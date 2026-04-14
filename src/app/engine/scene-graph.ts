import * as THREE from 'three';
import { Chunk, ChunkKey } from '../types/chunk';
import { TerrainConfig } from '../types/terrain';
import { getChunkKey } from '../math/chunk-coord';

export class SceneGraph {
  private readonly scene: THREE.Scene;
  private readonly config: TerrainConfig;

  private activeMeshes = new Map<ChunkKey, THREE.Mesh>();
  private geometryPool = new Map<number, THREE.BufferGeometry[]>();
  private terrainMaterial: THREE.MeshStandardMaterial | null = null;

  private totalTriangles = 0;

  constructor(scene: THREE.Scene, config: TerrainConfig) {
    this.scene = scene;
    this.config = config;
    this.initMaterial();
  }

  private initMaterial(): void {
    this.terrainMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.9,
      metalness: 0.1,
      flatShading: false,
      side: THREE.FrontSide,
      transparent: true,
      opacity: 1.0,
    });

    (this.terrainMaterial as any).uniforms = {
      ['uMinHeight']: { value: this.config.TERRAIN_OFFSET_Y },
      ['uMaxHeight']: { value: this.config.TERRAIN_OFFSET_Y + this.config.TERRAIN_HEIGHT_SCALE },
    };

    this.setupHeightBasedColor();
  }

  private setupHeightBasedColor(): void {
    if (!this.terrainMaterial) return;

    this.terrainMaterial.onBeforeCompile = (shader) => {
      shader.uniforms['uMinHeight'] = { value: this.config.TERRAIN_OFFSET_Y };
      shader.uniforms['uMaxHeight'] = {
        value: this.config.TERRAIN_OFFSET_Y + this.config.TERRAIN_HEIGHT_SCALE,
      };

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `
        #include <common>
        uniform float uMinHeight;
        uniform float uMaxHeight;

        vec3 getTerrainColor(float height) {
          float t = smoothstep(uMinHeight, uMaxHeight, height);

          vec3 water = vec3(0.1, 0.3, 0.5);
          vec3 sand = vec3(0.76, 0.7, 0.5);
          vec3 dirt = vec3(0.55, 0.45, 0.3);
          vec3 rock = vec3(0.4, 0.4, 0.4);
          vec3 snow = vec3(0.95, 0.95, 1.0);

          if (t < 0.2) return mix(water, sand, t * 5.0);
          if (t < 0.4) return mix(sand, dirt, (t - 0.2) * 5.0);
          if (t < 0.7) return mix(dirt, rock, (t - 0.4) * 3.33);
          return mix(rock, snow, (t - 0.7) * 3.33);
        }
        `,
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `
        float worldHeight = vViewPosition.y + cameraPosition.y;
        vec3 terrainColor = getTerrainColor(worldHeight);
        vec4 diffuseColor = vec4(terrainColor, opacity);
        `,
      );
    };
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

    const material = this.terrainMaterial || undefined;
    const mesh = new THREE.Mesh(geometry, material);

    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;

    (mesh as any).chunkKey = getChunkKey(chunk.meta.coord);
    (mesh as any).chunkBounds = chunk.bounds;
    (mesh as any).fadeStartTime = performance.now();

    return mesh;
  }

  private getOrCreateGeometry(chunk: Chunk): THREE.BufferGeometry | null {
    if (!chunk.geometryData) {
      console.warn(
        'Chunk without CPU geometryData. Make sure to return readbackGeometry from the generator',
      );
      return null;
    }

    const resolution = chunk.meta.resolution;

    const pooled = this.geometryPool.get(resolution);
    let geometry: THREE.BufferGeometry;

    if (pooled && pooled.length > 0) {
      geometry = pooled.pop()!;
    } else {
      geometry = new THREE.BufferGeometry();

      const posAttr = new THREE.BufferAttribute(
        new Float32Array(chunk.geometryData.positions.length),
        3,
      );
      const normAttr = new THREE.BufferAttribute(
        new Float32Array(chunk.geometryData.normals.length),
        3,
      );

      geometry.setAttribute('position', posAttr);
      geometry.setAttribute('normal', normAttr);

      const indices = this.generateIndices(resolution);
      geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    }

    const positions = geometry.attributes['position'] as THREE.BufferAttribute;
    const normals = geometry.attributes['normal'] as THREE.BufferAttribute;

    positions.array.set(chunk.geometryData.positions);
    normals.array.set(chunk.geometryData.normals);

    positions.needsUpdate = true;
    normals.needsUpdate = true;

    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();

    return geometry;
  }

  private generateIndices(resolution: number): Uint16Array {
    const indices: number[] = [];
    for (let z = 0; z < resolution - 1; z++) {
      for (let x = 0; x < resolution - 1; x++) {
        const tl = z * resolution + x;
        const tr = tl + 1;
        const bl = (z + 1) * resolution + x;
        const br = bl + 1;
        indices.push(tl, bl, tr, tr, bl, br);
      }
    }
    return new Uint16Array(indices);
  }

  removeChunk(key: ChunkKey): void {
    const mesh = this.activeMeshes.get(key);
    if (!mesh) return;

    this.scene.remove(mesh);

    const geometry = mesh.geometry as THREE.BufferGeometry;
    if (geometry) {
      const attrCount = geometry.attributes['position'].count;
      const resolution = Math.sqrt(attrCount);

      if (!this.geometryPool.has(resolution)) {
        this.geometryPool.set(resolution, []);
      }

      mesh.geometry = null as any;
      this.geometryPool.get(resolution)!.push(geometry);
    }

    (mesh as any).material = undefined;

    this.activeMeshes.delete(key);
  }

  cleanupInactive(activeChunks: ReadonlyMap<ChunkKey, Chunk>): void {
    const toRemove: ChunkKey[] = [];

    for (const key of this.activeMeshes.keys()) {
      if (!activeChunks.has(key)) {
        toRemove.push(key);
      }
    }

    for (const key of toRemove) {
      this.removeChunk(key);
    }
  }

  update(frameTime: number): void {}

  getStats(): { triangles: number; drawCalls: number; meshCount: number } {
    let triangles = 0;
    for (const mesh of this.activeMeshes.values()) {
      if (mesh.geometry) {
        triangles += (mesh.geometry as any).index?.count / 3 || 0;
      }
    }

    return {
      triangles,
      drawCalls: this.activeMeshes.size,
      meshCount: this.activeMeshes.size,
    };
  }

  dispose(): void {
    for (const [key, mesh] of this.activeMeshes) {
      this.scene.remove(mesh);
      mesh.geometry = null as any;
      (mesh as any).material = undefined;
    }
    this.activeMeshes.clear();

    for (const [res, geometries] of this.geometryPool) {
      geometries.forEach((g) => g.dispose());
    }

    this.geometryPool.clear();
    this.terrainMaterial?.dispose();
    this.terrainMaterial = null;
  }
}
