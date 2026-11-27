/**
 * The full-screen loading and error screen, shared by the application shell and the terrain.
 *
 * {@link LoaderComponent} has two modes, chosen by its inputs:
 *
 * | Mode | When | Shows |
 * | --- | --- | --- |
 * | Loading | `errorTitle` is `null` | The title, a progress bar (indeterminate while `progress` is `null`) and the status line with a percentage. Announced politely to screen readers (`role="status"`). |
 * | Error | `errorTitle` is set | The error title and message instead of the progress. Announced immediately (`role="alert"`). |
 *
 * Setting `done` fades the screen out in 0.6 s and then hides it, without removing it, so the terrain underneath can be used. With reduced motion, it disappears without the fade.
 *
 * It is used three times: by the application shell while the engine code downloads, by {@link terrain/terrain.component!TerrainComponent | TerrainComponent} while the engine starts, and by both for errors.
 *
 * @module
 */
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { DecimalPipe } from '@angular/common';

/**
 * Full-screen loading and error screen. Shows a status line and a progress bar, or an error title and message when `errorTitle` is set.
 *
 * Created by Angular from its template.
 *
 * @hideconstructor
 */
@Component({
  selector: 'app-loader',
  templateUrl: './loader.component.html',
  styleUrl: './loader.component.scss',
  imports: [DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoaderComponent {
  /**
   * Text describing the current loading step.
   */
  readonly status = input('');
  /**
   * Progress from 0 to 1, shown as a bar and a percentage, or `null` for an indeterminate bar.
   *
   * Values are shown as given; the terrain passes `null` during the `device` and `shaders` stages, whose length cannot be known.
   */
  readonly progress = input<number | null>(null);
  /**
   * Fades the screen out when `true`.
   */
  readonly done = input(false);
  /**
   * When set, the screen shows this error instead of the progress, announced as an alert.
   */
  readonly errorTitle = input<string | null>(null);
  /**
   * Explanation shown below the error title.
   */
  readonly errorMessage = input('');
}
