import * as THREE from 'three';
import { TerrainEngine, isWebGPUBackend } from './terrain-engine';

interface RendererSpy {
  setPixelRatio: ReturnType<typeof vi.fn>;
  setSize: ReturnType<typeof vi.fn>;
}

interface EngineInternals {
  canvas: HTMLCanvasElement | null;
  camera: THREE.PerspectiveCamera | null;
  renderer: RendererSpy | null;
  setupResizeHandling(): void;
  syncViewportSize(): void;
}

describe('TerrainEngine viewport sizing', () => {
  let resizeCallback: ResizeObserverCallback;
  let engine: TerrainEngine;
  let internals: EngineInternals;
  let renderer: RendererSpy;
  let camera: THREE.PerspectiveCamera;
  const originalRatio = window.devicePixelRatio;

  const resizeTo = (width: number, height: number) => {
    const entry = { contentRect: { width, height } } as ResizeObserverEntry;
    resizeCallback([entry], {} as ResizeObserver);
  };

  const setPixelRatio = (value: number) => {
    Object.defineProperty(window, 'devicePixelRatio', { value, configurable: true });
  };

  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        readonly observe = vi.fn();
        readonly disconnect = vi.fn();
      },
    );
    setPixelRatio(1);

    engine = new TerrainEngine();
    internals = engine as unknown as EngineInternals;
    renderer = { setPixelRatio: vi.fn(), setSize: vi.fn() };
    camera = new THREE.PerspectiveCamera(60, 1, 1, 1000);
    internals.canvas = document.createElement('canvas');
    internals.camera = camera;
    internals.renderer = renderer;
    internals.setupResizeHandling();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setPixelRatio(originalRatio);
  });

  it('applies the observed size on the next frame without touching the canvas style', () => {
    resizeTo(800, 600);
    expect(renderer.setSize).not.toHaveBeenCalled();

    internals.syncViewportSize();

    expect(renderer.setSize).toHaveBeenCalledExactlyOnceWith(800, 600, false);
    expect(camera.aspect).toBeCloseTo(800 / 600);
    expect(internals.canvas!.style.width).toBe('');
    expect(internals.canvas!.style.height).toBe('');
  });

  it('only resizes when the size or the pixel ratio changes', () => {
    resizeTo(1280.6, 720.4);
    internals.syncViewportSize();
    internals.syncViewportSize();
    resizeTo(1280.2, 720.9);
    internals.syncViewportSize();
    expect(renderer.setSize).toHaveBeenCalledOnce();
    expect(renderer.setSize).toHaveBeenLastCalledWith(1280, 720, false);

    setPixelRatio(1.5);
    internals.syncViewportSize();
    expect(renderer.setPixelRatio).toHaveBeenLastCalledWith(1.5);
    expect(renderer.setSize).toHaveBeenCalledTimes(2);

    setPixelRatio(3);
    internals.syncViewportSize();
    expect(renderer.setPixelRatio).toHaveBeenLastCalledWith(2);
  });

  it('ignores an empty viewport', () => {
    resizeTo(0, 400);
    internals.syncViewportSize();
    expect(renderer.setSize).not.toHaveBeenCalled();
    expect(camera.aspect).toBe(1);
  });
});

describe('TerrainEngine initial loading', () => {
  interface LoadingInternals {
    chunkManager: { getLoadProgress(maxLod: number): { ready: number; wanted: number } } | null;
    loadingStageSignal: { set(stage: string): void };
    trackInitialLoad(time: number): void;
  }

  const setup = (progress: { ready: number; wanted: number }) => {
    const engine = new TerrainEngine();
    const internals = engine as unknown as LoadingInternals;
    internals.chunkManager = { getLoadProgress: () => progress };
    internals.loadingStageSignal.set('terrain');
    return { engine, internals, progress };
  };

  it('reports progress and hides the loader once every near chunk is ready', () => {
    const { engine, internals, progress } = setup({ ready: 0, wanted: 400 });

    internals.trackInitialLoad(0);
    expect(engine.loadingStage()).toBe('terrain');
    expect(engine.loadingProgress()).toBe(0);

    progress.ready = 100;
    internals.trackInitialLoad(16);
    expect(engine.loadingProgress()).toBe(0.25);

    progress.ready = 400;
    internals.trackInitialLoad(32);
    expect(engine.loadingStage()).toBe('done');
    expect(engine.loadingProgress()).toBe(1);
  });

  it('never keeps the loader forever', () => {
    const { engine, internals } = setup({ ready: 3, wanted: 400 });

    internals.trackInitialLoad(0);
    internals.trackInitialLoad(9_999);
    expect(engine.loadingStage()).toBe('terrain');

    internals.trackInitialLoad(10_001);
    expect(engine.loadingStage()).toBe('done');
  });

  it('does not finish before the wanted chunks are known', () => {
    const { engine, internals } = setup({ ready: 0, wanted: 0 });

    internals.trackInitialLoad(0);
    internals.trackInitialLoad(500);
    expect(engine.loadingStage()).toBe('terrain');
    expect(engine.loadingProgress()).toBe(0);
  });
});

describe('isWebGPUBackend', () => {
  it('accepts only the WebGPU backend', () => {
    expect(isWebGPUBackend({ isWebGPUBackend: true })).toBe(true);
    expect(isWebGPUBackend({ isWebGLBackend: true })).toBe(false);
    expect(isWebGPUBackend({})).toBe(false);
    expect(isWebGPUBackend(null)).toBe(false);
  });
});
