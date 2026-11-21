import {
  If,
  Loop,
  Return,
  vec2,
  vec3,
  float,
  int,
  uint,
  Fn,
  uniform,
  storage,
  select,
  instanceIndex,
  vertexIndex,
  positionLocal,
  floatBitsToUint,
  atomicMin,
  atomicMax,
  atomicStore,
  mx_noise_float,
} from 'three/tsl';
import type { StorageBufferAttribute } from 'three/webgpu';

export const NOISE_FREQUENCY = 0.001;

export const MAX_NOISE_OCTAVES = 12;

export const BOUNDS_EMPTY_MIN_KEY = 0xffffffff;
export const BOUNDS_EMPTY_MAX_KEY = 0;

const SEED_OFFSET_RANGE = 256;

export function seedToNoiseOffset(seed: number): { x: number; z: number } {
  const hash = (v: number): number => {
    let h = v | 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
  return {
    x: hash(seed) * SEED_OFFSET_RANGE,
    z: hash(seed ^ 0x9e3779b9) * SEED_OFFSET_RANGE,
  };
}

const orderedKeyView = new DataView(new ArrayBuffer(4));

export function decodeOrderedFloat(key: number): number {
  const bits = key & 0x80000000 ? (key ^ 0x80000000) >>> 0 : ~key >>> 0;
  orderedKeyView.setUint32(0, bits);
  return orderedKeyView.getFloat32(0);
}

export function encodeOrderedFloat(value: number): number {
  orderedKeyView.setFloat32(0, value);
  const bits = orderedKeyView.getUint32(0);
  return (bits & 0x80000000 ? ~bits : bits ^ 0x80000000) >>> 0;
}

const fbm = Fn(
  ([p, octaves, persistence, lacunarity]: [
    ReturnType<typeof vec2>,
    ReturnType<typeof float>,
    ReturnType<typeof float>,
    ReturnType<typeof float>,
  ]) => {
    const total = float(0.0).toVar();
    const amplitude = float(1.0).toVar();
    const frequency = float(1.0).toVar();
    const norm = float(0.0).toVar();

    Loop({ start: int(0), end: int(octaves), type: 'int', condition: '<' }, ({ i }) => {
      const shift = vec2(17.13, 31.71).mul(float(i));
      total.addAssign(mx_noise_float(p.mul(frequency).add(shift)).mul(amplitude));
      norm.addAssign(amplitude);
      amplitude.mulAssign(persistence);
      frequency.mulAssign(lacunarity);
    });

    return total.div(norm.max(1e-6));
  },
);

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
    const q = p.mul(warpScale);
    const warpX = fbm(q.add(vec2(1.7, 9.2)), warpOctaves, float(0.5), float(2.0));
    const warpZ = fbm(q.add(vec2(8.3, 2.8)), warpOctaves, float(0.5), float(2.0));
    const warpedP = p.add(vec2(warpX, warpZ).mul(warpStrength));

    return fbm(warpedP, baseOctaves, basePersistence, baseLacunarity);
  },
);

export function createNoiseUniforms() {
  return {
    chunkSize: uniform(float(128)),
    seedOffsetX: uniform(float(0)),
    seedOffsetZ: uniform(float(0)),
    octaves: uniform(float(4)),
    persistence: uniform(float(0.5)),
    lacunarity: uniform(float(2.0)),
    heightScale: uniform(float(100)),
    offsetY: uniform(float(0)),
    warpEnabled: uniform(float(0)),
    warpStrength: uniform(float(0.3)),
    warpOctaves: uniform(float(1)),
    warpScale: uniform(float(0.5)),
  };
}

export type NoiseUniforms = ReturnType<typeof createNoiseUniforms>;

export interface HeightKernelOptions {
  readonly resolution: number;
  readonly maxJobs: number;
  readonly heights: StorageBufferAttribute;
  readonly bounds: StorageBufferAttribute;
  readonly jobs: StorageBufferAttribute;
  readonly noise: NoiseUniforms;
}

export function createHeightKernels(options: HeightKernelOptions) {
  const { resolution, maxJobs, noise } = options;
  const verticesPerChunk = resolution * resolution;

  const heights = storage(options.heights, 'float', options.heights.count);
  const bounds = storage(options.bounds, 'uint', options.bounds.count).toAtomic();
  const resetBounds = storage(options.bounds, 'uint', options.bounds.count).toAtomic();
  const jobs = storage(options.jobs, 'vec4', maxJobs);
  const resetJobs = storage(options.jobs, 'vec4', maxJobs);
  const jobCount = uniform(float(0));

  const res = int(resolution);
  const perChunk = int(verticesPerChunk);
  const invSpan = float(1 / (resolution - 1));

  const main = Fn(() => {
    const globalIdx = int(instanceIndex);

    If(globalIdx.greaterThanEqual(int(jobCount).mul(perChunk)), () => {
      Return();
    });

    const jobIndex = globalIdx.div(perChunk);
    const local = globalIdx.mod(perChunk);
    const job = jobs.element(jobIndex);
    const slot = int(job.z);

    const x = local.mod(res);
    const z = local.div(res);

    const u = float(x).mul(invSpan);
    const v = float(z).mul(invSpan);

    const worldX = job.x.add(u.mul(noise.chunkSize));
    const worldZ = job.y.add(v.mul(noise.chunkSize));

    const noiseP = vec2(worldX, worldZ)
      .mul(NOISE_FREQUENCY)
      .add(vec2(noise.seedOffsetX, noise.seedOffsetZ));

    const elevation = float(0.0).toVar();

    If(noise.warpEnabled.greaterThan(float(0.5)), () => {
      elevation.assign(
        domainWarp(
          noiseP,
          noise.warpStrength,
          noise.warpOctaves,
          noise.warpScale,
          noise.octaves,
          noise.persistence,
          noise.lacunarity,
        ),
      );
    }).Else(() => {
      elevation.assign(fbm(noiseP, noise.octaves, noise.persistence, noise.lacunarity));
    });

    elevation.assign(elevation.mul(0.5).add(0.5));
    elevation.mulAssign(noise.heightScale);
    elevation.addAssign(noise.offsetY);

    heights.element(slot.mul(perChunk).add(local)).assign(elevation);

    const bits = uint(floatBitsToUint(elevation));
    const key = bits.bitXor(
      select(bits.shiftRight(uint(31)).equal(uint(1)), uint(0xffffffff), uint(0x80000000)),
    );

    atomicMin(bounds.element(slot.mul(2)), key);
    atomicMax(bounds.element(slot.mul(2).add(1)), key);
  })().compute(maxJobs * verticesPerChunk);

  const reset = Fn(() => {
    const jobIndex = int(instanceIndex);

    If(jobIndex.greaterThanEqual(int(jobCount)), () => {
      Return();
    });

    const slot = int(resetJobs.element(jobIndex).z);

    atomicStore(resetBounds.element(slot.mul(2)), uint(BOUNDS_EMPTY_MIN_KEY));
    atomicStore(resetBounds.element(slot.mul(2).add(1)), uint(BOUNDS_EMPTY_MAX_KEY));
  })().compute(maxJobs);

  return { main, reset, jobCount, verticesPerChunk };
}

export function createHeightDisplacementNode(
  heightsAttribute: StorageBufferAttribute,
  resolution: number,
  slot: ReturnType<typeof uniform>,
) {
  const heights = storage(heightsAttribute, 'float', heightsAttribute.count).toReadOnly();
  const index = int(slot).mul(int(resolution * resolution)).add(int(vertexIndex));

  return vec3(positionLocal.x, heights.element(index), positionLocal.z);
}
