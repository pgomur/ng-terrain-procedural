import * as THREE from 'three';
import { DEFAULT_TERRAIN_CONFIG } from '../types/terrain';
import { createChunkGeometry } from './chunk-geometry';

describe('createChunkGeometry', () => {
  const size = 64;

  it('builds a grid plus four skirts with valid indices for every LOD resolution', () => {
    for (const resolution of Object.values(DEFAULT_TERRAIN_CONFIG.CHUNK_RESOLUTIONS)) {
      const geometry = createChunkGeometry(resolution, size);
      const vertices = resolution * resolution + 4 * resolution;
      const indices = geometry.index.array;

      expect(geometry.position.count).toBe(vertices);
      expect(geometry.heightIndex.count).toBe(vertices);
      expect(geometry.surfaceIndexCount).toBe((resolution - 1) ** 2 * 6);
      expect(geometry.skirtIndexCount).toBe(4 * (resolution - 1) * 6);
      expect(indices.length).toBe(geometry.surfaceIndexCount + geometry.skirtIndexCount);
      expect(Math.max(...indices)).toBe(vertices - 1);
    }
  });

  it('places the grid on the chunk and hangs every skirt vertex below an edge vertex', () => {
    const resolution = 17;
    const last = resolution - 1;
    const { position, heightIndex } = createChunkGeometry(resolution, size);
    const grid = resolution * resolution;

    for (let i = 0; i < grid; i++) {
      expect(position.getX(i)).toBeCloseTo(((i % resolution) / last) * size, 12);
      expect(position.getY(i)).toBe(0);
      expect(position.getZ(i)).toBeCloseTo((Math.floor(i / resolution) / last) * size, 12);
      expect(heightIndex.getX(i)).toBe(i);
    }
    for (let v = grid; v < position.count; v++) {
      const source = heightIndex.getX(v);
      const sx = source % resolution;
      const sz = Math.floor(source / resolution);
      expect(sx === 0 || sx === last || sz === 0 || sz === last).toBe(true);
      expect(position.getX(v)).toBe(position.getX(source));
      expect(position.getZ(v)).toBe(position.getZ(source));
      expect(position.getY(v)).toBe(-1);
    }
  });

  it('winds every surface triangle facing up', () => {
    const { position, index, surfaceIndexCount } = createChunkGeometry(9, size);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    for (let i = 0; i < surfaceIndexCount; i += 3) {
      a.fromBufferAttribute(position, index.getX(i));
      b.fromBufferAttribute(position, index.getX(i + 1));
      c.fromBufferAttribute(position, index.getX(i + 2));
      const normal = b.sub(a).cross(c.sub(a)).normalize();
      expect(normal.y).toBeCloseTo(1, 12);
    }
  });

  it('skirts face outwards on all four sides', () => {
    const resolution = 17;
    const base = createChunkGeometry(resolution, size);
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
  });
});
