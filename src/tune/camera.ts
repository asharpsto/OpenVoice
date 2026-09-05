import cameraRaw from '../../tune/camera.json';
import type { CameraTune } from '../camera/camera.js';

export function parseCameraTune(raw: CameraTune): CameraTune {
  for (const key of ['followLag', 'zoomLag', 'minZoom', 'maxZoom', 'followZoom', 'shakeDecay'] as const) {
    if (!(raw[key] > 0)) throw new Error(`tune/camera.json: ${key} must be positive`);
  }
  if (raw.maxZoom <= raw.minZoom) throw new Error(`tune/camera.json: maxZoom must exceed minZoom`);
  if (raw.framePadding < 0) throw new Error(`tune/camera.json: framePadding must not be negative`);
  if (raw.freeReturnSeconds < 0) throw new Error(`tune/camera.json: freeReturnSeconds must not be negative`);
  return { ...raw };
}

let cached: CameraTune | undefined;

export function getCameraTune(): CameraTune {
  cached ??= parseCameraTune(cameraRaw as CameraTune);
  return cached;
}

export function setCameraTune(tune: CameraTune): void {
  cached = tune;
}
