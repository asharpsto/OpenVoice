import { Application, BufferImageSource, Container, Graphics, ImageSource, Texture } from 'pixi.js';
import { FixedLoop } from './core/loop.js';
import { mulberry32 } from './core/rng.js';
import { applyImpulse, createBody, type Body } from './physics/body.js';
import { CircleCollider } from './physics/collider.js';
import { IDLE, stepCharacter, type CharacterInput } from './physics/controller.js';
import { buildSyntheticMap } from './dev/syntheticMap.js';
import { explode, type ExplosionResult } from './terrain/destroy.js';
import { loadMap } from './terrain/load.js';
import { BROADPHASE_CELL_SIZE, type Mask } from './terrain/mask.js';
import { TerrainView } from './terrain/render.js';
import { validateMap } from './terrain/validate.js';
import { getMonkeyTune } from './tune/monkey.js';
import { getPhysicsTune } from './tune/physics.js';
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
 *
 * From stage 3 it also carries grey circles running the stepped character
 * controller, which is deliberately what gate 1 wants to be tested with:
 * "grey circles, one map, no art" (SPEC §12).
 */

const SYNTHETIC_WIDTH = 2048;
const SYNTHETIC_HEIGHT = 1536;
const BUDGET_MS = 4;
const RADII = [20, 40, 80];
const STEP_SECONDS = 1 / 60;
/**
 * Placeholder knockback so the controller can be pushed around. The real
 * curves — damage and knockback falling off independently — are weapon.json
 * and arrive with the bazooka in stage 4 (SPEC §6.3).
 */
const DEMO_KNOCKBACK = 520;

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

  // Grey circles running the stepped controller (SPEC §6.1).
  const bodyLayer = new Graphics();
  world.addChild(bodyLayer);
  let collider = new CircleCollider(getMonkeyTune().colliderRadius);
  const bodies: Body[] = [];
  let selected = 0;
  const input: CharacterInput = { move: 0, jump: false };

  function spawnBodies(): void {
    bodies.length = 0;
    const spawns = validation.spawns;
    const wanted = Math.min(6, spawns.length);
    for (let i = 0; i < wanted; i++) {
      // Spread them across the map rather than bunching at one end.
      const spawn = spawns[Math.floor((i * spawns.length) / wanted)];
      bodies.push(createBody(spawn.x, spawn.y - getMonkeyTune().colliderRadius));
    }
    selected = 0;
  }
  spawnBodies();

  const simulation = new FixedLoop(STEP_SECONDS, (dt) => {
    const physics = getPhysicsTune();
    const monkeyTune = getMonkeyTune();
    for (let i = 0; i < bodies.length; i++) {
      stepCharacter(
        bodies[i],
        i === selected ? input : IDLE,
        mask,
        collider,
        physics,
        monkeyTune,
        dt,
      );
    }
  });

  function drawBodies(): void {
    bodyLayer.clear();
    const radius = collider.radius;
    for (let i = 0; i < bodies.length; i++) {
      const body = bodies[i];
      bodyLayer.circle(body.x, body.y, radius);
      bodyLayer.fill({ color: i === selected ? 0xff2e63 : 0xb8c4d4, alpha: 0.92 });
      if (!body.grounded) {
        bodyLayer.circle(body.x, body.y, radius + 3);
        bodyLayer.stroke({ width: 1.5, color: 0xffd23f, alpha: 0.7 });
      }
    }
  }

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
    for (const body of bodies) {
      const dx = body.x - x;
      const dy = body.y - y;
      const distance = Math.hypot(dx, dy);
      if (distance > radius * 3 || distance < 0.001) continue;
      const falloff = 1 - distance / (radius * 3);
      applyImpulse(
        body,
        (dx / distance) * DEMO_KNOCKBACK * falloff,
        (dy / distance) * DEMO_KNOCKBACK * falloff,
      );
    }
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
    spawnBodies();
    destruction.clear();
    blits.clear();
    uploads.clear();
    last = null;
    if (gridOverlay.visible) drawGrid();
  }

  const held = new Set<string>();
  function syncMove(): void {
    const left = held.has('arrowleft') || held.has('a');
    const right = held.has('arrowright') || held.has('d');
    input.move = left === right ? 0 : right ? 1 : -1;
  }
  window.addEventListener('keyup', (event) => {
    held.delete(event.key.toLowerCase());
    syncMove();
    if (event.key === ' ') input.jump = false;
  });
  window.addEventListener('blur', () => {
    held.clear();
    syncMove();
    input.jump = false;
  });

  window.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();
    held.add(key);
    syncMove();
    if (key === ' ') {
      input.jump = true;
      event.preventDefault();
    } else if (key === 'tab') {
      selected = bodies.length === 0 ? 0 : (selected + 1) % bodies.length;
      event.preventDefault();
    }
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

  if (import.meta.env.DEV) {
    const [{ mountTuneHarness }, { TUNE_SPECS }] = await Promise.all([
      import('./tune/harness.js'),
      import('./tune/registry.js'),
    ]);
    mountTuneHarness({
      specs: TUNE_SPECS,
      onChange(spec) {
        // Anything derived from tuning has to be rebuilt when it moves.
        if (spec.name === 'monkey') collider = new CircleCollider(getMonkeyTune().colliderRadius);
        if (spec.name === 'terrain') {
          const terrain = getTerrainTune();
          view.setRimDepth(terrain.rim.depthPx);
          view.rimStrength = terrain.rim.strength;
          view.uploadAll();
        }
      },
    });
  }

  // Handle for the smoke test and for poking at things from the console.
  (globalThis as unknown as { banana: unknown }).banana = {
    app,
    view,
    tune,
    fire,
    get mask() {
      return mask;
    },
    get bodies() {
      return bodies;
    },
    get physics() {
      return getPhysicsTune();
    },
    get monkey() {
      return getMonkeyTune();
    },
    step(frames = 1) {
      for (let i = 0; i < frames; i++) simulation.advance(STEP_SECONDS * 1000);
    },
  };

  app.ticker.add((ticker) => {
    frames.push(ticker.deltaMS);
    simulation.advance(ticker.deltaMS);
    drawBodies();
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
      bodies.length > 0
        ? `body     ${selected + 1}/${bodies.length}  ${bodies[selected].grounded ? 'grounded' : 'airborne'}${bodies[selected].atRest ? ' · at rest' : ''}  r${collider.radius}`
        : 'body     —',
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
