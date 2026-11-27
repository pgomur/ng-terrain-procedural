---
title: Architecture
group: Guides
---

# Architecture

The terrain is an Angular application around a small engine. Angular owns the page, the loading screens and the panels; the engine owns WebGPU, the scene and the frame loop. Everything heavy, generating heights and drawing them, happens on the GPU.

## The pieces

```text
App                                shell, loads the terrain lazily with @defer
└─ TerrainComponent                <app-terrain>
   ├─ FlyCameraController          keyboard and mouse flight
   ├─ HudComponent                 diagnostics panel
   ├─ LoaderComponent              loading and error screens
   └─ TerrainEngine                renderer, scene, camera, frame loop
      ├─ ChunkManager              wanted chunks, levels of detail, visibility
      │  ├─ StreamingPriorityQueue chunks waiting to be generated
      │  └─ CameraVelocityTracker  look-ahead for the priorities
      ├─ GPUGenerator              height atlas, compute dispatches, read-backs
      ├─ SceneGraph                instanced meshes, seams, shadow casters
      ├─ SunLight                  sun, ambient light, shadow camera
      └─ FrameStatsCollector       diagnostics
```

The shaders live apart, in `src/app/shaders`, written in Three.js Shading Language (TSL): the compute kernels and vertex displacement in `elevation.tsl.ts`, the terrain materials in `terrain-material.tsl.ts` and the sky in `sky.tsl.ts`. The pure maths shared by the CPU and mirrored by the shaders is in `src/app/math/chunk-coord.ts`.

| Module                                                                 | Responsibility                                                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| {@link engine/terrain-engine!TerrainEngine | TerrainEngine}           | Creates the renderer, scene, camera, sun and sky, and runs the frame loop.                       |
| {@link engine/chunk-manager!ChunkManager | ChunkManager}              | Decides the wanted chunks, queues, generates, retires and culls them.                            |
| {@link engine/gpu-generator!GPUGenerator | GPUGenerator}              | Stores heights in atlas pages, dispatches the compute kernels and reads back bounds and heights. |
| {@link engine/scene-graph!SceneGraph | SceneGraph}                    | Turns chunks into one instanced mesh per atlas page, with seams and shadow casters.              |
| {@link engine/sun-light!SunLight | SunLight}                          | Sun and shadows that follow the camera without shimmering.                                       |
| {@link terrain/terrain.component!TerrainComponent | TerrainComponent} | Connects the engine to the page: canvas, screens, panel and controls.                            |

## Start-up

1. The shell renders the loading screen and downloads the terrain code (`@defer`). If that download fails, it shows _The terrain engine could not be loaded_.
2. {@link terrain/terrain.component!TerrainComponent | TerrainComponent} merges the configuration (see [Configuration](configuration.md)) and calls {@link engine/terrain-engine!TerrainEngine.init | TerrainEngine.init} with its canvas.
3. **Stage `device`.** The engine creates a `WebGPURenderer`. If WebGPU is not available, or Three.js falls back to WebGL 2, initialisation fails and the page explains why: the engine reads storage buffers in the vertex stage, which WebGL 2 cannot do.
4. **Stage `shaders`.** After one paint, so the new status is visible, the engine builds the scene (sky dome and fog), the camera and the sun, creates the generator, the chunk manager and the scene graph, and compiles every pipeline by running the compute kernels once and rendering one frame with one instance per atlas page.
5. **Stage `terrain`.** The engine is `ready`. The component starts the flight controls and the frame loop. The loading screen shows the share of chunks up to LOD 1 around the camera that are ready, and fades out when all of them are, or after 10 seconds at most.

## The frame loop

Every frame, in one `requestAnimationFrame` callback:

1. **Timing.** The time since the previous frame is recorded for the statistics and clamped to 0.1 s for movement, so a stalled tab does not teleport the camera.
2. **Viewport.** If the canvas size or the device pixel ratio changed, the drawing buffer and the camera aspect are updated. Resizes are observed with a `ResizeObserver` and applied here, once per frame.
3. **Controls.** The frame callback runs; in the app it moves the camera ({@link terrain/fly-camera!FlyCameraController.update | FlyCameraController.update}).
4. **View.** If the camera moved or its projection changed, the frustum planes are recomputed.
5. **Sun.** The shadow camera follows the camera and the shadow-caster region is updated.
6. **Streaming.** {@link engine/chunk-manager!ChunkManager.update | ChunkManager.update} refreshes the wanted chunks, retires and retries, queues and generates up to `GENERATION_BUDGET` chunks, requests collision heights, **dispatches all queued compute work** with {@link engine/gpu-generator!GPUGenerator.flush | GPUGenerator.flush}, and updates visibility.
7. **Scene.** {@link engine/scene-graph!SceneGraph.sync | SceneGraph.sync} applies the changes to the instanced meshes.
8. **Loading.** While the loading screen is up, its progress is updated.
9. **Render.** The renderer draws the shadow map, the terrain and the sky. The compute work from step 6 was submitted to the same queue first, so a chunk generated in this frame is already drawn in it.
10. **Statistics.** At most every 250 ms a new snapshot of {@link types/engine!TerrainEngineStats | TerrainEngineStats} is published.

Nothing in the loop waits for the GPU. The only data that comes back from it, chunk bounds and collision heights, arrives through asynchronous read-backs and is applied in a later frame.

## Life of a chunk

```text
wanted ──► queued ──► generated and drawn ──► exact bounds read back
                      (same frame)            (a few frames later)
                              │
                              │ no longer wanted
                              ▼
                   unloading, still drawn ──► released after UNLOAD_DELAY_MS
                                                        or at once over MAX_CHUNKS
```

A chunk is generated and drawn in the same frame, culled first with a conservative height range and then with its exact bounds once they are read back. When it stops being wanted it keeps being drawn for `UNLOAD_DELAY_MS`, unless more than `MAX_CHUNKS` are held, and its atlas slot is then reused. [Streaming and levels of detail](streaming.md) covers each step.

## Shutdown and GPU loss

Destroying the component disposes the engine: the loop stops, a pending initialisation is cancelled and every GPU resource is released. If the GPU device is lost while running, after a driver reset or a GPU timeout, the engine stops the loop and moves to the `lost` state; the component releases the pointer and asks the user to reload the page.

## Conventions

- Distances are in world units; the camera moves at 30 units per second.
- Y is up. Chunk `(x, z)` covers the square from `(x, z) × CHUNK_SIZE` to `(x + 1, z + 1) × CHUNK_SIZE`.
- A chunk's key is `"x:z:lod"`; the key of its grid cell, shared by all its levels of detail, is `"x:z"`.
- Heading `0°` looks towards -Z and grows clockwise: `90°` is +X.
