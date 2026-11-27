import { InjectionToken } from '@angular/core';
import { TerrainConfig, DEFAULT_TERRAIN_CONFIG } from '../types/terrain';

export const TERRAIN_CONFIG = new InjectionToken<TerrainConfig>('TERRAIN_CONFIG', {
  providedIn: 'root',
  factory: () => DEFAULT_TERRAIN_CONFIG,
});
