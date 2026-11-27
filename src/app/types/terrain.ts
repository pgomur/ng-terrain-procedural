import type { ChunkLOD } from './chunk';

export interface TerrainConfig {
  readonly CHUNK_SIZE: 64 | 128 | 256;
  readonly MAX_CHUNKS: number;
  readonly CHUNK_RESOLUTIONS: Record<ChunkLOD, number>;

  readonly LOD_DISTANCES: [number, number, number];

  readonly GENERATION_BUDGET: number;
  readonly UNLOAD_DELAY_MS: number;

  readonly NOISE_SEED: number;
  readonly NOISE_OCTAVES: number;
  readonly NOISE_PERSISTENCE: number;
  readonly NOISE_LACUNARITY: number;

  readonly NOISE_WARP_ENABLED: boolean;
  readonly NOISE_WARP_STRENGTH: number;
  readonly NOISE_WARP_OCTAVES: number;
  readonly NOISE_WARP_SCALE: number;

  readonly TERRAIN_HEIGHT_SCALE: number;
  readonly TERRAIN_OFFSET_Y: number;

  readonly SEAM_FITTING_ENABLED: boolean;

  readonly ANTICIPATION_SECONDS: number;
  readonly VELOCITY_WEIGHT: number;
  readonly GENERATION_QUEUE_CAPACITY: number;
}

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
