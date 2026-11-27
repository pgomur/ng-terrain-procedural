/**
 * First-person flight controls with pointer lock.
 *
 * {@link FlyCameraController} turns keyboard and mouse input into camera movement. It does not know about Three.js scenes or the engine's internals: it drives any {@link FlyCameraTarget}, an interface the {@link engine/terrain-engine!TerrainEngine | TerrainEngine} implements.
 *
 * | Input | Action |
 * | --- | --- |
 * | Click on the canvas | Capture the pointer and start flying. |
 * | Mouse | Look around; the pitch stops just short of vertical. |
 * | `W` / `S` | Forward and back along the view direction, so looking up and pressing `W` climbs. |
 * | `A` / `D` | Left and right, horizontally. |
 * | `E` or `Space` / `Q` | Straight up / straight down. |
 * | `Left Shift` | Three times faster: 90 units per second instead of 30. |
 * | `Esc` | Release the pointer; all keys are then ignored. |
 *
 * Keys are read by their physical position (`KeyboardEvent.code`), so the controls stay in place on AZERTY and other layouts.
 *
 * See [Embedding the terrain](../../../guides/embedding.md#controls).
 *
 * @module
 */
import { signal } from '@angular/core';
import * as THREE from 'three';

/**
 * What a {@link FlyCameraController} needs from the engine. Implemented by {@link engine/terrain-engine!TerrainEngine | TerrainEngine}.
 *
 * Keeping the dependency this narrow lets the controls be tested with a plain object instead of a GPU.
 */
export interface FlyCameraTarget {
  /**
   * Moves the camera.
   *
   * @param x - Position along X, in world units.
   * @param y - Height, in world units.
   * @param z - Position along Z, in world units.
   *
   * Called every frame while flying, after the ground check.
   */
  setCameraPosition(x: number, y: number, z: number): void;
  /**
   * Turns the camera to look at a point.
   *
   * @param x - Point along X, in world units.
   * @param y - Point height, in world units.
   * @param z - Point along Z, in world units.
   *
   * Called every frame with a point one unit ahead along the view direction.
   */
  lookAt(x: number, y: number, z: number): void;
  /**
   * Writes the camera's view direction into a vector.
   *
   * @param target - Vector that receives the direction.
   * @returns `target`.
   */
  getCameraDirection(target: THREE.Vector3): THREE.Vector3;
  /**
   * Height of the terrain at a world position.
   *
   * @param x - Position along X, in world units.
   * @param z - Position along Z, in world units.
   * @returns The height, or `null` when it is not known.
   */
  getTerrainHeightAt(x: number, z: number): number | null;
}

const MOUSE_SENSITIVITY = 0.002;
const PITCH_LIMIT = Math.PI / 2 - 0.01;
const MOVEMENT_SPEED = 30.0;
const SPRINT_MULTIPLIER = 3.0;
const EYE_HEIGHT = 5.0;

/**
 * First-person flight controls with pointer lock.
 *
 * Clicking the canvas captures the pointer. While it is captured, the mouse turns the view and `W` `A` `S` `D` move along it, `E` or `Space` rise, `Q` descends and `Left Shift` triples the speed, which is 30 world units per second. The eye always stays at least 5 units above the terrain. Releasing the pointer, for example with `Esc`, forgets the held keys.
 */
export class FlyCameraController {
  /**
   * Whether the pointer is captured by the canvas.
   */
  readonly pointerLocked = signal(false);

  private readonly position = new THREE.Vector3(0, 100, 500);
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly lookTarget = new THREE.Vector3();
  private readonly activeKeys = new Set<string>();
  private pitch = 0;
  private yaw = 0;
  private cleanup: (() => void)[] = [];

  /**
   * Creates the controls. Nothing listens to input until {@link FlyCameraController.attach}.
   *
   * @param target - Engine that owns the camera.
   */
  constructor(private readonly target: FlyCameraTarget) {}

  /**
   * Places the camera at its start position, `(0, 100, 500)` looking at the origin, and takes its orientation from there.
   */
  start(): void {
    this.target.setCameraPosition(this.position.x, this.position.y, this.position.z);
    this.target.lookAt(0, 0, 0);

    const direction = this.target.getCameraDirection(this.forward);
    this.pitch = Math.asin(THREE.MathUtils.clamp(-direction.y, -1, 1));
    this.yaw = Math.atan2(-direction.x, -direction.z);
    this.pitch = THREE.MathUtils.clamp(this.pitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  /**
   * Starts listening to the canvas and to keyboard, mouse and pointer-lock events.
   *
   * @param canvas - Canvas that captures the pointer when clicked.
   */
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

  /**
   * Removes every listener added by {@link FlyCameraController.attach}.
   */
  detach(): void {
    for (const remove of this.cleanup) remove();
    this.cleanup = [];
  }

  /**
   * Detaches, forgets the held keys and exits pointer lock. Used when the engine stops for good.
   */
  release(): void {
    this.detach();
    this.activeKeys.clear();
    this.pointerLocked.set(false);
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /**
   * Moves and orients the camera for one frame. Does nothing while the pointer is not captured.
   *
   * @param delta - Time since the previous frame, in seconds.
   *
   * The {@link terrain/terrain.component!TerrainComponent | TerrainComponent} installs it as the engine's frame callback. The ground check only applies once the heights under the camera are known; until then the camera can pass below the surface.
   */
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
