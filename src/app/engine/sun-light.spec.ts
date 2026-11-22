import * as THREE from 'three';
import { SUN_DIRECTION, SunLight } from './sun-light';
import { DEFAULT_TERRAIN_CONFIG } from '../types/terrain';

describe('SunLight', () => {
  it('keeps the shadow camera on the shadow-map texel grid while following the camera', () => {
    const sun = new SunLight(DEFAULT_TERRAIN_CONFIG, 1);
    const position = new THREE.Vector3();
    let random = 3;
    const next = () => (random = (random * 1103515245 + 12345) >>> 0) / 2 ** 32;

    for (let i = 0; i < 500; i++) {
      position.set((next() - 0.5) * 20000, next() * 400, (next() - 0.5) * 20000);
      sun.follow(position);
      const target = sun.light.target.position;
      const u = target.dot(sun.axisX) / sun.texelSize;
      const v = target.dot(sun.axisY) / sun.texelSize;
      expect(Math.abs(u - Math.round(u))).toBeLessThan(1e-6);
      expect(Math.abs(v - Math.round(v))).toBeLessThan(1e-6);
      expect(Math.abs(target.dot(SUN_DIRECTION) - position.dot(SUN_DIRECTION))).toBeLessThan(1e-9);
      const offset = sun.light.position.clone().sub(target).normalize();
      expect(offset.distanceTo(SUN_DIRECTION)).toBeLessThan(1e-12);
    }
  });

  it('widens the shadow region with the camera height', () => {
    const sun = new SunLight(DEFAULT_TERRAIN_CONFIG, 1);
    const ground = sun.shadowRegionRadius(0);
    expect(ground).toBeGreaterThan(DEFAULT_TERRAIN_CONFIG.LOD_DISTANCES[0]);
    expect(sun.shadowRegionRadius(500)).toBeCloseTo(ground + 500 / Math.tan(Math.asin(SUN_DIRECTION.y)), 9);
    expect(sun.shadowRegionRadius(-500)).toBe(sun.shadowRegionRadius(500));
  });

  it('casts shadows on the shadow-caster layer only through its shadow camera', () => {
    const sun = new SunLight(DEFAULT_TERRAIN_CONFIG, 1);
    expect(sun.light.castShadow).toBe(true);
    expect(sun.light.shadow.camera.layers.isEnabled(1)).toBe(true);
    expect(sun.light.shadow.mapSize.x).toBe(2048);
    expect(sun.light.shadow.normalBias).toBe(sun.texelSize);
  });
});
