/**
 * The priority queue of chunks waiting to be generated.
 *
 * Many more chunks are usually missing than the GPU can generate in one frame, especially at start-up and when flying fast. {@link StreamingPriorityQueue} decides the order: chunks closest to the camera first, with an advantage for those ahead of its motion and a penalty for those behind.
 *
 * | Operation | Cost |
 * | --- | --- |
 * | {@link StreamingPriorityQueue.enqueue}, {@link StreamingPriorityQueue.dequeue}, {@link StreamingPriorityQueue.remove} | `O(log n)` |
 * | {@link StreamingPriorityQueue.has} | `O(1)` |
 * | {@link StreamingPriorityQueue.reprioritize}, {@link StreamingPriorityQueue.retainOnly} | `O(n)` |
 *
 * It is bounded by `GENERATION_QUEUE_CAPACITY` (256 by default): when full, a better request replaces the worst one, and a request that is not better is refused, to be offered again on a later frame while its chunk is still wanted.
 *
 * See [Streaming and levels of detail](../../../guides/streaming.md#priority).
 *
 * @module
 */
import { ChunkKey, StreamingRequest } from '../types/chunk';

/**
 * Bounded priority queue of chunks waiting to be generated.
 *
 * It is a binary min-heap ordered by {@link types/chunk!StreamingRequest.score | StreamingRequest.score} with an index by key, so a chunk can be looked up, updated or removed in `O(log n)`. When it is full, a better request replaces the worst one.
 *
 * @example
 * ```ts
 * const queue = new StreamingPriorityQueue(256);
 * queue.enqueue({ key: '0:0:0', coord: { x: 0, z: 0, lod: 0 }, score: 64, attempts: 0 });
 * queue.enqueue({ key: '5:0:1', coord: { x: 5, z: 0, lod: 1 }, score: 700, attempts: 0 });
 *
 * queue.reprioritize(camera.x, camera.z, velocity.vx, velocity.vz, velocity.speed, 1, 0.6, 128);
 * const next = queue.dequeue();
 * ```
 */
export class StreamingPriorityQueue {
  private readonly heap: StreamingRequest[] = [];
  private readonly index = new Map<ChunkKey, number>();
  private readonly capacity: number;

  /**
   * Creates an empty queue.
   *
   * @param capacity - Maximum number of requests, at least one.
   */
  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  /**
   * Number of queued requests.
   *
   * At most the capacity given to the constructor.
   */
  get size(): number {
    return this.heap.length;
  }

  /**
   * Whether a chunk is queued.
   *
   * @param key - Key of the chunk.
   *
   * @returns `true` when a request for that chunk is queued.
   */
  has(key: ChunkKey): boolean {
    return this.index.has(key);
  }

  /**
   * Adds a request, or updates the one already queued for the same chunk.
   *
   * An existing request keeps the lower of both scores and the higher attempt count. When the queue is full, the request replaces the worst queued one only if its score is lower.
   *
   * @param req - Request to add. It is stored, not copied.
   * @returns `false` when the queue is full and the request is not better than any queued one.
   */
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

  /**
   * Removes and returns the request with the lowest score.
   *
   * @returns The request, or `null` when the queue is empty.
   */
  dequeue(): StreamingRequest | null {
    if (this.heap.length === 0) return null;
    const top = this.heap[0];
    this.removeAt(0);
    return top;
  }

  /**
   * Removes a chunk's request.
   *
   * @param key - Key of the chunk.
   * @returns Whether a request was removed.
   */
  remove(key: ChunkKey): boolean {
    const i = this.index.get(key);
    if (i === undefined) return false;
    this.removeAt(i);
    return true;
  }

  /**
   * Drops every request whose chunk is not in `keep`, so chunks that stopped being wanted never reach the GPU.
   *
   * @param keep - Keys of the chunks to keep.
   *
   * The {@link engine/chunk-manager!ChunkManager | ChunkManager} calls it every frame with the wanted set, before generating.
   */
  retainOnly(keep: ReadonlySet<ChunkKey>): void {
    let write = 0;
    for (const req of this.heap) {
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

  /**
   * Recomputes every score from the camera position and velocity, then restores the heap order.
   *
   * The score is the distance from the camera to the chunk's centre minus a look-ahead along the direction of travel: `distance - cos(angle) × speed × anticipationSeconds × velocityWeight`, where `angle` is between the velocity and the direction to the chunk. Chunks ahead of the camera therefore come first.
   *
   * @param camX - Camera position along X.
   * @param camZ - Camera position along Z.
   * @param vx - Camera velocity along X, in world units per second.
   * @param vz - Camera velocity along Z, in world units per second.
   * @param speed - Magnitude of the horizontal velocity.
   * @param anticipationSeconds - `ANTICIPATION_SECONDS`.
   * @param velocityWeight - `VELOCITY_WEIGHT`.
   * @param chunkSize - `CHUNK_SIZE`.
   *
   * With `speed` at `0`, or with `velocityWeight` at `0`, the score is just the distance. The heap is rebuilt in place in `O(n)`.
   */
  reprioritize(
    camX: number,
    camZ: number,
    vx: number,
    vz: number,
    speed: number,
    anticipationSeconds: number,
    velocityWeight: number,
    chunkSize: number,
  ): void {
    if (this.heap.length === 0) return;

    const invSpeed = speed > 1e-3 ? 1 / speed : 0;
    const normVx = vx * invSpeed;
    const normVz = vz * invSpeed;
    const lookAheadDistance = speed * anticipationSeconds * velocityWeight;
    const half = chunkSize / 2;

    for (const s of this.heap) {
      const dx = s.coord.x * chunkSize + half - camX;
      const dz = s.coord.z * chunkSize + half - camZ;
      const dist = Math.sqrt(dx * dx + dz * dz) || 1;
      const dotVD = (normVx * dx + normVz * dz) / dist;
      s.score = dist - dotVD * lookAheadDistance;
    }

    this.rebuild();
  }

  /**
   * Removes every request.
   *
   * Used when the manager is disposed.
   */
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
    const last = this.heap.pop();
    if (last === undefined || i >= this.heap.length) return;
    this.heap[i] = last;
    this.index.set(last.key, i);
    this.siftDown(i);
    this.siftUp(i);
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
