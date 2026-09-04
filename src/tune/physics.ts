import physicsTuneJson from '../../tune/physics.json';

/**
 * Typed view of `tune/physics.json` (SPEC §6.1, §7).
 *
 * Everything here affects feel, so none of it may appear in code — a magic
 * number affecting feel is a bug (CLAUDE.md). The controller takes this as a
 * parameter so the slider overlay can swap it live and tests can pin it.
 */
export interface PhysicsTune {
  /** Downward acceleration, px/s². */
  gravity: number;
  /** Air resistance, as a fraction of velocity shed per second. */
  drag: number;
  /** Speed cap while airborne, px/s. */
  terminalVelocity: number;
  /** Tangential velocity retained on impact, 0..1. */
  friction: number;
  /** Velocity reflected on impact, 0..1. */
  bounce: number;
  /** Slope limit: how far up a body will step to keep walking (SPEC §6.1). */
  maxStepHeight: number;
  /** How far down a grounded body probes for ground before going airborne. */
  maxSnapDistance: number;
  /** Below this speed a body is a candidate for rest, px/s. */
  restSpeed: number;
  /** Consecutive frames under `restSpeed` before a body is declared at rest. */
  restFrames: number;
  /** Airborne integration sub-step, px. Never integrate in large steps. */
  maxSubStepPx: number;
}

function positive(value: number, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`tune/physics.json: ${path} must be a positive finite number, got ${value}`);
  }
  return value;
}

function fraction(value: number, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`tune/physics.json: ${path} must be within 0..1, got ${value}`);
  }
  return value;
}

export function parsePhysicsTune(raw: PhysicsTune): PhysicsTune {
  positive(raw.gravity, 'gravity');
  positive(raw.terminalVelocity, 'terminalVelocity');
  positive(raw.restSpeed, 'restSpeed');
  fraction(raw.friction, 'friction');
  fraction(raw.bounce, 'bounce');
  if (raw.drag < 0) throw new Error(`tune/physics.json: drag must not be negative`);
  for (const key of ['maxStepHeight', 'maxSnapDistance', 'restFrames'] as const) {
    if (!Number.isInteger(raw[key]) || raw[key] < 0) {
      throw new Error(`tune/physics.json: ${key} must be a non-negative integer, got ${raw[key]}`);
    }
  }
  if (!(raw.maxSubStepPx > 0) || raw.maxSubStepPx > 2) {
    // A body that moves more than a pixel or two per sub-step can pass through
    // thin terrain between samples (SPEC §5.5).
    throw new Error(`tune/physics.json: maxSubStepPx must be within (0, 2], got ${raw.maxSubStepPx}`);
  }
  return { ...raw };
}

let cached: PhysicsTune | undefined;

export function getPhysicsTune(): PhysicsTune {
  cached ??= parsePhysicsTune(physicsTuneJson as PhysicsTune);
  return cached;
}

/** Replaces the cached tuning. Used by the hot-reload harness. */
export function setPhysicsTune(tune: PhysicsTune): void {
  cached = tune;
}
