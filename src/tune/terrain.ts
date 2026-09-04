import terrainTuneJson from '../../tune/terrain.json';
import { MATERIAL_NAMES, MAX_MATERIAL_ID, SOLID_MATERIALS, type MaterialId } from '../terrain/materials.js';

/**
 * Typed view of `tune/terrain.json` (SPEC §7).
 *
 * Nothing here may be inlined into code: a magic number affecting feel is a bug
 * (CLAUDE.md). Terrain code takes these as parameters so tests can supply
 * fixtures and the stage-3 slider overlay can swap them live.
 */

export interface RimTune {
  /** How many pixels inside a fresh edge get darkened (SPEC §5.4). */
  depthPx: number;
  /** 0 = no darkening, 1 = black at the edge. */
  strength: number;
}

export interface QueryTune {
  /** Sub-pixel march interval for projectile/terrain raycasts (SPEC §5.5). */
  raycastStepPx: number;
}

export interface ValidationTune {
  minSolidFraction: number;
  maxSolidFraction: number;
  minSpawnPoints: number;
  /** Width of the flat-ish shelf a spawn needs. */
  spawnWidthPx: number;
  /** Empty headroom required above a spawn. */
  spawnClearanceHeightPx: number;
  /** Height variation tolerated across the shelf. */
  spawnFlatnessTolerancePx: number;
  /** Minimum horizontal gap between accepted spawns. */
  spawnSpacingPx: number;
  /** Solid depth required beneath a spawn, so ledges one pixel thick don't count. */
  spawnGroundDepthPx: number;
}

export interface TerrainTune {
  /**
   * How brightly the photograph shows through where the mask is empty, 0..1.
   * 0 discards the sky and leaves a cut-out on the app background.
   */
  backdrop: number;
  /**
   * Per-material blast resistance (SPEC §5.3). Effective crater radius at a
   * pixel is `radius / blastResistance[material]`, so high resistance means a
   * small crater. Indexed by material ID; index 0 (empty) is unused.
   */
  blastResistance: Float32Array;
  /**
   * `1 / blastResistance`, indexed by material ID. Precomputed so the
   * destruction blit's inner loop has no division in it.
   */
  radiusScale: Float32Array;
  /** Largest radiusScale over solid materials. Bounds the blit's scan rect. */
  maxRadiusScale: number;
  rim: RimTune;
  query: QueryTune;
  validation: ValidationTune;
}

export interface TerrainTuneJson {
  backdrop: number;
  blastResistance: Record<string, number>;
  rim: RimTune;
  query: QueryTune;
  validation: ValidationTune;
}

function positive(value: number, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`tune/terrain.json: ${path} must be a positive finite number, got ${value}`);
  }
  return value;
}

/** Builds the ID-indexed lookup the destruction blit reads in its inner loop. */
export function parseTerrainTune(raw: TerrainTuneJson): TerrainTune {
  const blastResistance = new Float32Array(MAX_MATERIAL_ID + 1);
  for (const id of SOLID_MATERIALS) {
    const name = MATERIAL_NAMES[id];
    const value = raw.blastResistance[name];
    if (value === undefined) {
      throw new Error(`tune/terrain.json: blastResistance.${name} is missing`);
    }
    blastResistance[id] = positive(value, `blastResistance.${name}`);
  }
  if (raw.rim.depthPx < 0 || !Number.isInteger(raw.rim.depthPx)) {
    throw new Error(`tune/terrain.json: rim.depthPx must be a non-negative integer`);
  }
  if (raw.rim.strength < 0 || raw.rim.strength > 1) {
    throw new Error(`tune/terrain.json: rim.strength must be within 0..1`);
  }
  if (raw.backdrop < 0 || raw.backdrop > 1) {
    throw new Error(`tune/terrain.json: backdrop must be within 0..1`);
  }
  positive(raw.query.raycastStepPx, 'query.raycastStepPx');
  if (raw.query.raycastStepPx > 1) {
    throw new Error(`tune/terrain.json: query.raycastStepPx must be sub-pixel (<= 1)`);
  }
  const radiusScale = new Float32Array(MAX_MATERIAL_ID + 1);
  let maxRadiusScale = 0;
  for (const id of SOLID_MATERIALS) {
    radiusScale[id] = 1 / blastResistance[id];
    maxRadiusScale = Math.max(maxRadiusScale, radiusScale[id]);
  }
  return {
    backdrop: raw.backdrop,
    blastResistance,
    radiusScale,
    maxRadiusScale,
    rim: { ...raw.rim },
    query: { ...raw.query },
    validation: { ...raw.validation },
  };
}

let cached: TerrainTune | undefined;

/** The loaded terrain tuning, hot-reloadable through the stage-3 harness. */
export function getTerrainTune(): TerrainTune {
  cached ??= parseTerrainTune(terrainTuneJson as TerrainTuneJson);
  return cached;
}

/** Replaces the cached tuning. Used by the hot-reload harness. */
export function setTerrainTune(tune: TerrainTune): void {
  cached = tune;
}

/** Effective crater radius for one material (SPEC §5.3, §5.4). */
export function effectiveBlastRadius(
  radius: number,
  material: MaterialId,
  tune: TerrainTune,
): number {
  return radius * tune.radiusScale[material];
}
