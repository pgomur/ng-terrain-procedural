import {
  If,
  Loop,
  Return,
  vec2,
  float,
  int,
  Fn,
  uniform,
  storage,
  instanceIndex,
  mx_noise_float,
} from 'three/tsl';

export const NOISE_FREQUENCY = 0.001;

export const MAX_NOISE_OCTAVES = 12;

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

export function createElevationComputeNode(resolution: number) {
  const uChunkOriginX = uniform(float(0));
  const uChunkOriginZ = uniform(float(0));
  const uChunkSize = uniform(float(128));
  const uSeedOffsetX = uniform(float(0));
  const uSeedOffsetZ = uniform(float(0));
  const uOctaves = uniform(float(4));
  const uPersistence = uniform(float(0.5));
  const uLacunarity = uniform(float(2.0));
  const uHeightScale = uniform(float(100));
  const uOffsetY = uniform(float(0));
  const uWarpEnabled = uniform(float(0));
  const uWarpStrength = uniform(float(0.3));
  const uWarpOctaves = uniform(float(1));
  const uWarpScale = uniform(float(0.5));

  const res = int(resolution);
  const totalSize = int(resolution * resolution);
  const invSpan = float(1 / (resolution - 1));

  const computeFn = Fn(([outputBuffer]: [ReturnType<typeof storage>]) => {
    const globalIdx = int(instanceIndex);

    If(globalIdx.greaterThanEqual(totalSize), () => {
      Return();
    });

    const x = globalIdx.mod(res);
    const z = globalIdx.div(res);

    const u = float(x).mul(invSpan);
    const v = float(z).mul(invSpan);

    const worldX = uChunkOriginX.add(u.mul(uChunkSize));
    const worldZ = uChunkOriginZ.add(v.mul(uChunkSize));

    const noiseP = vec2(worldX, worldZ)
      .mul(NOISE_FREQUENCY)
      .add(vec2(uSeedOffsetX, uSeedOffsetZ));

    const elevation = float(0.0).toVar();

    If(uWarpEnabled.greaterThan(float(0.5)), () => {
      elevation.assign(
        domainWarp(
          noiseP,
          uWarpStrength,
          uWarpOctaves,
          uWarpScale,
          uOctaves,
          uPersistence,
          uLacunarity,
        ),
      );
    }).Else(() => {
      elevation.assign(fbm(noiseP, uOctaves, uPersistence, uLacunarity));
    });

    elevation.assign(elevation.mul(0.5).add(0.5));
    elevation.mulAssign(uHeightScale);
    elevation.addAssign(uOffsetY);

    outputBuffer.element(globalIdx).assign(elevation);
  });

  return {
    computeFn,
    uniforms: {
      chunkOriginX: uChunkOriginX,
      chunkOriginZ: uChunkOriginZ,
      chunkSize: uChunkSize,
      seedOffsetX: uSeedOffsetX,
      seedOffsetZ: uSeedOffsetZ,
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
