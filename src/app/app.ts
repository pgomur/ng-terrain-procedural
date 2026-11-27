/**
 * Root component of the application.
 *
 * {@link App} only renders `<app-terrain>`, inside a `@defer (on immediate)` block. Three.js and the engine are therefore in a separate bundle: the first paint needs only Angular and the loading screen, and the engine is downloaded right after.
 *
 * | Block | Shows |
 * | --- | --- |
 * | `@placeholder` | The loading screen with *Loading engine*. |
 * | Main | The terrain, which then shows its own loading screen until the terrain is ready. |
 * | `@error` | *The terrain engine could not be loaded*, when the download fails. |
 *
 * See [Embedding the terrain](../../guides/embedding.md#lazy-loading).
 *
 * @module
 */
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TerrainComponent } from './terrain/terrain.component';
import { LoaderComponent } from './ui/loader.component';

/**
 * Root component. Loads the terrain lazily, showing the loading screen meanwhile and an error screen if the engine cannot be downloaded.
 *
 * Bootstrapped by `main.ts`; it has no inputs or outputs.
 *
 * @hideconstructor
 */
@Component({
  selector: 'app-root',
  imports: [TerrainComponent, LoaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="app-container">
      @defer (on immediate) {
        <app-terrain [showDiagnostics]="true" />
      } @placeholder {
        <app-loader status="Loading engine" />
      } @error {
        <app-loader
          errorTitle="The terrain engine could not be loaded"
          errorMessage="Check your connection and reload the page."
        />
      }
    </main>
  `,
  styles: `
    :host {
      display: block;
      width: 100%;
      height: 100%;
    }
    .app-container {
      position: relative;
      width: 100%;
      height: 100%;
    }
  `,
})
export class App {}
