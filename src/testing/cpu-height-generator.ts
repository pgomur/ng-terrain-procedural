import type { ChunkCoord, ChunkGPUResources, ChunkKey } from '../app/types/chunk';
import type { TerrainConfig } from '../app/types/terrain';
import type { HeightListener } from '../app/engine/gpu-generator';

export type GenerationOutcome = 'ok' | 'fail';
export type GenerationBehaviour = (key: ChunkKey, attempt: number) => GenerationOutcome;
export type HeightFunction = (x: number, z: number) => number;

export const coordKey = (c: ChunkCoord) => `${c.x}:${c.z}:${c.lod}` as ChunkKey;

interface Owner {
  readonly meta: { readonly coord: ChunkCoord };
}

export class CpuHeightGenerator {
  readonly live = new Map<number, ChunkGPUResources>();
  readonly attempts = new Map<ChunkKey, number>();
  readonly failHeightsOnce = new Set<ChunkKey>();
  created = 0;
  failures = 0;
  released = 0;
  staleCallbacks = 0;
  heightRequests = 0;

  private listener: HeightListener<Owner> | null = null;
  private nextSlot = 1;
  private pending: (() => void)[] = [];

  constructor(
    private readonly config: TerrainConfig,
    private readonly behaviour: GenerationBehaviour = () => 'ok',
    private readonly heightFn: HeightFunction = () => 50,
    private readonly delayMs = 1,
  ) {}

  setListener(listener: HeightListener<Owner> | null): void {
    this.listener = listener;
  }

  get generatedCount(): number {
    return this.created;
  }

  generate(coord: ChunkCoord, owner: Owner): ChunkGPUResources {
    const key = coordKey(coord);
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);
    if (this.behaviour(key, attempt) === 'fail') {
      this.failures++;
      throw new Error('simulated generation failure');
    }

    const slot = this.nextSlot++;
    const resolution = this.config.CHUNK_RESOLUTIONS[coord.lod];
    const resources: ChunkGPUResources = { pageId: coord.lod, slot, generation: 0, resolution };
    this.live.set(slot, resources);
    this.created++;

    const heights = this.heightsFor(coord, resolution);
    let min = Infinity;
    let max = -Infinity;
    for (const h of heights) {
      if (h < min) min = h;
      if (h > max) max = h;
    }
    this.pending.push(() => {
      if (!this.live.has(slot)) this.staleCallbacks++;
      this.listener?.onBounds(owner, min, max);
    });
    return resources;
  }

  heightsFor(coord: ChunkCoord, resolution: number): Float32Array {
    const size = this.config.CHUNK_SIZE;
    const heights = new Float32Array(resolution * resolution);
    for (let i = 0; i < heights.length; i++) {
      const lx = ((i % resolution) / (resolution - 1)) * size;
      const lz = (Math.floor(i / resolution) / (resolution - 1)) * size;
      heights[i] = this.heightFn(coord.x * size + lx, coord.z * size + lz);
    }
    return heights;
  }

  release(resources: ChunkGPUResources): void {
    if (!this.live.has(resources.slot)) throw new Error(`double release of slot ${resources.slot}`);
    this.live.delete(resources.slot);
    this.released++;
  }

  requestHeights(resources: ChunkGPUResources, owner: Owner): boolean {
    if (!this.live.has(resources.slot)) return false;
    this.heightRequests++;
    const key = coordKey(owner.meta.coord);
    this.pending.push(() => {
      if (this.failHeightsOnce.delete(key)) {
        this.listener?.onHeights(owner, null);
        return;
      }
      if (!this.live.has(resources.slot)) {
        this.staleCallbacks++;
        this.listener?.onHeights(owner, null);
        return;
      }
      this.listener?.onHeights(owner, this.heightsFor(owner.meta.coord, resources.resolution));
    });
    return true;
  }

  flush(): void {
    const batch = this.pending;
    this.pending = [];
    if (batch.length > 0) setTimeout(() => batch.forEach((callback) => callback()), this.delayMs);
  }
}
