/**
 * The look of the terrain: its colours, its faceted shading and the skirts that close the seams.
 *
 * Each atlas page gets two `MeshStandardNodeMaterial` instances from {@link createTerrainMaterials}, both lit by the sun with roughness 0.8 and metalness 0.1, and both displaced by the same vertex node from {@link shaders/elevation.tsl!createTerrainPositionNode | createTerrainPositionNode}:
 *
 * | Material | Draws | Notes |
 * | --- | --- | --- |
 * | `surface` | The chunk's grid | Flat-shaded: each triangle is one facet, with its normal from screen-space derivatives. Casts and receives shadows. |
 * | `skirt` | The four skirts | Lit with an upward normal, so a visible skirt has the colour and light of the ground above it. Pushed behind the surface with a polygon offset. Never casts shadows. |
 *
 * Both share one colour node from {@link createTerrainColorNode}, created once for the whole terrain:
 *
 * | Share of the height range | Colour |
 * | --- | --- |
 * | 0 – 25 % | Sand fading into grass |
 * | 25 – 65 % | Grass fading into rock |
 * | 65 – 95 % | Rock fading into snow |
 *
 * plus a grid every 10 world units that darkens its lines by 25 %, to judge scale and speed.
 *
 * See [Rendering](../../../guides/rendering.md#materials).
 *
 * @module
 */
import * as THREE from 'three';
import { MeshStandardNodeMaterial, type Node, type StorageBufferAttribute } from 'three/webgpu';
import { cameraViewMatrix, float, fract, fwidth, mix, positionWorld, smoothstep, uniform, vec3, vec4 } from 'three/tsl';
import { createTerrainPositionNode } from './elevation.tsl';
import { TerrainConfig } from '../types/terrain';

const SKIRT_POLYGON_OFFSET_FACTOR = 2;
const SKIRT_POLYGON_OFFSET_UNITS = 4;

/**
 * The two materials of an atlas page's terrain mesh.
 *
 * Used as the material array of a page's main mesh, one entry per geometry group: the surface group first, then the skirts. The shadow mesh uses `surface` alone.
 */
export interface TerrainMaterials {
  /**
   * Material of the chunk surface, flat-shaded so every triangle shows as a facet.
   */
  readonly surface: MeshStandardNodeMaterial;
  /**
   * Material of the skirts. It shares the surface's displacement, is lit as if facing up so it blends with the ground, and is pushed slightly behind the surface with a polygon offset so it never covers it.
   */
  readonly skirt: MeshStandardNodeMaterial;
}

/**
 * Builds the terrain colour: sand, grass, rock and snow blended by height between `TERRAIN_OFFSET_Y` and `TERRAIN_OFFSET_Y + TERRAIN_HEIGHT_SCALE`, with a faint world-space grid every 10 units. The grid lines are anti-aliased with screen-space derivatives.
 *
 * @param config - Terrain configuration.
 * @returns The colour node, shared by every terrain material.
 *
 * The colour depends only on the world position, so neighbouring chunks at different levels of detail match, and it needs no texture.
 */
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

/**
 * Builds the surface and skirt materials of one atlas page. Shadows are cast without the skirts.
 *
 * @param heights - Height atlas page the vertex shader reads.
 * @param resolution - Vertices per side of the page's chunks.
 * @param colorNode - Colour node from {@link createTerrainColorNode}.
 * @param skirtDepth - Depth of the skirts in world units.
 * @returns The two materials.
 *
 * The materials are created once per page and disposed with the {@link engine/scene-graph!SceneGraph | SceneGraph}.
 */
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
