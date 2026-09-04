import { EMPTY, type MaterialId, isMaterialId } from './materials.js';
import type { Rect } from './rect.js';

/**
 * Coarse occupancy grid cell size, in pixels (SPEC §5.5). A cell is "occupied"
 * when it contains any solid pixel, which lets queries skip empty sky in O(1).
 */
export const BROADPHASE_CELL_SIZE = 16;

/**
 * The terrain mask: one byte per pixel, 0 = empty, otherwise a material ID.
 *
 * This *is* the collision (CLAUDE.md). Every physics query in the game reads
 * this array; nothing else describes the shape of the world.
 *
 * A coarse occupancy grid is maintained incrementally alongside the pixels so
 * destruction stays O(changed pixels) rather than O(map).
 */
export class Mask {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;

  readonly cellsX: number;
  readonly cellsY: number;
  /** Solid pixel count per broadphase cell. Zero means "skippable". */
  private readonly cellSolid: Uint32Array;
  private solid = 0;

  constructor(width: number, height: number, data?: Uint8Array) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new Error(`Mask dimensions must be positive integers, got ${width}x${height}`);
    }
    if (data && data.length !== width * height) {
      throw new Error(
        `Mask data length ${data.length} does not match ${width}x${height} (${width * height})`,
      );
    }
    this.width = width;
    this.height = height;
    this.data = data ?? new Uint8Array(width * height);
    this.cellsX = Math.ceil(width / BROADPHASE_CELL_SIZE);
    this.cellsY = Math.ceil(height / BROADPHASE_CELL_SIZE);
    this.cellSolid = new Uint32Array(this.cellsX * this.cellsY);
    this.rebuildBroadphase();
  }

  /** Row-major pixel index. Callers must have bounds-checked. */
  index(x: number, y: number): number {
    return y * this.width + x;
  }

  /** Material at a pixel. Outside the map is EMPTY — the world ends, it is not walled. */
  at(x: number, y: number): MaterialId {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return EMPTY;
    return this.data[y * this.width + x] as MaterialId;
  }

  /** O(1) point test (SPEC §5.5). Accepts sub-pixel coordinates; floors them. */
  isSolid(x: number, y: number): boolean {
    return this.at(Math.floor(x), Math.floor(y)) !== EMPTY;
  }

  /** Writes a pixel and keeps the broadphase and solid count in step. */
  set(x: number, y: number, material: MaterialId): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    if (!isMaterialId(material)) throw new Error(`Not a material ID: ${material}`);
    const i = y * this.width + x;
    const prev = this.data[i];
    if (prev === material) return;
    this.data[i] = material;
    const cellIndex =
      ((y / BROADPHASE_CELL_SIZE) | 0) * this.cellsX + ((x / BROADPHASE_CELL_SIZE) | 0);
    if (prev === EMPTY && material !== EMPTY) {
      this.cellSolid[cellIndex]++;
      this.solid++;
    } else if (prev !== EMPTY && material === EMPTY) {
      this.cellSolid[cellIndex]--;
      this.solid--;
    }
  }

  /**
   * Clears a pixel already known to be solid and in bounds, updating counters.
   * The destruction blit's inner loop; not for general use.
   * @internal
   */
  clearSolidPixelUnchecked(x: number, y: number, index: number): void {
    this.data[index] = EMPTY;
    this.cellSolid[((y / BROADPHASE_CELL_SIZE) | 0) * this.cellsX + ((x / BROADPHASE_CELL_SIZE) | 0)]--;
    this.solid--;
  }

  /** True if the cell contains any solid pixel. Out-of-range cells are empty. */
  cellOccupied(cx: number, cy: number): boolean {
    if (cx < 0 || cy < 0 || cx >= this.cellsX || cy >= this.cellsY) return false;
    return this.cellSolid[cy * this.cellsX + cx] !== 0;
  }

  /** Broadphase test for a pixel coordinate. */
  cellOccupiedAtPixel(x: number, y: number): boolean {
    return this.cellOccupied((x / BROADPHASE_CELL_SIZE) | 0, (y / BROADPHASE_CELL_SIZE) | 0);
  }

  /** Solid pixel count in a cell (diagnostics and tests). */
  cellSolidCount(cx: number, cy: number): number {
    if (cx < 0 || cy < 0 || cx >= this.cellsX || cy >= this.cellsY) return 0;
    return this.cellSolid[cy * this.cellsX + cx];
  }

  get solidPixels(): number {
    return this.solid;
  }

  get solidFraction(): number {
    return this.solid / (this.width * this.height);
  }

  /** Full-map rect, handy for initial uploads and validation. */
  get bounds(): Rect {
    return { x: 0, y: 0, width: this.width, height: this.height };
  }

  clone(): Mask {
    return new Mask(this.width, this.height, this.data.slice());
  }

  /** Recomputes the occupancy grid and solid count from the pixels. O(map). */
  rebuildBroadphase(): void {
    this.cellSolid.fill(0);
    let solid = 0;
    const { width, height, data, cellsX } = this;
    for (let y = 0; y < height; y++) {
      const cellRow = ((y / BROADPHASE_CELL_SIZE) | 0) * cellsX;
      const row = y * width;
      for (let x = 0; x < width; x++) {
        if (data[row + x] !== EMPTY) {
          this.cellSolid[cellRow + ((x / BROADPHASE_CELL_SIZE) | 0)]++;
          solid++;
        }
      }
    }
    this.solid = solid;
  }
}
