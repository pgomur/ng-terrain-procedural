import type { ChunkLOD, WorldPosition } from './chunk';

/**
 * Global terrain engine configuration
 */
export interface TerrainConfig {
  // Basic Geometry
  readonly CHUNK_SIZE: 64 | 128 | 256;
  readonly MAX_CHUNKS: number;
  readonly CHUNK_RESOLUTIONS: Record<ChunkLOD, number>;

  // LOD and distance
  readonly LOD_DISTANCES: [number, number, number];

  // Generation
  readonly GENERATION_BUDGET: number;
  readonly UNLOAD_DELAY_FRAMES: number;

  // Noise procedural (FBM)
  readonly NOISE_SEED: number;
  readonly NOISE_OCTAVES: number;
  readonly NOISE_PERSISTENCE: number;
  readonly NOISE_LACUNARITY: number;

  // Domain Warping
  readonly NOISE_WARP_ENABLED: boolean;
  readonly NOISE_WARP_STRENGTH: number;
  readonly NOISE_WARP_OCTAVES: number;
  readonly NOISE_WARP_SCALE: number;

  // Vertical scale
  readonly TERRAIN_HEIGHT_SCALE: number;
  readonly TERRAIN_OFFSET_Y: number;

  // Features
  readonly SEAM_FITTING_ENABLED: boolean;

  // Streaming / Buffer de Anticipación
  /**
   * Frames into the future used for chunk preloading prediction.
   * Higher = more aggressive look-ahead, at cost of VRAM.
   * Range: [10, 120]. Default: 60 (≈1 s at 60 fps).
   */
  readonly ANTICIPATION_FRAMES: number;
  /**
   * Weight of camera velocity direction in the priority score.
   * 0 = pure distance, 1 = pure look-ahead. Default: 0.6.
   */
  readonly VELOCITY_WEIGHT: number;
  /**
   * Fixed capacity of the generation priority queue.
   * Requests beyond this limit evict the lowest-priority resident.
   * Default: 256.
   */
  readonly GENERATION_QUEUE_CAPACITY: number;
}

/**
 * Engine initialization state
 */
export type EngineInitState =
  | 'uninitialized' // Nothing created
  | 'initializing' // Requesting WebGPU device
  | 'ready' // Ready to generate terrain
  | 'failed'; // Unrecoverable error

/**
 * Camera status in world coordinates
 * Updated every frame from Three.js
 */
export interface CameraState {
  readonly position: WorldPosition;
  readonly forward: WorldPosition;
  readonly up: WorldPosition;
  readonly right: WorldPosition;
  readonly fov: number;
  readonly aspect: number;
  readonly near: number;
  readonly far: number;
  readonly viewMatrix: Float32Array;
  readonly projectionMatrix: Float32Array;
  readonly viewProjectionMatrix: Float32Array;
}

/**
 * Constant engine defaults
 * Exported for testing and partial overrides
 */
export const DEFAULT_TERRAIN_CONFIG: Readonly<TerrainConfig> = {
  CHUNK_SIZE: 128,
  MAX_CHUNKS: 1024,
  CHUNK_RESOLUTIONS: { 0: 65, 1: 33, 2: 17, 3: 9 },
  LOD_DISTANCES: [600, 1500, 3000],
  GENERATION_BUDGET: 16,
  UNLOAD_DELAY_FRAMES: 60,
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
  // Streaming / Buffer de Anticipación
  ANTICIPATION_FRAMES: 60,
  VELOCITY_WEIGHT: 0.6,
  GENERATION_QUEUE_CAPACITY: 256,
} as const;
