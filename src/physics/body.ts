/** A physical body: a circle with velocity, and whether it is standing on something. */
export interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
  grounded: boolean;
  /** Settled: under the rest speed for long enough that the turn can move on. */
  atRest: boolean;
  /** Consecutive frames spent under the rest speed. */
  restFrames: number;
  /** Speed at the moment of the last landing, for fall damage (SPEC §6.2). */
  lastImpactSpeed: number;
}

export function createBody(x: number, y: number): Body {
  return { x, y, vx: 0, vy: 0, grounded: false, atRest: false, restFrames: 0, lastImpactSpeed: 0 };
}

export function cloneBody(body: Body): Body {
  return { ...body };
}

/** Knockback, including your own (SPEC §6.3). Wakes the body up. */
export function applyImpulse(body: Body, ix: number, iy: number): void {
  body.vx += ix;
  body.vy += iy;
  body.grounded = false;
  body.atRest = false;
  body.restFrames = 0;
}
