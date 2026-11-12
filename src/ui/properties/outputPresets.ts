import type { RenderSettings } from '../../core/doc/schema';

/** Réglages de sortie : préréglages de résolution, taille finale, rapport d'aspect (logique pure). */

export const RES_MIN = 16;
export const RES_MAX = 16384;

export interface ResolutionPreset {
  id: string;
  label: string;
  resX: number;
  resY: number;
}

export const RESOLUTION_PRESETS: ResolutionPreset[] = [
  { id: 'hd720', label: 'HD 720p — 1280 × 720', resX: 1280, resY: 720 },
  { id: 'hd1080', label: 'Full HD 1080p — 1920 × 1080', resX: 1920, resY: 1080 },
  { id: 'qhd', label: 'QHD 1440p — 2560 × 1440', resX: 2560, resY: 1440 },
  { id: 'uhd4k', label: '4K UHD — 3840 × 2160', resX: 3840, resY: 2160 },
  { id: 'dci4k', label: '4K DCI — 4096 × 2160', resX: 4096, resY: 2160 },
  { id: 'square1k', label: 'Carré — 1080 × 1080', resX: 1080, resY: 1080 },
  { id: 'square2k', label: 'Carré — 2048 × 2048', resX: 2048, resY: 2048 },
  { id: 'vertical', label: 'Vertical 9:16 — 1080 × 1920', resX: 1080, resY: 1920 },
  { id: 'portrait45', label: 'Portrait 4:5 — 1080 × 1350', resX: 1080, resY: 1350 },
  { id: 'photo32', label: 'Photo 3:2 — 3000 × 2000', resX: 3000, resY: 2000 },
  { id: 'scope', label: 'Cinémascope 2,39:1 — 2048 × 858', resX: 2048, resY: 858 },
];

/** Préréglage dont la résolution est exactement celle des réglages, ou null (« Personnalisé »). */
export function matchResolutionPreset(r: Pick<RenderSettings, 'resX' | 'resY'>): ResolutionPreset | null {
  return RESOLUTION_PRESETS.find((p) => p.resX === r.resX && p.resY === r.resY) ?? null;
}

function finite(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Borne une dimension en pixels (entier dans [RES_MIN, RES_MAX]). */
export function clampResolution(v: number): number {
  return Math.max(RES_MIN, Math.min(RES_MAX, Math.round(finite(v, 1920))));
}

/** Pourcentage de résolution borné (1..400), 100 si la donnée est absente ou invalide. */
export function clampPercent(v: unknown): number {
  return Math.max(1, Math.min(400, Math.round(finite(v, 100))));
}

/** Taille réelle de l'image produite : résolution × pourcentage, au moins 1 px. */
export function outputSize(r: Pick<RenderSettings, 'resX' | 'resY'> & { resPercent?: number }): { width: number; height: number } {
  const k = clampPercent(r.resPercent) / 100;
  return {
    width: Math.max(1, Math.round(finite(r.resX, 1920) * k)),
    height: Math.max(1, Math.round(finite(r.resY, 1080) * k)),
  };
}

/** Rapport largeur / hauteur de l'image. */
export function aspectRatio(r: Pick<RenderSettings, 'resX' | 'resY'>): number {
  const x = finite(r.resX, 1920);
  const y = finite(r.resY, 1080);
  return x > 0 && y > 0 ? x / y : 1;
}

function gcd(a: number, b: number): number {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

/**
 * Rapport d'aspect lisible : « 16:9 », « 1:1 », « 9:16 » quand la fraction réduite est simple,
 * sinon une forme décimale (« 2,39:1 », « 1:1,25 »).
 */
export function aspectLabel(resX: number, resY: number): string {
  const x = Math.round(finite(resX, 0));
  const y = Math.round(finite(resY, 0));
  if (x <= 0 || y <= 0) return '—';
  const g = gcd(x, y);
  const a = x / g;
  const b = y / g;
  if (a <= 21 && b <= 21) return `${a}:${b}`;
  const dec = (v: number) => (Math.round(v * 100) / 100).toString().replace('.', ',');
  return x >= y ? `${dec(x / y)}:1` : `1:${dec(y / x)}`;
}

/** Nombre de mégapixels de l'image produite, arrondi au centième. */
export function megapixels(width: number, height: number): number {
  return Math.round((width * height) / 10000) / 100;
}

export type ImageFormat = RenderSettings['format'];

export const FORMAT_LABELS: Record<ImageFormat, string> = {
  png: 'PNG (sans perte)',
  jpeg: 'JPEG',
  webp: 'WebP',
};

/** Le réglage de qualité n'a de sens que pour les formats avec perte. */
export function formatHasQuality(format: ImageFormat | undefined): boolean {
  return format === 'jpeg' || format === 'webp';
}

/** Le JPEG n'a pas de couche alpha : le fond transparent y est impossible. */
export function formatHasAlpha(format: ImageFormat | undefined): boolean {
  return format !== 'jpeg';
}

/** Format lu dans le document, ramené à une valeur connue. */
export function safeFormat(format: unknown): ImageFormat {
  return format === 'jpeg' || format === 'webp' ? format : 'png';
}

/** Qualité bornée 1..100 (90 par défaut). */
export function clampQuality(v: unknown): number {
  return Math.max(1, Math.min(100, Math.round(finite(v, 90))));
}
