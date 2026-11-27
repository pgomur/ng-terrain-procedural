import { signal } from '@angular/core';
import * as THREE from 'three';

export interface FlyCameraTarget {
  setCameraPosition(x: number, y: number, z: number): void;
  lookAt(x: number, y: number, z: number): void;
  getCameraDirection(target: THREE.Vector3): THREE.Vector3;
  getTerrainHeightAt(x: number, z: number): number | null;
}

const MOUSE_SENSITIVITY = 0.002;
const PITCH_LIMIT = Math.PI / 2 - 0.01;
const MOVEMENT_SPEED = 30.0;
const SPRINT_MULTIPLIER = 3.0;
const EYE_HEIGHT = 5.0;

export class FlyCameraController {
  readonly pointerLocked = signal(false);

  private readonly position = new THREE.Vector3(0, 100, 500);
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly lookTarget = new THREE.Vector3();
  private readonly activeKeys = new Set<string>();
  private pitch = 0;
  private yaw = 0;
  private cleanup: (() => void)[] = [];

  constructor(private readonly target: FlyCameraTarget) {}

  start(): void {
    this.target.setCameraPosition(this.position.x, this.position.y, this.position.z);
    this.target.lookAt(0, 0, 0);

    const direction = this.target.getCameraDirection(this.forward);
    this.pitch = Math.asin(THREE.MathUtils.clamp(-direction.y, -1, 1));
    this.yaw = Math.atan2(-direction.x, -direction.z);
    this.pitch = THREE.MathUtils.clamp(this.pitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  attach(canvas: HTMLCanvasElement): void {
    const onKeydown = (e: KeyboardEvent) => this.activeKeys.add(e.code);
    const onKeyup = (e: KeyboardEvent) => this.activeKeys.delete(e.code);

    const onMousemove = (e: MouseEvent) => {
      if (!this.pointerLocked()) return;

      this.yaw -= e.movementX * MOUSE_SENSITIVITY;
      this.pitch += e.movementY * MOUSE_SENSITIVITY;

      this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch));
    };

    const onClick = () => {
      if (this.pointerLocked()) return;
      Promise.resolve()
        .then(() => canvas.requestPointerLock())
        .catch((error: unknown) => {
          console.warn('The pointer lock could not be established:', error);
        });
    };

    const onPointerLockChange = () => {
      const locked = document.pointerLockElement === canvas;
      this.pointerLocked.set(locked);
      if (!locked) {
        this.activeKeys.clear();
      }
    };

    canvas.addEventListener('click', onClick);
    document.addEventListener('pointerlockchange', onPointerLockChange);
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('keyup', onKeyup);
    document.addEventListener('mousemove', onMousemove);

    this.cleanup.push(() => canvas.removeEventListener('click', onClick));
    this.cleanup.push(() => document.removeEventListener('pointerlockchange', onPointerLockChange));
    this.cleanup.push(() => document.removeEventListener('keydown', onKeydown));
    this.cleanup.push(() => document.removeEventListener('keyup', onKeyup));
    this.cleanup.push(() => document.removeEventListener('mousemove', onMousemove));
  }

  detach(): void {
    for (const remove of this.cleanup) remove();
    this.cleanup = [];
  }

  release(): void {
    this.detach();
    this.activeKeys.clear();
    this.pointerLocked.set(false);
    if (document.pointerLockElement) document.exitPointerLock();
  }

  update(delta: number): void {
    if (!this.pointerLocked()) return;

    const moveDistance = MOVEMENT_SPEED * delta * (this.activeKeys.has('ShiftLeft') ? SPRINT_MULTIPLIER : 1.0);

    const cosPitch = Math.cos(this.pitch);
    this.forward.set(-Math.sin(this.yaw) * cosPitch, -Math.sin(this.pitch), -Math.cos(this.yaw) * cosPitch).normalize();

    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw)).normalize();

    if (this.activeKeys.has('KeyW')) this.position.addScaledVector(this.forward, moveDistance);
    if (this.activeKeys.has('KeyS')) this.position.addScaledVector(this.forward, -moveDistance);
    if (this.activeKeys.has('KeyD')) this.position.addScaledVector(this.right, moveDistance);
    if (this.activeKeys.has('KeyA')) this.position.addScaledVector(this.right, -moveDistance);

    if (this.activeKeys.has('KeyE') || this.activeKeys.has('Space')) this.position.y += moveDistance;
    if (this.activeKeys.has('KeyQ')) this.position.y -= moveDistance;

    const terrainHeight = this.target.getTerrainHeightAt(this.position.x, this.position.z);

    if (terrainHeight !== null) {
      const groundY = terrainHeight + EYE_HEIGHT;

      if (this.position.y < groundY) {
        this.position.y = groundY;
      }
    }

    this.target.setCameraPosition(this.position.x, this.position.y, this.position.z);

    this.lookTarget.copy(this.position).add(this.forward);
    this.target.lookAt(this.lookTarget.x, this.lookTarget.y, this.lookTarget.z);
  }
}
