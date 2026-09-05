import { CircleCollider } from '../physics/collider.js';
import { IDLE, stepCharacter, type CharacterInput } from '../physics/controller.js';
import type { Mask } from '../terrain/mask.js';
import type { MonkeyTune } from '../tune/monkey.js';
import { fallDamageFor } from '../tune/monkey.js';
import type { PhysicsTune } from '../tune/physics.js';
import type { TerrainTune } from '../tune/terrain.js';
import type { TurnTune } from '../tune/turn.js';
import type { WeaponTune } from '../tune/weapon.js';
import { applyBlast } from '../weapon/explosion.js';
import { resolveBlastChain, type Blast } from '../weapon/chain.js';
import { launch, stepProjectile, type Projectile } from '../weapon/projectile.js';
import { nextWind, type Wind, type WindTune } from '../wind/wind.js';
import type { Rng } from '../core/rng.js';
import { checkOutcome, hurt, livingOf, pendingDeaths, type Match, type MatchOutcome, type Monkey, type TeamId } from './match.js';

/**
 * The turn state machine (SPEC §6.6).
 *
 *   TURN_START → MOVE (timed) → AIM → FIRING → PROJECTILE_FLIGHT
 *     → RESOLUTION → SETTLE_WAIT → [win check] → TURN_START
 *
 * Everything here is deterministic and steppable without a renderer, because
 * the edge cases below are the ones that hang or crash a match and they need
 * to be testable rather than played for.
 */

export type TurnPhase =
  | 'TURN_START'
  | 'MOVE'
  | 'AIM'
  | 'FIRING'
  | 'PROJECTILE_FLIGHT'
  | 'RESOLUTION'
  | 'SETTLE_WAIT'
  | 'MATCH_OVER';

export interface TurnTunes {
  turn: TurnTune;
  physics: PhysicsTune;
  monkey: MonkeyTune;
  weapon: WeaponTune;
  terrain: TerrainTune;
  wind: WindTune;
}

export interface Shot {
  angle: number;
  power: number;
}

/** Something worth reporting: a death, a settle timeout, a chain, the result. */
export interface TurnEvent {
  type:
    | 'turnStart'
    | 'fired'
    | 'blast'
    | 'death'
    | 'settleTimeout'
    | 'suddenDeath'
    | 'matchOver';
  monkeyId?: number;
  detail?: string;
  blasts?: Blast[];
  outcome?: MatchOutcome;
}

export class TurnMachine {
  phase: TurnPhase = 'TURN_START';
  /** Seconds left in the move phase. Firing ends it immediately. */
  timer = 0;
  wind: Wind;
  projectile: Projectile | null = null;
  outcome: MatchOutcome = { over: false, winner: null };
  readonly events: TurnEvent[] = [];
  /** Dirty rects from this turn's blasts, for the renderer to upload. */
  pendingBlasts: Blast[] = [];

  private settleElapsed = 0;
  private retreatElapsed = 0;
  private readonly collider: CircleCollider;

  constructor(
    readonly match: Match,
    readonly mask: Mask,
    private readonly tunes: TurnTunes,
    private readonly rng: Rng,
    wind: Wind,
  ) {
    this.wind = wind;
    this.collider = new CircleCollider(tunes.monkey.colliderRadius);
  }

  /** Rebuilt when the collider radius is retuned mid-session. */
  get activeMonkey(): Monkey | null {
    return this.match.active >= 0 ? (this.match.monkeys[this.match.active] ?? null) : null;
  }

  /** The player (or AI) commits a shot. Only legal while moving or aiming. */
  fire(shot: Shot): boolean {
    if (this.phase !== 'MOVE' && this.phase !== 'AIM') return false;
    const monkey = this.activeMonkey;
    if (!monkey?.alive) return false;
    const offset = this.collider.radius + 5;
    this.projectile = launch(
      monkey.body.x + Math.cos(shot.angle) * offset,
      monkey.body.y + Math.sin(shot.angle) * offset,
      shot.angle,
      shot.power,
    );
    this.phase = 'PROJECTILE_FLIGHT';
    this.events.push({ type: 'fired', monkeyId: monkey.id });
    return true;
  }

  /** Marks the player as aiming, which is still inside the move timer. */
  beginAim(): void {
    if (this.phase === 'MOVE') this.phase = 'AIM';
  }

  cancelAim(): void {
    if (this.phase === 'AIM') this.phase = 'MOVE';
  }

  step(dt: number, input: CharacterInput = IDLE): void {
    switch (this.phase) {
      case 'TURN_START':
        this.startTurn();
        break;
      case 'MOVE':
      case 'AIM':
        this.stepMove(dt, input);
        break;
      case 'PROJECTILE_FLIGHT':
        this.stepFlight(dt);
        break;
      case 'RESOLUTION':
        this.resolve();
        break;
      case 'SETTLE_WAIT':
        this.stepSettle(dt);
        break;
      case 'FIRING':
      case 'MATCH_OVER':
        break;
    }
  }

  private startTurn(): void {
    const next = this.nextMonkey();
    if (next === -1) {
      this.finish();
      return;
    }
    this.match.active = next;
    this.match.turnTeam = this.match.monkeys[next].team;
    this.timer = this.tunes.turn.moveSeconds;
    this.retreatElapsed = 0;
    this.settleElapsed = 0;
    this.wind = nextWind(this.wind, this.rng, this.tunes.wind);
    this.phase = 'MOVE';
    this.events.push({ type: 'turnStart', monkeyId: this.match.monkeys[next].id });
  }

  /** Alternates teams, then rotates within the team. */
  private nextMonkey(): number {
    const wanted: TeamId = this.match.active === -1 ? 0 : ((1 - this.match.turnTeam) as TeamId);
    for (const team of [wanted, (1 - wanted) as TeamId]) {
      const living = livingOf(this.match, team);
      if (living.length === 0) continue;
      const after = this.match.active;
      const nextInTeam =
        living.find((monkey) => this.match.monkeys.indexOf(monkey) > after) ?? living[0];
      return this.match.monkeys.indexOf(nextInTeam);
    }
    return -1;
  }

  private stepMove(dt: number, input: CharacterInput): void {
    this.timer -= dt;
    this.stepBodies(dt, input);
    if (this.resolveDeaths()) return;
    if (this.timer <= 0) {
      // Time up without a shot: settle whatever is moving, then move on.
      this.phase = 'SETTLE_WAIT';
      this.settleElapsed = 0;
    }
  }

  private stepFlight(dt: number): void {
    const projectile = this.projectile;
    if (!projectile) {
      this.phase = 'RESOLUTION';
      return;
    }
    // The move timer keeps running, but a shot already in the air is never
    // cut short by it — the turn ends when the banana lands, not before.
    const step = stepProjectile(
      projectile,
      dt,
      this.mask,
      this.tunes.physics.gravity,
      this.wind.x,
      this.tunes.weapon.projectile,
      this.tunes.terrain.query.raycastStepPx,
    );
    this.stepBodies(dt, IDLE);
    if (step.hit) {
      this.phase = 'RESOLUTION';
      return;
    }
    if (step.offMap || projectile.age > 15) {
      this.projectile = null;
      this.phase = 'SETTLE_WAIT';
      this.settleElapsed = 0;
    }
  }

  /** One RESOLUTION resolves the whole chain, not just the first blast. */
  private resolve(): void {
    const projectile = this.projectile;
    this.projectile = null;
    if (projectile) {
      const chain = resolveBlastChain(
        this.mask,
        projectile.x,
        projectile.y,
        this.tunes.weapon.blastRadius,
        this.tunes.terrain,
        this.tunes.weapon,
      );
      this.pendingBlasts.push(...chain.blasts);
      const bodies = this.match.monkeys.map((monkey) => monkey.body);
      for (const blast of chain.blasts) {
        for (const effect of applyBlast(bodies, blast.x, blast.y, this.tunes.weapon)) {
          const monkey = this.match.monkeys[effect.index];
          if (!monkey.alive) continue;
          hurt(monkey, effect.damage, blast.depth === 0 ? 'blast' : 'chain');
        }
      }
      this.events.push({ type: 'blast', blasts: chain.blasts });
      if (chain.cappedOut) {
        this.events.push({ type: 'settleTimeout', detail: 'chain hit its depth cap' });
      }
    }
    this.phase = 'SETTLE_WAIT';
    this.settleElapsed = 0;
    this.retreatElapsed = 0;
  }

  private stepSettle(dt: number): void {
    this.settleElapsed += dt;
    this.retreatElapsed += dt;
    this.stepBodies(dt, IDLE);
    if (this.resolveDeaths()) return;

    if (this.settleElapsed >= this.tunes.turn.settleTimeoutSeconds) {
      // A monkey oscillating in a crater bowl may never rest. Freeze everything
      // and move on rather than hang; repeated timeouts mean restSpeed is wrong.
      for (const monkey of this.match.monkeys) {
        monkey.body.vx = 0;
        monkey.body.vy = 0;
        monkey.body.atRest = true;
      }
      this.events.push({ type: 'settleTimeout', detail: 'forced the turn to advance' });
      this.endTurn();
      return;
    }
    const settled = this.match.monkeys.every((monkey) => !monkey.alive || monkey.body.atRest);
    if (settled && this.retreatElapsed >= this.tunes.turn.retreatSeconds) this.endTurn();
  }

  private stepBodies(dt: number, input: CharacterInput): void {
    const active = this.activeMonkey;
    for (const monkey of this.match.monkeys) {
      if (!monkey.alive) continue;
      const wasAirborne = !monkey.body.grounded;
      stepCharacter(
        monkey.body,
        monkey === active && (this.phase === 'MOVE' || this.phase === 'AIM') ? input : IDLE,
        this.mask,
        this.collider,
        this.tunes.physics,
        this.tunes.monkey,
        dt,
      );
      if (wasAirborne && monkey.body.grounded && monkey.body.lastImpactSpeed > 0) {
        hurt(monkey, fallDamageFor(monkey.body.lastImpactSpeed, this.tunes.monkey), 'fall');
        monkey.body.lastImpactSpeed = 0;
      }
      // Water is instant death, and so is leaving the map sideways.
      if (monkey.body.y - this.collider.radius > this.match.waterLineY) {
        monkey.health = 0;
        monkey.cause = 'water';
      } else if (monkey.body.x < -this.collider.radius * 4 || monkey.body.x > this.mask.width + this.collider.radius * 4) {
        monkey.health = 0;
        monkey.cause = 'offMap';
      }
    }
  }

  /**
   * Removes everything that died, all at once, then runs the win check once.
   * Returns true when the match ended.
   */
  private resolveDeaths(): boolean {
    const dying = pendingDeaths(this.match);
    if (dying.length === 0) return false;
    for (const monkey of dying) {
      monkey.alive = false;
      monkey.health = 0;
      this.events.push({ type: 'death', monkeyId: monkey.id, detail: monkey.cause ?? 'blast' });
    }
    const outcome = checkOutcome(this.match);
    if (outcome.over) {
      this.outcome = outcome;
      this.finish();
      return true;
    }
    return false;
  }

  private endTurn(): void {
    if (this.resolveDeaths()) return;
    this.match.round++;
    this.applySuddenDeath();
    if (this.resolveDeaths()) return;
    this.phase = 'TURN_START';
  }

  /** Rising water after N rounds. More dramatic than a health drop (§6.6). */
  private applySuddenDeath(): void {
    const { suddenDeathRound, waterRisePerRound } = this.tunes.turn;
    if (this.match.round < suddenDeathRound) return;
    this.match.waterLineY -= waterRisePerRound;
    this.events.push({
      type: 'suddenDeath',
      detail: `water at y=${this.match.waterLineY}`,
    });
    for (const monkey of this.match.monkeys) {
      if (!monkey.alive) continue;
      if (monkey.body.y - this.collider.radius > this.match.waterLineY) {
        monkey.health = 0;
        monkey.cause = 'water';
      }
    }
  }

  private finish(): void {
    this.outcome = checkOutcome(this.match);
    this.phase = 'MATCH_OVER';
    this.events.push({ type: 'matchOver', outcome: this.outcome });
  }
}
