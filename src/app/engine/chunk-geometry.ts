/**
 * The shared vertex grid of a chunk.
 *
 * A chunk's mesh never changes: only its heights do, and those live in the GPU atlas. So every chunk of a resolution reuses one grid, built once by {@link createChunkGeometry}:
 *
 * ```text
 *  surface: resolution × resolution vertices, flat at y = 0, two triangles per cell
 *  skirts:  one strip of resolution vertices below each edge, marked with y = −1
 * ```
 *
 * The terrain vertex shader takes each vertex's height from the chunk's slot through the `heightIndex` attribute, and lowers the skirt vertices by the skirt depth. With the default resolutions:
 *
 * | Resolution | Vertices (surface + skirts) | Triangles (surface + skirts) |
 * | --- | --- | --- |
 * | 65 | 4,225 + 260 | 8,192 + 512 |
 * | 33 | 1,089 + 132 | 2,048 + 256 |
 * | 17 | 289 + 68 | 512 + 128 |
 * | 9 | 81 + 36 | 128 + 64 |
 *
 * See [Rendering](../../../guides/rendering.md#seams-and-skirts).
 *
 * @module
 */
import * as THREE from 'three';

/**
 * Vertex data shared by every chunk of one resolution. Heights are not stored here: the vertex shader reads them from the atlas.
 */
export interface ChunkGeometry {
  /**
   * Grid positions within the chunk's square, from `0` to `chunkSize` on X and Z. Y is `0` for surface vertices and `-1` for skirt vertices, which marks them to be lowered by the skirt depth.
   */
  readonly position: THREE.BufferAttribute;
  /**
   * Index of the height each vertex takes from its chunk's slot. A skirt vertex uses the height of the edge vertex above it.
   */
  readonly heightIndex: THREE.BufferAttribute;
  /**
   * Triangle indices: the surface first, then the four skirts. All triangles face outwards.
   */
  readonly index: THREE.BufferAttribute;
  /**
   * Number of indices of the surface, at the start of {@link ChunkGeometry.index}.
   */
  readonly surfaceIndexCount: number;
  /**
   * Number of indices of the skirts, after the surface.
   */
  readonly skirtIndexCount: number;
}

/**
 * Builds the shared grid of a chunk with one skirt hanging from each edge.
 *
 * @param resolution - Vertices per side, from 2 to 254, so that the indices of the grid and its skirts fit in 16 bits.
 * @param chunkSize - Side length of a chunk in world units.
 * @returns The vertex and index data.
 *
 * @example
 * ```ts
 * const grid = createChunkGeometry(65, 128);
 * grid.surfaceIndexCount;
 * grid.skirtIndexCount;
 * ```
 * `surfaceIndexCount` is `24576` (8,192 triangles) and `skirtIndexCount` is `1536` (512 triangles).
 */
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
