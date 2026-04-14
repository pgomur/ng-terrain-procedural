import { InjectionToken } from '@angular/core';
import { TerrainConfig, DEFAULT_TERRAIN_CONFIG } from '../types/terrain';

/**
 * Injection token para la configuración global del motor de terreno.
 * Proporciona DEFAULT_TERRAIN_CONFIG por defecto en la raíz.
 * Permite que otros módulos puedan inyectar o sobrescribir la configuración.
 */
export const TERRAIN_CONFIG = new InjectionToken<TerrainConfig>('TERRAIN_CONFIG', {
  providedIn: 'root',
  factory: () => DEFAULT_TERRAIN_CONFIG
});
