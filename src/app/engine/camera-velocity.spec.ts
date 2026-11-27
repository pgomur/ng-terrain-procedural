import { CameraVelocityTracker } from './camera-velocity';

describe('CameraVelocityTracker', () => {
  it('starts at rest, converges to the real velocity and forgets the old position on reset', () => {
    const tracker = new CameraVelocityTracker(0.5);
    tracker.update(0, 0, 1000);
    expect(tracker.speed).toBe(0);

    for (let i = 1; i <= 60; i++) tracker.update(10 * i, -5 * i, 1000 + 100 * i);
    expect(tracker.vx).toBeCloseTo(100, 9);
    expect(tracker.vz).toBeCloseTo(-50, 9);
    expect(tracker.speed).toBeCloseTo(Math.hypot(100, 50), 9);

    tracker.reset();
    tracker.update(90_000, 90_000, 20_000);
    tracker.update(90_000, 90_000, 20_100);
    expect(tracker.speed).toBe(0);
  });
});
