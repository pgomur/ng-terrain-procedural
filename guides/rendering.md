---
title: Rendering
group: Guides
---

# Rendering

Thousands of chunks are drawn with a handful of draw calls. Every chunk of the same resolution shares one vertex grid, every atlas page is one instanced mesh, and the vertex shader reads the heights directly from the atlas.

## Draw calls

{@link engine/scene-graph!SceneGraph | SceneGraph} creates two `InstancedMesh` objects per atlas page:

| Mesh   | Instances                                                        | Materials                                                                              | Purpose                                                |
| ------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Main   | The visible chunks of the page                                   | Surface and skirt (two geometry groups)                                                | What the camera sees; receives shadows.                |
| Shadow | Every chunk of the page inside the shadow region, visible or not | Surface only, on {@link engine/scene-graph!SHADOW_CASTER_LAYER | SHADOW_CASTER_LAYER} | Casts shadows, including from hills behind the camera. |

With the default configuration there are four pages, so the whole frame, shadow map and sky included, takes between 9 and 12 draw calls in typical views, whatever the number of chunks. A page with no visible instances costs nothing.

Each instance is a single `vec4`: world X and Z of the chunk's corner, its slot in the page, and its seam code. Only the instances of pages that changed are rewritten, and only the range in use is uploaded. Three.js frustum culling is turned off on these meshes: the {@link engine/chunk-manager!ChunkManager | ChunkManager} has already culled per chunk.

## The vertex shader

The shared grid of a resolution `n` has `n × n` vertices at height 0 spanning one chunk, and an attribute `heightIndex` with each vertex's index in a slot. For each vertex, the position node ({@link shaders/elevation.tsl!createTerrainPositionNode | createTerrainPositionNode}):

1. Reads the height at `slot × n² + heightIndex` from the page's storage buffer.
2. If the vertex lies on an edge next to a coarser neighbour, replaces it by the stitched height (below).
3. Offsets the vertex by the chunk's corner.

Normals are not computed from the heights: the surface uses flat shading, so each triangle's normal comes from screen-space derivatives of its position.

## Seams and skirts

Two neighbouring chunks at different levels of detail share an edge, but the finer one has more vertices along it. Its extra vertices would sit at their own height, slightly off the coarser neighbour's straight edge, and leave thin cracks.

### Stitching

Each instance carries a **seam code** with the level-of-detail difference to its four neighbours, two bits per side, clamped to 0–3:

```text
bits 0–1  left    (−X)
bits 2–3  right   (+X)
bits 4–5  top     (−Z)
bits 6–7  bottom  (+Z)
```

On a side with difference `d`, only every `2ᵈ`-th vertex keeps its height; the vertices between are moved onto the straight line joining their two kept neighbours. That is exactly the edge the coarser chunk draws, so the meshes meet with no gap. Only the finer side moves; the coarser side's code is 0. {@link math/chunk-coord!stitchedHeight | stitchedHeight} applies the same rule on the CPU for collision.

The codes are recomputed when a chunk, or one of its four neighbours, is added, removed or changes level of detail. Stitching requires each level to have exactly half the segments of the previous one; this holds for the defaults (64, 32, 16 and 8 segments). With other resolutions, or with `SEAM_FITTING_ENABLED: false`, it is turned off and only the skirts close the gaps.

### Skirts

Every grid also has a **skirt**: a strip of triangles hanging from each edge, `max(1, 2 % of TERRAIN_HEIGHT_SCALE)` units deep (2 with the defaults). It covers any remaining crack, from floating-point differences or from a neighbour that is still loading at another level. Skirts use their own material with a polygon offset so they never show through the surface, an upward normal so they are lit like the ground around them, and they do not cast shadows.

## Materials

Both materials are `MeshStandardNodeMaterial` (roughness 0.8, metalness 0.1) and share one colour node ({@link shaders/terrain-material.tsl! | terrain-material.tsl}):

| Height (share of `TERRAIN_HEIGHT_SCALE` above `TERRAIN_OFFSET_Y`) | Colour                 |
| ----------------------------------------------------------------- | ---------------------- |
| 0 – 25 %                                                          | Sand fading into grass |
| 25 – 65 %                                                         | Grass fading into rock |
| 65 – 95 %                                                         | Rock fading into snow  |

Over the colour, a faint grid every 10 world units darkens the surface by 25 % on its lines, which helps to judge scale and speed while flying. The lines are anti-aliased with screen-space derivatives, so they stay one or two pixels wide at any distance.

## Shadows

{@link engine/sun-light!SunLight | SunLight} owns a directional light, fixed at about 61° above the horizon, and a dim ambient light.

- The shadow map is 2048 × 2048 and covers a square of `2 × LOD_DISTANCES[0]` around the camera (1,200 units with the defaults, about 0.59 units per texel), with PCF filtering.
- The shadow camera follows the camera, but its position is snapped to whole texels in light space. Without that, shadow edges would shimmer while moving.
- Terrain outside the camera view can cast shadows into it. The shadow meshes include every chunk within the region the sun's rays cross on their way to the shadowed square, plus the height of the camera; about 800 units around a camera on the ground with the defaults. The region is quantised to half chunks, so it only changes every 64 units of movement.

## Sky and fog

The sky is a large sphere, drawn last and always at the far plane, coloured by {@link shaders/sky.tsl!skyColor | skyColor} from the view direction:

- A vertical gradient from the horizon to the zenith, and a lighter tone below the horizon.
- A warm glow around the sun and a haze near the horizon on the sun's side, plus the sun disk.
- Clouds: fractal noise projected onto a plane above the camera, drifting with the wind and slowly changing shape. Their edges are softened over at least a fixed width and over the noise's screen-space derivative, so they stay smooth without aliasing at the horizon. They fade out towards the horizon.

The fog uses the same function without the sun disk or the clouds, so distant terrain dissolves into exactly the colour of the sky behind it. It starts at `min(LOD_DISTANCES[1], half the fog end)` (1,500) and is complete at the edge of the generated world, `1.2 × max(LOD_DISTANCES) − CHUNK_SIZE / √2` (about 3,510). The far plane of the camera is just beyond the load radius, so the world never ends visibly.
