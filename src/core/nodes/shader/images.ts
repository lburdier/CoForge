import * as Y from 'yjs';
import type { SceneDoc } from '../../doc/SceneDoc';

/**
 * IMAGES DU DOCUMENT (nœud « Texture image »).
 *
 * Les images sont stockées DANS le document partagé (Y.Map de premier niveau 'images', ajoutée de
 * façon additive : aucune autre table n'est touchée), pour que tous les collaborateurs les voient
 * et qu'elles soient enregistrées dans le fichier .coforge. Une image est un bloc immuable :
 * l'ajouter ou la supprimer n'entre pas dans l'historique d'annulation (seul le nœud qui la
 * référence, par sa propriété `image` = identifiant, y entre).
 *
 * API utilisée par l'éditeur de nœuds (zone « noeuds-editeur ») :
 *
 *   importImage(doc, name, bytes, mime?) : Promise<string>
 *       Point d'entrée conseillé (bouton « Ouvrir » du nœud) : décode l'image (PNG / JPEG / WebP),
 *       la réduit à IMAGE_MAX_SIDE px sur son plus grand côté, la ré-encode si nécessaire, puis
 *       l'ajoute au document. Renvoie l'identifiant. Rejette une `ImageError` (message français à
 *       montrer tel quel) si le format n'est pas pris en charge ou si l'image dépasse IMAGE_MAX_BYTES
 *       après réduction. Navigateur / Electron uniquement (createImageBitmap + canvas).
 *   addImage(doc, name, bytes, mime, size?) : string
 *       Ajout direct d'octets déjà prêts (sans décodage ni réduction) ; mêmes contrôles de taille et
 *       de format. Utilisable hors navigateur (tests, import).
 *   getImage(doc, id) : DocImage | null        listImages(doc) : DocImage[]
 *   removeImage(doc, id)                        onImagesChanged(doc, cb) : () => void (désabonnement)
 *   imageMimeFromName(fileName) : mime | null   IMAGE_FILE_FILTER : filtre pour platform.openFile
 *
 * Un `DocImage` lu peut venir d'un autre client : il est validé (octets, dimensions, type MIME).
 */

export const IMAGE_MAX_SIDE = 2048;
/** Taille maximale d'une image stockée (après réduction) : au-delà, refus avec message. */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type ImageMime = (typeof IMAGE_MIMES)[number];

export const IMAGE_FILE_FILTER = { name: 'Images (PNG, JPEG, WebP)', extensions: ['png', 'jpg', 'jpeg', 'webp'] };

export interface DocImage {
  id: string;
  name: string;
  mime: ImageMime;
  width: number;
  height: number;
  bytes: Uint8Array;
}

export class ImageError extends Error {}

const MAP = 'images';

function ymap(doc: SceneDoc): Y.Map<unknown> {
  return doc.ydoc.getMap(MAP);
}

export function imageMimeFromName(name: string): ImageMime | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return null;
}

/** Type réel d'après la signature des octets (plus sûr que l'extension). */
export function sniffImageMime(b: Uint8Array): ImageMime | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

function mb(n: number): string {
  return (n / (1024 * 1024)).toFixed(1).replace('.', ',');
}

function newImageId(): string {
  return `img${Date.now().toString(36)}${Math.floor(Math.random() * 1679616).toString(36)}`;
}

/** Ajoute une image déjà prête au document ; renvoie son identifiant. */
export function addImage(doc: SceneDoc, name: string, bytes: Uint8Array, mime?: string, size?: { width: number; height: number }): string {
  const real = sniffImageMime(bytes) ?? (IMAGE_MIMES as readonly string[]).find((m) => m === mime) ?? null;
  if (!real) throw new ImageError('Format d’image non pris en charge : utilisez une image PNG, JPEG ou WebP.');
  if (bytes.length > IMAGE_MAX_BYTES) {
    throw new ImageError(`Image trop lourde (${mb(bytes.length)} Mo) : la limite est de ${mb(IMAGE_MAX_BYTES)} Mo par image, car elle est partagée avec tous les collaborateurs.`);
  }
  const id = newImageId();
  const rec = {
    name: String(name || 'Image').slice(0, 128),
    mime: real,
    width: Math.max(0, Math.round(size?.width ?? 0)),
    height: Math.max(0, Math.round(size?.height ?? 0)),
    bytes: new Uint8Array(bytes),
  };
  doc.ydoc.transact(() => ymap(doc).set(id, rec));
  return id;
}

export function getImage(doc: SceneDoc, id: unknown): DocImage | null {
  if (typeof id !== 'string' || !id) return null;
  const raw = ymap(doc).get(id) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object' || !(raw.bytes instanceof Uint8Array)) return null;
  const mime = sniffImageMime(raw.bytes) ?? ((IMAGE_MIMES as readonly string[]).includes(String(raw.mime)) ? (raw.mime as ImageMime) : null);
  if (!mime) return null;
  const n = (v: unknown) => (Number.isFinite(v) ? Math.max(0, Math.round(v as number)) : 0);
  return { id, name: typeof raw.name === 'string' ? raw.name : 'Image', mime, width: n(raw.width), height: n(raw.height), bytes: raw.bytes };
}

export function listImages(doc: SceneDoc): DocImage[] {
  return [...ymap(doc).keys()].map((id) => getImage(doc, id)).filter((x): x is DocImage => !!x);
}

export function removeImage(doc: SceneDoc, id: string): void {
  doc.ydoc.transact(() => ymap(doc).delete(id));
}

/** Appelé avec les identifiants ajoutés / modifiés / supprimés (local ou distant). */
export function onImagesChanged(doc: SceneDoc, cb: (ids: string[]) => void): () => void {
  const m = ymap(doc);
  const fn = (e: Y.YMapEvent<unknown>) => cb([...e.keysChanged]);
  m.observe(fn);
  return () => m.unobserve(fn);
}

// ------------------------------------------------------------------ décodage et réduction (navigateur)

/** Dimensions réduites pour que le plus grand côté tienne dans `max`. */
export function fitImageSize(w: number, h: number, max = IMAGE_MAX_SIDE): { width: number; height: number } {
  const s = Math.min(1, max / Math.max(w, h, 1));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/**
 * Décode, réduit (≤ IMAGE_MAX_SIDE) et ré-encode une image. Une image déjà assez petite est gardée
 * telle quelle (octets d'origine). PNG reste PNG (transparence) ; une image réduite JPEG / WebP est
 * ré-encodée dans son format (qualité 0,9).
 */
export async function prepareImage(bytes: Uint8Array, mime?: string): Promise<{ bytes: Uint8Array; mime: ImageMime; width: number; height: number }> {
  const real: ImageMime | null = sniffImageMime(bytes) ?? IMAGE_MIMES.find((m) => m === mime) ?? null;
  if (!real) throw new ImageError('Format d’image non pris en charge : utilisez une image PNG, JPEG ou WebP.');
  if (typeof createImageBitmap !== 'function') throw new ImageError('Décodage d’image indisponible dans cet environnement.');
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: real }));
  } catch {
    throw new ImageError('Image illisible ou corrompue.');
  }
  const { width, height } = fitImageSize(bmp.width, bmp.height);
  if (width === bmp.width && height === bmp.height && bytes.length <= IMAGE_MAX_BYTES) {
    bmp.close();
    return { bytes, mime: real, width, height };
  }
  let out: Blob;
  if (typeof OffscreenCanvas === 'function') {
    const cv = new OffscreenCanvas(width, height);
    const ctx = cv.getContext('2d');
    if (!ctx) throw new ImageError('Réduction de l’image impossible (canvas indisponible).');
    ctx.drawImage(bmp, 0, 0, width, height);
    out = await cv.convertToBlob({ type: real, quality: 0.9 });
  } else {
    const cv = document.createElement('canvas');
    cv.width = width;
    cv.height = height;
    const ctx = cv.getContext('2d');
    if (!ctx) throw new ImageError('Réduction de l’image impossible (canvas indisponible).');
    ctx.drawImage(bmp, 0, 0, width, height);
    out = await new Promise<Blob>((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new ImageError('Encodage de l’image impossible.'))), real, 0.9));
  }
  bmp.close();
  const data = new Uint8Array(await out.arrayBuffer());
  // Le navigateur peut ré-encoder dans un autre format (WebP non pris en charge à l'écriture) : on relit la signature.
  return { bytes: data, mime: sniffImageMime(data) ?? 'image/png', width, height };
}

/** Décode, réduit et ajoute une image au document ; renvoie son identifiant. */
export async function importImage(doc: SceneDoc, name: string, bytes: Uint8Array, mime?: string): Promise<string> {
  const ready = await prepareImage(bytes, mime ?? imageMimeFromName(name) ?? undefined);
  return addImage(doc, name.replace(/\.[^.]+$/, ''), ready.bytes, ready.mime, ready);
}
