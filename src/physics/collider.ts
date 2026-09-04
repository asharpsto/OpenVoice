import { EMPTY } from '../terrain/materials.js';
import { BROADPHASE_CELL_SIZE, type Mask } from '../terrain/mask.js';

/**
 * A circle tested against the terrain bitmap.
 *
 * The collider is a circle regardless of sprite shape (CLAUDE.md). All it
 * answers is "does this circle overlap solid terrain here" — no penetration
 * depth, no surface normal. The stepped controller (SPEC §6.1) is built on
 * that single question precisely so there is never a normal to push out along,
 * which is what makes bitmap character controllers jitter.
 */
export class CircleCollider {
  readonly radius: number;
  /** Half-width of the disc at each integer row offset, so rows outside it are skipped. */
  private readonly halfWidths: Float64Array;
  private readonly rowCount: number;
  private readonly top: number;

  constructor(radius: number) {
    if (!(radius > 0)) throw new Error(`Collider radius must be positive, got ${radius}`);
    this.radius = radius;
    this.top = -Math.ceil(radius);
    this.rowCount = Math.ceil(radius) * 2 + 1;
    this.halfWidths = new Float64Array(this.rowCount);
    for (let i = 0; i < this.rowCount; i++) {
      const dy = this.top + i;
      const inside = radius * radius - dy * dy;
      this.halfWidths[i] = inside > 0 ? Math.sqrt(inside) : -1;
    }
  }

  /**
   * True when any solid pixel lies under the circle centred at (cx, cy).
   *
   * Rows are walked bottom-up because terrain is almost always below a body,
   * so the common case exits on the first row it looks at.
   */
  overlaps(mask: Mask, cx: number, cy: number): boolean {
    if (this.outsideEverything(mask, cx, cy)) return false;
    const { data, width, height } = mask;
    for (let i = this.rowCount - 1; i >= 0; i--) {
      const halfWidth = this.halfWidths[i];
      if (halfWidth < 0) continue;
      const y = Math.floor(cy + this.top + i);
      if (y < 0 || y >= height) continue;
      const x0 = Math.max(0, Math.floor(cx - halfWidth));
      const x1 = Math.min(width - 1, Math.floor(cx + halfWidth));
      const row = y * width;
      for (let x = x0; x <= x1; x++) {
        if (data[row + x] !== EMPTY) return true;
      }
    }
    return false;
  }

  /** Broadphase reject: no occupied cell anywhere near the circle's box. */
  private outsideEverything(mask: Mask, cx: number, cy: number): boolean {
    const r = this.radius;
    const cx0 = Math.floor((cx - r) / BROADPHASE_CELL_SIZE);
    const cx1 = Math.floor((cx + r) / BROADPHASE_CELL_SIZE);
    const cy0 = Math.floor((cy - r) / BROADPHASE_CELL_SIZE);
    const cy1 = Math.floor((cy + r) / BROADPHASE_CELL_SIZE);
    for (let y = cy0; y <= cy1; y++) {
      for (let x = cx0; x <= cx1; x++) {
        if (mask.cellOccupied(x, y)) return false;
      }
    }
    return true;
  }
}
