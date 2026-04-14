import type { ChunkCoord, ChunkLOD, WorldPosition } from './chunk';

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
  readonly LOD_TRANSITION_RANGE: number;

  // Generation
  readonly GENERATION_BUDGET: number;
  readonly UNLOAD_DELAY_FRAMES: number;
  readonly PENDING_QUEUE_MAX: number;

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
  readonly OCCLUSION_CULLING_ENABLED: boolean;
  readonly FRUSTUM_CULLING_ENABLED: boolean;

  // GPU
  readonly USE_COMPUTE_SHADERS: boolean;
  readonly COMPUTE_WORKGROUP_SIZE: 8 | 16 | 32;
}

/**
 * Result of configuration validation against device capabilities
 */
export interface ConfigValidation {
  readonly isValid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly adjustedConfig: TerrainConfig;
  readonly appliedOverrides: readonly string[];
}

/**
 * Engine initialization state
 */
export type EngineInitState =
  | 'uninitialized' // Nothing created
  | 'initializing' // Requesting WebGPU device
  | 'ready' // Ready to generate terrain
  | 'fallback' // WebGPU not available, CPU mode
  | 'failed'; // Unrecoverable error

/**
 * WebGPU device capabilities detected
 */
export interface GPUCapabilities {
  readonly maxBufferSize: number;
  readonly maxComputeWorkgroupSize: number;
  readonly maxComputeInvocations: number;
  readonly maxStorageBufferBindingSize: number;
  readonly supportsTimestampQuery: boolean;
  readonly supportsOcclusionQuery: boolean;
  readonly vendor: string; // "nvidia", "amd", "intel", "apple", "unknown"
  readonly adapterInfo: unknown;
}

/**
 * References to global WebGPU resources (not per chunk)
 * Singleton handled by TerrainEngine
 */
export interface GlobalGPUResources {
  readonly device: unknown; // GPUDevice
  readonly queue: unknown; // GPUQueue
  readonly presentationFormat: string;

  // Reusable Pipelines
  readonly elevationPipeline: unknown;
  readonly normalPipeline: unknown;

  // Layouts (CPU-GPU contracts)
  readonly bindGroupLayout: unknown;
  readonly pipelineLayout: unknown;

  // Global buffers
  readonly noiseParamsBuffer: unknown;
  readonly cameraBuffer: unknown;
}

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
 * Queued generation request
 * The ChunkManager converts pending ChunkCoords into these requests
 */
export interface GenerationRequest {
  readonly coord: ChunkCoord;
  readonly priority: number;
  readonly frameRequested: number;
  readonly attempts: number;
}

/**
 * Result of the elevation stage (compute shader)
 * Intermediate before calculating normals
 */
export interface ElevationResult {
  readonly heightmap: Float32Array;
  readonly minHeight: number;
  readonly maxHeight: number;
}

/**
 * Land lifecycle events
 * For debugging and external metrics
 */
export interface TerrainEventMap {
  'chunk-generated': { coord: ChunkCoord; timeMs: number };
  'chunk-unloaded': { coord: ChunkCoord; lifetimeFrames: number };
  'lod-changed': { from: ChunkLOD; to: ChunkLOD; chunkKey: string };
  'gpu-error': { error: Error; fatal: boolean };
  'fallback-activated': { reason: string };
  'config-adjusted': {
    original: Partial<TerrainConfig>;
    adjusted: TerrainConfig;
    reasons: string[];
  };
}

/**
 * TerrainEngine initialization options
 */
export interface TerrainEngineOptions {
  readonly canvas: HTMLCanvasElement;
  readonly config?: Partial<TerrainConfig>;
  readonly onEvent?: <K extends keyof TerrainEventMap>(type: K, data: TerrainEventMap[K]) => void;
}

/**
 * Performance snapshot for debugging
 */
export interface PerformanceSnapshot {
  readonly timestamp: number;
  readonly frameTimeMs: number;
  readonly gpuTimeMs: number;
  readonly chunksRendered: number;
  readonly chunksVisible: number;
  readonly trianglesDrawn: number;
  readonly drawCalls: number;
  readonly memoryGPU: number;
}

/**
 * Constant engine defaults
 * Exported for testing and partial overrides
 */
export const DEFAULT_TERRAIN_CONFIG: Readonly<TerrainConfig> = {
  CHUNK_SIZE: 128,
  MAX_CHUNKS: 1024,
  CHUNK_RESOLUTIONS: { 0: 64, 1: 32, 2: 16, 3: 8 },
  LOD_DISTANCES: [600, 1500, 3000],
  LOD_TRANSITION_RANGE: 50,
  GENERATION_BUDGET: 4,
  UNLOAD_DELAY_FRAMES: 60,
  PENDING_QUEUE_MAX: 128,
  NOISE_SEED: 12345,
  NOISE_OCTAVES: 6,
  NOISE_PERSISTENCE: 0.5,
  NOISE_LACUNARITY: 2.0,
  NOISE_WARP_ENABLED: true,
  NOISE_WARP_STRENGTH: 0.3,
  NOISE_WARP_OCTAVES: 2,
  NOISE_WARP_SCALE: 0.5,
  TERRAIN_HEIGHT_SCALE: 100,
  TERRAIN_OFFSET_Y: 0,
  SEAM_FITTING_ENABLED: true,
  OCCLUSION_CULLING_ENABLED: false,
  FRUSTUM_CULLING_ENABLED: true,
  USE_COMPUTE_SHADERS: true,
  COMPUTE_WORKGROUP_SIZE: 8,
} as const;

/**
 * System hard limits for validation
 */
export const TERRAIN_LIMITS = {
  MIN_CHUNK_SIZE: 32,
  MAX_CHUNK_SIZE: 512,
  MIN_RESOLUTION: 4,
  MAX_RESOLUTION: 256,
  MAX_LOD_LEVELS: 4,
  MAX_GENERATION_BUDGET: 8,
  MIN_UNLOAD_DELAY: 10,
  MAX_PENDING_QUEUE: 128,
  MAX_WARP_STRENGTH: 1.0,
  MAX_NOISE_OCTAVES: 16,
} as const;
