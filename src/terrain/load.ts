import { maskFromRgba } from './ingest.js';
import type { Mask } from './mask.js';
import type { SpawnPoint } from './validate.js';

/**
 * Loading a baked map in the browser.
 *
 * The baker (`pipeline/bake.ts`) has already applied the long-edge cap and
 * checked the map is playable, so this path does no validation of its own — it
 * decodes and hands over. Stylisation (SPEC §11.1) is a load-time shader that
 * arrives with the art stage and will slot in between decode and first draw.
 */

/** `map.json`, written by the baker. */
export interface MapManifest {
  id: string;
  name: string;
  width: number;
  height: number;
  /** Row of the water surface. Below every spawn (SPEC §5.6). */
  waterLineY: number;
  /** Files relative to the manifest. */
  mask: string;
  texture: string;
  spawns: SpawnPoint[];
}

export interface LoadedMap {
  manifest: MapManifest;
  mask: Mask;
  /** The photograph, ready to become a texture. */
  photo: ImageBitmap;
}

export async function loadMap(manifestUrl: string): Promise<LoadedMap> {
  const response = await fetch(manifestUrl);
  if (!response.ok) throw new Error(`Map manifest ${manifestUrl}: HTTP ${response.status}`);
  const manifest = (await response.json()) as MapManifest;
  const base = new URL(manifestUrl, location.href);

  const [maskBitmap, photo] = await Promise.all([
    fetchBitmap(new URL(manifest.mask, base).href),
    fetchBitmap(new URL(manifest.texture, base).href),
  ]);

  const mask = maskFromRgba(readPixels(maskBitmap), maskBitmap.width, maskBitmap.height);
  if (mask.width !== manifest.width || mask.height !== manifest.height) {
    throw new Error(
      `Map ${manifest.id}: manifest says ${manifest.width}x${manifest.height}, ` +
        `mask is ${mask.width}x${mask.height}`,
    );
  }
  if (photo.width !== mask.width || photo.height !== mask.height) {
    throw new Error(
      `Map ${manifest.id}: photo is ${photo.width}x${photo.height}, mask is ${mask.width}x${mask.height}`,
    );
  }
  maskBitmap.close();
  return { manifest, mask, photo };
}

async function fetchBitmap(url: string): Promise<ImageBitmap> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  // No colour-space conversion or premultiply: mask bytes are data, not colour.
  return createImageBitmap(await response.blob(), {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
}

function readPixels(bitmap: ImageBitmap): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('No 2D context available to decode the mask');
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
}
