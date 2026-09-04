import windRaw from '../../tune/wind.json';
import type { WindTune } from '../wind/wind.js';

export function parseWindTune(raw: WindTune): WindTune {
  if (!(raw.maxStrength > 0)) throw new Error(`tune/wind.json: maxStrength must be positive`);
  if (raw.changePerTurn < 0 || raw.changePerTurn > 1) {
    throw new Error(`tune/wind.json: changePerTurn must be within 0..1`);
  }
  return { ...raw };
}

let cached: WindTune | undefined;

export function getWindTune(): WindTune {
  cached ??= parseWindTune(windRaw as WindTune);
  return cached;
}

export function setWindTune(tune: WindTune): void {
  cached = tune;
}
