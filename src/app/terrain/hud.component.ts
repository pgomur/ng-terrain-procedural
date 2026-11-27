import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { TerrainEngineStats } from '../types/engine';

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

@Component({
  selector: 'app-hud',
  templateUrl: './hud.component.html',
  styleUrl: './hud.component.scss',
  imports: [DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HudComponent {
  readonly stats = input.required<TerrainEngineStats>();

  protected cardinal(headingDeg: number): string {
    return CARDINALS[Math.round(headingDeg / 45) % CARDINALS.length];
  }
}
