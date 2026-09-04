import { Mask } from '../terrain/mask.js';
import { BUILDING, GROUND, POLE, VEGETATION, VEHICLE, type MaterialId } from '../terrain/materials.js';
import { mulberry32, rangeInt, type Rng } from '../core/rng.js';

/**
 * A stand-in map: a skyline of blocks over a street, with hedges, cars and
 * poles so every material is present.
 *
 * This is scaffolding for the dev harness and the benchmark, not a map. Real
 * maps are photographs with hand-painted masks (SPEC §5.2) and arrive in
 * stage 2 — nothing here should outlive that.
 */
export interface SyntheticMap {
  mask: Mask;
  /** Flat RGBA of the same size, standing in for the photograph. */
  photo: Uint8ClampedArray;
  waterLineY: number;
}

/**
 * Stand-in colours. Sky is deliberately much brighter than any solid material:
 * a real overcast sky reads around luma 190 where a rendered wall reads 140,
 * and a fixture where the two overlap tests nothing but the noise.
 */
const MATERIAL_COLOURS: Record<MaterialId, [number, number, number]> = {
  0: [178, 196, 212],
  1: [150, 142, 132],
  2: [116, 106, 96],
  3: [86, 112, 70],
  4: [96, 104, 122],
  5: [70, 70, 74],
};

export function buildSyntheticMap(width: number, height: number, seed = 1): SyntheticMap {
  const rng = mulberry32(seed);
  const mask = new Mask(width, height);
  const groundY = Math.floor(height * 0.72);

  fillRect(mask, 0, groundY, width, height - groundY, GROUND);
  addSkyline(mask, rng, width, groundY);

  const step = Math.max(48, Math.floor(width / 14));
  for (let x = step; x < width - step; x += step) {
    const roll = rng();
    if (roll < 0.4) {
      const w = rangeInt(rng, Math.floor(step * 0.4), Math.floor(step * 0.8));
      const h = rangeInt(rng, Math.floor(height * 0.03), Math.floor(height * 0.07));
      fillRect(mask, x, groundY - h, w, h, VEGETATION);
    } else if (roll < 0.7) {
      const w = rangeInt(rng, Math.floor(step * 0.5), Math.floor(step * 0.9));
      const h = Math.max(6, Math.floor(height * 0.035));
      fillRect(mask, x, groundY - h, w, h, VEHICLE);
    } else {
      const h = rangeInt(rng, Math.floor(height * 0.08), Math.floor(height * 0.16));
      fillRect(mask, x, groundY - h, Math.max(2, Math.floor(width / 400)), h, POLE);
    }
  }

  return { mask, photo: photoFromMask(mask, rng), waterLineY: height - 1 };
}

function addSkyline(mask: Mask, rng: Rng, width: number, groundY: number): void {
  let x = 0;
  while (x < width) {
    const w = rangeInt(rng, Math.floor(width * 0.06), Math.floor(width * 0.16));
    const h = rangeInt(rng, Math.floor(groundY * 0.2), Math.floor(groundY * 0.75));
    fillRect(mask, x, groundY - h, w, h, BUILDING);
    x += w + rangeInt(rng, 0, Math.floor(width * 0.05));
  }
}

function fillRect(
  mask: Mask,
  x0: number,
  y0: number,
  w: number,
  h: number,
  material: MaterialId,
): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) mask.set(x, y, material);
  }
}

/** Flat colour per material plus a little grain, so craters are visible. */
function photoFromMask(mask: Mask, rng: Rng): Uint8ClampedArray {
  const out = new Uint8ClampedArray(mask.width * mask.height * 4);
  for (let i = 0; i < mask.data.length; i++) {
    const [r, g, b] = MATERIAL_COLOURS[mask.data[i] as MaterialId];
    const n = (rng() - 0.5) * 26;
    out[i * 4] = r + n;
    out[i * 4 + 1] = g + n;
    out[i * 4 + 2] = b + n;
    out[i * 4 + 3] = 255;
  }
  return out;
}
