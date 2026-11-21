import { Injectable, signal, computed } from '@angular/core';
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { cameraWorldMatrix, fog, normalWorldGeometry, positionView, smoothstep, uniform, vec4 } from 'three/tsl';

import { ChunkManager } from './chunk-manager';
import { GPUGenerator } from './gpu-generator';
import { SceneGraph, SHADOW_CASTER_LAYER } from './scene-graph';
import { SKY_HORIZON_COLOR, skyColor } from '../shaders/sky.tsl';
import { TerrainConfig, DEFAULT_TERRAIN_CONFIG, EngineInitState, CameraState } from '../types/terrain';
import { Chunk, FrustumPlanes, WorldPosition } from '../types/chunk';

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
  readonly exactBoundsChunks: number;
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

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface BufferBackend {
  has?(resource: object): boolean;
  get?(resource: object): { readonly buffer?: GPUBuffer } | undefined;
}

const MAX_FRAME_DELTA_S = 0.1;
const STATS_INTERVAL_MS = 250;
const SHADOW_MAP_SIZE = 2048;
const CAMERA_NEAR = 1;
const SUN_DIRECTION = new THREE.Vector3(100, 200, 50).normalize();
const MAX_PIXEL_RATIO = 2;

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

  readonly initState = this.initStateSignal.asReadonly();
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
  private sun: THREE.DirectionalLight | null = null;
  private readonly sunAxisX = new THREE.Vector3();
  private readonly sunAxisY = new THREE.Vector3();
  private readonly sunTarget = new THREE.Vector3();
  private sunDistance = 0;
  private shadowTexelSize = 1;
  private shadowFootprintRadius = 0;

  private statsWindowStart = -1;
  private statsFrames = 0;
  private statsCpuMs = 0;
  private statsMaxFrameMs = 0;
  private statsStreamingMs = 0;
  private statsDistance = 0;
  private readonly statsLastPosition = new THREE.Vector3();
  private lastDrawCalls = 0;
  private lastTriangles = 0;
  private readonly statsDirection = new THREE.Vector3();
  private statsStartGenerated = 0;

  async init(canvas: HTMLCanvasElement, customConfig?: Partial<TerrainConfig>): Promise<boolean> {
    if (this.initStateSignal() !== 'uninitialized') {
      console.warn('TerrainEngine already initialized');
      return this.initStateSignal() === 'ready';
    }

    const generation = ++this.initGeneration;

    this.initStateSignal.set('initializing');
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

      this.initScene();
      this.initCamera();
      this.initLights();

      this.gpuGenerator = new GPUGenerator<Chunk>(this.renderer!, this.config);
      this.chunkManager = new ChunkManager(this.config, this.gpuGenerator);
      this.sceneGraph = new SceneGraph(this.scene!, this.config, this.gpuGenerator);

      this.prewarmPipelines();

      this.setupResizeHandling();

      this.initStateSignal.set('ready');
      console.log('TerrainEngine initialized successfully');

      return true;
    } catch (error) {
      if (generation !== this.initGeneration) return false;
      console.error('Error initializing TerrainEngine:', error);
      this.initStateSignal.set('failed');
      return false;
    }
  }

  private async createRenderer(canvas: HTMLCanvasElement): Promise<WebGPURenderer> {
    if (!navigator.gpu) {
      throw new Error('WebGPU is not supported in this browser');
    }

    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance',
    });

    if (!adapter) {
      throw new Error('WebGPU adapter could not be obtained');
    }

    const renderer = new WebGPURenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });

    await renderer.init();

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

  private initScene(): void {
    this.scene = new THREE.Scene();

    this.fogFar = this.worldEdgeDistance();
    this.fogNear = Math.min(this.config.LOD_DISTANCES[1], this.fogFar * 0.5);

    const distance = positionView.length();
    const viewDirection = cameraWorldMatrix.mul(vec4(positionView, 0.0)).xyz.normalize();
    Object.assign(this.scene, {
      backgroundNode: skyColor(normalWorldGeometry.normalize(), SUN_DIRECTION, {
        sunDisk: true,
        clouds: true,
      }),
      fogNode: fog(
        skyColor(viewDirection, SUN_DIRECTION, { sunDisk: false, clouds: false }),
        smoothstep(uniform(this.fogNear), uniform(this.fogFar), distance),
      ),
    });
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

    const ambient = new THREE.AmbientLight(0x404040, 0.5);
    this.scene.add(ambient);

    const shadowRadius = this.config.LOD_DISTANCES[0];
    const heightExtent = Math.abs(this.config.TERRAIN_HEIGHT_SCALE) * 2 + Math.abs(this.config.TERRAIN_OFFSET_Y);

    this.sunDistance = shadowRadius + heightExtent;
    this.shadowTexelSize = (shadowRadius * 2) / SHADOW_MAP_SIZE;

    this.sunAxisX.crossVectors(new THREE.Vector3(0, 1, 0), SUN_DIRECTION).normalize();
    this.sunAxisY.crossVectors(SUN_DIRECTION, this.sunAxisX).normalize();

    const sun = new THREE.DirectionalLight(0xffffff, 1);
    sun.castShadow = true;

    sun.shadow.mapSize.width = SHADOW_MAP_SIZE;
    sun.shadow.mapSize.height = SHADOW_MAP_SIZE;
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = this.sunDistance * 2;
    sun.shadow.camera.left = -shadowRadius;
    sun.shadow.camera.right = shadowRadius;
    sun.shadow.camera.top = shadowRadius;
    sun.shadow.camera.bottom = -shadowRadius;
    sun.shadow.normalBias = this.shadowTexelSize;
    sun.shadow.camera.layers.enable(SHADOW_CASTER_LAYER);
    sun.shadow.camera.updateProjectionMatrix();

    const elevation = Math.asin(SUN_DIRECTION.y);
    this.shadowFootprintRadius = shadowRadius / Math.sin(elevation) + heightExtent / Math.tan(elevation);

    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;
    this.updateSun();
  }

  private updateSun(): void {
    if (!this.sun || !this.camera) return;

    const position = this.camera.position;
    const texel = this.shadowTexelSize;
    const u = Math.round(position.dot(this.sunAxisX) / texel) * texel;
    const v = Math.round(position.dot(this.sunAxisY) / texel) * texel;
    const w = position.dot(SUN_DIRECTION);

    this.sunTarget
      .copy(this.sunAxisX)
      .multiplyScalar(u)
      .addScaledVector(this.sunAxisY, v)
      .addScaledVector(SUN_DIRECTION, w);

    this.sun.target.position.copy(this.sunTarget);
    this.sun.position.copy(this.sunTarget).addScaledVector(SUN_DIRECTION, this.sunDistance);

    this.sceneGraph?.setShadowRegion(
      position.x,
      position.z,
      this.shadowFootprintRadius + Math.abs(position.y) / Math.tan(Math.asin(SUN_DIRECTION.y)),
    );
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
    this.statsWindowStart = -1;

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

    if (this.lastLoopTime >= 0) {
      this.statsMaxFrameMs = Math.max(this.statsMaxFrameMs, time - this.lastLoopTime);
    }

    const delta =
      this.lastLoopTime < 0 ? 0 : Math.min(Math.max((time - this.lastLoopTime) / 1000, 0), MAX_FRAME_DELTA_S);
    this.lastLoopTime = time;

    const cpuStart = performance.now();

    this.syncViewportSize();
    this.frameCallback?.(delta);
    this.update();

    if (this.renderer && this.scene && this.camera) {
      this.renderer.info.reset();
      this.renderer.render(this.scene, this.camera);
      this.lastDrawCalls = this.renderer.info.render.drawCalls;
      this.lastTriangles = this.renderer.info.render.triangles;
    }

    this.recordFrame(time, performance.now() - cpuStart);

    this.animationId = requestAnimationFrame(this.renderLoop);
  };

  private update(): void {
    if (!this.camera || !this.chunkManager || !this.sceneGraph) return;

    this.camera.updateMatrixWorld(true);

    const viewChanged =
      !this.viewInitialized ||
      !this.camera.matrixWorld.equals(this.lastCameraMatrix) ||
      !this.camera.projectionMatrix.equals(this.lastProjectionMatrix);

    if (viewChanged) {
      this.refreshCameraState();
      this.refreshFrustumPlanes();
      this.lastCameraMatrix.copy(this.camera.matrixWorld);
      this.lastProjectionMatrix.copy(this.camera.projectionMatrix);
      this.viewInitialized = true;
    }

    this.updateSun();

    const streamingStart = performance.now();
    this.chunkManager.update(this.cameraState!, this.frustumPlanes, viewChanged);

    this.sceneGraph.sync(
      this.chunkManager.getChunks(),
      this.chunkManager.getVisibleKeys(),
      this.chunkManager.getDirtyCoords(),
      this.chunkManager.getVisibilityToggled(),
    );
    this.chunkManager.clearRenderChanges();
    this.statsStreamingMs += performance.now() - streamingStart;
  }

  private refreshCameraState(): void {
    const camera = this.camera!;

    this.forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
    this.right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

    if (!this.cameraState) {
      this.cameraState = {
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
    }

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
  private refreshFrustumPlanes(): void {
    const camera = this.camera!;

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

  private recordFrame(time: number, cpuMs: number): void {
    if (!this.camera) return;

    if (this.statsWindowStart < 0) {
      this.statsWindowStart = time;
      this.resetStatsWindow();
      return;
    }

    this.statsFrames++;
    this.statsCpuMs += cpuMs;
    this.statsDistance += this.camera.position.distanceTo(this.statsLastPosition);
    this.statsLastPosition.copy(this.camera.position);

    const elapsed = time - this.statsWindowStart;
    if (elapsed < STATS_INTERVAL_MS) return;

    this.publishStats(elapsed);

    this.statsWindowStart = time;
    this.resetStatsWindow();
  }

  private resetStatsWindow(): void {
    this.statsFrames = 0;
    this.statsCpuMs = 0;
    this.statsMaxFrameMs = 0;
    this.statsStreamingMs = 0;
    this.statsDistance = 0;
    this.statsLastPosition.copy(this.camera!.position);
    this.statsStartGenerated = this.gpuGenerator?.generatedCount ?? 0;
  }

  private publishStats(elapsedMs: number): void {
    if (!this.camera || !this.chunkManager) return;

    const chunkStats = this.chunkManager.getStats();
    const position = this.camera.position;

    const direction = this.camera.getWorldDirection(this.statsDirection);
    const heading = THREE.MathUtils.radToDeg(Math.atan2(direction.x, -direction.z));
    const ground = this.chunkManager.getTerrainHeightAt(position.x, position.z);
    const atlasBytes = this.gpuGenerator?.getAtlasBytes() ?? 0;
    const stagingBytes = this.gpuGenerator?.getStagingBytes() ?? 0;
    const geometryBytes = this.uploadedBytes(this.sceneGraph?.getGpuAttributes() ?? []);

    this.statsSignal.set({
      fps: (this.statsFrames * 1000) / elapsedMs,
      frameMs: this.statsFrames > 0 ? elapsedMs / this.statsFrames : 0,
      maxFrameMs: this.statsMaxFrameMs,
      cpuFrameMs: this.statsFrames > 0 ? this.statsCpuMs / this.statsFrames : 0,
      chunkUpdateMs: this.statsFrames > 0 ? this.statsStreamingMs / this.statsFrames : 0,
      drawCalls: this.lastDrawCalls,
      triangles: this.lastTriangles,
      renderWidth: Math.floor(this.appliedWidth * this.appliedPixelRatio),
      renderHeight: Math.floor(this.appliedHeight * this.appliedPixelRatio),
      pixelRatio: this.appliedPixelRatio,
      visibleChunks: chunkStats.visibleCount,
      visibleByLod: chunkStats.visibleByLod,
      readyChunks: chunkStats.readyCount,
      unloadingChunks: chunkStats.unloadingCount,
      generatedPerSecond: (((this.gpuGenerator?.generatedCount ?? 0) - this.statsStartGenerated) * 1000) / elapsedMs,
      exactBoundsChunks: chunkStats.exactBoundsCount,
      pendingChunks: chunkStats.pendingCount,
      queueUsage: chunkStats.streamingBufferUsage,
      failedChunks: chunkStats.errorCount,
      atlasBytes,
      stagingBytes,
      geometryBytes,
      terrainBufferBytes: atlasBytes + stagingBytes + geometryBytes,
      cameraX: position.x,
      cameraY: position.y,
      cameraZ: position.z,
      heightAboveGround: ground === null ? null : position.y - ground,
      headingDeg: (heading + 360) % 360,
      pitchDeg: THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1))),
      cameraSpeed: this.statsDistance / (elapsedMs / 1000),
      chunkX: Math.floor(position.x / this.config.CHUNK_SIZE),
      chunkZ: Math.floor(position.z / this.config.CHUNK_SIZE),
      seed: this.config.NOISE_SEED,
    });
  }

  private uploadedBytes(attributes: readonly object[]): number {
    const backend = (this.renderer as unknown as { readonly backend?: BufferBackend } | null)?.backend;
    if (!backend?.has || !backend.get) return 0;

    let bytes = 0;
    for (const attribute of attributes) {
      if (backend.has(attribute)) bytes += backend.get(attribute)?.buffer?.size ?? 0;
    }
    return bytes;
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
    this.sun = null;
    this.camera = null;
    this.canvas = null;
    this.cameraState = null;
    this.viewInitialized = false;

    this.statsSignal.set(null);
    this.initStateSignal.set('uninitialized');
  }
}
