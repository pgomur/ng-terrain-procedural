import * as THREE from 'three';
import { MeshStandardNodeMaterial, type Node, type StorageBufferAttribute } from 'three/webgpu';
import { cameraViewMatrix, float, fract, fwidth, mix, positionWorld, smoothstep, uniform, vec3, vec4 } from 'three/tsl';
import { createTerrainPositionNode } from './elevation.tsl';
import { TerrainConfig } from '../types/terrain';

const SKIRT_POLYGON_OFFSET_FACTOR = 2;
const SKIRT_POLYGON_OFFSET_UNITS = 4;

export interface TerrainMaterials {
  readonly surface: MeshStandardNodeMaterial;
  readonly skirt: MeshStandardNodeMaterial;
}

export function createTerrainColorNode(config: TerrainConfig): Node<'vec3'> {
  const uMinHeight = uniform(config.TERRAIN_OFFSET_Y);
  const uMaxHeight = uniform(config.TERRAIN_OFFSET_Y + config.TERRAIN_HEIGHT_SCALE);

  const height = positionWorld.y;
  const t = smoothstep(uMinHeight, uMaxHeight, height);

  const sand = vec3(0.8, 0.75, 0.6);
  const grass = vec3(0.35, 0.5, 0.25);
  const rock = vec3(0.5, 0.5, 0.5);
  const snow = vec3(0.95, 0.95, 1.0);

  let baseColor = mix(sand, grass, smoothstep(float(0.0), float(0.25), t));
  baseColor = mix(baseColor, rock, smoothstep(float(0.25), float(0.65), t));
  baseColor = mix(baseColor, snow, smoothstep(float(0.65), float(0.95), t));

  const gridSize = float(10.0);
  const gridPos = positionWorld.xz.div(gridSize);

  const grid = fract(gridPos.sub(0.5)).sub(0.5).abs().div(fwidth(gridPos));
  const line = grid.x.min(grid.y);

  const gridFactor = smoothstep(float(0.0), float(1.5), line).oneMinus();

  return mix(baseColor, baseColor.mul(0.75), gridFactor);
}

export function createTerrainMaterials(
  heights: StorageBufferAttribute,
  resolution: number,
  colorNode: Node<'vec3'>,
  skirtDepth: number,
): TerrainMaterials {
  const surface = new MeshStandardNodeMaterial({
    color: 0xffffff,
    roughness: 0.8,
    metalness: 0.1,
    flatShading: true,
    side: THREE.FrontSide,
  });
  surface.colorNode = vec4(colorNode, 1.0);
  surface.positionNode = createTerrainPositionNode(heights, resolution, skirtDepth);
  surface.castShadowPositionNode = createTerrainPositionNode(heights, resolution, 0);

  const skirt = new MeshStandardNodeMaterial({
    color: 0xffffff,
    roughness: 0.8,
    metalness: 0.1,
    side: THREE.FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: SKIRT_POLYGON_OFFSET_FACTOR,
    polygonOffsetUnits: SKIRT_POLYGON_OFFSET_UNITS,
  });
  skirt.colorNode = vec4(colorNode, 1.0);
  skirt.positionNode = surface.positionNode;
  skirt.castShadowPositionNode = surface.castShadowPositionNode;
  skirt.normalNode = cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz.normalize();

  return { surface, skirt };
}
