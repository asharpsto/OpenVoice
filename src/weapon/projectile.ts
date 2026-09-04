import { raycast, type RayHit } from '../terrain/query.js';
import type { Mask } from '../terrain/mask.js';

/**
 * The generic projectile system (SPEC §0.1) — parcels in Hardwicke, bananas
 * here, same integrator with different parameters.
 *
 * A point with gravity, linear drag and a constant wind for the turn. The path
 * is kept a **clean parabola**: a banana-shaped flight is a tempting joke that
 * would wreck pillar 2, which is that the whole game is judging an arc. Spin
 * the sprite instead — the parabola is already banana-shaped (SPEC §6.3).
 */

export interface ProjectileTune {
  /** Velocity shed per second, as a fraction. Linear, so the arc stays solvable. */
  drag: number;
  /** Multiplier on world gravity, for projectiles that should float or plummet. */
  gravityScale: number;
  /** How strongly wind pushes it, 0..1. Wind affects the projectile only. */
  windInfluence: number;
}

export interface Projectile {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Seconds since launch, for the whistle pitch and flight timeouts. */
  age: number;
}

export function launch(x: number, y: number, angle: number, power: number): Projectile {
  return { x, y, vx: Math.cos(angle) * power, vy: Math.sin(angle) * power, age: 0 };
}

/** Where a shot ended, and why. */
export interface FlightStep {
  /** Terrain the projectile struck this step, if any. */
  hit: RayHit | null;
  /** True once it has left the map — off the side, or below the bottom. */
  offMap: boolean;
}

/**
 * Advances one step and tests the swept segment against the terrain.
 *
 * The segment is handed to the terrain raycast rather than point-tested at the
 * new position: a fast banana moves further than the fence it is about to hit
 * is thick, and testing only the endpoints is exactly how it tunnels through
 * (SPEC §5.5).
 */
export function stepProjectile(
  projectile: Projectile,
  dt: number,
  mask: Mask,
  gravity: number,
  windX: number,
  tune: ProjectileTune,
  raycastStepPx: number,
): FlightStep {
  const ax = windX * tune.windInfluence;
  const ay = gravity * tune.gravityScale;
  const k = tune.drag;

  const fromX = projectile.x;
  const fromY = projectile.y;
  // Exact integration, not Euler. Drag here is linear, so the step has a
  // closed form — and using it means the shot flies precisely where
  // `analyticPosition` said it would. The preview is drawn from that same
  // function, and a preview that disagrees with the shot by even a few pixels
  // teaches players to stop trusting it, which would undo pillar 2.
  if (k <= 0) {
    projectile.x += projectile.vx * dt + 0.5 * ax * dt * dt;
    projectile.y += projectile.vy * dt + 0.5 * ay * dt * dt;
    projectile.vx += ax * dt;
    projectile.vy += ay * dt;
  } else {
    const decay = Math.exp(-k * dt);
    const restX = ax / k;
    const restY = ay / k;
    projectile.x += ((projectile.vx - restX) / k) * (1 - decay) + restX * dt;
    projectile.y += ((projectile.vy - restY) / k) * (1 - decay) + restY * dt;
    projectile.vx = (projectile.vx - restX) * decay + restX;
    projectile.vy = (projectile.vy - restY) * decay + restY;
  }
  projectile.age += dt;

  const hit = raycast(mask, fromX, fromY, projectile.x, projectile.y, { stepPx: raycastStepPx });
  if (hit) {
    projectile.x = hit.x;
    projectile.y = hit.y;
  }
  const offMap =
    !hit &&
    (projectile.y > mask.height ||
      projectile.x < -mask.width ||
      projectile.x > mask.width * 2);
  return { hit, offMap };
}

/**
 * Closed-form position under constant acceleration and linear drag.
 *
 * Used by the trajectory preview, by the AI's aim search, and by the test that
 * pins the integrator to the analytic arc (SPEC §10). Because drag here is
 * linear, the arc has an exact solution and there is something real to check
 * the integrator against.
 */
export function analyticPosition(
  x0: number,
  y0: number,
  vx0: number,
  vy0: number,
  t: number,
  gravity: number,
  windX: number,
  tune: ProjectileTune,
): { x: number; y: number } {
  const k = tune.drag;
  const ax = windX * tune.windInfluence;
  const ay = gravity * tune.gravityScale;
  if (k <= 0) {
    return {
      x: x0 + vx0 * t + 0.5 * ax * t * t,
      y: y0 + vy0 * t + 0.5 * ay * t * t,
    };
  }
  // v' = a - k*v  =>  v(t) = (v0 - a/k)e^-kt + a/k, integrated for position.
  // Check the signs against the k -> 0 limit if you touch this: it must reduce
  // to x0 + v0*t + a*t^2/2, and getting it backwards curves the preview the
  // wrong way while the shot itself flies true.
  const decay = 1 - Math.exp(-k * t);
  return {
    x: x0 + ((vx0 - ax / k) / k) * decay + (ax / k) * t,
    y: y0 + ((vy0 - ay / k) / k) * decay + (ay / k) * t,
  };
}

/**
 * Samples the arc for the trajectory preview (SPEC §6.3 — mandatory, and never
 * cut). Stops at terrain so the dotted line does not draw through a wall.
 */
export function previewArc(
  x: number,
  y: number,
  angle: number,
  power: number,
  mask: Mask,
  gravity: number,
  windX: number,
  tune: ProjectileTune,
  options: { points: number; secondsPerPoint: number },
): Array<{ x: number; y: number }> {
  const vx = Math.cos(angle) * power;
  const vy = Math.sin(angle) * power;
  const arc: Array<{ x: number; y: number }> = [];
  let previous = { x, y };
  for (let i = 1; i <= options.points; i++) {
    const point = analyticPosition(x, y, vx, vy, i * options.secondsPerPoint, gravity, windX, tune);
    const hit = raycast(mask, previous.x, previous.y, point.x, point.y, { stepPx: 1 });
    if (hit) {
      arc.push({ x: hit.x, y: hit.y });
      break;
    }
    arc.push(point);
    if (point.y > mask.height) break;
    previous = point;
  }
  return arc;
}
