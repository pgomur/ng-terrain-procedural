import {
  Chunk,
  ChunkCoord,
  ChunkKey,
  ChunkLOD,
  FrustumPlanes,
  ChunkBounds,
  StreamingRequest,
  WorldPosition,
} from '../types/chunk';
import { TerrainConfig } from '../types/terrain';
import { CameraVelocityTracker } from './camera-velocity';
import { GPUGenerator } from './gpu-generator';
import { StreamingPriorityQueue } from './streaming-queue';
import {
  getChunkKey,
  distanceToChunk,
  selectLODForDistance,
  getChunkCenter,
  intersectsFrustumAABB,
  isRenderableChunk,
  spatialKeyOf,
  analyticHeightRange,
  boundsFromHeights,
  supportsSeamStitching,
  seamLodDiff,
  encodeSeamCode,
  stitchedHeight,
} from '../math/chunk-coord';

const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 8000;

function retryDelayMs(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);
}

export interface ChunkManagerStats {
  readonly readyCount: number;
  readonly unloadingCount: number;
  readonly errorCount: number;
  readonly visibleCount: number;
  readonly visibleByLod: readonly number[];
  readonly pendingCount: number;
  readonly exactBoundsCount: number;
  readonly heightsCachedCount: number;
  readonly streamingBufferUsage: number;
}

interface DesiredChunk {
  readonly coord: ChunkCoord;
  readonly key: ChunkKey;
  readonly spatialKey: string;
}

const MAX_LOD: ChunkLOD = 3;

export class ChunkManager {
  private readonly config: TerrainConfig;
  private readonly gpuGenerator: GPUGenerator<Chunk>;

  private readonly chunks = new Map<ChunkKey, Chunk>();
  private readonly visibleKeys = new Set<ChunkKey>();
  private readonly releaseKeys = new Set<ChunkKey>();
  private readonly dirtyCoords = new Set<string>();
  private readonly visibilityToggled = new Set<ChunkKey>();
  private readonly exactBounds = new WeakSet<Chunk>();
  private readonly pendingHeights = new Set<Chunk>();
  private chunksChanged = true;
  private cullDirty = true;
  private nextCullAt = Infinity;
  private enqueueDirty = true;

  private readonly velocityTracker = new CameraVelocityTracker(0.15);
  private readonly queue: StreamingPriorityQueue;

  private lastCameraPos = { x: Infinity, z: Infinity };
  private lastVelocityX = 0;
  private lastVelocityZ = 0;
  private readonly VELOCITY_CHANGE_THRESHOLD = 5;

  private desired: DesiredChunk[] = [];
  private readonly desiredKeys = new Set<ChunkKey>();
  private readonly desiredByCoord = new Map<string, DesiredChunk>();
  private readonly CACHE_THRESHOLD = 0.1;

  private cameraX = 0;
  private cameraZ = 0;
  private hasCamera = false;

  private collisionChunkX = Number.NaN;
  private collisionChunkZ = Number.NaN;
  private collisionDirty = true;

  private readonly seamsEnabled: boolean;

  constructor(config: TerrainConfig, gpuGenerator: GPUGenerator<Chunk>) {
    this.config = config;
    this.seamsEnabled = config.SEAM_FITTING_ENABLED && supportsSeamStitching(config.CHUNK_RESOLUTIONS);
    this.gpuGenerator = gpuGenerator;
    this.queue = new StreamingPriorityQueue(config.GENERATION_QUEUE_CAPACITY);
    this.gpuGenerator.setListener({
      onBounds: (chunk, minHeight, maxHeight) => this.applyExactBounds(chunk, minHeight, maxHeight),
      onHeights: (chunk, heights) => this.applyHeights(chunk, heights),
    });
  }

  getChunks(): ReadonlyMap<ChunkKey, Chunk> {
    return this.chunks;
  }

  getVisibleKeys(): ReadonlySet<ChunkKey> {
    return this.visibleKeys;
  }

  getDirtyCoords(): ReadonlySet<string> {
    return this.dirtyCoords;
  }

  getVisibilityToggled(): ReadonlySet<ChunkKey> {
    return this.visibilityToggled;
  }

  clearRenderChanges(): void {
    this.dirtyCoords.clear();
    this.visibilityToggled.clear();
  }

  update(position: WorldPosition, frustum: FrustumPlanes, viewChanged = true): void {
    const frameStart = performance.now();

    this.cameraX = position.x;
    this.cameraZ = position.z;
    this.hasCamera = true;

    this.velocityTracker.update(position.x, position.z, frameStart);

    this.refreshDesiredChunks(position);

    if (this.cullDirty || frameStart >= this.nextCullAt) {
      this.cullDirty = false;
      this.cullAndRetry(frameStart);
      this.releasePendingKeys();
    }

    this.queue.retainOnly(this.desiredKeys);

    if (this.enqueueDirty) {
      this.enqueueDirty = false;
      this.enqueueNewChunks();
    }

    const velChanged =
      Math.abs(this.velocityTracker.vx - this.lastVelocityX) > this.VELOCITY_CHANGE_THRESHOLD ||
      Math.abs(this.velocityTracker.vz - this.lastVelocityZ) > this.VELOCITY_CHANGE_THRESHOLD;

    if (velChanged || this.queue.size > 0) {
      this.queue.reprioritize(
        position.x,
        position.z,
        this.velocityTracker.vx,
        this.velocityTracker.vz,
        this.velocityTracker.speed,
        this.config.ANTICIPATION_SECONDS,
        this.config.VELOCITY_WEIGHT,
        this.config.CHUNK_SIZE,
      );
      this.lastVelocityX = this.velocityTracker.vx;
      this.lastVelocityZ = this.velocityTracker.vz;
    }

    this.generateQueued(frameStart);
    this.requestCollisionHeights(position);

    this.gpuGenerator.flush();

    if (viewChanged || this.chunksChanged) {
      this.updateVisibility(frustum);
      this.chunksChanged = false;
    }
  }

  private refreshDesiredChunks(position: WorldPosition): void {
    const dx = Math.abs(position.x - this.lastCameraPos.x);
    const dz = Math.abs(position.z - this.lastCameraPos.z);
    const threshold = this.config.CHUNK_SIZE * this.CACHE_THRESHOLD;

    if (dx < threshold && dz < threshold && this.desired.length > 0) {
      return;
    }

    this.lastCameraPos = { x: position.x, z: position.z };
    this.desired = this.calculateDesiredChunks(position);

    this.desiredKeys.clear();
    this.desiredByCoord.clear();
    for (const entry of this.desired) {
      this.desiredKeys.add(entry.key);
      this.desiredByCoord.set(entry.spatialKey, entry);
    }
    this.cullDirty = true;
    this.enqueueDirty = true;
  }

  private calculateDesiredChunks(position: WorldPosition): DesiredChunk[] {
    const desired: DesiredChunk[] = [];
    const centerX = Math.floor(position.x / this.config.CHUNK_SIZE);
    const centerZ = Math.floor(position.z / this.config.CHUNK_SIZE);

    const maxDist = Math.max(...this.config.LOD_DISTANCES) * 1.2;
    const radius = Math.ceil(maxDist / this.config.CHUNK_SIZE);

    let x = 0,
      z = 0,
      dx = 0,
      dz = -1;
    const maxIter = (radius * 2 + 1) ** 2;

    for (let i = 0; i < maxIter; i++) {
      if (-radius <= x && x <= radius && -radius <= z && z <= radius) {
        const chunkX = centerX + x;
        const chunkZ = centerZ + z;
        const center = getChunkCenter({ x: chunkX, z: chunkZ, lod: 0 }, this.config.CHUNK_SIZE);
        const dist = distanceToChunk(position, center);

        if (dist < maxDist) {
          const lod = selectLODForDistance(dist, this.config.LOD_DISTANCES);
          const coord: ChunkCoord = { x: chunkX, z: chunkZ, lod };
          desired.push({ coord, key: getChunkKey(coord), spatialKey: spatialKeyOf(coord) });
        }
      }

      if (x === z || (x < 0 && x === -z) || (x > 0 && x === 1 - z)) {
        [dx, dz] = [-dz, dx];
      }
      x += dx;
      z += dz;
    }

    return desired;
  }

  private cullAndRetry(now: number): void {
    const unloadDelayMs = this.config.UNLOAD_DELAY_MS;
    let nextCullAt = Infinity;

    for (const [key, chunk] of this.chunks) {
      const isDesired = this.desiredKeys.has(key);

      if (chunk.state === 'error') {
        if (!isDesired) {
          this.releaseKeys.add(key);
          continue;
        }
        const failure = chunk.failure;
        if (!failure || now >= failure.retryAt) {
          this.chunks.delete(key);
          this.queue.enqueue(this.createRequest(chunk.meta.coord, key, failure?.attempts ?? 1));
          this.enqueueDirty = true;
        } else {
          nextCullAt = Math.min(nextCullAt, failure.retryAt);
        }
        continue;
      }

      if (isDesired) {
        if (chunk.state === 'unloading') {
          if (chunk.gpu) {
            chunk.state = 'ready';
            chunk.metrics.lastAccessed = now;
            this.markRenderChange(chunk);
          } else {
            this.chunks.delete(key);
            this.enqueueDirty = true;
          }
        }
        continue;
      }

      const desired = this.desiredByCoord.get(chunk.meta.spatialKey);

      if (desired) {
        const replacement = this.chunks.get(desired.key);
        if (replacement?.state !== 'ready') {
          chunk.metrics.lastAccessed = now;
          continue;
        }
      }

      if (chunk.state === 'unloading') {
        if (now - chunk.metrics.lastAccessed > unloadDelayMs) {
          this.releaseKeys.add(key);
        } else {
          nextCullAt = Math.min(nextCullAt, chunk.metrics.lastAccessed + unloadDelayMs);
        }
      } else {
        const wasRenderable = isRenderableChunk(chunk);
        chunk.state = 'unloading';
        chunk.metrics.lastAccessed = now;
        nextCullAt = Math.min(nextCullAt, now + unloadDelayMs);
        if (wasRenderable) this.markRenderChange(chunk);
      }
    }

    this.nextCullAt = nextCullAt;

    if (this.chunks.size - this.releaseKeys.size > this.config.MAX_CHUNKS) {
      const candidates: Chunk[] = [];
      for (const [key, chunk] of this.chunks) {
        if (chunk.state === 'unloading' && !this.releaseKeys.has(key)) candidates.push(chunk);
      }
      candidates.sort((a, b) => a.metrics.lastAccessed - b.metrics.lastAccessed);

      for (const chunk of candidates) {
        if (this.chunks.size - this.releaseKeys.size <= this.config.MAX_CHUNKS) break;
        this.releaseKeys.add(getChunkKey(chunk.meta.coord));
      }
    }
  }

  private releasePendingKeys(): void {
    if (this.releaseKeys.size === 0) return;

    for (const key of this.releaseKeys) {
      const chunk = this.chunks.get(key);
      if (!chunk) continue;
      this.releaseChunk(key, chunk);
    }

    this.releaseKeys.clear();
  }

  private releaseChunk(key: ChunkKey, chunk: Chunk): void {
    if (isRenderableChunk(chunk)) this.markRenderChange(chunk);
    if (chunk.gpu) {
      this.gpuGenerator.release(chunk.gpu);
      chunk.gpu = null;
    }
    chunk.heights = undefined;
    this.pendingHeights.delete(chunk);
    this.chunks.delete(key);
    if (this.visibleKeys.delete(key)) this.visibilityToggled.add(key);
  }

  private markRenderChange(chunk: Chunk): void {
    this.dirtyCoords.add(chunk.meta.spatialKey);
    this.chunksChanged = true;
    this.cullDirty = true;
  }

  private createRequest(coord: ChunkCoord, key: ChunkKey, attempts: number): StreamingRequest {
    let dist = Infinity;
    if (this.hasCamera) {
      const half = this.config.CHUNK_SIZE / 2;
      const dx = this.cameraX - (coord.x * this.config.CHUNK_SIZE + half);
      const dz = this.cameraZ - (coord.z * this.config.CHUNK_SIZE + half);
      dist = Math.sqrt(dx * dx + dz * dz);
    }
    return {
      key,
      coord,
      score: dist,
      attempts,
    };
  }

  private enqueueNewChunks(): void {
    for (const entry of this.desired) {
      const key = entry.key;
      if (this.chunks.has(key)) continue;
      if (this.queue.has(key)) continue;

      if (!this.queue.enqueue(this.createRequest(entry.coord, key, 0))) this.enqueueDirty = true;
    }
  }

  private generateQueued(now: number): number {
    const budget = Math.max(0, Math.floor(this.config.GENERATION_BUDGET));

    let generated = 0;
    while (generated < budget) {
      const req = this.queue.dequeue();
      if (!req) break;

      if (this.chunks.has(req.key)) continue;

      const chunk = this.buildChunk(req.coord, now);
      this.chunks.set(req.key, chunk);

      try {
        chunk.gpu = this.gpuGenerator.generate(req.coord, chunk);
        chunk.state = 'ready';
        this.markRenderChange(chunk);
      } catch (error) {
        const attempts = req.attempts + 1;
        console.error(`[ChunkManager] Error generating chunk ${req.key} (attempt ${attempts}):`, error);
        chunk.state = 'error';
        chunk.failure = { attempts, retryAt: now + retryDelayMs(attempts) };
        this.cullDirty = true;
      }

      generated++;
    }

    return generated;
  }

  private buildChunk(coord: ChunkCoord, now: number): Chunk {
    return {
      meta: {
        coord,
        spatialKey: spatialKeyOf(coord),
        resolution: this.config.CHUNK_RESOLUTIONS[coord.lod],
      },
      bounds: this.analyticBounds(coord),
      state: 'generating',
      gpu: null,
      metrics: {
        lastAccessed: now,
      },
    };
  }

  private applyExactBounds(chunk: Chunk, minHeight: number, maxHeight: number): void {
    if (this.chunks.get(getChunkKey(chunk.meta.coord)) !== chunk || !chunk.gpu) return;

    chunk.bounds = boundsFromHeights(chunk.meta.coord, this.config.CHUNK_SIZE, minHeight, maxHeight);
    this.exactBounds.add(chunk);
    this.chunksChanged = true;
  }

  private applyHeights(chunk: Chunk, heights: Float32Array | null): void {
    this.pendingHeights.delete(chunk);

    if (!heights) {
      this.collisionDirty = true;
      return;
    }
    if (this.chunks.get(getChunkKey(chunk.meta.coord)) !== chunk || !chunk.gpu) return;

    chunk.heights = heights;
  }

  private requestCollisionHeights(position: WorldPosition): void {
    const size = this.config.CHUNK_SIZE;
    const chunkX = Math.floor(position.x / size);
    const chunkZ = Math.floor(position.z / size);

    if (
      chunkX === this.collisionChunkX &&
      chunkZ === this.collisionChunkZ &&
      !this.collisionDirty &&
      this.dirtyCoords.size === 0
    ) {
      return;
    }

    this.collisionChunkX = chunkX;
    this.collisionChunkZ = chunkZ;
    this.collisionDirty = false;

    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const chunk = this.findSurfaceChunk(chunkX + dx, chunkZ + dz, false);
        if (!chunk?.gpu || chunk.heights || this.pendingHeights.has(chunk)) continue;
        if (this.gpuGenerator.requestHeights(chunk.gpu, chunk)) {
          this.pendingHeights.add(chunk);
        }
      }
    }
  }

  private findSurfaceChunk(chunkX: number, chunkZ: number, requireHeights: boolean): Chunk | undefined {
    let fallback: Chunk | undefined;
    for (let lod = 0; lod <= MAX_LOD; lod++) {
      const chunk = this.chunks.get(`${chunkX}:${chunkZ}:${lod}` as ChunkKey);
      if (!chunk?.gpu) continue;
      if (requireHeights && !chunk.heights) continue;
      if (chunk.state === 'ready') return chunk;
      if (!fallback && chunk.state === 'unloading') fallback = chunk;
    }
    return fallback;
  }

  private updateVisibility(frustum: FrustumPlanes): void {
    for (const [key, chunk] of this.chunks) {
      const visible = isRenderableChunk(chunk) && intersectsFrustumAABB(chunk.bounds, frustum);
      if (visible === this.visibleKeys.has(key)) continue;

      if (visible) {
        this.visibleKeys.add(key);
      } else {
        this.visibleKeys.delete(key);
      }
      this.visibilityToggled.add(key);
    }
  }

  getStats(): ChunkManagerStats {
    let readyCount = 0;
    let unloadingCount = 0;
    let errorCount = 0;
    let exactBoundsCount = 0;
    let heightsCachedCount = 0;

    for (const chunk of this.chunks.values()) {
      switch (chunk.state) {
        case 'ready':
          readyCount++;
          break;
        case 'unloading':
          unloadingCount++;
          break;
        case 'error':
          errorCount++;
          break;
      }
      if (this.exactBounds.has(chunk)) exactBoundsCount++;
      if (chunk.heights) heightsCachedCount++;
    }

    const visibleByLod = new Array<number>(MAX_LOD + 1).fill(0);
    for (const key of this.visibleKeys) {
      const chunk = this.chunks.get(key);
      if (chunk) visibleByLod[chunk.meta.coord.lod]++;
    }

    const capacity = this.config.GENERATION_QUEUE_CAPACITY;

    return {
      readyCount,
      unloadingCount,
      errorCount,
      visibleCount: this.visibleKeys.size,
      visibleByLod,
      pendingCount: this.queue.size,
      exactBoundsCount,
      heightsCachedCount,
      streamingBufferUsage: capacity > 0 ? this.queue.size / capacity : 0,
    };
  }

  getLoadProgress(maxLod: ChunkLOD): { readonly ready: number; readonly wanted: number } {
    let ready = 0;
    let wanted = 0;
    for (const entry of this.desiredByCoord.values()) {
      if (entry.coord.lod > maxLod) continue;
      wanted++;
      if (this.chunks.get(entry.key)?.state === 'ready') ready++;
    }
    return { ready, wanted };
  }

  getTerrainHeightAt(x: number, z: number): number | null {
    const size = this.config.CHUNK_SIZE;
    const chunkX = Math.floor(x / size);
    const chunkZ = Math.floor(z / size);

    const target = this.findSurfaceChunk(chunkX, chunkZ, true);
    if (!target?.heights) return null;

    const res = target.meta.resolution;
    const cellSize = size / (res - 1);

    const fx = (x - chunkX * size) / cellSize;
    const fz = (z - chunkZ * size) / cellSize;

    const gridX = Math.min(Math.max(Math.floor(fx), 0), res - 2);
    const gridZ = Math.min(Math.max(Math.floor(fz), 0), res - 2);

    const u = Math.min(Math.max(fx - gridX, 0), 1);
    const v = Math.min(Math.max(fz - gridZ, 0), 1);

    const heights = target.heights;
    const seamCode = this.seamsEnabled ? this.seamCodeFor(target, chunkX, chunkZ) : 0;
    const h00 = stitchedHeight(heights, res, gridX, gridZ, seamCode);
    const h10 = stitchedHeight(heights, res, gridX + 1, gridZ, seamCode);
    const h01 = stitchedHeight(heights, res, gridX, gridZ + 1, seamCode);
    const h11 = stitchedHeight(heights, res, gridX + 1, gridZ + 1, seamCode);

    if (u + v <= 1) {
      return h00 + (h10 - h00) * u + (h01 - h00) * v;
    }
    return h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
  }

  private seamCodeFor(chunk: Chunk, chunkX: number, chunkZ: number): number {
    const lod = chunk.meta.coord.lod;
    const neighborLod = (dx: number, dz: number): ChunkLOD | null =>
      this.findSurfaceChunk(chunkX + dx, chunkZ + dz, false)?.meta.coord.lod ?? null;

    return encodeSeamCode(
      seamLodDiff(lod, neighborLod(-1, 0)),
      seamLodDiff(lod, neighborLod(1, 0)),
      seamLodDiff(lod, neighborLod(0, -1)),
      seamLodDiff(lod, neighborLod(0, 1)),
    );
  }

  private clearAllChunks(): void {
    for (const [key, chunk] of this.chunks) {
      this.releaseChunk(key, chunk);
    }
    for (const key of this.visibleKeys) this.visibilityToggled.add(key);

    this.chunks.clear();
    this.visibleKeys.clear();
    this.releaseKeys.clear();
    this.pendingHeights.clear();
    this.queue.clear();
    this.desired = [];
    this.desiredKeys.clear();
    this.desiredByCoord.clear();
    this.lastCameraPos = { x: Infinity, z: Infinity };
    this.velocityTracker.reset();
    this.collisionChunkX = Number.NaN;
    this.collisionChunkZ = Number.NaN;
    this.collisionDirty = true;
    this.chunksChanged = true;
    this.cullDirty = true;
    this.enqueueDirty = true;
    this.nextCullAt = Infinity;
  }

  dispose(): void {
    this.clearAllChunks();
    this.gpuGenerator.setListener(null);
  }

  private analyticBounds(coord: ChunkCoord): ChunkBounds {
    const range = analyticHeightRange(this.config.TERRAIN_HEIGHT_SCALE, this.config.TERRAIN_OFFSET_Y);
    return boundsFromHeights(coord, this.config.CHUNK_SIZE, range.min, range.max);
  }
}
