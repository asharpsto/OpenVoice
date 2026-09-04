import { describe, expect, it } from 'vitest';
import { Mask } from '../src/terrain/mask.js';
import { labelSolidComponents, validateMap } from '../src/terrain/validate.js';
import { tuneFixture } from './helpers.js';

const tune = tuneFixture().validation;
/** For fixtures that isolate one rule, the coverage rule is turned down. */
const anyCoverage = tuneFixture({
  validation: { ...tuneFixture().validation, minSolidFraction: 0.02, maxSolidFraction: 0.98 },
}).validation;

function fill(mask: Mask, x0: number, y0: number, x1: number, y1: number, m: 1 | 2 | 3): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) mask.set(x, y, m);
}

/** An open street: flat ground across the bottom, sky above. The happy case. */
function streetMap(): Mask {
  const mask = new Mask(400, 200);
  fill(mask, 0, 120, 399, 199, 2);
  return mask;
}

describe('map validation', () => {
  it('accepts a playable map', () => {
    const result = validateMap(streetMap(), 199, tune);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.spawns.length).toBeGreaterThanOrEqual(tune.minSpawnPoints);
    expect(result.islandSpawns).toEqual([]);
  });

  it('rejects all sky', () => {
    const result = validateMap(new Mask(400, 200), 199, tune);
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/Too little terrain/);
    expect(result.spawns).toEqual([]);
  });

  it('rejects all solid', () => {
    const mask = new Mask(400, 200);
    fill(mask, 0, 0, 399, 199, 2);
    const result = validateMap(mask, 199, tune);
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/Too little sky/);
  });

  it('rejects a map with no flat ground to stand on', () => {
    // Sawtooth: the surface moves 4px per column, well past the flatness limit.
    const mask = new Mask(400, 200);
    for (let x = 0; x < 400; x++) fill(mask, x, 120 + (x % 8) * 4, x, 199, 2);
    const result = validateMap(mask, 199, tune);
    expect(result.ok).toBe(false);
    expect(result.spawns.length).toBeLessThan(tune.minSpawnPoints);
    expect(result.problems.join('\n')).toMatch(/reachable spawn point/);
  });

  it('will not count a spawn stranded on a floating island', () => {
    const mask = new Mask(400, 200);
    // Mainland: one short flat ledge, good for a handful of spawns.
    fill(mask, 0, 150, 79, 199, 2);
    // Islands: flat-topped platforms with nothing joining them to the ledge.
    for (const x of [120, 180, 240, 300, 350]) fill(mask, x, 60, x + 39, 67, 1);

    const result = validateMap(mask, 199, anyCoverage);
    expect(result.islandSpawns.length).toBeGreaterThan(0);
    expect(result.spawns.length).toBeLessThan(anyCoverage.minSpawnPoints);
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/reachable spawn point/);
    expect(result.warnings.join('\n')).toMatch(/not on the main land mass/);
    for (const spawn of result.spawns) expect(spawn.x).toBeLessThan(80);
  });

  it('rejects a water line that is not below the lowest spawn', () => {
    const mask = streetMap();
    const drowned = validateMap(mask, 100, tune);
    expect(drowned.ok).toBe(false);
    expect(drowned.problems.join('\n')).toMatch(/Water line/);
    expect(validateMap(mask, 121, tune).ok).toBe(true);
  });

  it('finds spawns on the street under a bridge as well as on the deck', () => {
    const mask = new Mask(400, 200);
    fill(mask, 0, 150, 399, 199, 2);
    // A deck overhead, joined to the ground by a support at each end so it is
    // part of the same land mass.
    fill(mask, 100, 40, 299, 47, 1);
    fill(mask, 100, 48, 107, 149, 1);
    fill(mask, 292, 48, 299, 149, 1);

    const result = validateMap(mask, 199, tune);
    const decks = result.spawns.filter((s) => s.y === 40);
    const underneath = result.spawns.filter((s) => s.y === 150 && s.x > 110 && s.x < 290);
    expect(decks.length).toBeGreaterThan(0);
    expect(underneath.length).toBeGreaterThan(0);
    expect(result.islandSpawns).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('treats a bridge deck with no way up to it as an island', () => {
    const mask = new Mask(400, 200);
    fill(mask, 0, 150, 399, 199, 2);
    fill(mask, 0, 40, 399, 47, 1);
    const result = validateMap(mask, 199, tune);
    expect(result.islandSpawns.length).toBeGreaterThan(0);
    for (const spawn of result.islandSpawns) expect(spawn.y).toBe(40);
    for (const spawn of result.spawns) expect(spawn.y).toBe(150);
  });

  it('spaces spawns out rather than returning every column', () => {
    const result = validateMap(streetMap(), 199, tune);
    const xs = result.spawns.map((s) => s.x).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(tune.spawnSpacingPx);
    }
  });
});

describe('connected components', () => {
  it('separates floating chunks from the main land mass', () => {
    const mask = new Mask(100, 100);
    fill(mask, 0, 60, 99, 99, 2);
    fill(mask, 10, 10, 19, 19, 1);
    const labels = labelSolidComponents(mask);
    expect(labels.componentCount).toBe(2);
    expect(labels.largestSize).toBe(100 * 40);
    expect(labels.isMainland(50, 80)).toBe(true);
    expect(labels.isMainland(15, 15)).toBe(false);
    expect(labels.isMainland(50, 10)).toBe(false);
  });

  it('joins chunks that touch only at a corner', () => {
    const mask = new Mask(10, 10);
    mask.set(2, 2, 2);
    mask.set(3, 3, 2);
    const labels = labelSolidComponents(mask);
    expect(labels.componentCount).toBe(1);
    expect(labels.largestSize).toBe(2);
  });
});
