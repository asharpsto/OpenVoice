import aiRaw from '../../tune/ai.json';
import type { AiTune } from '../ai/aim.js';

export function parseAiTune(raw: AiTune): AiTune {
  if (raw.aimErrorSigma.angleRadians < 0 || raw.aimErrorSigma.powerFraction < 0) {
    throw new Error(`tune/ai.json: aimErrorSigma must not be negative`);
  }
  if (!Number.isInteger(raw.searchAngles) || raw.searchAngles < 8) {
    throw new Error(`tune/ai.json: searchAngles must be an integer of at least 8`);
  }
  return { ...raw, aimErrorSigma: { ...raw.aimErrorSigma }, difficulty: { ...raw.difficulty } };
}

let cached: AiTune | undefined;

export function getAiTune(): AiTune {
  cached ??= parseAiTune(aiRaw as AiTune);
  return cached;
}

export function setAiTune(tune: AiTune): void {
  cached = tune;
}
