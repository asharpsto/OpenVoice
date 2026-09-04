import { Mask } from '../../src/terrain/mask.js';
import { EMPTY, MAX_MATERIAL_ID, type MaterialId } from '../../src/terrain/materials.js';
import { EMPTY_RECT, union, type Rect } from '../../src/terrain/rect.js';

/**
 * Mask editing operations for the paint tool (SPEC §5.2).
 *
 * These are deterministic and they decide what the collision looks like, so
 * they are tested. The tool's UI around them is not.
 *
 * None of this ships in the game bundle — nothing under /src imports it.
 */

export interface ThresholdSeedOptions {
  /** Luma above this counts as sky, 0..255. Overcast sky is around 180. */
  brightness: number;
  /**
   * Fraction of the image height below which nothing is sky, 0..1. This is the
   * "position" half of the threshold: a light grey wall low in the frame stays
   * solid where the same grey high in the frame does not.
   */
  horizon: number;
  /** What solid pixels start as; the painter reassigns from there. */
  material: MaterialId;
}

/**
 * The auto first pass: brightness plus position (SPEC §5.2).
 *
 * This is a seed, not a segmentation. It is wrong wherever the sky is dark or
 * the building is bright, and it will pinhole any tree it meets — which is
 * exactly why the tool exists and why the painter follows it. Do not grow this
 * into auto-segmentation; that decision is made (CLAUDE.md).
 */
export function thresholdSeed(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  options: ThresholdSeedOptions,
): Mask {
  const data = new Uint8Array(width * height);
  const horizonY = options.horizon * height;
  for (let y = 0; y < height; y++) {
    const skyPossible = y < horizonY;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (skyPossible) {
        const i = (row + x) * 4;
        // Rec. 601 luma; sky is bright before it is any particular colour.
        const luma = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
        if (luma > options.brightness) continue;
      }
      data[row + x] = options.material;
    }
  }
  return new Mask(width, height, data);
}

export interface FloodFillOptions {
  /**
   * Photo pixels, when the fill should follow the photograph rather than the
   * mask. Filling "the road" in one click needs the colour; filling a region
   * already painted does not.
   */
  photo?: Uint8Array | Uint8ClampedArray;
  /** Maximum per-channel difference from the seed colour. Ignored without `photo`. */
  tolerance?: number;
}

/**
 * 4-connected flood fill from a seed pixel (SPEC §5.2).
 *
 * The region always stays within pixels matching the seed's *material*, so a
 * fill can never leak across something already painted. With a photo and a
 * tolerance it additionally stays within pixels close to the seed's colour.
 */
export function floodFill(
  mask: Mask,
  seedX: number,
  seedY: number,
  material: MaterialId,
  options: FloodFillOptions = {},
): Rect {
  const { width, height, data } = mask;
  if (seedX < 0 || seedY < 0 || seedX >= width || seedY >= height) return EMPTY_RECT;
  const from = data[seedY * width + seedX];
  if (from === material) return EMPTY_RECT;

  const photo = options.photo;
  const tolerance = options.tolerance ?? 0;
  const seedIndex = seedY * width + seedX;
  const seedR = photo ? photo[seedIndex * 4] : 0;
  const seedG = photo ? photo[seedIndex * 4 + 1] : 0;
  const seedB = photo ? photo[seedIndex * 4 + 2] : 0;

  const matches = (index: number): boolean => {
    if (data[index] !== from) return false;
    if (!photo) return true;
    const i = index * 4;
    return (
      Math.abs(photo[i] - seedR) <= tolerance &&
      Math.abs(photo[i + 1] - seedG) <= tolerance &&
      Math.abs(photo[i + 2] - seedB) <= tolerance
    );
  };

  // Scanline fill: a queue of pixels would be millions of entries on a 2048px
  // map, and the tool has to feel instant.
  let minX = seedX;
  let maxX = seedX;
  let minY = seedY;
  let maxY = seedY;
  const stack: number[] = [seedX, seedY];
  while (stack.length > 0) {
    const y = stack.pop() as number;
    let x = stack.pop() as number;
    const row = y * width;
    while (x > 0 && matches(row + x - 1)) x--;
    let spanAbove = false;
    let spanBelow = false;
    for (; x < width && matches(row + x); x++) {
      mask.set(x, y, material);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (y > 0) {
        const above = matches(row - width + x);
        if (above && !spanAbove) {
          stack.push(x, y - 1);
          spanAbove = true;
        } else if (!above) spanAbove = false;
      }
      if (y + 1 < height) {
        const below = matches(row + width + x);
        if (below && !spanBelow) {
          stack.push(x, y + 1);
          spanBelow = true;
        } else if (!below) spanBelow = false;
      }
    }
  }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Morphological close over the solid set: dilate, then erode (SPEC §5.2).
 *
 * Kills the pinholes a threshold pass leaves in a tree, which are the whole
 * reason auto-segmentation was cut — a hedge full of one-pixel holes is a hedge
 * a banana flies straight through. Filled pixels take the material that most of
 * their neighbours are.
 *
 * Returns the number of pixels filled.
 */
export function despeckle(mask: Mask, radius = 2): number {
  if (radius < 1) return 0;
  const { width, height, data } = mask;
  const solid = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) solid[i] = data[i] === EMPTY ? 0 : 1;

  const dilated = boxMorph(solid, width, height, radius, true);
  const closed = boxMorph(dilated, width, height, radius, false);

  let filled = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (solid[i] === 1 || closed[i] === 0) continue;
      mask.set(x, y, majorityMaterial(mask, x, y, radius + 1));
      filled++;
    }
  }
  return filled;
}

/**
 * Separable dilate (`max`) or erode (`min`) with a square structuring element.
 * Two sliding windows rather than a (2r+1)^2 neighbourhood per pixel, because
 * this runs over three million pixels while someone waits for it.
 */
function boxMorph(
  src: Uint8Array,
  width: number,
  height: number,
  radius: number,
  dilate: boolean,
): Uint8Array {
  // Outside the map is empty, the same rule the mask itself follows. So a
  // window that hangs over the edge can never be full, and erosion pulls back
  // from the border — without that, dilate grows into the border and erode
  // cannot undo it, and a close near the edge thickens the silhouette.
  const span = radius * 2 + 1;
  const horizontal = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let count = 0;
    for (let x = 0; x <= radius && x < width; x++) count += src[row + x];
    for (let x = 0; x < width; x++) {
      horizontal[row + x] = (dilate ? count > 0 : count === span) ? 1 : 0;
      const leaving = x - radius;
      const entering = x + radius + 1;
      if (leaving >= 0) count -= src[row + leaving];
      if (entering < width) count += src[row + entering];
    }
  }

  const out = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    let count = 0;
    for (let y = 0; y <= radius && y < height; y++) count += horizontal[y * width + x];
    for (let y = 0; y < height; y++) {
      out[y * width + x] = (dilate ? count > 0 : count === span) ? 1 : 0;
      const leaving = y - radius;
      const entering = y + radius + 1;
      if (leaving >= 0) count -= horizontal[leaving * width + x];
      if (entering < height) count += horizontal[entering * width + x];
    }
  }
  return out;
}

/** The commonest solid material around a pixel. */
function majorityMaterial(mask: Mask, x: number, y: number, radius: number): MaterialId {
  const counts = new Uint32Array(MAX_MATERIAL_ID + 1);
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      counts[mask.at(x + dx, y + dy)]++;
    }
  }
  let best: MaterialId = 1;
  let bestCount = 0;
  for (let m = 1; m <= MAX_MATERIAL_ID; m++) {
    if (counts[m] > bestCount) {
      bestCount = counts[m];
      best = m as MaterialId;
    }
  }
  return best;
}

/** Circular brush stamp. Returns the rect it touched, for repainting. */
export function stampBrush(
  mask: Mask,
  centreX: number,
  centreY: number,
  radius: number,
  material: MaterialId,
): Rect {
  const x0 = Math.max(0, Math.floor(centreX - radius));
  const y0 = Math.max(0, Math.floor(centreY - radius));
  const x1 = Math.min(mask.width - 1, Math.ceil(centreX + radius));
  const y1 = Math.min(mask.height - 1, Math.ceil(centreY + radius));
  if (x1 < x0 || y1 < y0) return EMPTY_RECT;
  const r2 = radius * radius;
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - centreY;
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - centreX;
      if (dx * dx + dy * dy <= r2) mask.set(x, y, material);
    }
  }
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Brush stroke between two points, so a fast drag does not leave gaps. */
export function strokeBrush(
  mask: Mask,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  radius: number,
  material: MaterialId,
): Rect {
  const distance = Math.hypot(toX - fromX, toY - fromY);
  const steps = Math.max(1, Math.ceil(distance / Math.max(1, radius * 0.5)));
  let rect: Rect | null = null;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const stamped = stampBrush(
      mask,
      fromX + (toX - fromX) * t,
      fromY + (toY - fromY) * t,
      radius,
      material,
    );
    rect = rect === null ? stamped : union(rect, stamped);
  }
  return rect ?? EMPTY_RECT;
}
