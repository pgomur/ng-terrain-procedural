import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { StorageBufferAttribute } from 'three/webgpu';
import { ChunkManager } from './chunk-manager';
import { SceneGraph, SHADOW_CASTER_LAYER } from './scene-graph';
import { DEFAULT_TERRAIN_CONFIG, type TerrainConfig } from '../types/terrain';
import type { ChunkLOD, FrustumPlanes } from '../types/chunk';
import { encodeSeamCode, seamLodDiff, skirtDepthFor, stitchedHeight } from '../math/chunk-coord';
import { CpuHeightGenerator } from '../../testing/cpu-height-generator';

const config: TerrainConfig = {
  ...DEFAULT_TERRAIN_CONFIG,
  CHUNK_SIZE: 64,
  LOD_DISTANCES: [70, 140, 260],
  GENERATION_QUEUE_CAPACITY: 128,
  UNLOAD_DELAY_FRAMES: 2,
  GENERATION_BUDGET: 16,
};
const heightFn = (x: number, z: number) => 40 + 25 * Math.sin(x * 0.037) * Math.cos(z * 0.029) + 0.01 * x;

interface Entry {
  readonly spatialKey: string;
  readonly x: number;
  readonly z: number;
  readonly lod: ChunkLOD;
  readonly slot: number;
  readonly visible: boolean;
  readonly seamCode: number;
}

interface Internals {
  readonly entries: Map<string, Entry>;
  readonly batches: Map<number, {
    readonly page: { readonly resolution: number };
    readonly mesh: THREE.InstancedMesh;
    readonly shadowMesh: THREE.InstancedMesh;
    readonly shadowGeometry: THREE.BufferGeometry;
    readonly instanceData: THREE.InstancedBufferAttribute;
    readonly entries: Set<Entry>;
  }>;
  readonly shadowRegion: { readonly x: number; readonly z: number; readonly radius: number };
  baseGeometryFor(resolution: number): {
    readonly position: THREE.BufferAttribute;
    readonly heightIndex: THREE.BufferAttribute;
    readonly index: THREE.BufferAttribute;
    readonly surfaceIndexCount: number;
    readonly skirtIndexCount: number;
  };
}

const internals = (graph: SceneGraph) => graph as unknown as Internals;

const pageSource = () => {
  const pages = new Map<number, unknown>();
  return {
    getPage(id: number) {
      if (!pages.has(id)) {
        pages.set(id, {
          id,
          resolution: config.CHUNK_RESOLUTIONS[id as ChunkLOD],
          capacity: 4096,
          heights: new StorageBufferAttribute(new Float32Array(16), 1),
        });
      }
      return pages.get(id) as never;
    },
  };
};

function frustumFor(camera: THREE.PerspectiveCamera): FrustumPlanes {
  camera.updateMatrixWorld(true);
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
  return {
    normals: frustum.planes.map((p) => ({ x: p.normal.x, y: p.normal.y, z: p.normal.z })),
    constants: frustum.planes.map((p) => p.constant),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

function setup() {
  const scene = new THREE.Scene();
  const generator = new CpuHeightGenerator(config, () => 'ok', heightFn);
  const manager = new ChunkManager(config, generator as never);
  const graph = new SceneGraph(scene, config, pageSource());
  return { scene, generator, manager, graph };
}

function frame(manager: ChunkManager, graph: SceneGraph, camera: THREE.PerspectiveCamera, viewChanged = true) {
  manager.update({ position: camera.position } as never, frustumFor(camera), viewChanged);
  graph.sync(manager.getChunks(), manager.getVisibleKeys(), manager.getDirtyCoords(), manager.getVisibilityToggled());
  manager.clearRenderChanges();
}

async function settle(manager: ChunkManager, graph: SceneGraph, camera: THREE.PerspectiveCamera) {
  for (let f = 0; f < 3000; f++) {
    frame(manager, graph, camera);
    await tick();
    const stats = manager.getStats();
    if (f > 5 && stats.pendingCount === 0 && stats.unloadingCount === 0 && stats.exactBoundsCount === stats.readyCount) {
      for (let i = 0; i < 10; i++) {
        frame(manager, graph, camera, false);
        await tick();
      }
      return f;
    }
  }
  return -1;
}

function bruteForceSeam(graph: SceneGraph, entry: Entry): number {
  const lodAt = (dx: number, dz: number) => internals(graph).entries.get(`${entry.x + dx}:${entry.z + dz}`)?.lod ?? null;
  return encodeSeamCode(
    seamLodDiff(entry.lod, lodAt(-1, 0)),
    seamLodDiff(entry.lod, lodAt(1, 0)),
    seamLodDiff(entry.lod, lodAt(0, -1)),
    seamLodDiff(entry.lod, lodAt(0, 1)),
  );
}

describe('SceneGraph', () => {
  it('collision height equals the stitched rendered surface across LOD boundaries', async () => {
    const { generator, manager, graph } = setup();
    const camera = new THREE.PerspectiveCamera(60, 1, 0.5, 2000);
    camera.position.set(20, 300, 30);
    camera.lookAt(20, 0, 31);
    expect(await settle(manager, graph, camera)).toBeGreaterThan(0);

    const near = [...internals(graph).entries.values()].filter((e) => Math.abs(e.x) <= 1 && Math.abs(e.z) <= 1);
    expect(new Set(near.map((e) => e.lod)).size).toBeGreaterThan(1);

    const reference = new THREE.Group();
    for (const entry of near) {
      const resolution = config.CHUNK_RESOLUTIONS[entry.lod];
      const base = internals(graph).baseGeometryFor(resolution);
      const heights = generator.heightsFor({ x: entry.x, z: entry.z, lod: entry.lod }, resolution);
      const positions = new Float32Array(base.position.array.length);
      for (let v = 0; v < base.heightIndex.count; v++) {
        const index = base.heightIndex.array[v];
        positions[v * 3] = base.position.array[v * 3] + entry.x * config.CHUNK_SIZE;
        positions[v * 3 + 1] = stitchedHeight(heights, resolution, index % resolution, Math.floor(index / resolution), entry.seamCode);
        positions[v * 3 + 2] = base.position.array[v * 3 + 2] + entry.z * config.CHUNK_SIZE;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setIndex(base.index);
      geometry.setDrawRange(0, base.surfaceIndexCount);
      reference.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })));
    }
    reference.updateMatrixWorld(true);

    const ray = new THREE.Raycaster();
    let maxError = 0;
    let samples = 0;
    const points: [number, number][] = [];
    let s = 5;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let i = 0; i < 600; i++) points.push([-64 + rnd() * 191.99, -64 + rnd() * 191.99]);
    for (let k = 0; k <= 64; k += 3) points.push([0.0001, k], [63.9999, k], [k, 63.9999], [k, 0.0001], [-63.9999 + k, 64.0001]);
    for (const [x, z] of points) {
      const height = manager.getTerrainHeightAt(x, z);
      if (height === null) continue;
      ray.set(new THREE.Vector3(x, 1000, z), new THREE.Vector3(0, -1, 0));
      const hit = ray.intersectObject(reference, true)[0];
      maxError = Math.max(maxError, Math.abs(hit.point.y - height));
      samples++;
    }
    expect(samples).toBeGreaterThan(500);
    expect(maxError).toBeLessThan(1e-3);
  }, 30_000);

  it('instance buffers hold exactly the visible chunks with correct origin, slot and seam code', async () => {
    const { manager, graph } = setup();
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 2000);
    camera.position.set(0, 60, 0);
    camera.lookAt(100, 60, 0);
    expect(await settle(manager, graph, camera)).toBeGreaterThan(0);

    const verify = () => {
      const entries = [...internals(graph).entries.values()];
      for (const entry of entries) expect(entry.seamCode).toBe(bruteForceSeam(graph, entry));
      for (const batch of internals(graph).batches.values()) {
        const visible = [...batch.entries].filter((e) => e.visible);
        expect(batch.mesh.count).toBe(visible.length);
        const data = batch.instanceData.array as Float32Array;
        const rows = new Set<string>();
        for (let i = 0; i < batch.mesh.count; i++) rows.add(`${data[i * 4]}|${data[i * 4 + 1]}|${data[i * 4 + 2]}|${data[i * 4 + 3]}`);
        for (const e of visible) expect(rows.has(`${e.x * 64}|${e.z * 64}|${e.slot}|${e.seamCode}`)).toBe(true);
      }
      const coords = new Set([...manager.getChunks().values()].filter((c) => c.gpu).map((c) => `${c.meta.coord.x}:${c.meta.coord.z}`));
      expect(entries.length).toBe(coords.size);
      return entries;
    };

    const initial = verify();
    expect(initial.some((e) => e.seamCode !== 0)).toBe(true);
    const byKey = new Map(initial.map((e) => [e.spatialKey, e]));
    const visibleCounts = new Set<number>();
    for (let step = 1; step <= 24; step++) {
      const angle = (step / 24) * Math.PI * 2;
      camera.lookAt(100 * Math.cos(angle), 60, 100 * Math.sin(angle));
      frame(manager, graph, camera);
      const after = verify();
      for (const e of after) expect(byKey.get(e.spatialKey)).toBe(e);
      visibleCounts.add(after.filter((e) => e.visible).length);
    }
    expect(visibleCounts.size).toBeGreaterThan(1);
  }, 30_000);

  it('shadow casters cover the shadow region regardless of camera visibility', async () => {
    const { manager, graph } = setup();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.5, 2000);
    camera.position.set(0, 60, 0);
    camera.lookAt(0, 60, 100);
    await settle(manager, graph, camera);
    graph.setShadowRegion(0, 0, 150);
    graph.sync(manager.getChunks(), manager.getVisibleKeys(), new Set(), new Set());

    const entries = [...internals(graph).entries.values()];
    const region = internals(graph).shadowRegion;
    const limit = region.radius + 64 * Math.SQRT1_2;
    const expected = entries.filter((e) => Math.hypot(e.x * 64 + 32 - region.x, e.z * 64 + 32 - region.z) <= limit);
    expect(graph.shadowInstanceCount).toBe(expected.length);
    expect(expected.some((e) => !e.visible)).toBe(true);
    expect(graph.shadowInstanceCount).toBeLessThan(entries.length);
    for (const batch of internals(graph).batches.values()) {
      expect(batch.shadowMesh.layers.mask).toBe(1 << SHADOW_CASTER_LAYER);
      expect(batch.shadowMesh.castShadow).toBe(true);
      expect(batch.mesh.castShadow).toBe(false);
      expect(batch.shadowGeometry.drawRange.count).toBe(internals(graph).baseGeometryFor(batch.page.resolution).surfaceIndexCount);
    }
  }, 30_000);

  it('skirts face outwards on all four sides', () => {
    const graph = new SceneGraph(new THREE.Scene(), config, pageSource());
    const resolution = 17;
    const base = internals(graph).baseGeometryFor(resolution);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', base.position);
    geometry.setIndex(base.index);
    geometry.addGroup(base.surfaceIndexCount, base.skirtIndexCount, 0);
    const mesh = new THREE.Mesh(geometry, [new THREE.MeshBasicMaterial({ side: THREE.FrontSide })]);
    mesh.updateMatrixWorld(true);

    const ray = new THREE.Raycaster();
    const c = 33.3;
    const y = -0.37;
    const cases: [THREE.Vector3, THREE.Vector3][] = [
      [new THREE.Vector3(-50, y, c), new THREE.Vector3(1, 0, 0)],
      [new THREE.Vector3(114, y, c), new THREE.Vector3(-1, 0, 0)],
      [new THREE.Vector3(c, y, -50), new THREE.Vector3(0, 0, 1)],
      [new THREE.Vector3(c, y, 114), new THREE.Vector3(0, 0, -1)],
    ];
    for (const [origin, direction] of cases) {
      ray.set(origin, direction);
      const hits = ray.intersectObject(mesh);
      expect(hits.length).toBe(1);
      expect(hits[0].face!.normal.dot(direction)).toBeLessThan(-0.99);
      ray.set(new THREE.Vector3(c, y, c), direction.clone().negate());
      expect(ray.intersectObject(mesh).length).toBe(0);
    }
    expect(base.skirtIndexCount).toBe(4 * (resolution - 1) * 6);
    expect(skirtDepthFor(config.TERRAIN_HEIGHT_SCALE)).toBe(2);
  });
});
