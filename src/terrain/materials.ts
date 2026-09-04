/**
 * Mask material IDs. See CLAUDE.md ("Mask format") and SPEC §5.3.
 *
 * One byte per pixel. 0 = empty. The mask is the collision; no separate
 * collision geometry exists anywhere in this game.
 */

export const EMPTY = 0 as const;
export const BUILDING = 1 as const;
export const GROUND = 2 as const;
export const VEGETATION = 3 as const;
export const VEHICLE = 4 as const;
export const POLE = 5 as const;

export type MaterialId = 0 | 1 | 2 | 3 | 4 | 5;

/** Highest legal material ID. Anything above this is a malformed mask. */
export const MAX_MATERIAL_ID = 5;

export const MATERIAL_NAMES = [
  'empty',
  'building',
  'ground',
  'vegetation',
  'vehicle',
  'pole',
] as const;

export type MaterialName = (typeof MATERIAL_NAMES)[number];

/** Solid material IDs, in ID order. Excludes EMPTY. */
export const SOLID_MATERIALS: readonly MaterialId[] = [
  BUILDING,
  GROUND,
  VEGETATION,
  VEHICLE,
  POLE,
];

export function isMaterialId(value: number): value is MaterialId {
  return Number.isInteger(value) && value >= 0 && value <= MAX_MATERIAL_ID;
}

export function materialName(id: MaterialId): MaterialName {
  return MATERIAL_NAMES[id];
}
