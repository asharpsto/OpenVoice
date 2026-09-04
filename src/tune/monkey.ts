import monkeyTuneJson from '../../tune/monkey.json';

/** Typed view of `tune/monkey.json` (SPEC §6.2, §7). */
export interface FallDamageTune {
  /** Impact speed below which a landing is free, px/s. */
  thresholdSpeed: number;
  /** Health lost per px/s of impact speed above the threshold. */
  perPixelPerSecond: number;
}

export interface MonkeyTune {
  health: number;
  /** The collider is a circle regardless of sprite shape (CLAUDE.md). */
  colliderRadius: number;
  walkSpeed: number;
  jumpSpeed: number;
  fallDamage: FallDamageTune;
}

export function parseMonkeyTune(raw: MonkeyTune): MonkeyTune {
  for (const key of ['health', 'colliderRadius', 'walkSpeed', 'jumpSpeed'] as const) {
    if (!(raw[key] > 0) || !Number.isFinite(raw[key])) {
      throw new Error(`tune/monkey.json: ${key} must be a positive finite number, got ${raw[key]}`);
    }
  }
  if (raw.fallDamage.thresholdSpeed < 0 || raw.fallDamage.perPixelPerSecond < 0) {
    throw new Error(`tune/monkey.json: fallDamage values must not be negative`);
  }
  return { ...raw, fallDamage: { ...raw.fallDamage } };
}

/** Health lost by landing at `impactSpeed` (SPEC §6.2). */
export function fallDamageFor(impactSpeed: number, tune: MonkeyTune): number {
  const excess = impactSpeed - tune.fallDamage.thresholdSpeed;
  return excess <= 0 ? 0 : excess * tune.fallDamage.perPixelPerSecond;
}

let cached: MonkeyTune | undefined;

export function getMonkeyTune(): MonkeyTune {
  cached ??= parseMonkeyTune(monkeyTuneJson as MonkeyTune);
  return cached;
}

export function setMonkeyTune(tune: MonkeyTune): void {
  cached = tune;
}
