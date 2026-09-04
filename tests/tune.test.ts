import { describe, expect, it } from 'vitest';
import { BUILDING, GROUND, POLE, VEGETATION, VEHICLE } from '../src/terrain/materials.js';
import { getTerrainTune, parseTerrainTune, type TerrainTuneJson } from '../src/tune/terrain.js';

const valid: TerrainTuneJson = {
  backdrop: 0.34,
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

describe('tune/terrain.json', () => {
  it('loads', () => {
    const tune = getTerrainTune();
    expect(tune.blastResistance[GROUND]).toBeGreaterThan(0);
    expect(tune.rim.depthPx).toBeGreaterThanOrEqual(0);
  });

  it('keeps the material hierarchy the spec promises', () => {
    // "Hide behind the wall, not the hedge" is a design rule, not a feel value:
    // a wall must always resist more than the ground, and a pole least of all
    // (SPEC §5.3).
    const r = getTerrainTune().blastResistance;
    expect(r[BUILDING]).toBeGreaterThan(r[GROUND]);
    expect(r[GROUND]).toBeGreaterThan(r[VEGETATION]);
    expect(r[GROUND]).toBeGreaterThan(r[VEHICLE]);
    expect(r[VEGETATION]).toBeGreaterThan(r[POLE]);
  });

  it('keeps raycast stepping sub-pixel', () => {
    expect(getTerrainTune().query.raycastStepPx).toBeGreaterThan(0);
    expect(getTerrainTune().query.raycastStepPx).toBeLessThanOrEqual(1);
  });

  it('precomputes the radius scale the blit loop uses', () => {
    const tune = parseTerrainTune(valid);
    expect(tune.radiusScale[BUILDING]).toBeCloseTo(0.5);
    expect(tune.radiusScale[POLE]).toBeCloseTo(4);
    expect(tune.maxRadiusScale).toBeCloseTo(4);
  });

  it('rejects tuning that would break the terrain rather than loading it', () => {
    expect(() =>
      parseTerrainTune({ ...valid, blastResistance: { ...valid.blastResistance, ground: 0 } }),
    ).toThrow(/positive/);
    expect(() =>
      parseTerrainTune({ ...valid, blastResistance: { building: 1, ground: 1 } }),
    ).toThrow(/vegetation is missing/);
    expect(() => parseTerrainTune({ ...valid, rim: { depthPx: 2.5, strength: 0.5 } })).toThrow(
      /non-negative integer/,
    );
    expect(() => parseTerrainTune({ ...valid, rim: { depthPx: 2, strength: 1.5 } })).toThrow(
      /within 0\.\.1/,
    );
    expect(() => parseTerrainTune({ ...valid, query: { raycastStepPx: 2 } })).toThrow(/sub-pixel/);
  });
});
