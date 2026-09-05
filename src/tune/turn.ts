import turnRaw from '../../tune/turn.json';

/** Typed view of `tune/turn.json` (SPEC §6.6, §7). */
export interface TurnTune {
  /** Move phase length. Firing ends it immediately. */
  moveSeconds: number;
  /**
   * How long `SETTLE_WAIT` waits before force-freezing everything and moving
   * on. A monkey oscillating in a crater bowl may never come to rest, and the
   * turn must not hang on it.
   */
  settleTimeoutSeconds: number;
  /** Round at which the water starts rising. */
  suddenDeathRound: number;
  /** Pixels the water climbs each round once sudden death has started. */
  waterRisePerRound: number;
  teamSize: number;
  /** Grace after firing before the turn ends, so you can watch it land. */
  retreatSeconds: number;
}

export function parseTurnTune(raw: TurnTune): TurnTune {
  for (const key of ['moveSeconds', 'settleTimeoutSeconds', 'teamSize'] as const) {
    if (!(raw[key] > 0)) throw new Error(`tune/turn.json: ${key} must be positive`);
  }
  if (!Number.isInteger(raw.teamSize)) throw new Error(`tune/turn.json: teamSize must be an integer`);
  if (raw.suddenDeathRound < 1) throw new Error(`tune/turn.json: suddenDeathRound must be at least 1`);
  if (raw.waterRisePerRound < 0) throw new Error(`tune/turn.json: waterRisePerRound must not be negative`);
  if (raw.retreatSeconds < 0) throw new Error(`tune/turn.json: retreatSeconds must not be negative`);
  return { ...raw };
}

let cached: TurnTune | undefined;

export function getTurnTune(): TurnTune {
  cached ??= parseTurnTune(turnRaw as TurnTune);
  return cached;
}

export function setTurnTune(tune: TurnTune): void {
  cached = tune;
}
