/**
 * Pure functions on chunk coordinates: no state, no allocation beyond their results, no dependency on Three.js or the GPU. Everything here is covered by unit tests.
 *
 * | Group | Functions | Used by |
 * | --- | --- | --- |
 * | Keys | {@link getChunkKey}, {@link spatialKeyOf} | Every map and set of chunks. |
 * | Distances and levels of detail | {@link getChunkCenter}, {@link distanceToChunk}, {@link selectLODForDistance} | The wanted set of the {@link engine/chunk-manager!ChunkManager | ChunkManager}. |
 * | Bounds and culling | {@link analyticHeightRange}, {@link boundsFromHeights}, {@link intersectsFrustumAABB}, {@link isRenderableChunk} | Visibility. |
 * | Seams | {@link supportsSeamStitching}, {@link seamLodDiff}, {@link encodeSeamCode}, {@link stitchedHeight}, {@link skirtDepthFor} | The {@link engine/scene-graph!SceneGraph | SceneGraph} and collision. |
 *
 * Two of these functions have a twin on the GPU and must stay identical to it: {@link stitchedHeight} mirrors the stitching in {@link shaders/elevation.tsl!createTerrainPositionNode | createTerrainPositionNode}, so collision heights match the drawn surface, and the bits of {@link encodeSeamCode} are the ones that shader reads.
 *
 * See [Streaming and levels of detail](../../../guides/streaming.md) and [Rendering](../../../guides/rendering.md#seams-and-skirts).
 *
 * @module
 */
import type { Chunk, ChunkCoord, ChunkKey, ChunkLOD, WorldPosition, ChunkBounds, FrustumPlanes } from '../types/chunk';

/**
 * Builds the unique key of a chunk.
 *
 * @param coord - Grid position and level of detail.
 * @returns The key `"x:z:lod"`.
 *
 * @example
 * Returns `'3:-2:1'`:
 *
 * ```ts
 * getChunkKey({ x: 3, z: -2, lod: 1 });
 * ```
 */
export function getChunkKey(coord: ChunkCoord): ChunkKey {
  return `${coord.x}:${coord.z}:${coord.lod}`;
}

function getChunkOrigin(coord: ChunkCoord, chunkSize: number): WorldPosition {
  return {
    x: coord.x * chunkSize,
    y: 0,
    z: coord.z * chunkSize,
  };
}

/**
 * Returns the centre of a chunk's square at ground level.
 *
 * @param coord - Grid position of the chunk; the level of detail is ignored.
 * @param chunkSize - Side length of a chunk in world units.
 * @returns The centre in world units, with `y` set to `0`.
 *
 * @example
 * With chunks of 128 units, returns `{ x: 448, y: 0, z: -192 }`:
 * ```ts
 * getChunkCenter({ x: 3, z: -2, lod: 0 }, 128);
 * ```
 */
export function getChunkCenter(coord: ChunkCoord, chunkSize: number): WorldPosition {
  const origin = getChunkOrigin(coord, chunkSize);
  return {
    x: origin.x + chunkSize / 2,
    y: 0,
    z: origin.z + chunkSize / 2,
  };
}

/**
 * Chooses the level of detail for a chunk at a given distance from the camera.
 *
 * The thresholds are inclusive: a distance equal to `lodDistances[0]` still selects LOD 0.
 *
 * @param distance - Horizontal distance from the camera to the chunk's centre, in world units.
 * @param lodDistances - Upper distance of LOD 0, 1 and 2.
 * @returns The level of detail, `3` beyond the last threshold.
 *
 * @example
 * Returns `0`, `0`, `2` and `3`:
 *
 * ```ts
 * selectLODForDistance(450, [600, 1500, 3000]);
 * selectLODForDistance(600, [600, 1500, 3000]);
 * selectLODForDistance(2000, [600, 1500, 3000]);
 * selectLODForDistance(5000, [600, 1500, 3000]);
 * ```
 */
export function selectLODForDistance(distance: number, lodDistances: readonly [number, number, number]): ChunkLOD {
  if (distance <= lodDistances[0]) return 0;
  if (distance <= lodDistances[1]) return 1;
  if (distance <= lodDistances[2]) return 2;
  return 3;
}

/**
 * Horizontal (XZ) distance between the camera and a chunk's centre. Height is ignored.
 *
 * @param cameraPos - Camera position in world units.
 * @param chunkCenter - Chunk centre in world units.
 * @returns The distance in world units.
 *
 * Levels of detail depend on this distance only, so flying high over the terrain does not make it coarser.
 *
 * @example
 * Returns `500`:
 * ```ts
 * distanceToChunk({ x: 0, y: 900, z: 0 }, { x: 300, y: 0, z: 400 });
 * ```
 */
export function distanceToChunk(cameraPos: WorldPosition, chunkCenter: WorldPosition): number {
  const dx = cameraPos.x - chunkCenter.x;
  const dz = cameraPos.z - chunkCenter.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Tests whether a bounding box is at least partly inside a frustum.
 *
 * The test is conservative: a box may be reported as visible when it is just outside a corner of the frustum, but a visible box is never rejected.
 *
 * For each plane, only the corner of the box furthest along the plane's normal is tested (the "positive vertex"): if even that corner is outside, the whole box is. Six dot products per box, no square roots and no allocation, which is why it runs for every chunk whenever the view changes.
 *
 * @param bounds - Box to test, in world units.
 * @param planes - Frustum planes.
 * @param epsilon - Margin added to the box on every side, in world units, so that chunks touching the edge of the view are kept.
 * @returns `false` when the box lies entirely on the outer side of any plane.
 */
export function intersectsFrustumAABB(bounds: ChunkBounds, planes: FrustumPlanes, epsilon = 8.0): boolean {
  for (let i = 0; i < 6; i++) {
    const normal = planes.normals[i];
    const constant = planes.constants[i];

    const px = normal.x > 0 ? bounds.max.x + epsilon : bounds.min.x - epsilon;
    const py = normal.y > 0 ? bounds.max.y + epsilon : bounds.min.y - epsilon;
    const pz = normal.z > 0 ? bounds.max.z + epsilon : bounds.min.z - epsilon;

    const distance = normal.x * px + normal.y * py + normal.z * pz + constant;

    if (distance < 0) {
      return false;
    }
  }

  return true;
}

/**
 * Builds the key of a grid cell, shared by all levels of detail of that cell.
 *
 * @param coord - Grid position.
 * @returns The key `"x:z"`.
 *
 * @example
 * Returns `'3:-2'` for every level of detail of that cell:
 * ```ts
 * spatialKeyOf({ x: 3, z: -2, lod: 1 });
 * ```
 */
export function spatialKeyOf(coord: { readonly x: number; readonly z: number }): string {
  return `${coord.x}:${coord.z}`;
}

/**
 * Whether a chunk can be drawn: it holds an atlas slot and is either `ready` or `unloading`.
 *
 * @param chunk - Chunk to check.
 *
 * @returns `true` when the chunk can be drawn.
 */
export function isRenderableChunk(chunk: Chunk): boolean {
  return (chunk.state === 'ready' || chunk.state === 'unloading') && chunk.gpu !== null;
}

const ANALYTIC_HEIGHT_MARGIN = 0.1;

/**
 * A range of heights in world units.
 *
 * Returned by {@link analyticHeightRange}.
 */
export interface HeightRange {
  /** Lowest height. */
  readonly min: number;
  /** Highest height. */
  readonly max: number;
}

/**
 * Height range that any chunk can occupy, used as its bounds until the exact ones are read back from the GPU.
 *
 * The range covers `[offsetY, offsetY + heightScale]` plus a margin of 10 % of the scale on each side.
 *
 * @param heightScale - `TERRAIN_HEIGHT_SCALE`.
 * @param offsetY - `TERRAIN_OFFSET_Y`.
 * @returns The minimum and maximum height in world units.
 *
 * @example
 * With the default configuration, returns `{ min: -10, max: 110 }`:
 * ```ts
 * analyticHeightRange(100, 0);
 * ```
 */
export function analyticHeightRange(heightScale: number, offsetY: number): HeightRange {
  const margin = Math.abs(heightScale) * ANALYTIC_HEIGHT_MARGIN;
  return {
    min: offsetY + Math.min(0, heightScale) - margin,
    max: offsetY + Math.max(0, heightScale) + margin,
  };
}

/**
 * Builds a chunk's bounding box from its height range.
 *
 * @param coord - Grid position of the chunk.
 * @param chunkSize - Side length of a chunk in world units.
 * @param minHeight - Lowest height in the chunk.
 * @param maxHeight - Highest height in the chunk.
 * @returns The box covering the chunk's square between those heights.
 */
export function boundsFromHeights(
  coord: ChunkCoord,
  chunkSize: number,
  minHeight: number,
  maxHeight: number,
): ChunkBounds {
  const minX = coord.x * chunkSize;
  const minZ = coord.z * chunkSize;
  const maxX = minX + chunkSize;
  const maxZ = minZ + chunkSize;
  return {
    min: { x: minX, y: minHeight, z: minZ },
    max: { x: maxX, y: maxHeight, z: maxZ },
  };
}

/**
 * Whether a set of resolutions allows the edges between levels of detail to be stitched: the number of segments must halve at each level, as in `65, 33, 17, 9`.
 *
 * Stitching moves the edge vertices of a finer chunk onto the straight segments of its coarser neighbour, which only lines up when every coarse vertex is also a fine vertex. That holds when `(resolution[lod] − 1) × 2^lod` is the same for every level.
 *
 * @param resolutions - Vertices per side for each level of detail.
 *
 * @returns `true` when stitching can be enabled.
 *
 * @example
 * ```ts
 * supportsSeamStitching({ 0: 65, 1: 33, 2: 17, 3: 9 });
 * supportsSeamStitching({ 0: 64, 1: 32, 2: 16, 3: 8 });
 * ```
 * The first returns `true` (64, 32, 16 and 8 segments); the second returns `false` (63, 31, 15 and 7 segments).
 */
export function supportsSeamStitching(resolutions: Record<ChunkLOD, number>): boolean {
  const base = resolutions[0] - 1;
  if (base < 1) return false;
  for (let lod = 1; lod <= 3; lod++) {
    const segments = resolutions[lod as ChunkLOD] - 1;
    if (segments < 1 || segments * 2 ** lod !== base) return false;
  }
  return true;
}

/**
 * How many levels coarser a neighbour is, which determines how its shared edge is stitched.
 *
 * Only the finer side of an edge is stitched; the coarser side keeps its own vertices, so its difference is `0`. A missing neighbour also gives `0`, and the skirts hide that edge until the neighbour appears.
 *
 * @param ownLod - Level of detail of the chunk.
 * @param neighborLod - Level of detail of the neighbour on one side, or `null` when there is none.
 * @returns `0` when the neighbour is missing, equal or finer, otherwise the difference, clamped to `3`.
 *
 * @example
 * Returns `2`, `0` and `0`:
 * ```ts
 * seamLodDiff(0, 2);
 * seamLodDiff(2, 0);
 * seamLodDiff(1, null);
 * ```
 */
export function seamLodDiff(ownLod: ChunkLOD, neighborLod: ChunkLOD | null): number {
  if (neighborLod === null) return 0;
  return Math.max(0, Math.min(3, neighborLod - ownLod));
}

/**
 * Packs the LOD differences of the four neighbours into one number, two bits each.
 *
 * Bits 0–1 hold the neighbour on -X, bits 2–3 on +X, bits 4–5 on -Z and bits 6–7 on +Z.
 *
 * @param left - Difference with the neighbour on -X.
 * @param right - Difference with the neighbour on +X.
 * @param top - Difference with the neighbour on -Z.
 * @param bottom - Difference with the neighbour on +Z.
 * @returns The seam code read by the terrain vertex shader.
 *
 * @example
 * A chunk with a neighbour one level coarser on +X and two levels coarser on -Z; returns `0b00_10_01_00`, that is `36`:
 * ```ts
 * encodeSeamCode(0, 1, 2, 0);
 * ```
 */
export function encodeSeamCode(left: number, right: number, top: number, bottom: number): number {
  return (left & 3) | ((right & 3) << 2) | ((top & 3) << 4) | ((bottom & 3) << 6);
}

/**
 * Height of a grid vertex after seam stitching, exactly as the terrain vertex shader computes it.
 *
 * Edge vertices that do not exist in a coarser neighbour are interpolated between the neighbour's vertices, so both chunks share the same edge. Corners and inner vertices are returned unchanged.
 *
 * On a side with difference `d`, only every `2^d`-th vertex keeps its own height; each vertex in between is linearly interpolated between the two kept vertices around it.
 *
 * @param heights - Heights of the chunk, row by row along X.
 * @param resolution - Vertices per side.
 * @param ix - Vertex column.
 * @param iz - Vertex row.
 * @param seamCode - Code built with {@link encodeSeamCode}.
 * @returns The height in world units.
 *
 * @example
 * On a 5 × 5 grid whose -X neighbour is one level coarser (seam code `1`), vertex `(0, 1)` gets the average of vertices `(0, 0)` and `(0, 2)`:
 * ```ts
 * const h = stitchedHeight(heights, 5, 0, 1, encodeSeamCode(1, 0, 0, 0));
 * ```
 */
export function stitchedHeight(
  heights: ArrayLike<number>,
  resolution: number,
  ix: number,
  iz: number,
  seamCode: number,
): number {
  const last = resolution - 1;
  let h = heights[iz * resolution + ix];

  const stitch = (diff: number, t: number, toIndex: (i: number) => number) => {
    if (diff <= 0) return;
    const step = 1 << diff;
    const a = Math.floor(t / step) * step;
    const b = Math.min(a + step, last);
    const f = (t - a) / step;
    h = heights[toIndex(a)] + (heights[toIndex(b)] - heights[toIndex(a)]) * f;
  };

  if (ix === 0) stitch(seamCode & 3, iz, (i) => i * resolution);
  if (ix === last) stitch((seamCode >> 2) & 3, iz, (i) => i * resolution + last);
  if (iz === 0) stitch((seamCode >> 4) & 3, ix, (i) => i);
  if (iz === last) stitch((seamCode >> 6) & 3, ix, (i) => last * resolution + i);

  return h;
}

/**
 * Depth of the skirts hanging from chunk edges, which hide rasterisation pinholes between neighbours.
 *
 * @param heightScale - `TERRAIN_HEIGHT_SCALE`.
 * @returns 2 % of the height scale, at least one world unit.
 *
 * @example
 * Returns `2` for the default scale, and `1` for any scale up to 50:
 * ```ts
 * skirtDepthFor(100);
 * skirtDepthFor(20);
 * ```
 */
export function skirtDepthFor(heightScale: number): number {
  return Math.max(1, Math.abs(heightScale) * 0.02);
}
