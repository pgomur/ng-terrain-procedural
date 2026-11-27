---
title: Embedding the terrain
group: Guides
---

# Embedding the terrain

The whole terrain is one standalone component, `<app-terrain>`. It fills its container, creates its own engine and cleans everything up when it is destroyed.

## The component

```html
<div style="width: 100%; height: 100vh">
  <app-terrain [configOverrides]="{ NOISE_SEED: 42 }" [showDiagnostics]="false" (engineReady)="onEngineReady($event)" />
</div>
```

| Member            | Kind     | Description                                                                                                                                                                  |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `configOverrides` | Input    | Options that replace those of {@link terrain/terrain.config!TERRAIN_CONFIG | TERRAIN_CONFIG} for this instance. Read once, at start. See [Configuration](configuration.md). |
| `showDiagnostics` | Input    | Shows the [diagnostics panel](diagnostics.md). `true` by default.                                                                                                            |
| `engineReady`     | Output   | Emits `true` when the engine has started, or `false` if WebGPU could not be initialised.                                                                                     |
| `engine`          | Property | The component's {@link engine/terrain-engine!TerrainEngine | TerrainEngine}, for reading its signals.                                                                       |
| `isPointerLocked` | Property | Signal: whether the flight controls hold the pointer.                                                                                                                        |

The component provides its own {@link engine/terrain-engine!TerrainEngine | TerrainEngine}, so several instances on one page are independent, each with its own canvas, GPU resources and camera.

### Lazy loading

Three.js and the engine are large. The application shell loads the component with `@defer`, so the first paint only needs Angular and the loading screen:

```html
@defer (on immediate) {
<app-terrain />
} @placeholder {
<app-loader status="Loading engine" />
} @error {
<app-loader
  errorTitle="The terrain engine could not be loaded"
  errorMessage="Check your connection and reload the page."
/>
}
```

## Screens

The component shows {@link ui/loader.component!LoaderComponent | LoaderComponent} over the canvas while it cannot show terrain:

| Situation              | What the user sees                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| Starting               | _Connecting to the GPU_, then _Compiling shaders_, then _Generating terrain_ with a progress bar. |
| WebGPU unavailable     | _WebGPU could not start_, with the browsers that support it.                                      |
| GPU lost while running | _The GPU stopped responding_, asking to reload the page.                                          |

## Reading the engine

{@link engine/terrain-engine!TerrainEngine | TerrainEngine} exposes its state as read-only Angular signals, usable in templates, `computed` and `effect`:

| Signal            | Type                                                                    | Meaning                                                                      |
| ----------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `initState`       | {@link types/engine!EngineInitState | EngineInitState}                 | `uninitialized`, `initializing`, `ready`, `failed` or `lost`.                |
| `isReady`         | `boolean`                                                               | `initState() === 'ready'`.                                                   |
| `loadingStage`    | {@link types/engine!LoadingStage | LoadingStage}                       | `device`, `shaders`, `terrain`, then `done` when the first view is complete. |
| `loadingProgress` | `number`                                                                | Share of the first view that is ready, from 0 to 1.                          |
| `stats`           | {@link types/engine!TerrainEngineStats | TerrainEngineStats} or `null` | Diagnostics, four times per second.                                          |

```ts
@Component({
  selector: 'app-viewer',
  imports: [TerrainComponent, DecimalPipe],
  template: `
    <app-terrain #terrain [showDiagnostics]="false" />
    @if (terrain.engine.stats(); as stats) {
      <p class="badge">{{ stats.fps | number: '1.0-0' }} fps · {{ stats.visibleChunks }} chunks</p>
    }
  `,
})
export class ViewerComponent {}
```

## Controls

{@link terrain/fly-camera!FlyCameraController | FlyCameraController} turns the keyboard and mouse into free flight. A click on the canvas captures the pointer; <kbd>Esc</kbd> releases it, and then all keys are ignored.

| Input                                           | Action                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Mouse                                           | Look around. The pitch stops just short of straight up and down.                            |
| <kbd>W</kbd> / <kbd>S</kbd>                     | Forward and back, in the direction of view, so looking up and pressing <kbd>W</kbd> climbs. |
| <kbd>A</kbd> / <kbd>D</kbd>                     | Left and right, horizontally.                                                               |
| <kbd>E</kbd> or <kbd>Space</kbd> / <kbd>Q</kbd> | Straight up / straight down.                                                                |
| Left <kbd>Shift</kbd>                           | Three times faster: 90 units per second instead of 30.                                      |

The camera starts at `(0, 100, 500)` and can never go lower than 5 units above the terrain, once the heights under it are known.

### Your own camera

The engine does not depend on these controls. Anything with access to the engine can drive the camera from the frame callback, which runs once per frame before streaming, with the elapsed time in seconds (at most 0.1):

```ts
const engine = inject(TerrainEngine);
let t = 0;

engine.setFrameCallback((delta) => {
  t += delta;
  const x = Math.cos(t * 0.1) * 800;
  const z = Math.sin(t * 0.1) * 800;
  const ground = engine.getTerrainHeightAt(x, z) ?? 0;
  engine.setCameraPosition(x, ground + 60, z);
  engine.lookAt(0, 0, 0);
});
```

Only one callback is active at a time, and `<app-terrain>` installs its flight controls as that callback. A custom camera therefore belongs in a component that creates and runs the engine itself, as `<app-terrain>` does; see the source of {@link terrain/terrain.component!TerrainComponent | TerrainComponent} for the start-up and teardown order.

## Requirements

- A browser with WebGPU: current desktop Chrome, Edge, Safari or Firefox, with hardware acceleration enabled. Three.js's WebGL 2 fallback cannot run the engine, because the vertex shader reads storage buffers.
- The component must have a size: it fills its parent, so give the parent a height.
