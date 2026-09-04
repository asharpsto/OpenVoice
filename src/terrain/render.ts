import {
  BufferImageSource,
  GlProgram,
  Mesh,
  MeshGeometry,
  Shader,
  Texture,
  UniformGroup,
} from 'pixi.js';
import type { ExplosionResult } from './destroy.js';
import type { Mask } from './mask.js';
import { MaskPatchBuilder, MASK_TEXTURE_CHANNELS, maskPatchByteLength } from './patch.js';
import { isEmptyRect, type Rect } from './rect.js';

/**
 * Draws the terrain: the photograph, masked by the terrain bitmap.
 *
 * The mask lives on the GPU as an RG8 texture — R is the material ID, G is the
 * rim shade — and destruction re-uploads *only the dirty rect* with
 * `texSubImage2D`. Re-uploading the whole texture is the obvious
 * implementation and the difference between 4ms and 40ms (SPEC §5.4, §10).
 */

const vertex = /* glsl */ `
in vec2 aPosition;
in vec2 aUV;

out vec2 vUV;
out vec4 vColor;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform vec4 uColor;
uniform vec4 uWorldColorAlpha;

void main(void) {
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
    vUV = aUV;
    vColor = uColor * uWorldColorAlpha;
}
`;

const fragment = /* glsl */ `
in vec2 vUV;
in vec4 vColor;

out vec4 finalColor;

uniform sampler2D uPhoto;
uniform sampler2D uMask;
uniform float uRimStrength;
uniform float uBackdrop;

void main(void) {
    vec2 mask = texture(uMask, vUV).rg;
    // Material IDs are 1..5 stored as bytes, so anything solid clears half a step.
    float solid = step(0.5 / 255.0, mask.r);
    vec3 photo = texture(uPhoto, vUV).rgb;
    // G is the rim shade: 1 at a fresh edge, falling to 0 rimDepthPx inside it.
    vec3 shaded = photo * (1.0 - mask.g * uRimStrength);

    // Empty pixels still show the photograph, dimmed and pushed towards grey.
    // Discarding them entirely is what the mask means for *collision*, but it
    // throws the sky away and leaves the map a cut-out on the app background —
    // which stops it looking like the place it was shot in. Terrain is drawn
    // at full strength on top, so the silhouette still reads hard.
    float grey = dot(photo, vec3(0.299, 0.587, 0.114));
    vec3 backdrop = mix(vec3(grey), photo, 0.35) * uBackdrop;

    finalColor = vec4(mix(backdrop, shaded, solid), 1.0) * vColor;
}
`;

/** The slice of the WebGL renderer this view drives directly. */
interface GlRendererLike {
  gl: WebGL2RenderingContext;
  texture: {
    getGlSource(source: BufferImageSource): { target: number; format: number; type: number };
    bindSource(source: BufferImageSource, location: number): void;
    unbind(source: BufferImageSource): void;
  };
}

/** Cost of one dirty-rect upload, for the dev overlay and the perf budget. */
export interface UploadStats {
  /** Building the RG8 patch, including the rim shade. */
  patchMs: number;
  /** The `texSubImage2D` call itself, main-thread cost. */
  uploadMs: number;
  bytes: number;
  rect: Rect;
}

export interface TerrainViewOptions {
  mask: Mask;
  /** The stylised photograph, already sized to the mask. */
  photo: Texture;
  /** `tune/terrain.json` rim.depthPx — how far in from a fresh edge to darken. */
  rimDepthPx: number;
  /** `tune/terrain.json` rim.strength — how much to darken. */
  rimStrength: number;
  /** `tune/terrain.json` backdrop — how brightly non-solid photo shows through. */
  backdropStrength: number;
}

/** Pixi's Mesh wants a shader that carries its texture; ours carries the photo. */
type TerrainShader = Shader & { texture: Texture };

export class TerrainView {
  readonly mesh: Mesh<MeshGeometry, TerrainShader>;
  private readonly renderer: GlRendererLike;
  private mask: Mask;
  private readonly maskSource: BufferImageSource;
  private readonly uniforms: UniformGroup<{
    uRimStrength: { value: number; type: 'f32' };
    uBackdrop: { value: number; type: 'f32' };
  }>;
  private rimDepthPx: number;
  /** Reused patch buffer, so a crater does not allocate mid-frame. */
  private scratch: Uint8Array;
  /** Timings from the most recent upload. */
  lastUpload: UploadStats | null = null;
  private readonly patches = new MaskPatchBuilder();

  constructor(renderer: unknown, options: TerrainViewOptions) {
    const gl = (renderer as Partial<GlRendererLike>).gl;
    if (!gl) {
      throw new Error(
        'TerrainView needs a WebGL renderer: dirty-rect uploads are texSubImage2D. ' +
          "Create the application with { preference: 'webgl' }.",
      );
    }
    this.renderer = renderer as GlRendererLike;
    this.mask = options.mask;
    this.rimDepthPx = options.rimDepthPx;

    const { width, height } = options.mask;
    this.maskSource = new BufferImageSource({
      resource: new Uint8Array(width * height * MASK_TEXTURE_CHANNELS),
      width,
      height,
      format: 'rg8unorm',
      scaleMode: 'nearest',
      // The mask is the collision: a filtered or mipmapped mask would render
      // terrain that is not where the physics says it is.
      autoGenerateMipmaps: false,
      alphaMode: 'no-premultiply-alpha',
    });
    this.scratch = new Uint8Array(0);

    this.uniforms = new UniformGroup({
      uRimStrength: { value: options.rimStrength, type: 'f32' },
      uBackdrop: { value: options.backdropStrength, type: 'f32' },
    });
    const shader = new Shader({
      glProgram: GlProgram.from({ vertex, fragment, name: 'terrain' }),
      resources: {
        uPhoto: options.photo.source,
        uMask: this.maskSource,
        terrainUniforms: this.uniforms,
      },
    }) as TerrainShader;
    shader.texture = options.photo;

    const geometry = new MeshGeometry({
      positions: new Float32Array([0, 0, width, 0, width, height, 0, height]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });

    this.mesh = new Mesh({ geometry, shader });
    this.uploadAll();
  }

  get rimStrength(): number {
    return this.uniforms.uniforms.uRimStrength;
  }

  set rimStrength(value: number) {
    this.uniforms.uniforms.uRimStrength = value;
  }

  get backdropStrength(): number {
    return this.uniforms.uniforms.uBackdrop;
  }

  set backdropStrength(value: number) {
    this.uniforms.uniforms.uBackdrop = value;
  }

  /** Kept in step with `tune/terrain.json` when the stage-3 harness reloads it. */
  setRimDepth(depthPx: number): void {
    this.rimDepthPx = depthPx;
  }

  /** Pushes the crater to the GPU: one `texSubImage2D` over the dirty rect. */
  applyExplosion(result: ExplosionResult): void {
    this.uploadRect(result.dirtyRect);
  }

  /**
   * Re-uploads one rect of the mask texture. This is the only per-explosion GPU
   * work, and the whole reason destruction stays inside its frame budget.
   */
  uploadRect(rect: Rect): void {
    if (isEmptyRect(rect)) return;
    const needed = maskPatchByteLength(rect);
    if (this.scratch.length < needed) this.scratch = new Uint8Array(needed);
    const patchStart = performance.now();
    const patch = this.patches.build(this.mask, rect, this.rimDepthPx, this.scratch);
    const uploadStart = performance.now();

    const { gl, texture } = this.renderer;
    const glTexture = texture.getGlSource(this.maskSource);
    // Unbind first so the next bind is guaranteed to activate the texture unit
    // as well as bind it — Pixi skips both when it thinks the source is already
    // there, which would leave texSubImage2D writing to whatever else is active.
    texture.unbind(this.maskSource);
    texture.bindSource(this.maskSource, 0);
    // Rows are 2 bytes per pixel, so an odd-width patch breaks the default
    // 4-byte unpack alignment.
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(
      glTexture.target,
      0,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      glTexture.format,
      glTexture.type,
      patch,
      0,
    );
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);

    this.lastUpload = {
      patchMs: uploadStart - patchStart,
      uploadMs: performance.now() - uploadStart,
      bytes: needed,
      rect,
    };
  }

  /**
   * Swaps in a different mask of the same size and re-uploads it. Used when a
   * map is reset; the texture and geometry are sized once at construction.
   */
  replaceMask(mask: Mask): void {
    if (mask.width !== this.mask.width || mask.height !== this.mask.height) {
      throw new Error(
        `replaceMask needs the same size: have ${this.mask.width}x${this.mask.height}, ` +
          `got ${mask.width}x${mask.height}`,
      );
    }
    this.mask = mask;
    this.uploadAll();
  }

  /** Full upload. Load time only — never per explosion. */
  uploadAll(): void {
    const full = this.mask.bounds;
    const patch = this.patches.build(this.mask, full, 0);
    (this.maskSource.resource as Uint8Array).set(patch);
    this.maskSource.update();
  }

  destroy(): void {
    this.mesh.destroy();
    this.maskSource.destroy();
  }
}
