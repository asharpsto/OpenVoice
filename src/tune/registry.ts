import terrainRaw from '../../tune/terrain.json';
import weaponRaw from '../../tune/weapon.json';
import windRaw from '../../tune/wind.json';
import aiRaw from '../../tune/ai.json';
import turnRaw from '../../tune/turn.json';
import physicsRaw from '../../tune/physics.json';
import monkeyRaw from '../../tune/monkey.json';
import { parseTerrainTune, setTerrainTune, type TerrainTuneJson } from './terrain.js';
import { parsePhysicsTune, setPhysicsTune, type PhysicsTune } from './physics.js';
import { parseMonkeyTune, setMonkeyTune, type MonkeyTune } from './monkey.js';
import { parseWeaponTune, setWeaponTune, type WeaponTune } from './weapon.js';
import { parseWindTune, setWindTune } from './wind.js';
import { parseAiTune, setAiTune } from './ai.js';
import { parseTurnTune, setTurnTune, type TurnTune } from './turn.js';
import type { AiTune } from '../ai/aim.js';
import type { WindTune } from '../wind/wind.js';

/**
 * What the slider overlay knows about the tuning files (SPEC §7).
 *
 * Ranges live here rather than in the JSON because they are UI metadata, not
 * tuning: the JSON holds values and nothing else.
 */
export interface TuneField {
  /** Dotted path into the file, e.g. "rim.depthPx". */
  path: string;
  min: number;
  max: number;
  step: number;
}

export interface TuneSpec {
  name: string;
  fields: TuneField[];
  /** Mutable working copy of the file's contents. */
  raw: Record<string, unknown>;
  /** Validates `raw` and installs it as the live tuning. Throws if invalid. */
  apply(): void;
}

export function readPath(source: unknown, path: string): number | undefined {
  let node: unknown = source;
  for (const key of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === 'number' ? node : undefined;
}

export function writePath(target: Record<string, unknown>, path: string, value: number): void {
  const keys = path.split('.');
  const last = keys.pop();
  if (!last) return;
  let node: Record<string, unknown> = target;
  for (const key of keys) {
    const next = node[key];
    if (typeof next !== 'object' || next === null) return;
    node = next as Record<string, unknown>;
  }
  node[last] = value;
}

/** Deep copy, so the working copy never aliases the imported module. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const terrain: TuneSpec = {
  name: 'terrain',
  raw: copy(terrainRaw) as unknown as Record<string, unknown>,
  fields: [
    { path: 'blastResistance.building', min: 0.2, max: 5, step: 0.05 },
    { path: 'blastResistance.ground', min: 0.2, max: 5, step: 0.05 },
    { path: 'blastResistance.vegetation', min: 0.1, max: 3, step: 0.05 },
    { path: 'blastResistance.vehicle', min: 0.1, max: 3, step: 0.05 },
    { path: 'blastResistance.pole', min: 0.1, max: 3, step: 0.05 },
    { path: 'rim.depthPx', min: 0, max: 12, step: 1 },
    { path: 'rim.strength', min: 0, max: 1, step: 0.01 },
    { path: 'backdrop', min: 0, max: 1, step: 0.01 },
    { path: 'query.raycastStepPx', min: 0.05, max: 1, step: 0.05 },
  ],
  apply() {
    setTerrainTune(parseTerrainTune(this.raw as unknown as TerrainTuneJson));
  },
};

const physics: TuneSpec = {
  name: 'physics',
  raw: copy(physicsRaw) as unknown as Record<string, unknown>,
  fields: [
    { path: 'gravity', min: 100, max: 3000, step: 10 },
    { path: 'drag', min: 0, max: 3, step: 0.01 },
    { path: 'terminalVelocity', min: 200, max: 3000, step: 10 },
    { path: 'friction', min: 0, max: 1, step: 0.01 },
    { path: 'bounce', min: 0, max: 1, step: 0.01 },
    { path: 'maxStepHeight', min: 0, max: 16, step: 1 },
    { path: 'maxSnapDistance', min: 0, max: 24, step: 1 },
    { path: 'restSpeed', min: 1, max: 100, step: 1 },
    { path: 'restFrames', min: 1, max: 60, step: 1 },
    { path: 'maxSubStepPx', min: 0.25, max: 2, step: 0.25 },
  ],
  apply() {
    setPhysicsTune(parsePhysicsTune(this.raw as unknown as PhysicsTune));
  },
};

const monkey: TuneSpec = {
  name: 'monkey',
  raw: copy(monkeyRaw) as unknown as Record<string, unknown>,
  fields: [
    { path: 'health', min: 10, max: 500, step: 5 },
    { path: 'colliderRadius', min: 4, max: 40, step: 1 },
    { path: 'walkSpeed', min: 10, max: 400, step: 5 },
    { path: 'jumpSpeed', min: 50, max: 800, step: 10 },
    { path: 'fallDamage.thresholdSpeed', min: 0, max: 1500, step: 10 },
    { path: 'fallDamage.perPixelPerSecond', min: 0, max: 1, step: 0.01 },
  ],
  apply() {
    setMonkeyTune(parseMonkeyTune(this.raw as unknown as MonkeyTune));
  },
};

const weapon: TuneSpec = {
  name: 'weapon',
  raw: copy(weaponRaw) as unknown as Record<string, unknown>,
  fields: [
    { path: 'muzzleVelocity.min', min: 50, max: 600, step: 10 },
    { path: 'muzzleVelocity.max', min: 200, max: 1400, step: 10 },
    { path: 'projectile.drag', min: 0, max: 1.5, step: 0.01 },
    { path: 'projectile.windInfluence', min: 0, max: 3, step: 0.05 },
    { path: 'blastRadius', min: 10, max: 220, step: 2 },
    // Damage and knockback are separate curves on purpose (SPEC §6.3): the gap
    // between them is where this genre's best moments come from, so they get
    // separate sliders and must never be ganged together.
    { path: 'damage.max', min: 0, max: 120, step: 1 },
    { path: 'damage.radius', min: 10, max: 320, step: 2 },
    { path: 'damage.falloffPower', min: 0.2, max: 4, step: 0.05 },
    { path: 'knockback.max', min: 0, max: 1600, step: 10 },
    { path: 'knockback.radius', min: 10, max: 400, step: 2 },
    { path: 'knockback.falloffPower', min: 0.2, max: 4, step: 0.05 },
    { path: 'shake.max', min: 0, max: 80, step: 1 },
  ],
  apply() {
    setWeaponTune(parseWeaponTune(this.raw as unknown as WeaponTune));
  },
};

const wind: TuneSpec = {
  name: 'wind',
  raw: copy(windRaw) as unknown as Record<string, unknown>,
  fields: [
    { path: 'maxStrength', min: 0, max: 600, step: 10 },
    { path: 'changePerTurn', min: 0, max: 1, step: 0.05 },
  ],
  apply() {
    setWindTune(parseWindTune(this.raw as unknown as WindTune));
  },
};

const ai: TuneSpec = {
  name: 'ai',
  raw: copy(aiRaw) as unknown as Record<string, unknown>,
  fields: [
    { path: 'aimErrorSigma.angleRadians', min: 0, max: 0.4, step: 0.005 },
    { path: 'aimErrorSigma.powerFraction', min: 0, max: 0.4, step: 0.005 },
  ],
  apply() {
    setAiTune(parseAiTune(this.raw as unknown as AiTune));
  },
};

const turn: TuneSpec = {
  name: 'turn',
  raw: copy(turnRaw) as unknown as Record<string, unknown>,
  fields: [
    { path: 'moveSeconds', min: 5, max: 120, step: 1 },
    { path: 'settleTimeoutSeconds', min: 1, max: 30, step: 1 },
    { path: 'retreatSeconds', min: 0, max: 10, step: 0.5 },
    { path: 'suddenDeathRound', min: 1, max: 40, step: 1 },
    { path: 'waterRisePerRound', min: 0, max: 80, step: 2 },
  ],
  apply() {
    setTurnTune(parseTurnTune(this.raw as unknown as TurnTune));
  },
};

/** Every tunable file. */
export const TUNE_SPECS: TuneSpec[] = [terrain, physics, monkey, weapon, wind, ai, turn];

export function specByName(name: string): TuneSpec | undefined {
  return TUNE_SPECS.find((spec) => spec.name === name);
}
