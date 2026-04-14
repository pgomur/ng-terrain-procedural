import { Component, ViewEncapsulation } from '@angular/core';
import { TerrainComponent } from '../app/terrain/terrain.component';

@Component({
  selector: 'app-root',
  standalone: true,
  encapsulation: ViewEncapsulation.None,
  imports: [TerrainComponent],
  template: `
    <main class="app-container">
      <app-terrain [showDiagnostics]="true" (engineReady)="onEngineReady($event)"> </app-terrain>
    </main>
  `,
  styles: [
    `
      html,
      body {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background-color: #000;
      }
      .ui-overlay {
        position: absolute;
        top: 20px;
        right: 20px;
        pointer-events: none;
        color: white;
        text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.5);
        font-family: sans-serif;
      }
      h1 {
        margin: 0;
        font-size: 1.2rem;
        opacity: 0.7;
      }
    `,
  ],
})
export class App {
  onEngineReady(success: boolean) {
    if (success) {
    }
  }
}
