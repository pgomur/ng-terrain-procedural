---
title: Diagnostics panel
group: Guides
---

# Diagnostics panel

The panel in the corner of the screen ({@link terrain/hud.component!HudComponent | HudComponent}) shows what the engine is doing. It is refreshed four times per second; values marked _average_ are averaged over those 250 ms, the others are taken at the end of the interval. All of them come from {@link engine/terrain-engine!TerrainEngine.stats | TerrainEngine.stats} ({@link types/engine!TerrainEngineStats | TerrainEngineStats}), so an application can read them without the panel. Hide it with `[showDiagnostics]="false"` on `<app-terrain>`.

## Header

| Value   | Meaning                                                                                            |
| ------- | -------------------------------------------------------------------------------------------------- |
| **fps** | Frames rendered per second.                                                                        |
| **ms**  | Average time between frames. 16.7 ms is 60 fps.                                                    |
| **max** | Longest time between two frames in the interval. A high value with a good average means a stutter. |

## Render

| Value          | Meaning                                                                                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CPU frame**  | _Average_ JavaScript time of a frame: controls, streaming, scene update and issuing the render. GPU time is not included.                                                           |
| **Streaming**  | _Average_ part of the CPU frame spent in {@link engine/chunk-manager!ChunkManager.update | ChunkManager.update} and {@link engine/scene-graph!SceneGraph.sync | SceneGraph.sync}. |
| **Draw calls** | Draw calls of the last frame, shadow map included. It depends on the atlas pages in use, not on the number of chunks: between 9 and 12 in typical views with the defaults.                 |
| **Triangles**  | Triangles drawn in the last frame, shadow map included.                                                                                                                             |
| **Resolution** | Size of the drawing buffer in pixels, and the pixel ratio used, capped at 2.                                                                                                        |

## Terrain

| Value         | Meaning                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Visible**   | Chunks inside the camera frustum. During a level-of-detail change both versions of a cell can count, though only one is drawn.   |
| **LOD 0–3**   | The visible chunks split by level of detail.                                                                                     |
| **Ready**     | Chunks with heights on the GPU. _+N unloading_: chunks no longer wanted, still drawn while their unload delay runs.              |
| **Queue**     | Chunks waiting to be generated, and how full the queue is. It empties quickly after start-up and grows while flying fast.        |
| **Generated** | Chunks generated per second, _average_. At most `GENERATION_BUDGET` per frame.                                                   |
| **Failed**    | Only shown when chunks failed to generate. They are retried with backoff while still wanted ([Streaming](streaming.md#retries)). |
| **Seed**      | The world seed, `NOISE_SEED`.                                                                                                    |

## Terrain buffers

The total next to the title is the sum of the three rows.

| Value            | Meaning                                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Height atlas** | Storage buffers of every atlas page: heights, bounds and job buffers ([GPU height generation](gpu-generation.md#the-height-atlas)). About 6.5 MB with the defaults. It only grows when a page fills up. |
| **Geometry**     | Vertex, index and instance buffers on the GPU: the shared grids and the per-page instance data.                                                                                                         |
| **Read-back**    | Staging buffers kept in the pool for reading results back. A few kilobytes.                                                                                                                             |

## Camera

| Value            | Meaning                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| **X, Y, Z**      | Camera position in world units.                                                                         |
| **Above ground** | Height above the terrain under the camera. `–` until the heights around the camera have been read back. |
| **Heading**      | Horizontal direction: `0°` is −Z (N), `90°` is +X (E), and the nearest of eight cardinal points.        |
| **Pitch**        | Vertical angle; positive looks up.                                                                      |
| **Speed**        | Average distance travelled per second. 30 u/s flying, 90 u/s with Shift.                                |
| **Chunk**        | Grid coordinates of the chunk under the camera.                                                         |

## Reading the numbers

- **Low fps, low CPU frame**: the GPU is the bottleneck. Lower the resolution, `LOD_DISTANCES` or `CHUNK_RESOLUTIONS` ([Configuration](configuration.md)).
- **High Streaming while flying**: generation is the cost. Lower `GENERATION_BUDGET`, or the octaves.
- **The queue stays near 100 % and terrain pops in late**: generation cannot keep up with the speed. Raise `GENERATION_BUDGET` if there is frame time to spare.
- **Ready keeps growing past the wanted set**: chunks are not being released. With the defaults it settles around 2,500 plus the unloading ones.
- **Failed above zero**: the browser console has the error of each failure.
