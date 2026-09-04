/** Integer pixel rectangle, [x, x + width) x [y, y + height). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function isEmptyRect(r: Rect): boolean {
  return r.width <= 0 || r.height <= 0;
}

export const EMPTY_RECT: Rect = { x: 0, y: 0, width: 0, height: 0 };

/** Grow a rect by `pad` on every side, then clamp it to [0,w) x [0,h). */
export function padAndClamp(r: Rect, pad: number, w: number, h: number): Rect {
  const x0 = Math.max(0, r.x - pad);
  const y0 = Math.max(0, r.y - pad);
  const x1 = Math.min(w, r.x + r.width + pad);
  const y1 = Math.min(h, r.y + r.height + pad);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

/** Smallest rect containing both inputs. Empty rects are ignored. */
export function union(a: Rect, b: Rect): Rect {
  if (isEmptyRect(a)) return { ...b };
  if (isEmptyRect(b)) return { ...a };
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.width, b.x + b.width);
  const y1 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
