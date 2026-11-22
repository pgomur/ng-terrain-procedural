import * as THREE from 'three';
import { FrameStatsCollector, STATS_INTERVAL_MS, type FrameStatsSources } from './frame-stats';
import { DEFAULT_TERRAIN_CONFIG } from '../types/terrain';

function createSources(camera: THREE.PerspectiveCamera, generator: { generatedCount: number }): FrameStatsSources {
  const chunkManager = {
    getStats: () => ({
      readyCount: 10,
      unloadingCount: 2,
      errorCount: 1,
      visibleCount: 6,
      visibleByLod: [1, 2, 3, 0],
      pendingCount: 4,
      exactBoundsCount: 10,
      heightsCachedCount: 9,
      streamingBufferUsage: 0.25,
    }),
    getTerrainHeightAt: () => 40,
  };
  return {
    camera,
    chunkManager: chunkManager as never,
    gpuGenerator: Object.assign(generator, { getAtlasBytes: () => 1000, getStagingBytes: () => 24 }) as never,
    sceneGraph: { getGpuAttributes: () => [] } as never,
    renderer: { backend: { has: () => false } } as never,
    config: DEFAULT_TERRAIN_CONFIG,
    width: 800,
    height: 600,
    pixelRatio: 1.5,
  };
}

describe('FrameStatsCollector', () => {
  it('publishes one snapshot per window with exact frame, CPU and streaming averages', () => {
    const camera = new THREE.PerspectiveCamera();
    const generator = { generatedCount: 100 };
    const sources = createSources(camera, generator);
    const stats = new FrameStatsCollector();
    const intervals = [16, 17, 16, 50, 16, 17, 16, 16, 16, 17, 16, 16, 16, 17, 16, 33];

    let time = 1000;
    expect(stats.endFrame(time, 1, sources)).toBeNull();

    let published = null;
    let frames = 0;
    let elapsed = 0;
    for (const interval of intervals) {
      time += interval;
      elapsed += interval;
      frames++;
      stats.recordInterval(interval);
      stats.addStreaming(0.5);
      stats.recordRender(9, 1234);
      generator.generatedCount += 2;
      published = stats.endFrame(time, 2, sources);
      if (published) break;
    }

    expect(elapsed).toBeGreaterThanOrEqual(STATS_INTERVAL_MS);
    expect(published).not.toBeNull();
    expect(published?.fps).toBeCloseTo((frames * 1000) / elapsed, 12);
    expect(published?.frameMs).toBeCloseTo(elapsed / frames, 12);
    expect(published?.maxFrameMs).toBe(50);
    expect(published?.cpuFrameMs).toBe(2);
    expect(published?.chunkUpdateMs).toBe(0.5);
    expect(published?.drawCalls).toBe(9);
    expect(published?.triangles).toBe(1234);
    expect(published?.generatedPerSecond).toBeCloseTo((frames * 2 * 1000) / elapsed, 12);
    expect(published?.renderWidth).toBe(1200);
    expect(published?.renderHeight).toBe(900);
    expect(published?.terrainBufferBytes).toBe(1024);
    expect(published?.visibleByLod).toEqual([1, 2, 3, 0]);
  });

  it('measures speed along the travelled path, not the straight-line displacement', () => {
    const camera = new THREE.PerspectiveCamera();
    const sources = createSources(camera, { generatedCount: 0 });
    const stats = new FrameStatsCollector();
    const radius = 100;

    let time = 0;
    stats.endFrame(time, 0, sources);
    let published = null;
    let angle = 0;
    while (!published) {
      time += 10;
      angle += 0.05;
      camera.position.set(radius * Math.cos(angle) - radius, 0, radius * Math.sin(angle));
      published = stats.endFrame(time, 0, sources);
    }

    let path = 0;
    for (let a = 0.05; a <= angle + 1e-9; a += 0.05) path += 2 * radius * Math.sin(0.025);
    expect(published.cameraSpeed).toBeCloseTo(path / (time / 1000), 6);
    expect(published.cameraSpeed).toBeGreaterThan(camera.position.length() / (time / 1000));
  });

  it('reports heading, pitch, chunk and height above ground of the camera', () => {
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(-300, 140, 700);
    camera.lookAt(-300 + 100, 140, 700 - 100);
    camera.updateMatrixWorld(true);
    const sources = createSources(camera, { generatedCount: 0 });
    const stats = new FrameStatsCollector();

    stats.endFrame(0, 0, sources);
    const published = stats.endFrame(STATS_INTERVAL_MS, 0, sources);

    expect(published?.headingDeg).toBeCloseTo(45, 9);
    expect(published?.pitchDeg).toBeCloseTo(0, 9);
    expect(published?.chunkX).toBe(Math.floor(-300 / DEFAULT_TERRAIN_CONFIG.CHUNK_SIZE));
    expect(published?.chunkZ).toBe(Math.floor(700 / DEFAULT_TERRAIN_CONFIG.CHUNK_SIZE));
    expect(published?.heightAboveGround).toBe(100);
  });
});
