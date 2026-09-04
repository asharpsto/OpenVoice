import type { Rng } from '../core/rng.js';
import { analyticPosition, type ProjectileTune } from '../weapon/projectile.js';

/**
 * The dumb AI (SPEC §6.4).
 *
 * Pick the nearest living enemy, solve for an angle that reaches it accounting
 * for wind, add Gaussian error scaled by difficulty, fire. No pathing, no
 * movement, no target selection strategy.
 *
 * It exists so that iterating on the game does not need two people in the room
 * — that was a development bottleneck for the whole remaining build, not just a
 * missing feature — and its error term doubles as the difficulty dial.
 */

export interface AimErrorSigma {
  angleRadians: number;
  powerFraction: number;
}

export interface AiTune {
  aimErrorSigma: AimErrorSigma;
  difficulty: Record<string, AimErrorSigma>;
  /** How many angles to try when solving. More is slower and barely better. */
  searchAngles: number;
}

export interface AimSolution {
  angle: number;
  power: number;
  /** How close the solved arc passes to the target, in pixels. */
  missDistance: number;
}

/**
 * Searches angles for the one whose arc passes closest to the target.
 *
 * Drag makes a closed-form solve unpleasant, and a sampled search is both
 * simpler and robust to whatever the tuning does to the arc later. It is
 * evaluated against the analytic path, so it costs no simulation.
 */
export function solveAim(
  fromX: number,
  fromY: number,
  targetX: number,
  targetY: number,
  power: number,
  gravity: number,
  windX: number,
  tune: ProjectileTune,
  searchAngles: number,
): AimSolution {
  let best: AimSolution = { angle: 0, power, missDistance: Number.POSITIVE_INFINITY };
  const flightTime = 6;
  const samples = 90;
  for (let i = 0; i < searchAngles; i++) {
    // Upper half-circle only: lobbing over, not firing into the ground.
    const angle = -Math.PI + (i / (searchAngles - 1)) * Math.PI;
    const vx = Math.cos(angle) * power;
    const vy = Math.sin(angle) * power;
    let closest = Number.POSITIVE_INFINITY;
    for (let s = 1; s <= samples; s++) {
      const point = analyticPosition(
        fromX,
        fromY,
        vx,
        vy,
        (s / samples) * flightTime,
        gravity,
        windX,
        tune,
      );
      const distance = Math.hypot(point.x - targetX, point.y - targetY);
      if (distance < closest) closest = distance;
    }
    if (closest < best.missDistance) best = { angle, power, missDistance: closest };
  }
  return best;
}

/** Box–Muller, on the seeded RNG so an AI turn replays identically. */
export function gaussian(rng: Rng): number {
  const u = Math.max(Number.EPSILON, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Adds the difficulty error to a solved aim. */
export function addAimError(
  solution: AimSolution,
  rng: Rng,
  sigma: AimErrorSigma,
): { angle: number; power: number } {
  return {
    angle: solution.angle + gaussian(rng) * sigma.angleRadians,
    power: Math.max(1, solution.power * (1 + gaussian(rng) * sigma.powerFraction)),
  };
}

export interface Target {
  x: number;
  y: number;
}

/** Nearest living enemy. That is the whole target selection strategy. */
export function nearestTarget(fromX: number, fromY: number, targets: readonly Target[]): number {
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < targets.length; i++) {
    const distance = Math.hypot(targets[i].x - fromX, targets[i].y - fromY);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex;
}
