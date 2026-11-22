import type { Chunk, ChunkCoord, ChunkKey, ChunkLOD, WorldPosition, ChunkBounds, FrustumPlanes } from '../types/chunk';

/**
 * Generates the unique string key for a chunk
 */
export function getChunkKey(coord: ChunkCoord): ChunkKey {
  return `${coord.x}:${coord.z}:${coord.lod}`;
}

/**
 * Calculate the origin (bottom left corner) of a chunk in world coordinates
 */
export function getChunkOrigin(coord: ChunkCoord, chunkSize: number): WorldPosition {
  return {
    x: coord.x * chunkSize,
    y: 0,
    z: coord.z * chunkSize,
  };
}

/**
 * Gets the center of a chunk in world coordinates
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
 * Determine the appropriate LOD for a chunk based on distance to camera
 */
export function selectLODForDistance(distance: number, lodDistances: readonly [number, number, number]): ChunkLOD {
  if (distance <= lodDistances[0]) return 0;
  if (distance <= lodDistances[1]) return 1;
  if (distance <= lodDistances[2]) return 2;
  return 3;
}

/**
 * Calculate 2D Euclidean (XZ) distance from the camera to the center of the chunk
 */
export function distanceToChunk(cameraPos: WorldPosition, chunkCenter: WorldPosition): number {
  const dx = cameraPos.x - chunkCenter.x;
  const dz = cameraPos.z - chunkCenter.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * More stringent test: AABB (Axis-Aligned Bounding Box) vs. Frustum
 * More accurate than a sphere but more expensive
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

export function spatialKeyOf(coord: { readonly x: number; readonly z: number }): string {
  return `${coord.x}:${coord.z}`;
}

export function isRenderableChunk(chunk: Chunk): boolean {
  return (chunk.state === 'ready' || chunk.state === 'unloading') && chunk.gpu !== null;
}

export const ANALYTIC_HEIGHT_MARGIN = 0.1;

export function analyticHeightRange(
  heightScale: number,
  offsetY: number,
): { readonly min: number; readonly max: number } {
  const margin = Math.abs(heightScale) * ANALYTIC_HEIGHT_MARGIN;
  return {
    min: offsetY + Math.min(0, heightScale) - margin,
    max: offsetY + Math.max(0, heightScale) + margin,
  };
}

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
  const center = {
    x: (minX + maxX) / 2,
    y: (minHeight + maxHeight) / 2,
    z: (minZ + maxZ) / 2,
  };
  const hx = chunkSize / 2;
  const hy = (maxHeight - minHeight) / 2;

  return {
    min: { x: minX, y: minHeight, z: minZ },
    max: { x: maxX, y: maxHeight, z: maxZ },
    center,
    radius: Math.sqrt(hx * hx * 2 + hy * hy),
  };
}

export function supportsSeamStitching(resolutions: Record<ChunkLOD, number>): boolean {
  const base = resolutions[0] - 1;
  if (base < 1) return false;
  for (let lod = 1; lod <= 3; lod++) {
    const segments = resolutions[lod as ChunkLOD] - 1;
    if (segments < 1 || segments * 2 ** lod !== base) return false;
  }
  return true;
}

export function seamLodDiff(ownLod: ChunkLOD, neighborLod: ChunkLOD | null): number {
  if (neighborLod === null) return 0;
  return Math.max(0, Math.min(3, neighborLod - ownLod));
}

export function encodeSeamCode(left: number, right: number, top: number, bottom: number): number {
  return (left & 3) | ((right & 3) << 2) | ((top & 3) << 4) | ((bottom & 3) << 6);
}

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

export function skirtDepthFor(heightScale: number): number {
  return Math.max(1, Math.abs(heightScale) * 0.02);
}
