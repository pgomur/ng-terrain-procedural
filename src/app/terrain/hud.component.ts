/**
 * The diagnostics panel shown over the terrain.
 *
 * {@link HudComponent} is a presentational component: it receives a {@link types/engine!TerrainEngineStats | TerrainEngineStats} snapshot and formats it, four times per second, into five sections: the frame rate header, *Render*, *Terrain*, *Terrain buffers* and *Camera*. It reads nothing else and has no state, so it costs nothing between snapshots.
 *
 * It is shown by {@link terrain/terrain.component!TerrainComponent | TerrainComponent} once the engine is ready, unless `showDiagnostics` is `false`.
 *
 * See [Diagnostics panel](../../../guides/diagnostics.md) for what each value measures and how to read it.
 *
 * @module
 */
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { TerrainEngineStats } from '../types/engine';

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/**
 * Diagnostics panel: frame timing, rendering, streaming, GPU memory and camera, from the engine's statistics.
 *
 * Created by Angular from its template; it has no constructor parameters.
 *
 * @hideconstructor
 */
@Component({
  selector: 'app-hud',
  templateUrl: './hud.component.html',
  styleUrl: './hud.component.scss',
  imports: [DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HudComponent {
  /**
   * Statistics to display.
   *
   * Usually {@link engine/terrain-engine!TerrainEngine.stats | TerrainEngine.stats}, once it is not `null`.
   */
  readonly stats = input.required<TerrainEngineStats>();

  protected cardinal(headingDeg: number): string {
    return CARDINALS[Math.round(headingDeg / 45) % CARDINALS.length];
  }
}
