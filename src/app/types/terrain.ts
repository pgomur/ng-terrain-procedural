/**
 * The terrain configuration: {@link TerrainConfig}, every option the engine reads, and {@link DEFAULT_TERRAIN_CONFIG}, the values used when nothing else is provided.
 *
 * The options fall into four groups:
 *
 * | Group | Options |
 * | --- | --- |
 * | World layout | `CHUNK_SIZE`, `CHUNK_RESOLUTIONS`, `LOD_DISTANCES` |
 * | Streaming | `GENERATION_BUDGET`, `GENERATION_QUEUE_CAPACITY`, `UNLOAD_DELAY_MS`, `MAX_CHUNKS`, `ANTICIPATION_SECONDS`, `VELOCITY_WEIGHT` |
 * | Terrain shape | `NOISE_SEED`, `NOISE_OCTAVES`, `NOISE_PERSISTENCE`, `NOISE_LACUNARITY`, the four `NOISE_WARP_*`, `TERRAIN_HEIGHT_SCALE`, `TERRAIN_OFFSET_Y` |
 * | Seams | `SEAM_FITTING_ENABLED` |
 *
 * The configuration is read once, when the engine starts. Each option's page gives its default and what it costs.
 *
 * See [Configuration](../../../guides/configuration.md) for where to set it and some recipes.
 *
 * @module
 */
import type { ChunkLOD } from './chunk';

/**
 * Configuration of the terrain engine.
 *
 * Defaults are in {@link DEFAULT_TERRAIN_CONFIG}. They can be replaced application-wide with the {@link terrain/terrain.config!TERRAIN_CONFIG | TERRAIN_CONFIG} injection token, or per instance with the `configOverrides` input of {@link terrain/terrain.component!TerrainComponent | TerrainComponent}.
 */
export interface TerrainConfig {
  /**
   * Side length of a chunk in world units.
   *
   * Larger chunks mean fewer chunks for the same draw distance, so less per-chunk work on the CPU, but each one costs more to generate and is culled less tightly. The noise is sampled in world units, so changing the size does not change the shape of the terrain.
   *
   * @defaultValue `128`
   */
  readonly CHUNK_SIZE: 64 | 128 | 256;
  /**
   * Soft limit on chunks kept in memory, enforced by releasing unloading chunks early.
   *
   * Only chunks in the `unloading` state are candidates, the ones least recently wanted first. Because wanted chunks are never evicted, the number held can exceed this limit.
   *
   * With the defaults the wanted set alone, about 2,485 chunks, is above this limit, so a chunk is released as soon as it stops being wanted and {@link UNLOAD_DELAY_MS} has no effect. To keep recently left chunks for that delay, set this limit above the size of the wanted set.
   *
   * @defaultValue `1024`
   */
  readonly MAX_CHUNKS: number;
  /**
   * Vertices per side of a chunk for each level of detail.
   *
   * Edges between levels are only stitched when the number of segments halves at each level, which means resolutions of the form `2^n + 1`, such as `65, 33, 17, 9`.
   *
   * Each resolution gets its own atlas pages and its own shared grid. The cost of generating and drawing a chunk grows with the square of its resolution: a 65 × 65 chunk has 4,225 vertices and 8,192 triangles, a 9 × 9 chunk 81 vertices and 128 triangles, plus the skirts. See [Rendering](../../../guides/rendering.md#seams-and-skirts).
   *
   * @defaultValue `{ 0: 65, 1: 33, 2: 17, 3: 9 }`
   */
  readonly CHUNK_RESOLUTIONS: Record<ChunkLOD, number>;

  /**
   * Upper distance, in world units from the camera to a chunk's centre, of LOD 0, 1 and 2. Farther chunks use LOD 3.
   *
   * Every chunk within `1.2 × max(LOD_DISTANCES)` of the camera is loaded.
   *
   * The thresholds are inclusive and use the horizontal distance only. This option also sets the draw distance: the fog ends and the camera's far plane sits at the edge of the loaded disc, and the shadow map covers `2 × LOD_DISTANCES[0]` around the camera. The number of chunks, the atlas memory and the start-up time grow with the square of `max(LOD_DISTANCES)`. See [Streaming and levels of detail](../../../guides/streaming.md#the-wanted-set).
   *
   * @defaultValue `[600, 1500, 3000]`
   */
  readonly LOD_DISTANCES: [number, number, number];

  /**
   * Maximum number of chunks generated per frame. It is also the number of jobs a single compute dispatch can hold.
   *
   * Higher values fill the world faster after start-up and keep up with faster flight, at the cost of more GPU work in the frames that generate. With the defaults, a full budget of LOD 0 chunks is 67,600 height evaluations.
   *
   * @defaultValue `16`
   */
  readonly GENERATION_BUDGET: number;
  /**
   * Milliseconds a chunk stays loaded, and drawable, after it stops being wanted. Avoids reloading chunks when the camera moves back and forth across a boundary.
   *
   * During this delay the chunk keeps being drawn, so coming back to it costs nothing. It only applies while the chunks held stay under {@link MAX_CHUNKS}. The delay of an old level of detail only starts once its replacement is ready, so a level change never leaves a hole.
   *
   * @defaultValue `960`
   */
  readonly UNLOAD_DELAY_MS: number;

  /**
   * World seed. The same seed always produces the same terrain.
   *
   * The seed is hashed into an offset of the noise domain, in `[0, 256)` noise units on each axis (see {@link shaders/elevation.tsl!seedToNoiseOffset | seedToNoiseOffset}), so neighbouring seeds give unrelated landscapes.
   *
   * @defaultValue `12345`
   */
  readonly NOISE_SEED: number;
  /**
   * Octaves of fractional Brownian motion, rounded and clamped to 1–12.
   *
   * Each octave adds features half the size (with the default lacunarity) and costs one more noise evaluation per vertex. The sum is normalised by the total amplitude, so more octaves add detail without changing the height range.
   *
   * @defaultValue `4`
   */
  readonly NOISE_OCTAVES: number;
  /**
   * Amplitude multiplier between octaves.
   *
   * With `0.5`, each octave has half the amplitude of the previous one. Values close to `1` give rough, noisy terrain; values close to `0` give smooth, rolling terrain dominated by the first octave.
   *
   * @defaultValue `0.5`
   */
  readonly NOISE_PERSISTENCE: number;
  /**
   * Frequency multiplier between octaves.
   *
   * With `2.0`, each octave has features half the size of the previous one.
   *
   * @defaultValue `2.0`
   */
  readonly NOISE_LACUNARITY: number;

  /**
   * Whether the noise domain is warped by a second noise field, which bends ridges and valleys into less regular shapes.
   *
   * When enabled, each height costs two more fBm evaluations of `NOISE_WARP_OCTAVES` octaves. Only generation is slower; rendering is not affected.
   *
   * @defaultValue `false`
   */
  readonly NOISE_WARP_ENABLED: boolean;
  /**
   * How far the domain is displaced by the warp, in noise units.
   *
   * One noise unit is 1,000 world units, so the default displaces the sampled position by up to about 300 units.
   *
   * @defaultValue `0.3`
   */
  readonly NOISE_WARP_STRENGTH: number;
  /**
   * Octaves of the warping noise, rounded and clamped to 1–12.
   *
   * @defaultValue `1`
   */
  readonly NOISE_WARP_OCTAVES: number;
  /**
   * Frequency of the warping noise relative to the base noise.
   *
   * Below `1` the warp field is smoother than the terrain, which bends whole ridges; above `1` it only wrinkles them.
   *
   * @defaultValue `0.5`
   */
  readonly NOISE_WARP_SCALE: number;

  /**
   * Height range of the terrain in world units: heights go from `TERRAIN_OFFSET_Y` to `TERRAIN_OFFSET_Y + TERRAIN_HEIGHT_SCALE`.
   *
   * It also scales the colour bands, the depth of the skirts (2 % of it, at least 1 unit), the height range assumed for culling chunks whose exact bounds are not known yet, and the volume the shadow camera encloses.
   *
   * @defaultValue `100`
   */
  readonly TERRAIN_HEIGHT_SCALE: number;
  /**
   * Height of the lowest possible terrain, in world units.
   *
   * @defaultValue `0`
   */
  readonly TERRAIN_OFFSET_Y: number;

  /**
   * Whether the edges of finer chunks are moved onto their coarser neighbours to close the seams between levels of detail. Requires `2^n + 1` resolutions.
   *
   * When disabled, or when {@link CHUNK_RESOLUTIONS} does not have that form, only the skirts close the gaps between levels of detail, and small steps can show along the seams. See [Rendering](../../../guides/rendering.md#stitching).
   *
   * @defaultValue `true`
   */
  readonly SEAM_FITTING_ENABLED: boolean;

  /**
   * How many seconds ahead the camera's motion is projected when prioritising chunks to generate.
   *
   * Together with {@link VELOCITY_WEIGHT}, a chunk straight ahead gains up to `speed × ANTICIPATION_SECONDS × VELOCITY_WEIGHT` units of priority, and one straight behind loses as much. See [Streaming](../../../guides/streaming.md#priority).
   *
   * @defaultValue `1`
   */
  readonly ANTICIPATION_SECONDS: number;
  /**
   * Weight of that look-ahead in the priority, from `0` (distance only) to `1`.
   *
   * @defaultValue `0.6`
   */
  readonly VELOCITY_WEIGHT: number;
  /**
   * Maximum pending generation requests. When the queue is full, a request with a higher priority replaces the one with the lowest.
   *
   * Requests that do not fit are not lost: the chunk is still wanted and is queued again on a later frame.
   *
   * @defaultValue `256`
   */
  readonly GENERATION_QUEUE_CAPACITY: number;
}

/**
 * Default terrain configuration.
 *
 * @example
 * ```ts
 * const mountains: TerrainConfig = {
 *   ...DEFAULT_TERRAIN_CONFIG,
 *   TERRAIN_HEIGHT_SCALE: 400,
 *   NOISE_OCTAVES: 6,
 *   NOISE_WARP_ENABLED: true,
 * };
 * ```
 */
export const DEFAULT_TERRAIN_CONFIG: Readonly<TerrainConfig> = {
  CHUNK_SIZE: 128,
  MAX_CHUNKS: 1024,
  CHUNK_RESOLUTIONS: { 0: 65, 1: 33, 2: 17, 3: 9 },
  LOD_DISTANCES: [600, 1500, 3000],
  GENERATION_BUDGET: 16,
  UNLOAD_DELAY_MS: 960,
  NOISE_SEED: 12345,
  NOISE_OCTAVES: 4,
  NOISE_PERSISTENCE: 0.5,
  NOISE_LACUNARITY: 2.0,
  NOISE_WARP_ENABLED: false,
  NOISE_WARP_STRENGTH: 0.3,
  NOISE_WARP_OCTAVES: 1,
  NOISE_WARP_SCALE: 0.5,
  TERRAIN_HEIGHT_SCALE: 100,
  TERRAIN_OFFSET_Y: 0,
  SEAM_FITTING_ENABLED: true,
  ANTICIPATION_SECONDS: 1,
  VELOCITY_WEIGHT: 0.6,
  GENERATION_QUEUE_CAPACITY: 256,
} as const;
