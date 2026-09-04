import type { Rng } from '../core/rng.js';

/**
 * Wind (SPEC §6.3). Constant for a turn, changes between them, affects the
 * projectile only.
 *
 * In a single-weapon game this is the main source of turn-to-turn variety, so
 * the range wants to be generous enough to actually matter — a wind you can
 * ignore is a wind that is not doing its job.
 */
export interface WindTune {
  /** Largest wind acceleration, px/s², in either direction. */
  maxStrength: number;
  /**
   * How much of the range a turn can move through, 0..1. At 1 any turn can
   * produce any wind; lower values drift, so players can read the trend.
   */
  changePerTurn: number;
}

export interface Wind {
  /** Signed acceleration: negative blows left. */
  x: number;
}

export function createWind(rng: Rng, tune: WindTune): Wind {
  return { x: (rng() * 2 - 1) * tune.maxStrength };
}

/** Rolls the wind for a new turn, drifting from the current value. */
export function nextWind(current: Wind, rng: Rng, tune: WindTune): Wind {
  const target = (rng() * 2 - 1) * tune.maxStrength;
  const x = current.x + (target - current.x) * tune.changePerTurn;
  return { x: Math.max(-tune.maxStrength, Math.min(tune.maxStrength, x)) };
}

/** 0..1, for sizing the wind gauge and the ambience volume. */
export function windFraction(wind: Wind, tune: WindTune): number {
  return Math.min(1, Math.abs(wind.x) / tune.maxStrength);
}
