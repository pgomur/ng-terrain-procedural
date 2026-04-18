import { signal, computed, Signal, untracked } from '@angular/core';

import {
  Chunk,
  ChunkCoord,
  ChunkState,
  ChunkKey,
  ChunkSystemState,
  ChunkLOD,
  FrustumPlanes,
  ChunkBounds,
  ChunkMetrics,
  StreamingRequest,
  ConcurrencySlot,
} from '../types/chunk';
import { TerrainConfig, CameraState, PerformanceSnapshot } from '../types/terrain';
import { GPUGenerator } from './gpu-generator';
import {
  getChunkKey,
  distanceToChunk,
  selectLODForDistance,
  calculateNeighborMask,
  getChunkCenter,
  worldToChunkCoord,
  intersectsFrustumAABB,
} from '../math/chunk-coord';

class CameraVelocityTracker {
  private prevX = Infinity;
  private prevZ = Infinity;
  private prevT = 0;

  vx = 0;
  vz = 0;
  speed = 0;

  private readonly alpha: number;

  constructor(alpha = 0.15) {
    this.alpha = alpha;
  }

  update(x: number, z: number, nowMs: number): void {
    if (this.prevT === 0) {
      this.prevX = x;
      this.prevZ = z;
      this.prevT = nowMs;
      return;
    }

    const dtSec = Math.max((nowMs - this.prevT) / 1000, 1e-6);
    const rawVx = (x - this.prevX) / dtSec;
    const rawVz = (z - this.prevZ) / dtSec;

    this.vx = this.alpha * rawVx + (1 - this.alpha) * this.vx;
    this.vz = this.alpha * rawVz + (1 - this.alpha) * this.vz;
    this.speed = Math.sqrt(this.vx * this.vx + this.vz * this.vz);

    this.prevX = x;
    this.prevZ = z;
    this.prevT = nowMs;
  }

  reset(): void {
    this.prevX = Infinity;
    this.prevZ = Infinity;
    this.prevT = 0;
    this.vx = 0;
    this.vz = 0;
    this.speed = 0;
  }
}

class AnticipationRingBuffer {
  private readonly slots: (StreamingRequest | null)[];
  private readonly capacity: number;
  private head = 0; // next read index
  private tail = 0; // next write index
  private _size = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    // Pre-allocate all slots to avoid GC pressure at runtime
    this.slots = new Array<StreamingRequest | null>(capacity).fill(null);
  }

  get size(): number {
    return this._size;
  }

  enqueue(req: StreamingRequest): void {
    if (this._size < this.capacity) {
      this.slots[this.tail] = req;
      this.tail = (this.tail + 1) % this.capacity;
      this._size++;
    } else {
      // Buffer full: find the worst resident
      let worstIdx = -1;
      let worstScore = -Infinity;
      for (let i = 0; i < this.capacity; i++) {
        const s = this.slots[i];
        if (s !== null && s.score > worstScore) {
          worstScore = s.score;
          worstIdx = i;
        }
      }
      // Only replace if the new request is strictly better
      if (worstIdx >= 0 && req.score < worstScore) {
        this.slots[worstIdx] = req;
      }
    }
  }

  dequeue(): StreamingRequest | null {
    if (this._size === 0) return null;

    let bestIdx = -1;
    let bestScore = Infinity;
    for (let i = 0; i < this.capacity; i++) {
      const s = this.slots[i];
      if (s !== null && s.score < bestScore) {
        bestScore = s.score;
        bestIdx = i;
      }
    }

    if (bestIdx < 0) return null;

    const req = this.slots[bestIdx]!;
    this.slots[bestIdx] = null;
    this._size--;
    return req;
  }

  has(key: ChunkKey): boolean {
    for (let i = 0; i < this.capacity; i++) {
      const s = this.slots[i];
      if (s !== null && getChunkKey(s.coord) === key) return true;
    }
    return false;
  }

  remove(key: ChunkKey): void {
    for (let i = 0; i < this.capacity; i++) {
      const s = this.slots[i];
      if (s !== null && getChunkKey(s.coord) === key) {
        this.slots[i] = null;
        this._size--;
        return;
      }
    }
  }

  reprioritize(
    camX: number,
    camZ: number,
    vx: number,
    vz: number,
    speed: number,
    anticipationFrames: number,
    velocityWeight: number,
  ): void {
    const invSpeed = speed > 1e-3 ? 1 / speed : 0;
    const normVx = vx * invSpeed;
    const normVz = vz * invSpeed;

    for (let i = 0; i < this.capacity; i++) {
      const s = this.slots[i];
      if (s === null) continue;

      const chunkCenterX = s.coord.x * (s as any)._chunkSize + (s as any)._chunkSize / 2;
      const chunkCenterZ = s.coord.z * (s as any)._chunkSize + (s as any)._chunkSize / 2;

      const dx = chunkCenterX - camX;
      const dz = chunkCenterZ - camZ;
      const dist = Math.sqrt(dx * dx + dz * dz) || 1;

      const dotVD = normVx * (dx / dist) + normVz * (dz / dist);

      const anticipationGain = dotVD * speed * anticipationFrames * velocityWeight;

      s.score = dist - anticipationGain;
    }
  }

  reprioritizeWithSize(
    camX: number,
    camZ: number,
    vx: number,
    vz: number,
    speed: number,
    anticipationFrames: number,
    velocityWeight: number,
    chunkSize: number,
  ): void {
    const invSpeed = speed > 1e-3 ? 1 / speed : 0;
    const normVx = vx * invSpeed;
    const normVz = vz * invSpeed;

    for (let i = 0; i < this.capacity; i++) {
      const s = this.slots[i];
      if (s === null) continue;

      const chunkCenterX = s.coord.x * chunkSize + chunkSize / 2;
      const chunkCenterZ = s.coord.z * chunkSize + chunkSize / 2;

      const dx = chunkCenterX - camX;
      const dz = chunkCenterZ - camZ;
      const dist = Math.sqrt(dx * dx + dz * dz) || 1;

      const dotVD = normVx * (dx / dist) + normVz * (dz / dist);
      const anticipationGain = dotVD * speed * anticipationFrames * velocityWeight;

      s.score = dist - anticipationGain;
    }
  }

  avgAnticipationGain(camX: number, camZ: number, chunkSize: number): number {
    if (this._size === 0) return 0;
    let totalGain = 0;
    let count = 0;
    for (let i = 0; i < this.capacity; i++) {
      const s = this.slots[i];
      if (s === null) continue;
      const rawDist = s.distanceAtEnqueue;
      if (rawDist > 0) {
        totalGain += rawDist - s.score;
        count++;
      }
    }
    return count > 0 ? totalGain / count : 0;
  }

  clear(): void {
    this.slots.fill(null);
    this.head = 0;
    this.tail = 0;
    this._size = 0;
  }
}

class ConcurrencyPool {
  private readonly slots = new Map<ChunkKey, ConcurrencySlot>();
  private readonly maxSlots: number;
  private readonly timeoutMs: number;

  constructor(maxSlots: number, timeoutMs: number) {
    this.maxSlots = maxSlots;
    this.timeoutMs = timeoutMs;
  }

  get size(): number {
    return this.slots.size;
  }

  canAccept(): boolean {
    return this.slots.size < this.maxSlots;
  }

  has(key: ChunkKey): boolean {
    return this.slots.has(key);
  }

  submit(key: ChunkKey, genFn: () => Promise<void>): boolean {
    if (!this.canAccept() || this.slots.has(key)) return false;

    const slot: ConcurrencySlot = {
      promise: Promise.resolve(), // placeholder replaced below
      startedAt: performance.now(),
      settled: false,
    };

    // Override the promise with real work + settled flag
    const promise = genFn().finally(() => {
      slot.settled = true;
    });

    (slot as any).promise = promise;
    this.slots.set(key, slot);
    return true;
  }

  tick(now: number): void {
    for (const [key, slot] of this.slots) {
      if (slot.settled || now - slot.startedAt > this.timeoutMs) {
        this.slots.delete(key);
        if (!slot.settled) {
          console.warn(`[ChunkManager] Slot timeout for chunk ${key} after ${this.timeoutMs}ms`);
        }
      }
    }
  }

  activeKeys(): IterableIterator<ChunkKey> {
    return this.slots.keys();
  }

  clear(): void {
    this.slots.clear();
  }
}

export class ChunkManager {
  private readonly config: TerrainConfig;
  private readonly gpuGenerator: GPUGenerator;

  private activeChunks = signal<Map<ChunkKey, Chunk>>(new Map());
  private visibleKeys = signal<Set<ChunkKey>>(new Set());
  private cameraChunk = signal<ChunkCoord | null>(null);
  private submissionCounter = signal<number>(0);

  private perfStats = signal<PerformanceSnapshot>({
    timestamp: 0,
    frameTimeMs: 0,
    gpuTimeMs: 0,
    chunksRendered: 0,
    chunksVisible: 0,
    trianglesDrawn: 0,
    drawCalls: 0,
    memoryGPU: 0,
  });

  private readonly velocityTracker = new CameraVelocityTracker(0.15);
  private readonly ringBuffer: AnticipationRingBuffer;
  private readonly concurrencyPool: ConcurrencyPool;

  private lastCameraPos = { x: Infinity, z: Infinity };
  private lastVelocityX = 0;
  private lastVelocityZ = 0;
  private readonly VELOCITY_CHANGE_THRESHOLD = 5; // world-units/s

  private cachedDesiredChunks: ChunkCoord[] = [];
  private readonly CACHE_THRESHOLD = 0.1;

  private currentCamera: CameraState | null = null;
  private currentFrustum: FrustumPlanes | null = null;
  private needsNeighborUpdate = false;

  constructor(config: TerrainConfig, gpuGenerator: GPUGenerator) {
    this.config = config;
    this.gpuGenerator = gpuGenerator;
    this.ringBuffer = new AnticipationRingBuffer(config.RING_BUFFER_CAPACITY);
    this.concurrencyPool = new ConcurrencyPool(
      config.MAX_CONCURRENT_GENERATIONS,
      config.GENERATION_TIMEOUT_MS,
    );
  }

  update(camera: CameraState, frustum: FrustumPlanes): void {
    const frameStart = performance.now();

    this.currentCamera = camera;
    this.currentFrustum = frustum;

    this.velocityTracker.update(camera.position.x, camera.position.z, frameStart);

    this.concurrencyPool.tick(frameStart);

    const camChunkCoord = worldToChunkCoord(camera.position, this.config.CHUNK_SIZE, 0 as ChunkLOD);
    this.cameraChunk.set(camChunkCoord);
    const desiredChunks = this.getDesiredChunksCached(camera);

    const desiredSpatialCoords = new Map<string, number>();
    for (const c of desiredChunks) {
      desiredSpatialCoords.set(`${c.x}:${c.z}`, c.lod);
    }
    const desiredKeys = new Set(desiredChunks.map((c) => getChunkKey(c)));

    const mutations = this.collectCullMutations(
      this.activeChunks(),
      desiredKeys,
      desiredSpatialCoords,
    );

    this.enqueueNewChunks(desiredChunks, this.activeChunks());

    const velChanged =
      Math.abs(this.velocityTracker.vx - this.lastVelocityX) > this.VELOCITY_CHANGE_THRESHOLD ||
      Math.abs(this.velocityTracker.vz - this.lastVelocityZ) > this.VELOCITY_CHANGE_THRESHOLD;

    if (velChanged || this.ringBuffer.size > 0) {
      this.ringBuffer.reprioritizeWithSize(
        camera.position.x,
        camera.position.z,
        this.velocityTracker.vx,
        this.velocityTracker.vz,
        this.velocityTracker.speed,
        this.config.ANTICIPATION_FRAMES,
        this.config.VELOCITY_WEIGHT,
        this.config.CHUNK_SIZE,
      );
      this.lastVelocityX = this.velocityTracker.vx;
      this.lastVelocityZ = this.velocityTracker.vz;
    }

    this.drainRingBuffer(mutations.chunksAfterCull);

    this.applyMutations(mutations);

    this.updateVisibilityFast(this.activeChunks(), frustum);

    if (this.needsNeighborUpdate) {
      this.updateNeighborMasks(this.activeChunks());
      this.needsNeighborUpdate = false;
    }

    const frameTime = performance.now() - frameStart;
    this.perfStats.update((stats) => ({
      ...stats,
      timestamp: performance.now(),
      frameTimeMs: frameTime,
      chunksVisible: this.visibleKeys().size,
    }));
  }

  private getDesiredChunksCached(camera: CameraState): ChunkCoord[] {
    const dx = Math.abs(camera.position.x - this.lastCameraPos.x);
    const dz = Math.abs(camera.position.z - this.lastCameraPos.z);
    const threshold = this.config.CHUNK_SIZE * this.CACHE_THRESHOLD;

    if (dx < threshold && dz < threshold && this.cachedDesiredChunks.length > 0) {
      return this.cachedDesiredChunks;
    }

    this.lastCameraPos = { x: camera.position.x, z: camera.position.z };
    this.cachedDesiredChunks = this.calculateDesiredChunks(camera);
    return this.cachedDesiredChunks;
  }

  private calculateDesiredChunks(camera: CameraState): ChunkCoord[] {
    const desired: ChunkCoord[] = [];
    const centerX = Math.floor(camera.position.x / this.config.CHUNK_SIZE);
    const centerZ = Math.floor(camera.position.z / this.config.CHUNK_SIZE);

    const maxDist = Math.max(...this.config.LOD_DISTANCES) * 1.2;
    const radius = Math.ceil(maxDist / this.config.CHUNK_SIZE);

    // Spiral outward from camera to naturally order by proximity
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
        const dist = distanceToChunk(camera.position, center);

        if (dist < maxDist) {
          const lod = selectLODForDistance(dist, this.config.LOD_DISTANCES);
          desired.push({ x: chunkX, z: chunkZ, lod });
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

  private collectCullMutations(
    currentChunks: Map<ChunkKey, Chunk>,
    desiredKeys: Set<ChunkKey>,
    desiredSpatialCoords: Map<string, number>,
  ): { chunksAfterCull: Map<ChunkKey, Chunk>; keysToRelease: ChunkKey[]; hasChanges: boolean } {
    const working = new Map(currentChunks);
    const keysToRelease: ChunkKey[] = [];
    let hasChanges = false;
    const now = performance.now();

    for (const [key, chunk] of working) {
      if (desiredKeys.has(key)) continue;

      const spatialKey = `${chunk.meta.coord.x}:${chunk.meta.coord.z}`;
      const desiredLOD = desiredSpatialCoords.get(spatialKey);

      if (desiredLOD !== undefined) {
        const replacementKey =
          `${chunk.meta.coord.x}:${chunk.meta.coord.z}:${desiredLOD}` as ChunkKey;
        const replacement = working.get(replacementKey);
        if (!replacement || replacement.state !== 'ready') {
          working.set(key, {
            ...chunk,
            metrics: { ...chunk.metrics, lastAccessed: now },
          });
          continue;
        }
      }

      if (chunk.state === 'error') {
        if (chunk.metrics.frameCount > 60) {
          this.ringBuffer.enqueue({
            coord: chunk.meta.coord,
            score: 0,
            distanceAtEnqueue: 0,
            enqueuedAt: now,
            attempts: chunk.metrics.frameCount,
          });
        }
        continue;
      }

      if (chunk.state === 'unloading') {
        const framesPassed = (now - chunk.metrics.lastAccessed) / 16;
        if (framesPassed > this.config.UNLOAD_DELAY_FRAMES) {
          keysToRelease.push(key);
        }
      } else {
        working.set(key, {
          ...chunk,
          state: 'unloading',
          metrics: { ...chunk.metrics, lastAccessed: now },
        });
        hasChanges = true;
      }
    }

    // Evict excess if over MAX_CHUNKS
    if (working.size > this.config.MAX_CHUNKS) {
      const candidates = Array.from(working.entries())
        .filter(([, c]) => c.state === 'unloading')
        .sort((a, b) => a[1].metrics.lastAccessed - b[1].metrics.lastAccessed);

      while (
        working.size - keysToRelease.length > this.config.MAX_CHUNKS &&
        candidates.length > 0
      ) {
        const [key] = candidates.shift()!;
        if (!keysToRelease.includes(key)) keysToRelease.push(key);
      }
    }

    return { chunksAfterCull: working, keysToRelease, hasChanges };
  }

  private enqueueNewChunks(desired: ChunkCoord[], currentChunks: Map<ChunkKey, Chunk>): void {
    const now = performance.now();

    for (const coord of desired) {
      const key = getChunkKey(coord);
      if (currentChunks.has(key)) continue;
      if (this.concurrencyPool.has(key)) continue;
      if (this.ringBuffer.has(key)) continue;

      const center = getChunkCenter(coord, this.config.CHUNK_SIZE);
      const dist = this.currentCamera
        ? distanceToChunk(this.currentCamera.position, center)
        : Infinity;

      this.ringBuffer.enqueue({
        coord,
        score: dist,
        distanceAtEnqueue: dist,
        enqueuedAt: now,
        attempts: 0,
      });
    }
  }

  private drainRingBuffer(chunksAfterCull: Map<ChunkKey, Chunk>): void {
    const freeSlots = this.config.MAX_CONCURRENT_GENERATIONS - this.concurrencyPool.size;
    const budget = Math.min(freeSlots, this.config.GENERATION_BUDGET);

    let submitted = 0;
    while (this.ringBuffer.size > 0 && submitted < budget) {
      const req = this.ringBuffer.dequeue();
      if (!req) break;

      const key = getChunkKey(req.coord);

      // Skip if already active or generating
      if (chunksAfterCull.has(key)) continue;
      if (this.concurrencyPool.has(key)) continue;

      // Submit to pool — this starts the async GPU work
      const accepted = this.concurrencyPool.submit(key, () =>
        this.generateChunk(req.coord, req.attempts),
      );

      if (accepted) {
        // Immediately register chunk in the working map as 'generating'
        // so the scene graph doesn't get a gap
        chunksAfterCull.set(key, this.buildPendingChunk(req.coord, req.attempts));
        submitted++;
        this.needsNeighborUpdate = true;
      }
    }
  }

  private applyMutations(mutations: {
    chunksAfterCull: Map<ChunkKey, Chunk>;
    keysToRelease: ChunkKey[];
    hasChanges: boolean;
  }): void {
    const { chunksAfterCull, keysToRelease, hasChanges } = mutations;
    const hadReleases = keysToRelease.length > 0;

    // Release GPU resources for evicted chunks
    for (const key of keysToRelease) {
      const chunk = chunksAfterCull.get(key);
      if (chunk?.gpu) {
        this.gpuGenerator.releaseResources(chunk.gpu);
      }
      chunksAfterCull.delete(key);
    }

    if (hasChanges || hadReleases) {
      // Single atomic signal update
      this.activeChunks.set(new Map(chunksAfterCull));
      if (hadReleases) {
        this.needsNeighborUpdate = true;
      }
    }
  }

  private buildPendingChunk(coord: ChunkCoord, attemptCount: number): Chunk {
    const now = performance.now();
    return {
      meta: {
        coord,
        worldOrigin: {
          x: coord.x * this.config.CHUNK_SIZE,
          y: 0,
          z: coord.z * this.config.CHUNK_SIZE,
        },
        size: this.config.CHUNK_SIZE,
        resolution: this.config.CHUNK_RESOLUTIONS[coord.lod],
        seed: this.config.NOISE_SEED + (coord.x * 374761 + coord.z * 668265),
      },
      bounds: this.estimateBounds(coord),
      state: 'generating',
      gpu: null,
      metrics: {
        createdAt: now,
        generationTime: 0,
        lastAccessed: now,
        frameCount: attemptCount,
        distanceToCamera: 0,
        priorityScore: 0,
        visibility: { inFrustum: false, wasVisible: false, occlusionIndex: -1 },
        sync: null,
        neighborMask: 0,
        lastNeighborUpdate: 0,
      },
      mesh: null,
    };
  }

  private async generateChunk(coord: ChunkCoord, attemptCount = 0): Promise<void> {
    const key = getChunkKey(coord);

    this.activeChunks.update((chunks) => {
      if (!chunks.has(key)) {
        chunks.set(key, this.buildPendingChunk(coord, attemptCount));
        return new Map(chunks);
      }
      return chunks;
    });

    try {
      const genStart = performance.now();
      const { geometry, bounds, gpuResources } = await this.gpuGenerator.generateChunk(coord);
      const genTime = performance.now() - genStart;

      this.activeChunks.update((chunks) => {
        const chunk = chunks.get(key);
        if (!chunk) return chunks;

        const updated: Chunk = {
          ...chunk,
          state: 'ready',
          bounds,
          gpu: gpuResources,
          geometryData: geometry,
          metrics: {
            ...chunk.metrics,
            generationTime: genTime,
            lastAccessed: performance.now(),
            frameCount: 0,
          },
        };
        chunks.set(key, updated);
        return new Map(chunks);
      });

      this.submissionCounter.update((n) => n + 1);
      this.needsNeighborUpdate = true;
    } catch (error) {
      console.error(
        `[ChunkManager] Error generating chunk ${key} (attempt ${attemptCount}):`,
        error,
      );

      this.activeChunks.update((chunks) => {
        const chunk = chunks.get(key);
        if (chunk) {
          chunks.set(key, {
            ...chunk,
            state: 'error',
            metrics: { ...chunk.metrics, frameCount: attemptCount + 1 },
          });
        }
        return new Map(chunks);
      });
    }
    // Note: the ConcurrencyPool.tick() on the next frame will
    // release this slot via the settled flag set in submit().
  }

  private updateVisibilityFast(chunks: Map<ChunkKey, Chunk>, frustum: FrustumPlanes): void {
    const newVisible = new Set<ChunkKey>();

    for (const [key, chunk] of chunks) {
      if (chunk.state !== 'ready' && chunk.state !== 'unloading') continue;
      if (intersectsFrustumAABB(chunk.bounds, frustum)) {
        newVisible.add(key);
      }
    }

    const currentVisible = this.visibleKeys();
    const changed =
      newVisible.size !== currentVisible.size ||
      !Array.from(newVisible).every((k) => currentVisible.has(k));

    if (changed) {
      this.visibleKeys.set(newVisible);
    }
  }

  private updateNeighborMasks(chunks: Map<ChunkKey, Chunk>): void {
    const chunkMap = new Map<ChunkKey, { meta: { coord: ChunkCoord } }>();
    for (const [k, v] of chunks) {
      chunkMap.set(k, { meta: { coord: v.meta.coord } });
    }

    let changed = false;
    for (const [key, chunk] of chunks) {
      if (chunk.state !== 'ready') continue;

      const mask = calculateNeighborMask(chunk.meta.coord, chunkMap as any);
      if (mask !== chunk.metrics.neighborMask) {
        chunks.set(key, {
          ...chunk,
          metrics: {
            ...chunk.metrics,
            neighborMask: mask,
            lastNeighborUpdate: performance.now(),
          },
        });
        changed = true;
      }
    }

    if (changed) {
      // Only update the signal if something actually changed
      this.activeChunks.set(new Map(chunks));
    }
  }

  getChunkSystemState(): Signal<ChunkSystemState> {
    return computed(() => {
      const bufferSize = this.ringBuffer.size;
      const bufferCapacity = this.config.RING_BUFFER_CAPACITY;

      return {
        activeChunks: this.activeChunks(),
        visibleKeys: this.visibleKeys(),
        generatingKeys: new Set(this.concurrencyPool.activeKeys()),
        cameraChunk: this.cameraChunk(),
        submissionCounter: this.submissionCounter(),
        stats: {
          totalVRAM: this.calculateTotalVRAM(),
          visibleCount: this.visibleKeys().size,
          pendingCount: bufferSize,
          generatingCount: this.concurrencyPool.size,
          readyCount: Array.from(this.activeChunks().values()).filter((c) => c.state === 'ready')
            .length,
          fps: 1000 / (this.perfStats().frameTimeMs || 16),
          gpuWaitTime: this.perfStats().gpuTimeMs,
          // Streaming metrics
          streamingBufferUsage: bufferCapacity > 0 ? bufferSize / bufferCapacity : 0,
          anticipationScore: this.ringBuffer.avgAnticipationGain(
            this.currentCamera?.position.x ?? 0,
            this.currentCamera?.position.z ?? 0,
            this.config.CHUNK_SIZE,
          ),
          concurrencySlots: this.concurrencyPool.size,
        },
      };
    });
  }

  getTerrainHeightAt(x: number, z: number): number | null {
    let targetChunk: Chunk | null = null;

    for (const chunk of this.activeChunks().values()) {
      if (chunk.state !== 'ready' || !chunk.geometryData) continue;

      const { min, max } = chunk.bounds;
      if (x >= min.x && x < max.x && z >= min.z && z < max.z) {
        if (!targetChunk || chunk.meta.resolution > targetChunk.meta.resolution) {
          targetChunk = chunk;
        }
      }
    }

    if (!targetChunk || !targetChunk.geometryData) return null;

    const localX = x - targetChunk.meta.worldOrigin.x;
    const localZ = z - targetChunk.meta.worldOrigin.z;

    const res = targetChunk.meta.resolution;
    const cellSize = this.config.CHUNK_SIZE / (res - 1);

    const gridX = Math.floor(localX / cellSize);
    const gridZ = Math.floor(localZ / cellSize);

    if (gridX < 0 || gridX >= res - 1 || gridZ < 0 || gridZ >= res - 1) return null;

    const u = (localX % cellSize) / cellSize;
    const v = (localZ % cellSize) / cellSize;

    const { positions } = targetChunk.geometryData;
    const idx00 = (gridZ * res + gridX) * 3 + 1;
    const idx10 = (gridZ * res + (gridX + 1)) * 3 + 1;
    const idx01 = ((gridZ + 1) * res + gridX) * 3 + 1;
    const idx11 = ((gridZ + 1) * res + (gridX + 1)) * 3 + 1;

    const h00 = positions[idx00];
    const h10 = positions[idx10];
    const h01 = positions[idx01];
    const h11 = positions[idx11];

    return (h00 * (1 - u) + h10 * u) * (1 - v) + (h01 * (1 - u) + h11 * u) * v;
  }

  clearAllChunks(): void {
    const chunks = untracked(() => this.activeChunks());
    for (const chunk of chunks.values()) {
      if (chunk.gpu) {
        this.gpuGenerator.releaseResources(chunk.gpu);
      }
    }
    this.activeChunks.set(new Map());
    this.ringBuffer.clear();
    this.concurrencyPool.clear();
    this.visibleKeys.set(new Set());
    this.cachedDesiredChunks = [];
    this.velocityTracker.reset();
  }

  dispose(): void {
    this.clearAllChunks();
  }

  private calculateTotalVRAM(): number {
    let total = 0;
    for (const chunk of this.activeChunks().values()) {
      if (chunk.gpu) {
        const res = chunk.meta.resolution;
        total += res * res * 4; // Position buffer (float32 per vertex)
        total += (res - 1) * (res - 1) * 6 * 2; // Index buffer (uint16)
      }
    }
    return total;
  }

  private estimateBounds(coord: ChunkCoord): ChunkBounds {
    const originX = coord.x * this.config.CHUNK_SIZE;
    const originZ = coord.z * this.config.CHUNK_SIZE;

    const maxH = this.config.TERRAIN_HEIGHT_SCALE * 2.0 + this.config.TERRAIN_OFFSET_Y;
    const minH = this.config.TERRAIN_OFFSET_Y - this.config.TERRAIN_HEIGHT_SCALE * 1.5;

    return {
      min: { x: originX, y: minH, z: originZ },
      max: { x: originX + this.config.CHUNK_SIZE, y: maxH, z: originZ + this.config.CHUNK_SIZE },
      center: {
        x: originX + this.config.CHUNK_SIZE / 2,
        y: (minH + maxH) / 2,
        z: originZ + this.config.CHUNK_SIZE / 2,
      },
      radius: Math.sqrt(3 * Math.pow(this.config.CHUNK_SIZE / 2, 2) + Math.pow(maxH - minH, 2) / 2),
    };
  }
}
