import { DataTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace, RepeatWrapping, RGBAFormat, Texture, UnsignedByteType } from 'three';
import type { SceneDoc } from '../core/doc/SceneDoc';
import { getImage, onImagesChanged } from '../core/nodes/shader/images';
import { setImageAverage } from '../core/nodes/shader/cpu';
import { srgbToLinear } from '../core/nodes/shaderCompile';

/**
 * Textures three.js des images du document (nœuds Texture image / d'environnement).
 * Décodage asynchrone (createImageBitmap) ; en attendant, une texture grise 1×1. Les octets sont
 * envoyés tels quels (NoColorSpace) : la conversion sRVB → linéaire est faite dans le shader selon
 * l'« Espace de couleur » du nœud. La couleur moyenne de l'image est calculée au décodage et
 * transmise au repli CPU (path tracing, champs simples).
 */

const placeholder = (() => {
  const t = new DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, RGBAFormat, UnsignedByteType);
  t.needsUpdate = true;
  return t;
})();

interface Entry {
  texture: Texture | null;
  loading: boolean;
  failed: boolean;
  bytes: Uint8Array | null;
}

const entries = new WeakMap<SceneDoc, Map<string, Entry>>();
const watching = new WeakSet<SceneDoc>();
const listeners = new Set<(ids: string[]) => void>();

/** Appelé quand des images deviennent disponibles (décodées) : les matériaux concernés sont à relire. */
export function onNodeImagesReady(cb: (ids: string[]) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function notify(ids: string[]): void {
  for (const l of listeners) l(ids);
}

function averageOf(bmp: ImageBitmap): [number, number, number, number] | null {
  try {
    const n = 16;
    const cv = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(n, n) : Object.assign(document.createElement('canvas'), { width: n, height: n });
    const ctx = cv.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, n, n);
    const d = ctx.getImageData(0, 0, n, n).data;
    const acc = [0, 0, 0, 0];
    for (let i = 0; i < d.length; i += 4) {
      for (let k = 0; k < 3; k++) acc[k] += srgbToLinear(d[i + k] / 255);
      acc[3] += d[i + 3] / 255;
    }
    const c = d.length / 4;
    return [acc[0] / c, acc[1] / c, acc[2] / c, acc[3] / c];
  } catch {
    return null;
  }
}

function load(doc: SceneDoc, id: string, e: Entry): void {
  const img = getImage(doc, id);
  if (!img || typeof createImageBitmap !== 'function') return;
  if (e.bytes === img.bytes && (e.texture || e.loading)) return;
  e.bytes = img.bytes;
  e.loading = true;
  createImageBitmap(new Blob([img.bytes as BlobPart], { type: img.mime }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
    .then((bmp) => {
      const avg = averageOf(bmp);
      if (avg) setImageAverage(id, avg);
      const tex = new Texture(bmp);
      tex.colorSpace = NoColorSpace;
      tex.flipY = false;
      tex.wrapS = tex.wrapT = RepeatWrapping;
      tex.minFilter = LinearMipmapLinearFilter;
      tex.magFilter = LinearFilter;
      tex.generateMipmaps = true;
      tex.anisotropy = 4;
      tex.needsUpdate = true;
      e.texture?.dispose();
      e.texture = tex;
      e.loading = false;
      notify([id]);
    })
    .catch(() => {
      e.loading = false;
      e.failed = true;
    });
}

/** Texture d'une image (grise tant qu'elle n'est pas décodée ou si elle n'existe pas encore). */
export function nodeImageTexture(doc: SceneDoc, id: string): Texture {
  let map = entries.get(doc);
  if (!map) entries.set(doc, (map = new Map()));
  if (!watching.has(doc)) {
    watching.add(doc);
    // Image arrivée d'un autre client (ou remplacée) après le nœud qui la référence.
    onImagesChanged(doc, (ids) => {
      const m = entries.get(doc);
      for (const i of ids) {
        const e = m?.get(i);
        if (e) load(doc, i, e);
      }
    });
  }
  let e = map.get(id);
  if (!e) map.set(id, (e = { texture: null, loading: false, failed: false, bytes: null }));
  if (!e.texture && !e.loading && !e.failed) load(doc, id, e);
  return e.texture ?? placeholder;
}
