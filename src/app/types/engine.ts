/**
 * Types exposed by the engine to the rest of the application.
 *
 * | Type | Used for |
 * | --- | --- |
 * | {@link EngineInitState} | The life cycle of the engine, from `uninitialized` to `ready`, `failed` or `lost`. Exposed as {@link engine/terrain-engine!TerrainEngine.initState | TerrainEngine.initState}. |
 * | {@link LoadingStage} | The step shown by the loading screen. Exposed as {@link engine/terrain-engine!TerrainEngine.loadingStage | TerrainEngine.loadingStage}. |
 * | {@link FrameCallback} | The per-frame hook used to drive the camera, set with {@link engine/terrain-engine!TerrainEngine.setFrameCallback | TerrainEngine.setFrameCallback}. |
 * | {@link TerrainEngineStats} | The diagnostics snapshot, published as {@link engine/terrain-engine!TerrainEngine.stats | TerrainEngine.stats} and shown in the diagnostics panel. |
 *
 * All of them are plain types with no runtime code. See [Embedding the terrain](../../../guides/embedding.md#reading-the-engine) and [Diagnostics panel](../../../guides/diagnostics.md).
 *
 * @module
 */
/**
 * Initialisation state of the {@link engine/terrain-engine!TerrainEngine | TerrainEngine}.
 *
 * - `uninitialized`: not started, or disposed.
 * - `initializing`: requesting the WebGPU device and building the scene.
 * - `ready`: initialised; the frame loop can run.
 * - `failed`: WebGPU is not available or initialisation threw.
 * - `lost`: the GPU device was lost while running; the page has to be reloaded.
 *
 * ```text
 * uninitialized ──init()──► initializing ──► ready ──device lost──► lost
 *                                │
 *                                └──────────► failed
 * ```
 *
 * `dispose()` returns the engine to `uninitialized` from any state. Only `ready` runs the frame loop; `failed` and `lost` are final until the page is reloaded.
 */
export type EngineInitState = 'uninitialized' | 'initializing' | 'ready' | 'failed' | 'lost';

/**
 * Diagnostics published by the {@link engine/terrain-engine!TerrainEngine | TerrainEngine} four times per second and shown in the diagnostics panel. Rates and averages cover the last window of at least 250 ms.
 *
 * The values follow the sections of the panel: frame timing (`fps` to `chunkUpdateMs`), rendering (`drawCalls` to `pixelRatio`), streaming (`visibleChunks` to `failedChunks`), GPU memory (`atlasBytes` to `terrainBufferBytes`) and the camera (`cameraX` to `chunkZ`). Each snapshot is a new object, so it can be kept and compared with later ones.
 *
 * See [Diagnostics panel](../../../guides/diagnostics.md) for how to read the values.
 *
 * @example
 * Logging a warning when frames get slow:
 * ```ts
 * effect(() => {
 *   const stats = engine.stats();
 *   if (stats && stats.maxFrameMs > 50) {
 *     console.warn(`Stutter: ${stats.maxFrameMs.toFixed(0)} ms, ${stats.pendingChunks} chunks queued`);
 *   }
 * });
 * ```
 */
export interface TerrainEngineStats {
  /**
   * Frames per second over the window.
   *
   * Counted as frames rendered divided by the length of the window.
   */
  readonly fps: number;
  /**
   * Average time between frames, in milliseconds.
   *
   * The inverse of {@link TerrainEngineStats.fps}: `1000 / fps`. At 60 fps it is about 16.7 ms.
   */
  readonly frameMs: number;
  /**
   * Longest time between two frames in the window, in milliseconds.
   *
   * A high value with a normal {@link TerrainEngineStats.frameMs} means a single stutter, such as a pipeline compilation or a garbage collection.
   */
  readonly maxFrameMs: number;
  /**
   * Average CPU time per frame spent on input, streaming and render submission, in milliseconds.
   *
   * Measured with `performance.now()` around the work of the frame callback. It does not include the time the GPU spends executing the frame, so a low value with a low {@link TerrainEngineStats.fps} means the GPU is the bottleneck.
   */
  readonly cpuFrameMs: number;
  /**
   * Average CPU time per frame spent on streaming and scene updates, in milliseconds. Part of {@link TerrainEngineStats.cpuFrameMs}.
   *
   * Covers {@link engine/chunk-manager!ChunkManager.update | ChunkManager.update}, which also submits the compute dispatches, and {@link engine/scene-graph!SceneGraph.sync | SceneGraph.sync}.
   */
  readonly chunkUpdateMs: number;
  /**
   * Draw calls issued in the last frame, shadow pass included.
   *
   * Read from the renderer's own counters. It depends on the number of atlas pages with instances in view, not on the number of chunks; between 9 and 12 in typical views with the defaults.
   */
  readonly drawCalls: number;
  /**
   * Triangles submitted in the last frame, shadow pass included.
   *
   * Includes the skirts, and the triangles of every chunk drawn into the shadow map.
   */
  readonly triangles: number;
  /**
   * Width of the drawing buffer in device pixels.
   *
   * The canvas width in CSS pixels times {@link TerrainEngineStats.pixelRatio}.
   */
  readonly renderWidth: number;
  /**
   * Height of the drawing buffer in device pixels.
   */
  readonly renderHeight: number;
  /**
   * Device pixel ratio used for rendering, capped at 2.
   */
  readonly pixelRatio: number;
  /**
   * Chunks inside the camera frustum.
   *
   * While a cell changes level of detail, both of its versions can be counted, though only one is drawn.
   */
  readonly visibleChunks: number;
  /**
   * Visible chunks per level of detail, indexed by LOD.
   *
   * Always four entries; their sum is {@link TerrainEngineStats.visibleChunks}.
   */
  readonly visibleByLod: readonly number[];
  /**
   * Chunks in the `ready` state.
   *
   * With the defaults it settles around 2,485 once the area around the camera is complete.
   */
  readonly readyChunks: number;
  /**
   * Chunks in the `unloading` state, still drawable.
   */
  readonly unloadingChunks: number;
  /**
   * Chunks generated per second over the window.
   *
   * At most `GENERATION_BUDGET` per frame, so with the default budget of 16 at 60 fps the ceiling is 960 per second.
   */
  readonly generatedPerSecond: number;
  /**
   * Requests waiting in the generation queue.
   */
  readonly pendingChunks: number;
  /**
   * Fill level of the generation queue, from 0 to 1.
   *
   * {@link TerrainEngineStats.pendingChunks} divided by `GENERATION_QUEUE_CAPACITY`.
   */
  readonly queueUsage: number;
  /**
   * Chunks in the `error` state, waiting to be retried.
   *
   * Each failure is logged to the console with the chunk key and the attempt number.
   */
  readonly failedChunks: number;
  /**
   * Size of the GPU buffers of the height atlas, in bytes.
   *
   * Heights, bounds and job buffers of every atlas page. About 6.5 MB of heights with the defaults; it only grows when a page fills up.
   */
  readonly atlasBytes: number;
  /**
   * Size of the pooled GPU buffers used for read-backs, in bytes.
   *
   * Only the buffers waiting in the pool are counted, not those in use by a read-back in flight.
   */
  readonly stagingBytes: number;
  /**
   * Size of the GPU buffers of the terrain meshes, in bytes: shared grids, per-instance data and instance matrices.
   *
   * Only buffers already uploaded to the GPU are counted.
   */
  readonly geometryBytes: number;
  /**
   * Sum of the atlas, read-back and geometry buffers, in bytes.
   */
  readonly terrainBufferBytes: number;
  /**
   * Camera position along X, in world units.
   */
  readonly cameraX: number;
  /**
   * Camera height, in world units.
   */
  readonly cameraY: number;
  /**
   * Camera position along Z, in world units.
   */
  readonly cameraZ: number;
  /**
   * Camera height above the terrain below it, or `null` until those heights have been read back.
   *
   * The heights of the 3 × 3 chunks around the camera are copied back from the GPU when the camera enters a new chunk, so the value appears a few frames after the camera reaches new terrain.
   */
  readonly heightAboveGround: number | null;
  /**
   * Compass heading of the view in degrees, `0` towards -Z and increasing clockwise.
   *
   * Between `0` and `360`: `90` is +X (east), `180` is +Z (south), `270` is -X (west).
   */
  readonly headingDeg: number;
  /**
   * View pitch in degrees, positive when looking up.
   *
   * Between `-90` and `90`.
   */
  readonly pitchDeg: number;
  /**
   * Camera speed along its path, in world units per second.
   *
   * Distance travelled during the window divided by its length, so it includes vertical movement and is `0` while the camera is still.
   */
  readonly cameraSpeed: number;
  /**
   * Grid column of the chunk under the camera.
   *
   * `floor(cameraX / CHUNK_SIZE)`.
   */
  readonly chunkX: number;
  /**
   * Grid row of the chunk under the camera.
   *
   * `floor(cameraZ / CHUNK_SIZE)`.
   */
  readonly chunkZ: number;
  /**
   * World seed in use.
   */
  readonly seed: number;
}

/**
 * Called once per frame before the engine updates and renders, with the time since the previous frame in seconds.
 *
 * The engine calls it before streaming, so a camera moved here is used for the chunks and the culling of the same frame. `deltaSeconds` is `0` on the first frame after {@link engine/terrain-engine!TerrainEngine.start | start} and never more than `0.1`, so a tab that was in the background does not move the camera in one large jump.
 *
 * @example
 * ```ts
 * engine.setFrameCallback((delta) => {
 *   position.z -= 30 * delta;
 *   engine.setCameraPosition(position.x, position.y, position.z);
 * });
 * ```
 */
export type FrameCallback = (deltaSeconds: number) => void;

/**
 * Stage shown by the loading screen.
 *
 * - `device`: requesting the WebGPU device.
 * - `shaders`: building the scene and compiling pipelines.
 * - `terrain`: generating the chunks near the camera.
 * - `done`: the terrain around the camera is ready, or the loading timeout elapsed.
 *
 * ```text
 * device ──► shaders ──► terrain ──► done
 * ```
 *
 * During `terrain`, {@link engine/terrain-engine!TerrainEngine.loadingProgress | TerrainEngine.loadingProgress} goes from 0 to 1 as the chunks up to LOD 1 around the camera become ready. The stage becomes `done` when all of them are, or after 10 seconds at most.
 */
export type LoadingStage = 'device' | 'shaders' | 'terrain' | 'done';
