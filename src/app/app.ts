import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TerrainComponent } from './terrain/terrain.component';

@Component({
  selector: 'app-root',
  imports: [TerrainComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="app-container">
      @defer (on immediate) {
        <app-terrain [showDiagnostics]="true" />
      } @placeholder {
        <div class="loader" role="status">
          <div class="loader-content">
            <h1 class="loader-title">Procedural Terrain</h1>
            <div class="loader-bar is-indeterminate"><div class="loader-bar-fill"></div></div>
            <p class="loader-status">Loading engine</p>
          </div>
        </div>
      } @error {
        <div class="loader" role="alert">
          <div class="loader-content">
            <h1 class="loader-title">Procedural Terrain</h1>
            <p class="loader-error-title">The terrain engine could not be loaded</p>
            <p class="loader-error">Check your connection and reload the page.</p>
          </div>
        </div>
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
