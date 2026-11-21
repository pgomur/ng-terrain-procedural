import {
  Chunk,
  ChunkCoord,
  ChunkKey,
  ChunkLOD,
  FrustumPlanes,
  ChunkBounds,
  StreamingRequest,
  ConcurrencySlot,
  WorldPosition,
} from '../types/chunk';
import { TerrainConfig, CameraState } from '../types/terrain';
import { GPUGenerator } from './gpu-generator';
import {
  getChunkKey,
  distanceToChunk,
  selectLODForDistance,
  getChunkCenter,
  intersectsFrustumAABB,
  isRenderableChunk,
  spatialKeyOf,
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

export interface ChunkManagerStats {
  readonly activeCount: number;
  readonly readyCount: number;
  readonly unloadingCount: number;
  readonly generatingCount: number;
  readonly errorCount: number;
  readonly visibleCount: number;
  readonly pendingCount: number;
  readonly concurrencySlots: number;
  readonly storageBytes: number;
  readonly updateTimeMs: number;
  readonly streamingBufferUsage: number;
  readonly anticipationScore: number;
}

interface DesiredChunk {
  readonly coord: ChunkCoord;
  readonly key: ChunkKey;
}

const UNLOAD_FRAME_MS = 16;
const MAX_LOD: ChunkLOD = 3;

export class ChunkManager {
  private readonly config: TerrainConfig;
  private readonly gpuGenerator: GPUGenerator;

  private readonly chunks = new Map<ChunkKey, Chunk>();
  private readonly visibleKeys = new Set<ChunkKey>();
  private readonly releaseKeys = new Set<ChunkKey>();
  private readonly dirtyCoords = new Set<string>();
  private readonly visibilityToggled = new Set<ChunkKey>();
  private chunksChanged = true;

  private readonly velocityTracker = new CameraVelocityTracker(0.15);
  private readonly queue: StreamingPriorityQueue;
  private readonly concurrencyPool: ConcurrencyPool;

  private readonly inflight = new Map<ChunkKey, { token: number; attempts: number }>();
  private nextGenerationToken = 1;

  private lastCameraPos = { x: Infinity, z: Infinity };
  private lastVelocityX = 0;
  private lastVelocityZ = 0;
  private readonly VELOCITY_CHANGE_THRESHOLD = 5; // world-units/s

  private desired: DesiredChunk[] = [];
  private readonly desiredKeys = new Set<ChunkKey>();
  private readonly desiredLODByCoord = new Map<string, ChunkLOD>();
  private readonly CACHE_THRESHOLD = 0.1;

  private cameraX = 0;
  private cameraZ = 0;
  private hasCamera = false;
  private lastUpdateTimeMs = 0;

  constructor(config: TerrainConfig, gpuGenerator: GPUGenerator) {
    this.config = config;
    this.gpuGenerator = gpuGenerator;
    this.queue = new StreamingPriorityQueue(config.RING_BUFFER_CAPACITY);
    this.concurrencyPool = new ConcurrencyPool(
      config.MAX_CONCURRENT_GENERATIONS,
      config.GENERATION_TIMEOUT_MS,
    );
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

  update(camera: CameraState, frustum: FrustumPlanes, viewChanged = true): void {
    const frameStart = performance.now();
    const position = camera.position;

    this.cameraX = position.x;
    this.cameraZ = position.z;
    this.hasCamera = true;

    this.velocityTracker.update(position.x, position.z, frameStart);

    this.concurrencyPool.tick(frameStart, (key) => this.handleGenerationTimeout(key, frameStart));

    this.refreshDesiredChunks(position);

    this.cullAndRetry(frameStart);
    this.releasePendingKeys();

    this.queue.retainOnly(this.desiredKeys);

    this.enqueueNewChunks();

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
        this.config.ANTICIPATION_FRAMES,
        this.config.VELOCITY_WEIGHT,
        this.config.CHUNK_SIZE,
      );
      this.lastVelocityX = this.velocityTracker.vx;
      this.lastVelocityZ = this.velocityTracker.vz;
    }

    this.drainQueue();

    if (viewChanged || this.chunksChanged) {
      this.updateVisibility(frustum);
      this.chunksChanged = false;
    }

    this.lastUpdateTimeMs = performance.now() - frameStart;
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
    this.desiredLODByCoord.clear();
    for (const entry of this.desired) {
      this.desiredKeys.add(entry.key);
      this.desiredLODByCoord.set(spatialKeyOf(entry.coord), entry.coord.lod);
    }
  }

  private calculateDesiredChunks(position: WorldPosition): DesiredChunk[] {
    const desired: DesiredChunk[] = [];
    const centerX = Math.floor(position.x / this.config.CHUNK_SIZE);
    const centerZ = Math.floor(position.z / this.config.CHUNK_SIZE);

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
        const dist = distanceToChunk(position, center);

        if (dist < maxDist) {
          const lod = selectLODForDistance(dist, this.config.LOD_DISTANCES);
          const coord: ChunkCoord = { x: chunkX, z: chunkZ, lod };
          desired.push({ coord, key: getChunkKey(coord) });
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
          this.queue.enqueue(this.createRequest(chunk.meta.coord, key, failure?.attempts ?? 1, now));
        }
        continue;
      }

      if (isDesired) {
        if (chunk.state === 'unloading') {
          if (chunk.gpu && chunk.geometryData) {
            chunk.state = 'ready';
            chunk.metrics.lastAccessed = now;
            this.markRenderChange(chunk);
          } else if (this.inflight.has(key)) {
            chunk.state = 'generating';
            chunk.metrics.lastAccessed = now;
          } else {
            this.chunks.delete(key);
          }
        }
        continue;
      }

      const desiredLOD = this.desiredLODByCoord.get(spatialKeyOf(chunk.meta.coord));

      if (desiredLOD !== undefined) {
        const replacement = this.chunks.get(
          `${chunk.meta.coord.x}:${chunk.meta.coord.z}:${desiredLOD}` as ChunkKey,
        );
        if (!replacement || replacement.state !== 'ready') {
          chunk.metrics.lastAccessed = now;
          continue;
        }
      }

      if (chunk.state === 'unloading') {
        const framesPassed = (now - chunk.metrics.lastAccessed) / UNLOAD_FRAME_MS;
        if (framesPassed > this.config.UNLOAD_DELAY_FRAMES) {
          this.releaseKeys.add(key);
        }
      } else {
        const wasRenderable = isRenderableChunk(chunk);
        chunk.state = 'unloading';
        chunk.metrics.lastAccessed = now;
        if (wasRenderable) this.markRenderChange(chunk);
      }
    }

    // Evict excess if over MAX_CHUNKS
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
      if (chunk.gpu) {
        this.gpuGenerator.releaseResources(chunk.gpu);
        chunk.gpu = null;
      }
      if (isRenderableChunk(chunk)) this.markRenderChange(chunk);
      this.chunks.delete(key);
      if (this.visibleKeys.delete(key)) this.visibilityToggled.add(key);
    }

    this.releaseKeys.clear();
  }

  private markRenderChange(chunk: Chunk): void {
    this.dirtyCoords.add(spatialKeyOf(chunk.meta.coord));
    this.chunksChanged = true;
  }

  private createRequest(
    coord: ChunkCoord,
    key: ChunkKey,
    attempts: number,
    now: number,
  ): StreamingRequest {
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
      distanceAtEnqueue: dist,
      enqueuedAt: now,
      attempts,
    };
  }

  private enqueueNewChunks(): void {
    const now = performance.now();
    for (const entry of this.desired) {
      const key = entry.key;
      if (this.chunks.has(key)) continue;
      if (this.concurrencyPool.has(key)) continue;
      if (this.queue.has(key)) continue;

      this.queue.enqueue(this.createRequest(entry.coord, key, 0, now));
    }
  }

  private drainQueue(): number {
    const freeSlots = this.config.MAX_CONCURRENT_GENERATIONS - this.concurrencyPool.size;
    const budget = Math.min(freeSlots, this.config.GENERATION_BUDGET);

    let submitted = 0;
    while (submitted < budget) {
      const req = this.queue.dequeue();
      if (!req) break;

      const key = req.key;

      // Skip if already active or generating
      if (this.chunks.has(key)) continue;
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

      this.chunks.set(key, this.buildPendingChunk(req.coord));
      submitted++;
    }

    return submitted;
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

    const chunk = this.chunks.get(key);
    if (!chunk || (chunk.state !== 'generating' && chunk.state !== 'unloading')) {
      this.gpuGenerator.releaseResources(result.gpuResources);
      return;
    }

    const now = performance.now();
    if (chunk.state === 'generating') {
      chunk.state = 'ready';
      chunk.metrics.lastAccessed = now;
    }
    chunk.bounds = result.bounds;
    chunk.gpu = result.gpuResources;
    chunk.geometryData = result.geometry;
    chunk.failure = undefined;
    chunk.metrics.generationTime = now - genStart;

    if (isRenderableChunk(chunk)) this.markRenderChange(chunk);
  }

  private handleGenerationTimeout(key: ChunkKey, now: number): void {
    const owner = this.inflight.get(key);
    if (!owner) return;
    this.inflight.delete(key);
    this.markFailed(key, owner.attempts + 1, now);
  }

  private markFailed(key: ChunkKey, attempts: number, now: number): void {
    const chunk = this.chunks.get(key);
    if (!chunk) return;

    if (isRenderableChunk(chunk)) this.markRenderChange(chunk);
    if (chunk.gpu) {
      this.gpuGenerator.releaseResources(chunk.gpu);
    }

    chunk.state = 'error';
    chunk.gpu = null;
    chunk.geometryData = undefined;
    chunk.failure = { attempts, retryAt: now + retryDelayMs(attempts) };
    if (this.visibleKeys.delete(key)) this.visibilityToggled.add(key);
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
    let generatingCount = 0;
    let errorCount = 0;
    let storageBytes = 0;

    for (const chunk of this.chunks.values()) {
      switch (chunk.state) {
        case 'ready':
          readyCount++;
          break;
        case 'unloading':
          unloadingCount++;
          break;
        case 'generating':
        case 'pending':
          generatingCount++;
          break;
        case 'error':
          errorCount++;
          break;
      }
      if (chunk.gpu) {
        const res = chunk.meta.resolution;
        storageBytes += res * res * 4;
      }
    }

    const capacity = this.config.RING_BUFFER_CAPACITY;

    return {
      activeCount: this.chunks.size,
      readyCount,
      unloadingCount,
      generatingCount,
      errorCount,
      visibleCount: this.visibleKeys.size,
      pendingCount: this.queue.size,
      concurrencySlots: this.concurrencyPool.size,
      storageBytes,
      updateTimeMs: this.lastUpdateTimeMs,
      streamingBufferUsage: capacity > 0 ? this.queue.size / capacity : 0,
      anticipationScore: this.queue.avgAnticipationGain(),
    };
  }

  getTerrainHeightAt(x: number, z: number): number | null {
    const size = this.config.CHUNK_SIZE;
    const chunkX = Math.floor(x / size);
    const chunkZ = Math.floor(z / size);

    let target: Chunk | undefined;
    for (let lod = 0; lod <= MAX_LOD; lod++) {
      const chunk = this.chunks.get(`${chunkX}:${chunkZ}:${lod}` as ChunkKey);
      if (!chunk || !chunk.geometryData) continue;
      if (chunk.state === 'ready') {
        target = chunk;
        break;
      }
      if (!target && chunk.state === 'unloading') target = chunk;
    }

    if (!target || !target.geometryData) return null;

    const res = target.meta.resolution;
    const cellSize = size / (res - 1);

    const fx = (x - chunkX * size) / cellSize;
    const fz = (z - chunkZ * size) / cellSize;

    const gridX = Math.min(Math.max(Math.floor(fx), 0), res - 2);
    const gridZ = Math.min(Math.max(Math.floor(fz), 0), res - 2);

    const u = Math.min(Math.max(fx - gridX, 0), 1);
    const v = Math.min(Math.max(fz - gridZ, 0), 1);

    const { positions } = target.geometryData;
    const h00 = positions[(gridZ * res + gridX) * 3 + 1];
    const h10 = positions[(gridZ * res + gridX + 1) * 3 + 1];
    const h01 = positions[((gridZ + 1) * res + gridX) * 3 + 1];
    const h11 = positions[((gridZ + 1) * res + gridX + 1) * 3 + 1];

    if (u + v <= 1) {
      return h00 + (h10 - h00) * u + (h01 - h00) * v;
    }
    return h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
  }

  clearAllChunks(): void {
    for (const chunk of this.chunks.values()) {
      if (chunk.gpu) {
        this.gpuGenerator.releaseResources(chunk.gpu);
        chunk.gpu = null;
      }
      if (isRenderableChunk(chunk)) this.markRenderChange(chunk);
    }
    for (const key of this.visibleKeys) this.visibilityToggled.add(key);

    this.chunks.clear();
    this.visibleKeys.clear();
    this.releaseKeys.clear();
    this.queue.clear();
    this.concurrencyPool.clear();
    this.inflight.clear();
    this.desired = [];
    this.desiredKeys.clear();
    this.desiredLODByCoord.clear();
    this.lastCameraPos = { x: Infinity, z: Infinity };
    this.velocityTracker.reset();
    this.chunksChanged = true;
  }

  dispose(): void {
    this.clearAllChunks();
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
