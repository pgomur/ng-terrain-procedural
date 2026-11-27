/**
 * The procedural sky, shared by the sky dome and the fog.
 *
 * There is no texture and no skybox: {@link skyColor} computes the colour of the sky for any view direction, and that one function is used twice, so the sky and the fog always agree:
 *
 * | Use | Built by | Parts |
 * | --- | --- | --- |
 * | Sky dome | {@link createSkyDome} | Gradient, sun glow and haze, sun disk, clouds. |
 * | Fog | The engine's scene fog | Gradient, sun glow and haze only. |
 *
 * Distant terrain fades into exactly the colour of the sky behind it, without the clouds or the sun disk, which would otherwise appear painted on the mountains. The sun direction is {@link engine/sun-light!SUN_DIRECTION | SUN_DIRECTION}, the same as the light's.
 *
 * See [Rendering](../../../guides/rendering.md#sky-and-fog).
 *
 * @module
 */
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

/**
 * Colour of the sky at the horizon, also used as the renderer's clear colour.
 *
 * A pale blue-grey. Using it as the clear colour means any pixel left uncovered, such as during start-up, already looks like sky.
 */
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

/**
 * Optional parts of {@link skyColor}.
 *
 * The sky dome uses `{ sunDisk: true, clouds: true }` and the fog `{ sunDisk: false, clouds: false }`.
 */
export interface SkyOptions {
  /**
   * Whether to draw the sun disk. The fog leaves it out.
   */
  readonly sunDisk: boolean;
  /**
   * Whether to draw the drifting clouds. The fog leaves them out, so distant terrain fades into a clear horizon.
   */
  readonly clouds: boolean;
}

/**
 * Builds the colour of the sky in a view direction: a gradient from the horizon to the zenith, a glow and haze around the sun and, optionally, the sun disk and clouds.
 *
 * The clouds are fractional Brownian motion projected onto a plane above the camera and drifting with time. Their edges are softened over a fixed width, or over the noise's screen-space derivative where that is wider, so they look soft up close and do not flicker near the horizon. They fade out towards the horizon.
 *
 * @param direction - Normalised view direction.
 * @param sun - Unit vector towards the sun.
 * @param options - Parts to include.
 * @returns The colour node.
 *
 * @example
 * The fog colour of the engine:
 * ```ts
 * const viewDirection = cameraWorldMatrix.mul(vec4(positionView, 0.0)).xyz.normalize();
 * const fogColor = skyColor(viewDirection, SUN_DIRECTION, { sunDisk: false, clouds: false });
 * ```
 */
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

/**
 * Builds the sky dome: a unit sphere seen from inside, centred on the camera and projected onto the far plane. It is drawn after the terrain with depth testing, so only the sky pixels that are actually visible are shaded.
 *
 * @param sun - Unit vector towards the sun.
 * @returns The mesh to add to the scene.
 *
 * Since its vertices are projected onto the far plane, the dome's size and position do not matter and it is never clipped, whatever the camera's far distance.
 */
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
