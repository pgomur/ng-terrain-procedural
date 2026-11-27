/**
 * The terrain heights, written in Three.js Shading Language (TSL): the same source compiles to WGSL compute and vertex shaders.
 *
 * Heights are made in one place and used in another:
 *
 * | Where | Node | What it does |
 * | --- | --- | --- |
 * | Compute shader | {@link createHeightKernels} | Evaluates the noise at every vertex of a batch of chunks, writes the heights into their atlas slots and tracks each chunk's exact minimum and maximum. |
 * | Vertex shader | {@link createTerrainPositionNode} | Reads a vertex's height back from the atlas, stitches it onto a coarser neighbour if needed, and places it in the world. |
 *
 * The height at a world position `(x, z)` is:
 *
 * ```text
 * p      = (x, z) × 0.001 + seedToNoiseOffset(NOISE_SEED)
 * height = (fbm(p) × 0.5 + 0.5) × TERRAIN_HEIGHT_SCALE + TERRAIN_OFFSET_Y
 * ```
 *
 * where `fbm` sums `NOISE_OCTAVES` octaves of MaterialX Perlin noise, optionally after warping `p` with a second noise field. The noise parameters are uniforms ({@link NoiseUniforms}), set once from the configuration by the {@link engine/gpu-generator!GPUGenerator | GPUGenerator}.
 *
 * The CPU helpers here are the other half of the GPU code: {@link encodeOrderedFloat} and {@link decodeOrderedFloat} define the integer keys the kernel uses for atomic bounds, and {@link seedToNoiseOffset} turns the seed into the noise offset.
 *
 * See [GPU height generation](../../../guides/gpu-generation.md#the-kernels).
 *
 * @module
 */
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
  computeKernel,
  instanceIndex,
  attribute,
  vec4,
  positionLocal,
  floatBitsToUint,
  atomicMin,
  atomicMax,
  atomicStore,
  mx_noise_float,
} from 'three/tsl';
import type { ComputeNode, Node, StorageBufferAttribute, UniformNode } from 'three/webgpu';

const NOISE_FREQUENCY = 0.001;

/**
 * Upper limit applied to `NOISE_OCTAVES` and `NOISE_WARP_OCTAVES`.
 *
 * Octave loops run on the GPU with a uniform bound, so the limit only protects against accidental very slow shaders: each octave is one more noise evaluation per vertex.
 */
export const MAX_NOISE_OCTAVES = 12;

const BOUNDS_EMPTY_MIN_KEY = 0xffffffff;
const BOUNDS_EMPTY_MAX_KEY = 0;

const SEED_OFFSET_RANGE = 256;
const COMPUTE_WORKGROUP_SIZE = 64;

/**
 * Offset of the noise domain, in noise units.
 *
 * Returned by {@link seedToNoiseOffset}.
 */
export interface NoiseOffset {
  /** Offset along X. */
  readonly x: number;
  /** Offset along Z. */
  readonly z: number;
}

/**
 * Turns a world seed into a deterministic offset of the noise domain, so each seed shows a different region of the same noise.
 *
 * @param seed - World seed; only its 32-bit integer part is used.
 * @returns An offset in noise units, each component in `[0, 256)`.
 *
 * The seed is mixed with an integer hash, then scaled to the offset range. The noise is not periodic over that range, so every seed gives an unrelated landscape, and the same seed always gives the same one, on any device.
 *
 * @example
 * For the default seed, returns about `{ x: 60.28, z: 242.47 }`:
 * ```ts
 * seedToNoiseOffset(12345);
 * ```
 */
export function seedToNoiseOffset(seed: number): NoiseOffset {
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

/**
 * Inverse of {@link encodeOrderedFloat}: recovers the float from an ordered key read back from the GPU.
 *
 * @param key - Unsigned 32-bit key.
 * @returns The 32-bit float value.
 */
export function decodeOrderedFloat(key: number): number {
  const bits = key & 0x80000000 ? (key ^ 0x80000000) >>> 0 : ~key >>> 0;
  orderedKeyView.setUint32(0, bits);
  return orderedKeyView.getFloat32(0);
}

/**
 * Maps a 32-bit float to an unsigned 32-bit key whose integer order matches the float order, so atomic integer minimum and maximum can track float bounds. The compute kernel applies the same mapping.
 *
 * @param value - Value to encode; it is rounded to 32 bits.
 * @returns The key.
 *
 * Positive floats get their sign bit set; negative floats have all their bits inverted. As a result, for any two floats `a < b`, `encodeOrderedFloat(a) < encodeOrderedFloat(b)`.
 *
 * @example
 * ```ts
 * encodeOrderedFloat(-1);
 * encodeOrderedFloat(0);
 * encodeOrderedFloat(100);
 * ```
 * Returns `0x407fffff`, `0x80000000` and `0xc2c80000`, in increasing order like the floats.
 */
export function encodeOrderedFloat(value: number): number {
  orderedKeyView.setFloat32(0, value);
  const bits = orderedKeyView.getUint32(0);
  return (bits & 0x80000000 ? ~bits : bits ^ 0x80000000) >>> 0;
}

const fbm = Fn(([p, octaves, persistence, lacunarity]: [Node<'vec2'>, Node<'float'>, Node<'float'>, Node<'float'>]) => {
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
});

const domainWarp = Fn(
  ([p, warpStrength, warpOctaves, warpScale, baseOctaves, basePersistence, baseLacunarity]: [
    Node<'vec2'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>,
  ]) => {
    const q = p.mul(warpScale);
    const warpX = fbm(q.add(vec2(1.7, 9.2)), warpOctaves, float(0.5), float(2.0));
    const warpZ = fbm(q.add(vec2(8.3, 2.8)), warpOctaves, float(0.5), float(2.0));
    const warpedP = p.add(vec2(warpX, warpZ).mul(warpStrength));

    return fbm(warpedP, baseOctaves, basePersistence, baseLacunarity);
  },
);

/**
 * Uniforms read by the height kernels. {@link engine/gpu-generator!GPUGenerator | GPUGenerator} sets them from the {@link types/terrain!TerrainConfig | TerrainConfig}.
 *
 * Created once per generator by {@link createNoiseUniforms} and shared by the kernels of every page, so the whole terrain uses the same parameters.
 */
export interface NoiseUniforms {
  /** `CHUNK_SIZE`. */
  readonly chunkSize: UniformNode<'float', number>;
  /** Offset of the noise domain along X derived from the seed. See {@link seedToNoiseOffset}. */
  readonly seedOffsetX: UniformNode<'float', number>;
  /** Offset of the noise domain along Z derived from the seed. */
  readonly seedOffsetZ: UniformNode<'float', number>;
  /** `NOISE_OCTAVES`, clamped to `1`–`MAX_NOISE_OCTAVES`. */
  readonly octaves: UniformNode<'float', number>;
  /** `NOISE_PERSISTENCE`. */
  readonly persistence: UniformNode<'float', number>;
  /** `NOISE_LACUNARITY`. */
  readonly lacunarity: UniformNode<'float', number>;
  /** `TERRAIN_HEIGHT_SCALE`. */
  readonly heightScale: UniformNode<'float', number>;
  /** `TERRAIN_OFFSET_Y`. */
  readonly offsetY: UniformNode<'float', number>;
  /** `1` when `NOISE_WARP_ENABLED`, otherwise `0`. */
  readonly warpEnabled: UniformNode<'float', number>;
  /** `NOISE_WARP_STRENGTH`. */
  readonly warpStrength: UniformNode<'float', number>;
  /** `NOISE_WARP_OCTAVES`, clamped to `1`–`MAX_NOISE_OCTAVES`. */
  readonly warpOctaves: UniformNode<'float', number>;
  /** `NOISE_WARP_SCALE`. */
  readonly warpScale: UniformNode<'float', number>;
}

/**
 * Creates the uniforms read by the height kernels, with neutral values.
 *
 * The values are placeholders: the {@link engine/gpu-generator!GPUGenerator | GPUGenerator} overwrites them from the configuration right after, rounding and clamping both octave counts to `1`–{@link MAX_NOISE_OCTAVES}.
 *
 * @returns One uniform node per noise parameter.
 */
export function createNoiseUniforms(): NoiseUniforms {
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

/**
 * Buffers and settings shared by the height kernels of one atlas page.
 *
 * Passed by the {@link engine/gpu-generator!GPUGenerator | GPUGenerator} when it creates a page; each page has its own pair of kernels bound to its buffers.
 */
export interface HeightKernelOptions {
  /**
   * Vertices per side of the page's chunks.
   */
  readonly resolution: number;
  /**
   * Maximum jobs per dispatch; sizes the job list.
   */
  readonly maxJobs: number;
  /**
   * Height atlas page the kernel writes to.
   */
  readonly heights: StorageBufferAttribute;
  /**
   * Two ordered keys per slot, the minimum and maximum height, updated atomically.
   */
  readonly bounds: StorageBufferAttribute;
  /**
   * Job list: one `vec4` per job with the chunk's world X and Z origin and its slot.
   */
  readonly jobs: StorageBufferAttribute;
  /**
   * Noise parameters.
   */
  readonly noise: NoiseUniforms;
}

/**
 * Compute kernels of one atlas page, returned by {@link createHeightKernels}.
 *
 * Dispatched by {@link engine/gpu-generator!GPUGenerator.flush | GPUGenerator.flush}: `reset` with `jobCount` threads, then `main` with `jobCount × verticesPerChunk` threads, after setting {@link HeightKernels.jobCount}.
 */
export interface HeightKernels {
  /** Generates the heights and bounds of the queued jobs. Dispatch `jobCount × verticesPerChunk` threads. */
  readonly main: ComputeNode;
  /** Empties the bounds of the queued jobs' slots. Dispatch `jobCount` threads, before {@link HeightKernels.main}. */
  readonly reset: ComputeNode;
  /** Number of queued jobs; set it before dispatching. */
  readonly jobCount: UniformNode<'float', number>;
  /** Vertices per chunk, `resolution²`. */
  readonly verticesPerChunk: number;
}

/**
 * Builds the compute kernels that generate the heights of a batch of chunks.
 *
 * `main` runs one thread per vertex: it evaluates fractional Brownian motion of MaterialX Perlin noise at the vertex's world position (optionally domain-warped), maps it to `[TERRAIN_OFFSET_Y, TERRAIN_OFFSET_Y + TERRAIN_HEIGHT_SCALE]`, stores it in the chunk's slot and folds it into the slot's bounds with atomic minimum and maximum. `reset` runs one thread per job and empties those bounds first. Threads beyond `jobCount` exit immediately, so both kernels can be dispatched with the size of the current batch.
 *
 * Both kernels use workgroups of 64 threads. The job buffer holds one `vec4` per chunk: its world X and Z origin and its slot. The bounds of slot `s` are the two `uint` at `2s` (minimum key) and `2s + 1` (maximum key), encoded with {@link encodeOrderedFloat}.
 *
 * @param options - Page buffers and noise parameters.
 * @returns The kernels and their dispatch parameters.
 */
export function createHeightKernels(options: HeightKernelOptions): HeightKernels {
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

  const main = computeKernel(
    Fn(() => {
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

      const noiseP = vec2(worldX, worldZ).mul(NOISE_FREQUENCY).add(vec2(noise.seedOffsetX, noise.seedOffsetZ));

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

      const bits = uint(floatBitsToUint(elevation) as unknown as Node<'uint'>);
      const key = bits.bitXor(select(bits.shiftRight(uint(31)).equal(uint(1)), uint(0xffffffff), uint(0x80000000)));

      atomicMin(bounds.element(slot.mul(2)), key);
      atomicMax(bounds.element(slot.mul(2).add(1)), key);
    })(),
    [COMPUTE_WORKGROUP_SIZE],
  );

  const reset = computeKernel(
    Fn(() => {
      const jobIndex = int(instanceIndex);

      If(jobIndex.greaterThanEqual(int(jobCount)), () => {
        Return();
      });

      const slot = int(resetJobs.element(jobIndex).z);

      atomicStore(resetBounds.element(slot.mul(2)), uint(BOUNDS_EMPTY_MIN_KEY));
      atomicStore(resetBounds.element(slot.mul(2).add(1)), uint(BOUNDS_EMPTY_MAX_KEY));
    })(),
    [COMPUTE_WORKGROUP_SIZE],
  );

  return { main, reset, jobCount, verticesPerChunk };
}

/**
 * Builds the vertex position of the terrain materials.
 *
 * Each instance carries the chunk's world origin, its atlas slot and its seam code. The node reads the vertex height from the slot, moves edge vertices onto coarser neighbours as {@link math/chunk-coord!stitchedHeight | stitchedHeight} does, and lowers skirt vertices by the skirt depth.
 *
 * @param heightsAttribute - Height atlas page.
 * @param resolution - Vertices per side of the page's chunks.
 * @param skirtDepth - Depth of the skirts in world units.
 * @returns The world-space position node.
 */
export function createTerrainPositionNode(
  heightsAttribute: StorageBufferAttribute,
  resolution: number,
  skirtDepth: number,
) {
  const heights = storage(heightsAttribute, 'float', heightsAttribute.count).toReadOnly();

  return Fn(() => {
    const data = vec4(attribute('instanceData', 'vec4'));
    const res = int(resolution);
    const last = int(resolution - 1);
    const base = int(data.z).mul(int(resolution * resolution));
    const code = int(data.w);
    const index = int(attribute('heightIndex', 'float'));
    const gx = index.mod(res);
    const gz = index.div(res);

    const height = float(heights.element(base.add(index))).toVar();

    const stitch = (diff: Node<'int'>, t: Node<'int'>, toIndex: (i: Node<'int'>) => Node<'int'>) => {
      If(diff.greaterThan(int(0)), () => {
        const step = int(1).shiftLeft(diff);
        const a = t.div(step).mul(step);
        const next = a.add(step);
        const b = int(select(next.greaterThan(last), last, next));
        const f = float(t.sub(a)).div(float(step));
        const ha = float(heights.element(base.add(toIndex(a))));
        const hb = float(heights.element(base.add(toIndex(b))));
        height.assign(ha.add(hb.sub(ha).mul(f)));
      });
    };

    If(gx.equal(int(0)), () => {
      stitch(code.bitAnd(int(3)), gz, (i) => i.mul(res));
    });
    If(gx.equal(last), () => {
      stitch(code.shiftRight(int(2)).bitAnd(int(3)), gz, (i) => i.mul(res).add(last));
    });
    If(gz.equal(int(0)), () => {
      stitch(code.shiftRight(int(4)).bitAnd(int(3)), gx, (i) => i);
    });
    If(gz.equal(last), () => {
      stitch(code.shiftRight(int(6)).bitAnd(int(3)), gx, (i) => last.mul(res).add(i));
    });

    return vec3(positionLocal.x.add(data.x), height.add(positionLocal.y.mul(skirtDepth)), positionLocal.z.add(data.y));
  })();
}
