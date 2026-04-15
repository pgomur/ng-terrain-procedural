import { signal, computed, effect, Signal, untracked } from '@angular/core';

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
} from '../types/chunk';
import { TerrainConfig, CameraState, PerformanceSnapshot } from '../types/terrain';
import { GPUGenerator } from './gpu-generator';
import {
  getChunkKey,
  distanceToChunk,
  selectLODForDistance,
  intersectsFrustum,
  calculateNeighborMask,
  getChunkCenter,
  worldToChunkCoord,
  intersectsFrustumAABB,
} from '../math/chunk-coord';

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

  private pendingQueue: Array<{ coord: ChunkCoord; priority: number; attempts: number }> = [];
  private generatingChunks = new Set<ChunkKey>();

  private lastCameraPos = { x: Infinity, z: Infinity };
  private cachedDesiredChunks: ChunkCoord[] = [];
  private readonly CACHE_THRESHOLD = 0.1;

  private currentCamera: CameraState | null = null;
  private currentFrustum: FrustumPlanes | null = null;
  private needsNeighborUpdate = false;

  constructor(config: TerrainConfig, gpuGenerator: GPUGenerator) {
    this.config = config;
    this.gpuGenerator = gpuGenerator;
  }

  update(camera: CameraState, frustum: FrustumPlanes): void {
    const startTime = performance.now();
    this.currentCamera = camera;
    this.currentFrustum = frustum;

    const camChunkCoord = worldToChunkCoord(camera.position, this.config.CHUNK_SIZE, 0 as ChunkLOD);
    this.cameraChunk.set(camChunkCoord);

    const desiredChunks = this.getDesiredChunksCached(camera);
    const currentChunks = this.activeChunks();

    const desiredSpatialCoords = new Map<string, number>();
    for (const c of desiredChunks) {
      desiredSpatialCoords.set(`${c.x}:${c.z}`, c.lod);
    }

    const desiredKeys = new Set(desiredChunks.map((c) => getChunkKey(c)));

    this.cullChunks(currentChunks, desiredKeys, desiredSpatialCoords);
    this.queueNewChunks(desiredChunks, currentChunks);
    this.processGenerationQueue();

    this.updateVisibilityFast(currentChunks, frustum);

    if (this.needsNeighborUpdate) {
      this.updateNeighborMasks(currentChunks);
      this.needsNeighborUpdate = false;
    }

    const frameTime = performance.now() - startTime;
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

  private cullChunks(
    currentChunks: Map<ChunkKey, Chunk>,
    desiredKeys: Set<ChunkKey>,
    desiredSpatialCoords: Map<string, number>,
  ): void {
    const toUnload: ChunkKey[] = [];
    let hasChanges = false;

    for (const [key, chunk] of currentChunks) {
      if (!desiredKeys.has(key)) {
        const spatialKey = `${chunk.meta.coord.x}:${chunk.meta.coord.z}`;
        const desiredLOD = desiredSpatialCoords.get(spatialKey);

        if (desiredLOD !== undefined) {
          const replacementKey = `${chunk.meta.coord.x}:${chunk.meta.coord.z}:${desiredLOD}`;
          const replacement = currentChunks.get(replacementKey as ChunkKey);

          if (!replacement || replacement.state !== 'ready') {
            const updated: Chunk = {
              ...chunk,
              metrics: { ...chunk.metrics, lastAccessed: performance.now() },
            };
            currentChunks.set(key, updated);
            continue;
          }
        }

        if (chunk.state === 'error') {
          if (chunk.metrics.frameCount > 60) {
            this.pendingQueue.push({
              coord: chunk.meta.coord,
              priority: 0,
              attempts: chunk.metrics.frameCount,
            });
          }
          continue;
        }

        if (chunk.state === 'unloading') {
          const framesPassed = (performance.now() - chunk.metrics.lastAccessed) / 16;
          if (framesPassed > this.config.UNLOAD_DELAY_FRAMES) {
            toUnload.push(key);
          }
        } else {
          const updated: Chunk = {
            ...chunk,
            state: 'unloading',
            metrics: {
              ...chunk.metrics,
              lastAccessed: performance.now(),
            },
          };
          currentChunks.set(key, updated);
          hasChanges = true;
        }
      }
    }

    if (currentChunks.size > this.config.MAX_CHUNKS) {
      const candidates = Array.from(currentChunks.entries())
        .filter(([k, c]) => c.state === 'unloading')
        .sort((a, b) => a[1].metrics.lastAccessed - b[1].metrics.lastAccessed);

      while (
        currentChunks.size - toUnload.length > this.config.MAX_CHUNKS &&
        candidates.length > 0
      ) {
        const [key] = candidates.shift()!;
        if (!toUnload.includes(key)) toUnload.push(key);
      }
    }

    if (toUnload.length > 0 || hasChanges) {
      this.activeChunks.set(new Map(currentChunks));

      for (const key of toUnload) {
        const chunk = currentChunks.get(key);
        if (chunk?.gpu) {
          this.gpuGenerator.releaseResources(chunk.gpu);
        }
        currentChunks.delete(key);
      }

      if (toUnload.length > 0) {
        this.activeChunks.set(new Map(currentChunks));
        this.needsNeighborUpdate = true;
      }
    }
  }

  private queueNewChunks(desired: ChunkCoord[], currentChunks: Map<ChunkKey, Chunk>): void {
    for (const coord of desired) {
      const key = getChunkKey(coord);

      if (currentChunks.has(key)) continue;
      if (this.generatingChunks.has(key)) continue;

      const center = getChunkCenter(coord, this.config.CHUNK_SIZE);
      const priority = this.currentCamera
        ? distanceToChunk(this.currentCamera.position, center)
        : Infinity;

      this.pendingQueue.push({ coord, priority, attempts: 0 });
    }

    this.pendingQueue.sort((a, b) => a.priority - b.priority);

    if (this.pendingQueue.length > this.config.PENDING_QUEUE_MAX) {
      this.pendingQueue = this.pendingQueue.slice(0, this.config.PENDING_QUEUE_MAX);
    }
  }

  private processGenerationQueue(): void {
    const budget = this.config.GENERATION_BUDGET;
    let processed = 0;

    while (this.pendingQueue.length > 0 && processed < budget) {
      const request = this.pendingQueue.shift()!;
      const key = getChunkKey(request.coord);

      if (this.activeChunks().has(key)) continue;

      this.generateChunk(request.coord, request.attempts);
      processed++;
    }
  }

  private async generateChunk(coord: ChunkCoord, attemptCount: number = 0): Promise<void> {
    const key = getChunkKey(coord);
    this.generatingChunks.add(key);

    const now = performance.now();
    const newChunk: Chunk = {
      meta: {
        coord,
        worldOrigin: {
          x: coord.x * this.config.CHUNK_SIZE,
          y: 0,
          z: coord.z * this.config.CHUNK_SIZE,
        },
        size: this.config.CHUNK_SIZE,
        resolution: this.config.CHUNK_RESOLUTIONS[coord.lod],
        seed: this.config.NOISE_SEED + (coord.x * 374761 + coord.z * 668265),
      },
      bounds: this.estimateBounds(coord),
      state: 'generating',
      gpu: null,
      metrics: {
        createdAt: now,
        generationTime: 0,
        lastAccessed: now,
        frameCount: attemptCount,
        distanceToCamera: 0,
        priorityScore: 0,
        visibility: { inFrustum: false, wasVisible: false, occlusionIndex: -1 },
        sync: null,
        neighborMask: 0,
        lastNeighborUpdate: 0,
      },
      mesh: null,
    };

    this.activeChunks.update((chunks) => {
      chunks.set(key, newChunk);
      return new Map(chunks);
    });
    this.needsNeighborUpdate = true;

    try {
      const startGen = performance.now();
      const { geometry, bounds, gpuResources } = await this.gpuGenerator.generateChunk(coord);
      const genTime = performance.now() - startGen;

      this.activeChunks.update((chunks) => {
        const chunk = chunks.get(key);
        if (!chunk) return chunks;

        const updated: Chunk = {
          ...chunk,
          state: 'ready',
          bounds: bounds,
          gpu: gpuResources,
          geometryData: geometry,
          metrics: {
            ...chunk.metrics,
            generationTime: genTime,
            lastAccessed: performance.now(),
            frameCount: 0,
          },
        };
        chunks.set(key, updated);
        return new Map(chunks);
      });

      this.submissionCounter.update((n) => n + 1);
      this.needsNeighborUpdate = true;
    } catch (error) {
      console.error(`Error generando chunk ${key} (intento ${attemptCount}):`, error);
      this.activeChunks.update((chunks) => {
        const chunk = chunks.get(key);
        if (chunk) {
          const updated: Chunk = {
            ...chunk,
            state: 'error',
            metrics: {
              ...chunk.metrics,
              frameCount: attemptCount + 1,
            },
          };
          chunks.set(key, updated);
        }
        return new Map(chunks);
      });
    } finally {
      this.generatingChunks.delete(key);
    }
  }

  private updateVisibilityFast(chunks: Map<ChunkKey, Chunk>, frustum: FrustumPlanes): void {
    const newVisible = new Set<ChunkKey>();

    for (const [key, chunk] of chunks) {
      if (chunk.state !== 'ready' && chunk.state !== 'unloading') continue;

      const visible = intersectsFrustumAABB(chunk.bounds, frustum);

      if (visible) {
        newVisible.add(key);
      }
    }

    const currentVisible = this.visibleKeys();
    if (
      newVisible.size !== currentVisible.size ||
      !Array.from(newVisible).every((k) => currentVisible.has(k))
    ) {
      this.visibleKeys.set(newVisible);
    }
  }

  private updateNeighborMasks(chunks: Map<ChunkKey, Chunk>): void {
    const chunkMap = new Map<ChunkKey, { meta: { coord: ChunkCoord } }>();
    for (const [k, v] of chunks) {
      chunkMap.set(k, { meta: { coord: v.meta.coord } });
    }

    for (const [key, chunk] of chunks) {
      if (chunk.state !== 'ready') continue;

      const mask = calculateNeighborMask(chunk.meta.coord, chunkMap as any);

      if (mask !== chunk.metrics.neighborMask) {
        const updated: Chunk = {
          ...chunk,
          metrics: {
            ...chunk.metrics,
            neighborMask: mask,
            lastNeighborUpdate: performance.now(),
          },
        };
        chunks.set(key, updated);
      }
    }

    this.activeChunks.set(new Map(chunks));
  }

  getChunkSystemState(): Signal<ChunkSystemState> {
    return computed(() => ({
      activeChunks: this.activeChunks(),
      visibleKeys: this.visibleKeys(),
      generatingKeys: new Set(this.generatingChunks),
      cameraChunk: this.cameraChunk(),
      submissionCounter: this.submissionCounter(),
      stats: {
        totalVRAM: this.calculateTotalVRAM(),
        visibleCount: this.visibleKeys().size,
        pendingCount: this.pendingQueue.length,
        generatingCount: this.generatingChunks.size,
        readyCount: Array.from(this.activeChunks().values()).filter((c) => c.state === 'ready')
          .length,
        fps: 1000 / (this.perfStats().frameTimeMs || 16),
        gpuWaitTime: this.perfStats().gpuTimeMs,
      },
    }));
  }

  private calculateTotalVRAM(): number {
    let total = 0;
    for (const chunk of this.activeChunks().values()) {
      if (chunk.gpu) {
        const res = chunk.meta.resolution;
        total += res * res * 4; // Position buffer
        total += (res - 1) * (res - 1) * 6 * 2; // Index buffer
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

  /**
   * Obtains the local interpolated ground height at the X/Z coordinate.
   * A vital method for synchronous CPU collision grounding without WebGPU iteration.
   */
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

    const h0 = h00 * (1 - u) + h10 * u;
    const h1 = h01 * (1 - u) + h11 * u;

    return h0 * (1 - v) + h1 * v;
  }

  clearAllChunks(): void {
    const chunks = untracked(() => this.activeChunks());
    for (const chunk of chunks.values()) {
      if (chunk.gpu) {
        this.gpuGenerator.releaseResources(chunk.gpu);
      }
    }
    this.activeChunks.set(new Map());
    this.pendingQueue = [];
    this.generatingChunks.clear();
    this.visibleKeys.set(new Set());
    this.cachedDesiredChunks = [];
  }

  dispose(): void {
    this.clearAllChunks();
  }
}
