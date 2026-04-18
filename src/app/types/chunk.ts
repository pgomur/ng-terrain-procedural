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
  | 'pending' // Queued for generation
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
  readonly size: number;
  readonly resolution: number;
  readonly seed: number;
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
 * Neighbor mask for seam fitting (T-junctions)
 * Each bit indicates whether the neighbor in that direction has a lower LOD
 */
export type NeighborMask = number;

/**
 * Visibility flags to optimize culling
 */
export interface ChunkVisibility {
  readonly inFrustum: boolean;
  readonly wasVisible: boolean;
  readonly occlusionIndex: number;
}

/**
 * CPU-GPU synchronization.
 */
export interface ChunkGPUSync {
  readonly submissionId: number;
  readonly fenceValue: number;
}

/**
 * GPU resources allocated to the chunk.
 * Optional because they don't exist during 'pending'/'generating'
 * NOTE: I use 'unknown' to avoid dependency on @webgpu/types
 * in this layer. The engine/gpu-generator.ts handles the casting to WebGPU types
 */
export interface ChunkGPUResources {
  readonly positionBuffer: unknown;
  readonly normalBuffer: unknown;
  readonly indexBuffer: unknown;
  readonly uniformBuffer: unknown;
  readonly bindGroup: unknown;
  readonly indexCount: number;
  readonly vertexCount: number;
}

/**
 * Performance, visibility, and synchronization metrics
 */
export interface ChunkMetrics {
  // Timing
  readonly createdAt: number;
  readonly generationTime: number;
  readonly lastAccessed: number;
  readonly frameCount: number;

  // Distance and priority
  readonly distanceToCamera: number;
  readonly priorityScore: number;

  // Visibility
  readonly visibility: ChunkVisibility;

  // GPU synchronization
  readonly sync: ChunkGPUSync | null;

  // Seam fitting
  readonly neighborMask: NeighborMask;
  readonly lastNeighborUpdate: number;
}

/**
 * Full chunk entity
 * Mutable only in state, GPU, mesh, metrics (managed by ChunkManager)
 */
export interface Chunk {
  readonly meta: ChunkMeta;
  readonly bounds: ChunkBounds;

  state: ChunkState;
  gpu: ChunkGPUResources | null;
  metrics: ChunkMetrics;

  mesh: unknown | null;

  geometryData?: ChunkGeometryData;
}

/**
 * Global state of the chunk system
 * Immutable for Signals
 */
export interface ChunkSystemState {
  readonly activeChunks: ReadonlyMap<ChunkKey, Chunk>;
  readonly visibleKeys: ReadonlySet<ChunkKey>;
  readonly generatingKeys: ReadonlySet<ChunkKey>;
  readonly cameraChunk: ChunkCoord | null;
  readonly submissionCounter: number;

  readonly stats: {
    readonly totalVRAM: number;
    readonly visibleCount: number;
    readonly pendingCount: number;
    readonly generatingCount: number;
    readonly readyCount: number;
    readonly fps: number;
    readonly gpuWaitTime: number;
    // Streaming buffer metrics
    readonly streamingBufferUsage: number; // ringSize / capacity [0..1]
    readonly anticipationScore: number; // avg predicted gain from velocity
    readonly concurrencySlots: number; // active GPU generation promises
  };
}

// Streaming System Types

/**
 * Enriched generation request stored in the AnticipationRingBuffer.
 * Contains a pre-computed priority score that accounts for camera velocity
 * and predicted position, not just raw distance.
 */
export interface StreamingRequest {
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
 * Active slot in the ConcurrencyPool.
 * Tracks an in-flight GPU generation promise with a timeout guard.
 */
export interface ConcurrencySlot {
  /** Resolves when generateChunk() completes (success or error). */
  readonly promise: Promise<void>;
  /** performance.now() stamp when the slot was reserved. */
  readonly startedAt: number;
  /** Whether the underlying async work has settled (set by the closure). */
  settled: boolean;
}

/**
 * Streaming subsystem metrics exported per-frame.
 * Available on ChunkSystemState.stats for external monitoring.
 */
export interface StreamingStats {
  /** Ring buffer fill ratio [0..1]: ringSize / capacity. */
  readonly bufferUsage: number;
  /** Number of concurrency pool slots currently occupied. */
  readonly activeSlots: number;
  /** Smoothed camera speed in world-units per second. */
  readonly cameraSpeed: number;
  /** Weighted average anticipation gain for queued requests. */
  readonly avgAnticipationGain: number;
}

/**
 * System configuration (injected)
 */
export interface TerrainConfig {
  readonly CHUNK_SIZE: 64 | 128 | 256;
  readonly MAX_CHUNKS: number;
  readonly LOD_DISTANCES: [number, number, number];
  readonly GENERATION_BUDGET: number;
  readonly UNLOAD_DELAY: number;
  readonly OCCLUSION_QUERY_ENABLED: boolean;
  readonly SEAM_FITTING_ENABLED: boolean;
}

/**
 * Unique Hash for Maps/Sets: "x:z:lod"
 */
export type ChunkKey = `${number}:${number}:${ChunkLOD}`;

/**
 * Raw data from the compute shader.
 * We use Structure of Arrays (SoA) instead of interleaved (AoS)
 */
export interface ChunkGeometryData {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint16Array;
  readonly bounds: {
    readonly minHeight: number;
    readonly maxHeight: number;
  };
}

/**
 * Cardinal directions for neighbors
 */
export const NEIGHBOR_DIRECTIONS = ['top', 'right', 'bottom', 'left'] as const;
export type NeighborDirection = (typeof NEIGHBOR_DIRECTIONS)[number];

/**
 * Coordinate offsets for each direction
 */
export const NEIGHBOR_OFFSETS: Record<NeighborDirection, { dx: number; dz: number }> = {
  top: { dx: 0, dz: -1 },
  right: { dx: 1, dz: 0 },
  bottom: { dx: 0, dz: 1 },
  left: { dx: -1, dz: 0 },
};
