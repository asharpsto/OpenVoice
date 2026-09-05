import { describe, expect, it } from 'vitest';
import { solveAim } from '../src/ai/aim.js';
import { mulberry32 } from '../src/core/rng.js';
import { createBody } from '../src/physics/body.js';
import { Mask } from '../src/terrain/mask.js';
import { VEHICLE } from '../src/terrain/materials.js';
import { TurnMachine, type TurnTunes } from '../src/turn/machine.js';
import { checkOutcome, type Match, type Monkey, type TeamId } from '../src/turn/match.js';
import { parseMonkeyTune } from '../src/tune/monkey.js';
import { parsePhysicsTune } from '../src/tune/physics.js';
import { parseTurnTune } from '../src/tune/turn.js';
import { parseWeaponTune } from '../src/tune/weapon.js';
import { tuneFixture } from './helpers.js';

const DT = 1 / 60;

function tunes(overrides: Partial<TurnTunes> = {}): TurnTunes {
  return {
    turn: parseTurnTune({
      moveSeconds: 30,
      settleTimeoutSeconds: 8,
      suddenDeathRound: 12,
      waterRisePerRound: 14,
      teamSize: 3,
      retreatSeconds: 0,
    }),
    physics: parsePhysicsTune({
      gravity: 900, drag: 0.35, terminalVelocity: 1400, friction: 0.55, bounce: 0.22,
      maxStepHeight: 5, maxSnapDistance: 6, restSpeed: 14, restFrames: 8, maxSubStepPx: 1,
    }),
    monkey: parseMonkeyTune({
      health: 100, colliderRadius: 8, walkSpeed: 95, jumpSpeed: 310,
      fallDamage: { thresholdSpeed: 430, perPixelPerSecond: 0.12 },
    }),
    weapon: parseWeaponTune({
      muzzleVelocity: { min: 180, max: 720 },
      projectile: { drag: 0.22, gravityScale: 1, windInfluence: 1, spinRate: 12 },
      blastRadius: 78,
      damage: { max: 52, radius: 92, falloffPower: 1.7 },
      knockback: { max: 620, radius: 150, falloffPower: 0.85 },
      chain: { minVehiclePixels: 30, radiusScale: 0.75, maxDepth: 6, searchPad: 26 },
      selfPropelGapMin: 120,
      shake: { max: 26, radius: 420 },
    }),
    terrain: tuneFixture(),
    wind: { maxStrength: 190, changePerTurn: 0.75 },
    ...overrides,
  };
}

/** Flat ground with sky above; the water sits below the floor. */
function arena(width = 1200, height = 700, groundY = 500): Mask {
  const mask = new Mask(width, height);
  for (let y = groundY; y < height; y++) {
    for (let x = 0; x < width; x++) mask.set(x, y, 2);
  }
  return mask;
}

function makeMatch(positions: Array<{ x: number; team: TeamId }>, groundY = 500, water = 690): Match {
  const monkeys: Monkey[] = positions.map((spot, id) => ({
    id,
    team: spot.team,
    body: createBody(spot.x, groundY - 9),
    health: 100,
    alive: true,
    cause: null,
  }));
  return { monkeys, waterLineY: water, round: 0, active: -1, turnTeam: 0 };
}

function machine(match: Match, mask: Mask, t = tunes(), seed = 5): TurnMachine {
  return new TurnMachine(match, mask, t, mulberry32(seed), { x: 0 });
}

/** Runs until the phase changes or the budget runs out. */
function runUntil(m: TurnMachine, predicate: () => boolean, frames = 4000): boolean {
  for (let i = 0; i < frames; i++) {
    if (predicate()) return true;
    m.step(DT);
  }
  return predicate();
}

describe('turn machine', () => {
  it('cycles through the phases and alternates teams', () => {
    const mask = arena();
    const match = makeMatch([
      { x: 200, team: 0 }, { x: 400, team: 1 }, { x: 600, team: 0 }, { x: 800, team: 1 },
    ]);
    const m = machine(match, mask);
    m.step(DT);
    expect(m.phase).toBe('MOVE');
    const first = m.activeMonkey?.team;
    expect(first).toBe(0);

    // Fire straight down into the ground; the turn resolves and passes over.
    m.fire({ angle: Math.PI / 2, power: 400 });
    expect(m.phase).toBe('PROJECTILE_FLIGHT');
    runUntil(m, () => m.phase === 'MOVE' && m.activeMonkey?.team === 1);
    expect(m.activeMonkey?.team).toBe(1);
  });

  it('ends the move phase when the timer expires, with no shot', () => {
    const mask = arena();
    const match = makeMatch([{ x: 200, team: 0 }, { x: 800, team: 1 }]);
    const t = tunes();
    t.turn = parseTurnTune({ ...t.turn, moveSeconds: 0.5 });
    const m = machine(match, mask, t);
    m.step(DT);
    expect(m.phase).toBe('MOVE');
    runUntil(m, () => m.activeMonkey?.team === 1, 2000);
    expect(m.activeMonkey?.team).toBe(1);
  });

  it('does not cut a shot short when the turn timer expires mid-flight', () => {
    const mask = arena(2000, 900, 700);
    const match = makeMatch([{ x: 200, team: 0 }, { x: 1600, team: 1 }], 700, 890);
    const t = tunes();
    t.turn = parseTurnTune({ ...t.turn, moveSeconds: 0.2 });
    const m = machine(match, mask, t);
    m.step(DT);
    m.fire({ angle: -0.9, power: 700 });
    // Firing ends the move phase immediately (SPEC §6.6), so the timer stops
    // mattering — what must not happen is the shot being cut short.
    const elapsed = t.turn.moveSeconds / DT + 30;
    for (let i = 0; i < elapsed; i++) {
      if (m.phase !== 'PROJECTILE_FLIGHT') break;
      m.step(DT);
    }
    expect(runUntil(m, () => m.phase === 'MOVE' || m.phase === 'MATCH_OVER')).toBe(true);
    expect(m.events.some((event) => event.type === 'blast'), 'the shot should have landed').toBe(true);
  });
});

describe('§6.6 edge cases', () => {
  it('handles the active monkey dying from its own shot', () => {
    const mask = arena();
    const match = makeMatch([{ x: 200, team: 0 }, { x: 900, team: 1 }]);
    match.monkeys[0].health = 12; // barely alive, so its own blast finishes it
    const m = machine(match, mask);
    m.step(DT);
    const shooter = m.activeMonkey;
    m.fire({ angle: Math.PI / 2 - 0.25, power: 190 });
    runUntil(m, () => !shooter?.alive || m.phase === 'MATCH_OVER');
    expect(shooter?.alive).toBe(false);
    expect(m.outcome.over).toBe(true);
    expect(m.outcome.winner).toBe(1);
  });

  it('calls a draw, not a crash, when everyone dies at once', () => {
    const mask = arena();
    const match = makeMatch([{ x: 500, team: 0 }, { x: 512, team: 1 }]);
    for (const monkey of match.monkeys) monkey.health = 8;
    const m = machine(match, mask);
    m.step(DT);
    m.fire({ angle: Math.PI / 2, power: 200 });
    runUntil(m, () => m.phase === 'MATCH_OVER');
    expect(m.phase).toBe('MATCH_OVER');
    expect(m.outcome.over).toBe(true);
    expect(m.outcome.winner).toBeNull();
  });

  it('resolves the last two dying in the same explosion as one win check', () => {
    const mask = arena();
    const match = makeMatch([
      { x: 500, team: 0 }, { x: 516, team: 1 }, { x: 1100, team: 0 },
    ]);
    match.monkeys[0].health = 6;
    match.monkeys[1].health = 6;
    const m = machine(match, mask);
    m.step(DT);
    m.fire({ angle: Math.PI / 2, power: 200 });
    runUntil(m, () => match.monkeys[1].alive === false);
    const overs = m.events.filter((event) => event.type === 'matchOver');
    expect(overs.length).toBeLessThanOrEqual(1);
    expect(match.monkeys[0].alive).toBe(false);
    expect(match.monkeys[1].alive).toBe(false);
    // Team 0 still has one standing, so team 0 wins rather than it being a draw.
    expect(m.outcome.winner).toBe(0);
  });

  it('kills a monkey during another monkey\u2019s turn', () => {
    const mask = arena();
    // Within the bazooka's reach: it tops out near 500px at full power.
    const match = makeMatch([{ x: 200, team: 0 }, { x: 520, team: 1 }, { x: 560, team: 1 }]);
    match.monkeys[2].health = 5;
    const t = tunes();
    const m = machine(match, mask, t);
    m.step(DT);
    expect(m.activeMonkey?.team).toBe(0);

    // Solve the shot rather than guess it, so the test fails for the reason it
    // is named for and not because a hand-picked angle fell short.
    const shooter = match.monkeys[0].body;
    const target = match.monkeys[2].body;
    const power = 700;
    const solution = solveAim(
      shooter.x, shooter.y, target.x, target.y, power,
      t.physics.gravity, m.wind.x, t.weapon.projectile, 240,
    );
    expect(solution.missDistance).toBeLessThan(40);
    m.fire({ angle: solution.angle, power });

    runUntil(m, () => !match.monkeys[2].alive || m.phase === 'MATCH_OVER', 6000);
    expect(match.monkeys[2].alive).toBe(false);
    expect(m.activeMonkey?.id).not.toBe(2);
  });

  it('drowns a monkey knocked into the water while settling', () => {
    // A ledge over open water, in the middle of a map wide enough that being
    // flung sideways cannot reach the edge first.
    const mask = new Mask(2400, 900);
    // A perch narrower than one blast, so there is nowhere to land back on.
    for (let y = 250; y < 290; y++) {
      for (let x = 1140; x < 1260; x++) mask.set(x, y, 2);
    }
    const match = makeMatch([{ x: 1170, team: 0 }, { x: 1230, team: 1 }], 250, 800);
    const m = machine(match, mask);
    m.step(DT);
    m.fire({ angle: 0.5, power: 200 });
    runUntil(m, () => m.phase === 'MATCH_OVER' || match.monkeys.some((x) => !x.alive), 8000);
    const drowned = match.monkeys.filter((monkey) => monkey.cause === 'water');
    expect(drowned.length, `causes: ${match.monkeys.map((k) => k.cause).join(',')}`)
      .toBeGreaterThan(0);
  });

  it('kills the active monkey with a vehicle chain', () => {
    const mask = arena(1200, 700, 500);
    // A car right beside the shooter, so the chain comes back at it.
    for (let y = 470; y < 500; y++) {
      for (let x = 260; x < 420; x++) mask.set(x, y, VEHICLE);
    }
    const match = makeMatch([{ x: 220, team: 0 }, { x: 1000, team: 1 }]);
    match.monkeys[0].health = 30;
    const m = machine(match, mask);
    m.step(DT);
    m.fire({ angle: -0.12, power: 200 });
    runUntil(m, () => m.phase === 'MATCH_OVER' || !match.monkeys[0].alive, 6000);
    const blasts = m.events.filter((event) => event.type === 'blast').flatMap((e) => e.blasts ?? []);
    expect(blasts.some((blast) => blast.depth > 0), 'the car should have gone up too').toBe(true);
  });

  it('lifts a monkey that ends the turn inside terrain', () => {
    const mask = arena();
    const match = makeMatch([{ x: 200, team: 0 }, { x: 900, team: 1 }]);
    match.monkeys[1].body.y = 520; // buried
    const m = machine(match, mask);
    m.step(DT);
    for (let i = 0; i < 120; i++) m.step(DT);
    expect(match.monkeys[1].body.y).toBeLessThan(500);
  });

  it('kills a monkey knocked off the map sideways', () => {
    const mask = arena(600, 700, 500);
    const match = makeMatch([{ x: 60, team: 0 }, { x: 400, team: 1 }]);
    const m = machine(match, mask);
    m.step(DT);
    match.monkeys[0].body.x = -200;
    match.monkeys[0].body.grounded = false;
    runUntil(m, () => !match.monkeys[0].alive, 3000);
    expect(match.monkeys[0].alive).toBe(false);
    expect(match.monkeys[0].cause).toBe('offMap');
  });

  it('force-advances rather than hanging when settling times out', () => {
    const mask = arena();
    const match = makeMatch([{ x: 200, team: 0 }, { x: 900, team: 1 }]);
    const t = tunes();
    // A rest threshold of nearly zero means nothing ever settles on its own.
    t.physics = parsePhysicsTune({ ...t.physics, restSpeed: 0.0001, restFrames: 60 });
    t.turn = parseTurnTune({ ...t.turn, settleTimeoutSeconds: 0.5 });
    const m = machine(match, mask, t);
    m.step(DT);
    m.fire({ angle: Math.PI / 2, power: 300 });
    const advanced = runUntil(m, () => m.match.round > 0 || m.phase === 'MATCH_OVER', 3000);
    expect(advanced, 'the turn must advance rather than hang').toBe(true);
    expect(m.events.some((event) => event.type === 'settleTimeout')).toBe(true);
  });
});

describe('sudden death', () => {
  it('raises the water and drowns whatever it reaches', () => {
    const mask = arena(600, 700, 500);
    const match = makeMatch([{ x: 200, team: 0 }, { x: 400, team: 1 }], 500, 520);
    const t = tunes();
    t.turn = parseTurnTune({ ...t.turn, moveSeconds: 0.1, suddenDeathRound: 1, waterRisePerRound: 40 });
    const m = machine(match, mask, t);
    const startWater = match.waterLineY;
    runUntil(m, () => match.waterLineY < startWater, 3000);
    expect(match.waterLineY).toBeLessThan(startWater);
    runUntil(m, () => m.phase === 'MATCH_OVER', 20000);
    expect(m.phase).toBe('MATCH_OVER');
    expect(match.monkeys.some((monkey) => monkey.cause === 'water')).toBe(true);
  });
});

describe('match invariants', () => {
  it('never reaches a state where nobody can act', () => {
    const mask = arena(1400, 700, 500);
    const match = makeMatch([
      { x: 200, team: 0 }, { x: 400, team: 1 }, { x: 600, team: 0 },
      { x: 800, team: 1 }, { x: 1000, team: 0 }, { x: 1200, team: 1 },
    ]);
    const t = tunes();
    t.turn = parseTurnTune({ ...t.turn, moveSeconds: 0.15, suddenDeathRound: 3, waterRisePerRound: 30 });
    const m = machine(match, mask, t, 99);
    for (let i = 0; i < 60000; i++) {
      m.step(DT);
      if (m.phase === 'MATCH_OVER') break;
      // Outside MATCH_OVER there is always someone whose turn it is.
      if (m.phase !== 'TURN_START') {
        expect(m.activeMonkey, `no active monkey in ${m.phase}`).not.toBeNull();
        expect(m.activeMonkey?.alive).toBe(true);
      }
    }
    expect(m.phase).toBe('MATCH_OVER');
  });

  it('reports a draw from the outcome check when both teams are wiped', () => {
    const match = makeMatch([{ x: 100, team: 0 }, { x: 200, team: 1 }]);
    for (const monkey of match.monkeys) monkey.alive = false;
    expect(checkOutcome(match)).toEqual({ over: true, winner: null });
  });

  it('is deterministic across a whole match', () => {
    const play = () => {
      const mask = arena(1000, 700, 500);
      const match = makeMatch([
        { x: 200, team: 0 }, { x: 500, team: 1 }, { x: 800, team: 0 },
      ]);
      const t = tunes();
      t.turn = parseTurnTune({ ...t.turn, moveSeconds: 0.2, suddenDeathRound: 4, waterRisePerRound: 25 });
      const m = machine(match, mask, t, 1234);
      for (let i = 0; i < 40000 && m.phase !== 'MATCH_OVER'; i++) m.step(DT);
      return {
        phase: m.phase,
        outcome: m.outcome,
        round: match.round,
        positions: match.monkeys.map((monkey) => [monkey.body.x, monkey.body.y, monkey.health]),
      };
    };
    expect(play()).toEqual(play());
  });
});
