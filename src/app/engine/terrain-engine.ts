/**
 * The engine that runs the terrain, and the only part of it the rest of the application talks to.
 *
 * {@link TerrainEngine} is an Angular service provided per component. It owns the `WebGPURenderer`, the scene, the camera, the sun and the sky, creates the three parts that do the actual work and calls them in a fixed order every frame:
 *
 * | Part | Role in the frame |
 * | --- | --- |
 * | {@link engine/chunk-manager!ChunkManager | ChunkManager} | Decides which chunks exist and which are visible, and generates the missing ones. |
 * | {@link engine/gpu-generator!GPUGenerator | GPUGenerator} | Holds the heights on the GPU and runs the compute shaders. |
 * | {@link engine/scene-graph!SceneGraph | SceneGraph} | Turns the visible chunks into instanced meshes. |
 *
 * Everything the application needs is exposed as Angular signals ({@link TerrainEngine.initState}, {@link TerrainEngine.loadingStage}, {@link TerrainEngine.loadingProgress}, {@link TerrainEngine.stats}) and a few camera methods, so a component never touches Three.js objects.
 *
 * Its life cycle is `init` → `start` → (`stop` / `start`)* → `dispose`. A lost GPU device stops the loop and sets the state to `lost`.
 *
 * See [Architecture](../../../guides/architecture.md) for the frame loop step by step, and [Embedding the terrain](../../../guides/embedding.md) for using it from a component.
 *
 * @module
 */
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
import { EngineInitState, FrameCallback, LoadingStage, TerrainEngineStats } from '../types/engine';
import { TerrainConfig, DEFAULT_TERRAIN_CONFIG } from '../types/terrain';
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

function isWebGPUBackend(backend: unknown): boolean {
  return (backend as { readonly isWebGPUBackend?: boolean } | null)?.isWebGPUBackend === true;
}

function releaseRenderer(renderer: WebGPURenderer): void {
  renderer.dispose().catch(() => undefined);
}

function currentPixelRatio(): number {
  return Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
}

/**
 * Runs the terrain: owns the WebGPU renderer, the scene, the camera and the frame loop, and connects the streaming, the GPU generator and the scene graph.
 *
 * Provided per {@link terrain/terrain.component!TerrainComponent | TerrainComponent}. Call {@link TerrainEngine.init} with a canvas, then {@link TerrainEngine.start}; each frame then runs the frame callback, streams and renders. Its state, loading progress and diagnostics are exposed as signals.
 *
 * Created by Angular's injector, never with `new`: provide it in a component's `providers` and `inject` it.
 *
 * @example
 * A component that runs its own engine and orbits the origin:
 *
 * ```ts
 * @Component({
 *   selector: 'app-orbit',
 *   template: '<canvas #canvas></canvas>',
 *   providers: [TerrainEngine],
 * })
 * export class OrbitComponent implements AfterViewInit, OnDestroy {
 *   private readonly engine = inject(TerrainEngine);
 *   private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
 *
 *   async ngAfterViewInit(): Promise<void> {
 *     if (!(await this.engine.init(this.canvas().nativeElement, { NOISE_SEED: 7 }))) return;
 *
 *     let angle = 0;
 *     this.engine.setFrameCallback((delta) => {
 *       angle += delta * 0.1;
 *       this.engine.setCameraPosition(Math.cos(angle) * 800, 250, Math.sin(angle) * 800);
 *       this.engine.lookAt(0, 0, 0);
 *     });
 *     this.engine.start();
 *   }
 *
 *   ngOnDestroy(): void {
 *     this.engine.dispose();
 *   }
 * }
 * ```
 *
 * @hideconstructor
 */
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

  /**
   * Initialisation state.
   *
   * Use {@link TerrainEngine.isReady} for the common check. See {@link types/engine!EngineInitState | EngineInitState} for the transitions.
   */
  readonly initState = this.initStateSignal.asReadonly();
  /**
   * Current stage of the loading screen.
   *
   * Moves through `device`, `shaders` and `terrain` during start-up, then stays at `done`. See {@link types/engine!LoadingStage | LoadingStage}.
   */
  readonly loadingStage = this.loadingStageSignal.asReadonly();
  /**
   * Fraction of the chunks up to LOD 1 around the camera that are ready, from 0 to 1, during the `terrain` stage.
   *
   * It counts the same chunks the loading screen waits for. It is `0` before the `terrain` stage and becomes `1` when loading is `done`, also when the 10-second limit ended it early.
   */
  readonly loadingProgress = this.loadingProgressSignal.asReadonly();
  /**
   * Whether the engine is initialised and usable.
   */
  readonly isReady = computed(() => this.initStateSignal() === 'ready');
  /**
   * Latest diagnostics, published four times per second while running, or `null` before the first window and after disposal.
   *
   * Each snapshot is a new object, so `computed` and `effect` that read it re-run four times per second. See [Diagnostics panel](../../../guides/diagnostics.md).
   */
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

  /**
   * Creates the WebGPU renderer on a canvas, builds the scene and compiles the pipelines.
   *
   * Only the first call has an effect; later calls return whether that one succeeded. If the engine is disposed while initialising, the pending call returns `false` and leaves nothing behind.
   *
   * Initialisation goes through the loading stages: `device` while the WebGPU device is requested, then, after one paint so the new status is visible, `shaders` while the scene is built and every compute and render pipeline is compiled. If the renderer would fall back to WebGL 2, initialisation fails: the engine needs storage buffers in the vertex stage. Errors are logged and reported through the return value and {@link TerrainEngine.initState}; the method never throws.
   *
   * @param canvas - Canvas to render into. Its size is tracked with a `ResizeObserver`.
   * @param customConfig - Options that replace those of {@link types/terrain!DEFAULT_TERRAIN_CONFIG | DEFAULT_TERRAIN_CONFIG}.
   * @returns `true` when the engine is ready, `false` when WebGPU is not available or initialisation failed.
   */
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
        releaseRenderer(renderer);
        return false;
      }
      this.renderer = renderer;
      this.watchDeviceLoss(renderer, generation);

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

      if (generation !== this.initGeneration) return false;

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

  private watchDeviceLoss(renderer: WebGPURenderer, generation: number): void {
    const device = (renderer.backend as { readonly device?: GPUDevice }).device;
    void device?.lost.then((info) => {
      if (generation !== this.initGeneration) return;
      this.handleDeviceLost(info.message);
    });
  }

  private handleDeviceLost(message: string): void {
    console.error('TerrainEngine: GPU device lost:', message);
    this.initGeneration++;
    this.stop();
    this.statsSignal.set(null);
    this.initStateSignal.set('lost');
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
      releaseRenderer(renderer);
      throw error;
    }

    if (!isWebGPUBackend(renderer.backend)) {
      releaseRenderer(renderer);
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
    renderer.shadowMap.type = THREE.PCFShadowMap;

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

  /**
   * Sets the function called at the start of every frame, before streaming and rendering. Used for camera controls.
   *
   * The callback receives the time since the previous frame in seconds, `0` on the first frame and at most `0.1`. Only one callback is kept: setting a new one replaces the previous one. Moving the camera inside it is the way to drive the view, because the streaming and culling of the same frame then use the new position. See {@link types/engine!FrameCallback | FrameCallback}.
   *
   * @param callback - Callback, or `null` to remove it.
   */
  setFrameCallback(callback: FrameCallback | null): void {
    this.frameCallback = callback;
  }

  /**
   * Starts the frame loop. Does nothing unless the engine is ready, or when it is already running.
   *
   * The first frame after starting reports a delta of `0`, so time spent stopped does not move the camera, and the statistics window starts again.
   */
  start(): void {
    if (this.isRunning || this.initStateSignal() !== 'ready') return;

    this.isRunning = true;
    this.lastLoopTime = -1;
    this.frameStats.restart();

    this.animationId = requestAnimationFrame(this.renderLoop);
  }

  /**
   * Stops the frame loop. Nothing is released; {@link TerrainEngine.start} resumes it.
   *
   * The GPU resources, the chunks and the signals keep their values, and the canvas keeps showing the last frame.
   */
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
      this.refreshFrustumPlanes(this.camera);
      this.lastCameraMatrix.copy(this.camera.matrixWorld);
      this.lastProjectionMatrix.copy(this.camera.projectionMatrix);
      this.viewInitialized = true;
    }

    this.updateSun();

    const streamingStart = performance.now();
    this.chunkManager.update(this.camera.position, this.frustumPlanes, viewChanged);

    this.sceneGraph.sync(
      this.chunkManager.getChunks(),
      this.chunkManager.getVisibleKeys(),
      this.chunkManager.getDirtyCoords(),
      this.chunkManager.getVisibilityToggled(),
    );
    this.chunkManager.clearRenderChanges();
    this.frameStats.addStreaming(performance.now() - streamingStart);
  }

  private refreshFrustumPlanes(camera: THREE.PerspectiveCamera): void {
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
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

  /**
   * Moves the camera.
   *
   * The camera moves at once; streaming and culling follow it in the next update, which is the same frame when this is called from the frame callback. Nothing prevents placing the camera below the terrain; {@link TerrainEngine.getTerrainHeightAt} gives the ground height to check against. Does nothing before {@link TerrainEngine.init}.
   *
   * @param x - Position along X, in world units.
   * @param y - Height, in world units.
   * @param z - Position along Z, in world units.
   */
  setCameraPosition(x: number, y: number, z: number): void {
    this.camera?.position.set(x, y, z);
  }

  /**
   * Writes the camera's view direction into a vector.
   *
   * The vector is a unit vector in world space. Passing a reused vector avoids an allocation per call, which matters when it is called every frame.
   *
   * @param target - Vector that receives the direction.
   * @returns `target`, set to `(0, 0, -1)` before the camera exists.
   */
  getCameraDirection(target: THREE.Vector3): THREE.Vector3 {
    if (!this.camera) return target.set(0, 0, -1);
    return this.camera.getWorldDirection(target);
  }

  /**
   * Height of the rendered terrain at a world position. See {@link engine/chunk-manager!ChunkManager.getTerrainHeightAt | ChunkManager.getTerrainHeightAt}.
   *
   * Heights are copied to the CPU only for the 3 × 3 chunks around the camera, and kept until those chunks are released. Positions the camera has not been near return `null`.
   *
   * @param x - Position along X, in world units.
   * @param z - Position along Z, in world units.
   * @returns The height in world units, or `null` when it is not available yet.
   */
  getTerrainHeightAt(x: number, z: number): number | null {
    return this.chunkManager?.getTerrainHeightAt(x, z) ?? null;
  }

  /**
   * Turns the camera to look at a point.
   *
   * Use it after {@link TerrainEngine.setCameraPosition}, since the direction is computed from the camera's current position. Does nothing before {@link TerrainEngine.init}.
   *
   * @param x - Point along X, in world units.
   * @param y - Point height, in world units.
   * @param z - Point along Z, in world units.
   */
  lookAt(x: number, y: number, z: number): void {
    this.camera?.lookAt(x, y, z);
  }

  /**
   * Stops the loop, cancels a pending initialisation and releases every GPU resource. The engine returns to `uninitialized`.
   *
   * Called by {@link terrain/terrain.component!TerrainComponent | TerrainComponent} when it is destroyed. The frame callback and the resize observer are removed too, the statistics go back to `null`, and the canvas can be given to a new engine.
   */
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

    if (this.renderer) releaseRenderer(this.renderer);
    this.renderer = null;

    this.scene = null;
    this.sunLight = null;
    this.camera = null;
    this.canvas = null;
    this.viewInitialized = false;

    this.statsSignal.set(null);
    this.initStateSignal.set('uninitialized');
  }
}
