import { Mask } from '../src/terrain/mask.js';
import { parseTerrainTune, type TerrainTune, type TerrainTuneJson } from '../src/tune/terrain.js';

/**
 * Builds a mask from ASCII art: '.' or ' ' is empty, a digit is a material ID.
 * Fixtures stay readable, which matters when a test says a crater is the wrong
 * shape and you need to see the shape.
 */
export function maskFromAscii(rows: string[]): Mask {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  const mask = new Mask(width, height);
  for (let y = 0; y < height; y++) {
    const row = rows[y];
    if (row.length !== width) {
      throw new Error(`Row ${y} is ${row.length} wide, expected ${width}`);
    }
    for (let x = 0; x < width; x++) {
      const c = row[x];
      if (c === '.' || c === ' ') continue;
      const id = Number(c);
      if (!Number.isInteger(id) || id < 1 || id > 5) {
        throw new Error(`Bad material '${c}' at ${x},${y}`);
      }
      mask.set(x, y, id as 1 | 2 | 3 | 4 | 5);
    }
  }
  return mask;
}

export function maskToAscii(mask: Mask): string[] {
  const rows: string[] = [];
  for (let y = 0; y < mask.height; y++) {
    let row = '';
    for (let x = 0; x < mask.width; x++) {
      const m = mask.at(x, y);
      row += m === 0 ? '.' : String(m);
    }
    rows.push(row);
  }
  return rows;
}

const BASE_TUNE: TerrainTuneJson = {
  blastResistance: { building: 2, ground: 1, vegetation: 0.5, vehicle: 0.5, pole: 0.25 },
  rim: { depthPx: 4, strength: 0.6 },
  query: { raycastStepPx: 0.25 },
  validation: {
    minSolidFraction: 0.25,
    maxSolidFraction: 0.75,
    minSpawnPoints: 8,
    spawnWidthPx: 8,
    spawnClearanceHeightPx: 12,
    spawnFlatnessTolerancePx: 2,
    spawnSpacingPx: 16,
    spawnGroundDepthPx: 4,
  },
};

/**
 * Tuning for tests. Deliberately not `tune/terrain.json`: retuning the game for
 * feel must never turn a terrain test red.
 */
export function tuneFixture(overrides: Partial<TerrainTuneJson> = {}): TerrainTune {
  return parseTerrainTune({
    ...BASE_TUNE,
    ...overrides,
    blastResistance: { ...BASE_TUNE.blastResistance, ...overrides.blastResistance },
    rim: { ...BASE_TUNE.rim, ...overrides.rim },
    query: { ...BASE_TUNE.query, ...overrides.query },
    validation: { ...BASE_TUNE.validation, ...overrides.validation },
  });
}

/** Deterministic PRNG so a failing fuzz case can be replayed exactly. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
