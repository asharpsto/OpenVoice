export { explode, craterRadiusFor, type ExplosionResult } from './destroy.js';
export {
  MAX_LONG_EDGE,
  downscaleMask,
  downscaleRgba,
  ingestSize,
  maskFromRgba,
  maskToRgba,
  type Size,
} from './ingest.js';
export { loadMap, type LoadedMap, type MapManifest } from './load.js';
export { BROADPHASE_CELL_SIZE, Mask } from './mask.js';
export {
  BUILDING,
  EMPTY,
  GROUND,
  MATERIAL_NAMES,
  MAX_MATERIAL_ID,
  POLE,
  SOLID_MATERIALS,
  VEGETATION,
  VEHICLE,
  isMaterialId,
  materialName,
  type MaterialId,
  type MaterialName,
} from './materials.js';
export {
  MASK_TEXTURE_CHANNELS,
  MaskPatchBuilder,
  buildMaskPatch,
  maskPatchByteLength,
} from './patch.js';
export { isSolidAt, materialAt, raycast, type RayHit, type RaycastOptions } from './query.js';
export { EMPTY_RECT, isEmptyRect, padAndClamp, union, type Rect } from './rect.js';
export { TerrainView, type TerrainViewOptions, type UploadStats } from './render.js';
export {
  findSpawnCandidates,
  labelSolidComponents,
  validateMap,
  type MapValidationResult,
  type SpawnPoint,
} from './validate.js';
