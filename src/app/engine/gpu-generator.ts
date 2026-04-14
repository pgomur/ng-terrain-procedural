import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { storage } from 'three/tsl';

import { createElevationComputeNode } from '../shaders/elevation.tsl';
import { createNormalComputeNode } from '../shaders/normal.tsl';
import { ChunkCoord, ChunkGeometryData, ChunkBounds, ChunkGPUResources } from '../types/chunk';
import { TerrainConfig } from '../types/terrain';

type StorageBufferAttribute = THREE.InstancedBufferAttribute & {
  isStorageBufferAttribute?: boolean;
  gpuWrite?: boolean;
  buffer?: GPUBuffer;
};

export class GPUGenerator {
  private readonly renderer: WebGPURenderer;
  private readonly config: TerrainConfig;

  private computePipelines = new Map<
    number,
    {
      elevationNode: ReturnType<typeof createElevationComputeNode>;
      normalNode: ReturnType<typeof createNormalComputeNode>;
      positionStorageNode: any;
      normalStorageNode: any;
      elevationCompute: any;
      normalCompute: any;
    }
  >();

  private bufferPool = new Map<number, StorageBufferAttribute[]>();
  private indexBuffers = new Map<number, THREE.BufferAttribute>();
  private stagingBuffers = new Map<number, GPUBuffer[]>();

  private device: GPUDevice | null = null;
  private queue: GPUQueue | null = null;
  private backend: any = null;

  constructor(renderer: WebGPURenderer, config: TerrainConfig) {
    this.renderer = renderer;
    this.config = config;
    this.extractWebGPUBackend();
  }

  private extractWebGPUBackend() {
    this.backend = (this.renderer as any).backend;
    if (this.backend?.device) {
      this.device = this.backend.device as GPUDevice;
      this.queue = this.device.queue;
    }
  }

  async generateChunk(
    coord: ChunkCoord,
    existingResources?: ChunkGPUResources | null,
  ): Promise<{
    geometry?: ChunkGeometryData;
    bounds: ChunkBounds;
    gpuResources: ChunkGPUResources;
    readyToRender: boolean;
  }> {
    if (!this.device || !this.queue) {
      throw new Error('WebGPU no inicializado');
    }

    const resolution = this.config.CHUNK_RESOLUTIONS[coord.lod];
    const vertexCount = resolution * resolution;

    const pipeline = this.getComputePipeline(resolution);

    const positionStorage = this.getStorageBuffer(vertexCount);
    const normalStorage = this.getStorageBuffer(vertexCount * 4);

    pipeline.positionStorageNode.value = positionStorage;
    pipeline.normalStorageNode.value = normalStorage;

    this.updateElevationUniforms(pipeline.elevationNode, coord);

    this.renderer.compute(pipeline.elevationCompute as any);
    this.renderer.compute(pipeline.normalCompute as any);

    await this.waitForGPU();

    if ((this.renderer as any).resolveTimestamps) {
      (this.renderer as any).resolveTimestamps();
    }

    let posGPUBuffer = this.extractGPUBuffer(positionStorage);
    let normGPUBuffer = this.extractGPUBuffer(normalStorage);

    if (!posGPUBuffer || !normGPUBuffer) {
      await new Promise((r) => requestAnimationFrame(r));
      posGPUBuffer = this.extractGPUBuffer(positionStorage);
      normGPUBuffer = this.extractGPUBuffer(normalStorage);
    }

    const gpuResources: ChunkGPUResources = {
      positionBuffer: positionStorage,
      normalBuffer: normalStorage,
      indexBuffer: this.getIndexBuffer(resolution),
      uniformBuffer: null,
      bindGroup: null,
      indexCount: (resolution - 1) * (resolution - 1) * 6,
      vertexCount: vertexCount,
    } as unknown as ChunkGPUResources;

    if (posGPUBuffer && normGPUBuffer) {
      const { positions, normals, minHeight, maxHeight } = await this.readbackGeometry(
        posGPUBuffer,
        normGPUBuffer,
        resolution,
      );

      const geometry: ChunkGeometryData = {
        positions,
        normals,
        indices: this.generateIndices(resolution),
        bounds: { minHeight, maxHeight },
      };

      return {
        geometry,
        bounds: this.calculateBoundsFromGeometry(geometry, coord),
        gpuResources,
        readyToRender: true,
      };
    }

    return {
      bounds: this.estimateBounds(coord),
      gpuResources,
      readyToRender: true,
    };
  }

  private getComputePipeline(resolution: number) {
    if (!this.computePipelines.has(resolution)) {
      const vertexCount = resolution * resolution;

      const posDummy = new Float32Array(vertexCount);
      const posAttr = new THREE.InstancedBufferAttribute(posDummy, 1) as StorageBufferAttribute;
      posAttr.isStorageBufferAttribute = true;

      const normDummy = new Float32Array(vertexCount * 4);
      const normAttr = new THREE.InstancedBufferAttribute(normDummy, 1) as StorageBufferAttribute;
      normAttr.isStorageBufferAttribute = true;

      const positionStorageNode = storage(posAttr as any, 'float', vertexCount);
      const normalStorageNode = storage(normAttr as any, 'float', vertexCount * 4);

      const elevationNode = createElevationComputeNode(resolution);
      const elevationCompute = elevationNode.computeFn(positionStorageNode).compute(vertexCount);

      const normalNode = createNormalComputeNode(resolution);
      const normalCompute = normalNode
        .computeFn(positionStorageNode, normalStorageNode)
        .compute(vertexCount);

      this.computePipelines.set(resolution, {
        elevationNode,
        normalNode,
        positionStorageNode,
        normalStorageNode,
        elevationCompute,
        normalCompute,
      });
    }
    return this.computePipelines.get(resolution)!;
  }

  private updateElevationUniforms(
    node: ReturnType<typeof createElevationComputeNode>,
    coord: ChunkCoord,
  ) {
    const u = node.uniforms;
    u.chunkOriginX.value = coord.x * this.config.CHUNK_SIZE;
    u.chunkOriginZ.value = coord.z * this.config.CHUNK_SIZE;
    u.chunkSize.value = this.config.CHUNK_SIZE;
    u.seed.value = this.config.NOISE_SEED + (coord.x * 374761 + coord.z * 668265);
    u.octaves.value = this.config.NOISE_OCTAVES;
    u.persistence.value = this.config.NOISE_PERSISTENCE;
    u.lacunarity.value = this.config.NOISE_LACUNARITY;
    u.heightScale.value = this.config.TERRAIN_HEIGHT_SCALE;
    u.offsetY.value = this.config.TERRAIN_OFFSET_Y;
    u.warpEnabled.value = this.config.NOISE_WARP_ENABLED ? 1 : 0;
    u.warpStrength.value = this.config.NOISE_WARP_STRENGTH;
    u.warpOctaves.value = this.config.NOISE_WARP_OCTAVES;
    u.warpScale.value = this.config.NOISE_WARP_SCALE;
  }

  private getStorageBuffer(floatCount: number): StorageBufferAttribute {
    const byteLength = floatCount * 4;

    const pooled = this.bufferPool.get(byteLength);
    if (pooled && pooled.length > 0) {
      const buffer = pooled.pop()!;
      (buffer.array as Float32Array).fill(0);
      return buffer;
    }

    const array = new Float32Array(floatCount);
    const attr = new THREE.InstancedBufferAttribute(array, 1) as StorageBufferAttribute;
    attr.isStorageBufferAttribute = true;
    attr.gpuWrite = true;

    return attr;
  }

  private extractGPUBuffer(storageAttr: StorageBufferAttribute): GPUBuffer | null {
    if ((storageAttr as any).buffer) {
      return (storageAttr as any).buffer;
    }

    if (this.backend?.get) {
      const resource = this.backend.get(storageAttr);
      if (resource?.buffer) return resource.buffer;
    }

    if (this.backend?.data?.has) {
      const resource = this.backend.data.get(storageAttr);
      if (resource?.buffer) return resource.buffer;
    }

    return null;
  }

  private getIndexBuffer(resolution: number): THREE.BufferAttribute {
    if (this.indexBuffers.has(resolution)) {
      return this.indexBuffers.get(resolution)!;
    }

    const indices = this.generateIndices(resolution);
    const buffer = new THREE.BufferAttribute(indices, 1);
    this.indexBuffers.set(resolution, buffer);
    return buffer;
  }

  private async waitForGPU(): Promise<void> {
    if (!this.device || !this.queue) {
      await new Promise((r) => setTimeout(r, 0));
      return;
    }

    if ((this.queue as any)?.onSubmittedWorkDone) {
      await (this.queue as any).onSubmittedWorkDone();
      return;
    }

    try {
      const encoder = this.device.createCommandEncoder();
      this.queue.submit([encoder.finish()]);
      await new Promise((r) => setTimeout(r, 0));
    } catch {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  private async readbackGeometry(
    positionBuffer: GPUBuffer,
    normalBuffer: GPUBuffer,
    resolution: number,
  ): Promise<{
    positions: Float32Array;
    normals: Float32Array;
    minHeight: number;
    maxHeight: number;
  }> {
    if (!this.device) {
      throw new Error('WebGPU device no disponible');
    }

    if (!this.queue) {
      throw new Error('WebGPU queue no disponible');
    }

    const vertexCount = resolution * resolution;
    const posSize = vertexCount * 4;
    const normSize = vertexCount * 16;

    const posStaging = this.getStagingBuffer(posSize);
    const normStaging = this.getStagingBuffer(normSize);

    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(positionBuffer, 0, posStaging, 0, posSize);
    encoder.copyBufferToBuffer(normalBuffer, 0, normStaging, 0, normSize);
    this.queue.submit([encoder.finish()]);

    await posStaging.mapAsync(GPUMapMode.READ);
    await normStaging.mapAsync(GPUMapMode.READ);

    const posMapped = new Float32Array(posStaging.getMappedRange());
    const normMapped = new Float32Array(normStaging.getMappedRange());

    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    let minHeight = Infinity,
      maxHeight = -Infinity;

    for (let i = 0; i < vertexCount; i++) {
      const x = i % resolution;
      const z = Math.floor(i / resolution);
      const height = posMapped[i];

      if (height < minHeight) minHeight = height;
      if (height > maxHeight) maxHeight = height;

      positions[i * 3] = (x / (resolution - 1)) * this.config.CHUNK_SIZE;
      positions[i * 3 + 1] = height;
      positions[i * 3 + 2] = (z / (resolution - 1)) * this.config.CHUNK_SIZE;

      normals[i * 3] = normMapped[i * 4];
      normals[i * 3 + 1] = normMapped[i * 4 + 1];
      normals[i * 3 + 2] = normMapped[i * 4 + 2];
    }

    posStaging.unmap();
    normStaging.unmap();

    this.releaseStagingBuffer(posSize, posStaging);
    this.releaseStagingBuffer(normSize, normStaging);

    return { positions, normals, minHeight, maxHeight };
  }

  private getStagingBuffer(size: number): GPUBuffer {
    if (!this.device) throw new Error('Device no disponible');

    if (!this.stagingBuffers.has(size)) {
      this.stagingBuffers.set(size, []);
    }

    const pool = this.stagingBuffers.get(size)!;
    if (pool.length > 0) {
      return pool.pop()!;
    }

    return this.device.createBuffer({
      size,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
  }

  private releaseStagingBuffer(size: number, buffer: GPUBuffer) {
    if (buffer.mapState !== 'unmapped') {
      try {
        buffer.unmap();
      } catch (e) {}
    }
    const pool = this.stagingBuffers.get(size);
    if (pool) pool.push(buffer);
  }

  private generateIndices(resolution: number): Uint16Array {
    const indices: number[] = [];
    for (let z = 0; z < resolution - 1; z++) {
      for (let x = 0; x < resolution - 1; x++) {
        const tl = z * resolution + x;
        const tr = tl + 1;
        const bl = (z + 1) * resolution + x;
        const br = bl + 1;
        indices.push(tl, bl, tr, tr, bl, br);
      }
    }
    return new Uint16Array(indices);
  }

  private calculateBoundsFromGeometry(data: ChunkGeometryData, coord: ChunkCoord): ChunkBounds {
    const originX = coord.x * this.config.CHUNK_SIZE;
    const originZ = coord.z * this.config.CHUNK_SIZE;

    const min = { x: originX, y: data.bounds.minHeight, z: originZ };
    const max = {
      x: originX + this.config.CHUNK_SIZE,
      y: data.bounds.maxHeight,
      z: originZ + this.config.CHUNK_SIZE,
    };
    const center = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 };
    const radius = Math.sqrt(
      Math.pow(max.x - center.x, 2) + Math.pow(max.y - center.y, 2) + Math.pow(max.z - center.z, 2),
    );

    return { min, max, center, radius };
  }

  private estimateBounds(coord: ChunkCoord): ChunkBounds {
    const originX = coord.x * this.config.CHUNK_SIZE;
    const originZ = coord.z * this.config.CHUNK_SIZE;

    const maxH = this.config.TERRAIN_HEIGHT_SCALE * 2.0 + this.config.TERRAIN_OFFSET_Y;
    const minH = this.config.TERRAIN_OFFSET_Y - this.config.TERRAIN_HEIGHT_SCALE * 1.5;

    const min = { x: originX, y: minH, z: originZ };
    const max = {
      x: originX + this.config.CHUNK_SIZE,
      y: maxH,
      z: originZ + this.config.CHUNK_SIZE,
    };
    const center = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 };

    // Radio conservador para culling por esfera
    const radius = Math.sqrt(
      3 * Math.pow(this.config.CHUNK_SIZE / 2, 2) + Math.pow(maxH - minH, 2) / 2,
    );

    return { min, max, center, radius };
  }

  releaseResources(resources: ChunkGPUResources) {
    const returnToPool = (buf: any) => {
      if (!buf?.array) return;
      const byteLength = (buf.array as Float32Array).byteLength;

      if (!this.bufferPool.has(byteLength)) {
        this.bufferPool.set(byteLength, []);
      }
      this.bufferPool.get(byteLength)!.push(buf as StorageBufferAttribute);
    };

    returnToPool(resources.positionBuffer);
    returnToPool(resources.normalBuffer);
  }

  dispose() {
    this.bufferPool.clear();
    this.indexBuffers.clear();
    this.stagingBuffers.forEach((pool) => pool.forEach((b) => b.destroy()));
    this.stagingBuffers.clear();
    this.device = null;
    this.queue = null;
    this.backend = null;
  }
}
