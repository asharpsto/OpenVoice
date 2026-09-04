import { describe, expect, it } from 'vitest';
import { Mask } from '../src/terrain/mask.js';
import { EMPTY } from '../src/terrain/materials.js';
import { despeckle, floodFill, stampBrush, strokeBrush, thresholdSeed } from '../tools/masktool/ops.js';
import { maskFromAscii, maskToAscii } from './helpers.js';

function rgba(rows: Array<Array<[number, number, number]>>): {
  data: Uint8Array;
  width: number;
  height: number;
} {
  const height = rows.length;
  const width = rows[0].length;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rows[y][x];
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

const SKY: [number, number, number] = [200, 210, 220];
const WALL: [number, number, number] = [120, 112, 104];

describe('threshold seed', () => {
  it('calls bright pixels above the horizon sky and everything else solid', () => {
    const photo = rgba([
      [SKY, SKY, SKY, SKY],
      [SKY, WALL, WALL, SKY],
      [WALL, WALL, WALL, WALL],
      [WALL, WALL, WALL, WALL],
    ]);
    const mask = thresholdSeed(photo.data, photo.width, photo.height, {
      brightness: 160,
      horizon: 0.5,
      material: 2,
    });
    expect(maskToAscii(mask)).toEqual(['....', '.22.', '2222', '2222']);
  });

  it('leaves bright pixels below the horizon solid — a lit wall is not sky', () => {
    const photo = rgba([
      [SKY, SKY],
      [SKY, SKY],
    ]);
    const mask = thresholdSeed(photo.data, photo.width, photo.height, {
      brightness: 160,
      horizon: 0.5,
      material: 1,
    });
    expect(maskToAscii(mask)).toEqual(['..', '11']);
  });

  it('produces the pinholes it is expected to produce', () => {
    // Sky showing between branches. The seed cannot help this; despeckle is
    // what fixes it, and that is the point of the two being separate steps.
    const photo = rgba([
      [SKY, WALL, SKY, WALL, SKY],
      [WALL, SKY, WALL, SKY, WALL],
    ]);
    const mask = thresholdSeed(photo.data, photo.width, photo.height, {
      brightness: 160,
      horizon: 1,
      material: 3,
    });
    expect(mask.solidPixels).toBe(5);
  });
});

describe('flood fill', () => {
  it('fills the contiguous region sharing the seed material', () => {
    const mask = maskFromAscii(['..2..', '..2..', '.....']);
    floodFill(mask, 0, 0, 1);
    expect(maskToAscii(mask)).toEqual(['11211', '11211', '11111']);
  });

  it('cannot leak across something already painted', () => {
    const mask = maskFromAscii(['22222', '2...2', '22222']);
    floodFill(mask, 2, 1, 3);
    expect(maskToAscii(mask)).toEqual(['22222', '23332', '22222']);
  });

  it('is a no-op when the seed already holds the target material', () => {
    const mask = maskFromAscii(['22', '22']);
    const rect = floodFill(mask, 0, 0, 2);
    expect(rect.width).toBe(0);
    expect(maskToAscii(mask)).toEqual(['22', '22']);
  });

  it('ignores a seed outside the map', () => {
    const mask = maskFromAscii(['..', '..']);
    expect(floodFill(mask, -1, 0, 2).width).toBe(0);
    expect(mask.solidPixels).toBe(0);
  });

  it('follows the photograph when given a tolerance', () => {
    // A road that darkens across the frame, against a wall that does not.
    const photo = rgba([
      [
        [100, 100, 100],
        [104, 104, 104],
        [180, 170, 160],
        [182, 172, 162],
      ],
    ]);
    const mask = new Mask(4, 1);
    floodFill(mask, 0, 0, 2, { photo: photo.data, tolerance: 10 });
    expect(maskToAscii(mask)).toEqual(['22..']);
  });

  it('reports the rect it touched', () => {
    const mask = maskFromAscii(['22222', '2...2', '2...2', '22222']);
    const rect = floodFill(mask, 2, 1, 3);
    expect(rect).toEqual({ x: 1, y: 1, width: 3, height: 2 });
  });

  it('fills a large region without overflowing the stack', () => {
    const mask = new Mask(600, 600);
    const rect = floodFill(mask, 300, 300, 2);
    expect(mask.solidPixels).toBe(600 * 600);
    expect(rect).toEqual({ x: 0, y: 0, width: 600, height: 600 });
  });
});

describe('despeckle', () => {
  it('closes the pinholes a threshold pass leaves in a hedge', () => {
    const mask = maskFromAscii([
      '3333333',
      '3.33.33',
      '3333333',
      '33.3333',
      '3333333',
    ]);
    const filled = despeckle(mask, 1);
    expect(filled).toBe(3);
    expect(maskToAscii(mask)).toEqual([
      '3333333',
      '3333333',
      '3333333',
      '3333333',
      '3333333',
    ]);
  });

  it('gives a filled pixel the material of its neighbours', () => {
    const mask = maskFromAscii(['111', '1.1', '111']);
    despeckle(mask, 1);
    expect(mask.at(1, 1)).toBe(1);
  });

  it('leaves real sky alone', () => {
    // A gap far wider than the structuring element is a gap, not a pinhole.
    const mask = maskFromAscii([
      '22.....22',
      '22.....22',
      '22.....22',
      '22.....22',
      '22.....22',
    ]);
    const before = maskToAscii(mask);
    expect(despeckle(mask, 1)).toBe(0);
    expect(maskToAscii(mask)).toEqual(before);
  });

  it('does not thicken the silhouette it closes', () => {
    // Close = dilate then erode, so the outline must come back where it was.
    const mask = maskFromAscii([
      '.......',
      '..222..',
      '..2.2..',
      '..222..',
      '.......',
    ]);
    despeckle(mask, 1);
    expect(maskToAscii(mask)).toEqual([
      '.......',
      '..222..',
      '..222..',
      '..222..',
      '.......',
    ]);
  });

  it('does nothing at radius zero', () => {
    const mask = maskFromAscii(['2.2']);
    expect(despeckle(mask, 0)).toBe(0);
  });
});

describe('brush', () => {
  it('stamps a circle', () => {
    const mask = new Mask(7, 7);
    stampBrush(mask, 3.5, 3.5, 2, 4);
    expect(maskToAscii(mask)).toEqual([
      '.......',
      '...4...',
      '..444..',
      '.44444.',
      '..444..',
      '...4...',
      '.......',
    ]);
  });

  it('erases with the empty material', () => {
    const mask = new Mask(5, 5);
    stampBrush(mask, 2.5, 2.5, 3, 2);
    stampBrush(mask, 2.5, 2.5, 1.5, EMPTY as 0);
    expect(mask.at(2, 2)).toBe(EMPTY);
    expect(mask.at(0, 2)).toBe(2);
  });

  it('clips at the map edge instead of wrapping', () => {
    const mask = new Mask(5, 5);
    const rect = stampBrush(mask, 0, 0, 2, 2);
    expect(rect.x).toBe(0);
    expect(rect.y).toBe(0);
    expect(mask.at(4, 4)).toBe(EMPTY);
  });

  it('leaves no gaps along a fast drag', () => {
    const mask = new Mask(64, 8);
    strokeBrush(mask, 2, 4, 60, 4, 1.5, 2);
    for (let x = 3; x <= 59; x++) {
      expect(mask.at(x, 4), `gap at x=${x}`).toBe(2);
    }
  });

  it('reports a rect covering the whole stroke', () => {
    const mask = new Mask(64, 64);
    const rect = strokeBrush(mask, 10, 10, 50, 40, 3, 2);
    expect(rect.x).toBeLessThanOrEqual(7);
    expect(rect.y).toBeLessThanOrEqual(7);
    expect(rect.x + rect.width).toBeGreaterThanOrEqual(53);
    expect(rect.y + rect.height).toBeGreaterThanOrEqual(43);
  });
});
