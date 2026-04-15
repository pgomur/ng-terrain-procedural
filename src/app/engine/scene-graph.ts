import * as THREE from 'three';
import { vec3, smoothstep, positionWorld, fract, uniform, mix, fwidth, float } from 'three/tsl';
import { Chunk, ChunkKey } from '../types/chunk';
import { TerrainConfig } from '../types/terrain';
import { getChunkKey } from '../math/chunk-coord';

export class SceneGraph {
  private readonly scene: THREE.Scene;
  private readonly config: TerrainConfig;

  private activeMeshes = new Map<ChunkKey, THREE.Mesh>();
  private geometryPool = new Map<number, THREE.BufferGeometry[]>();
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

  addOrUpdateChunk(chunk: Chunk): void {
    const key = getChunkKey(chunk.meta.coord);

    if (this.activeMeshes.has(key)) {
      return;
    }

    const mesh = this.createChunkMesh(chunk);
    if (!mesh) return;

    mesh.position.set(chunk.meta.worldOrigin.x, 0, chunk.meta.worldOrigin.z);

    this.scene.add(mesh);
    this.activeMeshes.set(key, mesh);
  }

  private createChunkMesh(chunk: Chunk): THREE.Mesh | null {
    if (!chunk.gpu) return null;

    const geometry = this.getOrCreateGeometry(chunk);
    if (!geometry) return null;

    const mesh = new THREE.Mesh(geometry, this.terrainMaterial || undefined);

    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;

    (mesh as any).chunkKey = getChunkKey(chunk.meta.coord);
    (mesh as any).chunkBounds = chunk.bounds;

    return mesh;
  }

  private getOrCreateGeometry(chunk: Chunk): THREE.BufferGeometry | null {
    if (!chunk.geometryData) return null;

    const resolution = chunk.meta.resolution;
    const pooled = this.geometryPool.get(resolution);
    let geometry: THREE.BufferGeometry;

    if (pooled && pooled.length > 0) {
      geometry = pooled.pop()!;
    } else {
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(chunk.geometryData.positions.length), 3),
      );
      geometry.setIndex(new THREE.BufferAttribute(this.generateIndices(resolution), 1));
    }

    const positions = geometry.attributes['position'] as THREE.BufferAttribute;
    positions.array.set(chunk.geometryData.positions);
    positions.needsUpdate = true;

    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();

    return geometry;
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

  cleanupInactive(chunksToKeep: Map<ChunkKey, Chunk>): void {
    const keysToRemove: ChunkKey[] = [];
    for (const key of this.activeMeshes.keys()) {
      if (!chunksToKeep.has(key)) keysToRemove.push(key);
    }
    for (const key of keysToRemove) {
      const mesh = this.activeMeshes.get(key);
      if (mesh) {
        this.scene.remove(mesh);
        this.activeMeshes.delete(key);
        const res = Math.sqrt(mesh.geometry.attributes['position'].count);
        if (!this.geometryPool.has(res)) this.geometryPool.set(res, []);
        this.geometryPool.get(res)!.push(mesh.geometry);
      }
    }
  }

  update(frameTime: number): void {}

  dispose(): void {
    for (const mesh of this.activeMeshes.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.activeMeshes.clear();
    for (const geometries of this.geometryPool.values()) {
      for (const geometry of geometries) geometry.dispose();
    }
    this.geometryPool.clear();
    if (this.terrainMaterial) this.terrainMaterial.dispose();
  }
}
