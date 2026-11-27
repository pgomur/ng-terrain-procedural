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

@Component({
  selector: 'app-terrain',
  templateUrl: './terrain.component.html',
  styleUrl: './terrain.component.scss',
  imports: [HudComponent, LoaderComponent],
  providers: [TerrainEngine],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TerrainComponent implements AfterViewInit, OnDestroy {
  readonly configOverrides = input<Partial<TerrainConfig>>();
  readonly showDiagnostics = input(true);
  readonly engineReady = output<boolean>();

  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('terrainCanvas');

  public readonly engine = inject(TerrainEngine);
  private readonly globalConfig = inject(TERRAIN_CONFIG);
  private readonly flyCamera = new FlyCameraController(this.engine);

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

  ngOnDestroy(): void {
    this.destroyed = true;
    this.engine.setFrameCallback(null);
    this.flyCamera.detach();
    this.engine.dispose();
  }
}
