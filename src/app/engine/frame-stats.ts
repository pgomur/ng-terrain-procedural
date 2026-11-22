import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { ChunkManager } from './chunk-manager';
import { GPUGenerator } from './gpu-generator';
import { SceneGraph } from './scene-graph';
import { Chunk } from '../types/chunk';
import { TerrainEngineStats } from '../types/engine';
import { TerrainConfig } from '../types/terrain';

export const STATS_INTERVAL_MS = 250;

export interface FrameStatsSources {
  readonly camera: THREE.PerspectiveCamera;
  readonly chunkManager: ChunkManager;
  readonly gpuGenerator: GPUGenerator<Chunk>;
  readonly sceneGraph: SceneGraph;
  readonly renderer: WebGPURenderer;
  readonly config: TerrainConfig;
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
}

interface BufferBackend {
  has?(resource: object): boolean;
  get?(resource: object): { readonly buffer?: GPUBuffer } | undefined;
}

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

  restart(): void {
    this.windowStart = -1;
  }

  recordInterval(ms: number): void {
    this.maxFrameMs = Math.max(this.maxFrameMs, ms);
  }

  addStreaming(ms: number): void {
    this.streamingMs += ms;
  }

  recordRender(drawCalls: number, triangles: number): void {
    this.drawCalls = drawCalls;
    this.triangles = triangles;
  }

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
