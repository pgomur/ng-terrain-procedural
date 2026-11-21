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
        <div class="app-status">Loading terrain engine...</div>
      } @error {
        <div class="app-status app-status--error">The terrain engine could not be loaded.</div>
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
      width: 100%;
      height: 100%;
    }
    .app-status {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100%;
      background: rgba(15, 23, 42, 0.9);
      color: #e2e8f0;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 14px;
    }
    .app-status--error {
      color: #fca5a5;
    }
  `,
})
export class App {}
