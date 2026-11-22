import { TestBed } from '@angular/core/testing';
import { TerrainEngine } from '../engine/terrain-engine';
import { TerrainComponent } from './terrain.component';

interface ControlsInternals {
  activeKeys: Set<string>;
  cameraPitch: number;
  cameraYaw: number;
  updateCameraLogic(delta: number): void;
}

describe('TerrainComponent controls', () => {
  let component: TerrainComponent;
  let internals: ControlsInternals;
  let position: { x: number; y: number; z: number };

  const press = (...codes: string[]) => {
    internals.activeKeys.clear();
    for (const code of codes) internals.activeKeys.add(code);
  };

  const step = () => {
    const before = position.y;
    internals.updateCameraLogic(1);
    return position.y - before;
  };

  beforeEach(() => {
    position = { x: 0, y: 0, z: 0 };
    const engine = {
      getTerrainHeightAt: () => null,
      setCameraPosition: (x: number, y: number, z: number) => {
        position = { x, y, z };
      },
      lookAt: () => undefined,
    };
    TestBed.configureTestingModule({ providers: [{ provide: TerrainEngine, useValue: engine }] });
    component = TestBed.runInInjectionContext(() => new TerrainComponent());
    internals = component as unknown as ControlsInternals;
    internals.cameraPitch = 0;
    internals.cameraYaw = 0;
    component.isPointerLocked.set(true);
    press();
    internals.updateCameraLogic(0);
  });

  it('moves up with E or Space and down with Q', () => {
    press('KeyE');
    expect(step()).toBeCloseTo(30);
    press('Space');
    expect(step()).toBeCloseTo(30);
    press('KeyQ');
    expect(step()).toBeCloseTo(-30);
  });

  it('does not use Ctrl, so Ctrl + W can never be part of the controls', () => {
    press('ControlLeft');
    expect(step()).toBe(0);
    press('ControlRight');
    expect(step()).toBe(0);
  });

  it('ignores movement keys while the pointer is not captured', () => {
    component.isPointerLocked.set(false);
    press('KeyE');
    expect(step()).toBe(0);
  });
});
