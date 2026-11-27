/**
 * Height generation on the GPU, and the height atlas where all heights live.
 *
 * The heights of every chunk are computed by compute shaders straight into GPU storage buffers and read from there by the vertex shader; they never exist on the CPU, except for the few chunks the camera needs for collision. {@link GPUGenerator} organises that memory and that work:
 *
 * | Concept | What it is |
 * | --- | --- |
 * | Page ({@link HeightPage}) | One storage buffer holding the heights of many chunks of one resolution. |
 * | Slot | The place of one chunk in a page, `resolution²` heights. A chunk's {@link types/chunk!ChunkGPUResources | ChunkGPUResources} name its page and slot. |
 * | Job | A chunk to generate: its world origin and slot, written into the page's job buffer by {@link GPUGenerator.generate}. |
 * | Dispatch | {@link GPUGenerator.flush} runs the queued jobs of each page in two compute passes, once per frame, before rendering. |
 * | Read-back | An asynchronous copy back to the CPU: the exact height range of new chunks, and the heights for collision, delivered to a {@link HeightListener}. |
 *
 * With the default configuration the atlas starts with four pages, one per level of detail, holding about 6.5 MB of heights; a page that fills up gets a smaller companion page.
 *
 * See [GPU height generation](../../../guides/gpu-generation.md).
 *
 * @module
 */
import { StorageBufferAttribute, WebGPURenderer } from 'three/webgpu';

import {
  createHeightKernels,
  createNoiseUniforms,
  decodeOrderedFloat,
  seedToNoiseOffset,
  MAX_NOISE_OCTAVES,
  NoiseUniforms,
  type HeightKernels,
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
  has?(resource: object): boolean;
  get?(resource: object): { readonly buffer?: GPUBuffer } | undefined;
}

const RELEASED_HEIGHTS = new Float32Array(0);

/**
 * Receives the results of the asynchronous read-backs of a {@link GPUGenerator}.
 *
 * @typeParam TOwner - Object that requested the work, passed back unchanged.
 *
 * The {@link engine/chunk-manager!ChunkManager | ChunkManager} is the only listener in the application: it tightens the chunk's culling box on `onBounds`, and stores the heights used for collision on `onHeights`. Both are called from promise callbacks, outside the frame loop, and in no guaranteed order between chunks.
 */
export interface HeightListener<TOwner> {
  /**
   * Called with the exact height range of a generated chunk. Not called if the chunk's slot was released before the result arrived.
   *
   * @param owner - Owner given to {@link GPUGenerator.generate}.
   * @param minHeight - Lowest height of the chunk, in world units.
   * @param maxHeight - Highest height of the chunk, in world units.
   */
  onBounds(owner: TOwner, minHeight: number, maxHeight: number): void;
  /**
   * Called with the heights requested through {@link GPUGenerator.requestHeights}.
   *
   * @param owner - Owner given to {@link GPUGenerator.requestHeights}.
   * @param heights - Heights row by row along X, or `null` when the slot was released or the read-back failed.
   */
  onHeights(owner: TOwner, heights: Float32Array | null): void;
}

/**
 * A page of the height atlas: one GPU storage buffer holding the heights of many chunks of the same resolution, one slot per chunk.
 *
 * The {@link engine/scene-graph!SceneGraph | SceneGraph} creates one pair of instanced meshes per page and binds its `heights` buffer to the terrain vertex shader. Pages are never removed while the generator lives; their slots are reused.
 */
export interface HeightPage {
  /**
   * Index of the page, as used in {@link types/chunk!ChunkGPUResources.pageId | ChunkGPUResources.pageId}.
   */
  readonly id: number;
  /**
   * Vertices per side of the chunks stored in the page.
   */
  readonly resolution: number;
  /**
   * Number of chunk slots.
   */
  readonly capacity: number;
  /**
   * Storage buffer with `capacity × resolution²` heights. Slot `s` starts at element `s × resolution²`. Its CPU copy is released after the first upload.
   */
  readonly heights: StorageBufferAttribute;
}

interface PendingSlot<TOwner> {
  readonly slot: number;
  readonly generation: number;
  readonly owner: TOwner;
}

interface PageState<TOwner> extends HeightPage {
  readonly heightBytes: number;
  heightCopyReleased: boolean;
  readonly bounds: StorageBufferAttribute;
  readonly jobs: StorageBufferAttribute;
  readonly kernels: HeightKernels;
  readonly generations: Uint32Array;
  readonly owners: (TOwner | null)[];
  readonly freeSlots: number[];
  jobCount: number;
  boundsPending: PendingSlot<TOwner>[];
  boundsInFlight: boolean;
  heightRequests: PendingSlot<TOwner>[];
}

/**
 * Generates chunk heights on the GPU and owns the height atlas.
 *
 * Heights are written by a compute kernel into atlas pages, at least one per resolution, sized from the number of chunks expected at each level of detail. Jobs queued with {@link GPUGenerator.generate} are dispatched in batches by {@link GPUGenerator.flush}, before the frame is rendered, so a chunk can be drawn in the frame it is generated. The same kernel computes each chunk's exact height range with atomic operations; that range and any heights needed for collision come back through small asynchronous read-backs reported to the {@link HeightListener}.
 *
 * @typeParam TOwner - Object associated with each chunk and passed back to the listener.
 *
 * @example
 * Generating one chunk and reading its results back:
 *
 * ```ts
 * const generator = new GPUGenerator<string>(renderer, config);
 * generator.setListener({
 *   onBounds: (owner, min, max) => console.log(owner, 'spans', min, 'to', max),
 *   onHeights: (owner, heights) => console.log(owner, heights?.length),
 * });
 *
 * const handle = generator.generate({ x: 2, z: -1, lod: 0 }, '2:-1');
 * generator.requestHeights(handle, '2:-1');
 * generator.flush();
 *
 * generator.release(handle);
 * ```
 */
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

  /**
   * Creates the generator and its noise uniforms. No GPU memory is allocated until the first page is needed, by {@link GPUGenerator.prewarm} or {@link GPUGenerator.generate}.
   *
   * @param renderer - An initialised WebGPU renderer.
   * @param config - Terrain configuration. The noise parameters are applied once, here.
   */
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

  /**
   * Sets the object that receives bounds and heights.
   *
   * @param listener - Listener, or `null` to stop receiving results.
   *
   * Only one listener is kept; setting another replaces it.
   */
  setListener(listener: HeightListener<TOwner> | null): void {
    this.listener = listener;
  }

  /**
   * Total number of chunks generated since creation.
   *
   * It only grows. The diagnostics compute *Generated/s* from its change over time.
   */
  get generatedCount(): number {
    return this.generatedTotal;
  }

  /**
   * Looks up an atlas page by its index.
   *
   * @param pageId - Index of the page.
   * @returns The page, or `undefined` if it does not exist.
   */
  getPage(pageId: number): HeightPage | undefined {
    return this.pages[pageId];
  }

  /**
   * All pages created so far.
   *
   * In creation order, so `getPages()[id]` is the page with that index.
   */
  getPages(): readonly HeightPage[] {
    return this.pages;
  }

  /**
   * Creates one page per resolution and runs its kernels once, so the compute pipelines are compiled during loading instead of on the first frames.
   *
   * The engine calls it during the `shaders` loading stage, before the first frame. The pages it creates are the ones later used for the terrain, so nothing is wasted.
   */
  prewarm(): void {
    const resolutions = new Set(LODS.map((lod) => this.config.CHUNK_RESOLUTIONS[lod]));
    for (const resolution of resolutions) {
      const page = this.acquirePage(resolution);
      page.kernels.jobCount.value = 0;
      void this.renderer.compute(page.kernels.reset, 1);
      void this.renderer.compute(page.kernels.main, 1);
      this.releaseHeightCopy(page);
    }
  }

  private estimatePageCapacity(resolution: number): number {
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

  /**
   * Assigns an atlas slot to a chunk and queues the job that generates its heights. The job is dispatched by the next {@link GPUGenerator.flush}, or immediately if the page's batch is full.
   *
   * The slot comes from the first page of the chunk's resolution with room; a new page is created when all are full, so this never fails for lack of space. The handle is valid immediately: the scene graph can draw the chunk in this frame, because its job runs before rendering. The chunk's exact bounds are reported later through {@link HeightListener.onBounds}.
   *
   * @param coord - Chunk to generate.
   * @param owner - Object passed back to the listener with the chunk's bounds.
   * @returns Where the heights will be stored.
   * @throws If the generator has been disposed.
   */
  generate(coord: ChunkCoord, owner: TOwner): ChunkGPUResources {
    if (this.disposed) {
      throw new Error('GPUGenerator has been disposed');
    }

    const resolution = this.config.CHUNK_RESOLUTIONS[coord.lod];
    const page = this.acquirePage(resolution);

    if (page.jobCount >= this.maxJobs) {
      this.flushPage(page);
    }

    const slot = page.freeSlots.pop();
    if (slot === undefined) throw new Error('Height page has no free slot');
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

  /**
   * Frees a chunk's slot so it can be reused. A queued job for that slot is cancelled, and results still in flight for it are ignored. Calling it again for the same resources does nothing.
   *
   * @param resources - Resources returned by {@link GPUGenerator.generate}.
   */
  release(resources: ChunkGPUResources): void {
    const page = this.pages.at(resources.pageId);
    if (page?.generations[resources.slot] !== resources.generation) return;

    this.removeQueuedJob(page, resources.slot);

    page.generations[resources.slot] = (page.generations[resources.slot] + 1) >>> 0;
    page.owners[resources.slot] = null;
    page.freeSlots.push(resources.slot);
  }

  /**
   * Requests a CPU copy of a chunk's heights, delivered through {@link HeightListener.onHeights} after the next {@link GPUGenerator.flush}.
   *
   * @param resources - Resources of the chunk.
   * @param owner - Object passed back to the listener.
   * @returns `false` if the slot has been released or reused.
   */
  requestHeights(resources: ChunkGPUResources, owner: TOwner): boolean {
    const page = this.pages.at(resources.pageId);
    if (page?.generations[resources.slot] !== resources.generation) return false;

    page.heightRequests.push({ slot: resources.slot, generation: resources.generation, owner });
    this.dirtyPages.add(page);
    return true;
  }

  /**
   * Dispatches the queued jobs of every page with pending work and starts the pending read-backs. Called once per frame. Failed bounds read-backs are retried on the next call.
   *
   * Per page with jobs: one `reset` dispatch with one thread per job, then one `main` dispatch with one thread per vertex of every job. The compute work is submitted to the same queue as the frame that follows, so no synchronisation is needed. Only one bounds read-back per page is in flight at a time.
   */
  flush(): void {
    if (this.disposed) return;

    for (const page of this.dirtyPages) {
      if (page.jobCount > 0) this.flushPage(page);
      this.startBoundsReadback(page);
      this.startHeightReadbacks(page);
    }
    this.dirtyPages.clear();
  }

  /**
   * Size of the atlas buffers (heights, bounds and job lists), in bytes.
   *
   * Shown as *Height atlas* in the diagnostics panel. It only grows when a page is added.
   */
  getAtlasBytes(): number {
    let bytes = 0;
    for (const page of this.pages) {
      bytes += page.heightBytes + page.bounds.array.byteLength + page.jobs.array.byteLength;
    }
    return bytes;
  }

  /**
   * Size of the GPU buffers kept in the read-back pool, in bytes.
   *
   * Shown as *Read-back* in the diagnostics panel. Buffers are pooled by power-of-two size, from 256 bytes, at most 4 per size and 16 in total.
   */
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
      heightBytes: heights.array.byteLength,
      heightCopyReleased: false,
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

    void this.renderer.compute(page.kernels.reset, count);
    void this.renderer.compute(page.kernels.main, count * page.kernels.verticesPerChunk);
    this.releaseHeightCopy(page);

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
      .catch((error: unknown) => {
        if (this.disposed) return;
        console.error('[GPUGenerator] Bounds readback failed:', error);
        page.boundsPending.push(...batch);
      })
      .finally(() => {
        page.boundsInFlight = false;
        if (!this.disposed && page.boundsPending.length > 0) this.dirtyPages.add(page);
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
        .catch((error: unknown) => {
          if (this.disposed) return;
          console.error('[GPUGenerator] Height readback failed:', error);
          this.listener?.onHeights(request.owner, null);
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

  private releaseHeightCopy(page: PageState<TOwner>): void {
    if (page.heightCopyReleased || this.backendInternals()?.has?.(page.heights) !== true) return;
    page.heights.array = RELEASED_HEIGHTS;
    page.heightCopyReleased = true;
  }

  private backendInternals(): BackendInternals | undefined {
    return (this.renderer as unknown as { readonly backend?: BackendInternals }).backend;
  }

  private acquireStaging(device: GPUDevice, size: number): GPUBuffer {
    const pool = this.stagingPool.get(size);
    const pooled = pool?.pop();
    if (pooled) return pooled;
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

  /**
   * Stops all work, ignores results still in flight and destroys the pooled read-back buffers.
   *
   * After this, {@link GPUGenerator.generate} throws and the other methods do nothing. The atlas buffers themselves are freed with the renderer.
   */
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
