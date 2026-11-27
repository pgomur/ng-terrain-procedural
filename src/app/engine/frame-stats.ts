/**
 * The diagnostics behind the panel: what is measured every frame, and how it becomes a {@link types/engine!TerrainEngineStats | TerrainEngineStats} snapshot.
 *
 * Measuring is cheap and done every frame; reading the chunk counters and buffer sizes is not, so {@link FrameStatsCollector} accumulates the per-frame values and builds a snapshot only once per window of at least {@link STATS_INTERVAL_MS}:
 *
 * | Per frame | Per snapshot |
 * | --- | --- |
 * | Interval since the previous frame, CPU time, streaming time, draw calls and triangles, distance travelled. | Averages and maximum over the window, chunk counters from the {@link engine/chunk-manager!ChunkManager | ChunkManager}, buffer sizes from the {@link engine/gpu-generator!GPUGenerator | GPUGenerator} and the renderer, camera position and orientation, ground height. |
 *
 * Timing is measured with `performance.now()` on the CPU. GPU execution time is not measured, because WebGPU timestamp queries are not available everywhere.
 *
 * See [Diagnostics panel](../../../guides/diagnostics.md) for what each value measures.
 *
 * @module
 */
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { ChunkManager } from './chunk-manager';
import { GPUGenerator } from './gpu-generator';
import { SceneGraph } from './scene-graph';
import { Chunk } from '../types/chunk';
import { TerrainEngineStats } from '../types/engine';
import { TerrainConfig } from '../types/terrain';

/**
 * Minimum duration of a statistics window, in milliseconds.
 *
 * A window closes on the first frame at or after this time, so at 60 fps a window holds 15 or 16 frames.
 */
export const STATS_INTERVAL_MS = 250;

/**
 * Objects a {@link FrameStatsCollector} reads when it publishes a snapshot.
 *
 * The engine passes the same objects every frame; the collector keeps no reference to them between calls.
 */
export interface FrameStatsSources {
  /**
   * Camera whose position, direction and speed are reported.
   */
  readonly camera: THREE.PerspectiveCamera;
  /**
   * Source of the chunk counters and the ground height.
   */
  readonly chunkManager: ChunkManager;
  /**
   * Source of the generation count and atlas sizes.
   */
  readonly gpuGenerator: GPUGenerator<Chunk>;
  /**
   * Source of the terrain mesh buffers.
   */
  readonly sceneGraph: SceneGraph;
  /**
   * Renderer whose GPU buffers are measured.
   */
  readonly renderer: WebGPURenderer;
  /**
   * Terrain configuration.
   */
  readonly config: TerrainConfig;
  /**
   * Canvas width in CSS pixels.
   */
  readonly width: number;
  /**
   * Canvas height in CSS pixels.
   */
  readonly height: number;
  /**
   * Device pixel ratio used for rendering.
   */
  readonly pixelRatio: number;
}

interface BufferBackend {
  has?(resource: object): boolean;
  get?(resource: object): { readonly buffer?: GPUBuffer } | undefined;
}

/**
 * Accumulates per-frame measurements and turns them into a {@link types/engine!TerrainEngineStats | TerrainEngineStats} snapshot at most every {@link STATS_INTERVAL_MS}.
 *
 * The engine calls, every frame: {@link FrameStatsCollector.recordInterval}, {@link FrameStatsCollector.addStreaming}, {@link FrameStatsCollector.recordRender} and finally {@link FrameStatsCollector.endFrame}, which returns a snapshot when a window closes.
 */
export class FrameStatsCollector {
  private windowStart = -1;
  private frames = 0;
  private cpuMs = 0;
  private maxFrameMs = 0;
  private streamingMs = 0;
  private distance = 0;
  private drawCalls = 0;
  private triangles = 0;
  private startGenerated = 0;
  private readonly lastPosition = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();

  /**
   * Starts a new window on the next frame, so a pause in the loop is not averaged in.
   */
  restart(): void {
    this.windowStart = -1;
  }

  /**
   * Records the time since the previous frame.
   *
   * @param ms - Interval in milliseconds.
   *
   * Feeds the frame rate, the average frame time and the worst frame of the window.
   */
  recordInterval(ms: number): void {
    this.maxFrameMs = Math.max(this.maxFrameMs, ms);
  }

  /**
   * Adds time spent on streaming in the current frame.
   *
   * @param ms - Duration in milliseconds.
   */
  addStreaming(ms: number): void {
    this.streamingMs += ms;
  }

  /**
   * Records the renderer counters of the last frame.
   *
   * @param drawCalls - Draw calls issued.
   * @param triangles - Triangles submitted.
   */
  recordRender(drawCalls: number, triangles: number): void {
    this.drawCalls = drawCalls;
    this.triangles = triangles;
  }

  /**
   * Closes a frame and publishes a snapshot when the window is long enough. The first call after construction or {@link FrameStatsCollector.restart} only opens the window.
   *
   * @param time - Frame timestamp in milliseconds.
   * @param cpuMs - CPU time spent on the frame, in milliseconds.
   * @param sources - Objects to read the snapshot from.
   * @returns The snapshot, or `null` while the window is still open.
   */
  endFrame(time: number, cpuMs: number, sources: FrameStatsSources): TerrainEngineStats | null {
    const position = sources.camera.position;

    if (this.windowStart < 0) {
      this.windowStart = time;
      this.resetWindow(sources);
      return null;
    }

    this.frames++;
    this.cpuMs += cpuMs;
    this.distance += position.distanceTo(this.lastPosition);
    this.lastPosition.copy(position);

    const elapsed = time - this.windowStart;
    if (elapsed < STATS_INTERVAL_MS) return null;

    const snapshot = this.snapshot(elapsed, sources);
    this.windowStart = time;
    this.resetWindow(sources);
    return snapshot;
  }

  private resetWindow(sources: FrameStatsSources): void {
    this.frames = 0;
    this.cpuMs = 0;
    this.maxFrameMs = 0;
    this.streamingMs = 0;
    this.distance = 0;
    this.lastPosition.copy(sources.camera.position);
    this.startGenerated = sources.gpuGenerator.generatedCount;
  }

  private snapshot(elapsedMs: number, sources: FrameStatsSources): TerrainEngineStats {
    const { camera, chunkManager, gpuGenerator, config } = sources;
    const chunkStats = chunkManager.getStats();
    const position = camera.position;

    const direction = camera.getWorldDirection(this.direction);
    const heading = THREE.MathUtils.radToDeg(Math.atan2(direction.x, -direction.z));
    const ground = chunkManager.getTerrainHeightAt(position.x, position.z);
    const atlasBytes = gpuGenerator.getAtlasBytes();
    const stagingBytes = gpuGenerator.getStagingBytes();
    const geometryBytes = uploadedBytes(sources.renderer, sources.sceneGraph.getGpuAttributes());

    return {
      fps: (this.frames * 1000) / elapsedMs,
      frameMs: this.frames > 0 ? elapsedMs / this.frames : 0,
      maxFrameMs: this.maxFrameMs,
      cpuFrameMs: this.frames > 0 ? this.cpuMs / this.frames : 0,
      chunkUpdateMs: this.frames > 0 ? this.streamingMs / this.frames : 0,
      drawCalls: this.drawCalls,
      triangles: this.triangles,
      renderWidth: Math.floor(sources.width * sources.pixelRatio),
      renderHeight: Math.floor(sources.height * sources.pixelRatio),
      pixelRatio: sources.pixelRatio,
      visibleChunks: chunkStats.visibleCount,
      visibleByLod: chunkStats.visibleByLod,
      readyChunks: chunkStats.readyCount,
      unloadingChunks: chunkStats.unloadingCount,
      generatedPerSecond: ((gpuGenerator.generatedCount - this.startGenerated) * 1000) / elapsedMs,
      pendingChunks: chunkStats.pendingCount,
      queueUsage: chunkStats.streamingBufferUsage,
      failedChunks: chunkStats.errorCount,
      atlasBytes,
      stagingBytes,
      geometryBytes,
      terrainBufferBytes: atlasBytes + stagingBytes + geometryBytes,
      cameraX: position.x,
      cameraY: position.y,
      cameraZ: position.z,
      heightAboveGround: ground === null ? null : position.y - ground,
      headingDeg: (heading + 360) % 360,
      pitchDeg: THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1))),
      cameraSpeed: this.distance / (elapsedMs / 1000),
      chunkX: Math.floor(position.x / config.CHUNK_SIZE),
      chunkZ: Math.floor(position.z / config.CHUNK_SIZE),
      seed: config.NOISE_SEED,
    };
  }
}

function uploadedBytes(renderer: WebGPURenderer, attributes: readonly object[]): number {
  const backend = (renderer as unknown as { readonly backend?: BufferBackend }).backend;
  if (!backend?.has || !backend.get) return 0;

  let bytes = 0;
  for (const attribute of attributes) {
    if (backend.has(attribute)) bytes += backend.get(attribute)?.buffer?.size ?? 0;
  }
  return bytes;
}
