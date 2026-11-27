/**
 * From chunks to draw calls.
 *
 * The {@link engine/chunk-manager!ChunkManager | ChunkManager} decides what exists and what is visible; {@link SceneGraph} turns that into the Three.js objects the renderer draws, with as few draw calls and as little upload as possible:
 *
 * - **One instanced mesh per atlas page.** All chunks of a page share one vertex grid; each instance is a single `vec4` (corner X, corner Z, slot, seam code) and the vertex shader reads the heights of its slot from the page's storage buffer. Thousands of chunks cost a handful of draw calls.
 * - **One version per grid cell.** When a cell has several levels of detail loaded, only the finest `ready` one is drawn, or the finest `unloading` one while its replacement loads.
 * - **Seam codes.** Each instance records how much coarser each of its four neighbours is, so the shader can stitch its edges onto theirs.
 * - **Shadow casters.** A second instanced mesh per page, on {@link SHADOW_CASTER_LAYER}, draws every chunk near the camera into the shadow map, including those outside the view.
 *
 * Only the cells reported as changed are re-examined, and only the instance buffers of the pages that changed are rewritten and uploaded.
 *
 * See [Rendering](../../../guides/rendering.md).
 *
 * @module
 */
import * as THREE from 'three';
import type { Node } from 'three/webgpu';
import { Chunk, ChunkKey, ChunkLOD } from '../types/chunk';
import { TerrainConfig } from '../types/terrain';
import {
  getChunkKey,
  isRenderableChunk,
  supportsSeamStitching,
  seamLodDiff,
  encodeSeamCode,
  skirtDepthFor,
} from '../math/chunk-coord';
import { createTerrainColorNode, createTerrainMaterials, type TerrainMaterials } from '../shaders/terrain-material.tsl';
import { createChunkGeometry, type ChunkGeometry } from './chunk-geometry';
import type { HeightPage } from './gpu-generator';

/**
 * Provides the atlas pages the terrain meshes read their heights from. Implemented by {@link engine/gpu-generator!GPUGenerator | GPUGenerator}.
 *
 * Kept as an interface so the scene graph only depends on what it reads, and can be tested without a GPU.
 */
export interface HeightPageSource {
  /**
   * @param pageId - Index of the page.
   * @returns The page, or `undefined` if it does not exist.
   */
  getPage(pageId: number): HeightPage | undefined;
}

interface CoordEntry {
  readonly spatialKey: string;
  readonly x: number;
  readonly z: number;
  readonly chunkKey: ChunkKey;
  readonly lod: ChunkLOD;
  readonly pageId: number;
  readonly slot: number;
  readonly generation: number;
  visible: boolean;
  seamCode: number;
}

interface PageBatch {
  readonly page: HeightPage;
  readonly mesh: THREE.InstancedMesh;
  readonly geometry: THREE.BufferGeometry;
  readonly instanceData: THREE.InstancedBufferAttribute;
  readonly shadowMesh: THREE.InstancedMesh;
  readonly shadowGeometry: THREE.BufferGeometry;
  readonly shadowData: THREE.InstancedBufferAttribute;
  readonly entries: Set<CoordEntry>;
  dirty: boolean;
  shadowDirty: boolean;
}

interface ShadowRegion {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
}

/**
 * Render layer of the shadow-only terrain meshes. The sun's shadow camera renders this layer; the main camera does not.
 *
 * The main terrain meshes receive shadows but do not cast them; these meshes cast them but are never seen. That way terrain outside the view, such as a hill behind the camera, still throws its shadow into it.
 */
export const SHADOW_CASTER_LAYER = 1;

const LODS: readonly ChunkLOD[] = [0, 1, 2, 3];
const NEIGHBOR_STEPS: readonly (readonly [number, number])[] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

/**
 * Turns the chunk set into instanced Three.js meshes.
 *
 * Each atlas page gets one `InstancedMesh` that draws every visible chunk stored in it. The vertex shader displaces a shared grid with the heights of the chunk's slot and stitches its edges to coarser neighbours. For each grid cell, only one version is drawn: the finest `ready` chunk, or the finest `unloading` one while the replacement loads. A second instanced mesh per page, on {@link SHADOW_CASTER_LAYER}, casts shadows for every chunk within the shadow region, whether or not the camera sees it.
 *
 * Instance buffers are rebuilt only for pages whose content, visibility or seams changed.
 *
 * @example
 * ```ts
 * const sceneGraph = new SceneGraph(scene, config, generator);
 * sceneGraph.setShadowRegion(camera.position.x, camera.position.z, 800);
 * sceneGraph.sync(chunks.getChunks(), chunks.getVisibleKeys(), chunks.getDirtyCoords(), chunks.getVisibilityToggled());
 * chunks.clearRenderChanges();
 * ```
 */
export class SceneGraph {
  private readonly scene: THREE.Scene;
  private readonly config: TerrainConfig;
  private readonly heightSource: HeightPageSource;

  private readonly entries = new Map<string, CoordEntry>();
  private readonly batches = new Map<number, PageBatch>();
  private readonly baseGeometries = new Map<number, ChunkGeometry>();
  private readonly materials = new Map<number, TerrainMaterials>();
  private readonly seamDirty = new Set<CoordEntry>();
  private readonly colorNode: Node<'vec3'>;
  private readonly seamsEnabled: boolean;
  private readonly skirtDepth: number;
  private shadowRegion: ShadowRegion | null = null;

  /**
   * Creates an empty scene graph. Meshes, grids and materials are created on demand, the first time a page is used.
   *
   * @param scene - Scene the meshes are added to.
   * @param config - Terrain configuration.
   * @param heightSource - Source of the atlas pages.
   */
  constructor(scene: THREE.Scene, config: TerrainConfig, heightSource: HeightPageSource) {
    this.scene = scene;
    this.config = config;
    this.heightSource = heightSource;
    this.colorNode = createTerrainColorNode(config);
    this.seamsEnabled = config.SEAM_FITTING_ENABLED && supportsSeamStitching(config.CHUNK_RESOLUTIONS);
    this.skirtDepth = skirtDepthFor(config.TERRAIN_HEIGHT_SCALE);
  }

  /**
   * Applies the changes reported by the {@link engine/chunk-manager!ChunkManager | ChunkManager} since the last call.
   *
   * Call it once per frame, after {@link engine/chunk-manager!ChunkManager.update | ChunkManager.update} and before rendering, then call {@link engine/chunk-manager!ChunkManager.clearRenderChanges | ChunkManager.clearRenderChanges}. The cost is proportional to the changes, not to the number of chunks: a frame where nothing changed does no work.
   *
   * @param chunks - All chunks, by key.
   * @param visibleKeys - Keys of the chunks inside the frustum.
   * @param dirtyCoords - Spatial keys of the cells whose drawable chunk changed.
   * @param visibilityToggled - Keys of the chunks whose visibility changed.
   */
  sync(
    chunks: ReadonlyMap<ChunkKey, Chunk>,
    visibleKeys: ReadonlySet<ChunkKey>,
    dirtyCoords: ReadonlySet<string>,
    visibilityToggled: ReadonlySet<ChunkKey>,
  ): void {
    for (const spatialKey of dirtyCoords) {
      this.syncCoord(spatialKey, chunks, visibleKeys);
    }

    for (const key of visibilityToggled) {
      const entry = this.entries.get(key.slice(0, key.lastIndexOf(':')));
      if (entry?.chunkKey !== key) continue;
      const visible = visibleKeys.has(key);
      if (entry.visible !== visible) {
        entry.visible = visible;
        this.markBatchDirty(entry.pageId);
      }
    }

    if (this.seamsEnabled && this.seamDirty.size > 0) {
      for (const entry of this.seamDirty) {
        if (this.entries.get(entry.spatialKey) !== entry) continue;
        const code = this.computeSeamCode(entry);
        if (code !== entry.seamCode) {
          entry.seamCode = code;
          this.markBatchDirty(entry.pageId);
        }
      }
    }
    this.seamDirty.clear();

    for (const batch of this.batches.values()) {
      if (batch.dirty) this.rebuildBatch(batch);
      if (batch.shadowDirty) this.rebuildShadowBatch(batch);
    }
  }

  /**
   * Sets the circle on the ground whose chunks cast shadows. The centre and radius are quantised to half a chunk so the shadow casters are not rebuilt every frame.
   *
   * @param x - Centre along X, in world units.
   * @param z - Centre along Z, in world units.
   * @param radius - Radius in world units.
   *
   * The engine calls it every frame with the radius from {@link engine/sun-light!SunLight.shadowRegionRadius | SunLight.shadowRegionRadius}. Because of the quantisation, the shadow instances are only rebuilt every 64 units of movement with the default chunk size.
   */
  setShadowRegion(x: number, z: number, radius: number): void {
    const step = this.config.CHUNK_SIZE * 0.5;
    const qx = Math.round(x / step) * step;
    const qz = Math.round(z / step) * step;
    const qr = radius + step;
    const current = this.shadowRegion;
    if (current?.x === qx && current.z === qz && current.radius === qr) return;

    this.shadowRegion = { x: qx, z: qz, radius: qr };
    for (const batch of this.batches.values()) batch.shadowDirty = true;
  }

  /**
   * Number of chunks currently drawn as shadow casters.
   *
   * Used by the tests to check the shadow region.
   */
  get shadowInstanceCount(): number {
    let count = 0;
    for (const batch of this.batches.values()) count += batch.shadowMesh.count;
    return count;
  }

  /**
   * Every buffer attribute of the terrain meshes that can be uploaded to the GPU: shared grids, per-instance data and instance matrices. Used to report geometry memory.
   */
  getGpuAttributes(): THREE.BufferAttribute[] {
    const attributes: THREE.BufferAttribute[] = [];
    for (const base of this.baseGeometries.values()) {
      attributes.push(base.position, base.heightIndex, base.index);
    }
    for (const batch of this.batches.values()) {
      attributes.push(batch.instanceData, batch.shadowData, batch.mesh.instanceMatrix, batch.shadowMesh.instanceMatrix);
    }
    return attributes;
  }

  /**
   * Prepares one instance per page so the render pipelines are compiled during loading. Call {@link SceneGraph.endPrewarm} after rendering a frame.
   *
   * @param pages - Pages to prepare.
   *
   * The engine calls it during the `shaders` loading stage, after {@link engine/gpu-generator!GPUGenerator.prewarm | GPUGenerator.prewarm} has created the pages.
   */
  prewarm(pages: readonly HeightPage[]): void {
    for (const page of pages) {
      const batch = this.batchFor(page.id);
      const data = batch.instanceData.array as Float32Array;
      data[0] = 0;
      data[1] = 0;
      data[2] = 0;
      data[3] = 0;
      batch.instanceData.needsUpdate = true;
      batch.mesh.count = 1;
      batch.mesh.visible = true;
      batch.dirty = true;

      const shadow = batch.shadowData.array as Float32Array;
      shadow[0] = 0;
      shadow[1] = 0;
      shadow[2] = 0;
      shadow[3] = 0;
      batch.shadowData.needsUpdate = true;
      batch.shadowMesh.count = 1;
      batch.shadowMesh.visible = true;
      batch.shadowDirty = true;
    }
  }

  /**
   * Restores the real instance lists after {@link SceneGraph.prewarm}.
   */
  endPrewarm(): void {
    for (const batch of this.batches.values()) {
      batch.dirty = true;
      batch.shadowDirty = true;
      this.rebuildBatch(batch);
      this.rebuildShadowBatch(batch);
    }
  }

  private syncCoord(
    spatialKey: string,
    chunks: ReadonlyMap<ChunkKey, Chunk>,
    visibleKeys: ReadonlySet<ChunkKey>,
  ): void {
    const best = this.selectBest(spatialKey, chunks);
    const entry = this.entries.get(spatialKey);

    if (!best?.gpu) {
      if (entry) this.removeEntry(entry);
      return;
    }

    const chunkKey = getChunkKey(best.meta.coord);
    const gpu = best.gpu;

    if (
      entry?.chunkKey === chunkKey &&
      entry.pageId === gpu.pageId &&
      entry.slot === gpu.slot &&
      entry.generation === gpu.generation
    ) {
      const visible = visibleKeys.has(chunkKey);
      if (entry.visible !== visible) {
        entry.visible = visible;
        this.markBatchDirty(entry.pageId);
      }
      return;
    }

    if (entry) this.removeEntry(entry);

    const created: CoordEntry = {
      spatialKey,
      x: best.meta.coord.x,
      z: best.meta.coord.z,
      chunkKey,
      lod: best.meta.coord.lod,
      pageId: gpu.pageId,
      slot: gpu.slot,
      generation: gpu.generation,
      visible: visibleKeys.has(chunkKey),
      seamCode: 0,
    };

    this.entries.set(spatialKey, created);
    this.batchFor(gpu.pageId).entries.add(created);
    this.markBatchDirty(gpu.pageId);
    this.markSeamNeighborhood(created.x, created.z);
  }

  private removeEntry(entry: CoordEntry): void {
    this.entries.delete(entry.spatialKey);
    this.batches.get(entry.pageId)?.entries.delete(entry);
    this.markBatchDirty(entry.pageId);
    this.markSeamNeighborhood(entry.x, entry.z);
  }

  private markBatchDirty(pageId: number): void {
    const batch = this.batches.get(pageId);
    if (batch) {
      batch.dirty = true;
      batch.shadowDirty = true;
    }
  }

  private markSeamNeighborhood(x: number, z: number): void {
    if (!this.seamsEnabled) return;
    const self = this.entries.get(`${x}:${z}`);
    if (self) this.seamDirty.add(self);
    for (const [dx, dz] of NEIGHBOR_STEPS) {
      const neighbor = this.entries.get(`${x + dx}:${z + dz}`);
      if (neighbor) this.seamDirty.add(neighbor);
    }
  }

  private computeSeamCode(entry: CoordEntry): number {
    const diffs = NEIGHBOR_STEPS.map(([dx, dz]) => {
      const neighbor = this.entries.get(`${entry.x + dx}:${entry.z + dz}`);
      return seamLodDiff(entry.lod, neighbor ? neighbor.lod : null);
    });
    return encodeSeamCode(diffs[0], diffs[1], diffs[2], diffs[3]);
  }

  private selectBest(spatialKey: string, chunks: ReadonlyMap<ChunkKey, Chunk>): Chunk | null {
    let best: Chunk | null = null;
    for (const lod of LODS) {
      const chunk = chunks.get(`${spatialKey}:${lod}` as ChunkKey);
      if (!chunk || !isRenderableChunk(chunk)) continue;
      if (!best || (chunk.state === 'ready' && best.state !== 'ready')) {
        best = chunk;
      }
    }
    return best;
  }

  private rebuildBatch(batch: PageBatch): void {
    const data = batch.instanceData.array as Float32Array;
    const size = this.config.CHUNK_SIZE;
    let count = 0;

    for (const entry of batch.entries) {
      if (!entry.visible) continue;
      const o = count * 4;
      data[o] = entry.x * size;
      data[o + 1] = entry.z * size;
      data[o + 2] = entry.slot;
      data[o + 3] = this.seamsEnabled ? entry.seamCode : 0;
      count++;
    }

    batch.instanceData.clearUpdateRanges();
    if (count > 0) {
      batch.instanceData.addUpdateRange(0, count * 4);
      batch.instanceData.needsUpdate = true;
    }

    batch.mesh.count = count;
    batch.mesh.visible = count > 0;
    batch.dirty = false;
  }

  private rebuildShadowBatch(batch: PageBatch): void {
    const data = batch.shadowData.array as Float32Array;
    const size = this.config.CHUNK_SIZE;
    const half = size / 2;
    const region = this.shadowRegion;
    let count = 0;

    if (region) {
      const limit = region.radius + size * Math.SQRT1_2;
      const limitSq = limit * limit;
      for (const entry of batch.entries) {
        const dx = entry.x * size + half - region.x;
        const dz = entry.z * size + half - region.z;
        if (dx * dx + dz * dz > limitSq) continue;
        const o = count * 4;
        data[o] = entry.x * size;
        data[o + 1] = entry.z * size;
        data[o + 2] = entry.slot;
        data[o + 3] = this.seamsEnabled ? entry.seamCode : 0;
        count++;
      }
    }

    batch.shadowData.clearUpdateRanges();
    if (count > 0) {
      batch.shadowData.addUpdateRange(0, count * 4);
      batch.shadowData.needsUpdate = true;
    }

    batch.shadowMesh.count = count;
    batch.shadowMesh.visible = count > 0;
    batch.shadowDirty = false;
  }

  private batchFor(pageId: number): PageBatch {
    const existing = this.batches.get(pageId);
    if (existing) return existing;

    const page = this.heightSource.getPage(pageId);
    if (!page) {
      throw new Error(`Height page ${pageId} does not exist`);
    }

    const base = this.baseGeometryFor(page.resolution);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', base.position);
    geometry.setAttribute('heightIndex', base.heightIndex);
    geometry.setIndex(base.index);
    geometry.addGroup(0, base.surfaceIndexCount, 0);
    geometry.addGroup(base.surfaceIndexCount, base.skirtIndexCount, 1);

    const instanceData = new THREE.InstancedBufferAttribute(new Float32Array(page.capacity * 4), 4);
    instanceData.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('instanceData', instanceData);

    const materials = this.materialsFor(page);
    const mesh = new THREE.InstancedMesh(geometry, [materials.surface, materials.skirt], page.capacity);
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    this.scene.add(mesh);

    const shadowGeometry = new THREE.BufferGeometry();
    shadowGeometry.setAttribute('position', base.position);
    shadowGeometry.setAttribute('heightIndex', base.heightIndex);
    shadowGeometry.setIndex(base.index);
    shadowGeometry.setDrawRange(0, base.surfaceIndexCount);

    const shadowData = new THREE.InstancedBufferAttribute(new Float32Array(page.capacity * 4), 4);
    shadowData.setUsage(THREE.DynamicDrawUsage);
    shadowGeometry.setAttribute('instanceData', shadowData);

    const shadowMesh = new THREE.InstancedMesh(shadowGeometry, materials.surface, page.capacity);
    shadowMesh.count = 0;
    shadowMesh.visible = false;
    shadowMesh.frustumCulled = false;
    shadowMesh.castShadow = true;
    shadowMesh.receiveShadow = false;
    shadowMesh.matrixAutoUpdate = false;
    shadowMesh.layers.set(SHADOW_CASTER_LAYER);
    this.scene.add(shadowMesh);

    const batch: PageBatch = {
      page,
      mesh,
      geometry,
      instanceData,
      shadowMesh,
      shadowGeometry,
      shadowData,
      entries: new Set(),
      dirty: false,
      shadowDirty: false,
    };
    this.batches.set(pageId, batch);
    return batch;
  }

  private baseGeometryFor(resolution: number): ChunkGeometry {
    const cached = this.baseGeometries.get(resolution);
    if (cached) return cached;

    const base = createChunkGeometry(resolution, this.config.CHUNK_SIZE);
    this.baseGeometries.set(resolution, base);
    return base;
  }

  private materialsFor(page: HeightPage): TerrainMaterials {
    const cached = this.materials.get(page.id);
    if (cached) return cached;

    const materials = createTerrainMaterials(page.heights, page.resolution, this.colorNode, this.skirtDepth);
    this.materials.set(page.id, materials);
    return materials;
  }

  /**
   * Removes the meshes from the scene and disposes their geometries and materials.
   */
  dispose(): void {
    for (const batch of this.batches.values()) {
      this.scene.remove(batch.mesh);
      this.scene.remove(batch.shadowMesh);
      batch.geometry.dispose();
      batch.shadowGeometry.dispose();
    }
    this.batches.clear();
    this.entries.clear();
    this.seamDirty.clear();
    this.baseGeometries.clear();

    for (const materials of this.materials.values()) {
      materials.surface.dispose();
      materials.skirt.dispose();
    }
    this.materials.clear();
  }
}
