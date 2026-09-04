/** Blends the mask over the photo the way the paint tool shows it. */
import { readFile, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import type { MaterialId } from '../../src/terrain/materials.js';

const COLOURS: Record<MaterialId, [number, number, number]> = {
  0: [0, 0, 0],
  1: [232, 106, 62],
  2: [214, 178, 74],
  3: [92, 190, 120],
  4: [86, 156, 240],
  5: [198, 118, 226],
};

const dir = process.argv[2] ?? 'tools/demo/out';
const photo = PNG.sync.read(await readFile(`${dir}/photo.png`));
const mask = PNG.sync.read(await readFile(`${dir}/mask.png`));
const out = new PNG({ width: photo.width, height: photo.height });
for (let i = 0; i < photo.width * photo.height; i++) {
  const m = mask.data[i * 4] as MaterialId;
  const colour = COLOURS[m] ?? [0, 0, 0];
  const a = m === 0 ? 0 : 0.55;
  for (let c = 0; c < 3; c++) {
    out.data[i * 4 + c] = photo.data[i * 4 + c] * (1 - a) + colour[c] * a;
  }
  out.data[i * 4 + 3] = 255;
}
await writeFile(`${dir}/overlay.png`, PNG.sync.write(out));
console.log(`wrote ${dir}/overlay.png`);
