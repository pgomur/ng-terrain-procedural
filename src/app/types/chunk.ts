export interface FrustumPlanes {
  readonly normals: readonly WorldPosition[];
  readonly constants: readonly number[];
}

export interface ChunkCoord {
  readonly x: number;
  readonly z: number;
  readonly lod: ChunkLOD;
}

export type ChunkLOD = 0 | 1 | 2 | 3;

export type ChunkState = 'generating' | 'ready' | 'unloading' | 'error';

export interface ChunkMeta {
  readonly coord: ChunkCoord;
  readonly spatialKey: string;
  readonly resolution: number;
}

export interface WorldPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ChunkBounds {
  readonly min: WorldPosition;
  readonly max: WorldPosition;
}

export interface ChunkGPUResources {
  readonly pageId: number;
  readonly slot: number;
  readonly generation: number;
  readonly resolution: number;
}

export interface ChunkMetrics {
  lastAccessed: number;
}

export interface Chunk {
  readonly meta: ChunkMeta;
  bounds: ChunkBounds;

  state: ChunkState;
  gpu: ChunkGPUResources | null;
  metrics: ChunkMetrics;

  heights?: Float32Array;

  failure?: ChunkFailure;
}

export interface ChunkFailure {
  readonly attempts: number;
  readonly retryAt: number;
}

export interface StreamingRequest {
  readonly key: ChunkKey;
  readonly coord: ChunkCoord;
  score: number;
  attempts: number;
}

export type ChunkKey = `${number}:${number}:${ChunkLOD}`;
