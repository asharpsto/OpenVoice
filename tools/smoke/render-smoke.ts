/**
 * Boots the dev harness in headless Chromium and drives it, so the WebGL path
 * is actually exercised rather than merely compiled.
 *
 * What this proves: the terrain shader links, the RG8 mask texture allocates,
 * dirty-rect `texSubImage2D` uploads run without GL errors, and a map baked by
 * `pipeline/bake.ts` loads and renders through `loadMap`.
 *
 * What it does NOT prove: performance. Headless Chromium renders on SwiftShader
 * (CPU), so its timings say nothing about a mid-range Android. The frame budget
 * is checked by `npm run bench:blit` for the CPU side and by opening this page
 * on a real device for the GPU side.
 *
 *   npm run smoke
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const PORT = 5183;
const URL = `http://127.0.0.1:${PORT}/`;
/** Playwright's bundled Chromium; the folder carries a build number. */
function findChromium(): string {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const candidates = existsSync(root)
    ? readdirSync(root)
        .filter((name) => name.startsWith('chromium'))
        .sort()
        .reverse()
        .map((name) => join(root, name, 'chrome-linux', 'chrome'))
    : [];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error(`No Chromium under ${root}; set CHROMIUM_PATH`);
  return found;
}
const OUT_DIR = 'tools/smoke/out';
const FIXTURE_SRC = 'tools/smoke/out/fixture-src';
const FIXTURE_WIDTH = 1200;
const FIXTURE_HEIGHT = 800;

// Its own process group, so stopping it stops Vite and not just the npx
// wrapper — a leaked dev server would hold the port for the next run.
const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});

function stopServer(): void {
  if (server.pid === undefined || server.killed) return;
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    server.kill('SIGTERM');
  }
}
process.on('exit', stopServer);
let serverLog = '';
server.stdout.on('data', (chunk: Buffer) => (serverLog += chunk.toString()));
server.stderr.on('data', (chunk: Buffer) => (serverLog += chunk.toString()));

async function waitForServer(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(URL);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Vite did not start in ${timeoutMs}ms:\n${serverLog}`);
}

function fail(message: string): never {
  console.error(`SMOKE FAIL: ${message}`);
  stopServer();
  process.exit(1);
}

async function run(): Promise<void> {
  await waitForServer();
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });

  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // The browser asking for a favicon we do not ship is not a rendering fault.
    const location = message.location().url;
    if (location.endsWith('/favicon.ico')) return;
    problems.push(`console: ${message.text()} (${location})`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('response', (response) => {
    if (response.status() < 400) return;
    if (response.url().endsWith('/favicon.ico')) return;
    problems.push(`http ${response.status()}: ${response.url()}`);
  });

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(
    () => (document.getElementById('hud')?.textContent ?? '').includes('map '),
    undefined,
    { timeout: 30_000 },
  );

  const hudBefore = (await page.textContent('#hud')) ?? '';
  if (!hudBefore.includes('validate ok')) fail(`map validation failed:\n${hudBefore}`);

  // Fire a burst of craters through the real GL upload path.
  await page.keyboard.press('3');
  await page.keyboard.press('s');
  await page.waitForFunction(
    () => !(document.getElementById('hud')?.textContent ?? '').includes('stress'),
    undefined,
    { timeout: 120_000 },
  );
  await page.screenshot({ path: `${OUT_DIR}/terrain.png` });

  const hud = (await page.textContent('#hud')) ?? '';
  const measured = Number(/\((\d+) craters measured\)/.exec(hud)?.[1] ?? 0);
  const glErrors = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const gl = canvas?.getContext('webgl2');
    return gl ? gl.getError() : -1;
  });

  console.log(hud);
  if (problems.length > 0) fail(`page reported errors:\n${problems.join('\n')}`);
  if (measured < 100) fail(`expected 100+ craters through the GL path, measured ${measured}`);
  if (glErrors !== 0) fail(`WebGL context reported error ${glErrors}`);

  // Second pass: the same renderer fed by a map that went through the baker.
  await bakeFixture();
  problems.length = 0;
  await page.goto(`${URL}?map=/maps/fixture/map.json`, { waitUntil: 'load' });
  await page.waitForFunction(
    () => (document.getElementById('hud')?.textContent ?? '').includes('map '),
    undefined,
    { timeout: 30_000 },
  );
  await page.keyboard.press('1');
  for (let i = 0; i < 5; i++) {
    await page.mouse.click(300 + i * 60, 420);
    await page.waitForTimeout(60);
  }
  const bakedHud = (await page.textContent('#hud')) ?? '';
  await page.screenshot({ path: `${OUT_DIR}/baked-map.png` });

  await browser.close();
  stopServer();

  console.log(`\n${bakedHud}`);
  if (problems.length > 0) fail(`baked map reported errors:\n${problems.join('\n')}`);
  if (!bakedHud.includes('validate ok')) fail(`baked map failed validation:\n${bakedHud}`);
  if (!bakedHud.includes(`${FIXTURE_WIDTH}x`)) fail(`baked map did not load at its baked size`);
  if (/\(0 craters measured\)/.test(bakedHud)) fail('no craters landed on the baked map');

  console.log(`\nSMOKE PASS: ${measured} craters uploaded via texSubImage2D, no GL errors.`);
  console.log(`           baked map loaded through loadMap and destroyed cleanly.`);
  console.log(`screenshots: ${OUT_DIR}/terrain.png, ${OUT_DIR}/baked-map.png`);
}

/** Bakes a stand-in photo/mask pair into public/, where Vite will serve it. */
async function bakeFixture(): Promise<void> {
  await rm(FIXTURE_SRC, { recursive: true, force: true });
  await rm('public/maps/fixture', { recursive: true, force: true });
  sh('npx', ['tsx', 'tools/fixture-map.ts', FIXTURE_SRC, String(FIXTURE_WIDTH), String(FIXTURE_HEIGHT)]);
  sh('npx', [
    'tsx', 'pipeline/bake.ts',
    '--photo', `${FIXTURE_SRC}/photo.png`,
    '--mask', `${FIXTURE_SRC}/mask.png`,
    '--id', 'fixture',
    '--name', 'Fixture Street',
    '--out', 'public/maps',
  ]);
}

function sh(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited ${String(result.status)}`);
}

run().catch((error: unknown) => {
  console.error(error);
  fail('smoke run threw');
});
