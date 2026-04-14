import { Injectable, NgZone, inject, signal, computed, Injector } from '@angular/core';
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';

import { ChunkManager } from './chunk-manager';
import { GPUGenerator } from './gpu-generator';
import { SceneGraph } from './scene-graph';
import {
  TerrainConfig,
  DEFAULT_TERRAIN_CONFIG,
  EngineInitState,
  CameraState,
} from '../types/terrain';
import { ChunkSystemState, FrustumPlanes, Chunk, ChunkKey } from '../types/chunk';
import { getChunkKey } from '../math/chunk-coord';

@Injectable()
export class TerrainEngine {
  private readonly ngZone = inject(NgZone);
  private readonly injector = inject(Injector);

  private config: TerrainConfig = DEFAULT_TERRAIN_CONFIG;

  private renderer: WebGPURenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;

  private gpuGenerator: GPUGenerator | null = null;
  private chunkManager: ChunkManager | null = null;
  private sceneGraph: SceneGraph | null = null;

  private initState = signal<EngineInitState>('uninitialized');
  private frameCount = signal<number>(0);
  private lastFrameTime = signal<number>(0);
  private isRunning = false;
  private animationId: number | null = null;

  private canvas: HTMLCanvasElement | null = null;
  private resizeObserver: ResizeObserver | null = null;

  private lastCameraMatrix = new THREE.Matrix4();
  private lastCameraState: CameraState | null = null;
  private lastFrustum: FrustumPlanes | null = null;
  private readonly EPSILON = 0.0001;

  readonly state = computed(() => ({
    initState: this.initState(),
    frameCount: this.frameCount(),
    fps: 1000 / (this.lastFrameTime() || 16),
    isReady: this.initState() === 'ready',
  }));

  readonly chunkState = computed<ChunkSystemState | null>(() => {
    return this.chunkManager?.getChunkSystemState()() ?? null;
  });

  async init(canvas: HTMLCanvasElement, customConfig?: Partial<TerrainConfig>): Promise<boolean> {
    if (this.initState() !== 'uninitialized') {
      console.warn('TerrainEngine already initialized');
      return true;
    }

    this.initState.set('initializing');
    this.canvas = canvas;

    if (customConfig) {
      this.config = { ...DEFAULT_TERRAIN_CONFIG, ...customConfig };
    }

    try {
      await this.initRenderer(canvas);
      this.initScene();
      this.initCamera();
      this.initLights();

      this.gpuGenerator = new GPUGenerator(this.renderer!, this.config);
      this.chunkManager = new ChunkManager(this.config, this.gpuGenerator);
      this.sceneGraph = new SceneGraph(this.scene!, this.config);

      this.setupResizeHandling();

      this.initState.set('ready');
      console.log('TerrainEngine initialized successfully');

      return true;
    } catch (error) {
      console.error('Error initializing TerrainEngine:', error);
      this.initState.set('failed');
      return false;
    }
  }

  private async initRenderer(canvas: HTMLCanvasElement): Promise<void> {
    if (!navigator.gpu) {
      throw new Error('WebGPU is not supported in this browser');
    }

    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance',
    });

    if (!adapter) {
      throw new Error('WebGPU adapter could not be obtained');
    }

    this.renderer = new WebGPURenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });

    await this.renderer.init();

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    this.renderer.setClearColor(0x87ceeb, 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }

  private initScene(): void {
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(
      0x87ceeb,
      this.config.LOD_DISTANCES[1],
      this.config.LOD_DISTANCES[2] * 1.5,
    );
  }

  private initCamera(): void {
    if (!this.canvas) return;

    const aspect = this.canvas.clientWidth / this.canvas.clientHeight;
    this.camera = new THREE.PerspectiveCamera(60, aspect, 0.1, this.config.LOD_DISTANCES[2] * 2);

    this.camera.position.set(0, 100, 0);
    this.camera.lookAt(0, 0, 100);

    this.camera.updateMatrixWorld();
    this.lastCameraMatrix.copy(this.camera.matrixWorld);
  }

  private initLights(): void {
    if (!this.scene) return;

    const ambient = new THREE.AmbientLight(0x404040, 0.5);
    this.scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xffffff, 1);
    sun.position.set(100, 200, 50);
    sun.castShadow = true;

    sun.shadow.mapSize.width = 2048;
    sun.shadow.mapSize.height = 2048;
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 500;
    sun.shadow.camera.left = -200;
    sun.shadow.camera.right = 200;
    sun.shadow.camera.top = 200;
    sun.shadow.camera.bottom = -200;

    this.scene.add(sun);
  }

  private syncSceneGraph(): void {
    const state = this.chunkManager?.getChunkSystemState()();
    if (!state || !this.sceneGraph) return;

    const bestChunksByCoord = new Map<string, Chunk>();

    for (const [key, chunk] of state.activeChunks) {
      const spatialKey = `${chunk.meta.coord.x}:${chunk.meta.coord.z}`;
      const existing = bestChunksByCoord.get(spatialKey);

      const isRenderable = chunk.state === 'ready' || chunk.state === 'unloading';
      if (!isRenderable) continue;

      if (!state.visibleKeys.has(key)) continue;

      if (!existing) {
        bestChunksByCoord.set(spatialKey, chunk);
      } else {
        const currentIsBetterState = chunk.state === 'ready' && existing.state !== 'ready';
        const sameStateBetterLOD =
          chunk.state === existing.state && chunk.meta.coord.lod < existing.meta.coord.lod;

        if (currentIsBetterState || sameStateBetterLOD) {
          bestChunksByCoord.set(spatialKey, chunk);
        }
      }
    }

    const chunksToKeep = new Map<ChunkKey, Chunk>();

    for (const chunk of bestChunksByCoord.values()) {
      const key = getChunkKey(chunk.meta.coord) as ChunkKey;
      chunksToKeep.set(key, chunk);
      this.sceneGraph.addOrUpdateChunk(chunk);
    }

    this.sceneGraph.cleanupInactive(chunksToKeep);
  }

  private setupResizeHandling(): void {
    if (!this.canvas) return;

    this.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        this.handleResize(width, height);
      }
    });

    this.resizeObserver.observe(this.canvas);
  }

  private handleResize(width: number, height: number): void {
    if (!this.camera || !this.renderer) return;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  start(): void {
    if (this.isRunning || this.initState() !== 'ready') return;

    this.isRunning = true;

    this.ngZone.runOutsideAngular(() => {
      this.renderLoop();
    });
  }

  stop(): void {
    this.isRunning = false;
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  private renderLoop = (): void => {
    if (!this.isRunning) return;

    const startTime = performance.now();

    this.update(startTime);

    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }

    const frameTime = performance.now() - startTime;
    this.lastFrameTime.set(frameTime);
    this.frameCount.update((n) => n + 1);

    this.animationId = requestAnimationFrame(this.renderLoop);
  };

  private update(frameTime: number): void {
    if (!this.camera || !this.chunkManager) return;

    const cameraMoved = !this.camera.matrixWorld.equals(this.lastCameraMatrix);

    if (cameraMoved || !this.lastCameraState || !this.lastFrustum) {
      const camState = this.buildCameraState();
      const frustum = this.extractFrustumPlanes(camState);

      this.lastCameraState = camState;
      this.lastFrustum = frustum;
      this.lastCameraMatrix.copy(this.camera.matrixWorld);

      this.chunkManager.update(camState, frustum);
    } else {
      this.chunkManager.update(this.lastCameraState, this.lastFrustum);
    }

    this.syncSceneGraph();
    this.sceneGraph?.update(frameTime);
  }

  private buildCameraState(): CameraState {
    if (!this.camera) throw new Error('Camera not initialized');

    return {
      position: this.camera.position,
      forward: new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion),
      up: this.camera.up,
      right: new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion),
      fov: THREE.MathUtils.degToRad(this.camera.fov),
      aspect: this.camera.aspect,
      near: this.camera.near,
      far: this.camera.far,
      viewMatrix: new Float32Array(this.camera.matrixWorldInverse.elements),
      projectionMatrix: new Float32Array(this.camera.projectionMatrix.elements),
      viewProjectionMatrix: new Float32Array(
        new THREE.Matrix4().multiplyMatrices(
          this.camera.projectionMatrix,
          this.camera.matrixWorldInverse,
        ).elements,
      ),
    };
  }

  private extractFrustumPlanes(camera: CameraState): FrustumPlanes {
    const vp = camera.viewProjectionMatrix;
    const planes = {
      normals: [] as { x: number; y: number; z: number }[],
      constants: [] as number[],
    };

    const extractPlane = (a: number, b: number, c: number, d: number) => {
      const len = Math.sqrt(a * a + b * b + c * c);
      return {
        normal: { x: a / len, y: b / len, z: c / len },
        constant: d / len,
      };
    };

    let p = extractPlane(vp[3] + vp[0], vp[7] + vp[4], vp[11] + vp[8], vp[15] + vp[12]);
    planes.normals.push(p.normal);
    planes.constants.push(p.constant);

    p = extractPlane(vp[3] - vp[0], vp[7] - vp[4], vp[11] - vp[8], vp[15] - vp[12]);
    planes.normals.push(p.normal);
    planes.constants.push(p.constant);

    p = extractPlane(vp[3] - vp[1], vp[7] - vp[5], vp[11] - vp[9], vp[15] - vp[13]);
    planes.normals.push(p.normal);
    planes.constants.push(p.constant);

    p = extractPlane(vp[3] + vp[1], vp[7] + vp[5], vp[11] + vp[9], vp[15] + vp[13]);
    planes.normals.push(p.normal);
    planes.constants.push(p.constant);

    p = extractPlane(vp[3] + vp[2], vp[7] + vp[6], vp[11] + vp[10], vp[15] + vp[14]);
    planes.normals.push(p.normal);
    planes.constants.push(p.constant);

    p = extractPlane(vp[3] - vp[2], vp[7] - vp[6], vp[11] - vp[10], vp[15] - vp[14]);
    planes.normals.push(p.normal);
    planes.constants.push(p.constant);

    return planes as FrustumPlanes;
  }

  setCameraPosition(x: number, y: number, z: number): void {
    this.camera?.position.set(x, y, z);
  }

  getTerrainHeightAt(x: number, z: number): number | null {
    return this.chunkManager?.getTerrainHeightAt(x, z) ?? null;
  }

  lookAt(x: number, y: number, z: number): void {
    this.camera?.lookAt(x, y, z);
  }

  dispose(): void {
    this.stop();

    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    this.chunkManager?.dispose();
    this.chunkManager = null;

    this.gpuGenerator?.dispose();
    this.gpuGenerator = null;

    this.sceneGraph?.dispose();
    this.sceneGraph = null;

    this.renderer?.dispose();
    this.renderer = null;

    this.scene = null;
    this.camera = null;
    this.canvas = null;

    this.initState.set('uninitialized');
  }
}
