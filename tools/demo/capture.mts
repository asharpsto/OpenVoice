import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const PORT = 5190;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = 'tools/demo/out';
const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  stdio: 'ignore', detached: true,
});
function stop() { try { if (server.pid) process.kill(-server.pid, 'SIGTERM'); } catch {} }
process.on('exit', stop);

const root = '/opt/pw-browsers';
const exe = readdirSync(root).filter((n) => n.startsWith('chromium')).sort().reverse()
  .map((n) => join(root, n, 'chrome-linux', 'chrome')).find(existsSync)!;

for (let i = 0; i < 120; i++) {
  try { if ((await fetch(BASE)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(`${BASE}/?map=/maps/street/map.json`, { waitUntil: 'load' });
await page.waitForFunction('globalThis.banana !== undefined');
await page.waitForTimeout(700);
// Clean shot: no dev overlays.
await page.evaluate(`(() => {
  document.getElementById('hud').style.display = 'none';
  document.getElementById('help').style.display = 'none';
})()`);
await page.waitForTimeout(300);
await page.locator('canvas').screenshot({ path: `${OUT}/ingame.png` });

// Six shots: brick, hedge, car, road, lamppost, roofline.
await page.evaluate(`(() => {
  const b = globalThis.banana;
  const shots = [
    [300, 560], [770, 675], [1105, 800], [420, 860], [676, 520], [1230, 445],
  ];
  for (const [x, y] of shots) b.fire(x, y);
})()`);
await page.waitForTimeout(700);
await page.locator('canvas').screenshot({ path: `${OUT}/destroyed.png` });

// Compose the four panels with labels.
const composer = await browser.newPage({ viewport: { width: 1640, height: 2060 } });
await composer.goto(`${BASE}/tools/demo/compose.html`, { waitUntil: 'networkidle' });
await composer.waitForTimeout(600);
await composer.locator('#grid').screenshot({ path: `${OUT}/how-it-works.png` });

await browser.close();
stop();
console.log('captured ingame.png, destroyed.png, how-it-works.png');
