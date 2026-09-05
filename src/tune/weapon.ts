import weaponRaw from '../../tune/weapon.json';
import type { FalloffCurve } from '../weapon/explosion.js';
import type { ProjectileTune } from '../weapon/projectile.js';

/** Typed view of `tune/weapon.json` (SPEC §6.3, §7). */
export interface WeaponTune {
  muzzleVelocity: { min: number; max: number };
  projectile: ProjectileTune & { spinRate: number };
  blastRadius: number;
  damage: FalloffCurve;
  knockback: FalloffCurve;
  /**
   * G from SPEC §6.3: the gap a monkey must be able to clear by shooting the
   * ground at its own feet, while surviving the self-damage.
   *
   * With floating terrain, one weapon and no rope, this is the only way off a
   * disconnected chunk — so it is not purely a feel value, it is a hard
   * requirement against stalemates, and `tests/weapon.test.ts` pins it.
   */
  /** Vehicle chain reactions (SPEC §5.3, §6.6). */
  chain: {
    /** Vehicle pixels a blast must destroy before the rest of the car goes up. */
    minVehiclePixels: number;
    /** Secondary blast radius, relative to the one that set it off. */
    radiusScale: number;
    /** Hard cap on chain length, so one car park cannot loop forever. */
    maxDepth: number;
    /** How far beyond the crater to look for the rest of the vehicle. */
    searchPad: number;
  };
  selfPropelGapMin: number;
  shake: { max: number; radius: number };
}

function curve(raw: FalloffCurve, path: string): FalloffCurve {
  if (!(raw.max >= 0) || !(raw.radius > 0) || !(raw.falloffPower > 0)) {
    throw new Error(`tune/weapon.json: ${path} needs max >= 0, radius > 0, falloffPower > 0`);
  }
  return { ...raw };
}

export function parseWeaponTune(raw: WeaponTune): WeaponTune {
  if (!(raw.muzzleVelocity.min > 0) || raw.muzzleVelocity.max <= raw.muzzleVelocity.min) {
    throw new Error(`tune/weapon.json: muzzleVelocity needs 0 < min < max`);
  }
  if (raw.projectile.drag < 0) throw new Error(`tune/weapon.json: projectile.drag must not be negative`);
  if (!(raw.blastRadius > 0)) throw new Error(`tune/weapon.json: blastRadius must be positive`);
  if (!(raw.selfPropelGapMin > 0)) {
    throw new Error(`tune/weapon.json: selfPropelGapMin must be positive`);
  }
  if (!Number.isInteger(raw.chain.maxDepth) || raw.chain.maxDepth < 0) {
    throw new Error(`tune/weapon.json: chain.maxDepth must be a non-negative integer`);
  }
  return {
    ...raw,
    chain: { ...raw.chain },
    muzzleVelocity: { ...raw.muzzleVelocity },
    projectile: { ...raw.projectile },
    damage: curve(raw.damage, 'damage'),
    knockback: curve(raw.knockback, 'knockback'),
    shake: { ...raw.shake },
  };
}

let cached: WeaponTune | undefined;

export function getWeaponTune(): WeaponTune {
  cached ??= parseWeaponTune(weaponRaw as WeaponTune);
  return cached;
}

export function setWeaponTune(tune: WeaponTune): void {
  cached = tune;
}
