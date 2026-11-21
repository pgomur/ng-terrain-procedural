import { describe, expect, it } from 'vitest';
import { decodeOrderedFloat, encodeOrderedFloat, seedToNoiseOffset } from './elevation.tsl';

describe('elevation helpers', () => {
  it('ordered-float keys preserve order and round-trip exactly', () => {
    const values = [-1e6, -123.5, -1, -1e-7, -0, 0, 1e-7, 0.5, 1, 99.25, 3.4e38].map(Math.fround);
    const keys = values.map(encodeOrderedFloat);
    for (let i = 1; i < keys.length; i++) expect(keys[i]).toBeGreaterThanOrEqual(keys[i - 1]);
    values.forEach((v, i) => expect(decodeOrderedFloat(keys[i])).toBe(v));
  });

  it('derives a deterministic, bounded seed offset', () => {
    const a = seedToNoiseOffset(12345);
    expect(seedToNoiseOffset(12345)).toEqual(a);
    expect(seedToNoiseOffset(12346)).not.toEqual(a);
    for (const seed of [0, 1, -7, 2 ** 31 - 1, 987654321]) {
      const o = seedToNoiseOffset(seed);
      for (const v of [o.x, o.z]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(256);
      }
    }
  });
});
