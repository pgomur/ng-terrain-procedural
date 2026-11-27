import { TestBed } from '@angular/core/testing';
import { HudComponent } from './hud.component';
import type { TerrainEngineStats } from '../types/engine';

const stats: TerrainEngineStats = {
  fps: 143.6,
  frameMs: 6.96,
  maxFrameMs: 9.42,
  cpuFrameMs: 1.844,
  chunkUpdateMs: 0.311,
  drawCalls: 14,
  triangles: 1284352,
  renderWidth: 2560,
  renderHeight: 1440,
  pixelRatio: 1.5,
  visibleChunks: 212,
  visibleByLod: [24, 60, 80, 48],
  readyChunks: 2485,
  unloadingChunks: 0,
  generatedPerSecond: 48.2,
  pendingChunks: 3,
  queueUsage: 0.012,
  failedChunks: 0,
  atlasBytes: 7.6 * 1048576,
  stagingBytes: 0.15 * 1048576,
  geometryBytes: 0.3 * 1048576,
  terrainBufferBytes: 8.05 * 1048576,
  cameraX: -12480.4,
  cameraY: 162.2,
  cameraZ: 3215.7,
  heightAboveGround: 131.43,
  headingDeg: 47.2,
  pitchDeg: -12.4,
  cameraSpeed: 240.1,
  chunkX: -98,
  chunkZ: 25,
  seed: 12345,
};

describe('HudComponent', () => {
  const render = (overrides: Partial<TerrainEngineStats> = {}) => {
    const fixture = TestBed.createComponent(HudComponent);
    fixture.componentRef.setInput('stats', { ...stats, ...overrides });
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const row = (label: string) =>
      [...element.querySelectorAll('.hud-row')]
        .find((r) => r.querySelector('dt')?.textContent.trim() === label)
        ?.querySelector('dd')
        ?.textContent.replace(/\s+/g, ' ')
        .trim();
    return { element, row };
  };

  it('shows every value with its unit and precision', () => {
    const { element, row } = render();
    expect(element.querySelector('.hud-fps')?.textContent).toBe('144');
    expect(row('CPU frame')).toBe('1.84 ms');
    expect(row('Triangles')).toBe('1,284,352');
    expect(row('Resolution')).toBe('2560 × 1440 @1.5x');
    expect([...element.querySelectorAll('.hud-lods span')].map((span) => span.textContent)).toEqual([
      '24',
      '60',
      '80',
      '48',
    ]);
    expect(row('Queue')).toBe('3 1%');
    expect(row('X')).toBe('-12,480');
    expect(row('Above ground')).toBe('131.4');
    expect(row('Heading')).toBe('47° NE');
    expect(row('Chunk')).toBe('-98, 25');
    expect(element.querySelector('.hud-title-value')?.textContent).toBe('8.1 MB');
  });

  it('only mentions unloading and failed chunks when there are any', () => {
    expect(render().row('Ready')).toBe('2485');
    expect(render().row('Failed')).toBeUndefined();
    expect(render({ unloadingChunks: 12 }).row('Ready')).toBe('2485 +12 unloading');
    expect(render({ failedChunks: 2 }).row('Failed')).toBe('2');
  });

  it('shows a dash while the ground height is unknown', () => {
    expect(render({ heightAboveGround: null }).row('Above ground')).toBe('–');
  });

  it('names the heading with the nearest cardinal direction', () => {
    expect(render({ headingDeg: 0 }).row('Heading')).toBe('0° N');
    expect(render({ headingDeg: 359 }).row('Heading')).toBe('359° N');
    expect(render({ headingDeg: 180 }).row('Heading')).toBe('180° S');
    expect(render({ headingDeg: 292 }).row('Heading')).toBe('292° W');
  });
});
