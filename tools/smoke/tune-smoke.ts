/**
 * Stage 3 exit criteria that only a browser and a filesystem can prove:
 * "sliders live, write-back working" (SPEC §12).
 *
 * Checks both directions of the tuning harness — a slider changing the file on
 * disk, and an edit on disk reaching the running game — and that the stepped
 * controller settles the grey circles it drops onto the map.
 *
 *   npm run smoke:tune
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const PORT = 5185;
const URL = `http://127.0.0.1:${PORT}/`;
const PHYSICS = 'tune/physics.json';

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

let original = '';
async function restore(): Promise<void> {
  if (original) await writeFile(PHYSICS, original, 'utf8');
}

async function fail(message: string): Promise<never> {
  await restore();
  console.error(`TUNE SMOKE FAIL: ${message}`);
  console.error(`--- vite log ---\n${serverLog.slice(-2000)}`);
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

async function diskGravity(): Promise<number> {
  return (JSON.parse(await readFile(PHYSICS, 'utf8')) as { gravity: number }).gravity;
}

async function run(): Promise<void> {
  original = await readFile(PHYSICS, 'utf8');
  await waitForServer();
  const browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (message.location().url.endsWith('/favicon.ico')) return;
    problems.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));

  await page.goto(URL, { waitUntil: 'load' });
  try {
    await page.waitForFunction('globalThis.banana !== undefined');
  } catch {
    await fail(`the harness never started:\n${problems.join('\n') || '(no page errors reported)'}`);
  }
  await page.waitForSelector('#tune-overlay');

  const sliders = await page.locator('#tune-overlay input[type=range]').count();
  if (sliders < 20) await fail(`only ${sliders} sliders in the overlay`);

  // 1. The controller drops grey circles that settle rather than jitter.
  await page.evaluate('globalThis.banana.step(600)');
  const rested = (await page.evaluate(
    '(() => globalThis.banana.bodies.filter((b) => b.grounded && b.atRest).length)()',
  )) as number;
  const total = (await page.evaluate('globalThis.banana.bodies.length')) as number;
  if (total === 0) await fail('no bodies were spawned');
  if (rested !== total) await fail(`only ${rested} of ${total} bodies came to rest`);

  // 2. A slider changes the live tuning immediately...
  const startGravity = await diskGravity();
  const target = startGravity === 1500 ? 1200 : 1500;
  await page.evaluate(`(() => {
    const inputs = [...document.querySelectorAll('#tune-overlay input[type=range]')];
    const labels = [...document.querySelectorAll('#tune-overlay .field > label')];
    const index = labels.findIndex((l) => l.textContent === 'gravity');
    const input = inputs[index];
    input.value = '${target}';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const live = (await page.evaluate('globalThis.banana.physics.gravity')) as number;
  if (live !== target) await fail(`slider moved to ${target} but live gravity is ${live}`);

  // ...and lands on disk.
  await page.waitForTimeout(1200);
  const saved = await diskGravity();
  if (saved !== target) await fail(`write-back failed: disk still says ${saved}, wanted ${target}`);

  // 3. An edit on disk reaches the running game — without reloading the page,
  // which would throw away whatever was being tuned against.
  await page.evaluate('globalThis.__tuneReloadSentinel = true');
  const edited = target === 1500 ? 777 : 888;
  const contents = JSON.parse(original) as Record<string, unknown>;
  contents.gravity = edited;
  await writeFile(PHYSICS, `${JSON.stringify(contents, null, 2)}\n`, 'utf8');
  await page.waitForFunction(`globalThis.banana?.physics?.gravity === ${edited}`, undefined, {
    timeout: 15_000,
  });
  // The readout, not the slider position: a hand-edited value need not sit on
  // the slider's step grid, and the thumb snaps where the number must not.
  const shown = (await page.evaluate(`(() => {
    const labels = [...document.querySelectorAll('#tune-overlay .field > label')];
    const outputs = [...document.querySelectorAll('#tune-overlay .field > output')];
    return outputs[labels.findIndex((l) => l.textContent === 'gravity')].textContent;
  })()`)) as string;
  if (Number(shown) !== edited) await fail(`hot reload left the readout showing ${shown}`);
  const survived = (await page.evaluate('globalThis.__tuneReloadSentinel === true')) as boolean;
  if (!survived) await fail('the page reloaded instead of hot-reloading the tuning');

  // 4. Tuning that would not load is rejected rather than applied.
  await page.evaluate(`(() => {
    const labels = [...document.querySelectorAll('#tune-overlay .field > label')];
    const inputs = [...document.querySelectorAll('#tune-overlay input[type=range]')];
    const input = inputs[labels.findIndex((l) => l.textContent === 'maxSubStepPx')];
    input.min = '0';
    input.value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const stillValid = (await page.evaluate('globalThis.banana.physics.maxSubStepPx')) as number;
  if (!(stillValid > 0)) await fail('an invalid slider value was applied to the live tuning');

  await page.screenshot({ path: 'tools/smoke/out/tuning.png' });
  await browser.close();
  await restore();
  stopServer();

  if (problems.length > 0) {
    console.error(`TUNE SMOKE FAIL: page reported errors:\n${problems.join('\n')}`);
    process.exit(1);
  }
  console.log(
    `TUNE SMOKE PASS: ${sliders} sliders live; ${total}/${total} bodies at rest;` +
      ` slider -> disk (${target}); disk -> game (${edited}); invalid values rejected.`,
  );
  console.log('screenshot: tools/smoke/out/tuning.png');
}

run().catch(async (error: unknown) => {
  console.error(error);
  await fail('smoke run threw');
});
