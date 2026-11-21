import {
  Component,
  ElementRef,
  ViewChild,
  OnDestroy,
  OnInit,
  AfterViewInit,
  inject,
  NgZone,
  Input,
  Output,
  EventEmitter,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import * as THREE from 'three';
import { TerrainEngine } from '../engine/terrain-engine';
import { TerrainConfig } from '../types/terrain';
import { TERRAIN_CONFIG } from './terrain.config';

const MOUSE_SENSITIVITY = 0.002;
const PITCH_LIMIT = Math.PI / 2 - 0.01;
const SPRINT_MULTIPLIER = 3.0;
const EYE_HEIGHT = 5.0;

@Component({
  selector: 'app-terrain',
  standalone: true,
  templateUrl: './terrain.component.html',
  styleUrl: './terrain.component.scss',
  imports: [CommonModule],
  providers: [TerrainEngine],
})
export class TerrainComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('terrainCanvas', { static: true })
  private readonly canvasRef!: ElementRef<HTMLCanvasElement>;

  @Input() configOverrides?: Partial<TerrainConfig>;

  @Input() showDiagnostics = true;

  @Output() engineReady = new EventEmitter<boolean>();

  public readonly engine = inject(TerrainEngine);
  private readonly globalConfig = inject(TERRAIN_CONFIG);
  private readonly ngZone = inject(NgZone);

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

  ngOnInit(): void {}

  async ngAfterViewInit(): Promise<void> {
    const canvas = this.canvasRef.nativeElement;

    const finalConfig: TerrainConfig = {
      ...this.globalConfig,
      ...this.configOverrides,
    };

    const success = await this.engine.init(canvas, finalConfig);

    if (success) {
      this.engine.setCameraPosition(
        this.cameraPosition.x,
        this.cameraPosition.y,
        this.cameraPosition.z,
      );
      this.engine.lookAt(0, 0, 0);
      this.syncOrientationFromEngine();

      this.ngZone.runOutsideAngular(() => {
        this.setupFlyCameraControls(canvas);
        this.engine.setFrameCallback((delta) => this.updateCameraLogic(delta));
        this.engine.start();
      });

      this.engineReady.emit(true);
    } else {
      console.error('TerrainComponent: Failed to start WebGPU engine');
      this.engineReady.emit(false);
    }
  }

  ngOnDestroy(): void {
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

    const onClick = async () => {
      if (!this.isPointerLocked()) {
        try {
          if (canvas.requestPointerLock) {
            await canvas.requestPointerLock();
          }
        } catch (e) {
          console.warn('The pointer lock could not be established:', e);
        }
      }
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
    this.cleanupFunctions.push(() =>
      document.removeEventListener('pointerlockchange', onPointerLockChange),
    );
    this.cleanupFunctions.push(() => document.removeEventListener('keydown', onKeydown));
    this.cleanupFunctions.push(() => document.removeEventListener('keyup', onKeyup));
    this.cleanupFunctions.push(() => document.removeEventListener('mousemove', onMousemove));
  }

  private updateCameraLogic(delta: number): void {
    if (!this.isPointerLocked()) return;

    const moveDistance =
      this.movementSpeed * delta * (this.activeKeys.has('ShiftLeft') ? SPRINT_MULTIPLIER : 1.0);

    const cosPitch = Math.cos(this.cameraPitch);
    this.forward
      .set(
        -Math.sin(this.cameraYaw) * cosPitch,
        -Math.sin(this.cameraPitch),
        -Math.cos(this.cameraYaw) * cosPitch,
      )
      .normalize();

    this.right.set(Math.cos(this.cameraYaw), 0, -Math.sin(this.cameraYaw)).normalize();

    if (this.activeKeys.has('KeyW')) this.cameraPosition.addScaledVector(this.forward, moveDistance);
    if (this.activeKeys.has('KeyS')) this.cameraPosition.addScaledVector(this.forward, -moveDistance);
    if (this.activeKeys.has('KeyD')) this.cameraPosition.addScaledVector(this.right, moveDistance);
    if (this.activeKeys.has('KeyA')) this.cameraPosition.addScaledVector(this.right, -moveDistance);

    if (this.activeKeys.has('Space')) this.cameraPosition.y += moveDistance;
    if (this.activeKeys.has('ControlLeft')) this.cameraPosition.y -= moveDistance;

    const terrainHeight = this.engine.getTerrainHeightAt(
      this.cameraPosition.x,
      this.cameraPosition.z,
    );

    if (terrainHeight !== null) {
      const groundY = terrainHeight + EYE_HEIGHT;

      if (this.cameraPosition.y < groundY) {
        this.cameraPosition.y = groundY;
      }
    }

    this.engine.setCameraPosition(
      this.cameraPosition.x,
      this.cameraPosition.y,
      this.cameraPosition.z,
    );

    this.lookTarget.copy(this.cameraPosition).add(this.forward);
    this.engine.lookAt(this.lookTarget.x, this.lookTarget.y, this.lookTarget.z);
  }
}
