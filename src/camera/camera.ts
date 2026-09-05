import type { Rect } from '../terrain/rect.js';

/**
 * The camera (SPEC §6.5): pan, pinch zoom, follow the active monkey, follow the
 * shot, shake on impact — and **frame both the shooter and the arc when you
 * fire**, which is the reason to have a camera module rather than a fixed view.
 *
 * Nothing here feeds the simulation, so none of it affects determinism.
 */

export interface CameraTune {
  /** Approach rate for position. Higher is snappier; seconds⁻¹. */
  followLag: number;
  zoomLag: number;
  minZoom: number;
  maxZoom: number;
  /** Zoom used when following a single monkey. */
  followZoom: number;
  /** World-pixel margin left around a framed rect. */
  framePadding: number;
  shakeDecay: number;
  /** How long after a manual pan before the camera takes over again. */
  freeReturnSeconds: number;
  /** How far ahead of a projectile to look, in seconds of its velocity. */
  projectileLeadSeconds: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export class Camera {
  /** Centre of the view, in world coordinates. */
  x = 0;
  y = 0;
  zoom = 1;

  private targetX = 0;
  private targetY = 0;
  private targetZoom = 1;
  private shakeAmount = 0;
  private shakeX = 0;
  private shakeY = 0;
  private freeFor = 0;
  private seed = 1;

  constructor(
    private readonly mapWidth: number,
    private readonly mapHeight: number,
  ) {}

  /** True while a manual pan or pinch is holding off the automatic follow. */
  get isFree(): boolean {
    return this.freeFor > 0;
  }

  /** Snaps straight to a target, for the start of a match or a map reload. */
  reset(x: number, y: number, zoom: number): void {
    this.x = this.targetX = x;
    this.y = this.targetY = y;
    this.zoom = this.targetZoom = zoom;
    this.shakeAmount = 0;
    this.freeFor = 0;
  }

  /** Points the camera at one thing, at the follow zoom. */
  follow(x: number, y: number, tune: CameraTune): void {
    if (this.isFree) return;
    this.targetX = x;
    this.targetY = y;
    this.targetZoom = clamp(tune.followZoom, tune.minZoom, tune.maxZoom);
  }

  /**
   * Fits a world rect in the viewport — the shooter and the whole arc together
   * on firing, so you can read where the shot is going before it gets there.
   */
  frame(rect: Rect, viewport: Viewport, tune: CameraTune): void {
    if (this.isFree) return;
    const width = Math.max(1, rect.width) + tune.framePadding * 2;
    const height = Math.max(1, rect.height) + tune.framePadding * 2;
    const zoom = Math.min(viewport.width / width, viewport.height / height);
    this.targetX = rect.x + rect.width / 2;
    this.targetY = rect.y + rect.height / 2;
    this.targetZoom = clamp(zoom, tune.minZoom, tune.maxZoom);
  }

  /** Manual pan, in screen pixels. Holds off the automatic follow for a while. */
  panBy(screenDx: number, screenDy: number, tune: CameraTune): void {
    this.targetX -= screenDx / this.zoom;
    this.targetY -= screenDy / this.zoom;
    this.x -= screenDx / this.zoom;
    this.y -= screenDy / this.zoom;
    this.freeFor = tune.freeReturnSeconds;
  }

  /** Pinch or wheel zoom about a screen point, keeping that point still. */
  zoomAt(screenX: number, screenY: number, factor: number, viewport: Viewport, tune: CameraTune): void {
    const before = this.screenToWorld(screenX, screenY, viewport);
    this.targetZoom = clamp(this.targetZoom * factor, tune.minZoom, tune.maxZoom);
    this.zoom = clamp(this.zoom * factor, tune.minZoom, tune.maxZoom);
    const after = this.screenToWorld(screenX, screenY, viewport);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this.targetX += before.x - after.x;
    this.targetY += before.y - after.y;
    this.freeFor = tune.freeReturnSeconds;
  }

  /** Kick from an explosion, strongest nearby (the caller does the falloff). */
  addShake(amount: number): void {
    this.shakeAmount = Math.max(this.shakeAmount, amount);
  }

  update(dt: number, viewport: Viewport, tune: CameraTune): void {
    if (this.freeFor > 0) this.freeFor = Math.max(0, this.freeFor - dt);

    // Exponential approach, so the smoothing is the same at any frame rate.
    const move = 1 - Math.exp(-tune.followLag * dt);
    const scale = 1 - Math.exp(-tune.zoomLag * dt);
    this.x += (this.targetX - this.x) * move;
    this.y += (this.targetY - this.y) * move;
    this.zoom += (this.targetZoom - this.zoom) * scale;

    if (this.shakeAmount > 0.05) {
      this.shakeAmount *= Math.exp(-tune.shakeDecay * dt);
      this.shakeX = (this.random() - 0.5) * 2 * this.shakeAmount;
      this.shakeY = (this.random() - 0.5) * 2 * this.shakeAmount;
    } else {
      this.shakeAmount = 0;
      this.shakeX = 0;
      this.shakeY = 0;
    }

    this.clampToMap(viewport);
  }

  /**
   * Keeps the view over the map. When the map is smaller than the viewport on
   * an axis it centres on that axis instead, so a short map does not stick to
   * one edge.
   */
  private clampToMap(viewport: Viewport): void {
    const halfWidth = viewport.width / (2 * this.zoom);
    const halfHeight = viewport.height / (2 * this.zoom);
    this.x = halfWidth * 2 >= this.mapWidth
      ? this.mapWidth / 2
      : clamp(this.x, halfWidth, this.mapWidth - halfWidth);
    this.y = halfHeight * 2 >= this.mapHeight
      ? this.mapHeight / 2
      : clamp(this.y, halfHeight, this.mapHeight - halfHeight);
  }

  /** Container position for a world drawn at the origin. */
  containerTransform(viewport: Viewport): { x: number; y: number; scale: number } {
    return {
      x: viewport.width / 2 - (this.x + this.shakeX) * this.zoom,
      y: viewport.height / 2 - (this.y + this.shakeY) * this.zoom,
      scale: this.zoom,
    };
  }

  screenToWorld(screenX: number, screenY: number, viewport: Viewport): { x: number; y: number } {
    return {
      x: (screenX - viewport.width / 2) / this.zoom + this.x,
      y: (screenY - viewport.height / 2) / this.zoom + this.y,
    };
  }

  /** True when a world point is inside the visible area. */
  contains(x: number, y: number, viewport: Viewport): boolean {
    const halfWidth = viewport.width / (2 * this.zoom);
    const halfHeight = viewport.height / (2 * this.zoom);
    return (
      x >= this.x - halfWidth && x <= this.x + halfWidth &&
      y >= this.y - halfHeight && y <= this.y + halfHeight
    );
  }

  /** Shake wants jitter, not simulation, so it has its own throwaway generator. */
  private random(): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Bounding box of a set of world points, for framing a shot. */
export function boundsOf(points: ReadonlyArray<{ x: number; y: number }>): Rect {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = points[0].x;
  let maxX = points[0].x;
  let minY = points[0].y;
  let maxY = points[0].y;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
