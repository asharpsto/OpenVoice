/**
 * Photo + hand-painted mask -> game-ready map assets.
 *
 * Pure JS, no WebGL: stylisation runs in the browser at load time, not here
 * (SPEC §4.3). All this does is apply the long-edge cap, check the map is
 * playable, and write the manifest.
 *
 *   npm run bake -- --photo street.png --mask street-mask.png --id street \
 *     [--name "Cotham Road"] [--water <y>] [--out maps] [--force]
 *
 * --water is a row in the source image; it is scaled with everything else.
 *
 * The mask PNG holds the material ID in its red channel (0 empty, 1 building,
 * 2 ground, 3 vegetation, 4 vehicle, 5 pole). `/tools/masktool` paints these;
 * until it lands, any editor that writes exact pixel values will do.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { PNG } from 'pngjs';
import { downscaleRgba, ingestSize, maskFromRgba, maskToRgba } from '../src/terrain/ingest.js';
import type { MapManifest } from '../src/terrain/load.js';
import { validateMap } from '../src/terrain/validate.js';
import { getTerrainTune } from '../src/tune/terrain.js';

interface Args {
  photo: string;
  mask: string;
  id: string;
  name?: string;
  water?: number;
  out: string;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith('--')) continue;
    const key = flag.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags.set(key, 'true');
    else {
      flags.set(key, next);
      i++;
    }
  }
  const photo = flags.get('photo');
  const mask = flags.get('mask');
  if (!photo || !mask) {
    throw new Error('Usage: bake --photo <photo.png> --mask <mask.png> [--id <id>] [--water <y>]');
  }
  const args: Args = {
    photo,
    mask,
    id: flags.get('id') ?? basename(photo).replace(/\.[^.]+$/, ''),
    out: flags.get('out') ?? 'maps',
    force: flags.get('force') === 'true',
  };
  const name = flags.get('name');
  if (name !== undefined) args.name = name;
  const water = flags.get('water');
  if (water !== undefined) args.water = Number(water);
  return args;
}

async function readPng(path: string): Promise<PNG> {
  return PNG.sync.read(await readFile(path));
}

async function writePng(
  path: string,
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Promise<void> {
  const png = new PNG({ width, height });
  png.data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  await writeFile(path, PNG.sync.write(png));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tune = getTerrainTune();

  const [photoPng, maskPng] = await Promise.all([readPng(args.photo), readPng(args.mask)]);
  if (photoPng.width !== maskPng.width || photoPng.height !== maskPng.height) {
    throw new Error(
      `Photo is ${photoPng.width}x${photoPng.height} but mask is ${maskPng.width}x${maskPng.height}`,
    );
  }

  const target = ingestSize(maskPng.width, maskPng.height);
  const mask = maskFromRgba(maskPng.data, maskPng.width, maskPng.height);
  const photo =
    target.width === photoPng.width && target.height === photoPng.height
      ? new Uint8ClampedArray(photoPng.data)
      : downscaleRgba(photoPng.data, photoPng.width, photoPng.height, target);

  // --water is a row in the source image, so it has to ride the same downscale
  // the mask just took.
  const waterLineY =
    args.water === undefined
      ? mask.height
      : Math.round((args.water * mask.height) / maskPng.height);
  if (waterLineY < 0 || waterLineY > mask.height) {
    throw new Error(`Water line ${waterLineY} is outside a ${mask.width}x${mask.height} map`);
  }
  const validation = validateMap(mask, waterLineY, tune.validation);
  console.log(
    `${args.id}: ${maskPng.width}x${maskPng.height} -> ${mask.width}x${mask.height}, ` +
      `${(mask.solidFraction * 100).toFixed(1)}% solid, ${validation.spawns.length} spawns`,
  );
  for (const warning of validation.warnings) console.log(`  note: ${warning}`);
  for (const problem of validation.problems) console.error(`  problem: ${problem}`);
  if (!validation.ok && !args.force) {
    console.error(`\n${args.id} is not playable. Fix the mask, or pass --force to bake it anyway.`);
    process.exit(1);
  }

  const dir = join(args.out, args.id);
  await mkdir(dir, { recursive: true });
  await writePng(join(dir, 'mask.png'), maskToRgba(mask), mask.width, mask.height);
  await writePng(join(dir, 'texture.png'), photo, mask.width, mask.height);
  const manifest: MapManifest = {
    id: args.id,
    name: args.name ?? args.id,
    width: mask.width,
    height: mask.height,
    waterLineY,
    mask: 'mask.png',
    texture: 'texture.png',
    spawns: validation.spawns,
  };
  await writeFile(join(dir, 'map.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`  wrote ${dir}/`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
