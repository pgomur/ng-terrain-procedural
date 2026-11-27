---
title: GPU height generation
group: Guides
---

# GPU height generation

Terrain heights never exist on the CPU. {@link engine/gpu-generator!GPUGenerator | GPUGenerator} computes them with compute shaders straight into storage buffers that the vertex shader reads, so a new chunk costs one entry in a small job buffer and nothing is uploaded.

## The height atlas

Heights are stored in **pages**: one large storage buffer per page, divided into fixed-size **slots**, one chunk per slot. A page only holds chunks of one resolution, so a slot of a 65 × 65 page holds 4,225 floats.

| Per page  | Buffer                          | Content                                                              |
| --------- | ------------------------------- | -------------------------------------------------------------------- |
| `heights` | `float[capacity × resolution²]` | The heights, row by row (`index = z × resolution + x`).              |
| `bounds`  | `uint[capacity × 2]`            | Minimum and maximum height of each slot, encoded for atomics.        |
| `jobs`    | `vec4[GENERATION_BUDGET]`       | The chunks to generate in the next dispatch: world X, world Z, slot. |

The first page of a resolution is sized for the area its rings cover, plus 25 % headroom, with at least 16 slots. When it is full, a new page with a quarter of that capacity is added. No page exceeds the device's `maxStorageBufferBindingSize`. With the default configuration the first pages are:

| LOD | Resolution | Slots | Heights |
| --- | ---------- | ----- | ------- |
| 0   | 65 × 65    | 115   | 1.85 MB |
| 1   | 33 × 33    | 545   | 2.26 MB |
| 2   | 17 × 17    | 1,814 | 2.00 MB |
| 3   | 9 × 9      | 1,236 | 0.38 MB |

About 6.5 MB of heights in total. That is the figure shown as _Height atlas_ in the diagnostics panel, together with the bounds and job buffers.

Pages are never freed while the engine runs; released slots are reused. Every slot has a **generation** counter that grows when it is released, and every {@link types/chunk!ChunkGPUResources | ChunkGPUResources} handle carries the generation it was given. Results that arrive for an old generation are ignored, so a read-back that finishes after its chunk was released can never reach the slot's new owner.

Once a page's buffers are on the GPU, the CPU copy of its heights is dropped: it would be 6.5 MB of zeros.

## Generating a chunk

{@link engine/gpu-generator!GPUGenerator.generate | generate} only writes the chunk's world origin and slot into the page's job buffer and returns the handle. Nothing runs on the GPU yet.

{@link engine/gpu-generator!GPUGenerator.flush | flush}, called once per frame after all the generation of that frame, submits two compute dispatches per page with pending jobs:

1. **`reset`**, one thread per job: sets the slot's bounds to the empty range.
2. **`main`**, one thread per vertex of every job: computes the height, writes it into the slot and merges it into the slot's bounds.

So a frame that generates 16 chunks of LOD 0 dispatches 67,600 threads in 1,057 workgroups of 64. If a page receives more jobs in one frame than its job buffer holds, it is dispatched early and refilled.

Compute work and rendering share the WebGPU queue, and the compute passes are submitted first. A chunk generated in a frame is therefore drawn correctly in that same frame, with no fence and no waiting.

## The kernels

The heights come from fractional Brownian motion (fBm) over MaterialX gradient noise ({@link shaders/elevation.tsl! | elevation.tsl}):

```text
p         = (worldX, worldZ) × 0.001 + seedOffset
fbm(p)    = Σᵢ noise(p × lacunarityⁱ + shiftᵢ) × persistenceⁱ  /  Σᵢ persistenceⁱ
            for i = 0 … NOISE_OCTAVES − 1
height    = (fbm(p) × 0.5 + 0.5) × TERRAIN_HEIGHT_SCALE + TERRAIN_OFFSET_Y
```

- Each octave is shifted by a fixed vector so the octaves are not aligned around the origin.
- Dividing by the sum of amplitudes keeps the result in the same range whatever the number of octaves, so the terrain spans about `[TERRAIN_OFFSET_Y, TERRAIN_OFFSET_Y + TERRAIN_HEIGHT_SCALE]`.
- With `NOISE_WARP_ENABLED`, `p` is first displaced by two more fBm fields (`NOISE_WARP_OCTAVES` octaves, sampled at `p × NOISE_WARP_SCALE`, scaled by `NOISE_WARP_STRENGTH`), which bends ridges and valleys into more organic shapes.
- The seed does not change the noise function: {@link shaders/elevation.tsl!seedToNoiseOffset | seedToNoiseOffset} hashes it into an offset in `[0, 256)` on each axis, which moves the sampled region of the noise to a different, unrelated landscape.

Neighbouring chunks sample the same world positions along their shared edge, so their edge heights are identical without any communication between them.

### Exact bounds with atomics

WebGPU only has atomic min and max on integers. Each height is turned into an unsigned key whose integer order matches the float order: positive floats get their sign bit set, negative floats have all their bits inverted. `atomicMin` and `atomicMax` on these keys give the exact minimum and maximum of the chunk in one pass, and {@link shaders/elevation.tsl!decodeOrderedFloat | decodeOrderedFloat} turns them back into floats on the CPU.

## Reading results back

Only two things ever come back to the CPU, both asynchronously through pooled staging buffers:

| Read-back | When                                                                                      | Size                    | Used for                                                        |
| --------- | ----------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------- |
| Bounds    | Once per page per frame with new chunks, for the smallest range of slots that covers them | 8 bytes per slot        | Tighter frustum culling ([Streaming](streaming.md#visibility)). |
| Heights   | When the camera's 3 × 3 neighbourhood changes                                             | One slot, up to 16.5 KB | Collision ([Streaming](streaming.md#collision)).                |

Only one bounds read-back per page is in flight at a time; chunks generated meanwhile wait for the next one. A failed bounds read-back is retried; a failed height read-back is reported as missing and requested again when needed.

Staging buffers are kept in a pool of power-of-two sizes from 256 bytes, at most 4 per size and 16 in total, so the steady state allocates nothing. Their total size is _Read-back_ in the diagnostics panel.

## Pipeline warm-up

Compiling a WebGPU pipeline can take long enough to drop frames. During the loading screen, {@link engine/gpu-generator!GPUGenerator.prewarm | prewarm} creates the first page of every resolution and runs both kernels once with no jobs, and the engine renders one frame with one instance per page, so every compute and render pipeline is compiled before the terrain appears.
