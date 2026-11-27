---
title: Configuration
group: Guides
---

# Configuration

Every option of the terrain lives in one object, {@link types/terrain!TerrainConfig | TerrainConfig}. The defaults are in {@link types/terrain!DEFAULT_TERRAIN_CONFIG | DEFAULT_TERRAIN_CONFIG}.

## Where to set it

There are two levels, and the second wins:

1. **Application-wide**, by providing {@link terrain/terrain.config!TERRAIN_CONFIG | TERRAIN_CONFIG}:

   ```ts
   bootstrapApplication(App, {
     providers: [
       provideZonelessChangeDetection(),
       { provide: TERRAIN_CONFIG, useValue: { ...DEFAULT_TERRAIN_CONFIG, NOISE_SEED: 42 } },
     ],
   });
   ```

2. **Per component**, with the `configOverrides` input of `<app-terrain>`, which only needs the options to change:

   ```html
   <app-terrain [configOverrides]="{ TERRAIN_HEIGHT_SCALE: 250, NOISE_WARP_ENABLED: true }" />
   ```

The configuration is read once, when the engine starts. Changing it afterwards has no effect; recreate the component to apply a new one.

## Options

### World layout

| Option              | Default                       | Effect                                                                                                                                                                  |
| ------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHUNK_SIZE`        | `128`                         | Side of a chunk in world units: `64`, `128` or `256`. Larger chunks mean fewer, heavier chunks.                                                                         |
| `CHUNK_RESOLUTIONS` | `{0: 65, 1: 33, 2: 17, 3: 9}` | Vertices per side for each level of detail. Seams are stitched only when the segments halve at each level (`2ⁿ + 1`).                                                   |
| `LOD_DISTANCES`     | `[600, 1500, 3000]`           | Upper distance of LOD 0, 1 and 2. Chunks are loaded up to `1.2 ×` the largest; this also sets the fog, the camera's far plane and the shadow area (`LOD_DISTANCES[0]`). |

### Streaming

| Option                      | Default | Effect                                                                                                               |
| --------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `GENERATION_BUDGET`         | `16`    | Chunks generated per frame, and jobs per compute dispatch. Higher fills the world faster at a higher cost per frame. |
| `GENERATION_QUEUE_CAPACITY` | `256`   | Pending requests. When full, better requests replace the worst.                                                      |
| `UNLOAD_DELAY_MS`           | `960`   | How long a chunk stays loaded, and drawn, after it stops being wanted. Only applies while under `MAX_CHUNKS`.         |
| `MAX_CHUNKS`                | `1024`  | Soft limit on chunks held. Over it, unloading chunks are released at once; wanted ones never are. The default wanted set is about 2,485 chunks, so by default left chunks are released immediately. |
| `ANTICIPATION_SECONDS`      | `1`     | How far ahead the camera's motion is projected for the priorities.                                                   |
| `VELOCITY_WEIGHT`           | `0.6`   | Weight of that projection, from `0` (distance only) to `1`.                                                          |

### Terrain shape

| Option                 | Default | Effect                                                                                                |
| ---------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `NOISE_SEED`           | `12345` | The world. The same seed always gives the same terrain.                                               |
| `NOISE_OCTAVES`        | `4`     | Layers of detail, 1–12. Each octave adds smaller features and costs one more noise sample per vertex. |
| `NOISE_PERSISTENCE`    | `0.5`   | Amplitude kept from one octave to the next. Higher values give rougher terrain.                       |
| `NOISE_LACUNARITY`     | `2.0`   | Frequency growth from one octave to the next.                                                         |
| `NOISE_WARP_ENABLED`   | `false` | Bends the noise domain with a second noise field for more organic ridges and valleys.                 |
| `NOISE_WARP_STRENGTH`  | `0.3`   | How far the domain is bent, in noise units.                                                           |
| `NOISE_WARP_OCTAVES`   | `1`     | Octaves of the warping noise, 1–12.                                                                   |
| `NOISE_WARP_SCALE`     | `0.5`   | Frequency of the warping noise relative to the base noise.                                            |
| `TERRAIN_HEIGHT_SCALE` | `100`   | Height range in world units. Also scales the colour bands, the skirts and the shadow camera.          |
| `TERRAIN_OFFSET_Y`     | `0`     | Height of the lowest possible terrain.                                                                |
| `SEAM_FITTING_ENABLED` | `true`  | Stitches finer edges onto coarser neighbours. Skirts are always present.                              |

One noise unit is 1,000 world units: features of the first octave are roughly a kilometre across.

## What each option costs

- **Draw distance** (`LOD_DISTANCES`) is the main cost. The number of chunks grows with the square of the load radius, and so do the atlas memory and the time to fill the world at start-up.
- **Resolution** (`CHUNK_RESOLUTIONS`) multiplies triangles and generation work by the square of the vertices per side. LOD 0 is most of the triangles near the camera.
- **Octaves** and **domain warp** only cost generation time; once generated, a chunk renders at the same speed. Warp adds two fBm evaluations of `NOISE_WARP_OCTAVES` octaves per vertex.
- **`GENERATION_BUDGET`** trades frame time for loading speed. Watch _Streaming_ and _Generated/s_ in the [diagnostics panel](diagnostics.md) when changing it.

## Recipes

Mountains:

```ts
{ TERRAIN_HEIGHT_SCALE: 400, NOISE_OCTAVES: 6, NOISE_WARP_ENABLED: true, NOISE_WARP_STRENGTH: 0.5 }
```

Gentle hills:

```ts
{ TERRAIN_HEIGHT_SCALE: 40, NOISE_OCTAVES: 3, NOISE_PERSISTENCE: 0.4 }
```

Low-end devices, a shorter draw distance and lighter chunks:

```ts
{ LOD_DISTANCES: [400, 1000, 2000], CHUNK_RESOLUTIONS: { 0: 33, 1: 17, 2: 9, 3: 5 }, GENERATION_BUDGET: 8 }
```

Long views, at a much higher cost:

```ts
{ LOD_DISTANCES: [800, 2500, 5000], CHUNK_SIZE: 256 }
```

## Pitfalls

- Resolutions that are not `2ⁿ + 1` with halving segments silently turn stitching off. The terrain still has no holes, thanks to the skirts, but seams between levels can show as small steps.
- The flight speed is fixed at 30 units per second. With a much larger `TERRAIN_HEIGHT_SCALE` or draw distance the world feels slower; hold Shift for ×3.
- Very large `LOD_DISTANCES` push the camera's far plane out, which reduces depth precision.
