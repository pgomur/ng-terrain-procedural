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
} from '@angular/core';
import { CommonModule } from '@angular/common';
import * as THREE from 'three';
import { TerrainEngine } from '../engine/terrain-engine';
import { TerrainConfig } from '../types/terrain';
import { TERRAIN_CONFIG } from './terrain.config';

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

  public isPointerLocked = false;
  private cameraPitch = 0;
  private cameraYaw = 0;
  private cameraPosition = new THREE.Vector3(0, 100, 500);
  private movementSpeed = 30.0;

  public currentX = 0;
  public currentY = 100;
  public currentZ = 500;
  public currentSpeed = 0;

  private activeKeys = new Set<string>();
  private lastTime = 0;
  private animationFrameId?: number;

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

      this.ngZone.runOutsideAngular(() => {
        this.engine.start();
        this.setupFlyCameraControls(canvas);

        this.lastTime = performance.now();
        const runUpdateLoop = (time: number) => {
          const delta = (time - this.lastTime) / 1000;
          this.lastTime = time;
          this.updateCameraLogic(delta);
          this.animationFrameId = requestAnimationFrame(runUpdateLoop);
        };
        this.animationFrameId = requestAnimationFrame(runUpdateLoop);
      });

      this.engineReady.emit(true);
    } else {
      console.error('TerrainComponent: Failed to start WebGPU engine');
      this.engineReady.emit(false);
    }
  }

  ngOnDestroy(): void {
    if (this.animationFrameId !== undefined) {
      cancelAnimationFrame(this.animationFrameId);
    }

    this.cleanupFunctions.forEach((cleanupFn) => cleanupFn());
    this.cleanupFunctions = [];

    this.engine.dispose();
  }

  private setupFlyCameraControls(canvas: HTMLCanvasElement): void {
    const onKeydown = (e: KeyboardEvent) => this.activeKeys.add(e.code);
    const onKeyup = (e: KeyboardEvent) => this.activeKeys.delete(e.code);

    const onMousemove = (e: MouseEvent) => {
      if (!this.isPointerLocked) return;

      const sensitivity = 0.002;
      this.cameraYaw -= e.movementX * sensitivity;
      this.cameraPitch += e.movementY * sensitivity;

      const pitchLimit = Math.PI / 2 - 0.01;
      this.cameraPitch = Math.max(-pitchLimit, Math.min(pitchLimit, this.cameraPitch));
    };

    const onClick = async () => {
      if (!this.isPointerLocked) {
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
      this.isPointerLocked = document.pointerLockElement === canvas;
      if (!this.isPointerLocked) {
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
    if (!this.isPointerLocked) return;

    const moveDistance =
      this.movementSpeed * delta * (this.activeKeys.has('ShiftLeft') ? 3.0 : 1.0);

    const forward = new THREE.Vector3(
      Math.sin(this.cameraYaw) * Math.cos(this.cameraPitch),
      Math.sin(this.cameraPitch),
      Math.cos(this.cameraYaw) * Math.cos(this.cameraPitch),
    )
      .negate()
      .normalize();

    const right = new THREE.Vector3(
      Math.cos(this.cameraYaw),
      0,
      -Math.sin(this.cameraYaw),
    ).normalize();

    if (this.activeKeys.has('KeyW')) this.cameraPosition.addScaledVector(forward, moveDistance);
    if (this.activeKeys.has('KeyS')) this.cameraPosition.addScaledVector(forward, -moveDistance);
    if (this.activeKeys.has('KeyD')) this.cameraPosition.addScaledVector(right, moveDistance);
    if (this.activeKeys.has('KeyA')) this.cameraPosition.addScaledVector(right, -moveDistance);

    if (this.activeKeys.has('Space')) this.cameraPosition.y += moveDistance;
    if (this.activeKeys.has('ControlLeft')) this.cameraPosition.y -= moveDistance;

    const terrainHeight = this.engine.getTerrainHeightAt(
      this.cameraPosition.x,
      this.cameraPosition.z,
    );

    if (terrainHeight !== null) {
      const eyeHeight = 5.0;
      const groundY = terrainHeight + eyeHeight;

      if (this.cameraPosition.y < groundY) {
        this.cameraPosition.y = groundY;
      }
    }

    this.engine.setCameraPosition(
      this.cameraPosition.x,
      this.cameraPosition.y,
      this.cameraPosition.z,
    );

    const target = this.cameraPosition.clone().add(forward);
    this.engine.lookAt(target.x, target.y, target.z);

    this.currentX = this.cameraPosition.x;
    this.currentY = this.cameraPosition.y;
    this.currentZ = this.cameraPosition.z;
    this.currentSpeed = this.activeKeys.size > 0 ? moveDistance / delta : 0;
  }
}
