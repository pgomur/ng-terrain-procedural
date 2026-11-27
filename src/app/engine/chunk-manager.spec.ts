import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChunkManager } from './chunk-manager';
import { DEFAULT_TERRAIN_CONFIG, type TerrainConfig } from '../types/terrain';
import type { FrustumPlanes } from '../types/chunk';
import { CpuHeightGenerator } from '../../testing/cpu-height-generator';

const config: TerrainConfig = {
  ...DEFAULT_TERRAIN_CONFIG,
  CHUNK_SIZE: 64,
  LOD_DISTANCES: [150, 300, 450],
  GENERATION_BUDGET: 4,
  GENERATION_QUEUE_CAPACITY: 32,
  UNLOAD_DELAY_MS: 32,
};
const everything: FrustumPlanes = {
  normals: Array(6).fill({ x: 0, y: 0, z: 0 }),
  constants: Array(6).fill(1e9),
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 2));
const cameraAt = (x: number, z: number) => ({ x, y: 50, z });

function createManager(generator: CpuHeightGenerator, cfg = config) {
  return new ChunkManager(cfg, generator as never);
}

async function runUntilSettled(manager: ChunkManager, camera: { x: number; y: number; z: number }, maxFrames = 3000) {
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

  it('retries failed generations with backoff instead of leaving holes', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const generator = new CpuHeightGenerator(config, (key, attempt) =>
      key === '0:0:0' && attempt <= 3 ? 'fail' : 'ok',
    );
    const manager = createManager(generator);
    expect(await runUntilSettled(manager, cameraAt(0, 0))).toBeGreaterThan(0);
    expect(manager.getChunks().get('0:0:0')?.state).toBe('ready');
    expect(generator.attempts.get('0:0:0')).toBe(4);
    expect(errors).toHaveBeenCalledTimes(3);
    expect(generator.live.size).toBe(slotsHeld(manager));
  }, 30_000);

  it('ignores bounds and heights that arrive after the chunk was released', async () => {
    const generator = new CpuHeightGenerator(
      config,
      () => 'ok',
      () => 50,
      200,
    );
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
    const generator = new CpuHeightGenerator(
      config,
      () => 'ok',
      (x, z) => 10 + x * 0.01 + z * 0.02,
    );
    generator.failHeightsOnce.add('0:0:0');
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
    const failsFirst = (key: string) => {
      let hash = 7;
      for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
      return hash % 7 === 0;
    };
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

describe('ChunkManager incremental culling', () => {
  const quickConfig: TerrainConfig = {
    ...config,
    GENERATION_BUDGET: 64,
    GENERATION_QUEUE_CAPACITY: 4096,
    UNLOAD_DELAY_MS: 320,
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['default limits', quickConfig],
    ['eviction over MAX_CHUNKS', { ...quickConfig, MAX_CHUNKS: 240 }],
  ])(
    'produces exactly the same chunks, states and visibility as a full scan every frame (%s)',
    async (_, cfg) => {
      let now = 1000;
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const behaviour = (key: string, attempt: number) => {
        let hash = 11;
        for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
        return attempt <= 2 && hash % 9 === 0 ? 'fail' : 'ok';
      };
      const incremental = new ChunkManager(cfg, new CpuHeightGenerator(cfg, behaviour) as never);
      const fullScan = new ChunkManager(cfg, new CpuHeightGenerator(cfg, behaviour) as never);
      const forceFullScan = fullScan as unknown as { cullDirty: boolean; enqueueDirty: boolean };

      const snapshot = (manager: ChunkManager) =>
        [...manager.getChunks()]
          .map(([key, chunk]) => `${key}=${chunk.state}${chunk.gpu ? '' : '-'}`)
          .sort()
          .join(',') +
        '|' +
        [...manager.getVisibleKeys()].sort().join(',');

      let walk = 7;
      const step = () => (walk = (walk * 1103515245 + 12345) >>> 0) / 2 ** 32;
      let x = 0;
      let z = 0;
      let firstMismatch = '';
      const seen = { unloading: 0, error: 0, released: 0, maxChunks: 0 };

      for (let frame = 0; frame < 1200; frame++) {
        const phase = frame % 200;
        if (phase < 30) {
          x += 9;
          z += 4;
        } else if (phase === 120) {
          x += (step() - 0.5) * 3000;
          z += (step() - 0.5) * 3000;
        }

        const before = incremental.getChunks().size;
        forceFullScan.cullDirty = true;
        forceFullScan.enqueueDirty = true;
        incremental.update(cameraAt(x, z), everything);
        fullScan.update(cameraAt(x, z), everything);
        incremental.clearRenderChanges();
        fullScan.clearRenderChanges();

        const stats = incremental.getStats();
        seen.unloading += stats.unloadingCount;
        seen.error += stats.errorCount;
        if (incremental.getChunks().size < before) seen.released++;
        seen.maxChunks = Math.max(seen.maxChunks, incremental.getChunks().size);

        if (!firstMismatch && snapshot(incremental) !== snapshot(fullScan)) firstMismatch = `frame ${frame}`;

        now += 16;
        await tick();
      }

      expect(firstMismatch).toBe('');
      expect(seen.unloading).toBeGreaterThan(0);
      expect(seen.error).toBeGreaterThan(0);
      expect(seen.released).toBeGreaterThan(0);
      if (cfg.MAX_CHUNKS < 1024) expect(seen.maxChunks).toBeGreaterThan(cfg.MAX_CHUNKS);
    },
    60_000,
  );

  it('skips the full scan while nothing changes and wakes up exactly when a chunk must unload', async () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const manager = new ChunkManager(quickConfig, new CpuHeightGenerator(quickConfig) as never);
    const internals = manager as unknown as { cullAndRetry(time: number): void };
    const cull = vi.spyOn(internals, 'cullAndRetry');
    const frame = async (x: number) => {
      manager.update(cameraAt(x, 0), everything);
      manager.clearRenderChanges();
      now += 16;
      await tick();
    };

    for (let i = 0; i < 40; i++) await frame(0);
    cull.mockClear();
    for (let i = 0; i < 60; i++) await frame(0);
    expect(cull).not.toHaveBeenCalled();

    await frame(5000);
    await frame(5000);
    const jumpedAt = now;
    const unloading = manager.getStats().unloadingCount;
    expect(unloading).toBeGreaterThan(0);

    const delayMs = quickConfig.UNLOAD_DELAY_MS;
    while (now < jumpedAt + delayMs - 64) await frame(5000);
    cull.mockClear();
    while (now < jumpedAt + delayMs - 32) await frame(5000);
    expect(cull).not.toHaveBeenCalled();
    expect(manager.getStats().unloadingCount).toBe(unloading);

    for (let i = 0; i < 6; i++) await frame(5000);
    expect(cull).toHaveBeenCalled();
    expect(manager.getStats().unloadingCount).toBe(0);
  });
});
