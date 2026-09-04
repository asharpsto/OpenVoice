import { describe, expect, it } from 'vitest';
import { BROADPHASE_CELL_SIZE, Mask } from '../src/terrain/mask.js';
import { EMPTY } from '../src/terrain/materials.js';
import { maskFromAscii, maskToAscii } from './helpers.js';

describe('mask', () => {
  it('starts empty', () => {
    const mask = new Mask(10, 8);
    expect(mask.data.length).toBe(80);
    expect(mask.solidPixels).toBe(0);
    expect(mask.solidFraction).toBe(0);
    expect(mask.at(5, 5)).toBe(EMPTY);
  });

  it('rejects dimensions and data that do not agree', () => {
    expect(() => new Mask(0, 10)).toThrow();
    expect(() => new Mask(10, 10, new Uint8Array(99))).toThrow(/does not match/);
    expect(() => new Mask(2.5, 10)).toThrow();
  });

  it('keeps the solid count in step with writes', () => {
    const mask = new Mask(4, 4);
    mask.set(1, 1, 2);
    expect(mask.solidPixels).toBe(1);
    mask.set(1, 1, 3); // material change, still one solid pixel
    expect(mask.solidPixels).toBe(1);
    expect(mask.at(1, 1)).toBe(3);
    mask.set(1, 1, 0);
    expect(mask.solidPixels).toBe(0);
    mask.set(1, 1, 0); // no-op
    expect(mask.solidPixels).toBe(0);
  });

  it('ignores writes outside the map', () => {
    const mask = new Mask(4, 4);
    mask.set(-1, 0, 2);
    mask.set(0, 4, 2);
    expect(mask.solidPixels).toBe(0);
  });

  it('refuses a material ID that is not one', () => {
    const mask = new Mask(4, 4);
    expect(() => mask.set(0, 0, 9 as 1)).toThrow(/Not a material ID/);
  });

  it('tracks the broadphase grid per cell', () => {
    const mask = new Mask(40, 40);
    expect(mask.cellsX).toBe(Math.ceil(40 / BROADPHASE_CELL_SIZE));
    expect(mask.cellOccupied(0, 0)).toBe(false);

    mask.set(3, 3, 2);
    expect(mask.cellOccupied(0, 0)).toBe(true);
    expect(mask.cellSolidCount(0, 0)).toBe(1);
    expect(mask.cellOccupied(1, 0)).toBe(false);

    mask.set(BROADPHASE_CELL_SIZE, 0, 2);
    expect(mask.cellOccupied(1, 0)).toBe(true);

    mask.set(3, 3, 0);
    expect(mask.cellOccupied(0, 0)).toBe(false);
  });

  it('reports no occupancy outside the grid', () => {
    const mask = new Mask(16, 16);
    mask.set(0, 0, 2);
    expect(mask.cellOccupied(-1, 0)).toBe(false);
    expect(mask.cellOccupied(0, 99)).toBe(false);
    expect(mask.cellSolidCount(-1, -1)).toBe(0);
  });

  it('clones without sharing pixels', () => {
    const mask = maskFromAscii(['12', '34']);
    const copy = mask.clone();
    copy.set(0, 0, 5);
    expect(mask.at(0, 0)).toBe(1);
    expect(copy.at(0, 0)).toBe(5);
    expect(copy.solidPixels).toBe(4);
  });

  it('round-trips through ASCII fixtures', () => {
    const rows = ['.12.', '345.', '....'];
    expect(maskToAscii(maskFromAscii(rows))).toEqual(rows);
  });

  it('reports the solid fraction over the whole map', () => {
    const mask = maskFromAscii(['22', '..']);
    expect(mask.solidFraction).toBe(0.5);
  });
});
