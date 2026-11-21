import * as THREE from 'three';
import { vec3, smoothstep, positionWorld, fract, uniform, mix, fwidth, float } from 'three/tsl';
import { Chunk, ChunkKey, ChunkLOD } from '../types/chunk';
import { TerrainConfig } from '../types/terrain';
import { getChunkKey, isRenderableChunk } from '../math/chunk-coord';

interface CoordEntry {
  readonly chunkKey: ChunkKey;
  readonly mesh: THREE.Mesh;
  readonly resolution: number;
  readonly source: Float32Array;
}

const MAX_POOLED_MESHES_PER_RESOLUTION = 32;
const LODS: readonly ChunkLOD[] = [0, 1, 2, 3];

export class SceneGraph {
  private readonly scene: THREE.Scene;
  private readonly config: TerrainConfig;

  private readonly entries = new Map<string, CoordEntry>();
  private readonly meshPool = new Map<number, THREE.Mesh[]>();
  private terrainMaterial: THREE.MeshStandardMaterial | null = null;

  constructor(scene: THREE.Scene, config: TerrainConfig) {
    this.scene = scene;
    this.config = config;
    this.initMaterial();
  }

  private initMaterial(): void {
    this.terrainMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.8,
      metalness: 0.1,
      flatShading: true,
      side: THREE.FrontSide,
    });

    this.setupWebGPUShading();
  }

  /**
   * Configure terrain shading natively for WebGPU using TSL.
   * This ensures that changes are visible under WebGPU Denderer.
   */
  private setupWebGPUShading(): void {
    if (!this.terrainMaterial) return;

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

    (this.terrainMaterial as any).colorNode = mix(baseColor, baseColor.mul(0.75), gridFactor);
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

  get meshCount(): number {
    return this.entries.size;
  }

  getGeometryBytes(): number {
    let bytes = 0;
    for (const entry of this.entries.values()) {
      bytes += this.geometryBytes(entry.resolution);
    }
    for (const [resolution, pool] of this.meshPool) {
      bytes += this.geometryBytes(resolution) * pool.length;
    }
    return bytes;
  }

  private geometryBytes(resolution: number): number {
    return resolution * resolution * 12 + (resolution - 1) * (resolution - 1) * 6 * 2;
  }

  private syncCoord(
    spatialKey: string,
    chunks: ReadonlyMap<ChunkKey, Chunk>,
    visibleKeys: ReadonlySet<ChunkKey>,
  ): void {
    const best = this.selectBest(spatialKey, chunks);
    const entry = this.entries.get(spatialKey);

    if (!best || !best.geometryData) {
      if (entry) this.releaseEntry(spatialKey, entry);
      return;
    }

    const chunkKey = getChunkKey(best.meta.coord);
    const source = best.geometryData.positions;

    if (entry && entry.chunkKey === chunkKey && entry.source === source) {
      entry.mesh.visible = visibleKeys.has(chunkKey);
      return;
    }

    const resolution = best.meta.resolution;
    let mesh: THREE.Mesh;

    if (entry && entry.resolution === resolution) {
      mesh = entry.mesh;
    } else {
      if (entry) this.releaseEntry(spatialKey, entry);
      mesh = this.acquireMesh(resolution);
      this.scene.add(mesh);
    }

    this.writeGeometry(mesh.geometry, best);

    mesh.position.set(best.meta.worldOrigin.x, 0, best.meta.worldOrigin.z);
    mesh.updateMatrix();
    mesh.visible = visibleKeys.has(chunkKey);

    this.entries.set(spatialKey, { chunkKey, mesh, resolution, source });
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

  private writeGeometry(geometry: THREE.BufferGeometry, chunk: Chunk): void {
    const data = chunk.geometryData!;
    const positions = geometry.attributes['position'] as THREE.BufferAttribute;
    (positions.array as Float32Array).set(data.positions);
    positions.needsUpdate = true;

    const size = chunk.meta.size;
    const box = geometry.boundingBox ?? new THREE.Box3();
    box.min.set(0, data.bounds.minHeight, 0);
    box.max.set(size, data.bounds.maxHeight, size);
    geometry.boundingBox = box;

    const sphere = geometry.boundingSphere ?? new THREE.Sphere();
    box.getBoundingSphere(sphere);
    geometry.boundingSphere = sphere;
  }

  private acquireMesh(resolution: number): THREE.Mesh {
    const pooled = this.meshPool.get(resolution);
    if (pooled && pooled.length > 0) {
      return pooled.pop()!;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(resolution * resolution * 3), 3),
    );
    geometry.setIndex(new THREE.BufferAttribute(this.generateIndices(resolution), 1));

    const mesh = new THREE.Mesh(geometry, this.terrainMaterial || undefined);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    mesh.matrixAutoUpdate = false;

    return mesh;
  }

  private releaseEntry(spatialKey: string, entry: CoordEntry): void {
    this.scene.remove(entry.mesh);
    this.entries.delete(spatialKey);

    let pool = this.meshPool.get(entry.resolution);
    if (!pool) {
      pool = [];
      this.meshPool.set(entry.resolution, pool);
    }

    if (pool.length < MAX_POOLED_MESHES_PER_RESOLUTION) {
      pool.push(entry.mesh);
    } else {
      entry.mesh.geometry.dispose();
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
    for (const entry of this.entries.values()) {
      this.scene.remove(entry.mesh);
      entry.mesh.geometry.dispose();
    }
    this.entries.clear();
    for (const pool of this.meshPool.values()) {
      for (const mesh of pool) mesh.geometry.dispose();
    }
    this.meshPool.clear();
    if (this.terrainMaterial) this.terrainMaterial.dispose();
  }
}
