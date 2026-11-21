import * as THREE from 'three';
import { MeshStandardNodeMaterial, type Node } from 'three/webgpu';
import { vec3, vec4, smoothstep, positionWorld, fract, uniform, mix, fwidth, float } from 'three/tsl';
import { Chunk, ChunkKey, ChunkLOD } from '../types/chunk';
import { TerrainConfig } from '../types/terrain';
import { getChunkKey, isRenderableChunk, analyticHeightRange } from '../math/chunk-coord';
import { createHeightDisplacementNode } from '../shaders/elevation.tsl';
import type { HeightPage } from './gpu-generator';

export interface HeightPageSource {
  getPage(pageId: number): HeightPage | undefined;
}

interface CoordEntry {
  readonly chunkKey: ChunkKey;
  readonly mesh: THREE.Mesh;
  readonly resolution: number;
  readonly pageId: number;
  readonly slot: number;
  readonly generation: number;
}

const MAX_POOLED_MESHES = 256;
const LODS: readonly ChunkLOD[] = [0, 1, 2, 3];

export class SceneGraph {
  private readonly scene: THREE.Scene;
  private readonly config: TerrainConfig;
  private readonly heightSource: HeightPageSource;

  private readonly entries = new Map<string, CoordEntry>();
  private readonly meshPool: THREE.Mesh[] = [];
  private readonly prewarmMeshes: THREE.Mesh[] = [];
  private readonly geometries = new Map<number, THREE.BufferGeometry>();
  private readonly materials = new Map<number, MeshStandardNodeMaterial>();
  private readonly colorNode: Node<'vec3'>;
  private readonly slotUniform = uniform(float(0)).onObjectUpdate(({ object }) =>
    object ? ((object.userData['heightSlot'] as number | undefined) ?? 0) : 0,
  );

  constructor(scene: THREE.Scene, config: TerrainConfig, heightSource: HeightPageSource) {
    this.scene = scene;
    this.config = config;
    this.heightSource = heightSource;
    this.colorNode = this.createColorNode();
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
      if (entry && entry.chunkKey === key) {
        entry.mesh.visible = visibleKeys.has(key);
      }
    }
  }

  prewarm(pages: readonly HeightPage[]): void {
    for (const page of pages) {
      const mesh = new THREE.Mesh(this.geometryFor(page.resolution), this.materialFor(page.id));
      mesh.userData['heightSlot'] = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.prewarmMeshes.push(mesh);
      this.scene.add(mesh);
    }
  }

  endPrewarm(): void {
    for (const mesh of this.prewarmMeshes) this.scene.remove(mesh);
    this.prewarmMeshes.length = 0;
  }

  get meshCount(): number {
    return this.entries.size;
  }

  getGeometryBytes(): number {
    let bytes = 0;
    for (const resolution of this.geometries.keys()) {
      bytes += resolution * resolution * 12 + (resolution - 1) * (resolution - 1) * 6 * 2;
    }
    return bytes;
  }

  private syncCoord(
    spatialKey: string,
    chunks: ReadonlyMap<ChunkKey, Chunk>,
    visibleKeys: ReadonlySet<ChunkKey>,
  ): void {
    const best = this.selectBest(spatialKey, chunks);
    const entry = this.entries.get(spatialKey);

    if (!best || !best.gpu) {
      if (entry) this.releaseEntry(spatialKey, entry);
      return;
    }

    const chunkKey = getChunkKey(best.meta.coord);
    const gpu = best.gpu;

    if (
      entry &&
      entry.chunkKey === chunkKey &&
      entry.pageId === gpu.pageId &&
      entry.slot === gpu.slot &&
      entry.generation === gpu.generation
    ) {
      entry.mesh.visible = visibleKeys.has(chunkKey);
      return;
    }

    let mesh: THREE.Mesh;
    if (entry) {
      mesh = entry.mesh;
    } else {
      mesh = this.acquireMesh();
      this.scene.add(mesh);
    }

    mesh.geometry = this.geometryFor(gpu.resolution);
    mesh.material = this.materialFor(gpu.pageId);
    mesh.userData['heightSlot'] = gpu.slot;

    mesh.position.set(best.meta.worldOrigin.x, 0, best.meta.worldOrigin.z);
    mesh.updateMatrix();
    mesh.visible = visibleKeys.has(chunkKey);

    this.entries.set(spatialKey, {
      chunkKey,
      mesh,
      resolution: gpu.resolution,
      pageId: gpu.pageId,
      slot: gpu.slot,
      generation: gpu.generation,
    });
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

  private geometryFor(resolution: number): THREE.BufferGeometry {
    let geometry = this.geometries.get(resolution);
    if (geometry) return geometry;

    const size = this.config.CHUNK_SIZE;
    const positions = new Float32Array(resolution * resolution * 3);
    for (let z = 0; z < resolution; z++) {
      for (let x = 0; x < resolution; x++) {
        const i = (z * resolution + x) * 3;
        positions[i] = (x / (resolution - 1)) * size;
        positions[i + 1] = 0;
        positions[i + 2] = (z / (resolution - 1)) * size;
      }
    }

    geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(this.generateIndices(resolution), 1));

    const range = analyticHeightRange(this.config.TERRAIN_HEIGHT_SCALE, this.config.TERRAIN_OFFSET_Y);
    geometry.boundingBox = new THREE.Box3(
      new THREE.Vector3(0, range.min, 0),
      new THREE.Vector3(size, range.max, size),
    );
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());

    this.geometries.set(resolution, geometry);
    return geometry;
  }

  private materialFor(pageId: number): MeshStandardNodeMaterial {
    let material = this.materials.get(pageId);
    if (material) return material;

    const page = this.heightSource.getPage(pageId);
    if (!page) {
      throw new Error(`Height page ${pageId} does not exist`);
    }

    material = new MeshStandardNodeMaterial({
      color: 0xffffff,
      roughness: 0.8,
      metalness: 0.1,
      flatShading: true,
      side: THREE.FrontSide,
    });
    material.colorNode = vec4(this.colorNode, 1.0);
    material.positionNode = createHeightDisplacementNode(
      page.heights,
      page.resolution,
      this.slotUniform,
    );

    this.materials.set(pageId, material);
    return material;
  }

  private acquireMesh(): THREE.Mesh {
    const pooled = this.meshPool.pop();
    if (pooled) return pooled;

    const mesh = new THREE.Mesh();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  private releaseEntry(spatialKey: string, entry: CoordEntry): void {
    this.scene.remove(entry.mesh);
    this.entries.delete(spatialKey);

    if (this.meshPool.length < MAX_POOLED_MESHES) {
      this.meshPool.push(entry.mesh);
    }
  }

  private generateIndices(res: number): Uint16Array {
    const indices = new Uint16Array((res - 1) * (res - 1) * 6);
    let idx = 0;
    for (let z = 0; z < res - 1; z++) {
      for (let x = 0; x < res - 1; x++) {
        const a = z * res + x;
        const b = z * res + (x + 1);
        const c = (z + 1) * res + x;
        const d = (z + 1) * res + (x + 1);
        indices[idx++] = a;
        indices[idx++] = c;
        indices[idx++] = b;
        indices[idx++] = b;
        indices[idx++] = c;
        indices[idx++] = d;
      }
    }
    return indices;
  }

  dispose(): void {
    this.endPrewarm();
    for (const entry of this.entries.values()) {
      this.scene.remove(entry.mesh);
    }
    this.entries.clear();
    this.meshPool.length = 0;

    for (const geometry of this.geometries.values()) geometry.dispose();
    this.geometries.clear();

    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
  }
}
