import {
  Component,
  ElementRef,
  ViewChild,
  OnDestroy,
  OnInit,
  AfterViewInit,
  inject,
  NgZone,
  Input,
  Output,
  EventEmitter
} from '@angular/core';
import { CommonModule } from '@angular/common';
import * as THREE from 'three';
import { TerrainEngine } from '../engine/terrain-engine';
import { TerrainConfig } from '../types/terrain';
import { TERRAIN_CONFIG } from './terrain.config';

@Component({
  selector: 'app-terrain',
  standalone: true,
  imports: [CommonModule],
  providers: [TerrainEngine], // Proveemos una instancia propia del motor atada al ciclo de vida del componente
  template: `
    <div class="terrain-viewport">
      <!-- Canvas donde WebGPU renderizará la escena -->
      <canvas #terrainCanvas></canvas>
      
      <!-- Panel de Diagnóstico HUD (Heads-Up Display) conectado a las Signals del Engine -->
      <div class="engine-diagnostics" *ngIf="showDiagnostics && engine.state().isReady">
        <div class="diagnostic-panel">
          <h3>Motor de Terreno WebGPU</h3>
          <div class="metric-row">
            <span class="label">FPS</span>
            <span class="value" [class.warning]="engine.state().fps < 30">
              {{ engine.state().fps | number:'1.0-0' }}
            </span>
          </div>
          <div class="metric-row">
            <span class="label">Chunks Visibles</span>
            <span class="value">{{ engine.chunkState()?.stats?.visibleCount || 0 }}</span>
          </div>
          <div class="metric-row">
            <span class="label">Total en Memoria</span>
            <span class="value">{{ engine.chunkState()?.stats?.readyCount || 0 }}</span>
          </div>
          <div class="metric-row">
            <span class="label">Generando GPU</span>
            <span class="value">{{ engine.chunkState()?.stats?.generatingCount || 0 }}</span>
          </div>
          <div class="metric-row">
            <span class="label">Cola Pendiente</span>
            <span class="value">{{ engine.chunkState()?.stats?.pendingCount || 0 }}</span>
          </div>
          
          <div class="metric-row vram-metric" *ngIf="engine.chunkState()?.stats?.totalVRAM !== undefined">
            <span class="label">VRAM Estimada</span>
            <span class="value">
              {{ (engine.chunkState()!.stats.totalVRAM / 1048576) | number:'1.1-2' }} MB
            </span>
          </div>

          <div class="metric-row coord-metric">
            <span class="label">Coordenadas (X, Y, Z)</span>
            <span class="value coord-value">
              {{ currentX | number:'1.0-0' }} : {{ currentY | number:'1.0-0' }} : {{ currentZ | number:'1.0-0' }}
            </span>
          </div>
          <div class="metric-row">
            <span class="label">Velocidad</span>
            <span class="value">{{ currentSpeed | number:'1.0-0' }} u/s</span>
          </div>
        </div>
        
        <div class="controls-hint">
          Click sobre el terreno para navegar<br/>(WASD + Shift + Mouse para mirar)
        </div>
      </div>

      <!-- Spinner y Overlay de Inicialización asíncrona -->
      <div class="loading-overlay" *ngIf="engine.state().initState === 'initializing'">
        <div class="spinner"></div>
        <p>Inicializando pipeline WebGPU...</p>
      </div>

      <!-- Captura de errores (Ej. Tarjeta no soporta WebGPU v1+ computación) -->
      <div class="error-overlay" *ngIf="engine.state().initState === 'failed'">
        <div class="error-message">
          <h3>Error Crítico de Hardware</h3>
          <p>No se pudo inicializar WebGPU. Verifica que tu navegador o backend de GPU lo soporten correctamente.</p>
        </div>
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      width: 100%;
      height: 100%;
    }
    .terrain-viewport {
      width: 100%;
      height: 100%;
      position: relative;
      overflow: hidden;
      background: #87CEEB; /* Mismo color del cielo/fog configurado en engine */
    }
    canvas {
      display: block;
      width: 100%;
      height: 100%;
      touch-action: none; /* Previene scroll molesto en touch o trackpad */
      outline: none;
    }
    .engine-diagnostics {
      position: absolute;
      top: 16px;
      left: 16px;
      pointer-events: none;
      z-index: 10;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .diagnostic-panel {
      background: rgba(15, 23, 42, 0.85);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      padding: 16px;
      color: #e2e8f0;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 13px;
      min-width: 260px;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.5);
    }
    .diagnostic-panel h3 {
      margin: 0 0 12px 0;
      font-size: 12px;
      font-weight: 700;
      color: #f8fafc;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      padding-bottom: 8px;
    }
    .metric-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 6px;
    }
    .metric-row:last-child {
      margin-bottom: 0;
    }
    .metric-row .label {
      color: #94a3b8;
    }
    .metric-row .value {
      font-weight: 600;
      color: #10b981; /* Verde éxito */
    }
    .metric-row .value.warning {
      color: #ef4444; /* Rojo error de rendimiento */
    }
    .vram-metric {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px dashed rgba(255, 255, 255, 0.1);
    }
    .vram-metric .value {
      color: #3b82f6; /* Azul distintivo para memoria */
    }
    .coord-metric {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px dashed rgba(255, 255, 255, 0.1);
    }
    .coord-value {
      color: #fbbf24; /* Ámbar para telemetría espacial */
      font-feature-settings: "tnum";
      font-variant-numeric: tabular-nums;
    }
    .controls-hint {
      background: rgba(0, 0, 0, 0.5);
      border-radius: 6px;
      padding: 8px 12px;
      color: #cbd5e1;
      font-size: 11px;
      text-align: center;
      line-height: 1.4;
    }
    .loading-overlay, .error-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: rgba(15, 23, 42, 0.9);
      color: white;
      z-index: 20;
    }
    .spinner {
      border: 4px solid rgba(255,255,255,0.1);
      border-left-color: #3b82f6;
      border-radius: 50%;
      width: 40px;
      height: 40px;
      animation: spin 1s linear infinite;
      margin-bottom: 16px;
    }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    .error-message {
      background: rgba(239, 68, 68, 0.2);
      border: 1px solid #ef4444;
      padding: 24px;
      border-radius: 8px;
      text-align: center;
      max-width: 400px;
    }
    .error-message h3 { margin-top: 0; color: #fca5a5; }
  `]
})
export class TerrainComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('terrainCanvas', { static: true })
  private readonly canvasRef!: ElementRef<HTMLCanvasElement>;

  /** 
   * Permite sobreescribir partes de la configuración del terreno global
   * específicamente para esta vista. 
   */
  @Input() configOverrides?: Partial<TerrainConfig>;

  /** Si true, renderiza el panel de HUD encima del canvas WebGPU */
  @Input() showDiagnostics = true;

  @Output() engineReady = new EventEmitter<boolean>();

  public readonly engine = inject(TerrainEngine);
  private readonly globalConfig = inject(TERRAIN_CONFIG);
  private readonly ngZone = inject(NgZone);

  // --- VARIABLES PARA CÁMARA FLY ---
  private isPointerLocked = false;
  private cameraPitch = 0; // Rotación sobre eje X local
  private cameraYaw = 0;   // Rotación sobre eje Y global
  private cameraPosition = new THREE.Vector3(0, 300, 500);
  private movementSpeed = 150.0;
  
  // Variables expuestas al interpolador de UI
  public currentX = 0;
  public currentY = 300;
  public currentZ = 500;
  public currentSpeed = 0;
  
  private activeKeys = new Set<string>();
  private lastTime = 0;
  private animationFrameId?: number;

  // Colección de manejadores para limpiar memoria al destruir componente
  private cleanupFunctions: (() => void)[] = [];

  ngOnInit(): void {
    // Hooks iniciales si se requieren en un futuro
  }

  async ngAfterViewInit(): Promise<void> {
    const canvas = this.canvasRef.nativeElement;

    // Fusión inmutable de la configuración inyectada global y overrides locales
    const finalConfig: TerrainConfig = {
      ...this.globalConfig,
      ...this.configOverrides
    };

    // La inicialización requiere requestAdapter() dentro de engine
    const success = await this.engine.init(canvas, finalConfig);
    
    if (success) {
      // Configuraciones iniciales de cámara mirando al Origen de coordenadas
      this.engine.setCameraPosition(this.cameraPosition.x, this.cameraPosition.y, this.cameraPosition.z);
      this.engine.lookAt(0, 0, 0);

      // Desacoplamos el Render/Game loop pesado del ChangeDetection nativo de Angular,
      // para evitar reevaluar directivas constantemente provocados por input (teclado/ratón)
      this.ngZone.runOutsideAngular(() => {
        this.engine.start();
        this.setupFlyCameraControls(canvas);
        
        // Arrancamos el GameLoop lógico acoplado de Update
        this.lastTime = performance.now();
        const runUpdateLoop = (time: number) => {
          const delta = (time - this.lastTime) / 1000;
          this.lastTime = time;
          this.updateCameraLogic(delta);
          this.animationFrameId = requestAnimationFrame(runUpdateLoop);
        };
        this.animationFrameId = requestAnimationFrame(runUpdateLoop);
      });
      
      this.engineReady.emit(true);
    } else {
      console.error('TerrainComponent: Falla al iniciar engine WebGPU.');
      this.engineReady.emit(false);
    }
  }

  ngOnDestroy(): void {
    if (this.animationFrameId !== undefined) {
      cancelAnimationFrame(this.animationFrameId);
    }
    
    // Quitar todos los event listeners para prevenir memory leaks
    this.cleanupFunctions.forEach(cleanupFn => cleanupFn());
    this.cleanupFunctions = [];
    
    // Desconstruir estructuras pesadas webgpu buffers
    this.engine.dispose();
  }

  /**
   * Cámara First Person flotante y dinámica gestionada enteramente a mano.
   */
  private setupFlyCameraControls(canvas: HTMLCanvasElement): void {
    
    const onKeydown = (e: KeyboardEvent) => this.activeKeys.add(e.code);
    const onKeyup = (e: KeyboardEvent) => this.activeKeys.delete(e.code);

    const onMousemove = (e: MouseEvent) => {
      if (!this.isPointerLocked) return;
      
      const sensitivity = 0.002; // Sensibilidad del ratón controlada y fija
      this.cameraYaw -= e.movementX * sensitivity;
      this.cameraPitch -= e.movementY * sensitivity;

      // Restricción vertical extrema (-89 deg a 89 deg) para evitar Gimbal Lock en el View
      const pitchLimit = Math.PI / 2 - 0.01;
      this.cameraPitch = Math.max(-pitchLimit, Math.min(pitchLimit, this.cameraPitch));
    };

    const onClick = async () => {
      if (!this.isPointerLocked) {
        try {
          if (canvas.requestPointerLock) {
            await canvas.requestPointerLock();
          }
        } catch (e) {
          console.warn('No se pudo establecer el pointer lock:', e);
        }
      }
    };

    const onPointerLockChange = () => {
      this.isPointerLocked = document.pointerLockElement === canvas;
      if (!this.isPointerLocked) {
        // Al soltar el candado de raton, detenemos movimiento inercial
        this.activeKeys.clear();
      }
    };

    // Asignar listeners
    canvas.addEventListener('click', onClick);
    document.addEventListener('pointerlockchange', onPointerLockChange);
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('keyup', onKeyup);
    document.addEventListener('mousemove', onMousemove);

    // Registro de funciones de liberación
    this.cleanupFunctions.push(() => canvas.removeEventListener('click', onClick));
    this.cleanupFunctions.push(() => document.removeEventListener('pointerlockchange', onPointerLockChange));
    this.cleanupFunctions.push(() => document.removeEventListener('keydown', onKeydown));
    this.cleanupFunctions.push(() => document.removeEventListener('keyup', onKeyup));
    this.cleanupFunctions.push(() => document.removeEventListener('mousemove', onMousemove));
  }

  /**
   * Lógica computacional delta del movimiento posicional y el Update
   * sincronizado con THREE.js Engine
   */
  private updateCameraLogic(delta: number): void {
    if (!this.isPointerLocked) return;

    // Vector velocidad; Corremos X3 si oprimimos Shift Izquierdo
    const moveDistance = this.movementSpeed * delta * (this.activeKeys.has('ShiftLeft') ? 3.0 : 1.0);

    // Cálculo matricial de Vectores locales Forward y Right
    const forward = new THREE.Vector3(
      Math.sin(this.cameraYaw) * Math.cos(this.cameraPitch),
      Math.sin(this.cameraPitch),
      Math.cos(this.cameraYaw) * Math.cos(this.cameraPitch)
    ).negate().normalize();

    const right = new THREE.Vector3(
      Math.cos(this.cameraYaw),
      0,
      -Math.sin(this.cameraYaw)
    ).normalize();

    // Actualización Euler traslacional en la cámara
    if (this.activeKeys.has('KeyW')) this.cameraPosition.addScaledVector(forward, moveDistance);
    if (this.activeKeys.has('KeyS')) this.cameraPosition.addScaledVector(forward, -moveDistance);
    if (this.activeKeys.has('KeyD')) this.cameraPosition.addScaledVector(right, moveDistance);
    if (this.activeKeys.has('KeyA')) this.cameraPosition.addScaledVector(right, -moveDistance);
    
    // Movimiento vertical puro sobre Espacio de Mundo (Eje Y)
    if (this.activeKeys.has('Space')) this.cameraPosition.y += moveDistance;
    if (this.activeKeys.has('ControlLeft')) this.cameraPosition.y -= moveDistance;

    // --- COLLISION GROUNDING ---
    // Consultamos la altura real del terreno generado por WebGPU en (X, Z) mapeado en CPU por el interpolador
    const terrainHeight = this.engine.getTerrainHeightAt(this.cameraPosition.x, this.cameraPosition.z);
    
    if (terrainHeight !== null) {
      const eyeHeight = 5.0; // Altura del "jugador"
      const groundY = terrainHeight + eyeHeight;
      
      // Si la cámara intenta atravesar el suelo o el terreno sube abruptamente, la empujamos hacia arriba
      if (this.cameraPosition.y < groundY) {
        // En un juego real aquí reiniciaríamos la velocidad Y (gravedad), 
        // pero para Vuelo Libre forzamos posición estricta sin traspasar.
        this.cameraPosition.y = groundY;
      }
    }

    // Pasamos estado unificado al TerrainEngine Bridge
    this.engine.setCameraPosition(this.cameraPosition.x, this.cameraPosition.y, this.cameraPosition.z);
    
    // Forzamos lookAt computando Target futuro
    const target = this.cameraPosition.clone().add(forward);
    this.engine.lookAt(target.x, target.y, target.z);

    // Actualizamos variables de la UI (Telemetría exacta)
    this.currentX = this.cameraPosition.x;
    this.currentY = this.cameraPosition.y;
    this.currentZ = this.cameraPosition.z;
    this.currentSpeed = this.activeKeys.size > 0 ? (moveDistance / delta) : 0;
  }
}
