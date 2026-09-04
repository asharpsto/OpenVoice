import { describe, expect, it } from 'vitest';
import {
  MAX_LONG_EDGE,
  downscaleMask,
  ingestSize,
  maskFromRgba,
  maskToRgba,
} from '../src/terrain/ingest.js';
import { Mask } from '../src/terrain/mask.js';
import { maskFromAscii, mulberry32 } from './helpers.js';

function rgbaFromIds(ids: number[], width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    out[i * 4] = ids[i];
    out[i * 4 + 1] = ids[i];
    out[i * 4 + 2] = ids[i];
    out[i * 4 + 3] = 255;
  }
  return out;
}

describe('ingest size cap', () => {
  it('caps the long edge at 2048 and keeps the aspect ratio', () => {
    expect(ingestSize(4000, 3000)).toEqual({ width: 2048, height: 1536 });
    expect(ingestSize(3000, 4000)).toEqual({ width: 1536, height: 2048 });
    expect(ingestSize(6000, 6000)).toEqual({ width: 2048, height: 2048 });
  });

  it('leaves anything already within the cap alone', () => {
    expect(ingestSize(2048, 1536)).toEqual({ width: 2048, height: 1536 });
    expect(ingestSize(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it('never collapses an extreme aspect ratio to zero', () => {
    const size = ingestSize(8000, 3);
    expect(size.width).toBe(MAX_LONG_EDGE);
    expect(size.height).toBeGreaterThanOrEqual(1);
  });
});

describe('mask ingest', () => {
  it('downscales anything over 2048px', () => {
    const width = 2600;
    const height = 1300;
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        rgba[i] = y > height / 2 ? 2 : 0;
        rgba[i + 3] = 255;
      }
    }
    const mask = maskFromRgba(rgba, width, height);
    expect(mask.width).toBe(2048);
    expect(mask.height).toBe(1024);
    expect(mask.data.length).toBe(2048 * 1024);
    // Mask memory budget: one byte per pixel, under 4MB (SPEC §9).
    expect(mask.data.byteLength).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(mask.solidFraction).toBeGreaterThan(0.45);
    expect(mask.solidFraction).toBeLessThan(0.55);
  });

  it('reads the material ID out of the red channel', () => {
    const ids = [0, 1, 2, 3, 4, 5];
    const mask = maskFromRgba(rgbaFromIds(ids, 6, 1), 6, 1);
    expect(Array.from(mask.data)).toEqual(ids);
  });

  it('rejects values that are not material IDs rather than guessing', () => {
    const rgba = rgbaFromIds([0, 2, 200, 5], 4, 1);
    expect(() => maskFromRgba(rgba, 4, 1)).toThrow(/non-material values/);
  });

  it('round-trips through RGBA', () => {
    const mask = maskFromAscii(['.1234', '5.123', '45.12']);
    const back = maskFromRgba(maskToRgba(mask), mask.width, mask.height);
    expect(Array.from(back.data)).toEqual(Array.from(mask.data));
  });
});

describe('mask downscale', () => {
  it('never invents a material that was not in the block', () => {
    const rng = mulberry32(5);
    const src = new Mask(120, 90);
    for (let y = 0; y < 90; y++) {
      for (let x = 0; x < 120; x++) {
        // Only walls and poles, so an averaging filter would produce
        // vegetation and this test would catch it.
        src.set(x, y, rng() < 0.5 ? 1 : 5);
      }
    }
    const small = downscaleMask(src, { width: 40, height: 30 });
    for (const m of small.data) expect([1, 5]).toContain(m);
  });

  it('keeps solid regions solid — a downscale must not punch pinholes', () => {
    const src = new Mask(100, 100);
    for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) src.set(x, y, 2);
    const small = downscaleMask(src, { width: 25, height: 25 });
    expect(small.solidPixels).toBe(25 * 25);
  });

  it('takes the majority of each block', () => {
    // Left half hedge, right half wall, scaled 4:1.
    const src = new Mask(8, 4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 8; x++) src.set(x, y, x < 4 ? 3 : 1);
    }
    const small = downscaleMask(src, { width: 2, height: 1 });
    expect(Array.from(small.data)).toEqual([3, 1]);
  });

  it('refuses to upscale', () => {
    const src = new Mask(4, 4);
    expect(() => downscaleMask(src, { width: 8, height: 8 })).toThrow(/only shrinks/);
  });

  it('rebuilds the broadphase for the downscaled mask', () => {
    const src = new Mask(64, 64);
    for (let y = 32; y < 64; y++) for (let x = 0; x < 64; x++) src.set(x, y, 2);
    const small = downscaleMask(src, { width: 32, height: 32 });
    expect(small.cellOccupied(0, 0)).toBe(false);
    expect(small.cellOccupied(0, 1)).toBe(true);
    expect(small.solidPixels).toBe(32 * 16);
  });
});
