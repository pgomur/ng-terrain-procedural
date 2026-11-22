import { Injectable, signal, computed } from '@angular/core';
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { cameraWorldMatrix, fog, positionView, smoothstep, uniform, vec4 } from 'three/tsl';

import { ChunkManager } from './chunk-manager';
import { GPUGenerator } from './gpu-generator';
import { SceneGraph, SHADOW_CASTER_LAYER } from './scene-graph';
import { SKY_HORIZON_COLOR, createSkyDome, skyColor } from '../shaders/sky.tsl';
import { FrameStatsCollector } from './frame-stats';
import { SUN_DIRECTION, SunLight } from './sun-light';
import { FrameCallback, LoadingStage, TerrainEngineStats } from '../types/engine';
import { TerrainConfig, DEFAULT_TERRAIN_CONFIG, EngineInitState, CameraState } from '../types/terrain';
import { Chunk, FrustumPlanes, WorldPosition } from '../types/chunk';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const MAX_FRAME_DELTA_S = 0.1;
const CAMERA_NEAR = 1;
const MAX_PIXEL_RATIO = 2;
const INITIAL_LOAD_MAX_LOD = 1;
const INITIAL_LOAD_TIMEOUT_MS = 10_000;

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  });
}

export function isWebGPUBackend(backend: unknown): boolean {
  return (backend as { readonly isWebGPUBackend?: boolean } | null)?.isWebGPUBackend === true;
}

function currentPixelRatio(): number {
  return Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
}

@Injectable()
export class TerrainEngine {
  private config: TerrainConfig = DEFAULT_TERRAIN_CONFIG;

  private renderer: WebGPURenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;

  private gpuGenerator: GPUGenerator<Chunk> | null = null;
  private chunkManager: ChunkManager | null = null;
  private sceneGraph: SceneGraph | null = null;

  private readonly initStateSignal = signal<EngineInitState>('uninitialized');
  private readonly statsSignal = signal<TerrainEngineStats | null>(null);
  private readonly loadingStageSignal = signal<LoadingStage>('device');
  private readonly loadingProgressSignal = signal(0);
  private loadingStart = -1;

  readonly initState = this.initStateSignal.asReadonly();
  readonly loadingStage = this.loadingStageSignal.asReadonly();
  readonly loadingProgress = this.loadingProgressSignal.asReadonly();
  readonly isReady = computed(() => this.initStateSignal() === 'ready');
  readonly stats = this.statsSignal.asReadonly();

  private isRunning = false;
  private initGeneration = 0;
  private animationId: number | null = null;
  private lastLoopTime = -1;
  private frameCallback: FrameCallback | null = null;

  private canvas: HTMLCanvasElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private observedWidth = 0;
  private observedHeight = 0;
  private appliedWidth = 0;
  private appliedHeight = 0;
  private appliedPixelRatio = 0;

  private viewInitialized = false;
  private readonly lastCameraMatrix = new THREE.Matrix4();
  private readonly lastProjectionMatrix = new THREE.Matrix4();
  private readonly viewProjection = new THREE.Matrix4();
  private readonly frustum = new THREE.Frustum();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private cameraState: Mutable<CameraState> | null = null;
  private readonly frustumNormals: Mutable<WorldPosition>[] = Array.from({ length: 6 }, () => ({
    x: 0,
    y: 0,
    z: 0,
  }));
  private readonly frustumConstants: number[] = [0, 0, 0, 0, 0, 0];
  private readonly frustumPlanes: FrustumPlanes = {
    normals: this.frustumNormals,
    constants: this.frustumConstants,
  };

  private fogNear = 0;
  private fogFar = 0;
  private sunLight: SunLight | null = null;
  private readonly frameStats = new FrameStatsCollector();

  async init(canvas: HTMLCanvasElement, customConfig?: Partial<TerrainConfig>): Promise<boolean> {
    if (this.initStateSignal() !== 'uninitialized') {
      console.warn('TerrainEngine already initialized');
      return this.initStateSignal() === 'ready';
    }

    const generation = ++this.initGeneration;

    this.initStateSignal.set('initializing');
    this.loadingStageSignal.set('device');
    this.loadingProgressSignal.set(0);
    this.loadingStart = -1;
    this.canvas = canvas;

    if (customConfig) {
      this.config = { ...DEFAULT_TERRAIN_CONFIG, ...customConfig };
    }

    try {
      const renderer = await this.createRenderer(canvas);
      if (generation !== this.initGeneration) {
        renderer.dispose();
        return false;
      }
      this.renderer = renderer;

      this.loadingStageSignal.set('shaders');
      await nextPaint();
      if (generation !== this.initGeneration) return false;

      const scene = this.initScene();
      this.initCamera();
      this.initLights();

      this.gpuGenerator = new GPUGenerator<Chunk>(this.renderer, this.config);
      this.chunkManager = new ChunkManager(this.config, this.gpuGenerator);
      this.sceneGraph = new SceneGraph(scene, this.config, this.gpuGenerator);

      this.prewarmPipelines();

      this.setupResizeHandling();

      this.loadingStageSignal.set('terrain');
      this.initStateSignal.set('ready');

      return true;
    } catch (error) {
      if (generation !== this.initGeneration) return false;
      console.error('Error initializing TerrainEngine:', error);
      this.initStateSignal.set('failed');
      return false;
    }
  }

  private async createRenderer(canvas: HTMLCanvasElement): Promise<WebGPURenderer> {
    const gpu = navigator.gpu as GPU | undefined;
    if (!gpu) {
      throw new Error('WebGPU is not supported in this browser');
    }

    const renderer = new WebGPURenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });

    try {
      await renderer.init();
    } catch (error) {
      renderer.dispose();
      throw error;
    }

    if (!isWebGPUBackend(renderer.backend)) {
      renderer.dispose();
      throw new Error('WebGPU could not be initialized and the WebGL 2 fallback cannot run this engine');
    }

    this.observedWidth = canvas.clientWidth;
    this.observedHeight = canvas.clientHeight;
    this.appliedPixelRatio = currentPixelRatio();
    this.appliedWidth = Math.max(1, this.observedWidth);
    this.appliedHeight = Math.max(1, this.observedHeight);
    renderer.setPixelRatio(this.appliedPixelRatio);
    renderer.setSize(this.appliedWidth, this.appliedHeight, false);
    renderer.setClearColor(SKY_HORIZON_COLOR, 1);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    return renderer;
  }

  private loadRadius(): number {
    return Math.max(...this.config.LOD_DISTANCES) * 1.2;
  }

  private worldEdgeDistance(): number {
    return this.loadRadius() - this.config.CHUNK_SIZE * Math.SQRT1_2;
  }

  private initScene(): THREE.Scene {
    const scene = new THREE.Scene();
    this.scene = scene;

    this.fogFar = this.worldEdgeDistance();
    this.fogNear = Math.min(this.config.LOD_DISTANCES[1], this.fogFar * 0.5);

    const distance = positionView.length();
    const viewDirection = cameraWorldMatrix.mul(vec4(positionView, 0.0)).xyz.normalize();
    scene.add(createSkyDome(SUN_DIRECTION));
    Object.assign(scene, {
      fogNode: fog(
        skyColor(viewDirection, SUN_DIRECTION, { sunDisk: false, clouds: false }),
        smoothstep(uniform(this.fogNear), uniform(this.fogFar), distance),
      ),
    });

    return scene;
  }

  private initCamera(): void {
    if (!this.canvas) return;

    const aspect = this.appliedWidth / this.appliedHeight;
    const far = this.loadRadius() + this.config.CHUNK_SIZE * Math.SQRT2;
    this.camera = new THREE.PerspectiveCamera(60, aspect, CAMERA_NEAR, far);

    this.camera.position.set(0, 100, 0);
    this.camera.lookAt(0, 0, 100);

    this.camera.updateMatrixWorld();
  }

  private initLights(): void {
    if (!this.scene) return;

    this.sunLight = new SunLight(this.config, SHADOW_CASTER_LAYER);
    this.sunLight.addTo(this.scene);
    this.updateSun();
  }

  private updateSun(): void {
    if (!this.sunLight || !this.camera) return;

    const position = this.camera.position;
    this.sunLight.follow(position);
    this.sceneGraph?.setShadowRegion(position.x, position.z, this.sunLight.shadowRegionRadius(position.y));
  }

  private prewarmPipelines(): void {
    if (!this.renderer || !this.scene || !this.camera || !this.gpuGenerator || !this.sceneGraph) {
      return;
    }

    this.gpuGenerator.prewarm();
    this.sceneGraph.prewarm(this.gpuGenerator.getPages());
    this.camera.updateMatrixWorld(true);
    this.renderer.render(this.scene, this.camera);
    this.sceneGraph.endPrewarm();
  }

  private setupResizeHandling(): void {
    if (!this.canvas) return;

    this.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        this.observedWidth = entry.contentRect.width;
        this.observedHeight = entry.contentRect.height;
      }
    });

    this.resizeObserver.observe(this.canvas);
  }

  private syncViewportSize(): void {
    if (!this.camera || !this.renderer) return;

    const width = Math.floor(this.observedWidth);
    const height = Math.floor(this.observedHeight);
    if (width <= 0 || height <= 0) return;

    const pixelRatio = currentPixelRatio();
    if (width === this.appliedWidth && height === this.appliedHeight && pixelRatio === this.appliedPixelRatio) {
      return;
    }

    this.appliedWidth = width;
    this.appliedHeight = height;
    this.appliedPixelRatio = pixelRatio;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
  }

  setFrameCallback(callback: FrameCallback | null): void {
    this.frameCallback = callback;
  }

  start(): void {
    if (this.isRunning || this.initStateSignal() !== 'ready') return;

    this.isRunning = true;
    this.lastLoopTime = -1;
    this.frameStats.restart();

    this.animationId = requestAnimationFrame(this.renderLoop);
  }

  stop(): void {
    this.isRunning = false;
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  private renderLoop = (time: number): void => {
    if (!this.isRunning) return;

    if (this.lastLoopTime >= 0) this.frameStats.recordInterval(time - this.lastLoopTime);

    const delta =
      this.lastLoopTime < 0 ? 0 : Math.min(Math.max((time - this.lastLoopTime) / 1000, 0), MAX_FRAME_DELTA_S);
    this.lastLoopTime = time;

    const cpuStart = performance.now();

    this.syncViewportSize();
    this.frameCallback?.(delta);
    this.update();
    this.trackInitialLoad(time);

    if (this.renderer && this.scene && this.camera) {
      this.renderer.info.reset();
      this.renderer.render(this.scene, this.camera);
      this.frameStats.recordRender(this.renderer.info.render.drawCalls, this.renderer.info.render.triangles);
    }

    this.publishStats(time, performance.now() - cpuStart);

    this.animationId = requestAnimationFrame(this.renderLoop);
  };

  private trackInitialLoad(time: number): void {
    if (this.loadingStageSignal() !== 'terrain' || !this.chunkManager) return;
    if (this.loadingStart < 0) this.loadingStart = time;

    const { ready, wanted } = this.chunkManager.getLoadProgress(INITIAL_LOAD_MAX_LOD);
    const progress = wanted > 0 ? ready / wanted : 0;
    if (progress !== this.loadingProgressSignal()) this.loadingProgressSignal.set(progress);

    if ((wanted > 0 && ready >= wanted) || time - this.loadingStart > INITIAL_LOAD_TIMEOUT_MS) {
      this.loadingProgressSignal.set(1);
      this.loadingStageSignal.set('done');
    }
  }

  private update(): void {
    if (!this.camera || !this.chunkManager || !this.sceneGraph) return;

    this.camera.updateMatrixWorld(true);

    const viewChanged =
      !this.viewInitialized ||
      !this.camera.matrixWorld.equals(this.lastCameraMatrix) ||
      !this.camera.projectionMatrix.equals(this.lastProjectionMatrix);

    if (viewChanged) {
      this.refreshCameraState(this.camera);
      this.refreshFrustumPlanes(this.camera);
      this.lastCameraMatrix.copy(this.camera.matrixWorld);
      this.lastProjectionMatrix.copy(this.camera.projectionMatrix);
      this.viewInitialized = true;
    }

    this.updateSun();

    const streamingStart = performance.now();
    if (!this.cameraState) return;

    this.chunkManager.update(this.cameraState, this.frustumPlanes, viewChanged);

    this.sceneGraph.sync(
      this.chunkManager.getChunks(),
      this.chunkManager.getVisibleKeys(),
      this.chunkManager.getDirtyCoords(),
      this.chunkManager.getVisibilityToggled(),
    );
    this.chunkManager.clearRenderChanges();
    this.frameStats.addStreaming(performance.now() - streamingStart);
  }

  private refreshCameraState(camera: THREE.PerspectiveCamera): void {
    this.forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
    this.right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

    this.cameraState ??= {
      position: camera.position,
      forward: this.forward,
      up: camera.up,
      right: this.right,
      fov: 0,
      aspect: 0,
      near: 0,
      far: 0,
      viewMatrix: new Float32Array(16),
      projectionMatrix: new Float32Array(16),
      viewProjectionMatrix: new Float32Array(16),
    };

    const state = this.cameraState;
    state.fov = THREE.MathUtils.degToRad(camera.fov);
    state.aspect = camera.aspect;
    state.near = camera.near;
    state.far = camera.far;
    state.viewMatrix.set(camera.matrixWorldInverse.elements);
    state.projectionMatrix.set(camera.projectionMatrix.elements);
    state.viewProjectionMatrix.set(this.viewProjection.elements);
  }

  /**
   * Extracts the frustum planes of the current camera.
   * Uses Three.js native infrastructure for robustness with WebGPU.
   */
  private refreshFrustumPlanes(camera: THREE.PerspectiveCamera): void {
    this.frustum.setFromProjectionMatrix(this.viewProjection, camera.coordinateSystem, camera.reversedDepth);

    for (let i = 0; i < 6; i++) {
      const plane = this.frustum.planes[i];
      const normal = this.frustumNormals[i];
      normal.x = plane.normal.x;
      normal.y = plane.normal.y;
      normal.z = plane.normal.z;
      this.frustumConstants[i] = plane.constant;
    }
  }

  private publishStats(time: number, cpuMs: number): void {
    if (!this.camera || !this.chunkManager || !this.gpuGenerator || !this.sceneGraph || !this.renderer) return;

    const snapshot = this.frameStats.endFrame(time, cpuMs, {
      camera: this.camera,
      chunkManager: this.chunkManager,
      gpuGenerator: this.gpuGenerator,
      sceneGraph: this.sceneGraph,
      renderer: this.renderer,
      config: this.config,
      width: this.appliedWidth,
      height: this.appliedHeight,
      pixelRatio: this.appliedPixelRatio,
    });
    if (snapshot) this.statsSignal.set(snapshot);
  }

  setCameraPosition(x: number, y: number, z: number): void {
    this.camera?.position.set(x, y, z);
  }

  getCameraDirection(target: THREE.Vector3): THREE.Vector3 {
    if (!this.camera) return target.set(0, 0, -1);
    return this.camera.getWorldDirection(target);
  }

  getTerrainHeightAt(x: number, z: number): number | null {
    return this.chunkManager?.getTerrainHeightAt(x, z) ?? null;
  }

  lookAt(x: number, y: number, z: number): void {
    this.camera?.lookAt(x, y, z);
  }

  dispose(): void {
    this.initGeneration++;
    this.stop();
    this.frameCallback = null;

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
    this.sunLight = null;
    this.camera = null;
    this.canvas = null;
    this.cameraState = null;
    this.viewInitialized = false;

    this.statsSignal.set(null);
    this.initStateSignal.set('uninitialized');
  }
}
