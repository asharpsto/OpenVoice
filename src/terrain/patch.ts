import { EMPTY } from './materials.js';
import type { Mask } from './mask.js';
import { isEmptyRect, padAndClamp, type Rect } from './rect.js';

/**
 * The mask texture is RG8: R = material ID, G = rim shade.
 *
 * Rim shade darkens the first few pixels inside an edge so craters read as
 * carved rather than cut out (SPEC §5.4). It is computed here, at upload time,
 * over the dirty rect only — which is exactly why it lands on fresh edges and
 * not on the photograph's own silhouette: pixels outside any dirty rect keep
 * the zero shade they were uploaded with.
 */
export const MASK_TEXTURE_CHANNELS = 2;

/** Chamfer weights: 3 per orthogonal step, 4 per diagonal, so 3 units ~= 1px. */
const ORTHO = 3;
const DIAG = 4;
const FAR = 1 << 24;

export function maskPatchByteLength(rect: Rect): number {
  return rect.width * rect.height * MASK_TEXTURE_CHANNELS;
}

/**
 * Builds the interleaved RG8 patch for `rect`.
 *
 * `rimDepthPx` of 0 skips the distance transform entirely — used for the
 * one full-map upload at load, where no edge is fresh.
 *
 * Distances are exact within `rimDepthPx` of any pixel in `rect`, because the
 * transform runs over `rect` grown by that much. Anything further away is
 * clamped to "unshaded" regardless, so the window costs no accuracy.
 */
export function buildMaskPatch(
  mask: Mask,
  rect: Rect,
  rimDepthPx: number,
  out?: Uint8Array,
): Uint8Array {
  return new MaskPatchBuilder().build(mask, rect, rimDepthPx, out);
}

/**
 * Builds patches while reusing its scratch buffers.
 *
 * Every explosion allocating a fresh distance window is a GC pause waiting to
 * happen, and a GC pause during destruction is exactly the hitch the frame
 * budget is trying to avoid. The renderer keeps one of these for the session.
 */
export class MaskPatchBuilder {
  private patchBuffer = new Uint8Array(0);
  private distBuffer = new Int32Array(0);

  build(mask: Mask, rect: Rect, rimDepthPx: number, out?: Uint8Array): Uint8Array {
    const needed = maskPatchByteLength(rect);
    let patch: Uint8Array;
    if (out && out.length >= needed) {
      patch = out;
    } else {
      if (this.patchBuffer.length < needed) this.patchBuffer = new Uint8Array(needed);
      patch = this.patchBuffer;
    }
    if (isEmptyRect(rect)) return patch;
    writePatch(mask, rect, rimDepthPx, patch, this.borrowDistBuffer(mask, rect, rimDepthPx));
    return patch;
  }

  private borrowDistBuffer(mask: Mask, rect: Rect, rimDepthPx: number): Int32Array {
    if (rimDepthPx <= 0) return this.distBuffer;
    const win = padAndClamp(rect, rimDepthPx, mask.width, mask.height);
    const needed = (win.width + 2) * (win.height + 2);
    if (this.distBuffer.length < needed) this.distBuffer = new Int32Array(needed);
    return this.distBuffer;
  }
}

function writePatch(
  mask: Mask,
  rect: Rect,
  rimDepthPx: number,
  patch: Uint8Array,
  distBuffer: Int32Array,
): void {
  const { data, width } = mask;
  const dist = rimDepthPx > 0 ? distanceToEmpty(mask, rect, rimDepthPx, distBuffer) : undefined;
  // t reaches 1 at one pixel in from the edge and 0 at rimDepthPx + 1.
  const shadeSpan = ORTHO * rimDepthPx;

  let o = 0;
  for (let y = 0; y < rect.height; y++) {
    const row = (rect.y + y) * width + rect.x;
    for (let x = 0; x < rect.width; x++) {
      const m = data[row + x];
      patch[o++] = m;
      if (m === EMPTY || dist === undefined) {
        patch[o++] = 0;
        continue;
      }
      const d = dist.value(rect.x + x, rect.y + y) - ORTHO;
      patch[o++] = d <= 0 ? 255 : d >= shadeSpan ? 0 : (((shadeSpan - d) * 255) / shadeSpan) | 0;
    }
  }
}

interface DistanceWindow {
  /** Chamfer distance from a solid pixel to the nearest empty pixel. */
  value(x: number, y: number): number;
}

/**
 * Two-pass chamfer distance transform over `rect` grown by `pad`, with a
 * one-pixel apron so the passes need no bounds checks. Outside the map counts
 * as empty — the world ends at the mask edge, it is not walled.
 */
function distanceToEmpty(
  mask: Mask,
  rect: Rect,
  pad: number,
  buffer: Int32Array,
): DistanceWindow {
  const { data, width, height } = mask;
  const win = padAndClamp(rect, pad, width, height);
  const pw = win.width + 2;
  const ph = win.height + 2;
  // Every cell of the window is written before it is read, so a dirty buffer
  // from the last crater needs no clearing.
  const dist = buffer.length >= pw * ph ? buffer : new Int32Array(pw * ph);

  for (let y = 0; y < win.height; y++) {
    const src = (win.y + y) * width + win.x;
    const dst = (y + 1) * pw + 1;
    for (let x = 0; x < win.width; x++) {
      dist[dst + x] = data[src + x] === EMPTY ? 0 : FAR;
    }
  }

  // Apron: a pixel outside the map is empty, so it seeds distance 0; a pixel
  // inside the map but outside the window is simply unknown.
  const apron = (mx: number, my: number): number =>
    mx < 0 || my < 0 || mx >= width || my >= height ? 0 : FAR;
  for (let px = 0; px < pw; px++) {
    const mx = win.x + px - 1;
    dist[px] = apron(mx, win.y - 1);
    dist[(ph - 1) * pw + px] = apron(mx, win.y + win.height);
  }
  for (let py = 0; py < ph; py++) {
    const my = win.y + py - 1;
    dist[py * pw] = apron(win.x - 1, my);
    dist[py * pw + pw - 1] = apron(win.x + win.width, my);
  }

  for (let y = 1; y <= win.height; y++) {
    const row = y * pw;
    const up = row - pw;
    for (let x = 1; x <= win.width; x++) {
      let d = dist[row + x];
      if (d === 0) continue;
      const a = dist[up + x - 1] + DIAG;
      const b = dist[up + x] + ORTHO;
      const c = dist[up + x + 1] + DIAG;
      const e = dist[row + x - 1] + ORTHO;
      if (a < d) d = a;
      if (b < d) d = b;
      if (c < d) d = c;
      if (e < d) d = e;
      dist[row + x] = d;
    }
  }
  for (let y = win.height; y >= 1; y--) {
    const row = y * pw;
    const down = row + pw;
    for (let x = win.width; x >= 1; x--) {
      let d = dist[row + x];
      if (d === 0) continue;
      const a = dist[down + x + 1] + DIAG;
      const b = dist[down + x] + ORTHO;
      const c = dist[down + x - 1] + DIAG;
      const e = dist[row + x + 1] + ORTHO;
      if (a < d) d = a;
      if (b < d) d = b;
      if (c < d) d = c;
      if (e < d) d = e;
      dist[row + x] = d;
    }
  }

  return {
    value(x: number, y: number): number {
      return dist[(y - win.y + 1) * pw + (x - win.x + 1)];
    },
  };
}
