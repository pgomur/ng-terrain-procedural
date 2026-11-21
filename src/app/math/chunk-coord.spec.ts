import { describe, expect, it } from 'vitest';
import {
  analyticHeightRange,
  boundsFromHeights,
  encodeSeamCode,
  getChunkCenter,
  getChunkKey,
  intersectsFrustumAABB,
  seamLodDiff,
  selectLODForDistance,
  skirtDepthFor,
  stitchedHeight,
  supportsSeamStitching,
} from './chunk-coord';

describe('chunk-coord', () => {
  it('builds keys and centers', () => {
    expect(getChunkKey({ x: -3, z: 7, lod: 2 })).toBe('-3:7:2');
    expect(getChunkCenter({ x: -1, z: 2, lod: 0 }, 128)).toEqual({ x: -64, y: 0, z: 320 });
  });

  it('selects LOD by inclusive distance thresholds', () => {
    const d: [number, number, number] = [600, 1500, 3000];
    expect(selectLODForDistance(0, d)).toBe(0);
    expect(selectLODForDistance(600, d)).toBe(0);
    expect(selectLODForDistance(600.01, d)).toBe(1);
    expect(selectLODForDistance(3000, d)).toBe(2);
    expect(selectLODForDistance(3000.01, d)).toBe(3);
  });

  it('accepts only resolution chains whose segments halve per LOD', () => {
    expect(supportsSeamStitching({ 0: 65, 1: 33, 2: 17, 3: 9 })).toBe(true);
    expect(supportsSeamStitching({ 0: 64, 1: 32, 2: 16, 3: 8 })).toBe(false);
    expect(supportsSeamStitching({ 0: 129, 1: 65, 2: 33, 3: 17 })).toBe(true);
  });

  it('encodes per-side LOD differences in two bits each', () => {
    expect(seamLodDiff(0, null)).toBe(0);
    expect(seamLodDiff(2, 1)).toBe(0);
    expect(seamLodDiff(0, 3)).toBe(3);
    expect(encodeSeamCode(1, 2, 3, 1)).toBe(1 | (2 << 2) | (3 << 4) | (1 << 6));
  });

  it('stitches fine edge vertices onto the coarse neighbour edge and leaves corners intact', () => {
    const res = 9;
    const heights = Float32Array.from({ length: res * res }, (_, i) => (i * 7919) % 97);
    const code = encodeSeamCode(1, 0, 2, 0);
    for (let iz = 0; iz < res; iz++) {
      const expected = iz % 2 === 0 ? heights[iz * res] : (heights[(iz - 1) * res] + heights[(iz + 1) * res]) / 2;
      if (iz !== 0) expect(stitchedHeight(heights, res, 0, iz, code)).toBeCloseTo(expected, 5);
    }
    for (let ix = 1; ix < res - 1; ix++) {
      const a = Math.floor(ix / 4) * 4;
      const b = Math.min(a + 4, res - 1);
      const expected = heights[a] + (heights[b] - heights[a]) * ((ix - a) / 4);
      expect(stitchedHeight(heights, res, ix, 0, code)).toBeCloseTo(expected, 5);
    }
    expect(stitchedHeight(heights, res, 0, 0, code)).toBe(heights[0]);
    expect(stitchedHeight(heights, res, res - 1, res - 1, code)).toBe(heights[res * res - 1]);
    expect(stitchedHeight(heights, res, 4, 4, code)).toBe(heights[4 * res + 4]);
  });

  it('derives bounds and frustum visibility', () => {
    const b = boundsFromHeights({ x: 1, z: -1, lod: 0 }, 128, 10, 30);
    expect(b.min).toEqual({ x: 128, y: 10, z: -128 });
    expect(b.max).toEqual({ x: 256, y: 30, z: 0 });
    expect(b.radius).toBeCloseTo(Math.sqrt(64 * 64 * 2 + 10 * 10), 10);

    const inside = { normals: Array(6).fill({ x: 0, y: 0, z: 0 }), constants: Array(6).fill(1) };
    expect(intersectsFrustumAABB(b, inside)).toBe(true);
    const behind = {
      normals: [{ x: 1, y: 0, z: 0 }, ...Array(5).fill({ x: 0, y: 0, z: 0 })],
      constants: [-1000, 1, 1, 1, 1, 1],
    };
    expect(intersectsFrustumAABB(b, behind)).toBe(false);
  });

  it('keeps the analytic range conservative and the skirt depth positive', () => {
    expect(analyticHeightRange(100, 0)).toEqual({ min: -10, max: 110 });
    expect(analyticHeightRange(-50, 5)).toEqual({ min: -50, max: 10 });
    expect(skirtDepthFor(100)).toBe(2);
    expect(skirtDepthFor(10)).toBe(1);
  });
});
