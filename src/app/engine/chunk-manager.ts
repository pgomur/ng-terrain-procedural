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

export class StreamingPriorityQueue {
  private readonly heap: StreamingRequest[] = [];
  private readonly index = new Map<ChunkKey, number>();
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  get size(): number {
    return this.heap.length;
  }

  has(key: ChunkKey): boolean {
    return this.index.has(key);
  }

  enqueue(req: StreamingRequest): boolean {
    const existing = this.index.get(req.key);
    if (existing !== undefined) {
      const current = this.heap[existing];
      if (req.score < current.score) {
        current.score = req.score;
        this.siftUp(existing);
      }
      if (req.attempts > current.attempts) current.attempts = req.attempts;
      return true;
    }

    if (this.heap.length >= this.capacity) {
      const worst = this.worstIndex();
      if (worst < 0 || req.score >= this.heap[worst].score) return false;
      this.removeAt(worst);
    }

    this.heap.push(req);
    const i = this.heap.length - 1;
    this.index.set(req.key, i);
    this.siftUp(i);
    return true;
  }

  dequeue(): StreamingRequest | null {
    if (this.heap.length === 0) return null;
    const top = this.heap[0];
    this.removeAt(0);
    return top;
  }

  remove(key: ChunkKey): boolean {
    const i = this.index.get(key);
    if (i === undefined) return false;
    this.removeAt(i);
    return true;
  }

  retainOnly(keep: ReadonlySet<ChunkKey>): void {
    let write = 0;
    for (let read = 0; read < this.heap.length; read++) {
      const req = this.heap[read];
      if (keep.has(req.key)) {
        this.heap[write++] = req;
      } else {
        this.index.delete(req.key);
      }
    }
    if (write === this.heap.length) return;
    this.heap.length = write;
    this.rebuild();
  }

  reprioritize(
    camX: number,
    camZ: number,
    vx: number,
    vz: number,
    speed: number,
    anticipationFrames: number,
    velocityWeight: number,
    chunkSize: number,
  ): void {
    if (this.heap.length === 0) return;

    const invSpeed = speed > 1e-3 ? 1 / speed : 0;
    const normVx = vx * invSpeed;
    const normVz = vz * invSpeed;
    const lookAheadDistance = speed * (anticipationFrames / 60) * velocityWeight;
    const half = chunkSize / 2;

    for (let i = 0; i < this.heap.length; i++) {
      const s = this.heap[i];
      const dx = s.coord.x * chunkSize + half - camX;
      const dz = s.coord.z * chunkSize + half - camZ;
      const dist = Math.sqrt(dx * dx + dz * dz) || 1;
      const dotVD = (normVx * dx + normVz * dz) / dist;
      s.score = dist - dotVD * lookAheadDistance;
    }

    this.rebuild();
  }

  avgAnticipationGain(): number {
    let totalGain = 0;
    let count = 0;
    for (let i = 0; i < this.heap.length; i++) {
      const s = this.heap[i];
      if (s.distanceAtEnqueue > 0) {
        totalGain += s.distanceAtEnqueue - s.score;
        count++;
      }
    }
    return count > 0 ? totalGain / count : 0;
  }

  clear(): void {
    this.heap.length = 0;
    this.index.clear();
  }

  private worstIndex(): number {
    const n = this.heap.length;
    if (n === 0) return -1;
    let worst = n >> 1;
    for (let i = worst + 1; i < n; i++) {
      if (this.heap[i].score > this.heap[worst].score) worst = i;
    }
    return worst;
  }

  private removeAt(i: number): void {
    const removed = this.heap[i];
    this.index.delete(removed.key);
    const last = this.heap.pop()!;
    if (i < this.heap.length) {
      this.heap[i] = last;
      this.index.set(last.key, i);
      this.siftDown(i);
      this.siftUp(i);
    }
  }

  private rebuild(): void {
    for (let i = 0; i < this.heap.length; i++) this.index.set(this.heap[i].key, i);
    for (let i = (this.heap.length >> 1) - 1; i >= 0; i--) this.siftDown(i);
  }

  private siftUp(i: number): void {
    const heap = this.heap;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[i].score >= heap[parent].score) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private siftDown(i: number): void {
    const heap = this.heap;
    const n = heap.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let smallest = i;
      if (l < n && heap[l].score < heap[smallest].score) smallest = l;
      if (r < n && heap[r].score < heap[smallest].score) smallest = r;
      if (smallest === i) return;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private swap(a: number, b: number): void {
    const heap = this.heap;
    const tmp = heap[a];
    heap[a] = heap[b];
    heap[b] = tmp;
    this.index.set(heap[a].key, a);
    this.index.set(heap[b].key, b);
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

    const slot: { promise: Promise<void>; startedAt: number; settled: boolean } = {
      promise: Promise.resolve(),
      startedAt: performance.now(),
      settled: false,
    };
    slot.promise = genFn().finally(() => {
      slot.settled = true;
    });

    this.slots.set(key, slot);
    return true;
  }

  tick(now: number, onTimeout: (key: ChunkKey) => void): void {
    for (const [key, slot] of this.slots) {
      if (slot.settled) {
        this.slots.delete(key);
      } else if (now - slot.startedAt > this.timeoutMs) {
        this.slots.delete(key);
        console.warn(`[ChunkManager] Slot timeout for chunk ${key} after ${this.timeoutMs}ms`);
        onTimeout(key);
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

const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 8000;

function retryDelayMs(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);
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
  private readonly queue: StreamingPriorityQueue;
  private readonly concurrencyPool: ConcurrencyPool;

  private readonly inflight = new Map<ChunkKey, { token: number; attempts: number }>();
  private nextGenerationToken = 1;

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
    this.queue = new StreamingPriorityQueue(config.RING_BUFFER_CAPACITY);
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

    this.concurrencyPool.tick(frameStart, (key) => this.handleGenerationTimeout(key, frameStart));

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
      frameStart,
    );

    this.queue.retainOnly(desiredKeys);

    this.enqueueNewChunks(desiredChunks, mutations.chunksAfterCull);

    const velChanged =
      Math.abs(this.velocityTracker.vx - this.lastVelocityX) > this.VELOCITY_CHANGE_THRESHOLD ||
      Math.abs(this.velocityTracker.vz - this.lastVelocityZ) > this.VELOCITY_CHANGE_THRESHOLD;

    if (velChanged || this.queue.size > 0) {
      this.queue.reprioritize(
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

    if (this.drainQueue(mutations.chunksAfterCull) > 0) {
      mutations.hasChanges = true;
    }

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
    now: number,
  ): { chunksAfterCull: Map<ChunkKey, Chunk>; keysToRelease: ChunkKey[]; hasChanges: boolean } {
    const working = new Map(currentChunks);
    const keysToRelease: ChunkKey[] = [];
    let hasChanges = false;

    for (const [key, chunk] of currentChunks) {
      const isDesired = desiredKeys.has(key);

      if (chunk.state === 'error') {
        if (!isDesired) {
          keysToRelease.push(key);
          continue;
        }
        const failure = chunk.failure;
        if (!failure || now >= failure.retryAt) {
          working.delete(key);
          hasChanges = true;
          this.queue.enqueue(this.createRequest(chunk.meta.coord, key, failure?.attempts ?? 1));
        }
        continue;
      }

      if (isDesired) {
        if (chunk.state === 'unloading') {
          if (chunk.gpu && chunk.geometryData) {
            working.set(key, {
              ...chunk,
              state: 'ready',
              metrics: { ...chunk.metrics, lastAccessed: now },
            });
          } else if (this.inflight.has(key)) {
            working.set(key, {
              ...chunk,
              state: 'generating',
              metrics: { ...chunk.metrics, lastAccessed: now },
            });
          } else {
            working.delete(key);
          }
          hasChanges = true;
        }
        continue;
      }

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

  private createRequest(coord: ChunkCoord, key: ChunkKey, attempts: number): StreamingRequest {
    const center = getChunkCenter(coord, this.config.CHUNK_SIZE);
    const dist = this.currentCamera ? distanceToChunk(this.currentCamera.position, center) : Infinity;
    return {
      key,
      coord,
      score: dist,
      distanceAtEnqueue: dist,
      enqueuedAt: performance.now(),
      attempts,
    };
  }

  private enqueueNewChunks(desired: ChunkCoord[], working: Map<ChunkKey, Chunk>): void {
    for (const coord of desired) {
      const key = getChunkKey(coord);
      if (working.has(key)) continue;
      if (this.concurrencyPool.has(key)) continue;
      if (this.queue.has(key)) continue;

      this.queue.enqueue(this.createRequest(coord, key, 0));
    }
  }

  private drainQueue(working: Map<ChunkKey, Chunk>): number {
    const freeSlots = this.config.MAX_CONCURRENT_GENERATIONS - this.concurrencyPool.size;
    const budget = Math.min(freeSlots, this.config.GENERATION_BUDGET);

    let submitted = 0;
    while (submitted < budget) {
      const req = this.queue.dequeue();
      if (!req) break;

      const key = req.key;

      // Skip if already active or generating
      if (working.has(key)) continue;
      if (this.concurrencyPool.has(key)) continue;

      const token = this.nextGenerationToken++;
      this.inflight.set(key, { token, attempts: req.attempts });

      // Submit to pool — this starts the async GPU work
      const accepted = this.concurrencyPool.submit(key, () =>
        this.generateChunk(req.coord, key, token),
      );

      if (!accepted) {
        this.inflight.delete(key);
        this.queue.enqueue(req);
        break;
      }

      working.set(key, this.buildPendingChunk(req.coord));
      submitted++;
      this.needsNeighborUpdate = true;
    }

    return submitted;
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

  private buildPendingChunk(coord: ChunkCoord): Chunk {
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
        seed: this.config.NOISE_SEED,
      },
      bounds: this.estimateBounds(coord),
      state: 'generating',
      gpu: null,
      metrics: {
        createdAt: now,
        generationTime: 0,
        lastAccessed: now,
        frameCount: 0,
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

  private async generateChunk(coord: ChunkCoord, key: ChunkKey, token: number): Promise<void> {
    const genStart = performance.now();

    let result: Awaited<ReturnType<GPUGenerator['generateChunk']>>;
    try {
      result = await this.gpuGenerator.generateChunk(coord);
    } catch (error) {
      const owner = this.inflight.get(key);
      if (!owner || owner.token !== token) return;
      this.inflight.delete(key);

      const attempts = owner.attempts + 1;
      console.error(`[ChunkManager] Error generating chunk ${key} (attempt ${attempts}):`, error);
      this.markFailed(key, attempts, performance.now());
      return;
    }

    const owner = this.inflight.get(key);
    if (!owner || owner.token !== token) {
      this.gpuGenerator.releaseResources(result.gpuResources);
      return;
    }
    this.inflight.delete(key);

    const chunks = this.activeChunks();
    const chunk = chunks.get(key);
    if (!chunk || (chunk.state !== 'generating' && chunk.state !== 'unloading')) {
      this.gpuGenerator.releaseResources(result.gpuResources);
      return;
    }

    const now = performance.now();
    const wasUnloading = chunk.state === 'unloading';
    const next = new Map(chunks);
    next.set(key, {
      ...chunk,
      state: wasUnloading ? 'unloading' : 'ready',
      bounds: result.bounds,
      gpu: result.gpuResources,
      geometryData: result.geometry,
      failure: undefined,
      metrics: {
        ...chunk.metrics,
        generationTime: now - genStart,
        lastAccessed: wasUnloading ? chunk.metrics.lastAccessed : now,
        frameCount: 0,
      },
    });
    this.activeChunks.set(next);

    this.submissionCounter.update((n) => n + 1);
    this.needsNeighborUpdate = true;
  }

  private handleGenerationTimeout(key: ChunkKey, now: number): void {
    const owner = this.inflight.get(key);
    if (!owner) return;
    this.inflight.delete(key);
    this.markFailed(key, owner.attempts + 1, now);
  }

  private markFailed(key: ChunkKey, attempts: number, now: number): void {
    const chunks = this.activeChunks();
    const chunk = chunks.get(key);
    if (!chunk) return;

    if (chunk.gpu) {
      this.gpuGenerator.releaseResources(chunk.gpu);
    }

    const next = new Map(chunks);
    next.set(key, {
      ...chunk,
      state: 'error',
      gpu: null,
      geometryData: undefined,
      failure: { attempts, retryAt: now + retryDelayMs(attempts) },
    });
    this.activeChunks.set(next);
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
      const bufferSize = this.queue.size;
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
          anticipationScore: this.queue.avgAnticipationGain(),
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
    this.queue.clear();
    this.concurrencyPool.clear();
    this.inflight.clear();
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
