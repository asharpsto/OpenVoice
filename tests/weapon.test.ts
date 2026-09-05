import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/core/rng.js';
import { createBody } from '../src/physics/body.js';
import { CircleCollider } from '../src/physics/collider.js';
import { IDLE, stepCharacter } from '../src/physics/controller.js';
import { explode } from '../src/terrain/destroy.js';
import { Mask } from '../src/terrain/mask.js';
import { applyBlast, falloffAt } from '../src/weapon/explosion.js';
import { analyticPosition, launch, stepProjectile } from '../src/weapon/projectile.js';
import { fallDamageFor, parseMonkeyTune, type MonkeyTune } from '../src/tune/monkey.js';
import { parsePhysicsTune, type PhysicsTune } from '../src/tune/physics.js';
import { parseWeaponTune, type WeaponTune } from '../src/tune/weapon.js';
import { tuneFixture } from './helpers.js';

const DT = 1 / 120;

function physicsFixture(): PhysicsTune {
  return parsePhysicsTune({
    gravity: 900,
    drag: 0.35,
    terminalVelocity: 1400,
    friction: 0.55,
    bounce: 0.22,
    maxStepHeight: 5,
    maxSnapDistance: 6,
    restSpeed: 14,
    restFrames: 8,
    maxSubStepPx: 1,
  });
}

function monkeyFixture(): MonkeyTune {
  return parseMonkeyTune({
    health: 100,
    colliderRadius: 8,
    walkSpeed: 95,
    jumpSpeed: 310,
    fallDamage: { thresholdSpeed: 430, perPixelPerSecond: 0.12 },
  });
}

function weaponFixture(overrides: Partial<WeaponTune> = {}): WeaponTune {
  return parseWeaponTune({
    muzzleVelocity: { min: 180, max: 720 },
    projectile: { drag: 0.22, gravityScale: 1, windInfluence: 1, spinRate: 12 },
    blastRadius: 78,
    damage: { max: 52, radius: 92, falloffPower: 1.7 },
    knockback: { max: 620, radius: 150, falloffPower: 0.85 },
    chain: { minVehiclePixels: 30, radiusScale: 0.75, maxDepth: 6, searchPad: 26 },
    selfPropelGapMin: 120,
    shake: { max: 26, radius: 420 },
    ...overrides,
  });
}

describe('projectile flight', () => {
  it('follows the analytic arc within 2px, at any angle, power or wind', () => {
    const weapon = weaponFixture();
    const terrain = tuneFixture();
    const sky = new Mask(4000, 3000); // nothing to hit
    const gravity = 900;

    for (const angle of [-2.6, -2.2, -Math.PI / 2, -1.1, -0.5]) {
      for (const power of [250, 450, 700]) {
        for (const wind of [-190, 0, 120]) {
          const projectile = launch(200, 2500, angle, power);
          let elapsed = 0;
          for (let i = 0; i < 240; i++) {
            stepProjectile(
              projectile,
              DT,
              sky,
              gravity,
              wind,
              weapon.projectile,
              terrain.query.raycastStepPx,
            );
            elapsed += DT;
          }
          const expected = analyticPosition(
            200,
            2500,
            Math.cos(angle) * power,
            Math.sin(angle) * power,
            elapsed,
            gravity,
            wind,
            weapon.projectile,
          );
          const drift = Math.hypot(projectile.x - expected.x, projectile.y - expected.y);
          expect(drift, `angle ${angle} power ${power} wind ${wind} drifted ${drift.toFixed(2)}px`)
            .toBeLessThan(2);
        }
      }
    }
  });

  it('wind bends the arc, and bends it the way it blows', () => {
    const weapon = weaponFixture();
    const terrain = tuneFixture();
    const sky = new Mask(4000, 3000);
    const landing = (wind: number): number => {
      const projectile = launch(200, 2500, -Math.PI / 4, 600);
      for (let i = 0; i < 240; i++) {
        stepProjectile(projectile, DT, sky, 900, wind, weapon.projectile, terrain.query.raycastStepPx);
      }
      return projectile.x;
    };
    expect(landing(-190)).toBeLessThan(landing(0));
    expect(landing(0)).toBeLessThan(landing(190));
  });

  it('does not tunnel through a thin fence at full power', () => {
    const weapon = weaponFixture();
    const terrain = tuneFixture();
    const mask = new Mask(1200, 600);
    for (let y = 0; y < 600; y++) {
      mask.set(600, y, 5);
      mask.set(601, y, 5);
    }
    const projectile = launch(100, 300, 0, weapon.muzzleVelocity.max);
    let hit = null;
    for (let i = 0; i < 400 && !hit; i++) {
      hit = stepProjectile(projectile, DT, mask, 0, 0, weapon.projectile, terrain.query.raycastStepPx).hit;
    }
    expect(hit).not.toBeNull();
    expect(hit?.pixelX).toBe(600);
  });

  it('is deterministic', () => {
    const weapon = weaponFixture();
    const terrain = tuneFixture();
    const fly = () => {
      const mask = new Mask(2000, 1200);
      for (let y = 900; y < 1200; y++) for (let x = 0; x < 2000; x++) mask.set(x, y, 2);
      const projectile = launch(100, 800, -0.9, 540);
      for (let i = 0; i < 500; i++) {
        const step = stepProjectile(projectile, DT, mask, 900, 60, weapon.projectile, terrain.query.raycastStepPx);
        if (step.hit || step.offMap) break;
      }
      return { ...projectile };
    };
    expect(fly()).toEqual(fly());
  });
});

describe('blast curves', () => {
  it('falls to zero at the radius and peaks at the centre', () => {
    const curve = { max: 50, radius: 100, falloffPower: 2 };
    expect(falloffAt(0, curve)).toBe(50);
    expect(falloffAt(100, curve)).toBe(0);
    expect(falloffAt(200, curve)).toBe(0);
    expect(falloffAt(50, curve)).toBeCloseTo(12.5, 6);
  });

  it('matches the damage curve at any distance', () => {
    const weapon = weaponFixture();
    for (const distance of [0, 10, 30, 60, 91, 92, 150]) {
      const body = createBody(100 + distance, 100);
      const [effect] = applyBlast([body], 100, 100, weapon);
      const expected =
        distance >= weapon.damage.radius
          ? 0
          : weapon.damage.max * Math.pow(1 - distance / weapon.damage.radius, weapon.damage.falloffPower);
      if (distance >= weapon.knockback.radius && distance >= weapon.damage.radius) {
        expect(effect).toBeUndefined();
      } else {
        expect(effect.damage).toBeCloseTo(expected, 6);
      }
    }
  });

  it('keeps damage and knockback on genuinely independent curves', () => {
    // The gap between the two is where this genre's memorable moments live,
    // so a shot that barely scratches you can still throw you off the map.
    const weapon = weaponFixture();
    const far = 120; // beyond the damage radius, inside the knockback radius
    const body = createBody(100 + far, 100);
    const [effect] = applyBlast([body], 100, 100, weapon);
    expect(effect.damage).toBe(0);
    expect(Math.hypot(effect.impulse.x, effect.impulse.y)).toBeGreaterThan(50);
    expect(body.grounded).toBe(false);
  });

  it('throws a body sitting exactly on the blast straight up', () => {
    const weapon = weaponFixture();
    const body = createBody(100, 100);
    const [effect] = applyBlast([body], 100, 100, weapon);
    expect(effect.impulse.x).toBe(0);
    expect(effect.impulse.y).toBe(-weapon.knockback.max);
  });
});

describe('self-propulsion', () => {
  /**
   * SPEC §6.3: with floating terrain, one weapon and no rope, a monkey stranded
   * on a disconnected chunk has exactly one way off — shoot the ground at its
   * feet and ride the knockback. That makes this a hard requirement against
   * stalemates rather than a feel value, and §10 asks for it by name.
   */
  it('clears selfPropelGapMin and survives the self-damage', () => {
    const weapon = weaponFixture();
    const terrain = tuneFixture();
    const physics = physicsFixture();
    const monkey = monkeyFixture();
    const gap = weapon.selfPropelGapMin;

    // A ledge, a gap of exactly G, then ground to land on.
    const mask = new Mask(900, 700);
    for (let y = 400; y < 700; y++) {
      for (let x = 0; x < 200; x++) mask.set(x, y, 2);
      for (let x = 200 + gap; x < 900; x++) mask.set(x, y, 2);
    }

    const collider = new CircleCollider(monkey.colliderRadius);
    const body = createBody(190, 400 - monkey.colliderRadius);
    for (let i = 0; i < 120; i++) stepCharacter(body, IDLE, mask, collider, physics, monkey, 1 / 60);
    expect(body.grounded).toBe(true);

    // The manoeuvre is to fire into the ground on the trailing side, not
    // straight down: a blast directly beneath throws you straight up and you
    // land where you started, which crosses nothing.
    const feetX = body.x - 14;
    const feetY = body.y + monkey.colliderRadius;
    explode(mask, feetX, feetY, weapon.blastRadius, terrain);
    const [effect] = applyBlast([body], feetX, feetY, weapon);
    let health = monkey.health - effect.damage;
    expect(health, 'the self-damage should not be fatal on its own').toBeGreaterThan(0);

    for (let i = 0; i < 900; i++) {
      stepCharacter(body, IDLE, mask, collider, physics, monkey, 1 / 60);
      if (body.atRest) break;
    }
    health -= fallDamageFor(body.lastImpactSpeed, monkey);

    // Landed on the far side of the gap, not back in the crater.
    expect(body.x, `came to rest at x=${body.x.toFixed(0)}, far side starts at ${200 + gap}`)
      .toBeGreaterThan(200 + gap);
    expect(body.grounded).toBe(true);
    expect(health, `died on the way with ${health.toFixed(1)} health left`).toBeGreaterThan(0);
  });
});

describe('aim solver', () => {
  it('finds an arc that reaches a target, and wind changes the answer', async () => {
    const { solveAim } = await import('../src/ai/aim.js');
    const weapon = weaponFixture();
    // Pick the target by flying a known shot, so a solution provably exists —
    // a target simply out of range would fail this for the wrong reason.
    const power = 640;
    const target = analyticPosition(
      100, 500,
      Math.cos(-0.9) * power, Math.sin(-0.9) * power,
      1.1, 900, 0, weapon.projectile,
    );

    const calm = solveAim(100, 500, target.x, target.y, power, 900, 0, weapon.projectile, 96);
    expect(calm.missDistance).toBeLessThan(12);
    const windy = solveAim(100, 500, target.x, target.y, power, 900, 180, weapon.projectile, 96);
    expect(windy.angle).not.toBe(calm.angle);
  });

  it('scatters shots by the difficulty sigma, and the dial actually turns', async () => {
    const { addAimError, solveAim } = await import('../src/ai/aim.js');
    const weapon = weaponFixture();
    const solution = solveAim(100, 500, 700, 500, 520, 900, 0, weapon.projectile, 96);

    const spread = (sigma: number): number => {
      const rng = mulberry32(7);
      let sum = 0;
      for (let i = 0; i < 400; i++) {
        const shot = addAimError(solution, rng, { angleRadians: sigma, powerFraction: 0 });
        sum += Math.abs(shot.angle - solution.angle);
      }
      return sum / 400;
    };
    expect(spread(0)).toBe(0);
    expect(spread(0.2)).toBeGreaterThan(spread(0.02) * 5);
  });
});
