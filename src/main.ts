import { Application, BufferImageSource, Container, Graphics, ImageSource, Texture } from 'pixi.js';
import { FixedLoop } from './core/loop.js';
import { mulberry32 } from './core/rng.js';
import { createBody, type Body } from './physics/body.js';
import { addAimError, nearestTarget, solveAim } from './ai/aim.js';
import { applyBlast, shakeAt } from './weapon/explosion.js';
import { launch, previewArc, stepProjectile, type Projectile } from './weapon/projectile.js';
import { createWind, nextWind, windFraction, type Wind } from './wind/wind.js';
import { getAiTune } from './tune/ai.js';
import { getWeaponTune } from './tune/weapon.js';
import { getWindTune } from './tune/wind.js';
import { fallDamageFor } from './tune/monkey.js';
import { CircleCollider } from './physics/collider.js';
import { IDLE, stepCharacter, type CharacterInput } from './physics/controller.js';
import { buildStreetScene } from './dev/streetScene.js';
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

const SYNTHETIC_WIDTH = 1600;
const SYNTHETIC_HEIGHT = 1000;
const BUDGET_MS = 4;
const RADII = [20, 40, 80];
const STEP_SECONDS = 1 / 60;
/** Trajectory preview sampling. Mandatory, and never cut (SPEC §12.1). */
const PREVIEW = { points: 46, secondsPerPoint: 0.07 };

/**
 * Touch aiming is an open question, not a settled decision (SPEC §6.3): a
 * thumb dragging from the monkey covers the monkey and the first part of the
 * arc, which is exactly what you are trying to read. Both schemes are built so
 * day 4 can decide by playing them.
 */
type AimScheme = 'drag' | 'widget';

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
    backdropStrength: tune.backdrop,
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
    // Spread across the map but inset from both ends, so nobody starts with
    // half of themselves off the edge of the screen.
    const spawns = validation.spawns;
    const wanted = Math.min(6, spawns.length);
    const usable = spawns.filter(
      (spawn) => spawn.x > width * 0.06 && spawn.x < width * 0.94,
    );
    const pool = usable.length >= wanted ? usable : spawns;
    for (let i = 0; i < wanted; i++) {
      const spawn = pool[Math.floor(((i + 0.5) * pool.length) / wanted)];
      bodies.push(createBody(spawn.x, spawn.y - getMonkeyTune().colliderRadius));
    }
    selected = 0;
  }
  spawnBodies();

  const health: number[] = [];
  function spawnHealth(): void {
    health.length = 0;
    for (let i = 0; i < bodies.length; i++) health.push(getMonkeyTune().health);
  }
  spawnHealth();

  const aimLayer = new Graphics();
  world.addChild(aimLayer);
  const rng = mulberry32(20260904);
  let wind: Wind = createWind(rng, getWindTune());
  let scheme: AimScheme = 'drag';
  let aimAngle = -Math.PI / 4;
  let aimPower = 0.6;
  let aiming = false;
  let projectile: Projectile | null = null;
  let shake = 0;
  let lastShot = '';

  function power(): number {
    const weapon = getWeaponTune();
    return (
      weapon.muzzleVelocity.min +
      (weapon.muzzleVelocity.max - weapon.muzzleVelocity.min) * Math.min(1, Math.max(0, aimPower))
    );
  }

  function muzzle(body: Body): { x: number; y: number } {
    const offset = collider.radius + 5;
    return { x: body.x + Math.cos(aimAngle) * offset, y: body.y + Math.sin(aimAngle) * offset };
  }

  function fireBanana(): void {
    const body = bodies[selected];
    if (!body || projectile) return;
    const start = muzzle(body);
    projectile = launch(start.x, start.y, aimAngle, power());
    aiming = false;
  }

  function detonate(x: number, y: number): void {
    const weapon = getWeaponTune();
    const terrain = getTerrainTune();
    const monkeyTune = getMonkeyTune();
    const result = explode(mask, x, y, weapon.blastRadius, terrain);
    if (result.clearedTotal > 0) view.applyExplosion(result);

    let worst = '';
    for (const effect of applyBlast(bodies, x, y, weapon)) {
      health[effect.index] -= effect.damage;
      if (effect.index === selected && effect.damage > 0) {
        worst = `self-damage ${effect.damage.toFixed(0)}`;
      }
    }
    const distance = bodies[selected] ? Math.hypot(bodies[selected].x - x, bodies[selected].y - y) : 0;
    shake = Math.max(shake, shakeAt(distance, weapon.shake.max, weapon.shake.radius));
    lastShot = `hit at ${x.toFixed(0)},${y.toFixed(0)}${worst ? ` · ${worst}` : ''}`;
    void monkeyTune;
    // Wind changes each turn; firing ends the turn in the real machine (stage 5).
    wind = nextWind(wind, rng, getWindTune());
  }

  function aiTurn(): void {
    const weapon = getWeaponTune();
    const ai = getAiTune();
    const shooter = bodies[selected];
    if (!shooter || projectile) return;
    const enemies = bodies.filter((_, i) => i !== selected && health[i] > 0);
    if (enemies.length === 0) return;
    const target = enemies[nearestTarget(shooter.x, shooter.y, enemies)];
    const solution = solveAim(
      shooter.x, shooter.y, target.x, target.y,
      weapon.muzzleVelocity.max * 0.85,
      getPhysicsTune().gravity, wind.x, weapon.projectile, ai.searchAngles,
    );
    const shot = addAimError(solution, rng, ai.aimErrorSigma);
    aimAngle = shot.angle;
    aimPower =
      (shot.power - weapon.muzzleVelocity.min) /
      (weapon.muzzleVelocity.max - weapon.muzzleVelocity.min);
    lastShot = `AI aims, miss estimate ${solution.missDistance.toFixed(0)}px`;
    fireBanana();
  }

  const simulation = new FixedLoop(STEP_SECONDS, (dt) => {
    const physics = getPhysicsTune();
    const monkeyTune = getMonkeyTune();
    const weapon = getWeaponTune();
    const terrain = getTerrainTune();

    if (projectile) {
      const step = stepProjectile(
        projectile, dt, mask, physics.gravity, wind.x, weapon.projectile, terrain.query.raycastStepPx,
      );
      if (step.hit) {
        detonate(projectile.x, projectile.y);
        projectile = null;
      } else if (step.offMap || projectile.age > 12) {
        lastShot = 'off the map';
        projectile = null;
        wind = nextWind(wind, rng, getWindTune());
      }
    }

    for (let i = 0; i < bodies.length; i++) {
      const wasAirborne = !bodies[i].grounded;
      stepCharacter(bodies[i], i === selected ? input : IDLE, mask, collider, physics, monkeyTune, dt);
      if (wasAirborne && bodies[i].grounded && bodies[i].lastImpactSpeed > 0) {
        health[i] -= fallDamageFor(bodies[i].lastImpactSpeed, monkeyTune);
        bodies[i].lastImpactSpeed = 0;
      }
      // Water at the bottom of the map is instant death (SPEC §6.2).
      if (bodies[i].y > mask.height) health[i] = 0;
    }
    shake *= 0.88;
  });

  function drawBodies(): void {
    bodyLayer.clear();
    const radius = collider.radius;
    for (let i = 0; i < bodies.length; i++) {
      const body = bodies[i];
      if (health[i] <= 0) continue;
      bodyLayer.circle(body.x, body.y, radius);
      bodyLayer.fill({ color: i === selected ? 0xff2e63 : 0xb8c4d4, alpha: 0.92 });
      // Health bar in the reserved UI accent (SPEC §11.2).
      const ratio = Math.max(0, health[i]) / getMonkeyTune().health;
      bodyLayer.rect(body.x - radius, body.y - radius - 9, radius * 2, 3);
      bodyLayer.fill({ color: 0x0e1116, alpha: 0.75 });
      bodyLayer.rect(body.x - radius, body.y - radius - 9, radius * 2 * ratio, 3);
      bodyLayer.fill({ color: 0xff2e63 });
    }
  }

  /** Dotted arc including wind, fading with distance so it hints, not solves. */
  function drawAim(): void {
    aimLayer.clear();
    const body = bodies[selected];

    if (projectile) {
      aimLayer.circle(projectile.x, projectile.y, 5);
      aimLayer.fill({ color: 0xffd23f });
      return;
    }
    if (!body || health[selected] <= 0) return;

    const weapon = getWeaponTune();
    const start = muzzle(body);
    const arc = previewArc(
      start.x, start.y, aimAngle, power(), mask,
      getPhysicsTune().gravity, wind.x, weapon.projectile, PREVIEW,
    );
    for (let i = 0; i < arc.length; i++) {
      const fade = 1 - i / arc.length;
      aimLayer.circle(arc[i].x, arc[i].y, 2.4);
      aimLayer.fill({ color: 0xff2e63, alpha: 0.15 + fade * 0.75 });
    }
    // Power as a stub from the muzzle, so the drag length is readable.
    aimLayer.moveTo(body.x, body.y);
    aimLayer.lineTo(start.x + Math.cos(aimAngle) * 26 * aimPower, start.y + Math.sin(aimAngle) * 26 * aimPower);
    aimLayer.stroke({ width: 2, color: 0xff2e63, alpha: 0.9 });
  }

  const frames = new Samples();
  const destruction = new Samples();
  const blits = new Samples();
  const uploads = new Samples();
  let last: (ExplosionResult & { blitMs: number }) | null = null;
  let radius = RADII[1];
  let stressLeft = 0;

  const worldHome = { x: 0, y: 0 };
  function fit(): void {
    const scale = Math.min(app.screen.width / width, app.screen.height / height);
    world.scale.set(scale);
    worldHome.x = (app.screen.width - width * scale) / 2;
    worldHome.y = (app.screen.height - height * scale) / 2;
    world.position.set(worldHome.x, worldHome.y);
  }
  fit();
  app.renderer.on('resize', fit);

  function fire(x: number, y: number): void {
    const t0 = performance.now();
    const result = explode(mask, x, y, radius, tune);
    const blitMs = performance.now() - t0;
    if (result.clearedTotal === 0) return;
    view.applyExplosion(result);
    for (const effect of applyBlast(bodies, x, y, getWeaponTune())) {
      health[effect.index] -= effect.damage;
    }
    const upload = view.lastUpload;
    last = { ...result, blitMs };
    blits.push(blitMs);
    if (upload) {
      uploads.push(upload.uploadMs);
      destruction.push(blitMs + upload.patchMs + upload.uploadMs);
    }
  }

  const WIDGET = { x: 128, y: 0, radius: 92 };
  function widgetCentre(): { x: number; y: number } {
    return { x: WIDGET.x, y: app.screen.height - 132 };
  }
  function toWorld(event: PointerEvent): { x: number; y: number } {
    const bounds = app.canvas.getBoundingClientRect();
    return world.toLocal({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
  }

  function setAimFrom(dx: number, dy: number, span: number): void {
    // Drag backwards to aim, like drawing a bow: the arc goes where the sling
    // is pulled from, and the finger stays off the part of the arc you read.
    aimAngle = Math.atan2(-dy, -dx);
    aimPower = Math.min(1, Math.hypot(dx, dy) / span);
  }

  app.canvas.addEventListener('pointerdown', (event: PointerEvent) => {
    app.canvas.setPointerCapture(event.pointerId);
    if (event.shiftKey) {
      fire(toWorld(event).x, toWorld(event).y); // spot blast, for terrain testing
      return;
    }
    if (scheme === 'widget') {
      const centre = widgetCentre();
      const bounds = app.canvas.getBoundingClientRect();
      const px = event.clientX - bounds.left;
      const py = event.clientY - bounds.top;
      if (Math.hypot(px - centre.x, py - centre.y) <= WIDGET.radius) {
        aiming = true;
        setAimFrom(px - centre.x, py - centre.y, WIDGET.radius);
      }
      return;
    }
    const body = bodies[selected];
    if (!body) return;
    const local = toWorld(event);
    aiming = true;
    setAimFrom(local.x - body.x, local.y - body.y, 190);
  });

  app.canvas.addEventListener('pointermove', (event: PointerEvent) => {
    if (!aiming) return;
    if (scheme === 'widget') {
      const centre = widgetCentre();
      const bounds = app.canvas.getBoundingClientRect();
      setAimFrom(event.clientX - bounds.left - centre.x, event.clientY - bounds.top - centre.y, WIDGET.radius);
      return;
    }
    const body = bodies[selected];
    if (!body) return;
    const local = toWorld(event);
    setAimFrom(local.x - body.x, local.y - body.y, 190);
  });

  app.canvas.addEventListener('pointerup', () => {
    if (!aiming) return;
    aiming = false;
    fireBanana();
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
    spawnHealth();
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
    } else if (key === 'f') {
      fireBanana();
    } else if (key === 'i') {
      aiTurn();
    } else if (key === 'm') {
      scheme = scheme === 'drag' ? 'widget' : 'drag';
    } else if (key === 'w') {
      wind = nextWind(wind, rng, getWindTune());
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
          view.backdropStrength = terrain.backdrop;
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
    drawAim();
    if (shake > 0.4) {
      world.position.set(
        worldHome.x + (Math.random() - 0.5) * shake,
        worldHome.y + (Math.random() - 0.5) * shake,
      );
    } else if (world.position.x !== worldHome.x || world.position.y !== worldHome.y) {
      world.position.set(worldHome.x, worldHome.y);
    }
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
        ? `body     ${selected + 1}/${bodies.length}  hp ${Math.max(0, health[selected]).toFixed(0)}  ${bodies[selected].grounded ? 'grounded' : 'airborne'}${bodies[selected].atRest ? ' · at rest' : ''}`
        : 'body     —',
      `wind     ${wind.x < 0 ? '<<' : '>>'} ${Math.abs(wind.x).toFixed(0)}  (${(windFraction(wind, getWindTune()) * 100).toFixed(0)}%)`,
      `aim      ${scheme}  ${((-aimAngle * 180) / Math.PI).toFixed(0)}°  power ${(aimPower * 100).toFixed(0)}%`,
      `shot     ${lastShot || '—'}`,
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
  const synthetic = buildStreetScene(SYNTHETIC_WIDTH, SYNTHETIC_HEIGHT, 11);
  return {
    mask: synthetic.mask,
    photo: new Texture({
      source: new BufferImageSource({
        resource: synthetic.pixels,
        width: SYNTHETIC_WIDTH,
        height: SYNTHETIC_HEIGHT,
        format: 'rgba8unorm',
        alphaMode: 'no-premultiply-alpha',
      }),
    }),
    waterLineY: synthetic.waterLineY,
    label: 'stand-in street',
  };
}

void main().catch((error: unknown) => {
  hud.textContent = `failed to start: ${String(error)}`;
  throw error;
});
