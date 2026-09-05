/**
 * Plays whole matches in a real browser and checks they finish.
 *
 * The exit criterion for stage 5 is that every §6.6 edge case is tested, and
 * those tests are headless. This checks the other half: that the machine wired
 * to a renderer and an AI actually reaches a result, repeatedly, without
 * hanging or throwing.
 *
 *   npm run smoke:match
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const PORT = 5186;
const URL = `http://127.0.0.1:${PORT}/`;
const OUT_DIR = 'tools/smoke/out';
const MATCHES = 3;

const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
let serverLog = '';
server.stdout.on('data', (chunk: Buffer) => (serverLog += chunk.toString()));
server.stderr.on('data', (chunk: Buffer) => (serverLog += chunk.toString()));

function stopServer(): void {
  if (server.pid === undefined || server.killed) return;
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    server.kill('SIGTERM');
  }
}
process.on('exit', stopServer);

function fail(message: string): never {
  console.error(`MATCH SMOKE FAIL: ${message}`);
  console.error(`--- vite log ---\n${serverLog.slice(-1500)}`);
  stopServer();
  process.exit(1);
}

function findChromium(): string {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const found = existsSync(root)
    ? readdirSync(root)
        .filter((name) => name.startsWith('chromium'))
        .sort()
        .reverse()
        .map((name) => join(root, name, 'chrome-linux', 'chrome'))
        .find((path) => existsSync(path))
    : undefined;
  if (!found) throw new Error(`No Chromium under ${root}; set CHROMIUM_PATH`);
  return found;
}

async function waitForServer(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(URL)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Vite did not start in ${timeoutMs}ms:\n${serverLog}`);
}

/** Drives the match off the render loop so a whole game runs in seconds. */
const PLAY = `(() => {
  const b = globalThis.banana;
  b.setAi('both');
  b.turn.match.round = 0;
  for (let i = 0; i < 240000; i++) {
    b.step(1);
    if (b.turn.phase === 'MATCH_OVER') break;
  }
  const m = b.turn.match;
  return {
    phase: b.turn.phase,
    winner: b.turn.outcome.winner,
    over: b.turn.outcome.over,
    round: m.round,
    alive: m.monkeys.filter((k) => k.alive).length,
    causes: m.monkeys.map((k) => k.cause),
    events: b.turn.events.length,
    timeouts: b.turn.events.filter((e) => e.type === 'settleTimeout').length,
  };
})()`;

async function run(): Promise<void> {
  await waitForServer();
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (message.location().url.endsWith('/favicon.ico')) return;
    problems.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction('globalThis.banana !== undefined');
  await page.waitForTimeout(600);

  let totalTimeouts = 0;
  for (let i = 0; i < MATCHES; i++) {
    const result = (await page.evaluate(PLAY)) as {
      phase: string;
      winner: number | null;
      over: boolean;
      round: number;
      alive: number;
      causes: Array<string | null>;
      events: number;
      timeouts: number;
    };
    if (result.phase !== 'MATCH_OVER') {
      fail(`match ${i + 1} did not finish: still in ${result.phase} after ${result.round} rounds`);
    }
    if (!result.over) fail(`match ${i + 1} ended without an outcome`);
    totalTimeouts += result.timeouts;
    const causes = result.causes.filter(Boolean).join(', ') || 'none';
    console.log(
      `match ${i + 1}: ${result.winner === null ? 'draw' : `team ${result.winner === 0 ? 'A' : 'B'}`}` +
        ` after ${result.round} rounds · ${result.alive} left · deaths by ${causes}` +
        ` · ${result.timeouts} settle timeout(s)`,
    );
    if (i + 1 < MATCHES) {
      await page.keyboard.press('n');
      await page.waitForTimeout(300);
    }
  }

  await page.screenshot({ path: `${OUT_DIR}/match.png` });
  await browser.close();
  stopServer();

  if (problems.length > 0) fail(`page reported errors:\n${problems.join('\n')}`);
  // Settle timeouts should be near zero; SPEC §8 tracks them for that reason.
  if (totalTimeouts > MATCHES * 2) {
    fail(`${totalTimeouts} settle timeouts across ${MATCHES} matches — restSpeed is probably wrong`);
  }
  console.log(`\nMATCH SMOKE PASS: ${MATCHES} matches ran to a result, ${totalTimeouts} settle timeouts.`);
}

run().catch((error: unknown) => {
  console.error(error);
  fail('smoke run threw');
});
