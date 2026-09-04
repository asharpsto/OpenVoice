/**
 * Stage 1 exit criterion: explosion blit plus dirty-rect texture upload under
 * 4ms (SPEC §9, §12).
 *
 * This measures the CPU half — the mask blit and the RG8 patch build that feeds
 * `texSubImage2D`. The GL call itself needs a GPU, so it is measured in the
 * browser by the dev harness overlay; see CODE_LOG.md.
 *
 *   npm run bench:blit
 */
import { mulberry32 } from '../src/core/rng.js';
import { buildSyntheticMap } from '../src/dev/syntheticMap.js';
import { explode } from '../src/terrain/destroy.js';
import { MaskPatchBuilder, maskPatchByteLength } from '../src/terrain/patch.js';
import { getTerrainTune } from '../src/tune/terrain.js';

const WIDTH = 2048;
const HEIGHT = 1536;
const BUDGET_MS = 4;
const SHOTS = 300;

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function report(label: string, samples: number[], budget?: number): boolean {
  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = percentile(sorted, 0.5);
  const p99 = percentile(sorted, 0.99);
  const worst = sorted[sorted.length - 1];
  const within = budget === undefined || p99 <= budget;
  const verdict = budget === undefined ? '' : within ? '  OK' : '  OVER BUDGET';
  console.log(
    `${label.padEnd(34)} p50 ${p50.toFixed(3)}ms  p99 ${p99.toFixed(3)}ms  max ${worst.toFixed(3)}ms${verdict}`,
  );
  return within;
}

const tune = getTerrainTune();
const { mask } = buildSyntheticMap(WIDTH, HEIGHT, 7);
console.log(
  `map ${WIDTH}x${HEIGHT}  mask ${(mask.data.byteLength / 1024 / 1024).toFixed(2)}MB  ` +
    `solid ${(mask.solidFraction * 100).toFixed(1)}%  rim ${tune.rim.depthPx}px`,
);

// The one full upload a map costs at load.
const loadStart = performance.now();
const patches = new MaskPatchBuilder();
const fullPatch = patches.build(mask, mask.bounds, 0);
console.log(
  `full-map patch (load only)          ${(performance.now() - loadStart).toFixed(1)}ms  ` +
    `${(fullPatch.byteLength / 1024 / 1024).toFixed(1)}MB`,
);

let allWithin = true;
for (const radius of [20, 40, 80]) {
  const rng = mulberry32(radius * 13);
  const scratch = new Uint8Array(WIDTH * HEIGHT * 2);
  const blitMs: number[] = [];
  const patchMs: number[] = [];
  const totalMs: number[] = [];
  let bytes = 0;
  let hits = 0;

  // Warm the JIT before measuring: the first few hundred craters of a session
  // are not what the frame budget is about.
  for (let i = 0; i < 40; i++) {
    const warm = explode(mask, rng() * WIDTH, HEIGHT * 0.45 + rng() * HEIGHT * 0.5, radius, tune);
    if (warm.clearedTotal > 0) patches.build(mask, warm.dirtyRect, tune.rim.depthPx, scratch);
  }

  for (let i = 0; i < SHOTS; i++) {
    // Aim at terrain, not sky: an explosion in mid-air is not the hard case.
    const x = rng() * WIDTH;
    const y = HEIGHT * 0.45 + rng() * HEIGHT * 0.5;
    const t0 = performance.now();
    const result = explode(mask, x, y, radius, tune);
    const t1 = performance.now();
    if (result.clearedTotal === 0) continue;
    patches.build(mask, result.dirtyRect, tune.rim.depthPx, scratch);
    const t2 = performance.now();
    blitMs.push(t1 - t0);
    patchMs.push(t2 - t1);
    totalMs.push(t2 - t0);
    bytes += maskPatchByteLength(result.dirtyRect);
    hits++;
  }

  console.log(`\nradius ${radius}px  (${hits} craters, mean patch ${(bytes / hits / 1024).toFixed(1)}KB)`);
  report('  mask blit', blitMs);
  report('  RG8 patch + rim shade', patchMs);
  allWithin = report('  blit + patch (CPU total)', totalMs, BUDGET_MS) && allWithin;
}

console.log(
  `\n${allWithin ? 'PASS' : 'FAIL'}: CPU side of the destruction path vs the ${BUDGET_MS}ms budget.`,
);
process.exit(allWithin ? 0 : 1);
