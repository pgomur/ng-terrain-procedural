export type EngineInitState = 'uninitialized' | 'initializing' | 'ready' | 'failed' | 'lost';

export interface TerrainEngineStats {
  readonly fps: number;
  readonly frameMs: number;
  readonly maxFrameMs: number;
  readonly cpuFrameMs: number;
  readonly chunkUpdateMs: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly renderWidth: number;
  readonly renderHeight: number;
  readonly pixelRatio: number;
  readonly visibleChunks: number;
  readonly visibleByLod: readonly number[];
  readonly readyChunks: number;
  readonly unloadingChunks: number;
  readonly generatedPerSecond: number;
  readonly pendingChunks: number;
  readonly queueUsage: number;
  readonly failedChunks: number;
  readonly atlasBytes: number;
  readonly stagingBytes: number;
  readonly geometryBytes: number;
  readonly terrainBufferBytes: number;
  readonly cameraX: number;
  readonly cameraY: number;
  readonly cameraZ: number;
  readonly heightAboveGround: number | null;
  readonly headingDeg: number;
  readonly pitchDeg: number;
  readonly cameraSpeed: number;
  readonly chunkX: number;
  readonly chunkZ: number;
  readonly seed: number;
}

export type FrameCallback = (deltaSeconds: number) => void;

export type LoadingStage = 'device' | 'shaders' | 'terrain' | 'done';
