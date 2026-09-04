import { EMPTY, MAX_MATERIAL_ID, type MaterialId } from './materials.js';
import { BROADPHASE_CELL_SIZE, type Mask } from './mask.js';
import { EMPTY_RECT, padAndClamp, type Rect } from './rect.js';
import type { TerrainTune } from '../tune/terrain.js';

/** What one explosion did to the mask. */
export interface ExplosionResult {
  clearedTotal: number;
  /** Pixels cleared per material ID. Index 0 is unused. Feeds debris audio and vehicle chains. */
  clearedByMaterial: Uint32Array;
  /** Bounding box of the cleared pixels. Empty when nothing was destroyed. */
  clearedRect: Rect;
  /**
   * Region whose rendered appearance changed: the cleared box grown by the rim
   * shade depth. This is the only region that needs re-uploading (SPEC §5.4).
   */
  dirtyRect: Rect;
}

/**
 * Blits a transparent circle into the mask, the radius at each pixel scaled by
 * the material under that pixel (SPEC §5.4). A hedge opens up; a wall chips.
 *
 * Note this is per-pixel, not line-of-sight: a low-resistance pixel behind a
 * wall is still within the blast. That is the specified behaviour, and it is
 * what makes vegetation blow apart while the building in front of it holds.
 */
export function explode(
  mask: Mask,
  centreX: number,
  centreY: number,
  radius: number,
  tune: TerrainTune,
): ExplosionResult {
  const clearedByMaterial = new Uint32Array(MAX_MATERIAL_ID + 1);
  if (!(radius > 0)) {
    return { clearedTotal: 0, clearedByMaterial, clearedRect: EMPTY_RECT, dirtyRect: EMPTY_RECT };
  }

  // Squared effective radius per material, so the inner loop has no divisions
  // and no square roots.
  const r2 = new Float64Array(MAX_MATERIAL_ID + 1);
  for (let m = 1; m <= MAX_MATERIAL_ID; m++) {
    const r = radius * tune.radiusScale[m];
    r2[m] = r * r;
  }

  // The blast reaches furthest through whatever material resists it least.
  const reach = radius * tune.maxRadiusScale;
  const reach2 = reach * reach;
  const x0 = Math.max(0, Math.floor(centreX - reach));
  const y0 = Math.max(0, Math.floor(centreY - reach));
  const x1 = Math.min(mask.width - 1, Math.ceil(centreX + reach));
  const y1 = Math.min(mask.height - 1, Math.ceil(centreY + reach));
  if (x1 < x0 || y1 < y0) {
    return { clearedTotal: 0, clearedByMaterial, clearedRect: EMPTY_RECT, dirtyRect: EMPTY_RECT };
  }

  const { data, width } = mask;
  let clearedTotal = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  // Walk the scan box a broadphase cell at a time. A large blast over a street
  // is mostly sky and mostly corners, and both are rejected here in O(1)
  // instead of a pixel at a time (SPEC §5.5).
  const cell = BROADPHASE_CELL_SIZE;
  const cy0 = (y0 / cell) | 0;
  const cy1 = (y1 / cell) | 0;
  const cx0 = (x0 / cell) | 0;
  const cx1 = (x1 / cell) | 0;

  for (let cy = cy0; cy <= cy1; cy++) {
    const cellTop = cy * cell;
    const py0 = cellTop > y0 ? cellTop : y0;
    const py1 = cellTop + cell - 1 < y1 ? cellTop + cell - 1 : y1;
    for (let cx = cx0; cx <= cx1; cx++) {
      if (!mask.cellOccupied(cx, cy)) continue;
      const cellLeft = cx * cell;
      // Nearest point of the cell to the blast centre; if that is out of
      // reach, nothing in the cell can be.
      const nx = centreX < cellLeft ? cellLeft : Math.min(centreX, cellLeft + cell);
      const ny = centreY < cellTop ? cellTop : Math.min(centreY, cellTop + cell);
      const cdx = nx - centreX;
      const cdy = ny - centreY;
      if (cdx * cdx + cdy * cdy > reach2) continue;

      const px0 = cellLeft > x0 ? cellLeft : x0;
      const px1 = cellLeft + cell - 1 < x1 ? cellLeft + cell - 1 : x1;
      for (let y = py0; y <= py1; y++) {
        // Pixel (x, y) covers [x, x+1) x [y, y+1); measure from its centre.
        const dy = y + 0.5 - centreY;
        const dy2 = dy * dy;
        const row = y * width;
        for (let x = px0; x <= px1; x++) {
          const i = row + x;
          const m = data[i];
          if (m === EMPTY) continue;
          const dx = x + 0.5 - centreX;
          if (dx * dx + dy2 > r2[m]) continue;
          mask.clearSolidPixelUnchecked(x, y, i);
          clearedByMaterial[m]++;
          clearedTotal++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
  }

  if (clearedTotal === 0) {
    return { clearedTotal: 0, clearedByMaterial, clearedRect: EMPTY_RECT, dirtyRect: EMPTY_RECT };
  }

  const clearedRect: Rect = {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
  return {
    clearedTotal,
    clearedByMaterial,
    clearedRect,
    dirtyRect: padAndClamp(clearedRect, tune.rim.depthPx, mask.width, mask.height),
  };
}

/** Effective crater radius at a given material, exposed for tests and tooling. */
export function craterRadiusFor(radius: number, material: MaterialId, tune: TerrainTune): number {
  return material === EMPTY ? 0 : radius * tune.radiusScale[material];
}
