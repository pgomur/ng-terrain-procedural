import { describe, expect, it } from 'vitest';
import { StreamingPriorityQueue } from './streaming-queue';
import type { ChunkKey, StreamingRequest } from '../types/chunk';

let seed = 42;
const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const request = (x: number, score: number): StreamingRequest => ({
  key: `${x}:0:0` as ChunkKey,
  coord: { x, z: 0, lod: 0 },
  score,
  attempts: 0,
});

describe('StreamingPriorityQueue', () => {
  it('matches a reference model under random operations', () => {
    const capacity = 64;
    const queue = new StreamingPriorityQueue(capacity);
    const model = new Map<ChunkKey, number>();

    for (let step = 0; step < 40_000; step++) {
      const op = random();
      if (op < 0.55) {
        const r = request(Math.floor(random() * 200), Math.floor(random() * 10_000));
        const existed = model.has(r.key);
        const stored = queue.enqueue(r);
        if (existed) {
          model.set(r.key, Math.min(model.get(r.key)!, r.score));
          expect(stored).toBe(true);
        } else if (model.size < capacity) {
          model.set(r.key, r.score);
          expect(stored).toBe(true);
        } else {
          const worst = Math.max(...model.values());
          if (r.score < worst) {
            expect(stored).toBe(true);
            const evicted = [...model.entries()]
              .filter(([, v]) => v === worst)
              .map(([k]) => k)
              .find((k) => !queue.has(k));
            expect(evicted).toBeDefined();
            model.delete(evicted!);
            model.set(r.key, r.score);
          } else {
            expect(stored).toBe(false);
          }
        }
      } else if (op < 0.85) {
        const got = queue.dequeue();
        if (model.size === 0) {
          expect(got).toBeNull();
          continue;
        }
        const best = Math.min(...model.values());
        expect(got!.score).toBe(best);
        model.delete(got!.key);
      } else if (op < 0.95) {
        const key = `${Math.floor(random() * 200)}:0:0` as ChunkKey;
        expect(queue.remove(key)).toBe(model.delete(key));
      } else {
        const keep = new Set<ChunkKey>([...model.keys()].filter(() => random() < 0.7));
        queue.retainOnly(keep);
        for (const key of [...model.keys()]) if (!keep.has(key)) model.delete(key);
      }
      expect(queue.size).toBe(model.size);
    }
  });

  it('prioritises chunks ahead of the camera with a look-ahead measured in seconds', () => {
    const queue = new StreamingPriorityQueue(16);
    queue.enqueue(request(5, 0));
    queue.enqueue(request(-6, 0));
    queue.reprioritize(0, 0, 100, 0, 100, 1, 1, 128);
    const first = queue.dequeue()!;
    const dx = 5 * 128 + 64;
    const distance = Math.hypot(dx, 64);
    expect(first.key).toBe('5:0:0');
    expect(first.score).toBeCloseTo(distance - (dx / distance) * 100, 6);
  });
});
