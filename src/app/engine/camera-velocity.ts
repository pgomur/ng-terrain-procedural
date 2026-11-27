/**
 * Smoothed camera velocity, used to generate first the chunks the camera is heading towards.
 *
 * The raw velocity between two frames is noisy: frame times vary and the input is applied in steps. {@link CameraVelocityTracker} smooths it with an exponential moving average, so the priorities of the generation queue follow the real direction of travel instead of jittering. Only the horizontal velocity is tracked, because levels of detail ignore height.
 *
 * See [Streaming and levels of detail](../../../guides/streaming.md#priority).
 *
 * @module
 */
/**
 * Horizontal camera velocity smoothed with an exponential moving average, used to look ahead when prioritising chunks.
 *
 * Each new sample `v` updates the average as `average = alpha × v + (1 − alpha) × average`. With the `alpha` of `0.15` used by the {@link engine/chunk-manager!ChunkManager | ChunkManager}, a change of velocity is half absorbed after about 4 samples, roughly 70 ms at 60 fps.
 *
 * @example
 * ```ts
 * const tracker = new CameraVelocityTracker(0.15);
 * tracker.update(0, 0, 0);
 * tracker.update(0.5, 0, 16);
 * tracker.update(1.0, 0, 32);
 * ```
 * After these samples `tracker.vx` is about 8.7 and rising towards the real 31.25 units per second.
 */
export class CameraVelocityTracker {
  private prevX = Infinity;
  private prevZ = Infinity;
  private prevT = 0;

  /**
   * Smoothed velocity along X, in world units per second.
   */
  vx = 0;
  /**
   * Smoothed velocity along Z, in world units per second.
   */
  vz = 0;
  /**
   * Magnitude of the smoothed horizontal velocity.
   *
   * `sqrt(vx² + vz²)`.
   */
  speed = 0;

  private readonly alpha: number;

  /**
   * Creates a tracker at rest.
   *
   * @param alpha - Weight of each new sample, between `0` and `1`. Higher values react faster and smooth less.
   */
  constructor(alpha = 0.15) {
    this.alpha = alpha;
  }

  /**
   * Adds a position sample. The first sample after construction or {@link CameraVelocityTracker.reset} only records the position.
   *
   * @param x - Camera position along X.
   * @param z - Camera position along Z.
   * @param nowMs - Sample time in milliseconds.
   */
  update(x: number, z: number, nowMs: number): void {
    if (this.prevT === 0) {
      this.prevX = x;
      this.prevZ = z;
      this.prevT = nowMs;
      return;
    }

    const dtSec = Math.max((nowMs - this.prevT) / 1000, 1e-6);
    const rawVx = (x - this.prevX) / dtSec;
    const rawVz = (z - this.prevZ) / dtSec;

    this.vx = this.alpha * rawVx + (1 - this.alpha) * this.vx;
    this.vz = this.alpha * rawVz + (1 - this.alpha) * this.vz;
    this.speed = Math.sqrt(this.vx * this.vx + this.vz * this.vz);

    this.prevX = x;
    this.prevZ = z;
    this.prevT = nowMs;
  }

  /**
   * Forgets the previous position and sets the velocity to zero, so the next sample does not produce a jump.
   */
  reset(): void {
    this.prevX = Infinity;
    this.prevZ = Infinity;
    this.prevT = 0;
    this.vx = 0;
    this.vz = 0;
    this.speed = 0;
  }
}
