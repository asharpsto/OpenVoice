import type { Body } from '../physics/body.js';

/**
 * Match state: two teams of monkeys, the water line, and the round counter
 * (SPEC §6.2, §6.6).
 *
 * Deliberately plain data with no physics or rendering in it, so the turn
 * machine can be driven and every §6.6 edge case tested headlessly.
 */

export type TeamId = 0 | 1;

export const TEAM_NAMES = ['A', 'B'] as const;

/** Why a monkey died, for the telemetry in SPEC §8. */
export type DeathCause = 'blast' | 'fall' | 'water' | 'chain' | 'offMap';

export interface Monkey {
  id: number;
  team: TeamId;
  body: Body;
  health: number;
  alive: boolean;
  /** Set when it dies; kept so the match log can say what happened. */
  cause: DeathCause | null;
}

export interface Match {
  monkeys: Monkey[];
  /** Row of the water surface. Rises during sudden death. */
  waterLineY: number;
  /** Completed rounds. A round is one turn for every living monkey. */
  round: number;
  /** Index into `monkeys` of whoever is up. -1 before the first turn. */
  active: number;
  /** Whose go it is at team level, so turns alternate between the teams. */
  turnTeam: TeamId;
}

export function livingOf(match: Match, team: TeamId): Monkey[] {
  return match.monkeys.filter((monkey) => monkey.alive && monkey.team === team);
}

export function isAlive(monkey: Monkey): boolean {
  return monkey.alive;
}

/**
 * Damage a monkey. Health hitting zero does not kill it here — deaths queue
 * and resolve together so a single explosion that kills two monkeys produces
 * one win check, not two (SPEC §6.6).
 */
export function hurt(monkey: Monkey, amount: number, cause: DeathCause): void {
  if (!monkey.alive || amount <= 0) return;
  monkey.health -= amount;
  if (monkey.health <= 0 && monkey.cause === null) monkey.cause = cause;
}

/** Everything whose health has run out but which has not yet been removed. */
export function pendingDeaths(match: Match): Monkey[] {
  return match.monkeys.filter((monkey) => monkey.alive && monkey.health <= 0);
}

export interface MatchOutcome {
  over: boolean;
  /** Winning team, or null for a draw. Only meaningful when `over`. */
  winner: TeamId | null;
}

/**
 * Win check. Runs once after each batch of deaths resolves.
 *
 * Both teams wiped in the same explosion is a draw, not a crash — it is a
 * genuinely reachable state whenever the last two die together.
 */
export function checkOutcome(match: Match): MatchOutcome {
  const a = livingOf(match, 0).length;
  const b = livingOf(match, 1).length;
  if (a === 0 && b === 0) return { over: true, winner: null };
  if (a === 0) return { over: true, winner: 1 };
  if (b === 0) return { over: true, winner: 0 };
  return { over: false, winner: null };
}
