import { MAX_MATERIAL_ID, type MaterialId } from './materials.js';
import { Mask } from './mask.js';

/**
 * Long edge cap (CLAUDE.md, SPEC §5.3). A phone photo is 4000x3000: unbounded
 * that is a 12MB mask and a 48MB texture on a mid-range Android.
 */
export const MAX_LONG_EDGE = 2048;

export interface Size {
  width: number;
  height: number;
}

/**
 * Canonical mask image encoding: the red channel holds the material ID
 * (0..5) and the other channels are ignored. The baker writes R=G=B=id so a
 * mask opens as a near-black image whose pixel values are exact — no palette
 * round-trip, nothing to drift.
 */
export const MASK_ID_CHANNEL = 0;

/** Size after applying the long-edge cap, preserving aspect ratio. */
export function ingestSize(width: number, height: number, maxLongEdge = MAX_LONG_EDGE): Size {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdge) return { width, height };
  const scale = maxLongEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Decodes RGBA bytes into a mask, downscaling if the long edge is over the cap.
 *
 * Throws on any red-channel value that is not a material ID: a mask with
 * stray values is a mask that was saved through something lossy, and finding
 * that out here is much cheaper than finding it out as a monkey falling
 * through a hedge.
 */
export function maskFromRgba(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  maxLongEdge = MAX_LONG_EDGE,
): Mask {
  const pixels = width * height;
  if (rgba.length < pixels * 4) {
    throw new Error(`RGBA buffer too small: ${rgba.length} bytes for ${width}x${height}`);
  }
  const data = new Uint8Array(pixels);
  const offenders = new Set<number>();
  for (let i = 0; i < pixels; i++) {
    const value = rgba[i * 4 + MASK_ID_CHANNEL];
    if (value > MAX_MATERIAL_ID) {
      if (offenders.size < 8) offenders.add(value);
      continue;
    }
    data[i] = value;
  }
  if (offenders.size > 0) {
    throw new Error(
      `Mask contains non-material values in the red channel: ${[...offenders].join(', ')}` +
        ` (legal IDs are 0..${MAX_MATERIAL_ID})`,
    );
  }
  const full = new Mask(width, height, data);
  const target = ingestSize(width, height, maxLongEdge);
  return target.width === width && target.height === height ? full : downscaleMask(full, target);
}

/**
 * Downscales a mask by majority vote over each source block.
 *
 * Never interpolate a mask: averaging material 1 and material 5 gives
 * material 3, which would be a hedge that used to be a wall. Ties go to the
 * block's centre sample, which keeps the result stable and unbiased —
 * favouring solids would dilate terrain, favouring empty would punch pinholes,
 * and pinholes are the exact failure mode that killed auto-segmentation
 * (SPEC §5.2).
 */
export function downscaleMask(mask: Mask, target: Size): Mask {
  const { width, height, data } = mask;
  if (target.width > width || target.height > height) {
    throw new Error(
      `downscaleMask only shrinks: ${width}x${height} -> ${target.width}x${target.height}`,
    );
  }
  const out = new Uint8Array(target.width * target.height);
  const counts = new Uint32Array(MAX_MATERIAL_ID + 1);

  for (let ty = 0; ty < target.height; ty++) {
    const sy0 = Math.floor((ty * height) / target.height);
    const sy1 = Math.max(sy0 + 1, Math.floor(((ty + 1) * height) / target.height));
    for (let tx = 0; tx < target.width; tx++) {
      const sx0 = Math.floor((tx * width) / target.width);
      const sx1 = Math.max(sx0 + 1, Math.floor(((tx + 1) * width) / target.width));
      counts.fill(0);
      for (let sy = sy0; sy < sy1; sy++) {
        const row = sy * width;
        for (let sx = sx0; sx < sx1; sx++) counts[data[row + sx]]++;
      }
      const centre = data[((sy0 + sy1 - 1) >> 1) * width + ((sx0 + sx1 - 1) >> 1)];
      let best = 0;
      let bestCount = -1;
      for (let m = 0; m <= MAX_MATERIAL_ID; m++) {
        const c = counts[m];
        if (c > bestCount || (c === bestCount && m === centre)) {
          best = m;
          bestCount = c;
        }
      }
      out[ty * target.width + tx] = best;
    }
  }
  return new Mask(target.width, target.height, out);
}

/** Downscales an RGBA photo by box average. Colour may be interpolated; masks may not. */
export function downscaleRgba(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  target: Size,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(target.width * target.height * 4);
  for (let ty = 0; ty < target.height; ty++) {
    const sy0 = Math.floor((ty * height) / target.height);
    const sy1 = Math.max(sy0 + 1, Math.floor(((ty + 1) * height) / target.height));
    for (let tx = 0; tx < target.width; tx++) {
      const sx0 = Math.floor((tx * width) / target.width);
      const sx1 = Math.max(sx0 + 1, Math.floor(((tx + 1) * width) / target.width));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * width + sx) * 4;
          r += rgba[i];
          g += rgba[i + 1];
          b += rgba[i + 2];
          a += rgba[i + 3];
        }
      }
      const n = (sy1 - sy0) * (sx1 - sx0);
      const o = (ty * target.width + tx) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return out;
}

/** Encodes a mask back to RGBA (R=G=B=id, opaque) for saving or previewing. */
export function maskToRgba(mask: Mask): Uint8ClampedArray {
  const out = new Uint8ClampedArray(mask.width * mask.height * 4);
  for (let i = 0; i < mask.data.length; i++) {
    const m = mask.data[i] as MaterialId;
    out[i * 4] = m;
    out[i * 4 + 1] = m;
    out[i * 4 + 2] = m;
    out[i * 4 + 3] = 255;
  }
  return out;
}
