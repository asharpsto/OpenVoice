import { applyImpulse, type Body } from '../physics/body.js';

/**
 * Blast effects on bodies (SPEC §6.3).
 *
 * Damage and knockback fall off **separately, on independently tunable
 * curves** — different maxima, different radii, different falloff powers. This
 * is non-negotiable: almost every memorable moment in this genre lives in the
 * gap between the two. A shot that barely scratches someone but throws them
 * into the sea is the point, and it is impossible if one curve drives both.
 */

export interface FalloffCurve {
  /** Value at the centre of the blast. */
  max: number;
  /** Distance at which it reaches zero. */
  radius: number;
  /** 1 is linear; above 1 concentrates the effect at the centre. */
  falloffPower: number;
}

export function falloffAt(distance: number, curve: FalloffCurve): number {
  if (distance >= curve.radius) return 0;
  const t = 1 - distance / curve.radius;
  return curve.max * Math.pow(t, curve.falloffPower);
}

export interface BlastTune {
  damage: FalloffCurve;
  knockback: FalloffCurve;
}

export interface BlastEffect {
  /** Index into the array passed in, so callers can map back to their own state. */
  index: number;
  distance: number;
  damage: number;
  impulse: { x: number; y: number };
}

/**
 * Works out what a blast at (x, y) does to each body, and applies the impulses.
 *
 * Damage is returned rather than applied: health belongs to the monkey and the
 * turn machine, not to the physics.
 */
export function applyBlast(
  bodies: readonly Body[],
  x: number,
  y: number,
  tune: BlastTune,
): BlastEffect[] {
  const effects: BlastEffect[] = [];
  for (let index = 0; index < bodies.length; index++) {
    const body = bodies[index];
    const dx = body.x - x;
    const dy = body.y - y;
    const distance = Math.hypot(dx, dy);
    const damage = falloffAt(distance, tune.damage);
    const impulseMagnitude = falloffAt(distance, tune.knockback);
    if (damage === 0 && impulseMagnitude === 0) continue;

    // A body sitting exactly on the blast centre — a monkey shooting its own
    // feet — has no direction to be thrown in. Send it straight up, which is
    // also the only useful answer for self-propulsion (SPEC §6.3).
    const length = distance < 0.001 ? 0 : distance;
    const nx = length === 0 ? 0 : dx / length;
    const ny = length === 0 ? -1 : dy / length;
    const impulse = { x: nx * impulseMagnitude, y: ny * impulseMagnitude };
    if (impulseMagnitude > 0) applyImpulse(body, impulse.x, impulse.y);
    effects.push({ index, distance, damage, impulse });
  }
  return effects;
}

/** Screen shake, strongest at the blast (SPEC §6.3). */
export function shakeAt(distance: number, max: number, radius: number): number {
  return falloffAt(distance, { max, radius, falloffPower: 2 });
}
