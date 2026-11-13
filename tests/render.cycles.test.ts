import { describe, expect, it } from 'vitest';
import { SCENE_DEFAULTS, type RenderSettings } from '../src/core/doc/schema';
import { SceneDoc } from '../src/core/doc/SceneDoc';
import {
  planPostPasses,
  readAtrousParams,
  readBloomParams,
  readTracerParams,
  readViewportSamples,
  resolveDenoiser,
  timeLimitMs,
} from '../src/engine/render/settings';
import {
  ATROUS_KERNEL,
  albedoFactor,
  atrousColorSigma,
  atrousKernelWeight,
  atrousStep,
  normalExponent,
} from '../src/engine/render/denoise';

/** Réglages tels qu'une scène CoForge 0.3 les contenait (sans aucun champ récent). */
function legacy(patch: Partial<RenderSettings> = {}): Partial<RenderSettings> {
  return {
    engine: 'pathtrace',
    resX: 1920,
    resY: 1080,
    samples: 128,
    viewportSamples: 64,
    bounces: 5,
    upscale: 'balanced',
    denoise: true,
    ao: true,
    bloom: false,
    shadows: 'high',
    exposure: 0,
    toneMapping: 'agx',
    transparentBg: false,
    ...patch,
  };
}

describe('débruiteur : migration du booléen `denoise`', () => {
  it('scène ancienne, denoise vrai : viewport « Rapide » (comportement inchangé), rendu final « Haute qualité »', () => {
    expect(resolveDenoiser(legacy(), 'viewport')).toBe('fast');
    expect(resolveDenoiser(legacy(), 'final')).toBe('hq');
  });

  it('scène ancienne, denoise faux : viewport sans débruitage', () => {
    expect(resolveDenoiser(legacy({ denoise: false }), 'viewport')).toBe('none');
  });

  it('denoise faux l’emporte sur viewportDenoiser', () => {
    expect(resolveDenoiser(legacy({ denoise: false, viewportDenoiser: 'hq' }), 'viewport')).toBe('none');
    expect(resolveDenoiser(legacy({ denoise: true, viewportDenoiser: 'hq' }), 'viewport')).toBe('hq');
  });

  it('rendu final : interrupteur et choix séparés, valeurs inconnues → défaut', () => {
    expect(resolveDenoiser(legacy({ denoiseFinal: false, denoiser: 'hq' }), 'final')).toBe('none');
    expect(resolveDenoiser(legacy({ denoiser: 'fast' }), 'final')).toBe('fast');
    expect(resolveDenoiser(legacy({ denoiser: 'none' }), 'final')).toBe('none');
    expect(resolveDenoiser(legacy({ denoiser: 'optix' as any, denoiseFinal: 'oui' as any }), 'final')).toBe('hq');
    expect(resolveDenoiser({}, 'viewport')).toBe('fast');
  });

  it('SceneDoc : une scène sans les nouveaux champs les lit avec leurs valeurs par défaut', () => {
    const doc = new SceneDoc();
    doc.updateRender({ denoise: false, engine: 'pathtrace' });
    const r = doc.getScene().render;
    expect(r.denoiser).toBe(SCENE_DEFAULTS.render.denoiser);
    expect(r.ptBloom).toBe(false);
    expect(resolveDenoiser(r, 'viewport')).toBe('none');
    expect(resolveDenoiser(r, 'final')).toBe('hq');
    doc.updateRender({ viewportDenoiser: 'hq', denoise: true, ptBloom: true });
    const r2 = doc.getScene().render;
    expect(resolveDenoiser(r2, 'viewport')).toBe('hq');
    expect(readBloomParams(r2)).not.toBeNull();
  });
});

describe('lecture des réglages avec repli', () => {
  it('valeurs absentes → défauts', () => {
    const t = readTracerParams({});
    expect(t.bounces).toBe(SCENE_DEFAULTS.render.bounces);
    expect(t.transmissionBounces).toBe(SCENE_DEFAULTS.render.transmissionBounces);
    expect(t.filterGlossy).toBe(SCENE_DEFAULTS.render.filterGlossy);
    expect(t.seed).toBe(0);
    expect(t.sampleClamp).toBe(0);
    expect(timeLimitMs({})).toBe(0);
    expect(readBloomParams({})).toBeNull();
  });

  it('valeurs mal formées (autre client) → défauts ou bornes', () => {
    const t = readTracerParams({ bounces: NaN, transmissionBounces: -3, filterGlossy: 7, seed: 1.6, sampleClamp: 'x' as any });
    expect(t.bounces).toBe(SCENE_DEFAULTS.render.bounces);
    expect(t.transmissionBounces).toBe(0);
    expect(t.filterGlossy).toBe(1);
    expect(t.seed).toBe(2);
    expect(t.sampleClamp).toBe(0);
    const a = readAtrousParams({ denoiseIterations: 99, denoiseStrength: -1, denoiseNormalWeight: Infinity });
    expect(a.iterations).toBe(6);
    expect(a.strength).toBe(0);
    expect(a.normalWeight).toBe(SCENE_DEFAULTS.render.denoiseNormalWeight);
    expect(timeLimitMs({ timeLimit: 2.5 })).toBe(2500);
  });

  it('échantillons du viewport : le minimum ne dépasse jamais le maximum', () => {
    expect(readViewportSamples({ viewportSamples: 16, viewportMinSamples: 64 })).toEqual({ min: 16, max: 16 });
    expect(readViewportSamples({ viewportSamples: 64 })).toEqual({ min: 1, max: 64 });
  });

  it('bloom : désactivé ou d’intensité nulle → aucune passe', () => {
    expect(readBloomParams({ ptBloom: false, ptBloomIntensity: 1 })).toBeNull();
    expect(readBloomParams({ ptBloom: true, ptBloomIntensity: 0 })).toBeNull();
    expect(readBloomParams({ ptBloom: true, ptBloomIntensity: 2, ptBloomThreshold: -5, ptBloomRadius: 3 })).toEqual({
      intensity: 2,
      threshold: 0,
      radius: 1,
    });
  });
});

describe('à-trous guidé', () => {
  it('noyau B3 : symétrique, somme 1 en 1D comme en 2D', () => {
    expect(ATROUS_KERNEL.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    let sum = 0;
    for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) sum += atrousKernelWeight(x, y);
    expect(sum).toBeCloseTo(1, 12);
    expect(atrousKernelWeight(-1, 2)).toBe(atrousKernelWeight(1, -2));
    expect(atrousKernelWeight(3, 0)).toBe(0);
  });

  it('écart des trous : 1, 2, 4, 8…', () => {
    expect([0, 1, 2, 3].map(atrousStep)).toEqual([1, 2, 4, 8]);
  });

  it('tolérance de couleur : décroît avec les échantillons et les itérations, nulle à force 0', () => {
    expect(atrousColorSigma(1, 1, 0)).toBeGreaterThan(atrousColorSigma(64, 1, 0));
    expect(atrousColorSigma(64, 1, 0)).toBeGreaterThan(atrousColorSigma(4096, 1, 0));
    expect(atrousColorSigma(64, 1, 1)).toBeCloseTo(atrousColorSigma(64, 1, 0) / 2, 12);
    expect(atrousColorSigma(64, 2, 0)).toBeCloseTo(2 * atrousColorSigma(64, 1, 0), 12);
    expect(atrousColorSigma(64, 0, 0)).toBe(0);
    expect(atrousColorSigma(NaN, 1, 0)).toBeGreaterThan(0);
  });

  it('poids des guides : 0 désactive le guide', () => {
    expect(normalExponent(0)).toBe(0);
    expect(albedoFactor(0)).toBe(0);
    expect(normalExponent(2)).toBe(2 * normalExponent(1));
  });
});

describe('enchaînement des passes', () => {
  it('rien d’actif → aucune passe (image présentée telle quelle)', () => {
    expect(planPostPasses({ denoiser: 'none', fastActive: true, scaled: false, bloom: false })).toEqual([]);
    expect(planPostPasses({ denoiser: 'fast', fastActive: false, scaled: false, bloom: false })).toEqual([]);
  });

  it('ordre : débruitage, remise à l’échelle, bloom', () => {
    expect(planPostPasses({ denoiser: 'hq', fastActive: true, scaled: true, bloom: true })).toEqual(['denoise-hq', 'upscale', 'bloom']);
    expect(planPostPasses({ denoiser: 'fast', fastActive: true, scaled: true, bloom: false })).toEqual(['denoise-fast', 'upscale']);
    expect(planPostPasses({ denoiser: 'none', fastActive: true, scaled: false, bloom: true })).toEqual(['bloom']);
  });
});
