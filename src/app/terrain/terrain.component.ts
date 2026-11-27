/**
 * The `<app-terrain>` component: everything needed to show the terrain on a page, in one element.
 *
 * {@link TerrainComponent} is the glue between Angular and the engine. It provides its own {@link engine/terrain-engine!TerrainEngine | TerrainEngine}, gives it the canvas, connects the {@link terrain/fly-camera!FlyCameraController | FlyCameraController} as the engine's frame callback, and shows over the canvas whatever the engine's state calls for:
 *
 * | Engine state | Shown |
 * | --- | --- |
 * | `initializing`, and `ready` while loading | The loading screen: *Connecting to the GPU*, *Compiling shaders*, then *Generating terrain* with a progress bar. |
 * | `ready` | The terrain, the diagnostics panel, the controls bar with a link to this documentation, and a crosshair while flying. |
 * | `failed` | *WebGPU could not start*, with the browsers that support it. |
 * | `lost` | *The GPU stopped responding*, asking to reload. |
 *
 * Its configuration is {@link terrain/terrain.config!TERRAIN_CONFIG | TERRAIN_CONFIG} merged with the `configOverrides` input, read once at start-up.
 *
 * See [Embedding the terrain](../../../guides/embedding.md).
 *
 * @module
 */
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { TerrainEngine } from '../engine/terrain-engine';
import { TerrainConfig } from '../types/terrain';
import { LoaderComponent } from '../ui/loader.component';
import { FlyCameraController } from './fly-camera';
import { HudComponent } from './hud.component';
import { TERRAIN_CONFIG } from './terrain.config';

const LOADING_STATUS = {
  device: 'Connecting to the GPU',
  shaders: 'Compiling shaders',
  terrain: 'Generating terrain',
  done: 'Generating terrain',
} as const;

/**
 * Hosts the terrain: a full-size canvas with its own {@link engine/terrain-engine!TerrainEngine | TerrainEngine}, the loading and error screens, the diagnostics panel, the controls bar and the crosshair.
 *
 * The engine starts after the view is created and is disposed with the component. If the GPU device is lost, the pointer is released and a message asks the user to reload.
 *
 * Created by Angular from its template.
 *
 * @example
 * ```html
 * <app-terrain [configOverrides]="{ NOISE_SEED: 42 }" (engineReady)="onReady($event)" />
 * ```
 *
 * @hideconstructor
 */
@Component({
  selector: 'app-terrain',
  templateUrl: './terrain.component.html',
  styleUrl: './terrain.component.scss',
  imports: [HudComponent, LoaderComponent],
  providers: [TerrainEngine],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TerrainComponent implements AfterViewInit, OnDestroy {
  /**
   * Options that replace those of the {@link terrain/terrain.config!TERRAIN_CONFIG | TERRAIN_CONFIG} configuration for this instance. Read once, when the engine starts.
   */
  readonly configOverrides = input<Partial<TerrainConfig>>();
  /**
   * Whether to show the diagnostics panel.
   *
   * The statistics keep being collected when the panel is hidden, so {@link engine/terrain-engine!TerrainEngine.stats | engine.stats} stays available.
   */
  readonly showDiagnostics = input(true);
  /**
   * Emits once after start-up: `true` when the engine is running, `false` when it could not start.
   */
  readonly engineReady = output<boolean>();

  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('terrainCanvas');

  /**
   * The engine of this instance.
   *
   * Use it to read the engine's signals from a parent, for example through a template reference: `terrain.engine.stats()`.
   */
  public readonly engine = inject(TerrainEngine);
  private readonly globalConfig = inject(TERRAIN_CONFIG);
  private readonly flyCamera = new FlyCameraController(this.engine);

  /**
   * Whether the pointer is captured for flying.
   */
  public readonly isPointerLocked = this.flyCamera.pointerLocked.asReadonly();
  protected readonly loadingStatus = computed(() => LOADING_STATUS[this.engine.loadingStage()]);
  protected readonly loadingProgress = computed(() => {
    const stage = this.engine.loadingStage();
    return stage === 'device' || stage === 'shaders' ? null : this.engine.loadingProgress();
  });

  private destroyed = false;

  constructor() {
    effect(() => {
      if (this.engine.initState() === 'lost') this.flyCamera.release();
    });
  }

  /**
   * Starts the engine on the canvas.
   *
   * The configuration is merged and the engine initialised asynchronously. If the component is destroyed before that finishes, the controls are never started and the engine is disposed.
   */
  ngAfterViewInit(): void {
    void this.startEngine(this.canvasRef().nativeElement);
  }

  private async startEngine(canvas: HTMLCanvasElement): Promise<void> {
    const finalConfig: TerrainConfig = {
      ...this.globalConfig,
      ...this.configOverrides(),
    };

    const success = await this.engine.init(canvas, finalConfig);

    if (this.destroyed) return;

    if (success) {
      this.flyCamera.start();
      this.flyCamera.attach(canvas);
      this.engine.setFrameCallback((delta) => this.flyCamera.update(delta));
      this.engine.start();

      this.engineReady.emit(true);
    } else {
      console.error('TerrainComponent: Failed to start WebGPU engine');
      this.engineReady.emit(false);
    }
  }

  /**
   * Stops the controls and disposes the engine.
   *
   * After this, the canvas, its GPU resources and every listener are released; a new instance starts from scratch.
   */
  ngOnDestroy(): void {
    this.destroyed = true;
    this.engine.setFrameCallback(null);
    this.flyCamera.detach();
    this.engine.dispose();
  }
}
