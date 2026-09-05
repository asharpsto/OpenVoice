import { explode, type ExplosionResult } from '../terrain/destroy.js';
import type { Mask } from '../terrain/mask.js';
import { VEHICLE } from '../terrain/materials.js';
import { padAndClamp, union, type Rect } from '../terrain/rect.js';
import type { TerrainTune } from '../tune/terrain.js';
import type { WeaponTune } from '../tune/weapon.js';

/**
 * Vehicle chain reactions (SPEC §5.3, §6.6).
 *
 * A blast that takes a big enough bite out of a car sets the rest of it off,
 * and that secondary blast can set off the car next to it. Chains resolve
 * **fully within one RESOLUTION** — the turn machine never sees a half-finished
 * chain, which is what stops deaths arriving in two batches and the win check
 * running twice.
 */

export interface Blast {
  x: number;
  y: number;
  radius: number;
  /** 0 for the shot itself, 1+ for each car it sets off. */
  depth: number;
  result: ExplosionResult;
}

export interface ChainOutcome {
  blasts: Blast[];
  /** Everything the chain changed, for one texture upload. */
  dirtyRect: Rect;
  /** True when the depth cap stopped it early — worth logging if it ever happens. */
  cappedOut: boolean;
}

/**
 * Fires one blast and every blast it sets off, in order.
 *
 * Each step destroys vehicle pixels, and the mask only ever empties, so the
 * chain terminates on its own; `maxDepth` is a belt-and-braces cap rather than
 * the actual termination argument.
 */
export function resolveBlastChain(
  mask: Mask,
  x: number,
  y: number,
  radius: number,
  terrain: TerrainTune,
  weapon: WeaponTune,
): ChainOutcome {
  const blasts: Blast[] = [];
  let dirtyRect: Rect = { x: 0, y: 0, width: 0, height: 0 };
  const queue: Array<{ x: number; y: number; radius: number; depth: number }> = [
    { x, y, radius, depth: 0 },
  ];
  let cappedOut = false;

  while (queue.length > 0) {
    const next = queue.shift() as { x: number; y: number; radius: number; depth: number };
    const result = explode(mask, next.x, next.y, next.radius, terrain);
    blasts.push({ x: next.x, y: next.y, radius: next.radius, depth: next.depth, result });
    dirtyRect = union(dirtyRect, result.dirtyRect);

    if (result.clearedByMaterial[VEHICLE] < weapon.chain.minVehiclePixels) continue;
    if (next.depth >= weapon.chain.maxDepth) {
      cappedOut = true;
      continue;
    }
    // The rest of the car: vehicle pixels still standing around the crater.
    const centre = remainingVehicleCentroid(
      mask,
      padAndClamp(result.clearedRect, weapon.chain.searchPad, mask.width, mask.height),
    );
    if (!centre) continue;
    queue.push({
      x: centre.x,
      y: centre.y,
      radius: next.radius * weapon.chain.radiusScale,
      depth: next.depth + 1,
    });
  }

  return { blasts, dirtyRect, cappedOut };
}

function remainingVehicleCentroid(mask: Mask, area: Rect): { x: number; y: number } | null {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (let y = area.y; y < area.y + area.height; y++) {
    for (let x = area.x; x < area.x + area.width; x++) {
      if (mask.at(x, y) !== VEHICLE) continue;
      sumX += x;
      sumY += y;
      count++;
    }
  }
  return count === 0 ? null : { x: sumX / count + 0.5, y: sumY / count + 0.5 };
}
