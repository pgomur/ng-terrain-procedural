/**
 * The injection token for the application-wide configuration.
 *
 * {@link TERRAIN_CONFIG} is provided in the root injector with {@link types/terrain!DEFAULT_TERRAIN_CONFIG | DEFAULT_TERRAIN_CONFIG}, so nothing has to be provided to use the defaults. Each {@link terrain/terrain.component!TerrainComponent | TerrainComponent} injects it and applies its own `configOverrides` on top:
 *
 * ```text
 * DEFAULT_TERRAIN_CONFIG ──► TERRAIN_CONFIG (application) ──► configOverrides (instance) ──► engine
 * ```
 *
 * See [Configuration](../../../guides/configuration.md).
 *
 * @module
 */
import { InjectionToken } from '@angular/core';
import { TerrainConfig, DEFAULT_TERRAIN_CONFIG } from '../types/terrain';

/**
 * Injection token for the application-wide terrain configuration. Defaults to {@link types/terrain!DEFAULT_TERRAIN_CONFIG | DEFAULT_TERRAIN_CONFIG}.
 *
 * @example
 * ```ts
 * bootstrapApplication(App, {
 *   providers: [{ provide: TERRAIN_CONFIG, useValue: { ...DEFAULT_TERRAIN_CONFIG, NOISE_SEED: 42 } }],
 * });
 * ```
 *
 * Provide a complete {@link types/terrain!TerrainConfig | TerrainConfig}: the token is not merged with the defaults, which is why the example spreads them.
 */
export const TERRAIN_CONFIG = new InjectionToken<TerrainConfig>('TERRAIN_CONFIG', {
  providedIn: 'root',
  factory: () => DEFAULT_TERRAIN_CONFIG,
});
