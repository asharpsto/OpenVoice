import { EMPTY, type MaterialId } from './materials.js';
import { BROADPHASE_CELL_SIZE, type Mask } from './mask.js';

/** Where a ray first met solid terrain. */
export interface RayHit {
  /** Sub-pixel position of the sample that hit. */
  x: number;
  y: number;
  /** Pixel the sample landed in. */
  pixelX: number;
  pixelY: number;
  material: MaterialId;
  /** Parameter along the segment, 0 at the start, 1 at the end. */
  t: number;
  /** Distance travelled from the start, in pixels. */
  distance: number;
}

export interface RaycastOptions {
  /** Sub-pixel march interval. From `tune/terrain.json` (query.raycastStepPx). */
  stepPx: number;
  /**
   * Skip provably-empty broadphase cells. Purely an optimisation: results are
   * identical either way, which `tests/query.test.ts` asserts by fuzzing.
   */
  useBroadphase?: boolean;
}

/** O(1) point test (SPEC §5.5). Outside the map is empty. */
export function materialAt(mask: Mask, x: number, y: number): MaterialId {
  return mask.at(Math.floor(x), Math.floor(y));
}

export function isSolidAt(mask: Mask, x: number, y: number): boolean {
  return materialAt(mask, x, y) !== EMPTY;
}

/**
 * Marches a segment at sub-pixel intervals and returns the first solid sample.
 *
 * Projectiles must never be integrated in large steps — a fast banana would
 * tunnel straight through a fence (SPEC §5.5). The caller integrates its
 * ballistic arc as it likes, then hands each frame's segment to this.
 */
export function raycast(
  mask: Mask,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  options: RaycastOptions,
): RayHit | null {
  const stepPx = options.stepPx;
  if (!(stepPx > 0)) throw new Error(`raycast stepPx must be positive, got ${stepPx}`);
  const useBroadphase = options.useBroadphase ?? true;

  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(length / stepPx));
  const invSteps = 1 / steps;

  for (let i = 0; i <= steps; i++) {
    const t = i * invSteps;
    const x = x0 + dx * t;
    const y = y0 + dy * t;
    const px = Math.floor(x);
    const py = Math.floor(y);
    const material = mask.at(px, py);
    if (material !== EMPTY) {
      return { x, y, pixelX: px, pixelY: py, material, t, distance: length * t };
    }
    if (useBroadphase && i < steps && px >= 0 && py >= 0 && px < mask.width && py < mask.height) {
      const cx = (px / BROADPHASE_CELL_SIZE) | 0;
      const cy = (py / BROADPHASE_CELL_SIZE) | 0;
      if (!mask.cellOccupied(cx, cy)) {
        const skipTo = Math.floor(cellExitT(x, y, dx, dy, cx, cy, t) * steps);
        if (skipTo > i) i = skipTo - 1; // -1 because the loop increments.
      }
    }
  }
  return null;
}

/**
 * Segment parameter at which the ray leaves cell (cx, cy). Every sample before
 * it lies inside that cell, so when the cell holds no solid pixels they can all
 * be skipped without changing the result.
 */
function cellExitT(
  x: number,
  y: number,
  dx: number,
  dy: number,
  cx: number,
  cy: number,
  t: number,
): number {
  let span = Number.POSITIVE_INFINITY;
  if (dx > 0) span = Math.min(span, ((cx + 1) * BROADPHASE_CELL_SIZE - x) / dx);
  else if (dx < 0) span = Math.min(span, (cx * BROADPHASE_CELL_SIZE - x) / dx);
  if (dy > 0) span = Math.min(span, ((cy + 1) * BROADPHASE_CELL_SIZE - y) / dy);
  else if (dy < 0) span = Math.min(span, (cy * BROADPHASE_CELL_SIZE - y) / dy);
  return span === Number.POSITIVE_INFINITY ? t : t + span;
}
