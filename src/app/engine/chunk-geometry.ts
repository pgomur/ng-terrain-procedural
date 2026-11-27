import * as THREE from 'three';

export interface ChunkGeometry {
  readonly position: THREE.BufferAttribute;
  readonly heightIndex: THREE.BufferAttribute;
  readonly index: THREE.BufferAttribute;
  readonly surfaceIndexCount: number;
  readonly skirtIndexCount: number;
}

export function createChunkGeometry(resolution: number, chunkSize: number): ChunkGeometry {
  const size = chunkSize;
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

  return {
    position: new THREE.BufferAttribute(positions, 3),
    heightIndex: new THREE.BufferAttribute(heightIndex, 1),
    index: new THREE.BufferAttribute(indices, 1),
    surfaceIndexCount: gridTriangles * 3,
    skirtIndexCount: skirtTriangles * 3,
  };
}
