import * as THREE from 'three';
import { MeshStandardNodeMaterial, type Node } from 'three/webgpu';
import { vec3, vec4, smoothstep, positionWorld, fract, uniform, mix, fwidth, float, cameraViewMatrix } from 'three/tsl';
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
import { createTerrainPositionNode } from '../shaders/elevation.tsl';
import type { HeightPage } from './gpu-generator';

export interface HeightPageSource {
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

interface BaseGeometry {
  readonly position: THREE.BufferAttribute;
  readonly heightIndex: THREE.BufferAttribute;
  readonly index: THREE.BufferAttribute;
  readonly surfaceIndexCount: number;
  readonly skirtIndexCount: number;
}

interface PageMaterials {
  readonly surface: MeshStandardNodeMaterial;
  readonly skirt: MeshStandardNodeMaterial;
}

export const SHADOW_CASTER_LAYER = 1;

const SKIRT_POLYGON_OFFSET_FACTOR = 2;
const SKIRT_POLYGON_OFFSET_UNITS = 4;

const LODS: readonly ChunkLOD[] = [0, 1, 2, 3];
const NEIGHBOR_STEPS: readonly (readonly [number, number])[] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

export class SceneGraph {
  private readonly scene: THREE.Scene;
  private readonly config: TerrainConfig;
  private readonly heightSource: HeightPageSource;

  private readonly entries = new Map<string, CoordEntry>();
  private readonly batches = new Map<number, PageBatch>();
  private readonly baseGeometries = new Map<number, BaseGeometry>();
  private readonly materials = new Map<number, PageMaterials>();
  private readonly seamDirty = new Set<CoordEntry>();
  private readonly colorNode: Node<'vec3'>;
  private readonly seamsEnabled: boolean;
  private readonly skirtDepth: number;
  private shadowRegion: ShadowRegion | null = null;

  constructor(scene: THREE.Scene, config: TerrainConfig, heightSource: HeightPageSource) {
    this.scene = scene;
    this.config = config;
    this.heightSource = heightSource;
    this.colorNode = this.createColorNode();
    this.seamsEnabled = config.SEAM_FITTING_ENABLED && supportsSeamStitching(config.CHUNK_RESOLUTIONS);
    this.skirtDepth = skirtDepthFor(config.TERRAIN_HEIGHT_SCALE);
  }

  /**
   * Configure terrain shading natively for WebGPU using TSL.
   * This ensures that changes are visible under WebGPU Denderer.
   */
  private createColorNode(): Node<'vec3'> {
    const uMinHeight = uniform(this.config.TERRAIN_OFFSET_Y);
    const uMaxHeight = uniform(this.config.TERRAIN_OFFSET_Y + this.config.TERRAIN_HEIGHT_SCALE);

    const height = positionWorld.y;
    const t = smoothstep(uMinHeight, uMaxHeight, height);

    const sand = vec3(0.8, 0.75, 0.6);
    const grass = vec3(0.35, 0.5, 0.25);
    const rock = vec3(0.5, 0.5, 0.5);
    const snow = vec3(0.95, 0.95, 1.0);

    let baseColor = mix(sand, grass, smoothstep(float(0.0), float(0.25), t));
    baseColor = mix(baseColor, rock, smoothstep(float(0.25), float(0.65), t));
    baseColor = mix(baseColor, snow, smoothstep(float(0.65), float(0.95), t));

    const gridSize = float(10.0);
    const gridPos = positionWorld.xz.div(gridSize);

    const grid = fract(gridPos.sub(0.5)).sub(0.5).abs().div(fwidth(gridPos));
    const line = grid.x.min(grid.y);

    const gridFactor = smoothstep(float(0.0), float(1.5), line).oneMinus();

    return mix(baseColor, baseColor.mul(0.75), gridFactor);
  }

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

  get shadowInstanceCount(): number {
    let count = 0;
    for (const batch of this.batches.values()) count += batch.shadowMesh.count;
    return count;
  }

  get meshCount(): number {
    return this.entries.size;
  }

  get drawBatchCount(): number {
    let count = 0;
    for (const batch of this.batches.values()) if (batch.mesh.count > 0) count++;
    return count;
  }

  getSeamCode(spatialKey: string): number | undefined {
    return this.entries.get(spatialKey)?.seamCode;
  }

  getGpuAttributes(): THREE.BufferAttribute[] {
    const attributes: THREE.BufferAttribute[] = [];
    for (const base of this.baseGeometries.values()) {
      attributes.push(base.position, base.heightIndex, base.index);
    }
    for (const batch of this.batches.values()) {
      attributes.push(batch.instanceData, batch.shadowData);
    }
    return attributes;
  }

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

  private baseGeometryFor(resolution: number): BaseGeometry {
    const cached = this.baseGeometries.get(resolution);
    if (cached) return cached;

    const size = this.config.CHUNK_SIZE;
    const last = resolution - 1;
    const gridCount = resolution * resolution;
    const vertexCount = gridCount + 4 * resolution;

    const positions = new Float32Array(vertexCount * 3);
    const heightIndex = new Float32Array(vertexCount);

    for (let z = 0; z < resolution; z++) {
      for (let x = 0; x < resolution; x++) {
        const i = z * resolution + x;
        positions[i * 3] = (x / last) * size;
        positions[i * 3 + 1] = 0;
        positions[i * 3 + 2] = (z / last) * size;
        heightIndex[i] = i;
      }
    }

    const edgeIndex = [
      (k: number) => k * resolution,
      (k: number) => k * resolution + last,
      (k: number) => k,
      (k: number) => last * resolution + k,
    ];

    for (let side = 0; side < 4; side++) {
      for (let k = 0; k < resolution; k++) {
        const source = edgeIndex[side](k);
        const v = gridCount + side * resolution + k;
        positions[v * 3] = positions[source * 3];
        positions[v * 3 + 1] = -1;
        positions[v * 3 + 2] = positions[source * 3 + 2];
        heightIndex[v] = source;
      }
    }

    const gridTriangles = (resolution - 1) * (resolution - 1) * 2;
    const skirtTriangles = 4 * (resolution - 1) * 2;
    const indices = new Uint16Array((gridTriangles + skirtTriangles) * 3);
    let idx = 0;

    for (let z = 0; z < last; z++) {
      for (let x = 0; x < last; x++) {
        const a = z * resolution + x;
        const b = z * resolution + (x + 1);
        const c = (z + 1) * resolution + x;
        const d = (z + 1) * resolution + (x + 1);
        indices[idx++] = a;
        indices[idx++] = c;
        indices[idx++] = b;
        indices[idx++] = b;
        indices[idx++] = c;
        indices[idx++] = d;
      }
    }

    for (let side = 0; side < 4; side++) {
      const reversed = side === 1 || side === 2;
      for (let k = 0; k < last; k++) {
        const e0 = edgeIndex[side](k);
        const e1 = edgeIndex[side](k + 1);
        const s0 = gridCount + side * resolution + k;
        const s1 = s0 + 1;
        if (reversed) {
          indices[idx++] = e0;
          indices[idx++] = e1;
          indices[idx++] = s0;
          indices[idx++] = e1;
          indices[idx++] = s1;
          indices[idx++] = s0;
        } else {
          indices[idx++] = e0;
          indices[idx++] = s0;
          indices[idx++] = e1;
          indices[idx++] = e1;
          indices[idx++] = s0;
          indices[idx++] = s1;
        }
      }
    }

    const base: BaseGeometry = {
      position: new THREE.BufferAttribute(positions, 3),
      heightIndex: new THREE.BufferAttribute(heightIndex, 1),
      index: new THREE.BufferAttribute(indices, 1),
      surfaceIndexCount: gridTriangles * 3,
      skirtIndexCount: skirtTriangles * 3,
    };
    this.baseGeometries.set(resolution, base);
    return base;
  }

  private materialsFor(page: HeightPage): PageMaterials {
    const cached = this.materials.get(page.id);
    if (cached) return cached;

    const surface = new MeshStandardNodeMaterial({
      color: 0xffffff,
      roughness: 0.8,
      metalness: 0.1,
      flatShading: true,
      side: THREE.FrontSide,
    });
    surface.colorNode = vec4(this.colorNode, 1.0);
    surface.positionNode = createTerrainPositionNode(page.heights, page.resolution, this.skirtDepth);
    surface.castShadowPositionNode = createTerrainPositionNode(page.heights, page.resolution, 0);

    const skirt = new MeshStandardNodeMaterial({
      color: 0xffffff,
      roughness: 0.8,
      metalness: 0.1,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: SKIRT_POLYGON_OFFSET_FACTOR,
      polygonOffsetUnits: SKIRT_POLYGON_OFFSET_UNITS,
    });
    skirt.colorNode = vec4(this.colorNode, 1.0);
    skirt.positionNode = surface.positionNode;
    skirt.castShadowPositionNode = surface.castShadowPositionNode;
    skirt.normalNode = cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz.normalize();

    const materials: PageMaterials = { surface, skirt };
    this.materials.set(page.id, materials);
    return materials;
  }

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
