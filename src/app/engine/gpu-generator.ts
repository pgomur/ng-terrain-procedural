import { StorageBufferAttribute, WebGPURenderer } from 'three/webgpu';

import {
  createHeightKernels,
  createNoiseUniforms,
  decodeOrderedFloat,
  seedToNoiseOffset,
  MAX_NOISE_OCTAVES,
  NoiseUniforms,
} from '../shaders/elevation.tsl';
import { ChunkCoord, ChunkGPUResources, ChunkLOD } from '../types/chunk';
import { TerrainConfig } from '../types/terrain';

const PAGE_HEADROOM = 1.25;
const GROWTH_PAGE_FRACTION = 0.25;
const MIN_PAGE_SLOTS = 16;
const DEFAULT_MAX_STORAGE_BINDING_BYTES = 128 * 1024 * 1024;
const LODS: readonly ChunkLOD[] = [0, 1, 2, 3];

const MAX_POOLED_STAGING_PER_SIZE = 4;
const MAX_POOLED_STAGING_TOTAL = 16;
const MIN_STAGING_BYTES = 256;

function stagingBucket(byteLength: number): number {
  let size = MIN_STAGING_BYTES;
  while (size < byteLength) size *= 2;
  return size;
}

interface BackendInternals {
  readonly device?: GPUDevice;
  get?(resource: object): { readonly buffer?: GPUBuffer } | undefined;
}

export interface HeightListener<TOwner> {
  onBounds(owner: TOwner, minHeight: number, maxHeight: number): void;
  onHeights(owner: TOwner, heights: Float32Array | null): void;
}

export interface HeightPage {
  readonly id: number;
  readonly resolution: number;
  readonly capacity: number;
  readonly heights: StorageBufferAttribute;
}

interface PendingSlot<TOwner> {
  readonly slot: number;
  readonly generation: number;
  readonly owner: TOwner;
}

interface PageState<TOwner> extends HeightPage {
  readonly bounds: StorageBufferAttribute;
  readonly jobs: StorageBufferAttribute;
  readonly kernels: ReturnType<typeof createHeightKernels>;
  readonly generations: Uint32Array;
  readonly owners: (TOwner | null)[];
  readonly freeSlots: number[];
  jobCount: number;
  boundsPending: PendingSlot<TOwner>[];
  boundsInFlight: boolean;
  heightRequests: PendingSlot<TOwner>[];
}

export class GPUGenerator<TOwner = unknown> {
  private readonly renderer: WebGPURenderer;
  private readonly config: TerrainConfig;
  private readonly noise: NoiseUniforms;
  private readonly maxJobs: number;

  private readonly pages: PageState<TOwner>[] = [];
  private readonly pagesByResolution = new Map<number, PageState<TOwner>[]>();
  private readonly dirtyPages = new Set<PageState<TOwner>>();
  private readonly stagingPool = new Map<number, GPUBuffer[]>();

  private listener: HeightListener<TOwner> | null = null;
  private disposed = false;
  private generatedTotal = 0;

  constructor(renderer: WebGPURenderer, config: TerrainConfig) {
    this.renderer = renderer;
    this.config = config;
    this.maxJobs = Math.max(1, Math.floor(config.GENERATION_BUDGET));
    this.noise = createNoiseUniforms();
    this.applyNoiseConfig();
  }

  private applyNoiseConfig(): void {
    const n = this.noise;
    const c = this.config;
    const seedOffset = seedToNoiseOffset(c.NOISE_SEED);
    const clampOctaves = (v: number) => Math.max(1, Math.min(MAX_NOISE_OCTAVES, Math.round(v)));

    n.chunkSize.value = c.CHUNK_SIZE;
    n.seedOffsetX.value = seedOffset.x;
    n.seedOffsetZ.value = seedOffset.z;
    n.octaves.value = clampOctaves(c.NOISE_OCTAVES);
    n.persistence.value = c.NOISE_PERSISTENCE;
    n.lacunarity.value = c.NOISE_LACUNARITY;
    n.heightScale.value = c.TERRAIN_HEIGHT_SCALE;
    n.offsetY.value = c.TERRAIN_OFFSET_Y;
    n.warpEnabled.value = c.NOISE_WARP_ENABLED ? 1 : 0;
    n.warpStrength.value = c.NOISE_WARP_STRENGTH;
    n.warpOctaves.value = clampOctaves(c.NOISE_WARP_OCTAVES);
    n.warpScale.value = c.NOISE_WARP_SCALE;
  }

  setListener(listener: HeightListener<TOwner> | null): void {
    this.listener = listener;
  }

  get generatedCount(): number {
    return this.generatedTotal;
  }

  getPage(pageId: number): HeightPage | undefined {
    return this.pages[pageId];
  }

  getPages(): readonly HeightPage[] {
    return this.pages;
  }

  prewarm(): void {
    const resolutions = new Set(LODS.map((lod) => this.config.CHUNK_RESOLUTIONS[lod]));
    for (const resolution of resolutions) {
      const page = this.acquirePage(resolution);
      page.kernels.jobCount.value = 0;
      this.renderer.compute(page.kernels.reset, 1);
      this.renderer.compute(page.kernels.main, 1);
    }
  }

  estimatePageCapacity(resolution: number): number {
    const size = this.config.CHUNK_SIZE;
    const distances = this.config.LOD_DISTANCES;
    const maxDist = Math.max(...distances) * 1.2;
    const margin = size * Math.SQRT1_2;

    let chunks = 0;
    for (const lod of LODS) {
      if (this.config.CHUNK_RESOLUTIONS[lod] !== resolution) continue;
      const inner = lod === 0 ? 0 : distances[lod - 1];
      const outer = lod === 3 ? maxDist : Math.min(distances[lod], maxDist);
      if (outer <= inner) continue;
      const area = Math.PI * ((outer + margin) ** 2 - Math.max(0, inner - margin) ** 2);
      chunks += area / (size * size);
    }

    return Math.max(MIN_PAGE_SLOTS, Math.ceil(chunks * PAGE_HEADROOM));
  }

  generate(coord: ChunkCoord, owner: TOwner): ChunkGPUResources {
    if (this.disposed) {
      throw new Error('GPUGenerator has been disposed');
    }

    const resolution = this.config.CHUNK_RESOLUTIONS[coord.lod];
    const page = this.acquirePage(resolution);

    if (page.jobCount >= this.maxJobs) {
      this.flushPage(page);
    }

    const slot = page.freeSlots.pop()!;
    const generation = page.generations[slot];
    page.owners[slot] = owner;

    const jobs = page.jobs.array as Float32Array;
    const base = page.jobCount * 4;
    jobs[base] = coord.x * this.config.CHUNK_SIZE;
    jobs[base + 1] = coord.z * this.config.CHUNK_SIZE;
    jobs[base + 2] = slot;
    jobs[base + 3] = 0;
    page.jobCount++;

    page.boundsPending.push({ slot, generation, owner });
    this.dirtyPages.add(page);
    this.generatedTotal++;

    return { pageId: page.id, slot, generation, resolution };
  }

  release(resources: ChunkGPUResources): void {
    const page = this.pages[resources.pageId];
    if (!page || page.generations[resources.slot] !== resources.generation) return;

    this.removeQueuedJob(page, resources.slot);

    page.generations[resources.slot] = (page.generations[resources.slot] + 1) >>> 0;
    page.owners[resources.slot] = null;
    page.freeSlots.push(resources.slot);
  }

  requestHeights(resources: ChunkGPUResources, owner: TOwner): boolean {
    const page = this.pages[resources.pageId];
    if (!page || page.generations[resources.slot] !== resources.generation) return false;

    page.heightRequests.push({ slot: resources.slot, generation: resources.generation, owner });
    this.dirtyPages.add(page);
    return true;
  }

  flush(): void {
    if (this.disposed) return;

    for (const page of this.dirtyPages) {
      if (page.jobCount > 0) this.flushPage(page);
      this.startBoundsReadback(page);
      this.startHeightReadbacks(page);
    }
    this.dirtyPages.clear();
  }

  getAllocatedBytes(): number {
    return this.getAtlasBytes() + this.getStagingBytes();
  }

  getAtlasBytes(): number {
    let bytes = 0;
    for (const page of this.pages) {
      bytes += page.heights.array.byteLength + page.bounds.array.byteLength + page.jobs.array.byteLength;
    }
    return bytes;
  }

  getStagingBytes(): number {
    let bytes = 0;
    for (const [size, pool] of this.stagingPool) bytes += size * pool.length;
    return bytes;
  }

  private acquirePage(resolution: number): PageState<TOwner> {
    let list = this.pagesByResolution.get(resolution);
    if (!list) {
      list = [];
      this.pagesByResolution.set(resolution, list);
    }

    for (const page of list) {
      if (page.freeSlots.length > 0) return page;
    }

    const verticesPerChunk = resolution * resolution;
    const estimate = this.estimatePageCapacity(resolution);
    const requested =
      list.length === 0 ? estimate : Math.max(MIN_PAGE_SLOTS, Math.ceil(estimate * GROWTH_PAGE_FRACTION));
    const maxBindingBytes =
      this.backendInternals()?.device?.limits.maxStorageBufferBindingSize ?? DEFAULT_MAX_STORAGE_BINDING_BYTES;
    const capacity = Math.max(1, Math.min(requested, Math.floor(maxBindingBytes / (verticesPerChunk * 4))));

    const heights = new StorageBufferAttribute(new Float32Array(capacity * verticesPerChunk), 1);
    const bounds = new StorageBufferAttribute(new Uint32Array(capacity * 2), 1);
    const jobs = new StorageBufferAttribute(new Float32Array(this.maxJobs * 4), 4);

    const kernels = createHeightKernels({
      resolution,
      maxJobs: this.maxJobs,
      heights,
      bounds,
      jobs,
      noise: this.noise,
    });

    const freeSlots: number[] = [];
    for (let i = capacity - 1; i >= 0; i--) freeSlots.push(i);

    const page: PageState<TOwner> = {
      id: this.pages.length,
      resolution,
      capacity,
      heights,
      bounds,
      jobs,
      kernels,
      generations: new Uint32Array(capacity),
      owners: new Array<TOwner | null>(capacity).fill(null),
      freeSlots,
      jobCount: 0,
      boundsPending: [],
      boundsInFlight: false,
      heightRequests: [],
    };

    this.pages.push(page);
    list.push(page);
    return page;
  }

  private removeQueuedJob(page: PageState<TOwner>, slot: number): void {
    const jobs = page.jobs.array as Float32Array;
    for (let i = 0; i < page.jobCount; i++) {
      if (jobs[i * 4 + 2] !== slot) continue;
      const last = (page.jobCount - 1) * 4;
      jobs[i * 4] = jobs[last];
      jobs[i * 4 + 1] = jobs[last + 1];
      jobs[i * 4 + 2] = jobs[last + 2];
      jobs[i * 4 + 3] = jobs[last + 3];
      page.jobCount--;
      return;
    }
  }

  private flushPage(page: PageState<TOwner>): void {
    const count = page.jobCount;
    if (count === 0) return;

    page.jobs.needsUpdate = true;
    page.kernels.jobCount.value = count;

    this.renderer.compute(page.kernels.reset, count);
    this.renderer.compute(page.kernels.main, count * page.kernels.verticesPerChunk);

    page.jobCount = 0;
  }

  private startBoundsReadback(page: PageState<TOwner>): void {
    if (this.disposed || page.boundsInFlight || page.boundsPending.length === 0) return;

    if (page.jobCount > 0) this.flushPage(page);

    const batch = page.boundsPending;
    page.boundsPending = [];
    page.boundsInFlight = true;

    let firstSlot = Infinity;
    let lastSlot = -Infinity;
    for (const item of batch) {
      if (item.slot < firstSlot) firstSlot = item.slot;
      if (item.slot > lastSlot) lastSlot = item.slot;
    }

    this.readRange(page.bounds, firstSlot * 8, (lastSlot - firstSlot + 1) * 8)
      .then((buffer) => {
        if (this.disposed) return;
        const keys = new Uint32Array(buffer);
        for (const item of batch) {
          if (page.generations[item.slot] !== item.generation) continue;
          const local = item.slot - firstSlot;
          const minHeight = decodeOrderedFloat(keys[local * 2]);
          const maxHeight = decodeOrderedFloat(keys[local * 2 + 1]);
          if (!Number.isFinite(minHeight) || !Number.isFinite(maxHeight)) continue;
          this.listener?.onBounds(item.owner, minHeight, maxHeight);
        }
      })
      .catch((error) => {
        console.error('[GPUGenerator] Bounds readback failed:', error);
        page.boundsPending.push(...batch);
      })
      .finally(() => {
        page.boundsInFlight = false;
        if (!this.disposed && page.boundsPending.length > 0) this.startBoundsReadback(page);
      });
  }

  private startHeightReadbacks(page: PageState<TOwner>): void {
    if (this.disposed || page.heightRequests.length === 0) return;

    if (page.jobCount > 0) this.flushPage(page);

    const requests = page.heightRequests;
    page.heightRequests = [];

    const bytesPerChunk = page.resolution * page.resolution * 4;

    for (const request of requests) {
      if (page.generations[request.slot] !== request.generation) {
        this.listener?.onHeights(request.owner, null);
        continue;
      }

      this.readRange(page.heights, request.slot * bytesPerChunk, bytesPerChunk)
        .then((buffer) => {
          if (this.disposed) return;
          const valid = page.generations[request.slot] === request.generation;
          this.listener?.onHeights(request.owner, valid ? new Float32Array(buffer) : null);
        })
        .catch((error) => {
          console.error('[GPUGenerator] Height readback failed:', error);
          if (!this.disposed) this.listener?.onHeights(request.owner, null);
        });
    }
  }

  private async readRange(
    attribute: StorageBufferAttribute,
    byteOffset: number,
    byteLength: number,
  ): Promise<ArrayBuffer> {
    const backend = this.backendInternals();
    const device = backend?.device;
    const source = backend?.get?.(attribute)?.buffer;

    if (!device || !source) {
      const full = await this.renderer.getArrayBufferAsync(attribute);
      return full.slice(byteOffset, byteOffset + byteLength);
    }

    const bucket = stagingBucket(byteLength);
    const staging = this.acquireStaging(device, bucket);
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(source, byteOffset, staging, 0, byteLength);
    device.queue.submit([encoder.finish()]);

    try {
      await staging.mapAsync(GPUMapMode.READ, 0, byteLength);
      return staging.getMappedRange(0, byteLength).slice(0);
    } finally {
      if (staging.mapState === 'mapped') staging.unmap();
      this.releaseStaging(bucket, staging);
    }
  }

  private backendInternals(): BackendInternals | undefined {
    return (this.renderer as unknown as { readonly backend?: BackendInternals }).backend;
  }

  private acquireStaging(device: GPUDevice, size: number): GPUBuffer {
    const pool = this.stagingPool.get(size);
    if (pool && pool.length > 0) return pool.pop()!;
    return device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  }

  private releaseStaging(size: number, buffer: GPUBuffer): void {
    if (this.disposed) {
      buffer.destroy();
      return;
    }
    let pool = this.stagingPool.get(size);
    if (!pool) {
      pool = [];
      this.stagingPool.set(size, pool);
    }
    let pooledTotal = 0;
    for (const list of this.stagingPool.values()) pooledTotal += list.length;

    if (pool.length < MAX_POOLED_STAGING_PER_SIZE && pooledTotal < MAX_POOLED_STAGING_TOTAL) {
      pool.push(buffer);
    } else {
      buffer.destroy();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listener = null;
    this.dirtyPages.clear();
    for (const pool of this.stagingPool.values()) {
      for (const buffer of pool) buffer.destroy();
    }
    this.stagingPool.clear();
    this.pages.length = 0;
    this.pagesByResolution.clear();
  }
}
