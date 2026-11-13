import { SCENE_DEFAULTS, type RenderSettings } from '../../core/doc/schema';

/**
 * Lecture TOLÉRANTE des réglages de path tracing (fonctions pures, sans three.js).
 *
 * Les réglages viennent du document partagé : une scène ancienne (CoForge 0.3) ou écrite par un
 * autre client peut ne pas avoir les champs récents, ou contenir des valeurs mal formées. Toute
 * lecture passe donc par ces fonctions, qui bornent les nombres et retombent sur les valeurs par
 * défaut de `SCENE_DEFAULTS.render`.
 */

const D = SCENE_DEFAULTS.render;

export type DenoiserKind = 'none' | 'fast' | 'hq';

function num(v: unknown, fallback: number, lo: number, hi: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return n < lo ? lo : n > hi ? hi : n;
}

function int(v: unknown, fallback: number, lo: number, hi: number): number {
  return Math.round(num(v, fallback, lo, hi));
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function denoiserKind(v: unknown, fallback: DenoiserKind): DenoiserKind {
  return v === 'none' || v === 'fast' || v === 'hq' ? v : fallback;
}

/**
 * Débruiteur effectif d'un usage.
 *
 * Compatibilité : avant la v0.4, seul le booléen `denoise` existait (débruitage bilatéral du
 * viewport, le rendu final n'était jamais débruité). Il garde ce sens : `denoise === false`
 * coupe le débruitage du viewport quel que soit `viewportDenoiser`. Une scène ancienne sans
 * `viewportDenoiser` retrouve donc exactement l'ancien comportement (« Rapide »).
 */
export function resolveDenoiser(s: Partial<RenderSettings>, use: 'viewport' | 'final'): DenoiserKind {
  if (use === 'viewport') {
    if (!bool(s.denoise, D.denoise)) return 'none';
    return denoiserKind(s.viewportDenoiser, D.viewportDenoiser ?? 'fast');
  }
  if (!bool(s.denoiseFinal, D.denoiseFinal ?? true)) return 'none';
  return denoiserKind(s.denoiser, D.denoiser ?? 'hq');
}

/** Réglages du débruiteur haute qualité (à-trous guidé). */
export interface AtrousParams {
  iterations: number;
  strength: number;
  normalWeight: number;
  albedoWeight: number;
}

export function readAtrousParams(s: Partial<RenderSettings>): AtrousParams {
  return {
    iterations: int(s.denoiseIterations, D.denoiseIterations ?? 4, 1, 6),
    strength: num(s.denoiseStrength, D.denoiseStrength ?? 1, 0, 10),
    normalWeight: num(s.denoiseNormalWeight, D.denoiseNormalWeight ?? 1, 0, 10),
    albedoWeight: num(s.denoiseAlbedoWeight, D.denoiseAlbedoWeight ?? 1, 0, 10),
  };
}

/** Réglages du bloom du path tracing ; null s'il est désactivé (aucune passe, aucun coût). */
export interface BloomParams {
  intensity: number;
  threshold: number;
  radius: number;
}

export function readBloomParams(s: Partial<RenderSettings>): BloomParams | null {
  if (!bool(s.ptBloom, D.ptBloom ?? false)) return null;
  const intensity = num(s.ptBloomIntensity, D.ptBloomIntensity ?? 0.3, 0, 10);
  if (intensity <= 0) return null;
  return {
    intensity,
    threshold: num(s.ptBloomThreshold, D.ptBloomThreshold ?? 1, 0, 1000),
    radius: num(s.ptBloomRadius, D.ptBloomRadius ?? 0.5, 0, 1),
  };
}

/** Chemins de lumière et échantillonnage du path tracer. */
export interface TracerParams {
  bounces: number;
  transmissionBounces: number;
  filterGlossy: number;
  seed: number;
  sampleClamp: number;
}

export function readTracerParams(s: Partial<RenderSettings>): TracerParams {
  return {
    bounces: int(s.bounces, D.bounces, 1, 64),
    transmissionBounces: int(s.transmissionBounces, D.transmissionBounces ?? 8, 0, 64),
    filterGlossy: num(s.filterGlossy, D.filterGlossy ?? 0.5, 0, 1),
    seed: int(s.seed, D.seed ?? 0, 0, 2147483647),
    sampleClamp: num(s.sampleClamp, D.sampleClamp ?? 0, 0, 1e6),
  };
}

/** Échantillons du viewport : minimum avant affichage, maximum accumulé. */
export function readViewportSamples(s: Partial<RenderSettings>): { min: number; max: number } {
  const max = int(s.viewportSamples, D.viewportSamples, 1, 100000);
  const min = Math.min(max, int(s.viewportMinSamples, D.viewportMinSamples ?? 1, 1, 100000));
  return { min, max };
}

/** Limite de temps du rendu final, en millisecondes (0 = aucune). */
export function timeLimitMs(s: Partial<RenderSettings>): number {
  return num(s.timeLimit, D.timeLimit ?? 0, 0, 86400) * 1000;
}

export type PostPass = 'denoise-fast' | 'denoise-hq' | 'upscale' | 'bloom';

/**
 * Enchaînement des passes appliquées à l'accumulation HDR linéaire, dans l'ordre :
 * débruitage (à la résolution interne), remise à l'échelle, bloom (à la résolution de sortie),
 * puis — hors de cette liste — tone mapping et sortie sRGB. Liste vide : l'accumulation est
 * présentée telle quelle (aucune passe, aucun coût).
 *
 * `fastActive` : le débruiteur rapide a encore quelque chose à faire (il s'éteint une fois
 * l'image convergée, voir `denoiseStrength`).
 */
export function planPostPasses(o: { denoiser: DenoiserKind; fastActive: boolean; scaled: boolean; bloom: boolean }): PostPass[] {
  const out: PostPass[] = [];
  if (o.denoiser === 'hq') out.push('denoise-hq');
  else if (o.denoiser === 'fast' && o.fastActive) out.push('denoise-fast');
  if (o.scaled) out.push('upscale');
  if (o.bloom) out.push('bloom');
  return out;
}
