// src/app/shaders/elevation.tsl.ts

import * as THREE from 'three';
import {
  If,
  vec2,
  vec3,
  vec4,
  float,
  int,
  uint,
  Fn,
  uniform,
  storage,
  workgroupArray,
  workgroupBarrier,
  globalId,
  localId,
  workgroupId,
} from 'three/tsl';

/**
 * TSL node for 2D hash to float.
 * Permutation based on sin() to avoid lookup tables
 */
const hash22 = Fn(([p]: [ReturnType<typeof vec2>]) => {
  const k = float(0.3183099);
  const k2 = float(0.3678794);

  const x = float(p.x.mul(k).add(p.y.mul(k2)))
    .fract()
    .mul(2.0)
    .sub(1.0);
  const y = float(p.x.mul(k2).sub(p.y.mul(k)))
    .fract()
    .mul(2.0)
    .sub(1.0);

  return vec2(x, y);
});

/**
 * TSL node for 2D Simplex Noise
 * Standard implementation with mod 289 for permutation
 * Note: In WebGPU, I keep the coordinate range controlled
 * to avoid degraded accuracy at very high values
 */
const simplexNoise2D = Fn(([p_immutable]: [ReturnType<typeof vec2>]) => {
  const p = vec2(p_immutable);

  // Skewing and unskewing constants
  const C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);

  const i = vec2(p.add(p.dot(C.yy))).floor();
  const x0 = vec2(p.sub(i).sub(i.dot(C.xx)));

  const i1 = vec2(x0.x.greaterThan(x0.y).select(vec2(1.0, 0.0), vec2(0.0, 1.0)));

  const x12 = vec4(x0.xy.sub(i1), x0.xy.sub(1.0));

  const i_mod = i.sub(i.div(289.0).floor().mul(289.0));

  const p_hash = hash22(i_mod.div(289.0));
  const p_hash2 = hash22(i_mod.add(i1).div(289.0));
  const p_hash3 = hash22(i_mod.add(1.0).div(289.0));

  const m = vec3(
    float(0.5).sub(x0.dot(x0)).max(0.0),
    float(0.5).sub(x12.xy.dot(x12.xy)).max(0.0),
    float(0.5).sub(x12.zw.dot(x12.zw)).max(0.0),
  );

  const m2 = m.mul(m).mul(m);

  const x = vec3(x0.dot(p_hash), x12.xy.dot(p_hash2), x12.zw.dot(p_hash3));

  return float(70.0).mul(m2.dot(x));
});

/**
 * FBM with manual unwound loop (TSL does not support dynamic loops)
 * in compute shaders natively)
 * Maximum 8 octaves per design
 */
const fbm = Fn(
  ([p, octavesVal, persistenceVal, lacunarityVal]: [
    ReturnType<typeof vec2>,
    ReturnType<typeof float>,
    ReturnType<typeof float>,
    ReturnType<typeof float>,
  ]) => {
    const total = float(0.0).toVar();
    const amplitude = float(1.0).toVar();
    const frequency = float(1.0).toVar();
    const maxValue = float(0.0).toVar();

    const octaves = int(octavesVal);

    // 8 iterations maximum
    const i0 = int(0);
    If(i0.lessThan(octaves), () => {
      total.addAssign(simplexNoise2D(p.mul(frequency)).mul(amplitude));
      maxValue.addAssign(amplitude);
      amplitude.mulAssign(persistenceVal);
      frequency.mulAssign(lacunarityVal);

      const i1 = int(1);
      If(i1.lessThan(octaves), () => {
        total.addAssign(simplexNoise2D(p.mul(frequency)).mul(amplitude));
        maxValue.addAssign(amplitude);
        amplitude.mulAssign(persistenceVal);
        frequency.mulAssign(lacunarityVal);

        const i2 = int(2);
        If(i2.lessThan(octaves), () => {
          total.addAssign(simplexNoise2D(p.mul(frequency)).mul(amplitude));
          maxValue.addAssign(amplitude);
          amplitude.mulAssign(persistenceVal);
          frequency.mulAssign(lacunarityVal);

          const i3 = int(3);
          If(i3.lessThan(octaves), () => {
            total.addAssign(simplexNoise2D(p.mul(frequency)).mul(amplitude));
            maxValue.addAssign(amplitude);
            amplitude.mulAssign(persistenceVal);
            frequency.mulAssign(lacunarityVal);

            const i4 = int(4);
            If(i4.lessThan(octaves), () => {
              total.addAssign(simplexNoise2D(p.mul(frequency)).mul(amplitude));
              maxValue.addAssign(amplitude);
              amplitude.mulAssign(persistenceVal);
              frequency.mulAssign(lacunarityVal);

              const i5 = int(5);
              If(i5.lessThan(octaves), () => {
                total.addAssign(simplexNoise2D(p.mul(frequency)).mul(amplitude));
                maxValue.addAssign(amplitude);
                amplitude.mulAssign(persistenceVal);
                frequency.mulAssign(lacunarityVal);

                const i6 = int(6);
                If(i6.lessThan(octaves), () => {
                  total.addAssign(simplexNoise2D(p.mul(frequency)).mul(amplitude));
                  maxValue.addAssign(amplitude);
                  amplitude.mulAssign(persistenceVal);
                  frequency.mulAssign(lacunarityVal);

                  const i7 = int(7);
                  If(i7.lessThan(octaves), () => {
                    total.addAssign(simplexNoise2D(p.mul(frequency)).mul(amplitude));
                    maxValue.addAssign(amplitude);
                    amplitude.mulAssign(persistenceVal);
                    frequency.mulAssign(lacunarityVal);
                  });
                });
              });
            });
          });
        });
      });
    });

    return total.div(maxValue);
  },
);

/**
 * Domain Warping - coordinate distortion for organic terrain
 */
const domainWarp = Fn(
  ([p, warpStrength, warpOctaves, warpScale, baseOctaves, basePersistence, baseLacunarity]: [
    ReturnType<typeof vec2>,
    ReturnType<typeof float>,
    ReturnType<typeof float>,
    ReturnType<typeof float>,
    ReturnType<typeof float>,
    ReturnType<typeof float>,
    ReturnType<typeof float>,
  ]) => {
    const warpX = fbm(p.mul(warpScale), warpOctaves, float(0.5), float(2.0));
    const warpY = fbm(p.mul(warpScale).add(vec2(5.2, 1.3)), warpOctaves, float(0.5), float(2.0));

    const warpedP = vec2(p.x.add(warpX.mul(warpStrength)), p.y.add(warpY.mul(warpStrength)));

    return fbm(warpedP, baseOctaves, basePersistence, baseLacunarity);
  },
);

/**
 * Interface for shader parameters
 * 1:1 mapping to the CPU uniform buffer
 */
export interface ElevationUniforms {
  chunkOriginX: number;
  chunkOriginZ: number;
  chunkSize: number;
  resolution: number;
  seed: number;
  octaves: number;
  persistence: number;
  lacunarity: number;
  heightScale: number;
  offsetY: number;
  warpEnabled: number;
  warpStrength: number;
  warpOctaves: number;
  warpScale: number;
}

/**
 * Create the elevation compute node
 *
 * The node is built using uniform TSLs that are updated
 * from the CPU before each dispatch. The output buffer is connected via
 * storage() when the final compute node is created.
 */
export function createElevationComputeNode(resolution: number) {
  const uChunkOriginX = uniform(float(0));
  const uChunkOriginZ = uniform(float(0));
  const uChunkSize = uniform(float(128));
  const uSeed = uniform(float(12345));
  const uOctaves = uniform(float(6));
  const uPersistence = uniform(float(0.5));
  const uLacunarity = uniform(float(2.0));
  const uHeightScale = uniform(float(100));
  const uOffsetY = uniform(float(0));
  const uWarpEnabled = uniform(float(1));
  const uWarpStrength = uniform(float(0.3));
  const uWarpOctaves = uniform(float(2));
  const uWarpScale = uniform(float(0.5));

  /**
   * Main compute function
   * Writes directly to the storage buffer passed as a parameter
   */
  const computeFn = Fn(([outputBuffer]: [ReturnType<typeof storage>]) => {
    const globalIdx = int(uint(globalId).x);
    const res = int(resolution);
    const totalSize = res.mul(res);

    If(globalIdx.greaterThanEqual(totalSize), () => {
      return;
    });

    const x = int(globalIdx.mod(res));
    const z = int(globalIdx.div(res));

    const u = float(x).add(0.5).div(float(res));
    const v = float(z).add(0.5).div(float(res));

    const worldX = uChunkOriginX.add(u.mul(uChunkSize)).add(uSeed.mul(1000.0));
    const worldZ = uChunkOriginZ.add(v.mul(uChunkSize)).add(uSeed.mul(1000.0));

    const worldPos = vec2(worldX, worldZ).mul(0.001);

    const elevation = float(0.0).toVar();

    If(uWarpEnabled.equal(float(1)), () => {
      elevation.assign(
        domainWarp(
          worldPos,
          uWarpStrength,
          uWarpOctaves,
          uWarpScale,
          uOctaves,
          uPersistence,
          uLacunarity,
        ),
      );
    }).Else(() => {
      elevation.assign(fbm(worldPos, uOctaves, uPersistence, uLacunarity));
    });

    elevation.assign(elevation.mul(0.5).add(0.5));
    elevation.mulAssign(uHeightScale);
    elevation.addAssign(uOffsetY);

    outputBuffer.element(globalIdx).assign(elevation);
  });

  return {
    computeFn: computeFn,
    uniforms: {
      chunkOriginX: uChunkOriginX,
      chunkOriginZ: uChunkOriginZ,
      chunkSize: uChunkSize,
      seed: uSeed,
      octaves: uOctaves,
      persistence: uPersistence,
      lacunarity: uLacunarity,
      heightScale: uHeightScale,
      offsetY: uOffsetY,
      warpEnabled: uWarpEnabled,
      warpStrength: uWarpStrength,
      warpOctaves: uWarpOctaves,
      warpScale: uWarpScale,
    },
    resolution,
    workgroupSize: 64,
  };
}

/**
 * Standard bind group layout for WebGPU.
 * Binding 0: Uniform buffer (chunk parameters)
 * Binding 1: Storage buffer (output heightmap)
 */
export const ELEVATION_BIND_GROUP_LAYOUT = {
  entries: [
    {
      binding: 0,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: 'uniform' },
    },
    {
      binding: 1,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: 'storage' },
    },
  ],
} as const;

/**
 * Uniform buffer size in bytes (std140 layout)
 * 16 floats * 4 bytes = 64 bytes (aligned to 16)
 */
export const ELEVATION_UNIFORM_SIZE = 64;
