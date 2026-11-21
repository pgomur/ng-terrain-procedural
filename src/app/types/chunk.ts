/**
 * Frustum plans for manual culling on CPU.
 * Avoid allocations of Three.js objects (Plane/Frustum) in the hot path.
 * Layout: 6 planes [left, right, top, bottom, near, far]
 */
export interface FrustumPlanes {
  readonly normals: readonly WorldPosition[];
  readonly constants: readonly number[];
}

/**
 * The origin (0,0) is the center of the world.
 */
export interface ChunkCoord {
  readonly x: number;
  readonly z: number;
  readonly lod: ChunkLOD;
}

/**
 * Available levels of detail
 * 0 = maximum resolution (close-up), 3 = minimum (far-out)
 */
export type ChunkLOD = 0 | 1 | 2 | 3;

/**
 * Chunk lifecycle states
 * WebGPU is asynchronous
 */
export type ChunkState =
  | 'generating' // Compute shader queued in command buffer
  | 'ready' // GPU finished, resources ready for rendering
  | 'unloading' // Marked for release
  | 'error'; // Failure (OOM, device lost, timeout)

/**
 * Immutable chunk metadata calculated when creating the coordinate
 */
export interface ChunkMeta {
  readonly coord: ChunkCoord;
  readonly worldOrigin: WorldPosition;
  readonly resolution: number;
}

/**
 * 3D position in world coordinates (float)
 */
export interface WorldPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Bounding volumes for culling and distance
 */
export interface ChunkBounds {
  readonly min: WorldPosition;
  readonly max: WorldPosition;
  readonly center: WorldPosition;
  readonly radius: number;
}

/**
 * GPU resources allocated to the chunk.
 * Optional because they don't exist during 'generating'
 */
export interface ChunkGPUResources {
  readonly pageId: number;
  readonly slot: number;
  readonly generation: number;
  readonly resolution: number;
}

/**
 * Performance, visibility, and synchronization metrics
 */
export interface ChunkMetrics {
  // Timing
  readonly createdAt: number;
  generationTime: number;
  lastAccessed: number;
}

/**
 * Full chunk entity
 * Mutable only in state, GPU, bounds, metrics (managed by ChunkManager)
 */
export interface Chunk {
  readonly meta: ChunkMeta;
  bounds: ChunkBounds;

  state: ChunkState;
  gpu: ChunkGPUResources | null;
  metrics: ChunkMetrics;

  heights?: Float32Array;

  failure?: ChunkFailure;
}

export interface ChunkFailure {
  readonly attempts: number;
  readonly retryAt: number;
}

// Streaming System Types

/**
 * Enriched generation request stored in the StreamingPriorityQueue.
 * Contains a pre-computed priority score that accounts for camera velocity
 * and predicted position, not just raw distance.
 */
export interface StreamingRequest {
  readonly key: ChunkKey;
  readonly coord: ChunkCoord;
  /** Lower score = higher priority. Updated by reprioritize(). */
  score: number;
  /** Raw world-space distance to camera at enqueue time. */
  readonly distanceAtEnqueue: number;
  /** Monotonic timestamp when this request was created. */
  readonly enqueuedAt: number;
  /** Number of generation attempts (for retry throttling). */
  attempts: number;
}

/**
 * Unique Hash for Maps/Sets: "x:z:lod"
 */
export type ChunkKey = `${number}:${number}:${ChunkLOD}`;
