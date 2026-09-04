import { describe, expect, it } from 'vitest';
import { Mask, BROADPHASE_CELL_SIZE } from '../src/terrain/mask.js';
import { EMPTY } from '../src/terrain/materials.js';
import { isSolidAt, materialAt, raycast } from '../src/terrain/query.js';
import { maskFromAscii, mulberry32 } from './helpers.js';

const STEP = 0.25;

describe('point query', () => {
  it('matches the mask byte at every pixel', () => {
    const rng = mulberry32(11);
    const mask = new Mask(70, 50);
    for (let y = 0; y < 50; y++) {
      for (let x = 0; x < 70; x++) {
        if (rng() < 0.5) mask.set(x, y, ((1 + Math.floor(rng() * 5)) as 1 | 2 | 3 | 4 | 5));
      }
    }
    for (let y = 0; y < mask.height; y++) {
      for (let x = 0; x < mask.width; x++) {
        expect(materialAt(mask, x, y)).toBe(mask.data[y * mask.width + x]);
        // Sub-pixel positions floor into the same pixel.
        expect(materialAt(mask, x + 0.5, y + 0.99)).toBe(mask.data[y * mask.width + x]);
      }
    }
  });

  it('treats everything outside the map as empty — the world ends, it is not walled', () => {
    const mask = maskFromAscii(['22', '22']);
    expect(materialAt(mask, -1, 0)).toBe(EMPTY);
    expect(materialAt(mask, 0, -1)).toBe(EMPTY);
    expect(materialAt(mask, 2, 0)).toBe(EMPTY);
    expect(materialAt(mask, 0, 2)).toBe(EMPTY);
    expect(isSolidAt(mask, 1, 1)).toBe(true);
  });
});

describe('raycast', () => {
  /** A 2px-thick fence standing in open sky, the classic tunnelling case. */
  function fenceMap(): Mask {
    const mask = new Mask(400, 64);
    for (let y = 0; y < 64; y++) {
      mask.set(200, y, 5);
      mask.set(201, y, 5);
    }
    return mask;
  }

  it('does not tunnel through 2px terrain at any speed', () => {
    const mask = fenceMap();
    // A whole frame of flight in one segment, far faster than any real shot.
    for (const speed of [50, 120, 399, 800, 5000]) {
      const hit = raycast(mask, 0, 32, speed, 32, { stepPx: STEP });
      if (speed <= 199) {
        expect(hit, `speed ${speed} should stop short of the fence`).toBeNull();
      } else {
        expect(hit, `speed ${speed} tunnelled through the fence`).not.toBeNull();
        expect(hit?.pixelX).toBe(200);
      }
    }
  });

  it('does not tunnel through a 2px floor on a steep descent', () => {
    const mask = new Mask(64, 400);
    for (let x = 0; x < 64; x++) {
      mask.set(x, 300, 2);
      mask.set(x, 301, 2);
    }
    const hit = raycast(mask, 5, 0, 60, 399, { stepPx: STEP });
    expect(hit).not.toBeNull();
    expect(hit?.pixelY).toBe(300);
  });

  it('reports the first hit, not just any hit', () => {
    const mask = maskFromAscii([
      '..........',
      '..1....3..',
      '..........',
    ]);
    const hit = raycast(mask, 0.5, 1.5, 9.5, 1.5, { stepPx: STEP });
    expect(hit?.pixelX).toBe(2);
    expect(hit?.material).toBe(1);
    const back = raycast(mask, 9.5, 1.5, 0.5, 1.5, { stepPx: STEP });
    expect(back?.pixelX).toBe(7);
    expect(back?.material).toBe(3);
  });

  it('returns null across open sky', () => {
    const mask = fenceMap();
    expect(raycast(mask, 0, 0, 190, 60, { stepPx: STEP })).toBeNull();
  });

  it('hits immediately when it starts inside terrain', () => {
    const mask = maskFromAscii(['222', '222']);
    const hit = raycast(mask, 1.5, 1.5, 2.5, 1.5, { stepPx: STEP });
    expect(hit?.t).toBe(0);
    expect(hit?.distance).toBe(0);
  });

  it('gives the same answer with the broadphase as without it', () => {
    const rng = mulberry32(2024);
    const mask = new Mask(256, 192);
    // Lumpy terrain with plenty of empty cells to skip.
    for (let x = 0; x < 256; x++) {
      const top = 96 + Math.floor(Math.sin(x / 17) * 30 + rng() * 6);
      for (let y = top; y < 192; y++) mask.set(x, y, 2);
    }
    for (let i = 0; i < 40; i++) {
      const cx = Math.floor(rng() * 240) + 8;
      const cy = Math.floor(rng() * 60) + 10;
      for (let y = cy; y < cy + 6; y++) for (let x = cx; x < cx + 6; x++) mask.set(x, y, 1);
    }

    let hits = 0;
    for (let i = 0; i < 600; i++) {
      const x0 = rng() * 300 - 20;
      const y0 = rng() * 240 - 20;
      const x1 = rng() * 300 - 20;
      const y1 = rng() * 240 - 20;
      const withGrid = raycast(mask, x0, y0, x1, y1, { stepPx: STEP, useBroadphase: true });
      const without = raycast(mask, x0, y0, x1, y1, { stepPx: STEP, useBroadphase: false });
      expect(withGrid, `ray ${i}: ${x0},${y0} -> ${x1},${y1}`).toEqual(without);
      if (withGrid) hits++;
    }
    // Guard the guard: a fuzz run that only ever hits, or only ever misses,
    // would pass this test while exercising half the code.
    expect(hits).toBeGreaterThan(100);
    expect(hits).toBeLessThan(595);
  });

  it('skips empty cells rather than sampling them', () => {
    const mask = new Mask(1024, 64);
    for (let y = 0; y < 64; y++) mask.set(1000, y, 2);
    let sampled = 0;
    const counting = new Proxy(mask, {
      get(target, prop, receiver) {
        if (prop === 'at') {
          return (x: number, y: number) => {
            sampled++;
            return target.at(x, y);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    raycast(counting as Mask, 0, 32, 1023, 32, { stepPx: STEP });
    // 1000px at 0.25px steps is 4000 samples without a broadphase; cells are
    // 16px wide, so skipping empty sky should cost roughly one sample each.
    expect(sampled).toBeLessThan(300);
    expect(mask.cellOccupied(1000 / BROADPHASE_CELL_SIZE, 0)).toBe(true);
  });
});
