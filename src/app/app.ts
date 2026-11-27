import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TerrainComponent } from './terrain/terrain.component';
import { LoaderComponent } from './ui/loader.component';

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
