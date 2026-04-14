import type {
  ChunkCoord,
  ChunkKey,
  ChunkLOD,
  WorldPosition,
  ChunkBounds,
  NeighborMask,
  FrustumPlanes
} from '../types/chunk';
import { NEIGHBOR_OFFSETS, NEIGHBOR_DIRECTIONS } from '../types/chunk';

/**
* Generates the unique string key for a chunk
 */
export function getChunkKey(coord: ChunkCoord): ChunkKey {
  return `${coord.x}:${coord.z}:${coord.lod}`;
}

/**
* Parse a chunk key to coordinates
 */
export function parseChunkKey(key: ChunkKey): ChunkCoord {
  const parts = key.split(':');
  if (parts.length !== 3) {
    throw new Error(`Invalid chunk key format: ${key}. Expected "x:z:lod"`);
  }

  const x = parseInt(parts[0], 10);
  const z = parseInt(parts[1], 10);
  const lod = parseInt(parts[2], 10) as ChunkLOD;

  if (isNaN(x) || isNaN(z) || isNaN(lod) || lod < 0 || lod > 3) {
    throw new Error(`Invalid chunk key values: ${key}`);
  }

  return { x, z, lod };
}

/**
 * Calculate the origin (bottom left corner) of a chunk in world coordinates
 */
export function getChunkOrigin(coord: ChunkCoord, chunkSize: number): WorldPosition {
  return {
    x: coord.x * chunkSize,
    y: 0,
    z: coord.z * chunkSize
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
    z: origin.z + chunkSize / 2
  };
}

/**
 * Converts a world position to a chunk coordinate
 */
export function worldToChunkCoord(
  pos: WorldPosition,
  chunkSize: number,
  lod: ChunkLOD
): ChunkCoord {
  const x = Math.floor(pos.x / chunkSize);
  const z = Math.floor(pos.z / chunkSize);

  return { x, z, lod };
}

/**
 * Determine the appropriate LOD for a chunk based on distance to camera
 */
export function selectLODForDistance(
  distance: number,
  lodDistances: readonly [number, number, number]
): ChunkLOD {
  if (distance <= lodDistances[0]) return 0;
  if (distance <= lodDistances[1]) return 1;
  if (distance <= lodDistances[2]) return 2;
  return 3;
}

/**
 * Calculate 2D Euclidean (XZ) distance from the camera to the center of the chunk
 */
export function distanceToChunk(
  cameraPos: WorldPosition,
  chunkCenter: WorldPosition
): number {
  const dx = cameraPos.x - chunkCenter.x;
  const dz = cameraPos.z - chunkCenter.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Full 3D distance, useful for height culling
 */
export function distance3DToChunk(
  cameraPos: WorldPosition,
  chunkCenter: WorldPosition,
  chunkHeight: number = 0
): number {
  const dx = cameraPos.x - chunkCenter.x;
  const dy = cameraPos.y - (chunkCenter.y + chunkHeight / 2);
  const dz = cameraPos.z - chunkCenter.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
* Calculates the neighbor mask for seam fitting (T-junction correction)
 */
export function calculateNeighborMask(
  coord: ChunkCoord,
  activeChunks: ReadonlyMap<ChunkKey, { meta: { lod: ChunkLOD } }>
): NeighborMask {
  let mask = 0;

  const directions = NEIGHBOR_DIRECTIONS;

  for (let i = 0; i < 4; i++) {
    const dir = directions[i];
    const offset = NEIGHBOR_OFFSETS[dir];

    const neighborCoord: ChunkCoord = {
      x: coord.x + offset.dx,
      z: coord.z + offset.dz,
      lod: coord.lod
    };

    const neighborKey = getChunkKey(neighborCoord);
    const neighbor = activeChunks.get(neighborKey);

    if (!neighbor) {
      mask |= (1 << i);
      continue;
    }

    if (neighbor.meta.lod > coord.lod) {
      mask |= (1 << i);
    }
  }

  return mask as NeighborMask;
}

/**
* Calculates the mask using only the LODs of the four neighbors
* Returns null if any neighbor is unavailable
 */
export function calculateNeighborMaskFast(
  currentLOD: ChunkLOD,
  neighborLODs: [number | null, number | null, number | null, number | null]
): NeighborMask | null {
  let mask = 0;

  for (let i = 0; i < 4; i++) {
    const neighborLOD = neighborLODs[i];

    if (neighborLOD === null) return null;

    if (neighborLOD > currentLOD) {
      mask |= (1 << i);
    }
  }

  return mask as NeighborMask;
}

/**
* For each frustum plane, calculate the signed distance
* from the center of the sphere to the plane. If < -radius, it is completely outside
 */
export function intersectsFrustum(
  bounds: ChunkBounds,
  planes: FrustumPlanes
): boolean {
  for (let i = 0; i < 6; i++) {
    const normal = planes.normals[i];
    const constant = planes.constants[i];

    const distance =
      normal.x * bounds.center.x +
      normal.y * bounds.center.y +
      normal.z * bounds.center.z +
      constant;

    if (distance < -bounds.radius) {
      return false;
    }
  }

  return true;
}

/**
 * More stringent test: AABB (Axis-Aligned Bounding Box) vs. Frustum
 * More accurate than a sphere but more expensive
 */
export function intersectsFrustumAABB(
  bounds: ChunkBounds,
  planes: FrustumPlanes
): boolean {
  // Para cada plano, test contra AABB
  for (let i = 0; i < 6; i++) {
    const normal = planes.normals[i];
    const constant = planes.constants[i];

    const px = normal.x > 0 ? bounds.max.x : bounds.min.x;
    const py = normal.y > 0 ? bounds.max.y : bounds.min.y;
    const pz = normal.z > 0 ? bounds.max.z : bounds.min.z;

    const distance = normal.x * px + normal.y * py + normal.z * pz + constant;

    if (distance < 0) {
      return false;
    }
  }

  return true;
}

/**
 * Generates the coordinates of all chunks visible from a given position
 * Returns a ChunkKey Set to prevent duplicates (shared corners)
 */
export function getVisibleChunkCoords(
  cameraPos: WorldPosition,
  lodDistances: readonly [number, number, number],
  chunkSize: number,
  maxChunks: number
): Set<ChunkKey> {
  const visible = new Set<ChunkKey>();

  const maxDistance = lodDistances[2] * 1.5;
  const chunksRadius = Math.ceil(maxDistance / chunkSize);

  const centerX = Math.floor(cameraPos.x / chunkSize);
  const centerZ = Math.floor(cameraPos.z / chunkSize);

  let x = 0;
  let z = 0;
  let dx = 0;
  let dz = -1;

  for (let i = 0; i < maxChunks * 2; i++) {
    if (-chunksRadius <= x && x <= chunksRadius &&
        -chunksRadius <= z && z <= chunksRadius) {

      const chunkX = centerX + x;
      const chunkZ = centerZ + z;

      // Calcular distancia para determinar LOD
      const origin = getChunkOrigin({ x: chunkX, z: chunkZ, lod: 0 }, chunkSize);
      const center = { ...origin, x: origin.x + chunkSize/2, z: origin.z + chunkSize/2 };
      const dist = distanceToChunk(cameraPos, center);
      const lod = selectLODForDistance(dist, lodDistances);

      const key = getChunkKey({ x: chunkX, z: chunkZ, lod });
      visible.add(key);

      if (visible.size >= maxChunks) break;
    }

    if (x === z || (x < 0 && x === -z) || (x > 0 && x === 1 - z)) {
      [dx, dz] = [-dz, dx];
    }
    x += dx;
    z += dz;
  }

  return visible;
}

/**
 * Calculate the vertex resolution for a given LOD level
 */
export function getResolutionForLOD(
  lod: ChunkLOD,
  resolutions: Record<ChunkLOD, number>
): number {
  return resolutions[lod];
}

/**
 * Calculates the number of indices in a chunk's mesh based on its resolution
 * Grid of (res-1) x (res-1) quads, 2 triangles per quad, 3 indices per triangle
 */
export function getIndexCountForResolution(resolution: number): number {
  return (resolution - 1) * (resolution - 1) * 6;
}

/**
 * Calculate how many vertices the mesh has
 */
export function getVertexCountForResolution(resolution: number): number {
  return resolution * resolution;
}