---
title: Streaming and levels of detail
group: Guides
---

# Streaming and levels of detail

The world is infinite, but only the chunks around the camera exist at any moment. {@link engine/chunk-manager!ChunkManager | ChunkManager} decides which ones, at which level of detail, and keeps that set up to date as the camera moves, without ever waiting for the GPU.

## The wanted set

Every chunk whose centre is within `1.2 × max(LOD_DISTANCES)` of the camera, measured horizontally, is wanted. Its level of detail depends on that distance:

| LOD | Distance to the chunk centre (default) | Vertices per side (default) | Chunks wanted (default) |
| --- | -------------------------------------- | --------------------------- | ----------------------- |
| 0   | up to 600                              | 65                          | about 70                |
| 1   | up to 1,500                            | 33                          | about 360               |
| 2   | up to 3,000                            | 17                          | about 1,300             |
| 3   | up to 3,600                            | 9                           | about 760               |

With the defaults that is about 2,485 chunks covering a disc 7,200 units across; the exact count shifts slightly with the camera's position inside its chunk. The thresholds are inclusive and the height of the camera is ignored.

The set is recomputed only when the camera has moved more than 10 % of a chunk since the last time, walking a square spiral outwards from the camera so the list comes out ordered by proximity. When a chunk's ring changes, it is wanted at its new level of detail: a new chunk with a different key.

## Priority

Missing chunks wait in a {@link engine/streaming-queue!StreamingPriorityQueue | StreamingPriorityQueue}, a bounded binary min-heap. A chunk's score is its distance to the camera minus a look-ahead in the direction of travel:

```text
score = distance − cos(angle) × speed × ANTICIPATION_SECONDS × VELOCITY_WEIGHT
```

`angle` is between the camera's horizontal velocity and the direction to the chunk, so chunks straight ahead get up to `speed × 1 s × 0.6` units of advantage with the defaults, and chunks behind are pushed back by the same amount. The velocity is smoothed with an exponential moving average ({@link engine/camera-velocity!CameraVelocityTracker | CameraVelocityTracker}, weight 0.15 per sample) so a jittery input does not reshuffle the queue. Scores are recomputed every frame while the queue has requests, and whenever the velocity changes by more than 5 units per second.

The queue holds at most `GENERATION_QUEUE_CAPACITY` requests (256). When it is full, a request with a lower score replaces the worst one; a worse one is retried on a later frame. Requests for chunks that stop being wanted are dropped before they reach the GPU, so flying fast never wastes generation on terrain already left behind.

## Generation

Each frame, up to `GENERATION_BUDGET` requests (16) are taken from the queue. Each gets a slot in the GPU height atlas and a compute job, and is `ready` straight away: its job is dispatched before the frame is rendered, so it is drawn in the same frame. [GPU height generation](gpu-generation.md) covers what happens on the GPU.

## Chunk lifecycle

```text
  generating ── generate() throws ──► error ── retry due ─────────► queued again
      │                                 └─── no longer wanted ───► released
      │ job queued
      ▼
    ready ◄──────── wanted again ────────┐
      │                                  │
      │ no longer wanted                 │
      ▼                                  │
  unloading ─────────────────────────────┘
      │
      │ UNLOAD_DELAY_MS elapsed, or evicted over MAX_CHUNKS
      ▼
  released   atlas slot freed; results still in flight are ignored
```

| State        | Drawn | Meaning                                                                              |
| ------------ | ----- | ------------------------------------------------------------------------------------ |
| `generating` | No    | Created; its job is being queued.                                                    |
| `ready`      | Yes   | Its heights are on the GPU, or being generated in this frame.                        |
| `unloading`  | Yes   | No longer wanted. Kept for `UNLOAD_DELAY_MS` in case the camera comes back, while under `MAX_CHUNKS` (see below). |
| `error`      | No    | Generation failed; retried while it is still wanted.                                 |

### Changing level of detail

When a cell moves to another ring, the new version is generated while the old one keeps being drawn. The old version does not even start its unload delay until the new one is `ready`, so there is never a hole. For each cell the scene graph draws the finest `ready` version, or the finest `unloading` one if none is ready.

### Retries

A failed generation is retried with exponential backoff while the chunk is still wanted:

| Attempt | 1      | 2      | 3   | 4   | 5   | 6 and later |
| ------- | ------ | ------ | --- | --- | --- | ----------- |
| Wait    | 250 ms | 500 ms | 1 s | 2 s | 4 s | 8 s         |

The failures are counted in the diagnostics panel (_Failed_) until they succeed.

### Memory limit

If more than `MAX_CHUNKS` (1,024) chunks are held, the unloading chunks that were last wanted longest ago are released first, before their delay ends. Wanted chunks are never evicted, so the limit is soft.

With the defaults the wanted set alone, about 2,485 chunks, is larger than the limit. Every chunk that stops being wanted is therefore released in the same pass, and `UNLOAD_DELAY_MS` has no effect: going back over terrain just left generates it again. Level-of-detail changes are not affected, because the old version only starts unloading once its replacement is drawn. To keep recently left chunks around, set `MAX_CHUNKS` above the size of the wanted set; each kept chunk holds an atlas slot, and the atlas grows by extra pages if needed.

## Visibility

A chunk is visible when it is drawable and its bounding box intersects the camera frustum, with an 8-unit margin so chunks touching the edge of the view are kept. The test is conservative: it never hides a visible chunk.

Until the GPU reports a chunk's exact minimum and maximum height, its box uses the full possible range, `[TERRAIN_OFFSET_Y, TERRAIN_OFFSET_Y + TERRAIN_HEIGHT_SCALE]` widened by 10 % of the scale on each side (−10 to 110 with the defaults). The exact bounds arrive a few frames later and make culling tighter.

Visibility is recomputed only when the view or the chunk set changed. The retire-and-retry pass is skipped too while nothing changes, and wakes up exactly when the next unloading chunk is due.

## Collision

The camera must not go underground, so the CPU needs the terrain height under it. Only the heights of the 3 × 3 chunks around the camera are requested from the GPU, and only when the camera enters a new chunk or those chunks change. Each copy, 16.5 KB for a LOD 0 chunk, is kept until its chunk is released, which for the chunks near the camera happens when they leave the LOD 0 ring; so a few dozen copies at most are held while flying.

{@link engine/chunk-manager!ChunkManager.getTerrainHeightAt | getTerrainHeightAt} interpolates within the same triangle the GPU rasterises and applies the same seam stitching as the vertex shader ({@link math/chunk-coord!stitchedHeight | stitchedHeight}), so the result matches the drawn surface. It returns `null` until those heights have arrived; the flight controls simply skip the ground check meanwhile.
