import { describe, expect, it } from 'vitest';
import { applyImpulse, cloneBody, createBody } from '../src/physics/body.js';
import { CircleCollider } from '../src/physics/collider.js';
import { IDLE, stepCharacter, walk, type CharacterInput } from '../src/physics/controller.js';
import { Mask } from '../src/terrain/mask.js';
import { parseMonkeyTune, type MonkeyTune } from '../src/tune/monkey.js';
import { parsePhysicsTune, type PhysicsTune } from '../src/tune/physics.js';

const DT = 1 / 60;

function physicsFixture(overrides: Partial<PhysicsTune> = {}): PhysicsTune {
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
    ...overrides,
  });
}

function monkeyFixture(overrides: Partial<MonkeyTune> = {}): MonkeyTune {
  return parseMonkeyTune({
    health: 100,
    colliderRadius: 8,
    walkSpeed: 95,
    jumpSpeed: 310,
    fallDamage: { thresholdSpeed: 430, perPixelPerSecond: 0.12 },
    ...overrides,
  });
}

/** Flat ground across the bottom half. */
function flatGround(width = 400, height = 200, groundY = 120): Mask {
  const mask = new Mask(width, height);
  for (let y = groundY; y < height; y++) {
    for (let x = 0; x < width; x++) mask.set(x, y, 2);
  }
  return mask;
}

/** Ground that rises `rise` pixels every `run` pixels, left to right. */
function slope(rise: number, run: number, width = 400, height = 300, baseY = 220): Mask {
  const mask = new Mask(width, height);
  for (let x = 0; x < width; x++) {
    const top = Math.max(0, baseY - Math.floor((x / run) * rise));
    for (let y = top; y < height; y++) mask.set(x, y, 2);
  }
  return mask;
}

function drop(mask: Mask, x: number, y: number, monkey: MonkeyTune, physics: PhysicsTune) {
  const body = createBody(x, y);
  const collider = new CircleCollider(monkey.colliderRadius);
  for (let i = 0; i < 240; i++) stepCharacter(body, IDLE, mask, collider, physics, monkey, DT);
  return { body, collider };
}

describe('resting', () => {
  it('does not drift, sink or jitter over 1000 frames', () => {
    const physics = physicsFixture();
    const monkey = monkeyFixture();
    const mask = flatGround();
    const { body, collider } = drop(mask, 200, 40, monkey, physics);

    expect(body.grounded).toBe(true);
    expect(body.atRest).toBe(true);
    const settled = cloneBody(body);

    for (let frame = 0; frame < 1000; frame++) {
      stepCharacter(body, IDLE, mask, collider, physics, monkey, DT);
      expect(body.x, `drifted on frame ${frame}`).toBe(settled.x);
      expect(body.y, `sank or jittered on frame ${frame}`).toBe(settled.y);
      expect(body.grounded, `lost contact on frame ${frame}`).toBe(true);
    }
    expect(body.vx).toBe(0);
    expect(body.vy).toBe(0);
  });

  it('rests on a slope without sliding', () => {
    const physics = physicsFixture();
    const monkey = monkeyFixture();
    const mask = slope(4, 8);
    const { body, collider } = drop(mask, 200, 40, monkey, physics);
    const settled = cloneBody(body);
    for (let frame = 0; frame < 1000; frame++) {
      stepCharacter(body, IDLE, mask, collider, physics, monkey, DT);
    }
    expect(body.x).toBe(settled.x);
    expect(body.y).toBe(settled.y);
  });

  it('comes to rest above the ground, not inside it', () => {
    const physics = physicsFixture();
    const monkey = monkeyFixture();
    const mask = flatGround(400, 200, 120);
    const { body, collider } = drop(mask, 200, 40, monkey, physics);
    // Touching: clear where it stands, solid one pixel lower.
    expect(collider.overlaps(mask, body.x, body.y)).toBe(false);
    expect(collider.overlaps(mask, body.x, body.y + 1)).toBe(true);
  });

  it('declares rest only after the tuned number of quiet frames', () => {
    const physics = physicsFixture({ restFrames: 12 });
    const monkey = monkeyFixture();
    const mask = flatGround();
    const collider = new CircleCollider(monkey.colliderRadius);
    const body = createBody(200, 111);
    body.grounded = true;

    for (let i = 0; i < 11; i++) {
      stepCharacter(body, IDLE, mask, collider, physics, monkey, DT);
      expect(body.atRest).toBe(false);
    }
    stepCharacter(body, IDLE, mask, collider, physics, monkey, DT);
    expect(body.atRest).toBe(true);
  });
});

describe('stepped movement', () => {
  it('climbs a slope at the limit and refuses one above it', () => {
    const physics = physicsFixture({ maxStepHeight: 4 });
    const monkey = monkeyFixture();

    // 4 pixels up per pixel across is exactly the limit.
    const atLimit = slope(4, 1);
    const climbable = drop(atLimit, 40, 40, monkey, physics);
    const startX = climbable.body.x;
    const startY = climbable.body.y;
    for (let i = 0; i < 120; i++) {
      stepCharacter(climbable.body, { move: 1, jump: false }, atLimit, climbable.collider, physics, monkey, DT);
    }
    expect(climbable.body.x, 'should have climbed the slope at the limit').toBeGreaterThan(startX + 20);
    expect(climbable.body.y).toBeLessThan(startY);

    // 6 up per pixel across is past it.
    const tooSteep = slope(6, 1);
    const blocked = drop(tooSteep, 40, 40, monkey, physics);
    const blockedStartX = blocked.body.x;
    for (let i = 0; i < 120; i++) {
      stepCharacter(blocked.body, { move: 1, jump: false }, tooSteep, blocked.collider, physics, monkey, DT);
    }
    expect(blocked.body.x, 'should have refused the slope above the limit').toBeLessThan(
      blockedStartX + 4,
    );
  });

  it('stops at a wall rather than climbing it', () => {
    const physics = physicsFixture();
    const monkey = monkeyFixture();
    const mask = flatGround(400, 300, 200);
    for (let y = 100; y < 200; y++) {
      for (let x = 250; x < 262; x++) mask.set(x, y, 1);
    }
    const { body, collider } = drop(mask, 100, 40, monkey, physics);
    for (let i = 0; i < 300; i++) {
      stepCharacter(body, { move: 1, jump: false }, mask, collider, physics, monkey, DT);
    }
    expect(body.x).toBeLessThan(250);
    expect(body.x).toBeGreaterThan(200);
  });

  it('walks down a slope without going airborne', () => {
    const physics = physicsFixture();
    const monkey = monkeyFixture();
    // Descending to the right, within the snap distance per frame.
    const mask = new Mask(400, 300);
    for (let x = 0; x < 400; x++) {
      const top = 100 + Math.floor(x / 4);
      for (let y = top; y < 300; y++) mask.set(x, y, 2);
    }
    const { body, collider } = drop(mask, 40, 40, monkey, physics);
    let airborneFrames = 0;
    for (let i = 0; i < 200; i++) {
      stepCharacter(body, { move: 1, jump: false }, mask, collider, physics, monkey, DT);
      if (!body.grounded) airborneFrames++;
    }
    expect(body.x).toBeGreaterThan(100);
    expect(airborneFrames, 'should stay in contact walking downhill').toBe(0);
  });

  it('walks off a ledge and falls', () => {
    const physics = physicsFixture();
    const monkey = monkeyFixture();
    const mask = new Mask(400, 400);
    for (let y = 100; y < 130; y++) {
      for (let x = 0; x < 200; x++) mask.set(x, y, 2);
    }
    for (let y = 340; y < 400; y++) {
      for (let x = 0; x < 400; x++) mask.set(x, y, 2);
    }
    const { body, collider } = drop(mask, 100, 40, monkey, physics);
    expect(body.y).toBeLessThan(120);
    for (let i = 0; i < 400; i++) {
      stepCharacter(body, { move: 1, jump: false }, mask, collider, physics, monkey, DT);
    }
    expect(body.y).toBeGreaterThan(300);
  });

  it('reports how far it actually moved', () => {
    const physics = physicsFixture();
    const monkey = monkeyFixture();
    const mask = flatGround(400, 200, 120);
    const collider = new CircleCollider(monkey.colliderRadius);
    const body = createBody(200, 111);
    const moved = walk(body, 1, 3, mask, collider, physics);
    expect(moved).toBeCloseTo(3, 6);
    expect(body.x).toBeCloseTo(203, 6);
  });
});

describe('knockback', () => {
  it('takes an impulse, flies, and settles again', () => {
    const physics = physicsFixture();
    const monkey = monkeyFixture();
    const mask = flatGround(800, 400, 300);
    const { body, collider } = drop(mask, 100, 40, monkey, physics);
    const restingX = body.x;

    applyImpulse(body, 260, -300);
    expect(body.grounded).toBe(false);
    expect(body.atRest).toBe(false);

    let airborne = 0;
    for (let i = 0; i < 600; i++) {
      stepCharacter(body, IDLE, mask, collider, physics, monkey, DT);
      if (!body.grounded) airborne++;
      if (body.atRest) break;
    }
    expect(airborne).toBeGreaterThan(10);
    expect(body.atRest).toBe(true);
    expect(body.x).toBeGreaterThan(restingX + 20);
  });

  it('records the impact speed of a landing, for fall damage', () => {
    const physics = physicsFixture();
    const monkey = monkeyFixture();
    const mask = flatGround(400, 900, 800);
    const collider = new CircleCollider(monkey.colliderRadius);
    const body = createBody(200, 40);
    for (let i = 0; i < 400; i++) {
      stepCharacter(body, IDLE, mask, collider, physics, monkey, DT);
      if (body.atRest) break;
    }
    expect(body.lastImpactSpeed).toBeGreaterThan(600);
  });
});

describe('unsticking', () => {
  it('lifts a body placed with its centre on the surface, as spawns are', () => {
    const physics = physicsFixture();
    const monkey = monkeyFixture();
    const mask = flatGround(400, 300, 150);
    const collider = new CircleCollider(monkey.colliderRadius);
    const body = createBody(200, 150); // exactly what a spawn point gives
    stepCharacter(body, IDLE, mask, collider, physics, monkey, DT);
    expect(collider.overlaps(mask, body.x, body.y)).toBe(false);
    expect(body.grounded).toBe(true);
  });

  it('lifts a body buried a couple of diameters deep', () => {
    const physics = physicsFixture();
    const monkey = monkeyFixture();
    const mask = flatGround(400, 300, 150);
    const collider = new CircleCollider(monkey.colliderRadius);
    const body = createBody(200, 170);
    stepCharacter(body, IDLE, mask, collider, physics, monkey, DT);
    expect(collider.overlaps(mask, body.x, body.y)).toBe(false);
    expect(body.y).toBeLessThan(150);
  });

  it('leaves a genuinely entombed body where it is rather than flinging it', () => {
    // Deep inside a thick slab there is no sensible place to put it, and an
    // unbounded search would cost a column scan every frame. The turn machine
    // resolves this case, not the physics (SPEC §6.6).
    const physics = physicsFixture();
    const monkey = monkeyFixture();
    const mask = flatGround(400, 500, 100);
    const collider = new CircleCollider(monkey.colliderRadius);
    const body = createBody(200, 300);
    stepCharacter(body, IDLE, mask, collider, physics, monkey, DT);
    expect(body.y).toBe(300);
    expect(collider.overlaps(mask, body.x, body.y)).toBe(true);
  });
});

describe('determinism', () => {
  it('produces identical outcomes from identical inputs', () => {
    const physics = physicsFixture();
    const monkey = monkeyFixture();
    const inputs: CharacterInput[] = [];
    for (let i = 0; i < 400; i++) {
      inputs.push({ move: ((i % 7) - 3 > 0 ? 1 : (i % 7) - 3 < 0 ? -1 : 0) as -1 | 0 | 1, jump: i % 53 === 0 });
    }

    const run = () => {
      const mask = slope(3, 9, 600, 400, 300);
      const collider = new CircleCollider(monkey.colliderRadius);
      const body = createBody(120, 40);
      for (const input of inputs) {
        stepCharacter(body, input, mask, collider, physics, monkey, DT);
      }
      return cloneBody(body);
    };

    expect(run()).toEqual(run());
  });
});
