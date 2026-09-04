/**
 * Generates a photographic-looking street and the mask a painter would produce
 * for it, so the terrain pipeline can be demonstrated end to end without a
 * camera.
 *
 * This is a demo asset, not a map. Real maps are photographs (SPEC §5.1) and
 * their masks are hand-painted in /tools/masktool. What this exists to show is
 * the relationship between the two: the photograph is wallpaper, the mask is
 * the game.
 *
 *   npx tsx tools/demo/streetPhoto.ts <out-dir> [width] [height]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { mulberry32, type Rng } from '../../src/core/rng.js';
import { maskToRgba } from '../../src/terrain/ingest.js';
import { Mask } from '../../src/terrain/mask.js';
import {
  BUILDING,
  GROUND,
  POLE,
  VEGETATION,
  VEHICLE,
  type MaterialId,
} from '../../src/terrain/materials.js';

type Rgb = [number, number, number];

class Scene {
  readonly pixels: Uint8ClampedArray;
  readonly mask: Mask;

  constructor(
    readonly width: number,
    readonly height: number,
    private readonly rng: Rng,
  ) {
    this.pixels = new Uint8ClampedArray(width * height * 4);
    this.mask = new Mask(width, height);
  }

  put(x: number, y: number, colour: Rgb, material: MaterialId): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    this.pixels[i] = colour[0];
    this.pixels[i + 1] = colour[1];
    this.pixels[i + 2] = colour[2];
    this.pixels[i + 3] = 255;
    this.mask.set(x, y, material);
  }

  rect(x0: number, y0: number, w: number, h: number, colour: Rgb, material: MaterialId, jitter = 6): void {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        this.put(x, y, this.jitterColour(colour, jitter), material);
      }
    }
  }

  jitterColour(colour: Rgb, amount: number): Rgb {
    const n = (this.rng() - 0.5) * amount * 2;
    return [colour[0] + n, colour[1] + n, colour[2] + n];
  }
}

/** Cheap value noise, smoothed. Enough to break up flat fills. */
function makeNoise(seed: number): (x: number, y: number) => number {
  const rng = mulberry32(seed);
  const table = new Float32Array(256 * 256);
  for (let i = 0; i < table.length; i++) table[i] = rng();
  const at = (xi: number, yi: number): number => table[((yi & 255) << 8) | (xi & 255)];
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  return (x: number, y: number): number => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const tx = smooth(x - xi);
    const ty = smooth(y - yi);
    const a = at(xi, yi) * (1 - tx) + at(xi + 1, yi) * tx;
    const b = at(xi, yi + 1) * (1 - tx) + at(xi + 1, yi + 1) * tx;
    return a * (1 - ty) + b * ty;
  };
}

function build(width: number, height: number, seed: number): Scene {
  const rng = mulberry32(seed);
  const scene = new Scene(width, height, rng);
  const clouds = makeNoise(seed + 1);
  const brickNoise = makeNoise(seed + 2);
  const foliage = makeNoise(seed + 3);
  const tarmac = makeNoise(seed + 4);

  const kerbY = Math.round(height * 0.72);
  const pavementDepth = Math.round(height * 0.05);
  // Plenty of sky: the arc needs somewhere to fly, and validation wants the
  // map between 25% and 75% solid (SPEC §5.6).
  const eavesY = Math.round(height * 0.42);

  // Overcast sky: bright, and much brighter than any brick — which is what
  // makes the threshold seed worth running at all.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = y / height;
      const cloud = clouds(x / 90, y / 70) * 16 + clouds(x / 25, y / 22) * 7;
      const base = 196 + t * 22 + cloud;
      scene.put(x, y, [base - 8, base - 1, base + 8], 0);
    }
  }

  // Road and pavement.
  for (let y = kerbY; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const onPavement = y < kerbY + pavementDepth;
      const grit = tarmac(x / 3, y / 3) * 26 + tarmac(x / 11, y / 9) * 14;
      const colour: Rgb = onPavement
        ? [128 + grit, 126 + grit, 121 + grit]
        : [74 + grit, 74 + grit, 78 + grit];
      scene.put(x, y, colour, GROUND);
    }
  }
  // Kerb edge catches the light.
  for (let x = 0; x < width; x++) {
    for (let y = kerbY + pavementDepth; y < kerbY + pavementDepth + 4; y++) {
      scene.put(x, y, scene.jitterColour([150, 148, 143], 5), GROUND);
    }
  }

  // A terrace: houses of slightly different brick, shoulder to shoulder.
  const houses = 5;
  const houseWidth = Math.floor(width / houses);
  for (let h = 0; h < houses; h++) {
    const x0 = h * houseWidth;
    const hue = rng();
    const brick: Rgb = [128 + hue * 34, 84 + hue * 22, 72 + hue * 18];
    const roofTop = eavesY - Math.round(height * (0.03 + rng() * 0.06));

    // Facade with brick courses and mortar lines.
    for (let y = eavesY; y < kerbY; y++) {
      for (let x = x0; x < x0 + houseWidth; x++) {
        const course = Math.floor(y / 9);
        const offset = (course % 2) * 14;
        const mortarH = y % 9 === 0;
        const mortarV = (x + offset) % 28 === 0;
        const grain = brickNoise(x / 4, y / 4) * 22 - 11;
        const colour: Rgb = mortarH || mortarV
          ? [150 + grain, 146 + grain, 138 + grain]
          : [brick[0] + grain, brick[1] + grain, brick[2] + grain];
        scene.put(x, y, colour, BUILDING);
      }
    }

    // Parapet and roof.
    scene.rect(x0, roofTop, houseWidth, eavesY - roofTop, [96 + hue * 20, 92 + hue * 18, 94 + hue * 18], BUILDING, 9);
    // Chimney.
    const chimneyX = x0 + Math.round(houseWidth * (0.15 + rng() * 0.6));
    scene.rect(chimneyX, roofTop - 46, 34, 48, [112, 78, 68], BUILDING, 8);

    // Two rows of windows, then a door.
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 2; col++) {
        const wx = x0 + Math.round(houseWidth * (0.18 + col * 0.42));
        const wy = eavesY + Math.round((kerbY - eavesY) * (0.12 + row * 0.36));
        const ww = Math.round(houseWidth * 0.22);
        const wh = Math.round((kerbY - eavesY) * 0.24);
        scene.rect(wx - 4, wy - 4, ww + 8, wh + 8, [214, 210, 202], BUILDING, 5);
        for (let y = wy; y < wy + wh; y++) {
          for (let x = wx; x < wx + ww; x++) {
            // Glass: dark, with the sky sliding down it.
            const reflect = 1 - (y - wy) / wh;
            const v = 48 + reflect * 96 + brickNoise(x / 7, y / 7) * 18;
            scene.put(x, y, [v * 0.9, v * 0.95, v * 1.05], BUILDING);
          }
        }
      }
    }
    const doorX = x0 + Math.round(houseWidth * 0.72);
    const doorH = Math.round((kerbY - eavesY) * 0.34);
    scene.rect(doorX, kerbY - doorH, Math.round(houseWidth * 0.16), doorH, [58 + hue * 40, 62, 74], BUILDING, 7);
  }

  // A hedge in front of the third house: soft terrain, blows apart.
  const hedgeX = houseWidth * 2 + 20;
  const hedgeW = houseWidth - 60;
  const hedgeH = Math.round(height * 0.10);
  for (let y = kerbY - hedgeH; y < kerbY; y++) {
    for (let x = hedgeX; x < hedgeX + hedgeW; x++) {
      const n = foliage(x / 6, y / 6);
      const edge = foliage(x / 14, y / 14);
      // Ragged top edge, so the silhouette is not a rectangle.
      if (y < kerbY - hedgeH + edge * hedgeH * 0.5) continue;
      if (n < 0.22) continue;
      scene.put(x, y, [44 + n * 62, 78 + n * 74, 38 + n * 44], VEGETATION);
    }
  }

  // A parked car on the road.
  const carX = Math.round(width * 0.62);
  const carY = kerbY + pavementDepth + 6;
  const carW = Math.round(width * 0.17);
  const carH = Math.round(height * 0.075);
  const body: Rgb = [58, 74, 104];
  for (let y = carY; y < carY + carH; y++) {
    for (let x = carX; x < carX + carW; x++) {
      const t = (x - carX) / carW;
      const roof = carY + carH * 0.42;
      // Cabin is inset; bonnet and boot are lower.
      if (y < roof && (t < 0.24 || t > 0.78)) continue;
      const sheen = y < roof ? 40 : 0;
      scene.put(x, y, [body[0] + sheen, body[1] + sheen, body[2] + sheen], VEHICLE);
    }
  }
  for (const wheelT of [0.22, 0.78]) {
    const wx = carX + carW * wheelT;
    for (let y = carY + carH - 8; y < carY + carH + 10; y++) {
      for (let x = Math.round(wx - 12); x < wx + 12; x++) {
        if ((x - wx) ** 2 + (y - (carY + carH)) ** 2 > 144) continue;
        scene.put(x, y, [30, 30, 32], VEHICLE);
      }
    }
  }

  // A lamppost: very low blast resistance, snaps and leaves a gap.
  const postX = Math.round(width * 0.42);
  const postTop = Math.round(height * 0.24);
  for (let y = postTop; y < kerbY + pavementDepth; y++) {
    for (let x = postX; x < postX + 7; x++) scene.put(x, y, [66, 68, 70], POLE);
  }
  scene.rect(postX - 16, postTop - 12, 40, 14, [72, 74, 76], POLE, 4);

  // Grain and a little vignetting, so it reads as a photograph rather than art.
  const grain = makeNoise(seed + 9);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const g = (grain(x / 1.3, y / 1.3) - 0.5) * 13;
      const dx = (x - width / 2) / (width / 2);
      const dy = (y - height / 2) / (height / 2);
      const vignette = 1 - 0.16 * (dx * dx + dy * dy);
      for (let c = 0; c < 3; c++) {
        scene.pixels[i + c] = (scene.pixels[i + c] + g) * vignette;
      }
    }
  }
  return scene;
}

async function writePng(path: string, data: Uint8ClampedArray, width: number, height: number): Promise<void> {
  const png = new PNG({ width, height });
  png.data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  await writeFile(path, PNG.sync.write(png));
}

const dir = process.argv[2] ?? 'tools/demo/out';
const width = Number(process.argv[3] ?? 1600);
const height = Number(process.argv[4] ?? 1000);
await mkdir(dir, { recursive: true });
const scene = build(width, height, 11);
await writePng(`${dir}/photo.png`, scene.pixels, width, height);
await writePng(`${dir}/mask.png`, maskToRgba(scene.mask), width, height);
console.log(
  `${width}x${height}  ${(scene.mask.solidFraction * 100).toFixed(1)}% solid  -> ${dir}/photo.png, ${dir}/mask.png`,
);
