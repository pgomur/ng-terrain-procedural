/**
 * The sun and its shadows.
 *
 * The sun is fixed: about 61° above the horizon, shining from the east-south-east (from heading 117°). {@link SUN_DIRECTION} is shared by the light, the sky and the fog, so the bright spot in the sky, the glow in the fog and the shadows agree.
 *
 * {@link SunLight} solves the two problems of shadows over a large, moving world:
 *
 * - **Coverage.** A single shadow map cannot cover kilometres with useful detail, so it only covers a square of `2 × LOD_DISTANCES[0]` (1,200 units by default, about 0.59 units per texel) around the camera, and follows it.
 * - **Stability.** A shadow camera that moves continuously makes shadow edges shimmer. {@link SunLight.follow} moves it in whole texels of the shadow map, measured in the plane facing the sun.
 *
 * It also tells the {@link engine/scene-graph!SceneGraph | SceneGraph} how far around the camera chunks can cast a shadow into that square, with {@link SunLight.shadowRegionRadius}.
 *
 * See [Rendering](../../../guides/rendering.md#shadows).
 *
 * @module
 */
import * as THREE from 'three';
import { TerrainConfig } from '../types/terrain';

/**
 * Unit vector pointing from the ground towards the sun. Shared by the light, the sky and the fog.
 *
 * `(100, 200, 50)` normalised: elevation `asin(0.873)` ≈ 60.8°.
 */
export const SUN_DIRECTION = new THREE.Vector3(100, 200, 50).normalize();

const SHADOW_MAP_SIZE = 2048;
const SUN_ELEVATION = Math.asin(SUN_DIRECTION.y);

/**
 * The sun: a shadow-casting directional light and a weak ambient light.
 *
 * The shadow camera covers a square of `2 × LOD_DISTANCES[0]` around the camera and follows it. Its position is snapped to whole shadow-map texels in light space, so shadows do not shimmer as the camera moves.
 */
export class SunLight {
  /**
   * The directional light. Its shadow camera also renders the shadow-caster layer.
   */
  readonly light: THREE.DirectionalLight;
  /**
   * Ambient light that lifts the shadowed sides.
   */
  readonly ambient: THREE.AmbientLight;
  /**
   * Size of one shadow-map texel in world units. Also used as the normal bias against shadow acne.
   */
  readonly texelSize: number;
  /**
   * First axis of the plane perpendicular to the sun, used to snap the shadow camera.
   */
  readonly axisX = new THREE.Vector3();
  /**
   * Second axis of the plane perpendicular to the sun.
   */
  readonly axisY = new THREE.Vector3();

  private readonly distance: number;
  private readonly footprintRadius: number;
  private readonly target = new THREE.Vector3();

  /**
   * Creates both lights and configures the shadow camera: a 2048 × 2048 map, an orthographic frustum of `±LOD_DISTANCES[0]`, and a depth range that encloses the whole terrain height.
   *
   * @param config - Terrain configuration; sets the shadow coverage and the height range to enclose.
   * @param shadowCasterLayer - Layer of the meshes that only cast shadows.
   */
  constructor(config: TerrainConfig, shadowCasterLayer: number) {
    const shadowRadius = config.LOD_DISTANCES[0];
    const heightExtent = Math.abs(config.TERRAIN_HEIGHT_SCALE) * 2 + Math.abs(config.TERRAIN_OFFSET_Y);

    this.distance = shadowRadius + heightExtent;
    this.texelSize = (shadowRadius * 2) / SHADOW_MAP_SIZE;
    this.footprintRadius = shadowRadius / Math.sin(SUN_ELEVATION) + heightExtent / Math.tan(SUN_ELEVATION);

    this.axisX.crossVectors(new THREE.Vector3(0, 1, 0), SUN_DIRECTION).normalize();
    this.axisY.crossVectors(SUN_DIRECTION, this.axisX).normalize();

    this.ambient = new THREE.AmbientLight(0x404040, 0.5);

    const light = new THREE.DirectionalLight(0xffffff, 1);
    light.castShadow = true;
    light.shadow.mapSize.width = SHADOW_MAP_SIZE;
    light.shadow.mapSize.height = SHADOW_MAP_SIZE;
    light.shadow.camera.near = 0.5;
    light.shadow.camera.far = this.distance * 2;
    light.shadow.camera.left = -shadowRadius;
    light.shadow.camera.right = shadowRadius;
    light.shadow.camera.top = shadowRadius;
    light.shadow.camera.bottom = -shadowRadius;
    light.shadow.normalBias = this.texelSize;
    light.shadow.camera.layers.enable(shadowCasterLayer);
    light.shadow.camera.updateProjectionMatrix();
    this.light = light;
  }

  /**
   * Adds both lights and the light's target to a scene.
   *
   * @param scene - Scene to add them to.
   */
  addTo(scene: THREE.Scene): void {
    scene.add(this.ambient);
    scene.add(this.light);
    scene.add(this.light.target);
  }

  /**
   * Centres the shadow camera on a position, snapped to the shadow-map texel grid.
   *
   * @param position - Camera position in world units.
   *
   * The engine calls it every frame with the camera position, before the shadow map is rendered.
   */
  follow(position: THREE.Vector3): void {
    const texel = this.texelSize;
    const u = Math.round(position.dot(this.axisX) / texel) * texel;
    const v = Math.round(position.dot(this.axisY) / texel) * texel;
    const w = position.dot(SUN_DIRECTION);

    this.target.copy(this.axisX).multiplyScalar(u).addScaledVector(this.axisY, v).addScaledVector(SUN_DIRECTION, w);

    this.light.target.position.copy(this.target);
    this.light.position.copy(this.target).addScaledVector(SUN_DIRECTION, this.distance);
  }

  /**
   * Radius of the ground area whose chunks can cast a shadow into the shadow camera's view. It grows with the camera height: the shadow camera is centred on the camera itself, so a higher camera has to include terrain farther away along the sun direction.
   *
   * @param cameraHeight - Camera height in world units.
   * @returns The radius in world units.
   *
   * About 800 units for a camera on the ground with the default configuration.
   */
  shadowRegionRadius(cameraHeight: number): number {
    return this.footprintRadius + Math.abs(cameraHeight) / Math.tan(SUN_ELEVATION);
  }
}
