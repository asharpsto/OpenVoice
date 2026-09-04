import { Application, BufferImageSource, Container, Graphics, ImageSource, Texture } from 'pixi.js';
import { mulberry32 } from './core/rng.js';
import { buildSyntheticMap } from './dev/syntheticMap.js';
import { explode, type ExplosionResult } from './terrain/destroy.js';
import { loadMap } from './terrain/load.js';
import { BROADPHASE_CELL_SIZE, type Mask } from './terrain/mask.js';
import { TerrainView } from './terrain/render.js';
import { validateMap } from './terrain/validate.js';
import { getTerrainTune } from './tune/terrain.js';

/**
 * Stage 1 dev harness: load a map, look at it, blow holes in it, and watch what
 * the destruction path costs.
 *
 * Grey boxes on purpose. There are no monkeys, no camera and no HUD in stage 1;
 * the only question this page answers is whether terrain, destruction and the
 * dirty-rect upload hold up (SPEC §12, day 1).
 *
 * With no `?map=` it generates a stand-in map, since no photograph has been
 * baked yet; `?map=/maps/<id>/map.json` loads a real one.
 */

const SYNTHETIC_WIDTH = 2048;
const SYNTHETIC_HEIGHT = 1536;
const BUDGET_MS = 4;
const RADII = [20, 40, 80];

const hud = document.getElementById('hud') as HTMLDivElement;

class Samples {
  private readonly values: number[] = [];
  constructor(private readonly limit = 240) {}
  push(value: number): void {
    this.values.push(value);
    if (this.values.length > this.limit) this.values.shift();
  }
  get count(): number {
    return this.values.length;
  }
  percentile(p: number): number {
    if (this.values.length === 0) return 0;
    const sorted = [...this.values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  }
  clear(): void {
    this.values.length = 0;
  }
}

async function main(): Promise<void> {
  const tune = getTerrainTune();
  const app = new Application();
  await app.init({
    preference: 'webgl', // Dirty-rect uploads are texSubImage2D (SPEC §5.4).
    antialias: false,
    background: '#0e1116',
    resizeTo: window,
    powerPreference: 'high-performance',
  });
  document.body.appendChild(app.canvas);

  const source = await loadTerrain();
  let mask = source.mask;
  const { width, height } = mask;
  const validation = validateMap(mask, source.waterLineY, tune.validation);
  const photo = source.photo;

  const world = new Container();
  app.stage.addChild(world);
  const view = new TerrainView(app.renderer, {
    mask,
    photo,
    rimDepthPx: tune.rim.depthPx,
    rimStrength: tune.rim.strength,
  });
  world.addChild(view.mesh);

  const gridOverlay = new Graphics();
  gridOverlay.visible = false;
  world.addChild(gridOverlay);

  const frames = new Samples();
  const destruction = new Samples();
  const blits = new Samples();
  const uploads = new Samples();
  let last: (ExplosionResult & { blitMs: number }) | null = null;
  let radius = RADII[1];
  let stressLeft = 0;
  const rng = mulberry32(20260904);

  function fit(): void {
    const scale = Math.min(app.screen.width / width, app.screen.height / height);
    world.scale.set(scale);
    world.position.set(
      (app.screen.width - width * scale) / 2,
      (app.screen.height - height * scale) / 2,
    );
  }
  fit();
  app.renderer.on('resize', fit);

  function fire(x: number, y: number): void {
    const t0 = performance.now();
    const result = explode(mask, x, y, radius, tune);
    const blitMs = performance.now() - t0;
    if (result.clearedTotal === 0) return;
    view.applyExplosion(result);
    const upload = view.lastUpload;
    last = { ...result, blitMs };
    blits.push(blitMs);
    if (upload) {
      uploads.push(upload.uploadMs);
      destruction.push(blitMs + upload.patchMs + upload.uploadMs);
    }
  }

  app.canvas.addEventListener('pointerdown', (event: PointerEvent) => {
    const bounds = app.canvas.getBoundingClientRect();
    const local = world.toLocal({
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    });
    fire(local.x, local.y);
  });

  function drawGrid(): void {
    gridOverlay.clear();
    for (let cy = 0; cy < mask.cellsY; cy++) {
      for (let cx = 0; cx < mask.cellsX; cx++) {
        if (!mask.cellOccupied(cx, cy)) continue;
        gridOverlay.rect(
          cx * BROADPHASE_CELL_SIZE,
          cy * BROADPHASE_CELL_SIZE,
          BROADPHASE_CELL_SIZE,
          BROADPHASE_CELL_SIZE,
        );
      }
    }
    gridOverlay.stroke({ width: 1, color: 0xff2e63, alpha: 0.25 });
  }

  async function reset(): Promise<void> {
    mask = (await loadTerrain()).mask;
    view.replaceMask(mask);
    destruction.clear();
    blits.clear();
    uploads.clear();
    last = null;
    if (gridOverlay.visible) drawGrid();
  }

  window.addEventListener('keydown', (event) => {
    if (event.key === '1') radius = RADII[0];
    else if (event.key === '2') radius = RADII[1];
    else if (event.key === '3') radius = RADII[2];
    else if (event.key === 's') stressLeft = 200;
    else if (event.key === 'r') void reset();
    else if (event.key === 'g') {
      gridOverlay.visible = !gridOverlay.visible;
      if (gridOverlay.visible) drawGrid();
    }
  });

  // Handle for the smoke test and for poking at things from the console.
  (globalThis as unknown as { banana: unknown }).banana = {
    app,
    view,
    tune,
    fire,
    get mask() {
      return mask;
    },
  };

  app.ticker.add((ticker) => {
    frames.push(ticker.deltaMS);
    if (stressLeft > 0) {
      stressLeft--;
      fire(rng() * width, height * 0.4 + rng() * height * 0.55);
      if (gridOverlay.visible) drawGrid();
    }
    updateHud();
  });

  function updateHud(): void {
    const p99 = destruction.percentile(0.99);
    const withinBudget = destruction.count === 0 || p99 <= BUDGET_MS;
    const lines = [
      `map      ${source.label}  ${width}x${height}  mask ${(mask.data.byteLength / 1048576).toFixed(2)}MB  solid ${(mask.solidFraction * 100).toFixed(1)}%`,
      `validate ${validation.ok ? 'ok' : 'FAILED'}  spawns ${validation.spawns.length}  islands ${validation.islandSpawns.length}`,
      `frame    p50 ${frames.percentile(0.5).toFixed(2)}ms  p99 ${frames.percentile(0.99).toFixed(2)}ms`,
      `radius   ${radius}px${stressLeft > 0 ? `   stress ${stressLeft} left` : ''}`,
      '',
      last
        ? `last     cleared ${last.clearedTotal}px  dirty ${last.dirtyRect.width}x${last.dirtyRect.height}  ${((view.lastUpload?.bytes ?? 0) / 1024).toFixed(1)}KB`
        : 'last     —',
      `  blit           ${blits.percentile(0.5).toFixed(3)}ms p50   ${blits.percentile(0.99).toFixed(3)}ms p99`,
      `  texSubImage2D  ${uploads.percentile(0.5).toFixed(3)}ms p50   ${uploads.percentile(0.99).toFixed(3)}ms p99`,
      `  blit+patch+upload p99 ${p99.toFixed(3)}ms / ${BUDGET_MS}ms  ${withinBudget ? 'OK' : 'OVER'}`,
      `  (${destruction.count} craters measured)`,
    ];
    hud.innerHTML = lines
      .join('\n')
      .replace(/\bOK\b/g, '<span class="ok">OK</span>')
      .replace(/\bOVER\b|\bFAILED\b/g, '<span class="over">$&</span>');
  }
}

/** A baked map when one is named in the query string, otherwise a stand-in. */
async function loadTerrain(): Promise<{
  mask: Mask;
  photo: Texture;
  waterLineY: number;
  label: string;
}> {
  const url = new URLSearchParams(location.search).get('map');
  if (url) {
    const loaded = await loadMap(url);
    return {
      mask: loaded.mask,
      photo: new Texture({
        source: new ImageSource({ resource: loaded.photo, alphaMode: 'no-premultiply-alpha' }),
      }),
      waterLineY: loaded.manifest.waterLineY,
      label: loaded.manifest.name,
    };
  }
  const synthetic = buildSyntheticMap(SYNTHETIC_WIDTH, SYNTHETIC_HEIGHT, 7);
  return {
    mask: synthetic.mask,
    photo: new Texture({
      source: new BufferImageSource({
        resource: synthetic.photo,
        width: SYNTHETIC_WIDTH,
        height: SYNTHETIC_HEIGHT,
        format: 'rgba8unorm',
        alphaMode: 'no-premultiply-alpha',
      }),
    }),
    waterLineY: synthetic.waterLineY,
    label: 'synthetic',
  };
}

void main().catch((error: unknown) => {
  hud.textContent = `failed to start: ${String(error)}`;
  throw error;
});
