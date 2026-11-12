import {
  AgXToneMapping,
  ACESFilmicToneMapping,
  Color,
  LinearToneMapping,
  PCFShadowMap,
  SRGBColorSpace,
  type ShadowMapType,
  type ToneMapping,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import type { RenderSettings } from '../../core/doc/schema';

/** Nombre fini ou valeur de repli. */
export function finiteOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Transformation de vue (équivalent du « View Transform » de Blender) :
 *  - 'agx'      → AgX ;
 *  - 'filmic'   → ACES Filmic (le plus proche du Filmic de Blender disponible dans three) ;
 *  - 'standard' → linéaire (simple écrêtage, mais l'exposition s'applique).
 */
export function toneMappingOf(settings: Pick<RenderSettings, 'toneMapping'>): ToneMapping {
  switch (settings.toneMapping) {
    case 'filmic':
      return ACESFilmicToneMapping;
    case 'standard':
      return LinearToneMapping;
    default:
      return AgXToneMapping;
  }
}

/** Exposition en diaphragmes (stops) : facteur multiplicatif 2^exposure. */
export function exposureOf(settings: Pick<RenderSettings, 'exposure'>): number {
  return Math.pow(2, clampNum(finiteOr(settings.exposure, 0), -10, 10));
}

/** Applique tone mapping, exposition et sortie sRGB au renderer. */
export function applyColorManagement(renderer: WebGLRenderer, settings: RenderSettings): void {
  renderer.toneMapping = toneMappingOf(settings);
  renderer.toneMappingExposure = exposureOf(settings);
  renderer.outputColorSpace = SRGBColorSpace;
}

/** Instantané de l'état du renderer modifié par le pipeline, pour le restaurer à l'identique. */
export interface RendererState {
  target: WebGLRenderTarget | null;
  toneMapping: ToneMapping;
  exposure: number;
  outputColorSpace: string;
  clearColor: Color;
  clearAlpha: number;
  autoClear: boolean;
  autoClearColor: boolean;
  autoClearDepth: boolean;
  autoClearStencil: boolean;
  shadowEnabled: boolean;
  shadowType: ShadowMapType;
  shadowAutoUpdate: boolean;
  scissorTest: boolean;
}

export function saveRendererState(renderer: WebGLRenderer): RendererState {
  return {
    target: renderer.getRenderTarget(),
    toneMapping: renderer.toneMapping,
    exposure: renderer.toneMappingExposure,
    outputColorSpace: renderer.outputColorSpace,
    clearColor: renderer.getClearColor(new Color()),
    clearAlpha: renderer.getClearAlpha(),
    autoClear: renderer.autoClear,
    autoClearColor: renderer.autoClearColor,
    autoClearDepth: renderer.autoClearDepth,
    autoClearStencil: renderer.autoClearStencil,
    shadowEnabled: renderer.shadowMap.enabled,
    shadowType: renderer.shadowMap.type,
    shadowAutoUpdate: renderer.shadowMap.autoUpdate,
    scissorTest: renderer.getScissorTest(),
  };
}

export function restoreRendererState(renderer: WebGLRenderer, s: RendererState): void {
  renderer.setRenderTarget(s.target);
  renderer.toneMapping = s.toneMapping;
  renderer.toneMappingExposure = s.exposure;
  renderer.outputColorSpace = s.outputColorSpace;
  renderer.setClearColor(s.clearColor, s.clearAlpha);
  renderer.autoClear = s.autoClear;
  renderer.autoClearColor = s.autoClearColor;
  renderer.autoClearDepth = s.autoClearDepth;
  renderer.autoClearStencil = s.autoClearStencil;
  renderer.shadowMap.enabled = s.shadowEnabled;
  renderer.shadowMap.type = s.shadowType;
  renderer.shadowMap.autoUpdate = s.shadowAutoUpdate;
  renderer.setScissorTest(s.scissorTest);
}

/** Ombres temps réel : PCF filtré (le rayon de flou de chaque lumière donne la douceur). */
export function applyShadowSettings(renderer: WebGLRenderer, quality: RenderSettings['shadows'] | 'none'): void {
  const enabled = quality === 'low' || quality === 'high';
  renderer.shadowMap.enabled = enabled;
  // PCFSoftShadowMap a été retiré de three (r18x) : PCFShadowMap + shadow.radius donne des ombres douces.
  renderer.shadowMap.type = PCFShadowMap;
}

/** Cède la main à la boucle d'événements (interface, autres rendus) avant de continuer. */
export function yieldToUI(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Erreur standard d'annulation, attendue par l'interface. */
export function abortError(): Error {
  return new Error('Rendu annulé');
}

/**
 * Lit (de façon synchrone) une cible RGBA 8 bits déjà en sRGB et renvoie ses pixels de
 * haut en bas (WebGL lit de bas en haut). `alphaMask`, s'il est fourni, remplace le canal
 * alpha (même taille, même orientation que la cible) ; `opaque` force alpha = 1.
 */
export function readTargetRGBA(
  renderer: WebGLRenderer,
  target: WebGLRenderTarget,
  width: number,
  height: number,
  opts: { opaque: boolean; alphaMask?: Uint8Array | null },
): Uint8ClampedArray {
  const raw = new Uint8Array(width * height * 4);
  renderer.readRenderTargetPixels(target, 0, 0, width, height, raw);
  const out = new Uint8ClampedArray(width * height * 4);
  const row = width * 4;
  const mask = opts.alphaMask ?? null;
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * row;
    const dst = y * row;
    out.set(raw.subarray(src, src + row), dst);
    if (opts.opaque) {
      for (let x = 3; x < row; x += 4) out[dst + x] = 255;
    } else if (mask) {
      for (let x = 3; x < row; x += 4) out[dst + x] = mask[src + x];
    }
  }
  return out;
}

/**
 * Encode des pixels RGBA (haut → bas) en data URL via un canvas 2D :
 * PNG sans perte par défaut, JPEG (plus rapide, opaque) pour les aperçus.
 */
export async function pixelsToDataUrl(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  format: 'png' | 'jpeg' = 'png',
): Promise<string> {
  const image = new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, width, height);
  const type = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error("Impossible de créer le canvas d'encodage de l'image");
    ctx.putImageData(image, 0, 0);
    const url = canvas.toDataURL(type, 0.85);
    canvas.width = canvas.height = 0;
    return url;
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error("Impossible de créer le canvas d'encodage de l'image");
    ctx.putImageData(image, 0, 0);
    const blob = await canvas.convertToBlob({ type, quality: 0.85 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${type};base64,${btoa(bin)}`;
  }
  throw new Error("Aucun canvas disponible pour encoder l'image");
}

/**
 * Attend que le GPU ait terminé les commandes déjà soumises, sans bloquer le thread
 * (barrière WebGL2 interrogée entre deux tâches). Évite d'empiler des échantillons de path
 * tracing dans la file du GPU, ce qui figerait l'interface ou déclencherait le chien de
 * garde du pilote.
 */
export async function waitForGpu(renderer: WebGLRenderer, timeoutMs = 10000): Promise<void> {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  if (typeof gl.fenceSync !== 'function') return;
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!sync) return;
  gl.flush();
  const start = performance.now();
  try {
    for (;;) {
      const st = gl.clientWaitSync(sync, 0, 0);
      if (st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED || st === gl.WAIT_FAILED) return;
      if (performance.now() - start > timeoutMs) return;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  } finally {
    gl.deleteSync(sync);
  }
}
