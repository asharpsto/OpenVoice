import type { Mask } from '../terrain/mask.js';
import type { MonkeyTune } from '../tune/monkey.js';
import type { PhysicsTune } from '../tune/physics.js';
import type { Body } from './body.js';
import type { CircleCollider } from './collider.js';

/**
 * The stepped character controller (SPEC §6.1).
 *
 * Rev 1 specified sampling points around the circumference. That detects
 * contact but yields no penetration depth and no surface normal, so the body
 * sinks, catches on edges and jitters. This is the stepped version instead:
 * movement advances a pixel at a time, and where a pixel is blocked the body
 * tries to *step up* over it, up to the slope limit.
 *
 * **Never** resolve a collision by pushing out along a sampled normal. That is
 * what causes the jitter, and there is deliberately no code here that could.
 */

export interface CharacterInput {
  /** -1 walks left, 1 walks right, 0 stands still. */
  move: -1 | 0 | 1;
  jump: boolean;
}

export const IDLE: CharacterInput = { move: 0, jump: false };

/**
 * Advances one body by one fixed timestep.
 *
 * Grounded bodies walk (stepped, never integrated) and then settle. Airborne
 * bodies integrate ballistically with stepped collision. The split is what
 * keeps a standing monkey perfectly still: a grounded body with no input does
 * no arithmetic that could drift.
 */
export function stepCharacter(
  body: Body,
  input: CharacterInput,
  mask: Mask,
  collider: CircleCollider,
  physics: PhysicsTune,
  monkey: MonkeyTune,
  dt: number,
): void {
  unstick(body, mask, collider);

  if (body.grounded && input.jump) {
    body.vy = -monkey.jumpSpeed;
    body.grounded = false;
    body.atRest = false;
    body.restFrames = 0;
  }

  if (body.grounded) {
    if (input.move !== 0) {
      walk(body, input.move, monkey.walkSpeed * dt, mask, collider, physics);
      body.atRest = false;
      body.restFrames = 0;
    }
    settle(body, mask, collider, physics);
    if (body.grounded) {
      // Standing still is standing still: no residual velocity to integrate.
      body.vx = 0;
      body.vy = 0;
    }
  } else {
    integrateAirborne(body, mask, collider, physics, dt);
  }

  updateRest(body, physics, input);
}

/**
 * Horizontal movement, a pixel at a time, stepping up over anything within the
 * slope limit and stopping at anything above it (SPEC §6.1).
 */
export function walk(
  body: Body,
  direction: -1 | 1,
  distance: number,
  mask: Mask,
  collider: CircleCollider,
  physics: PhysicsTune,
): number {
  let remaining = Math.abs(distance);
  let moved = 0;
  while (remaining > 0) {
    const stepSize = Math.min(1, remaining);
    remaining -= stepSize;
    const nextX = body.x + direction * stepSize;

    if (!collider.overlaps(mask, nextX, body.y)) {
      body.x = nextX;
      moved += stepSize;
      continue;
    }

    // Blocked. Try to rise over it, one pixel at a time, up to the slope limit.
    let stepped = false;
    for (let h = 1; h <= physics.maxStepHeight; h++) {
      if (collider.overlaps(mask, nextX, body.y - h)) continue;
      body.x = nextX;
      body.y -= h;
      moved += stepSize;
      stepped = true;
      break;
    }
    if (!stepped) break; // Slope too steep.
  }
  return moved;
}

/**
 * Vertical settling for a grounded body: probe down up to `maxSnapDistance`.
 * Ground found means snap to it and stay grounded; nothing found means the
 * body has walked off an edge and is now airborne (SPEC §6.1).
 */
export function settle(
  body: Body,
  mask: Mask,
  collider: CircleCollider,
  physics: PhysicsTune,
): void {
  if (collider.overlaps(mask, body.x, body.y + 1)) {
    body.grounded = true;
    return;
  }
  for (let d = 1; d <= physics.maxSnapDistance; d++) {
    if (collider.overlaps(mask, body.x, body.y + d + 1)) {
      body.y += d;
      body.grounded = true;
      return;
    }
  }
  body.grounded = false;
}

/** Ballistic flight with stepped collision and axis-separated response. */
function integrateAirborne(
  body: Body,
  mask: Mask,
  collider: CircleCollider,
  physics: PhysicsTune,
  dt: number,
): void {
  body.vy += physics.gravity * dt;
  const shed = Math.max(0, 1 - physics.drag * dt);
  body.vx *= shed;
  body.vy *= shed;

  const speed = Math.hypot(body.vx, body.vy);
  if (speed > physics.terminalVelocity) {
    const scale = physics.terminalVelocity / speed;
    body.vx *= scale;
    body.vy *= scale;
  }

  const dx = body.vx * dt;
  const dy = body.vy * dt;
  // Sub-pixel stepping: a fast body integrated in one jump would pass straight
  // through thin terrain between samples (SPEC §5.5).
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / physics.maxSubStepPx));
  const sx = dx / steps;
  const sy = dy / steps;

  for (let i = 0; i < steps; i++) {
    if (!collider.overlaps(mask, body.x + sx, body.y)) {
      body.x += sx;
    } else {
      // Axis-separated response: reflect along the blocked axis and take
      // friction off the other. No normal is sampled, so none can be wrong.
      body.lastImpactSpeed = Math.max(body.lastImpactSpeed, Math.abs(body.vx));
      body.vx = -body.vx * physics.bounce;
      body.vy *= physics.friction;
      break;
    }
    if (!collider.overlaps(mask, body.x, body.y + sy)) {
      body.y += sy;
      continue;
    }
    const landing = sy > 0;
    body.lastImpactSpeed = Math.max(body.lastImpactSpeed, Math.abs(body.vy));
    body.vy = -body.vy * physics.bounce;
    body.vx *= physics.friction;
    if (landing) {
      settle(body, mask, collider, physics);
      if (body.grounded) return;
    }
    break;
  }

  if (body.vy >= 0) settle(body, mask, collider, physics);
}

/**
 * A body that has ended up inside terrain is lifted straight up until it is
 * clear.
 *
 * The realistic cases are shallow: a spawn point puts a body's centre on the
 * surface pixel, so half the circle starts buried, and the airborne response
 * can leave a pixel of overlap. Two diameters covers those with room to spare.
 *
 * The bound is deliberate. A body genuinely entombed — inside a slab thicker
 * than this — is left exactly where it is rather than teleported somewhere
 * arbitrary; that is the turn machine's problem to resolve (SPEC §6.6), and
 * an unbounded search would cost a full column scan every frame.
 */
function unstick(body: Body, mask: Mask, collider: CircleCollider): void {
  if (!collider.overlaps(mask, body.x, body.y)) return;
  const limit = Math.ceil(collider.radius * 4);
  for (let d = 1; d <= limit; d++) {
    if (collider.overlaps(mask, body.x, body.y - d)) continue;
    body.y -= d;
    body.vy = Math.min(0, body.vy);
    return;
  }
}

/** Rest test: under the rest speed for N consecutive frames (SPEC §6.1). */
function updateRest(body: Body, physics: PhysicsTune, input: CharacterInput): void {
  const moving = input.move !== 0 || input.jump;
  const slow = Math.hypot(body.vx, body.vy) < physics.restSpeed;
  if (!moving && slow && body.grounded) {
    body.restFrames++;
    if (body.restFrames >= physics.restFrames) {
      body.atRest = true;
      body.vx = 0;
      body.vy = 0;
    }
  } else {
    body.restFrames = 0;
    body.atRest = false;
  }
}
