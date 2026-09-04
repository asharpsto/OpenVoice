import { EMPTY } from './materials.js';
import type { Mask } from './mask.js';
import type { ValidationTune } from '../tune/terrain.js';

/** A place a monkey can be put down at the start of a match. */
export interface SpawnPoint {
  /** Column the spawn was measured at. */
  x: number;
  /** Row of the surface pixel; a monkey stands directly above it. */
  y: number;
}

export interface MapValidationResult {
  ok: boolean;
  /** Reasons the map is unplayable. Empty when `ok`. */
  problems: string[];
  /** Things worth knowing that do not fail the map. */
  warnings: string[];
  solidFraction: number;
  /** Usable spawns, left to right. */
  spawns: SpawnPoint[];
  /** Candidates discarded because their ground is not the main land mass. */
  islandSpawns: SpawnPoint[];
}

/**
 * Rejects unplayable maps before they ever load (SPEC §5.6). Runs at bake time
 * and in CI, never per frame — the connected-component pass is O(map).
 */
export function validateMap(
  mask: Mask,
  waterLineY: number,
  tune: ValidationTune,
): MapValidationResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  const solidFraction = mask.solidFraction;

  if (solidFraction < tune.minSolidFraction) {
    problems.push(
      `Too little terrain: ${(solidFraction * 100).toFixed(1)}% solid, minimum ${(
        tune.minSolidFraction * 100
      ).toFixed(0)}%`,
    );
  }
  if (solidFraction > tune.maxSolidFraction) {
    problems.push(
      `Too little sky: ${(solidFraction * 100).toFixed(1)}% solid, maximum ${(
        tune.maxSolidFraction * 100
      ).toFixed(0)}%`,
    );
  }

  const candidates = findSpawnCandidates(mask, tune);
  const mainland = labelSolidComponents(mask);
  const spawns: SpawnPoint[] = [];
  const islandSpawns: SpawnPoint[] = [];
  for (const spawn of candidates) {
    // The surface pixel itself is solid, so it carries the component label.
    if (mainland.isMainland(spawn.x, spawn.y)) spawns.push(spawn);
    else islandSpawns.push(spawn);
  }

  if (islandSpawns.length > 0) {
    warnings.push(
      `${islandSpawns.length} spawn candidate(s) discarded: not on the main land mass`,
    );
  }
  if (spawns.length < tune.minSpawnPoints) {
    problems.push(
      `Only ${spawns.length} reachable spawn point(s), need ${tune.minSpawnPoints}` +
        (islandSpawns.length > 0 ? ` (${islandSpawns.length} more were on islands)` : ''),
    );
  }

  if (spawns.length > 0) {
    let lowest = spawns[0].y;
    for (const spawn of spawns) if (spawn.y > lowest) lowest = spawn.y;
    if (waterLineY <= lowest) {
      problems.push(
        `Water line at y=${waterLineY} is not below the lowest spawn at y=${lowest}`,
      );
    }
  }

  return { ok: problems.length === 0, problems, warnings, solidFraction, spawns, islandSpawns };
}

/**
 * Finds flat-ish shelves with headroom above and solid ground beneath.
 *
 * Every empty-to-solid transition down a column counts as a surface, not just
 * the silhouette, so platforms under a bridge are spawnable (SPEC §5.1).
 */
export function findSpawnCandidates(mask: Mask, tune: ValidationTune): SpawnPoint[] {
  const spawns: SpawnPoint[] = [];
  const halfWidth = Math.floor(tune.spawnWidthPx / 2);
  // Spawns are pushed in ascending x, so the crowding check only has to look at
  // the tail of the list: everything before this index is already too far left.
  let windowStart = 0;

  for (let x = 0; x < mask.width; x++) {
    while (windowStart < spawns.length && spawns[windowStart].x <= x - tune.spawnSpacingPx) {
      windowStart++;
    }
    for (const y of surfacesInColumn(mask, x, tune)) {
      if (!shelfIsFlat(mask, x, y, halfWidth, tune)) continue;
      // Spacing applies per level, not per column: the street under a bridge is
      // its own shelf and deserves its own spawns (SPEC §5.1).
      let crowded = false;
      for (let i = windowStart; i < spawns.length; i++) {
        if (Math.abs(spawns[i].y - y) < tune.spawnClearanceHeightPx) {
          crowded = true;
          break;
        }
      }
      if (!crowded) spawns.push({ x, y });
    }
  }
  return spawns;
}

/** Surface rows in a column: solid pixels with the required headroom and depth. */
function* surfacesInColumn(mask: Mask, x: number, tune: ValidationTune): Generator<number> {
  const { height } = mask;
  for (let y = 0; y < height; y++) {
    if (mask.at(x, y) === EMPTY) continue;
    if (!hasHeadroom(mask, x, y, tune.spawnClearanceHeightPx)) {
      // Skip to the end of this solid run; its interior is not a surface.
      while (y < height && mask.at(x, y) !== EMPTY) y++;
      continue;
    }
    if (hasGroundBeneath(mask, x, y, tune.spawnGroundDepthPx)) yield y;
    while (y < height && mask.at(x, y) !== EMPTY) y++;
  }
}

function hasHeadroom(mask: Mask, x: number, y: number, clearance: number): boolean {
  for (let dy = 1; dy <= clearance; dy++) {
    if (mask.at(x, y - dy) !== EMPTY) return false;
  }
  return true;
}

function hasGroundBeneath(mask: Mask, x: number, y: number, depth: number): boolean {
  for (let dy = 0; dy < depth; dy++) {
    if (mask.at(x, y + dy) === EMPTY) return false;
  }
  return true;
}

function shelfIsFlat(
  mask: Mask,
  x: number,
  y: number,
  halfWidth: number,
  tune: ValidationTune,
): boolean {
  for (let dx = -halfWidth; dx <= halfWidth; dx++) {
    const cx = x + dx;
    if (cx < 0 || cx >= mask.width) return false;
    let matched = false;
    for (let dy = -tune.spawnFlatnessTolerancePx; dy <= tune.spawnFlatnessTolerancePx; dy++) {
      const cy = y + dy;
      if (mask.at(cx, cy) === EMPTY) continue;
      if (!hasHeadroom(mask, cx, cy, tune.spawnClearanceHeightPx)) continue;
      if (!hasGroundBeneath(mask, cx, cy, tune.spawnGroundDepthPx)) continue;
      matched = true;
      break;
    }
    if (!matched) return false;
  }
  return true;
}

interface ComponentLabels {
  /** True when the solid pixel belongs to the largest connected mass. */
  isMainland(x: number, y: number): boolean;
  componentCount: number;
  largestSize: number;
}

/**
 * 8-connected components over solid pixels, by union-find. Approximates
 * reachability: the biggest mass is the mainland, anything else is a floating
 * island a monkey could not walk to.
 *
 * It is an approximation on purpose — true reachability needs the character
 * controller's slope limit and jump height, which arrive in stage 3.
 */
export function labelSolidComponents(mask: Mask): ComponentLabels {
  const { width, height, data } = mask;
  const parent = new Int32Array(width * height).fill(-1);

  const find = (a: number): number => {
    let root = a;
    while (parent[root] !== root) root = parent[root];
    let node = a;
    while (parent[node] !== root) {
      const next = parent[node];
      parent[node] = root;
      node = next;
    }
    return root;
  };
  const unite = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      if (data[i] === EMPTY) continue;
      parent[i] = i;
      if (x > 0 && data[i - 1] !== EMPTY) unite(i, i - 1);
      if (y > 0) {
        const up = i - width;
        if (data[up] !== EMPTY) unite(i, up);
        if (x > 0 && data[up - 1] !== EMPTY) unite(i, up - 1);
        if (x + 1 < width && data[up + 1] !== EMPTY) unite(i, up + 1);
      }
    }
  }

  const sizes = new Map<number, number>();
  for (let i = 0; i < parent.length; i++) {
    if (parent[i] === -1) continue;
    const root = find(i);
    sizes.set(root, (sizes.get(root) ?? 0) + 1);
  }
  let largestRoot = -1;
  let largestSize = 0;
  for (const [root, size] of sizes) {
    if (size > largestSize) {
      largestSize = size;
      largestRoot = root;
    }
  }

  return {
    isMainland(x: number, y: number): boolean {
      if (x < 0 || y < 0 || x >= width || y >= height) return false;
      const i = y * width + x;
      if (parent[i] === -1) return false;
      return find(i) === largestRoot;
    },
    componentCount: sizes.size,
    largestSize,
  };
}
