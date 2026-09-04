import { describe, expect, it } from 'vitest';
import { explode } from '../src/terrain/destroy.js';
import { Mask } from '../src/terrain/mask.js';
import { buildMaskPatch, maskPatchByteLength, MASK_TEXTURE_CHANNELS } from '../src/terrain/patch.js';
import type { Rect } from '../src/terrain/rect.js';
import { maskFromAscii, mulberry32, tuneFixture } from './helpers.js';

const RIM = 4;

function materialChannel(patch: Uint8Array, rect: Rect): number[] {
  const out: number[] = [];
  for (let i = 0; i < rect.width * rect.height; i++) out.push(patch[i * MASK_TEXTURE_CHANNELS]);
  return out;
}

function shadeAt(patch: Uint8Array, rect: Rect, x: number, y: number): number {
  const i = ((y - rect.y) * rect.width + (x - rect.x)) * MASK_TEXTURE_CHANNELS;
  return patch[i + 1];
}

function cratered(seed: number, width = 96, height = 72): Mask {
  const rng = mulberry32(seed);
  const mask = new Mask(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rng() < 0.85) mask.set(x, y, ((1 + Math.floor(rng() * 5)) as 1 | 2 | 3 | 4 | 5));
    }
  }
  const tune = tuneFixture();
  for (let i = 0; i < 6; i++) explode(mask, rng() * width, rng() * height, 3 + rng() * 9, tune);
  return mask;
}

describe('mask texture patch', () => {
  it('puts the material ID in the red channel, unchanged', () => {
    const mask = maskFromAscii(['.12', '345', '..1']);
    const rect = { x: 0, y: 0, width: 3, height: 3 };
    const patch = buildMaskPatch(mask, rect, 0);
    expect(patch.length).toBe(maskPatchByteLength(rect));
    expect(materialChannel(patch, rect)).toEqual(Array.from(mask.data));
  });

  it('reads only the requested rect', () => {
    const mask = maskFromAscii(['1111', '1221', '1221', '1111']);
    const rect = { x: 1, y: 1, width: 2, height: 2 };
    expect(materialChannel(buildMaskPatch(mask, rect, 0), rect)).toEqual([2, 2, 2, 2]);
  });

  it('leaves empty pixels unshaded', () => {
    const mask = maskFromAscii(['..2..', '.222.', '22222']);
    const rect = mask.bounds;
    const patch = buildMaskPatch(mask, rect, RIM);
    expect(shadeAt(patch, rect, 0, 0)).toBe(0);
    expect(shadeAt(patch, rect, 4, 0)).toBe(0);
  });

  it('applies no shade at all when the rim depth is zero', () => {
    const mask = cratered(3);
    const rect = mask.bounds;
    const patch = buildMaskPatch(mask, rect, 0);
    for (let i = 0; i < rect.width * rect.height; i++) expect(patch[i * 2 + 1]).toBe(0);
  });

  it('darkens hardest at the edge and fades to nothing rimDepth pixels in', () => {
    // A solid block with the top half of the map open above it.
    const mask = new Mask(24, 24);
    for (let y = 12; y < 24; y++) for (let x = 0; x < 24; x++) mask.set(x, y, 2);
    const rect = mask.bounds;
    const patch = buildMaskPatch(mask, rect, RIM);

    expect(shadeAt(patch, rect, 12, 12)).toBe(255);
    const profile = [0, 1, 2, 3, 4, 5].map((d) => shadeAt(patch, rect, 12, 12 + d));
    for (let i = 1; i < profile.length; i++) {
      expect(profile[i]).toBeLessThan(profile[i - 1] || 256);
    }
    expect(profile[RIM + 1]).toBe(0);
    // The bottom row is shaded too: outside the map is empty, so that is an
    // edge as much as the top of the block is.
    expect(shadeAt(patch, rect, 12, 23)).toBe(255);
  });

  it('confines everything an explosion changes to the dirty rect', () => {
    // This is the correctness condition for uploading only the dirty rect: if
    // a single byte changed outside it, the screen would disagree with the
    // collision until something else happened to repaint that area.
    const mask = new Mask(64, 64);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) mask.set(x, y, 2);
    const before = buildMaskPatch(mask, mask.bounds, RIM);
    const result = explode(mask, 32, 32, 10, tuneFixture());
    const after = buildMaskPatch(mask, mask.bounds, RIM);

    let changed = 0;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const i = (y * 64 + x) * MASK_TEXTURE_CHANNELS;
        if (before[i] === after[i] && before[i + 1] === after[i + 1]) continue;
        changed++;
        const r = result.dirtyRect;
        expect(
          x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height,
          `pixel ${x},${y} changed outside the dirty rect`,
        ).toBe(true);
      }
    }
    expect(changed).toBeGreaterThan(result.clearedTotal);
    // And the rim really is dark right up against the hole.
    expect(shadeAt(after, mask.bounds, 32, result.clearedRect.y - 1)).toBe(255);
  });

  it('gives a dirty rect exactly the shade the whole map would have', () => {
    // The windowed distance transform is the load-bearing optimisation here: if
    // the window were too small, craters would show a seam at the rect border.
    const mask = cratered(17);
    const rng = mulberry32(99);
    const full = buildMaskPatch(mask, mask.bounds, RIM);
    for (let i = 0; i < 40; i++) {
      const rect: Rect = {
        x: Math.floor(rng() * 80),
        y: Math.floor(rng() * 60),
        width: 1 + Math.floor(rng() * 16),
        height: 1 + Math.floor(rng() * 12),
      };
      const patch = buildMaskPatch(mask, rect, RIM);
      for (let y = rect.y; y < rect.y + rect.height; y++) {
        for (let x = rect.x; x < rect.x + rect.width; x++) {
          expect(shadeAt(patch, rect, x, y), `rect ${JSON.stringify(rect)} at ${x},${y}`).toBe(
            shadeAt(full, mask.bounds, x, y),
          );
        }
      }
    }
  });

  it('shades terrain that runs off the map edge, since outside is empty', () => {
    const mask = new Mask(16, 16);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) mask.set(x, y, 2);
    const rect = mask.bounds;
    const patch = buildMaskPatch(mask, rect, RIM);
    expect(shadeAt(patch, rect, 0, 8)).toBe(255);
    expect(shadeAt(patch, rect, 8, 8)).toBe(0);
  });

  it('reuses a caller-supplied buffer without reallocating', () => {
    const mask = cratered(5, 32, 32);
    const rect = { x: 2, y: 2, width: 8, height: 8 };
    const scratch = new Uint8Array(4096);
    const patch = buildMaskPatch(mask, rect, RIM, scratch);
    expect(patch).toBe(scratch);
    const fresh = buildMaskPatch(mask, rect, RIM);
    expect(Array.from(scratch.subarray(0, maskPatchByteLength(rect)))).toEqual(Array.from(fresh));
  });
});
