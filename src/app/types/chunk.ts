/**
 * The data model of the terrain: how chunks are identified, where they are, what state they are in and where their heights live on the GPU.
 *
 * The terrain is an infinite grid of square chunks, `CHUNK_SIZE` world units on a side. Each grid cell can exist at up to four levels of detail at once, each one a separate {@link Chunk} with its own {@link ChunkKey}:
 *
 * ```text
 * ChunkCoord { x: 3, z: -2, lod: 1 }
 *    ├─ ChunkKey    "3:-2:1"    one version of the cell
 *    └─ spatialKey  "3:-2"      the cell, shared by all its versions
 * ```
 *
 * | Type | Describes |
 * | --- | --- |
 * | {@link ChunkCoord}, {@link ChunkLOD}, {@link ChunkKey} | Identity: grid cell and level of detail. |
 * | {@link Chunk}, {@link ChunkMeta}, {@link ChunkState}, {@link ChunkMetrics}, {@link ChunkFailure} | A chunk as held by the {@link engine/chunk-manager!ChunkManager | ChunkManager}, and its lifecycle. |
 * | {@link ChunkGPUResources} | The chunk's slot in the GPU height atlas. |
 * | {@link ChunkBounds}, {@link WorldPosition}, {@link FrustumPlanes} | Geometry used for culling. |
 * | {@link StreamingRequest} | A chunk waiting to be generated. |
 *
 * The functions that work on these types are in {@link math/chunk-coord! | math/chunk-coord}. See [Streaming and levels of detail](../../../guides/streaming.md#chunk-lifecycle).
 *
 * @module
 */
/**
 * The six planes of a view frustum in a form that can be tested without allocating Three.js objects.
 *
 * A point `p` is on the inner side of plane `i` when `dot(normals[i], p) + constants[i] >= 0`.
 *
 * The engine fills it from the camera's projection and view matrices whenever the view changes, reusing the same arrays, and passes it to {@link engine/chunk-manager!ChunkManager.update | ChunkManager.update}. {@link math/chunk-coord!intersectsFrustumAABB | intersectsFrustumAABB} tests boxes against it.
 */
export interface FrustumPlanes {
  /**
   * Unit normals of the six planes, pointing into the frustum.
   */
  readonly normals: readonly WorldPosition[];
  /**
   * Plane constants matching {@link FrustumPlanes.normals}, in world units.
   */
  readonly constants: readonly number[];
}

/**
 * Grid position and level of detail of a chunk.
 *
 * Chunk `(x, z)` covers the world square from `(x, z) * CHUNK_SIZE` to `(x + 1, z + 1) * CHUNK_SIZE`.
 *
 * With the default `CHUNK_SIZE` of 128, chunk `(0, 0)` covers `[0, 128) × [0, 128)` and chunk `(-1, 2)` covers `[-128, 0) × [256, 384)`. The level of detail does not change the area covered, only the number of vertices.
 *
 * @example
 * The chunk under a world position:
 * ```ts
 * const coord: ChunkCoord = {
 *   x: Math.floor(worldX / config.CHUNK_SIZE),
 *   z: Math.floor(worldZ / config.CHUNK_SIZE),
 *   lod: 0,
 * };
 * ```
 */
export interface ChunkCoord {
  /**
   * Grid column along the world X axis.
   */
  readonly x: number;
  /**
   * Grid row along the world Z axis.
   */
  readonly z: number;
  /**
   * Level of detail.
   */
  readonly lod: ChunkLOD;
}

/**
 * Level of detail of a chunk, from `0` (finest, closest to the camera) to `3` (coarsest).
 *
 * | LOD | Default distance to the chunk centre | Default vertices per side |
 * | --- | --- | --- |
 * | `0` | up to 600 | 65 |
 * | `1` | up to 1,500 | 33 |
 * | `2` | up to 3,000 | 17 |
 * | `3` | beyond, up to 3,600 | 9 |
 *
 * The distances come from `LOD_DISTANCES` and the resolutions from `CHUNK_RESOLUTIONS`. {@link math/chunk-coord!selectLODForDistance | selectLODForDistance} picks the level for a distance.
 */
export type ChunkLOD = 0 | 1 | 2 | 3;

/**
 * Lifecycle state of a chunk.
 *
 * - `generating`: created, its heights not yet requested from the GPU.
 * - `ready`: its heights are generated, or queued for generation in this frame, and it can be drawn.
 * - `unloading`: no longer wanted; it stays drawable until it is released after `UNLOAD_DELAY_MS`.
 * - `error`: generation failed; it is retried with exponential backoff while it is still wanted.
 *
 * ```text
 * generating ──► ready ──► unloading ──► released
 *     │            ▲           │
 *     ▼            └───────────┘ wanted again
 *   error ──► retried while wanted
 * ```
 *
 * A chunk released after `unloading` or `error` is removed from the manager and its atlas slot is freed; it has no state of its own. When more than `MAX_CHUNKS` chunks are held, `unloading` chunks are released without waiting for the delay. See [Streaming and levels of detail](../../../guides/streaming.md#chunk-lifecycle).
 */
export type ChunkState = 'generating' | 'ready' | 'unloading' | 'error';

/**
 * Properties of a chunk that never change after it is created.
 *
 * Created by the {@link engine/chunk-manager!ChunkManager | ChunkManager} together with the chunk and shared, never copied.
 */
export interface ChunkMeta {
  /**
   * Grid position and level of detail.
   */
  readonly coord: ChunkCoord;
  /**
   * Key of the grid cell regardless of level of detail, `"x:z"`. Versions of the same cell at different LODs share it.
   */
  readonly spatialKey: string;
  /**
   * Vertices per side of the chunk's height grid, taken from `CHUNK_RESOLUTIONS` for its LOD.
   */
  readonly resolution: number;
}

/**
 * A position in world units. Y is up.
 *
 * Structurally compatible with a Three.js `Vector3`, so a camera position can be passed where a `WorldPosition` is expected.
 */
export interface WorldPosition {
  /**
   * X coordinate.
   */
  readonly x: number;
  /**
   * Y coordinate, the height.
   */
  readonly y: number;
  /**
   * Z coordinate.
   */
  readonly z: number;
}

/**
 * Axis-aligned bounding box of a chunk in world units.
 *
 * In X and Z the box is exactly the chunk's square. In Y it is either the analytic range of the terrain, before the GPU has reported the chunk's heights, or its exact minimum and maximum after. See {@link math/chunk-coord!boundsFromHeights | boundsFromHeights} and {@link math/chunk-coord!analyticHeightRange | analyticHeightRange}.
 */
export interface ChunkBounds {
  /**
   * Corner with the smallest coordinates.
   */
  readonly min: WorldPosition;
  /**
   * Corner with the largest coordinates.
   */
  readonly max: WorldPosition;
}

/**
 * Location of a chunk's heights in the GPU height atlas.
 *
 * Returned by {@link engine/gpu-generator!GPUGenerator.generate | GPUGenerator.generate} and given back to {@link engine/gpu-generator!GPUGenerator.release | GPUGenerator.release}. The chunk's heights start at element `slot × resolution²` of the page's height buffer, row by row along X. The scene graph uses `pageId` to pick the instanced mesh and `slot` as the per-instance index into the heights. See [GPU height generation](../../../guides/gpu-generation.md#the-height-atlas).
 */
export interface ChunkGPUResources {
  /**
   * Index of the atlas page that holds the heights.
   */
  readonly pageId: number;
  /**
   * Slot of the chunk inside its page.
   */
  readonly slot: number;
  /**
   * Generation counter of the slot when it was assigned. Read-backs that arrive after the slot has been reused carry an older generation and are ignored.
   */
  readonly generation: number;
  /**
   * Vertices per side of the page, which is the chunk's resolution.
   */
  readonly resolution: number;
}

/**
 * Mutable bookkeeping used by the streaming logic.
 */
export interface ChunkMetrics {
  /**
   * `performance.now()` timestamp of the last time the chunk was wanted, or kept on screen while its replacement loads. Drives the unload delay and the eviction order.
   */
  lastAccessed: number;
}

/**
 * A square piece of terrain at one level of detail, owned by the {@link engine/chunk-manager!ChunkManager | ChunkManager}.
 *
 * A chunk is a record, not a class: the {@link engine/chunk-manager!ChunkManager | ChunkManager} creates it, changes its state and releases it, and the other modules only read it. It holds no heights of its own, only a handle to its slot in the atlas, except for the chunks near the camera whose heights are copied back for collision.
 */
export interface Chunk {
  /**
   * Immutable identity of the chunk.
   */
  readonly meta: ChunkMeta;
  /**
   * Bounds used for frustum culling. They start from the analytic height range and become exact once the GPU reports the chunk's minimum and maximum height.
   */
  bounds: ChunkBounds;

  /**
   * Current lifecycle state.
   */
  state: ChunkState;
  /**
   * Where the heights live on the GPU, or `null` when no atlas slot is held.
   */
  gpu: ChunkGPUResources | null;
  /**
   * Streaming bookkeeping.
   */
  metrics: ChunkMetrics;

  /**
   * CPU copy of the heights, row by row along X, used for collision. Present once the chunk has been among the 3 × 3 chunks around the camera, until it is released.
   */
  heights?: Float32Array;

  /**
   * Details of the last failed generation, set while the chunk is in the `error` state.
   */
  failure?: ChunkFailure;
}

/**
 * Retry information for a chunk whose generation failed.
 */
export interface ChunkFailure {
  /**
   * Number of failed attempts so far.
   */
  readonly attempts: number;
  /**
   * `performance.now()` timestamp after which the chunk may be requested again.
   */
  readonly retryAt: number;
}

/**
 * A chunk waiting in the {@link engine/streaming-queue!StreamingPriorityQueue | StreamingPriorityQueue} to be generated.
 *
 * Created by the {@link engine/chunk-manager!ChunkManager | ChunkManager} for each wanted chunk that does not exist yet. The score is set when the request is queued and recomputed every frame while the queue is not empty.
 */
export interface StreamingRequest {
  /**
   * Key of the requested chunk.
   */
  readonly key: ChunkKey;
  /**
   * Grid position and level of detail of the requested chunk.
   */
  readonly coord: ChunkCoord;
  /**
   * Priority in world units; lower is generated first. See {@link engine/streaming-queue!StreamingPriorityQueue.reprioritize | StreamingPriorityQueue.reprioritize}.
   */
  score: number;
  /**
   * Failed generation attempts carried over from earlier requests for the same chunk.
   */
  attempts: number;
}

/**
 * Unique key of a chunk, `"x:z:lod"`.
 *
 * The template type makes keys checked by the compiler: `"3:-2:1"` is a valid key, `"3:-2"` and `"3:-2:4"` are not. Build keys with {@link math/chunk-coord!getChunkKey | getChunkKey}.
 */
export type ChunkKey = `${number}:${number}:${ChunkLOD}`;
