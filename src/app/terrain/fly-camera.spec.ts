import * as THREE from 'three';
import { FlyCameraController, type FlyCameraTarget } from './fly-camera';

describe('FlyCameraController', () => {
  let canvas: HTMLCanvasElement;
  let position: THREE.Vector3;
  let ground: number | null;
  let camera: FlyCameraController;

  const looking = new THREE.Vector3();
  const target: FlyCameraTarget = {
    setCameraPosition: (x, y, z) => position.set(x, y, z),
    lookAt: (x, y, z) => looking.set(x, y, z),
    getCameraDirection: (out) => out.set(0, 0, -1),
    getTerrainHeightAt: () => ground,
  };

  const setPointerLock = (element: Element | null) => {
    Object.defineProperty(document, 'pointerLockElement', { value: element, configurable: true });
    document.dispatchEvent(new Event('pointerlockchange'));
  };
  const key = (type: 'keydown' | 'keyup', code: string) => document.dispatchEvent(new KeyboardEvent(type, { code }));
  const mouse = (movementX: number, movementY: number) => {
    const event = new MouseEvent('mousemove');
    Object.defineProperties(event, { movementX: { value: movementX }, movementY: { value: movementY } });
    document.dispatchEvent(event);
  };
  const move = () => {
    const before = position.clone();
    camera.update(1);
    return position.clone().sub(before);
  };
  const climb = () => {
    const before = position.y;
    camera.update(1);
    return position.y - before;
  };

  beforeEach(() => {
    canvas = document.createElement('canvas');
    position = new THREE.Vector3();
    ground = null;
    camera = new FlyCameraController(target);
    camera.start();
    camera.attach(canvas);
    setPointerLock(canvas);
  });

  afterEach(() => {
    camera.detach();
    setPointerLock(null);
  });

  it('starts at the spawn point and tracks the pointer lock', () => {
    expect(position.toArray()).toEqual([0, 100, 500]);
    expect(camera.pointerLocked()).toBe(true);
    setPointerLock(null);
    expect(camera.pointerLocked()).toBe(false);
  });

  it('moves up with E or Space and down with Q, never with Ctrl', () => {
    key('keydown', 'KeyE');
    expect(climb()).toBeCloseTo(30);
    key('keyup', 'KeyE');
    key('keydown', 'Space');
    expect(climb()).toBeCloseTo(30);
    key('keyup', 'Space');
    key('keydown', 'KeyQ');
    expect(climb()).toBeCloseTo(-30);
    key('keyup', 'KeyQ');
    key('keydown', 'ControlLeft');
    expect(climb()).toBe(0);
  });

  it('flies along the view direction with W and S and sideways with A and D', () => {
    key('keydown', 'KeyW');
    expect(
      move()
        .toArray()
        .map((v) => Math.round(v * 1e9) / 1e9),
    ).toEqual([0, 0, -30]);
    key('keyup', 'KeyW');
    key('keydown', 'KeyD');
    expect(move().x).toBeCloseTo(30, 9);
    key('keyup', 'KeyD');
    key('keydown', 'KeyA');
    expect(move().x).toBeCloseTo(-30, 9);
    key('keyup', 'KeyA');
    key('keydown', 'KeyS');
    expect(move().z).toBeCloseTo(30, 9);
  });

  it('turns with the mouse and stops the pitch just short of vertical', () => {
    mouse(Math.PI / 2 / 0.002, 0);
    key('keydown', 'KeyW');
    const step = move();
    expect(step.x).toBeCloseTo(30, 9);
    expect(step.z).toBeCloseTo(0, 9);
    expect(looking.clone().sub(position).x).toBeCloseTo(1, 9);

    mouse(0, 1e6);
    camera.update(0);
    const view = looking.clone().sub(position);
    expect(view.y).toBeLessThan(-0.99);
    expect(view.x).toBeGreaterThan(0);
  });

  it('moves three times faster with Shift', () => {
    key('keydown', 'KeyE');
    key('keydown', 'ShiftLeft');
    expect(climb()).toBeCloseTo(90);
  });

  it('ignores movement while the pointer is not captured and forgets held keys when released', () => {
    key('keydown', 'KeyE');
    setPointerLock(null);
    expect(climb()).toBe(0);
    setPointerLock(canvas);
    expect(climb()).toBe(0);
  });

  it('keeps the eye above the terrain', () => {
    ground = 120;
    key('keydown', 'KeyQ');
    camera.update(1);
    expect(position.y).toBe(125);
  });

  it('stops listening after detach', () => {
    camera.detach();
    key('keydown', 'KeyE');
    expect(climb()).toBe(0);
  });

  it('frees the pointer and stops listening when the engine stops for good', () => {
    const exitPointerLock = vi.fn();
    document.exitPointerLock = exitPointerLock;
    camera.release();
    expect(camera.pointerLocked()).toBe(false);
    expect(exitPointerLock).toHaveBeenCalledOnce();
    setPointerLock(canvas);
    expect(camera.pointerLocked()).toBe(false);
  });
});
