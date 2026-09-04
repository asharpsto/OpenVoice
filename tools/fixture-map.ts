/**
 * Writes a synthetic photo/mask PNG pair, so the bake pipeline can be exercised
 * before any real map exists.
 *
 * Dev scaffolding. Real maps are photographs with hand-painted masks and arrive
 * in stage 2 (SPEC §5.2); nothing here should outlive that.
 *
 *   npx tsx tools/fixture-map.ts <out-dir> [width] [height]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { buildSyntheticMap } from '../src/dev/syntheticMap.js';
import { maskToRgba } from '../src/terrain/ingest.js';

const dir = process.argv[2] ?? 'maps/_fixture';
await mkdir(dir, { recursive: true });
const W = Number(process.argv[3] ?? 2600);
const H = Number(process.argv[4] ?? 1400);
const map = buildSyntheticMap(W, H, 3);
async function write(path: string, data: Uint8ClampedArray) {
  const png = new PNG({ width: W, height: H });
  png.data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  await writeFile(path, PNG.sync.write(png));
}
await write(`${dir}/photo.png`, map.photo);
await write(`${dir}/mask.png`, maskToRgba(map.mask));
console.log(`wrote ${W}x${H} fixture pair`);
