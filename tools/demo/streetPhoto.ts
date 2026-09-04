/**
 * Writes the stand-in street out as a photo/mask PNG pair, so the bake
 * pipeline and the mask tool can be exercised without a camera.
 *
 *   npx tsx tools/demo/streetPhoto.ts <out-dir> [width] [height]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { buildStreetScene } from '../../src/dev/streetScene.js';
import { maskToRgba } from '../../src/terrain/ingest.js';

async function writePng(
  path: string,
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<void> {
  const png = new PNG({ width, height });
  png.data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  await writeFile(path, PNG.sync.write(png));
}

const dir = process.argv[2] ?? 'tools/demo/out';
const width = Number(process.argv[3] ?? 1600);
const height = Number(process.argv[4] ?? 1000);
await mkdir(dir, { recursive: true });
const scene = buildStreetScene(width, height, 11);
await writePng(`${dir}/photo.png`, scene.pixels, width, height);
await writePng(`${dir}/mask.png`, maskToRgba(scene.mask), width, height);
console.log(
  `${width}x${height}  ${(scene.mask.solidFraction * 100).toFixed(1)}% solid  -> ${dir}/photo.png, ${dir}/mask.png`,
);
