/**
 * Drives the mask tool in headless Chromium: load a photo, seed, paint, fill,
 * despeckle, validate, export.
 *
 * The export check is the one that matters. A mask is material IDs stored as
 * pixel values, so it has to survive PNG encode and decode byte for byte —
 * if it does not, terrain silently stops matching what was painted.
 *
 *   npm run smoke:masktool
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Download } from 'playwright-core';
import { PNG } from 'pngjs';

const PORT = 5184;
const URL = `http://127.0.0.1:${PORT}/tools/masktool/`;
const OUT_DIR = 'tools/smoke/out/masktool';
const PHOTO_DIR = 'tools/smoke/out/masktool-src';
const PHOTO_WIDTH = 900;
const PHOTO_HEIGHT = 600;

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
  console.error(`MASKTOOL SMOKE FAIL: ${message}`);
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

const SOLID_FRACTION = `(() => {
  const data = globalThis.masktool.maskData;
  let solid = 0;
  for (let i = 0; i < data.length; i++) if (data[i] !== 0) solid++;
  return solid / data.length;
})()`;

async function run(): Promise<void> {
  await rm(OUT_DIR, { recursive: true, force: true });
  await rm(PHOTO_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });
  const fixture = spawnSync(
    'npx',
    ['tsx', 'tools/fixture-map.ts', PHOTO_DIR, String(PHOTO_WIDTH), String(PHOTO_HEIGHT)],
    { stdio: 'inherit' },
  );
  if (fixture.status !== 0) fail('could not build the test photograph');

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
  await page.waitForFunction('globalThis.masktool !== undefined');

  await page.setInputFiles('#file', `${PHOTO_DIR}/photo.png`);
  await page.waitForFunction('globalThis.masktool.maskData !== null');
  const size = (await page.evaluate('globalThis.masktool.size')) as {
    width: number;
    height: number;
  };
  if (size.width !== PHOTO_WIDTH || size.height !== PHOTO_HEIGHT) {
    fail(`loaded at ${size.width}x${size.height}, expected ${PHOTO_WIDTH}x${PHOTO_HEIGHT}`);
  }

  // 1. Score the auto first pass against the mask the fixture was generated
  // from, rather than asserting it merely changed something.
  //
  // The fixture is a clean synthetic image whose sky and materials are well
  // separated, so the threshold should nearly nail it — that is what proves
  // the mechanism works. A real photograph will do far worse, which is the
  // entire reason the rest of this tool exists (SPEC §5.2).
  const blank = (await page.evaluate(SOLID_FRACTION)) as number;
  if (blank !== 0) fail('mask did not start empty');
  await page.fill('#brightness', '170');
  await page.fill('#horizon', '75');
  await page.click('#seed');
  const seeded = (await page.evaluate(SOLID_FRACTION)) as number;
  const seededMask = (await page.evaluate(
    '(() => Array.from(globalThis.masktool.maskData))()',
  )) as number[];
  const truth = PNG.sync.read(await readFile(`${PHOTO_DIR}/mask.png`));
  let agree = 0;
  for (let i = 0; i < seededMask.length; i++) {
    if (seededMask[i] !== 0 === (truth.data[i * 4] !== 0)) agree++;
  }
  const agreement = agree / seededMask.length;
  if (agreement < 0.95) {
    fail(`threshold seed agrees with the true mask on only ${(agreement * 100).toFixed(1)}% of pixels`);
  }

  // 2. Painting changes the mask.
  await page.keyboard.press('3');
  const box = (await page.locator('#canvas').boundingBox()) ?? fail('no canvas');
  await page.mouse.move(box.x + 200, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 500, box.y + 260, { steps: 12 });
  await page.mouse.up();
  const painted = (await page.evaluate(
    `(() => { const d = globalThis.masktool.maskData; let n = 0; for (let i = 0; i < d.length; i++) if (d[i] === 3) n++; return n; })()`,
  )) as number;
  if (painted < 500) fail(`brush stroke painted only ${painted} pixels`);

  // 3. Fill and despeckle run without error.
  await page.keyboard.press('f');
  await page.mouse.click(box.x + 60, box.y + 40);
  await page.keyboard.press('d');
  await page.click('#check');
  const status = (await page.textContent('#status')) ?? '';

  // 4. Export, and verify the mask survives the PNG round-trip.
  await page.fill('#mapId', 'smoke');
  const downloads: Download[] = [];
  page.on('download', (download) => downloads.push(download));
  await page.click('#export');
  await page.waitForFunction(
    '(document.getElementById("status")?.textContent ?? "").includes("exported")',
    undefined,
    { timeout: 30_000 },
  );
  const expected = (await page.evaluate(
    '(() => Array.from(globalThis.masktool.maskData))()',
  )) as number[];

  for (const download of downloads) {
    await download.saveAs(join(OUT_DIR, download.suggestedFilename()));
  }
  await page.screenshot({ path: `${OUT_DIR}/masktool.png` });
  await browser.close();
  stopServer();

  if (problems.length > 0) fail(`page reported errors:\n${problems.join('\n')}`);
  const names = downloads.map((d) => d.suggestedFilename()).sort();
  if (names.length !== 2 || !names.includes('smoke-mask.png') || !names.includes('smoke-texture.png')) {
    fail(`expected smoke-mask.png and smoke-texture.png, got ${names.join(', ') || 'nothing'}`);
  }

  const png = PNG.sync.read(await readFile(join(OUT_DIR, 'smoke-mask.png')));
  if (png.width !== PHOTO_WIDTH || png.height !== PHOTO_HEIGHT) {
    fail(`exported mask is ${png.width}x${png.height}`);
  }
  const seen = new Set<number>();
  for (let i = 0; i < expected.length; i++) {
    const value = png.data[i * 4];
    seen.add(value);
    if (value !== expected[i]) {
      const x = i % PHOTO_WIDTH;
      const y = Math.floor(i / PHOTO_WIDTH);
      fail(`exported mask differs at ${x},${y}: painted ${expected[i]}, file has ${value}`);
    }
  }
  for (const value of seen) {
    if (value > 5) fail(`exported mask holds ${value}, which is not a material ID`);
  }

  console.log(`\n${status}`);
  console.log(
    `\nMASKTOOL SMOKE PASS: seeded ${(seeded * 100).toFixed(1)}% solid, painted ${painted}px,` +
      ` seed agreed with the true mask on ${(agreement * 100).toFixed(1)}% of pixels,` +
      ` exported ${[...seen].sort().join('/')} as material IDs, byte-identical round-trip.`,
  );
  console.log(`screenshot: ${OUT_DIR}/masktool.png`);
}

run().catch((error: unknown) => {
  console.error(error);
  fail('smoke run threw');
});
