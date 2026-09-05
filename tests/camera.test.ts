import { describe, expect, it } from 'vitest';
import { boundsOf, Camera, type CameraTune, type Viewport } from '../src/camera/camera.js';
import { parseCameraTune } from '../src/tune/camera.js';

const VIEW: Viewport = { width: 800, height: 600 };
const MAP = { width: 2000, height: 1200 };

function tune(overrides: Partial<CameraTune> = {}): CameraTune {
  return parseCameraTune({
    followLag: 5.5,
    zoomLag: 3.5,
    minZoom: 0.3,
    maxZoom: 3,
    followZoom: 1,
    framePadding: 110,
    shakeDecay: 7,
    freeReturnSeconds: 2.5,
    projectileLeadSeconds: 0.22,
    ...overrides,
  });
}

function settle(camera: Camera, t: CameraTune, seconds = 3, dt = 1 / 60): void {
  for (let i = 0; i < seconds / dt; i++) camera.update(dt, VIEW, t);
}

describe('framing', () => {
  it('fits the shooter and the whole arc in view', () => {
    // The reason the camera module exists at all (SPEC §6.5).
    const t = tune();
    const camera = new Camera(MAP.width, MAP.height);
    camera.reset(1000, 600, 1);
    const shot = [
      { x: 300, y: 700 }, { x: 500, y: 500 }, { x: 700, y: 420 },
      { x: 900, y: 500 }, { x: 1050, y: 760 },
    ];
    camera.frame(boundsOf(shot), VIEW, t);
    settle(camera, t);

    for (const point of shot) {
      expect(camera.contains(point.x, point.y, VIEW), `${point.x},${point.y} off screen`).toBe(true);
    }
  });

  it('does not zoom past the limits to fit something enormous', () => {
    const t = tune({ minZoom: 0.5 });
    const camera = new Camera(MAP.width, MAP.height);
    camera.reset(1000, 600, 1);
    camera.frame({ x: 0, y: 0, width: 100000, height: 100000 }, VIEW, t);
    settle(camera, t);
    expect(camera.zoom).toBeGreaterThanOrEqual(t.minZoom - 1e-6);
  });

  it('measures the bounds of a set of points', () => {
    expect(boundsOf([{ x: 10, y: 40 }, { x: 30, y: 20 }, { x: 5, y: 25 }]))
      .toEqual({ x: 5, y: 20, width: 25, height: 20 });
    expect(boundsOf([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('following', () => {
  it('converges on what it is following', () => {
    const t = tune();
    const camera = new Camera(MAP.width, MAP.height);
    camera.reset(400, 400, 1);
    camera.follow(1200, 700, t);
    settle(camera, t, 4);
    expect(camera.x).toBeCloseTo(1200, 0);
    expect(camera.y).toBeCloseTo(700, 0);
  });

  it('smooths the same way at any frame rate', () => {
    const t = tune();
    const slow = new Camera(MAP.width, MAP.height);
    const fast = new Camera(MAP.width, MAP.height);
    slow.reset(400, 400, 1);
    fast.reset(400, 400, 1);
    slow.follow(1200, 700, t);
    fast.follow(1200, 700, t);
    for (let i = 0; i < 30; i++) slow.update(1 / 30, VIEW, t);
    for (let i = 0; i < 120; i++) fast.update(1 / 120, VIEW, t);
    expect(slow.x).toBeCloseTo(fast.x, 0);
  });
});

describe('bounds', () => {
  it('keeps the view over the map', () => {
    const t = tune();
    const camera = new Camera(MAP.width, MAP.height);
    camera.reset(1000, 600, 1);
    camera.follow(-5000, -5000, t);
    settle(camera, t, 5);
    expect(camera.x).toBeGreaterThanOrEqual(VIEW.width / 2 - 1);
    expect(camera.y).toBeGreaterThanOrEqual(VIEW.height / 2 - 1);

    camera.follow(50_000, 50_000, t);
    settle(camera, t, 5);
    expect(camera.x).toBeLessThanOrEqual(MAP.width - VIEW.width / 2 + 1);
    expect(camera.y).toBeLessThanOrEqual(MAP.height - VIEW.height / 2 + 1);
  });

  it('centres an axis where the map is narrower than the view', () => {
    const t = tune({ minZoom: 0.1 });
    const camera = new Camera(400, 300);
    camera.reset(200, 150, 1);
    camera.follow(-900, -900, t);
    settle(camera, t, 4);
    expect(camera.x).toBeCloseTo(200, 0);
    expect(camera.y).toBeCloseTo(150, 0);
  });
});

describe('manual control', () => {
  it('holds off the automatic follow after a pan, then gives it back', () => {
    const t = tune({ freeReturnSeconds: 0.5 });
    const camera = new Camera(MAP.width, MAP.height);
    camera.reset(1000, 600, 1);
    camera.panBy(-100, 0, t);
    expect(camera.isFree).toBe(true);

    // While free, following is ignored.
    camera.follow(200, 200, t);
    settle(camera, t, 0.2);
    expect(camera.x).toBeGreaterThan(900);

    settle(camera, t, 1);
    expect(camera.isFree).toBe(false);
    camera.follow(1500, 800, t);
    settle(camera, t, 3);
    expect(camera.x).toBeCloseTo(1500, 0);
  });

  it('keeps the pinched point still while zooming', () => {
    const t = tune();
    const camera = new Camera(MAP.width, MAP.height);
    camera.reset(1000, 600, 1);
    const before = camera.screenToWorld(200, 150, VIEW);
    camera.zoomAt(200, 150, 1.8, VIEW, t);
    const after = camera.screenToWorld(200, 150, VIEW);
    expect(after.x).toBeCloseTo(before.x, 4);
    expect(after.y).toBeCloseTo(before.y, 4);
  });

  it('respects the zoom limits', () => {
    const t = tune();
    const camera = new Camera(MAP.width, MAP.height);
    camera.reset(1000, 600, 1);
    for (let i = 0; i < 40; i++) camera.zoomAt(400, 300, 1.5, VIEW, t);
    expect(camera.zoom).toBeLessThanOrEqual(t.maxZoom + 1e-6);
    for (let i = 0; i < 80; i++) camera.zoomAt(400, 300, 1 / 1.5, VIEW, t);
    expect(camera.zoom).toBeGreaterThanOrEqual(t.minZoom - 1e-6);
  });
});

describe('shake', () => {
  it('decays back to nothing and leaves the view where it was', () => {
    const t = tune();
    const camera = new Camera(MAP.width, MAP.height);
    camera.reset(1000, 600, 1);
    camera.follow(1000, 600, t);
    camera.addShake(30);
    const shaken = camera.containerTransform(VIEW);
    camera.update(1 / 60, VIEW, t);
    const during = camera.containerTransform(VIEW);
    expect(during.x).not.toBe(shaken.x);
    settle(camera, t, 3);
    const after = camera.containerTransform(VIEW);
    expect(after.x).toBeCloseTo(VIEW.width / 2 - 1000, 1);
  });
});
