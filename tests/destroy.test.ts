import { describe, expect, it } from 'vitest';
import { explode } from '../src/terrain/destroy.js';
import { Mask } from '../src/terrain/mask.js';
import { EMPTY, MAX_MATERIAL_ID } from '../src/terrain/materials.js';
import { maskFromAscii, mulberry32, tuneFixture } from './helpers.js';
import type { TerrainTune } from '../src/tune/terrain.js';

/**
 * Independent reference blit: every pixel of the map, no scan-rect bound, no
 * broadphase. If the optimised version disagrees anywhere, its bounds are
 * wrong.
 */
function referenceExplode(
  mask: Mask,
  cx: number,
  cy: number,
  radius: number,
  tune: TerrainTune,
): Uint8Array {
  const out = mask.data.slice();
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      const i = y * mask.width + x;
      const m = out[i];
      if (m === EMPTY) continue;
      const r = radius * tune.radiusScale[m];
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r * r) out[i] = EMPTY;
    }
  }
  return out;
}

function randomMask(seed: number, width: number, height: number): Mask {
  const rng = mulberry32(seed);
  const mask = new Mask(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const r = rng();
      if (r < 0.35) continue;
      mask.set(x, y, ((Math.floor(rng() * MAX_MATERIAL_ID) + 1) as 1 | 2 | 3 | 4 | 5));
    }
  }
  return mask;
}

describe('explosion', () => {
  const tune = tuneFixture();

  it('clears exactly the pixels the material distribution says it should', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const rng = mulberry32(seed * 977);
      const mask = randomMask(seed, 64, 48);
      const expected = new Mask(mask.width, mask.height, mask.data.slice());
      const cx = rng() * 80 - 8;
      const cy = rng() * 64 - 8;
      const radius = 2 + rng() * 14;

      const reference = referenceExplode(expected, cx, cy, radius, tune);
      explode(mask, cx, cy, radius, tune);

      expect(Array.from(mask.data), `seed ${seed}`).toEqual(Array.from(reference));
    }
  });

  it('scales the crater per material: a hedge opens up where a wall chips', () => {
    const wall = new Mask(64, 64);
    const hedge = new Mask(64, 64);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        wall.set(x, y, 1);
        hedge.set(x, y, 3);
      }
    }
    const wallResult = explode(wall, 32, 32, 10, tune);
    const hedgeResult = explode(hedge, 32, 32, 10, tune);

    // building resistance 2 -> radius 5; vegetation 0.5 -> radius 20.
    expect(hedgeResult.clearedTotal).toBeGreaterThan(wallResult.clearedTotal * 10);
    expect(wallResult.clearedByMaterial[1]).toBe(wallResult.clearedTotal);
    expect(hedgeResult.clearedByMaterial[3]).toBe(hedgeResult.clearedTotal);
  });

  it('reports a dirty rect that covers every changed pixel, plus the rim', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const rng = mulberry32(seed * 31);
      const mask = randomMask(seed + 100, 96, 72);
      const before = mask.data.slice();
      const result = explode(mask, rng() * 96, rng() * 72, 3 + rng() * 12, tune);
      if (result.clearedTotal === 0) continue;

      for (let y = 0; y < mask.height; y++) {
        for (let x = 0; x < mask.width; x++) {
          const i = y * mask.width + x;
          if (before[i] === mask.data[i]) continue;
          const r = result.clearedRect;
          expect(x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height).toBe(true);
        }
      }
      // The rim shade reaches further than the hole itself.
      expect(result.dirtyRect.width).toBeGreaterThanOrEqual(result.clearedRect.width);
      expect(result.dirtyRect.height).toBeGreaterThanOrEqual(result.clearedRect.height);
    }
  });

  it('keeps the broadphase grid exact through destruction', () => {
    const mask = randomMask(7, 100, 80);
    const rng = mulberry32(4242);
    for (let i = 0; i < 25; i++) {
      explode(mask, rng() * 100, rng() * 80, 2 + rng() * 10, tune);
    }
    const observed: number[] = [];
    for (let cy = 0; cy < mask.cellsY; cy++) {
      for (let cx = 0; cx < mask.cellsX; cx++) observed.push(mask.cellSolidCount(cx, cy));
    }
    const solidBefore = mask.solidPixels;

    mask.rebuildBroadphase();
    const rebuilt: number[] = [];
    for (let cy = 0; cy < mask.cellsY; cy++) {
      for (let cx = 0; cx < mask.cellsX; cx++) rebuilt.push(mask.cellSolidCount(cx, cy));
    }
    expect(observed).toEqual(rebuilt);
    expect(solidBefore).toBe(mask.solidPixels);
  });

  it('is deterministic: same state and inputs, identical outcome', () => {
    const a = randomMask(9, 80, 60);
    const b = randomMask(9, 80, 60);
    const shots: Array<[number, number, number]> = [
      [10.25, 12.5, 9],
      [40, 30, 14.75],
      [79.5, 59.5, 20],
      [-3, 25, 12],
    ];
    for (const [x, y, r] of shots) {
      const ra = explode(a, x, y, r, tune);
      const rb = explode(b, x, y, r, tune);
      expect(ra).toEqual(rb);
    }
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  it('does nothing outside the map and nothing to sky', () => {
    const mask = maskFromAscii([
      '........',
      '........',
      '..2222..',
      '..2222..',
    ]);
    const before = mask.data.slice();
    const miss = explode(mask, -50, -50, 10, tune);
    expect(miss.clearedTotal).toBe(0);
    expect(miss.dirtyRect.width).toBe(0);
    expect(Array.from(mask.data)).toEqual(Array.from(before));

    const sky = explode(mask, 4, 0.5, 1, tune);
    expect(sky.clearedTotal).toBe(0);
  });

  it('clears a partial circle at the map edge without wrapping', () => {
    const mask = new Mask(32, 32);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) mask.set(x, y, 2);
    explode(mask, 0, 0, 6, tune);
    expect(mask.at(0, 0)).toBe(EMPTY);
    expect(mask.at(31, 31)).toBe(2);
    expect(mask.at(31, 0)).toBe(2);
    expect(mask.at(0, 31)).toBe(2);
  });
});
