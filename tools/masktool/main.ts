import { downscaleRgba, ingestSize, maskFromRgba, maskToRgba } from '../../src/terrain/ingest.js';
import { Mask } from '../../src/terrain/mask.js';
import { MATERIAL_NAMES, SOLID_MATERIALS, type MaterialId } from '../../src/terrain/materials.js';
import type { Rect } from '../../src/terrain/rect.js';
import { validateMap } from '../../src/terrain/validate.js';
import { getTerrainTune } from '../../src/tune/terrain.js';
import { despeckle, floodFill, stampBrush, strokeBrush, thresholdSeed } from './ops.js';

/**
 * The mask paint tool (SPEC §5.2).
 *
 * Auto-segmentation is out: overcast sky and a rendered wall are the same grey,
 * and a tree against sky comes out riddled with pinholes. Ten minutes painting
 * a mask by hand beats making that work. This is the tool for those ten
 * minutes — a threshold seed for the easy 80%, then a brush.
 *
 * Dev tool only. Vite builds `index.html` at the root, so nothing here reaches
 * the game bundle.
 */

/** Overlay colours. Deliberately not the reserved game palette (SPEC §11.2). */
const MATERIAL_COLOURS: Record<MaterialId, [number, number, number]> = {
  0: [0, 0, 0],
  1: [232, 106, 62],
  2: [214, 178, 74],
  3: [92, 190, 120],
  4: [86, 156, 240],
  5: [198, 118, 226],
};

type ViewMode = 'photo' | 'mask' | 'overlay';
type Tool = 'brush' | 'fill';

const UNDO_LIMIT = 12;

class MaskTool {
  private mask: Mask | null = null;
  private photo: Uint8ClampedArray | null = null;
  private width = 0;
  private height = 0;
  private photoCanvas: HTMLCanvasElement | null = null;
  /** Colourised mask at map resolution, kept in step by dirty rect. */
  private maskCanvas: HTMLCanvasElement | null = null;
  private maskCtx: CanvasRenderingContext2D | null = null;

  private view: ViewMode = 'overlay';
  private tool: Tool = 'brush';
  private material: MaterialId = 2;
  private brushRadius = 18;
  private tolerance = 0;

  private scale = 1;
  private originX = 0;
  private originY = 0;

  private painting = false;
  private panning = false;
  private lastX = 0;
  private lastY = 0;
  private undoStack: Uint8Array[] = [];
  private message = '';

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly ctx: CanvasRenderingContext2D,
    private readonly status: HTMLElement,
  ) {}

  get hasMap(): boolean {
    return this.mask !== null;
  }

  /** Exposed for the smoke test and for poking at things from the console. */
  get maskData(): Uint8Array | null {
    return this.mask?.data ?? null;
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  async loadPhoto(file: File): Promise<void> {
    const bitmap = await createImageBitmap(file, { colorSpaceConversion: 'none' });
    const target = ingestSize(bitmap.width, bitmap.height);
    const full = document.createElement('canvas');
    full.width = bitmap.width;
    full.height = bitmap.height;
    const fullCtx = full.getContext('2d', { willReadFrequently: true });
    if (!fullCtx) throw new Error('No 2D context');
    fullCtx.drawImage(bitmap, 0, 0);
    const source = fullCtx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    bitmap.close();

    // Downscale with the same box filter the baker uses, so what is painted
    // here is pixel-for-pixel what the game loads.
    this.photo =
      target.width === full.width && target.height === full.height
        ? source
        : downscaleRgba(source, full.width, full.height, target);
    this.width = target.width;
    this.height = target.height;
    this.mask = new Mask(this.width, this.height);
    this.undoStack = [];

    this.photoCanvas = document.createElement('canvas');
    this.photoCanvas.width = this.width;
    this.photoCanvas.height = this.height;
    const photoCtx = this.photoCanvas.getContext('2d');
    photoCtx?.putImageData(new ImageData(this.photo, this.width, this.height), 0, 0);

    this.maskCanvas = document.createElement('canvas');
    this.maskCanvas.width = this.width;
    this.maskCanvas.height = this.height;
    this.maskCtx = this.maskCanvas.getContext('2d', { willReadFrequently: true });
    this.repaintMask(this.mask.bounds);

    const downscaled =
      target.width !== full.width ? ` (from ${full.width}x${full.height})` : '';
    this.message = `loaded ${this.width}x${this.height}${downscaled}`;
    this.fit();
  }

  /** Rebuilds the colourised mask over one rect only. */
  private repaintMask(rect: Rect): void {
    const mask = this.mask;
    const ctx = this.maskCtx;
    if (!mask || !ctx || rect.width <= 0 || rect.height <= 0) return;
    const image = ctx.createImageData(rect.width, rect.height);
    for (let y = 0; y < rect.height; y++) {
      for (let x = 0; x < rect.width; x++) {
        const m = mask.at(rect.x + x, rect.y + y);
        const i = (y * rect.width + x) * 4;
        if (m === 0) {
          image.data[i + 3] = 0;
          continue;
        }
        const [r, g, b] = MATERIAL_COLOURS[m];
        image.data[i] = r;
        image.data[i + 1] = g;
        image.data[i + 2] = b;
        image.data[i + 3] = 255;
      }
    }
    ctx.putImageData(image, rect.x, rect.y);
  }

  private pushUndo(): void {
    if (!this.mask) return;
    this.undoStack.push(this.mask.data.slice());
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
  }

  undo(): void {
    const previous = this.undoStack.pop();
    if (!previous || !this.mask) {
      this.message = 'nothing to undo';
      return;
    }
    this.mask.data.set(previous);
    this.mask.rebuildBroadphase();
    this.repaintMask(this.mask.bounds);
    this.message = `undone (${this.undoStack.length} left)`;
    this.draw();
  }

  applySeed(brightness: number, horizon: number): void {
    if (!this.photo || !this.mask) return;
    this.pushUndo();
    const seeded = thresholdSeed(this.photo, this.width, this.height, {
      brightness,
      horizon,
      material: this.material === 0 ? 2 : this.material,
    });
    this.mask.data.set(seeded.data);
    this.mask.rebuildBroadphase();
    this.repaintMask(this.mask.bounds);
    this.message = `seeded: ${(this.mask.solidFraction * 100).toFixed(1)}% solid`;
    this.draw();
  }

  runDespeckle(radius: number): void {
    if (!this.mask) return;
    this.pushUndo();
    const filled = despeckle(this.mask, radius);
    this.repaintMask(this.mask.bounds);
    this.message = `despeckle r${radius}: filled ${filled} pinhole pixel(s)`;
    this.draw();
  }

  check(): void {
    if (!this.mask) return;
    const tune = getTerrainTune();
    const result = validateMap(this.mask, this.height, tune.validation);
    const lines = [
      `${(result.solidFraction * 100).toFixed(1)}% solid · ${result.spawns.length} spawns · ${result.islandSpawns.length} island`,
      ...result.warnings.map((w) => `note: ${w}`),
      ...result.problems.map((p) => `problem: ${p}`),
      result.ok ? 'playable' : 'NOT playable yet',
    ];
    this.message = lines.join('\n');
    this.draw();
  }

  async exportFiles(id: string): Promise<void> {
    const mask = this.mask;
    if (!mask || !this.photoCanvas) return;
    const maskRgba = maskToRgba(mask);
    const maskBlob = await encodePng(maskRgba, this.width, this.height);

    // A mask that does not survive its own PNG round-trip is a mask that will
    // drop a monkey through a wall. Cheap to check, catastrophic to miss.
    const reread = maskFromRgba(
      await decodePng(maskBlob, this.width, this.height),
      this.width,
      this.height,
    );
    if (!sameBytes(reread.data, mask.data)) {
      this.message = 'EXPORT ABORTED: mask did not survive the PNG round-trip';
      this.draw();
      return;
    }

    download(maskBlob, `${id}-mask.png`);
    const textureBlob = await canvasToBlob(this.photoCanvas);
    download(textureBlob, `${id}-texture.png`);
    this.message = `exported ${id}-mask.png and ${id}-texture.png (round-trip verified)`;
    this.draw();
  }

  setView(view: ViewMode): void {
    this.view = view;
    this.draw();
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.draw();
  }

  setMaterial(material: MaterialId): void {
    this.material = material;
    this.draw();
  }

  setBrushRadius(radius: number): void {
    this.brushRadius = radius;
    this.draw();
  }

  setTolerance(tolerance: number): void {
    this.tolerance = tolerance;
  }

  get currentView(): ViewMode {
    return this.view;
  }

  get currentTool(): Tool {
    return this.tool;
  }

  get currentMaterial(): MaterialId {
    return this.material;
  }

  resize(): void {
    const stage = this.canvas.parentElement;
    if (!stage) return;
    this.canvas.width = stage.clientWidth;
    this.canvas.height = stage.clientHeight;
    this.draw();
  }

  fit(): void {
    if (!this.mask) return;
    this.scale = Math.min(this.canvas.width / this.width, this.canvas.height / this.height);
    this.originX = (this.canvas.width - this.width * this.scale) / 2;
    this.originY = (this.canvas.height - this.height * this.scale) / 2;
    this.draw();
  }

  zoomAt(clientX: number, clientY: number, factor: number): void {
    const before = this.toMap(clientX, clientY);
    this.scale = Math.min(24, Math.max(0.05, this.scale * factor));
    this.originX = clientX - before.x * this.scale;
    this.originY = clientY - before.y * this.scale;
    this.draw();
  }

  private toMap(clientX: number, clientY: number): { x: number; y: number } {
    return {
      x: (clientX - this.originX) / this.scale,
      y: (clientY - this.originY) / this.scale,
    };
  }

  pointerDown(clientX: number, clientY: number, pan: boolean): void {
    if (!this.mask) return;
    this.lastX = clientX;
    this.lastY = clientY;
    if (pan) {
      this.panning = true;
      return;
    }
    const point = this.toMap(clientX, clientY);
    this.pushUndo();
    if (this.tool === 'fill') {
      const options =
        this.tolerance > 0 && this.photo
          ? { photo: this.photo, tolerance: this.tolerance }
          : {};
      const rect = floodFill(
        this.mask,
        Math.floor(point.x),
        Math.floor(point.y),
        this.material,
        options,
      );
      this.repaintMask(rect);
      this.message = rect.width > 0 ? `filled ${rect.width}x${rect.height}` : 'nothing to fill';
    } else {
      this.painting = true;
      this.repaintMask(
        stampBrush(this.mask, point.x, point.y, this.brushRadius, this.material),
      );
    }
    this.draw();
  }

  pointerMove(clientX: number, clientY: number): void {
    if (this.panning) {
      this.originX += clientX - this.lastX;
      this.originY += clientY - this.lastY;
      this.lastX = clientX;
      this.lastY = clientY;
      this.draw();
      return;
    }
    if (!this.painting || !this.mask) return;
    const from = this.toMap(this.lastX, this.lastY);
    const to = this.toMap(clientX, clientY);
    this.lastX = clientX;
    this.lastY = clientY;
    const rect = strokeBrush(
      this.mask,
      from.x,
      from.y,
      to.x,
      to.y,
      this.brushRadius,
      this.material,
    );
    this.repaintMask(rect);
    this.draw();
  }

  pointerUp(): void {
    this.painting = false;
    this.panning = false;
  }

  draw(): void {
    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0e13';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!this.mask) return;

    ctx.imageSmoothingEnabled = this.scale < 1;
    ctx.setTransform(this.scale, 0, 0, this.scale, this.originX, this.originY);
    if (this.photoCanvas && this.view !== 'mask') ctx.drawImage(this.photoCanvas, 0, 0);
    if (this.maskCanvas && this.view !== 'photo') {
      ctx.globalAlpha = this.view === 'overlay' ? 0.5 : 1;
      ctx.drawImage(this.maskCanvas, 0, 0);
      ctx.globalAlpha = 1;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    this.status.textContent = [
      `${this.width}x${this.height}  ${(this.mask.solidFraction * 100).toFixed(1)}% solid  zoom ${(this.scale * 100).toFixed(0)}%`,
      `${this.tool}  ${MATERIAL_NAMES[this.material]}  brush ${this.brushRadius}px  view ${this.view}`,
      this.message,
    ]
      .filter(Boolean)
      .join('\n');
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function encodePng(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('No 2D context');
  ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvasToBlob(canvas);
}

async function decodePng(blob: Blob, width: number, height: number): Promise<Uint8ClampedArray> {
  const bitmap = await createImageBitmap(blob, {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('No 2D context');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, width, height).data;
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Canvas would not encode to PNG'));
    }, 'image/png');
  });
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function main(): void {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D context');
  const status = document.getElementById('status') as HTMLElement;
  const drop = document.getElementById('drop') as HTMLElement;
  const tool = new MaskTool(canvas, ctx, status);

  const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const brightness = byId<HTMLInputElement>('brightness');
  const horizon = byId<HTMLInputElement>('horizon');
  const brush = byId<HTMLInputElement>('brush');
  const tolerance = byId<HTMLInputElement>('tolerance');
  const despeckleRadius = byId<HTMLInputElement>('despeckleRadius');
  const viewButtons: Record<ViewMode, HTMLButtonElement> = {
    photo: byId<HTMLButtonElement>('viewPhoto'),
    mask: byId<HTMLButtonElement>('viewMask'),
    overlay: byId<HTMLButtonElement>('viewOverlay'),
  };
  const toolButtons: Record<Tool, HTMLButtonElement> = {
    brush: byId<HTMLButtonElement>('toolBrush'),
    fill: byId<HTMLButtonElement>('toolFill'),
  };

  const materialButtons = new Map<MaterialId, HTMLButtonElement>();
  const materialHost = byId('materials');
  for (const id of [...SOLID_MATERIALS, 0 as MaterialId]) {
    const button = document.createElement('button');
    button.style.width = '100%';
    button.style.marginBottom = '4px';
    const colour = MATERIAL_COLOURS[id];
    button.innerHTML =
      id === 0
        ? `<span class="swatch" style="background:transparent;border-style:dashed"></span>erase <span class="key">0</span>`
        : `<span class="swatch" style="background:rgb(${colour.join(',')})"></span>${MATERIAL_NAMES[id]} <span class="key">${id}</span>`;
    button.addEventListener('click', () => setMaterial(id));
    materialHost.appendChild(button);
    materialButtons.set(id, button);
  }

  function syncButtons(): void {
    for (const [mode, button] of Object.entries(viewButtons)) {
      button.setAttribute('aria-pressed', String(tool.currentView === mode));
    }
    for (const [name, button] of Object.entries(toolButtons)) {
      button.setAttribute('aria-pressed', String(tool.currentTool === name));
    }
    for (const [id, button] of materialButtons) {
      button.setAttribute('aria-pressed', String(tool.currentMaterial === id));
    }
  }

  function setMaterial(id: MaterialId): void {
    tool.setMaterial(id);
    syncButtons();
  }
  function setView(view: ViewMode): void {
    tool.setView(view);
    syncButtons();
  }
  function setTool(name: Tool): void {
    tool.setTool(name);
    syncButtons();
  }

  byId<HTMLButtonElement>('seed').addEventListener('click', () => {
    tool.applySeed(Number(brightness.value), Number(horizon.value) / 100);
  });
  byId<HTMLButtonElement>('despeckle').addEventListener('click', () => {
    tool.runDespeckle(Number(despeckleRadius.value));
  });
  byId<HTMLButtonElement>('undo').addEventListener('click', () => tool.undo());
  byId<HTMLButtonElement>('check').addEventListener('click', () => tool.check());
  byId<HTMLButtonElement>('fit').addEventListener('click', () => tool.fit());
  byId<HTMLButtonElement>('export').addEventListener('click', () => {
    void tool.exportFiles(byId<HTMLInputElement>('mapId').value.trim() || 'map');
  });
  for (const [mode, button] of Object.entries(viewButtons)) {
    button.addEventListener('click', () => setView(mode as ViewMode));
  }
  for (const [name, button] of Object.entries(toolButtons)) {
    button.addEventListener('click', () => setTool(name as Tool));
  }
  brush.addEventListener('input', () => tool.setBrushRadius(Number(brush.value)));
  tolerance.addEventListener('input', () => tool.setTolerance(Number(tolerance.value)));

  async function open(file: File): Promise<void> {
    await tool.loadPhoto(file);
    drop.classList.add('hidden');
    byId('photoInfo').textContent = file.name;
    syncButtons();
  }

  byId<HTMLInputElement>('file').addEventListener('change', (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) void open(file);
  });
  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('drop', (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) void open(file);
  });

  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    tool.pointerDown(event.offsetX, event.offsetY, event.button === 1 || event.shiftKey);
  });
  canvas.addEventListener('pointermove', (event) => tool.pointerMove(event.offsetX, event.offsetY));
  canvas.addEventListener('pointerup', () => tool.pointerUp());
  canvas.addEventListener('pointerleave', () => tool.pointerUp());
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      tool.zoomAt(event.offsetX, event.offsetY, event.deltaY < 0 ? 1.12 : 1 / 1.12);
    },
    { passive: false },
  );

  window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement) return;
    const key = event.key.toLowerCase();
    if (key >= '1' && key <= '5') setMaterial(Number(key) as MaterialId);
    else if (key === 'e') setMaterial(0);
    else if (key === 'b') setTool('brush');
    else if (key === 'f') setTool('fill');
    else if (key === 'z') tool.undo();
    else if (key === 'd') tool.runDespeckle(Number(despeckleRadius.value));
    else if (key === '0') tool.fit();
    else if (key === 'v') {
      const order: ViewMode[] = ['overlay', 'photo', 'mask'];
      setView(order[(order.indexOf(tool.currentView) + 1) % order.length]);
    } else if (key === '[') {
      brush.value = String(Math.max(1, Number(brush.value) - 4));
      tool.setBrushRadius(Number(brush.value));
    } else if (key === ']') {
      brush.value = String(Math.min(120, Number(brush.value) + 4));
      tool.setBrushRadius(Number(brush.value));
    }
  });

  window.addEventListener('resize', () => tool.resize());
  tool.resize();
  syncButtons();
  (globalThis as unknown as { masktool: unknown }).masktool = tool;
}

main();
