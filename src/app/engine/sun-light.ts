import * as THREE from 'three';
import { TerrainConfig } from '../types/terrain';

export const SUN_DIRECTION = new THREE.Vector3(100, 200, 50).normalize();

const SHADOW_MAP_SIZE = 2048;
const SUN_ELEVATION = Math.asin(SUN_DIRECTION.y);

export class SunLight {
  readonly light: THREE.DirectionalLight;
  readonly ambient: THREE.AmbientLight;
  readonly texelSize: number;
  readonly axisX = new THREE.Vector3();
  readonly axisY = new THREE.Vector3();

  private readonly distance: number;
  private readonly footprintRadius: number;
  private readonly target = new THREE.Vector3();

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

  addTo(scene: THREE.Scene): void {
    scene.add(this.ambient);
    scene.add(this.light);
    scene.add(this.light.target);
  }

  follow(position: THREE.Vector3): void {
    const texel = this.texelSize;
    const u = Math.round(position.dot(this.axisX) / texel) * texel;
    const v = Math.round(position.dot(this.axisY) / texel) * texel;
    const w = position.dot(SUN_DIRECTION);

    this.target.copy(this.axisX).multiplyScalar(u).addScaledVector(this.axisY, v).addScaledVector(SUN_DIRECTION, w);

    this.light.target.position.copy(this.target);
    this.light.position.copy(this.target).addScaledVector(SUN_DIRECTION, this.distance);
  }

  shadowRegionRadius(cameraHeight: number): number {
    return this.footprintRadius + Math.abs(cameraHeight) / Math.tan(SUN_ELEVATION);
  }
}
