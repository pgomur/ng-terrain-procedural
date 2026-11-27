import {
  cameraProjectionMatrix,
  color,
  dot,
  float,
  fwidth,
  max,
  mix,
  modelViewMatrix,
  mx_fractal_noise_float,
  positionLocal,
  pow,
  smoothstep,
  step,
  time,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { BackSide, Mesh, SphereGeometry, type Vector3 } from 'three';
import { NodeMaterial, type Node } from 'three/webgpu';

export const SKY_HORIZON_COLOR = 0xd4e4ef;

const SKY_ZENITH_COLOR = 0x2c69b3;
const SKY_MID_COLOR = 0x7cb0df;
const SKY_GROUND_COLOR = 0xbfcfda;
const SUN_GLOW_COLOR = 0xffdfae;
const SUN_DISK_COLOR = 0xfff6e4;
const CLOUD_LIT_COLOR = 0xffffff;
const CLOUD_SHADE_COLOR = 0xa9b8c8;

const SUN_DISK_INNER = 0.99965;
const SUN_DISK_OUTER = 0.9993;
const CLOUD_SCALE = 1.4;
const CLOUD_EDGE = 0.14;
const CLOUD_EDGE_SOFTNESS = 0.12;
const CLOUD_WIND = vec2(0.006, 0.0025);

export interface SkyOptions {
  readonly sunDisk: boolean;
  readonly clouds: boolean;
}

export function skyColor(direction: Node<'vec3'>, sun: Vector3, options: SkyOptions): Node<'vec3'> {
  const y = direction.y;
  const up = max(y, 0.0);

  const above = mix(color(SKY_HORIZON_COLOR), color(SKY_MID_COLOR), smoothstep(0.0, 0.3, up));
  const gradient = mix(above, color(SKY_ZENITH_COLOR), smoothstep(0.25, 0.95, up));
  const below = mix(color(SKY_HORIZON_COLOR), color(SKY_GROUND_COLOR), smoothstep(0.0, 0.3, y.negate()));
  const base = mix(below, gradient, step(0.0, y));

  const sunAmount = max(dot(direction, vec3(sun.x, sun.y, sun.z)), 0.0);
  const glow = pow(sunAmount, 8.0).mul(0.22).add(pow(sunAmount, 96.0).mul(0.55));
  const haze = pow(sunAmount, 2.0)
    .mul(pow(float(1.0).sub(up), 6.0))
    .mul(0.18);
  let result = base.add(color(SUN_GLOW_COLOR).mul(glow.add(haze)));

  if (options.sunDisk) {
    const disk = smoothstep(SUN_DISK_OUTER, SUN_DISK_INNER, sunAmount);
    result = mix(result, color(SUN_DISK_COLOR).mul(1.6), disk);
  }

  if (options.clouds) {
    const plane = direction.xz.div(max(y, 0.04)).mul(CLOUD_SCALE).add(CLOUD_WIND.mul(time));
    const position = vec3(plane, time.mul(0.01));
    const broad = mx_fractal_noise_float(position, 3, 2.0, 0.5);
    const fine = mx_fractal_noise_float(position.mul(8.0), 3, 2.0, 0.5).mul(0.08);
    const density = broad.add(fine.mul(smoothstep(0.05, 0.3, up)));
    const edge = max(fwidth(density), CLOUD_EDGE_SOFTNESS);
    const silhouette = smoothstep(edge.negate().add(CLOUD_EDGE), edge.add(CLOUD_EDGE), density);
    const coverage = silhouette
      .mul(mix(0.62, 0.92, smoothstep(CLOUD_EDGE, 0.55, density)))
      .mul(smoothstep(0.03, 0.3, up));
    const shading = mix(color(CLOUD_SHADE_COLOR), color(CLOUD_LIT_COLOR), smoothstep(-0.1, 0.6, density));
    const cloud = shading.add(color(SUN_GLOW_COLOR).mul(glow.mul(0.6)));
    result = mix(result, cloud, coverage);
  }

  return result;
}

const SKY_RENDER_ORDER = Number.MAX_SAFE_INTEGER;

export function createSkyDome(sun: Vector3): Mesh {
  const material = new NodeMaterial();
  material.name = 'SkyDome';
  material.side = BackSide;
  material.depthTest = true;
  material.depthWrite = false;
  material.fog = false;
  material.lights = false;

  const viewPosition = modelViewMatrix.mul(vec4(positionLocal, 0.0));
  const clipPosition = cameraProjectionMatrix.mul(vec4(viewPosition.xyz, 1.0));
  material.vertexNode = clipPosition.setZ(clipPosition.w);
  material.colorNode = vec4(skyColor(positionLocal.normalize(), sun, { sunDisk: true, clouds: true }), 1.0);

  const dome = new Mesh(new SphereGeometry(1, 32, 32), material);
  dome.name = 'SkyDome';
  dome.frustumCulled = false;
  dome.renderOrder = SKY_RENDER_ORDER;
  return dome;
}
