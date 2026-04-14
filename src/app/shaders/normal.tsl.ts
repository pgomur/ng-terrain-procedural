import * as THREE from 'three';
import { If, vec2, vec3, vec4, float, int, uint, Fn, uniform, storage, globalId } from 'three/tsl';

/**
 * Calculate normals by finite differences with correct world-space scale.
 *
 * - Output buffer uses vec4 alignment (xyz + w padding) for 16-byte alignment
 * - Gradient scaled by actual step size (chunkSize/resolution)
 */

/**
 * Create the compute node for normal calculation.
 */
export function createNormalComputeNode(resolution: number) {
  const uResolution = uniform(float(resolution));
  const uChunkSize = uniform(float(128));
  const uHeightScale = uniform(float(1.0));

  /**
   * Helper: Sample elevation in xz coordinates.
   * Returns 0 if out of bounds.
   */
  const sampleElevation = Fn(
    ([heightBuffer, x_immutable, z_immutable, res]: [
      ReturnType<typeof storage>,
      ReturnType<typeof int>,
      ReturnType<typeof int>,
      ReturnType<typeof int>,
    ]) => {
      const x = int(x_immutable);
      const z = int(z_immutable);

      const elevation = float(0.0).toVar();

      If(
        x
          .greaterThanEqual(int(0))
          .and(x.lessThan(res))
          .and(z.greaterThanEqual(int(0)))
          .and(z.lessThan(res)),
        () => {
          const idx = z.mul(res).add(x);
          elevation.assign(heightBuffer.element(idx));
        },
      );

      return elevation;
    },
  );

  /**
   * Main compute function.
   */
  const computeFn = Fn(
    ([heightBuffer, normalBuffer]: [ReturnType<typeof storage>, ReturnType<typeof storage>]) => {
      const globalIdx = int(uint(globalId).x);
      const res = int(resolution);
      const totalSize = res.mul(res);

      If(globalIdx.greaterThanEqual(totalSize), () => {
        return;
      });

      // 2D Index
      const x = int(globalIdx.mod(res));
      const z = int(globalIdx.div(res));

      // Sample neighbors (central difference)
      const hL = sampleElevation(heightBuffer, x.sub(int(1)), z, res);
      const hR = sampleElevation(heightBuffer, x.add(int(1)), z, res);
      const hD = sampleElevation(heightBuffer, x, z.sub(int(1)), res);
      const hU = sampleElevation(heightBuffer, x, z.add(int(1)), res);

      // Calculate step size world-space: distance between adjacent vertices
      const step = uChunkSize.div(uResolution);
      const stepMul2 = step.mul(2.0);

      // World-space gradients (real slope)
      const dx = hR.sub(hL).div(stepMul2);
      const dz = hU.sub(hD).div(stepMul2);

      const normal = vec3(dx.negate(), float(1.0).div(uHeightScale), dz.negate()).normalize();

      // Use vec4 (xyz + w) for 16-byte alignment
      // Base index = globalIdx * 4 (each normal occupies 4 floats)
      const baseIdx = globalIdx.mul(4);
      normalBuffer.element(baseIdx.add(0)).assign(normal.x);
      normalBuffer.element(baseIdx.add(1)).assign(normal.y);
      normalBuffer.element(baseIdx.add(2)).assign(normal.z);
      normalBuffer.element(baseIdx.add(3)).assign(float(0.0));
    },
  );

  return {
    computeFn: computeFn,
    uniforms: {
      chunkSize: uChunkSize,
      resolution: uResolution,
      heightScale: uHeightScale,
    },
    resolution,
    workgroupSize: 64,
  };
}

/**
 * Layout of bind group for normal calculation.
 */
export const NORMAL_BIND_GROUP_LAYOUT = {
  entries: [
    {
      binding: 0,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: 'uniform' },
    },
    {
      binding: 1,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: 'read-only-storage' },
    },
    {
      binding: 2,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: 'storage' },
    },
  ],
} as const;

/**
 * Uniform buffer size in bytes (std140).
 * resolution (float), chunkSize (float), heightScale (float), padding (float)
 * = 16 bytes
 */
export const NORMAL_UNIFORM_SIZE = 16;
