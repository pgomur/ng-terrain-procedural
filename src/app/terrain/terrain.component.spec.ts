import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TerrainEngine } from '../engine/terrain-engine';
import type * as THREE from 'three';
import type { EngineInitState, LoadingStage, TerrainEngineStats } from '../types/engine';
import { DEFAULT_TERRAIN_CONFIG, type TerrainConfig } from '../types/terrain';
import { TerrainComponent } from './terrain.component';
import { TERRAIN_CONFIG } from './terrain.config';

describe('TerrainComponent', () => {
  const initState = signal<EngineInitState>('initializing');
  const loadingStage = signal<LoadingStage>('device');
  const loadingProgress = signal(0);
  const stats = signal<TerrainEngineStats | null>(null);
  const engine = {
    initState,
    loadingStage,
    loadingProgress,
    stats,
    isReady: () => initState() === 'ready',
    init: vi.fn<(canvas: HTMLCanvasElement, config: TerrainConfig) => Promise<boolean>>(),
    start: vi.fn(),
    dispose: vi.fn(),
    setFrameCallback: vi.fn(),
    setCameraPosition: () => undefined,
    lookAt: () => undefined,
    getCameraDirection: (out: THREE.Vector3) => out.set(0, 0, -1),
    getTerrainHeightAt: () => null,
  };

  const render = (configOverrides?: Partial<TerrainConfig>) => {
    TestBed.overrideComponent(TerrainComponent, { set: { providers: [{ provide: TerrainEngine, useValue: engine }] } });
    const fixture = TestBed.createComponent(TerrainComponent);
    if (configOverrides) fixture.componentRef.setInput('configOverrides', configOverrides);
    const ready: boolean[] = [];
    fixture.componentInstance.engineReady.subscribe((value) => ready.push(value));
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const refresh = () => {
      fixture.detectChanges();
      return element;
    };
    return { fixture, refresh, ready, canvas: element.querySelector('canvas')! };
  };

  const setPointerLock = (element: Element | null) => {
    Object.defineProperty(document, 'pointerLockElement', { value: element, configurable: true });
    document.dispatchEvent(new Event('pointerlockchange'));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    engine.init.mockImplementation(() => new Promise<boolean>(() => undefined));
    initState.set('initializing');
    loadingStage.set('device');
    loadingProgress.set(0);
    stats.set(null);
  });

  it('starts the engine with the global config overridden by the input, and stops it on destroy', async () => {
    TestBed.configureTestingModule({
      providers: [{ provide: TERRAIN_CONFIG, useValue: { ...DEFAULT_TERRAIN_CONFIG, NOISE_SEED: 7, CHUNK_SIZE: 256 } }],
    });
    engine.init.mockResolvedValue(true);
    const { fixture, ready, canvas } = render({ CHUNK_SIZE: 64 });
    await fixture.whenStable();

    expect(engine.init).toHaveBeenCalledExactlyOnceWith(
      canvas,
      expect.objectContaining({ NOISE_SEED: 7, CHUNK_SIZE: 64 }),
    );
    expect(engine.start).toHaveBeenCalledOnce();
    expect(ready).toEqual([true]);

    fixture.destroy();
    expect(engine.setFrameCallback).toHaveBeenLastCalledWith(null);
    expect(engine.dispose).toHaveBeenCalledOnce();
  });

  it('reports a failed start without running the engine', async () => {
    engine.init.mockResolvedValue(false);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { fixture, ready } = render();
    await fixture.whenStable();
    expect(engine.start).not.toHaveBeenCalled();
    expect(ready).toEqual([false]);
  });

  it('describes each loading stage and only shows a percentage while generating terrain', () => {
    const { refresh } = render();
    expect(refresh().querySelector('.loader-status')?.textContent.trim()).toBe('Connecting to the GPU');

    loadingStage.set('shaders');
    expect(refresh().querySelector('.loader-status')?.textContent.trim()).toBe('Compiling shaders');
    expect(refresh().querySelector('.loader-percent')).toBeNull();

    loadingStage.set('terrain');
    loadingProgress.set(0.5);
    expect(refresh().querySelector('.loader-status')?.textContent.replace(/\s+/g, ' ').trim()).toBe(
      'Generating terrain 50%',
    );

    loadingStage.set('done');
    loadingProgress.set(1);
    expect(refresh().querySelector('.loader')?.classList).toContain('is-done');
  });

  it('shows the panel and the controls once the engine is ready', () => {
    const { refresh } = render();
    expect(refresh().querySelector('app-hud')).toBeNull();
    expect(refresh().querySelector('.hud-hint')).toBeNull();

    initState.set('ready');
    stats.set({ fps: 60, visibleByLod: [0, 0, 0, 0], heightAboveGround: null } as unknown as TerrainEngineStats);
    expect(refresh().querySelector('app-hud .hud')).not.toBeNull();
    expect(refresh().querySelector('.hud-hint-cta')?.textContent).toBe('Click to start');
    const docs = refresh().querySelector('.hud-hint-docs');
    expect(docs?.getAttribute('href')).toBe('docs/');
    expect(docs?.getAttribute('target')).toBe('_blank');
  });

  it('replaces the loader with the WebGPU error when the engine fails', () => {
    const { refresh } = render();
    initState.set('failed');
    const element = refresh();
    expect(element.querySelector('.loader')?.getAttribute('role')).toBe('alert');
    expect(element.querySelector('.loader-error-title')?.textContent).toBe('WebGPU could not start');
  });

  it('shows a reload message and frees the cursor when the GPU device is lost', async () => {
    engine.init.mockResolvedValue(true);
    const exitPointerLock = vi.fn();
    document.exitPointerLock = exitPointerLock;
    const { fixture, refresh, canvas } = render();
    await fixture.whenStable();
    initState.set('ready');
    setPointerLock(canvas);
    expect(refresh().querySelector('.precision-crosshair')).not.toBeNull();

    initState.set('lost');
    const element = refresh();
    expect(element.querySelector('.loader')?.getAttribute('role')).toBe('alert');
    expect(element.querySelector('.loader-error-title')?.textContent).toBe('The GPU stopped responding');
    expect(element.querySelector('.hud-hint')).toBeNull();
    expect(element.querySelector('.precision-crosshair')).toBeNull();
    expect(exitPointerLock).toHaveBeenCalledOnce();
    setPointerLock(null);
  });
});
