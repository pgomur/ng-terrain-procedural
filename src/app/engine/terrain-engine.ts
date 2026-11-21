import { Injectable, NgZone, inject, signal, computed } from '@angular/core';
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
import { FrustumPlanes, WorldPosition } from '../types/chunk';

export interface TerrainEngineStats {
  readonly fps: number;
  readonly cpuFrameMs: number;
  readonly chunkUpdateMs: number;
  readonly visibleChunks: number;
  readonly readyChunks: number;
  readonly generatingChunks: number;
  readonly pendingChunks: number;
  readonly estimatedVRAMBytes: number;
  readonly cameraX: number;
  readonly cameraY: number;
  readonly cameraZ: number;
  readonly cameraSpeed: number;
}

export type FrameCallback = (deltaSeconds: number) => void;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const MAX_FRAME_DELTA_S = 0.1;
const STATS_INTERVAL_MS = 250;

@Injectable()
export class TerrainEngine {
  private readonly ngZone = inject(NgZone);

  private config: TerrainConfig = DEFAULT_TERRAIN_CONFIG;

  private renderer: WebGPURenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;

  private gpuGenerator: GPUGenerator | null = null;
  private chunkManager: ChunkManager | null = null;
  private sceneGraph: SceneGraph | null = null;
  private raycaster = new THREE.Raycaster();
  private centerMouse = new THREE.Vector2(0, 0);

  private readonly initStateSignal = signal<EngineInitState>('uninitialized');
  private readonly statsSignal = signal<TerrainEngineStats | null>(null);

  readonly initState = this.initStateSignal.asReadonly();
  readonly isReady = computed(() => this.initStateSignal() === 'ready');
  readonly stats = this.statsSignal.asReadonly();

  private isRunning = false;
  private animationId: number | null = null;
  private lastLoopTime = -1;
  private frameCallback: FrameCallback | null = null;

  private canvas: HTMLCanvasElement | null = null;
  private resizeObserver: ResizeObserver | null = null;

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

  private statsWindowStart = -1;
  private statsFrames = 0;
  private statsCpuMs = 0;
  private readonly statsStartPosition = new THREE.Vector3();

  async init(canvas: HTMLCanvasElement, customConfig?: Partial<TerrainConfig>): Promise<boolean> {
    if (this.initStateSignal() !== 'uninitialized') {
      console.warn('TerrainEngine already initialized');
      return true;
    }

    this.initStateSignal.set('initializing');
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

      this.initStateSignal.set('ready');
      console.log('TerrainEngine initialized successfully');

      return true;
    } catch (error) {
      console.error('Error initializing TerrainEngine:', error);
      this.initStateSignal.set('failed');
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
    if (!this.camera || !this.renderer || width <= 0 || height <= 0) return;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
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

    this.ngZone.runOutsideAngular(() => {
      this.animationId = requestAnimationFrame(this.renderLoop);
    });
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

    const delta =
      this.lastLoopTime < 0
        ? 0
        : Math.min(Math.max((time - this.lastLoopTime) / 1000, 0), MAX_FRAME_DELTA_S);
    this.lastLoopTime = time;

    const cpuStart = performance.now();

    this.frameCallback?.(delta);
    this.update();

    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
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

    this.chunkManager.update(this.cameraState!, this.frustumPlanes, viewChanged);

    this.sceneGraph.sync(
      this.chunkManager.getChunks(),
      this.chunkManager.getVisibleKeys(),
      this.chunkManager.getDirtyCoords(),
      this.chunkManager.getVisibilityToggled(),
    );
    this.chunkManager.clearRenderChanges();
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

    this.frustum.setFromProjectionMatrix(
      this.viewProjection,
      camera.coordinateSystem,
      camera.reversedDepth,
    );

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
      this.statsFrames = 0;
      this.statsCpuMs = 0;
      this.statsStartPosition.copy(this.camera.position);
      return;
    }

    this.statsFrames++;
    this.statsCpuMs += cpuMs;

    const elapsed = time - this.statsWindowStart;
    if (elapsed < STATS_INTERVAL_MS) return;

    this.publishStats(elapsed);

    this.statsWindowStart = time;
    this.statsFrames = 0;
    this.statsCpuMs = 0;
    this.statsStartPosition.copy(this.camera.position);
  }

  private publishStats(elapsedMs: number): void {
    if (!this.camera || !this.chunkManager) return;

    const chunkStats = this.chunkManager.getStats();
    const position = this.camera.position;

    this.statsSignal.set({
      fps: (this.statsFrames * 1000) / elapsedMs,
      cpuFrameMs: this.statsFrames > 0 ? this.statsCpuMs / this.statsFrames : 0,
      chunkUpdateMs: chunkStats.updateTimeMs,
      visibleChunks: chunkStats.visibleCount,
      readyChunks: chunkStats.readyCount,
      generatingChunks: chunkStats.generatingCount,
      pendingChunks: chunkStats.pendingCount,
      estimatedVRAMBytes:
        chunkStats.storageBytes +
        (this.sceneGraph?.getGeometryBytes() ?? 0) +
        (this.gpuGenerator?.getPooledBytes() ?? 0),
      cameraX: position.x,
      cameraY: position.y,
      cameraZ: position.z,
      cameraSpeed: position.distanceTo(this.statsStartPosition) / (elapsedMs / 1000),
    });
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

  getCenterIntersection(): THREE.Intersection | null {
    if (!this.camera || !this.scene) return null;
    this.raycaster.setFromCamera(this.centerMouse, this.camera);
    const intersects = this.raycaster.intersectObjects(this.scene.children, true);
    return intersects.length > 0 ? intersects[0] : null;
  }

  dispose(): void {
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
    this.camera = null;
    this.canvas = null;
    this.cameraState = null;
    this.viewInitialized = false;

    this.statsSignal.set(null);
    this.initStateSignal.set('uninitialized');
  }
}
