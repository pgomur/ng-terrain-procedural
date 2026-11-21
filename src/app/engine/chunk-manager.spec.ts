import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChunkManager, StreamingPriorityQueue } from './chunk-manager';
import { DEFAULT_TERRAIN_CONFIG, type TerrainConfig } from '../types/terrain';
import type { ChunkKey, FrustumPlanes, StreamingRequest } from '../types/chunk';
import { CpuHeightGenerator } from '../../testing/cpu-height-generator';

const config: TerrainConfig = {
  ...DEFAULT_TERRAIN_CONFIG,
  CHUNK_SIZE: 64,
  LOD_DISTANCES: [150, 300, 450],
  GENERATION_BUDGET: 4,
  GENERATION_QUEUE_CAPACITY: 32,
  UNLOAD_DELAY_FRAMES: 2,
};
const everything: FrustumPlanes = {
  normals: Array(6).fill({ x: 0, y: 0, z: 0 }),
  constants: Array(6).fill(1e9),
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 2));
const cameraAt = (x: number, z: number) => ({ position: { x, y: 50, z } }) as never;

function createManager(generator: CpuHeightGenerator, cfg = config) {
  return new ChunkManager(cfg, generator as never);
}

async function runUntilSettled(manager: ChunkManager, camera: never, maxFrames = 3000) {
  for (let frame = 0; frame < maxFrames; frame++) {
    manager.update(camera, everything);
    manager.clearRenderChanges();
    await tick();
    const stats = manager.getStats();
    if (
      frame > 3 &&
      stats.pendingCount === 0 &&
      stats.errorCount === 0 &&
      stats.unloadingCount === 0 &&
      stats.exactBoundsCount === stats.readyCount &&
      stats.readyCount > 0
    ) {
      return frame;
    }
  }
  return -1;
}

const slotsHeld = (manager: ChunkManager) => [...manager.getChunks().values()].filter((c) => c.gpu).length;

let seed = 42;
const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const request = (x: number, score: number): StreamingRequest => ({
  key: `${x}:0:0` as ChunkKey,
  coord: { x, z: 0, lod: 0 },
  score,
  distanceAtEnqueue: score,
  enqueuedAt: 0,
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
            const evicted = [...model.entries()].filter(([, v]) => v === worst).map(([k]) => k).find((k) => !queue.has(k));
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
    queue.reprioritize(0, 0, 100, 0, 100, 60, 1, 128);
    const first = queue.dequeue()!;
    const dx = 5 * 128 + 64;
    const distance = Math.hypot(dx, 64);
    expect(first.key).toBe('5:0:0');
    expect(first.score).toBeCloseTo(distance - (dx / distance) * 100, 6);
  });
});

describe('ChunkManager', () => {
  afterEach(() => vi.restoreAllMocks());

  it('generates synchronously within the per-frame budget', () => {
    const generator = new CpuHeightGenerator(config);
    const manager = createManager(generator);
    manager.update(cameraAt(0, 0), everything);
    const stats = manager.getStats();
    expect(stats.readyCount).toBe(config.GENERATION_BUDGET);
    expect(stats.exactBoundsCount).toBe(0);
    expect(generator.live.size).toBe(config.GENERATION_BUDGET);
  });

  it('loads the whole area, refines every bound and holds one slot per chunk', async () => {
    const generator = new CpuHeightGenerator(config);
    const manager = createManager(generator);
    expect(await runUntilSettled(manager, cameraAt(0, 0))).toBeGreaterThan(0);
    expect(generator.live.size).toBe(slotsHeld(manager));
  }, 30_000);

  it('retries failed generations with backoff instead of leaving holes', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const generator = new CpuHeightGenerator(config, (key, attempt) =>
      key === '0:0:0' && attempt <= 3 ? 'fail' : 'ok',
    );
    const manager = createManager(generator);
    expect(await runUntilSettled(manager, cameraAt(0, 0))).toBeGreaterThan(0);
    expect(manager.getChunks().get('0:0:0' as ChunkKey)?.state).toBe('ready');
    expect(generator.attempts.get('0:0:0' as ChunkKey)).toBe(4);
    expect(errors).toHaveBeenCalledTimes(3);
    expect(generator.live.size).toBe(slotsHeld(manager));
  }, 30_000);

  it('ignores bounds and heights that arrive after the chunk was released', async () => {
    const generator = new CpuHeightGenerator(config, () => 'ok', () => 50, 200);
    const manager = createManager(generator);
    manager.update(cameraAt(0, 0), everything);
    const firstChunks = [...manager.getChunks().values()];
    manager.update(cameraAt(5000, 5000), everything);
    manager.clearRenderChanges();
    await new Promise((resolve) => setTimeout(resolve, 60));
    manager.update(cameraAt(5000, 5000), everything);
    manager.clearRenderChanges();
    expect(firstChunks.every((c) => c.gpu === null)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(generator.staleCallbacks).toBeGreaterThan(0);
    expect(firstChunks.every((c) => c.gpu === null && c.heights === undefined)).toBe(true);
    expect(await runUntilSettled(manager, cameraAt(5000, 5000))).toBeGreaterThan(0);
    expect(generator.live.size).toBe(slotsHeld(manager));
  }, 30_000);

  it('requests collision heights around the camera and retries a failed read', async () => {
    const generator = new CpuHeightGenerator(config, () => 'ok', (x, z) => 10 + x * 0.01 + z * 0.02);
    generator.failHeightsOnce.add('0:0:0' as ChunkKey);
    const manager = createManager(generator);
    await runUntilSettled(manager, cameraAt(10, 10));
    for (let frame = 0; frame < 20; frame++) {
      manager.update(cameraAt(10, 10), everything);
      manager.clearRenderChanges();
      await tick();
    }
    expect(manager.getStats().heightsCachedCount).toBe(9);
    expect(manager.getTerrainHeightAt(10, 10)!).toBeCloseTo(10.3, 4);
  }, 30_000);

  it('survives a long flight without leaks, with a bounded queue', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failsFirst = (key: string) => [...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 7 === 0;
    const generator = new CpuHeightGenerator(config, (key, attempt) =>
      attempt === 1 && failsFirst(key) ? 'fail' : 'ok',
    );
    const manager = createManager(generator);
    let x = 0;
    for (let frame = 0; frame < 1500; frame++) {
      x += frame % 300 < 200 ? 9 : -14;
      manager.update(cameraAt(x, x * 0.3), everything);
      manager.clearRenderChanges();
      if (frame % 3 === 0) await tick();
      expect(manager.getStats().pendingCount).toBeLessThanOrEqual(config.GENERATION_QUEUE_CAPACITY);
    }
    expect(await runUntilSettled(manager, cameraAt(x, x * 0.3))).toBeGreaterThan(0);
    expect(generator.live.size).toBe(slotsHeld(manager));
    expect(generator.failures).toBeGreaterThan(50);
    expect(errors).toHaveBeenCalledTimes(generator.failures);
    expect(manager.getStats().errorCount).toBe(0);
  }, 60_000);
});
