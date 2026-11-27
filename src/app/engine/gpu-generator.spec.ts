import type { StorageBufferAttribute, WebGPURenderer } from 'three/webgpu';
import { encodeOrderedFloat } from '../shaders/elevation.tsl';
import { DEFAULT_TERRAIN_CONFIG } from '../types/terrain';
import { GPUGenerator } from './gpu-generator';

describe('GPUGenerator', () => {
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  afterEach(() => vi.restoreAllMocks());

  const setup = () => {
    const getArrayBufferAsync = vi.fn(() => Promise.reject(new Error('device lost')));
    const renderer = { compute: vi.fn(), getArrayBufferAsync } as unknown as WebGPURenderer;
    const generator = new GPUGenerator<string>(renderer, DEFAULT_TERRAIN_CONFIG);
    const onHeights = vi.fn();
    generator.setListener({ onBounds: vi.fn(), onHeights });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    return { generator, getArrayBufferAsync, onHeights };
  };

  it('waits for the next flush before retrying the bounds', async () => {
    const { generator, getArrayBufferAsync } = setup();
    generator.generate({ x: 0, z: 0, lod: 0 }, 'chunk');
    generator.flush();
    await settle();
    expect(getArrayBufferAsync).toHaveBeenCalledTimes(1);

    await settle();
    expect(getArrayBufferAsync).toHaveBeenCalledTimes(1);

    generator.flush();
    await settle();
    expect(getArrayBufferAsync).toHaveBeenCalledTimes(2);
  });

  it('stops retrying once disposed', async () => {
    const { generator, getArrayBufferAsync } = setup();
    generator.generate({ x: 0, z: 0, lod: 0 }, 'chunk');
    generator.flush();
    generator.dispose();
    await settle();
    generator.flush();
    await settle();
    expect(getArrayBufferAsync).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('reports a failed height readback once without retrying it', async () => {
    const { generator, getArrayBufferAsync, onHeights } = setup();
    const resources = generator.generate({ x: 0, z: 0, lod: 0 }, 'chunk');
    generator.requestHeights(resources, 'chunk');
    generator.flush();
    await settle();
    expect(onHeights).toHaveBeenCalledExactlyOnceWith('chunk', null);
    const calls = getArrayBufferAsync.mock.calls.length;
    await settle();
    expect(getArrayBufferAsync.mock.calls.length).toBe(calls);
  });

  it('drops the job of a chunk released before the dispatch and ignores bounds that arrive after a release', async () => {
    let deliver: () => void = () => undefined;
    const getArrayBufferAsync = vi.fn(
      (attribute: StorageBufferAttribute) =>
        new Promise<ArrayBuffer>((resolve) => {
          const keys = new Uint32Array(attribute.array.length);
          for (let i = 0; i < keys.length; i += 2) {
            keys[i] = encodeOrderedFloat(10);
            keys[i + 1] = encodeOrderedFloat(20);
          }
          deliver = () => resolve(keys.buffer);
        }),
    );
    const compute = vi.fn();
    const renderer = { compute, getArrayBufferAsync } as unknown as WebGPURenderer;
    const generator = new GPUGenerator<string>(renderer, DEFAULT_TERRAIN_CONFIG);
    const onBounds = vi.fn();
    generator.setListener({ onBounds, onHeights: vi.fn() });

    const a = generator.generate({ x: 0, z: 0, lod: 0 }, 'a');
    const b = generator.generate({ x: 1, z: 0, lod: 0 }, 'b');
    const c = generator.generate({ x: 2, z: 0, lod: 0 }, 'c');
    generator.release(b);
    const d = generator.generate({ x: 3, z: 0, lod: 0 }, 'd');
    expect(d.slot).toBe(b.slot);

    const page = (generator as unknown as { pages: { jobs: { array: Float32Array } }[] }).pages[a.pageId];
    const queuedSlots = [0, 1, 2].map((i) => page.jobs.array[i * 4 + 2]).sort();
    expect(queuedSlots).toEqual([a.slot, c.slot, d.slot].sort());

    compute.mockClear();
    generator.flush();
    expect(compute.mock.calls[0][1]).toBe(3);

    generator.release(a);
    deliver();
    await settle();

    expect(onBounds.mock.calls.map(([owner]) => owner as string).sort()).toEqual(['c', 'd']);
    expect(onBounds).toHaveBeenCalledWith('c', 10, 20);
  });
});
