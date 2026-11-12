import { WebGLRenderTarget, type Camera, type OrthographicCamera, type PerspectiveCamera, type Scene, type WebGLRenderer } from 'three';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { RenderSettings } from '../../core/doc/schema';
import { RealtimeChain, applyShadowQuality, presentTexture, renderCoverageMask } from './realtime';
import { PathTracerHost, hasTraceableMesh } from './pathtracer';
import {
  abortError,
  applyColorManagement,
  applyShadowSettings,
  clampNum,
  finiteOr,
  pixelsToDataUrl,
  readTargetRGBA,
  restoreRendererState,
  saveRendererState,
  waitForGpu,
  yieldToUI,
} from './state';

export interface FinalImageArgs {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: Camera;
  settings: RenderSettings;
  width: number;
  height: number;
  samples: number;
  onProgress(progress: number, samples: number, previewUrl: string | null): void;
  signal: AbortSignal;
}

/** Intervalle minimal entre deux aperçus (ms) et côté maximal de l'aperçu (px). */
const PREVIEW_INTERVAL_MS = 1500;
const PREVIEW_MAX_SIDE = 1024;
/** Au-delà, la compilation du shader de path tracing est considérée comme bloquée. */
const COMPILE_TIMEOUT_MS = 180000;

/**
 * Rendu de l'image finale hors écran, dans des cibles dédiées : la taille du canvas et
 * l'état du renderer sont restaurés à l'identique (y compris entre deux échantillons,
 * pendant lesquels le viewport continue de dessiner). Résout avec une data URL PNG ;
 * rejette avec Error('Rendu annulé') si `signal` est abandonné.
 */
export async function renderFinalImage(a: FinalImageArgs): Promise<string> {
  if (a.signal.aborted) throw abortError();
  const width = Math.max(1, Math.round(finiteOr(a.width, 1920)));
  const height = Math.max(1, Math.round(finiteOr(a.height, 1080)));
  const maxSide = maxRenderSize(a.renderer);
  if (width > maxSide || height > maxSide) {
    throw new Error(`Résolution trop élevée pour ce GPU (${maxSide} px maximum par côté)`);
  }
  const camera = cameraForAspect(a.camera, width / height);
  const args = { ...a, width, height, camera };
  safeProgress(a, 0, 0, null);

  if (a.settings.engine === 'pathtrace' && hasTraceableMesh(a.scene)) {
    try {
      return await renderPathTraced(args);
    } catch (err) {
      if (a.signal.aborted || (err instanceof Error && err.message === 'Rendu annulé')) throw abortError();
      console.warn('Path tracing indisponible pour le rendu final, repli sur le moteur temps réel', err);
    }
  }
  return renderRealtime(args);
}

// ------------------------------------------------------------------ temps réel

async function renderRealtime(a: FinalImageArgs): Promise<string> {
  const { renderer, scene, camera, settings, width, height } = a;
  const transparent = settings.transparentBg === true;
  const state = saveRendererState(renderer);
  const prevBackground = scene.background;
  const chain = new RealtimeChain(renderer, 4);
  const out = new WebGLRenderTarget(width, height, { depthBuffer: false });
  let pixels: Uint8ClampedArray;
  try {
    applyColorManagement(renderer, settings);
    applyShadowSettings(renderer, settings.shadows);
    applyShadowQuality(scene, settings.shadows);
    chain.setSize(width, height);
    if (transparent) scene.background = null;
    const hdr = chain.renderHDR(scene, camera, settings, transparent ? { clearAlpha: 0 } : {});
    presentTexture(renderer, chain.output, hdr, out);
    // Les passes AO/bloom ne conservent pas l'alpha : il vient d'un masque de couverture.
    const mask = transparent ? renderCoverageMask(renderer, scene, camera, width, height) : null;
    pixels = readTargetRGBA(renderer, out, width, height, { opaque: !transparent, alphaMask: mask });
  } finally {
    scene.background = prevBackground;
    restoreRendererState(renderer, state);
    chain.dispose();
    out.dispose();
  }
  if (a.signal.aborted) throw abortError();
  const url = await pixelsToDataUrl(pixels, width, height, 'png');
  if (a.signal.aborted) throw abortError();
  safeProgress(a, 1, 0, url);
  return url;
}

// ------------------------------------------------------------------ path tracing

async function renderPathTraced(a: FinalImageArgs): Promise<string> {
  const { renderer, scene, camera, settings, width, height, signal } = a;
  const transparent = settings.transparentBg === true;
  const target = Math.round(clampNum(finiteOr(a.samples, settings.samples), 1, 100000));
  // Grandes images : rendu par tuiles pour garder chaque appel GPU court (chien de garde du pilote).
  const pixelsCount = width * height;
  const tiles = pixelsCount > 6e6 ? 4 : pixelsCount > 2.5e6 ? 3 : pixelsCount > 1.2e6 ? 2 : 1;

  const host = new PathTracerHost(renderer, tiles);
  const output = new OutputPass();
  const out = new WebGLRenderTarget(width, height, { depthBuffer: false });
  const pScale = Math.min(1, PREVIEW_MAX_SIDE / Math.max(width, height));
  const pw = Math.max(1, Math.round(width * pScale));
  const ph = Math.max(1, Math.round(height * pScale));
  const previewRT = new WebGLRenderTarget(pw, ph, { depthBuffer: false });

  /** Exécute un bloc synchrone avec l'état du renderer propre au rendu final, puis restaure. */
  const withState = <T>(fn: () => T): T => {
    const state = saveRendererState(renderer);
    try {
      applyColorManagement(renderer, settings);
      return fn();
    } finally {
      restoreRendererState(renderer, state);
    }
  };

  try {
    host.setSize(width, height);
    host.setBounces(settings.bounces);
    withState(() => {
      // L'environnement est déterminé avant de retirer le fond (fond transparent).
      const env = host.environmentFor(scene);
      const prevBackground = scene.background;
      if (transparent) scene.background = null;
      try {
        host.setScene(scene, camera, env);
      } finally {
        scene.background = prevBackground;
      }
    });

    let lastPreview = performance.now();
    let lastReported = -1;
    while (Math.floor(host.samples) < target) {
      if (signal.aborted) throw abortError();
      withState(() => host.renderSample());
      if (host.failed) throw new Error('Le shader de path tracing ne fonctionne pas sur ce GPU');
      if (host.compiling) {
        if (host.compileTime() > COMPILE_TIMEOUT_MS) throw new Error('Compilation du path tracer trop longue');
        await new Promise((resolve) => setTimeout(resolve, 30));
        continue;
      }
      await waitForGpu(renderer);
      const done = Math.floor(host.samples);
      if (done !== lastReported) {
        lastReported = done;
        let preview: string | null = null;
        const now = performance.now();
        if (done >= 1 && done < target && now - lastPreview >= PREVIEW_INTERVAL_MS) {
          lastPreview = now;
          const px = withState(() => {
            presentTexture(renderer, output, host.texture, previewRT);
            return readTargetRGBA(renderer, previewRT, pw, ph, { opaque: true });
          });
          preview = await pixelsToDataUrl(px, pw, ph, 'jpeg');
          if (signal.aborted) throw abortError();
        }
        safeProgress(a, done / target, done, preview);
      }
      await yieldToUI();
    }

    if (signal.aborted) throw abortError();
    const pixels = withState(() => {
      presentTexture(renderer, output, host.texture, out);
      return readTargetRGBA(renderer, out, width, height, { opaque: !transparent });
    });
    const url = await pixelsToDataUrl(pixels, width, height, 'png');
    if (signal.aborted) throw abortError();
    safeProgress(a, 1, Math.floor(host.samples), url);
    return url;
  } finally {
    host.dispose();
    output.dispose();
    out.dispose();
    previewRT.dispose();
  }
}

// ------------------------------------------------------------------ utilitaires

function safeProgress(a: FinalImageArgs, progress: number, samples: number, url: string | null): void {
  try {
    a.onProgress(clampNum(progress, 0, 1), samples, url);
  } catch (err) {
    console.error('Rendu final : erreur dans le suivi de progression', err);
  }
}

function maxRenderSize(renderer: WebGLRenderer): number {
  const gl = renderer.getContext();
  const tex = renderer.capabilities.maxTextureSize || 4096;
  let rb = tex;
  try {
    rb = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || tex;
  } catch {
    /* valeur par défaut */
  }
  return Math.min(tex, rb);
}

/**
 * Copie indépendante de la caméra, figée sur sa pose monde courante, avec une projection
 * adaptée au rapport largeur/hauteur de l'image (la caméra de scène suit sinon celui du viewport).
 */
export function cameraForAspect(src: Camera, aspect: number): Camera {
  src.updateMatrixWorld();
  const cam = src.clone();
  // Les enfants éventuels (gizmos…) sont inutiles au rendu.
  cam.clear();
  cam.matrixAutoUpdate = false;
  cam.matrix.copy(src.matrixWorld);
  cam.matrixWorld.copy(src.matrixWorld);
  cam.matrixWorldInverse.copy(src.matrixWorld).invert();
  const any = cam as any;
  if (any.isPerspectiveCamera) {
    const p = cam as PerspectiveCamera;
    p.clearViewOffset();
    p.aspect = aspect;
    p.updateProjectionMatrix();
  } else if (any.isOrthographicCamera) {
    const o = cam as OrthographicCamera;
    o.clearViewOffset();
    const halfH = (o.top - o.bottom) / 2;
    const cy = (o.top + o.bottom) / 2;
    const cx = (o.left + o.right) / 2;
    o.top = cy + halfH;
    o.bottom = cy - halfH;
    o.left = cx - halfH * aspect;
    o.right = cx + halfH * aspect;
    o.updateProjectionMatrix();
  }
  return cam;
}
