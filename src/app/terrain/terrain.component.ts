import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import * as THREE from 'three';
import { TerrainEngine } from '../engine/terrain-engine';
import { TerrainConfig } from '../types/terrain';
import { TERRAIN_CONFIG } from './terrain.config';

const MOUSE_SENSITIVITY = 0.002;
const PITCH_LIMIT = Math.PI / 2 - 0.01;
const SPRINT_MULTIPLIER = 3.0;
const EYE_HEIGHT = 5.0;
const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

@Component({
  selector: 'app-terrain',
  templateUrl: './terrain.component.html',
  styleUrl: './terrain.component.scss',
  imports: [DecimalPipe],
  providers: [TerrainEngine],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TerrainComponent implements AfterViewInit, OnDestroy {
  readonly configOverrides = input<Partial<TerrainConfig>>();
  readonly showDiagnostics = input(true);
  readonly engineReady = output<boolean>();

  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('terrainCanvas');

  public readonly engine = inject(TerrainEngine);
  private readonly globalConfig = inject(TERRAIN_CONFIG);

  public readonly isPointerLocked = signal(false);
  private cameraPitch = 0;
  private cameraYaw = 0;
  private readonly cameraPosition = new THREE.Vector3(0, 100, 500);
  private readonly movementSpeed = 30.0;

  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly lookTarget = new THREE.Vector3();

  private readonly activeKeys = new Set<string>();

  private cleanupFunctions: (() => void)[] = [];
  private destroyed = false;

  protected cardinal(headingDeg: number): string {
    return CARDINALS[Math.round(headingDeg / 45) % CARDINALS.length];
  }

  ngAfterViewInit(): void {
    void this.startEngine(this.canvasRef().nativeElement);
  }

  private async startEngine(canvas: HTMLCanvasElement): Promise<void> {
    const finalConfig: TerrainConfig = {
      ...this.globalConfig,
      ...this.configOverrides(),
    };

    const success = await this.engine.init(canvas, finalConfig);

    if (this.destroyed) return;

    if (success) {
      this.engine.setCameraPosition(this.cameraPosition.x, this.cameraPosition.y, this.cameraPosition.z);
      this.engine.lookAt(0, 0, 0);
      this.syncOrientationFromEngine();

      this.setupFlyCameraControls(canvas);
      this.engine.setFrameCallback((delta) => this.updateCameraLogic(delta));
      this.engine.start();

      this.engineReady.emit(true);
    } else {
      console.error('TerrainComponent: Failed to start WebGPU engine');
      this.engineReady.emit(false);
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.engine.setFrameCallback(null);

    this.cleanupFunctions.forEach((cleanupFn) => cleanupFn());
    this.cleanupFunctions = [];

    this.engine.dispose();
  }

  private syncOrientationFromEngine(): void {
    const direction = this.engine.getCameraDirection(this.forward);
    this.cameraPitch = Math.asin(THREE.MathUtils.clamp(-direction.y, -1, 1));
    this.cameraYaw = Math.atan2(-direction.x, -direction.z);
    this.cameraPitch = THREE.MathUtils.clamp(this.cameraPitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  private setupFlyCameraControls(canvas: HTMLCanvasElement): void {
    const onKeydown = (e: KeyboardEvent) => this.activeKeys.add(e.code);
    const onKeyup = (e: KeyboardEvent) => this.activeKeys.delete(e.code);

    const onMousemove = (e: MouseEvent) => {
      if (!this.isPointerLocked()) return;

      this.cameraYaw -= e.movementX * MOUSE_SENSITIVITY;
      this.cameraPitch += e.movementY * MOUSE_SENSITIVITY;

      this.cameraPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.cameraPitch));
    };

    const onClick = () => {
      if (this.isPointerLocked()) return;
      Promise.resolve()
        .then(() => canvas.requestPointerLock())
        .catch((error: unknown) => {
          console.warn('The pointer lock could not be established:', error);
        });
    };

    const onPointerLockChange = () => {
      const locked = document.pointerLockElement === canvas;
      this.isPointerLocked.set(locked);
      if (!locked) {
        this.activeKeys.clear();
      }
    };

    canvas.addEventListener('click', onClick);
    document.addEventListener('pointerlockchange', onPointerLockChange);
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('keyup', onKeyup);
    document.addEventListener('mousemove', onMousemove);

    this.cleanupFunctions.push(() => canvas.removeEventListener('click', onClick));
    this.cleanupFunctions.push(() => document.removeEventListener('pointerlockchange', onPointerLockChange));
    this.cleanupFunctions.push(() => document.removeEventListener('keydown', onKeydown));
    this.cleanupFunctions.push(() => document.removeEventListener('keyup', onKeyup));
    this.cleanupFunctions.push(() => document.removeEventListener('mousemove', onMousemove));
  }

  private updateCameraLogic(delta: number): void {
    if (!this.isPointerLocked()) return;

    const moveDistance = this.movementSpeed * delta * (this.activeKeys.has('ShiftLeft') ? SPRINT_MULTIPLIER : 1.0);

    const cosPitch = Math.cos(this.cameraPitch);
    this.forward
      .set(-Math.sin(this.cameraYaw) * cosPitch, -Math.sin(this.cameraPitch), -Math.cos(this.cameraYaw) * cosPitch)
      .normalize();

    this.right.set(Math.cos(this.cameraYaw), 0, -Math.sin(this.cameraYaw)).normalize();

    if (this.activeKeys.has('KeyW')) this.cameraPosition.addScaledVector(this.forward, moveDistance);
    if (this.activeKeys.has('KeyS')) this.cameraPosition.addScaledVector(this.forward, -moveDistance);
    if (this.activeKeys.has('KeyD')) this.cameraPosition.addScaledVector(this.right, moveDistance);
    if (this.activeKeys.has('KeyA')) this.cameraPosition.addScaledVector(this.right, -moveDistance);

    if (this.activeKeys.has('KeyE') || this.activeKeys.has('Space')) this.cameraPosition.y += moveDistance;
    if (this.activeKeys.has('KeyQ')) this.cameraPosition.y -= moveDistance;

    const terrainHeight = this.engine.getTerrainHeightAt(this.cameraPosition.x, this.cameraPosition.z);

    if (terrainHeight !== null) {
      const groundY = terrainHeight + EYE_HEIGHT;

      if (this.cameraPosition.y < groundY) {
        this.cameraPosition.y = groundY;
      }
    }

    this.engine.setCameraPosition(this.cameraPosition.x, this.cameraPosition.y, this.cameraPosition.z);

    this.lookTarget.copy(this.cameraPosition).add(this.forward);
    this.engine.lookAt(this.lookTarget.x, this.lookTarget.y, this.lookTarget.z);
  }
}
