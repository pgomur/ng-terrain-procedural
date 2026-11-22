import { ChunkKey, StreamingRequest } from '../types/chunk';

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
