import { StorageBufferAttribute } from 'three/webgpu';
import { DEFAULT_TERRAIN_CONFIG } from '../types/terrain';
import { createTerrainColorNode, createTerrainMaterials } from './terrain-material.tsl';

describe('createTerrainMaterials', () => {
  const heights = new StorageBufferAttribute(new Float32Array(17 * 17), 1);
  const colorNode = createTerrainColorNode(DEFAULT_TERRAIN_CONFIG);

  it('shades the surface flat and offsets the skirts behind it', () => {
    const { surface, skirt } = createTerrainMaterials(heights, 17, colorNode, 2);
    expect(surface.flatShading).toBe(true);
    expect(surface.polygonOffset).toBe(false);
    expect(skirt.flatShading).toBe(false);
    expect(skirt.polygonOffset).toBe(true);
    expect(skirt.polygonOffsetFactor).toBeGreaterThan(0);
    expect(skirt.polygonOffsetUnits).toBeGreaterThan(0);
  });

  it('shares the displacement between surface and skirt, and casts shadows without skirts', () => {
    const { surface, skirt } = createTerrainMaterials(heights, 17, colorNode, 2);
    expect(skirt.positionNode).toBe(surface.positionNode);
    expect(skirt.castShadowPositionNode).toBe(surface.castShadowPositionNode);
    expect(surface.castShadowPositionNode).not.toBe(surface.positionNode);
    expect(skirt.normalNode).not.toBeNull();
  });
});
