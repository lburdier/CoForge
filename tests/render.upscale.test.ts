import { describe, expect, it } from 'vitest';
import { SCENE_DEFAULTS } from '../src/core/doc/schema';
import { SceneDoc } from '../src/core/doc/SceneDoc';
import { UPSCALE_SCALES, denoiseStrength, samplesPerFrame, upscaleScale } from '../src/engine/render/upscale';

describe('super-résolution du path tracing', () => {
  it('échelles : 1 sans mise à l’échelle, décroissantes ensuite', () => {
    expect(upscaleScale('off')).toBe(1);
    expect(upscaleScale(undefined)).toBe(1);
    const order = ['off', 'quality', 'balanced', 'performance', 'ultra'] as const;
    for (let i = 1; i < order.length; i++) expect(UPSCALE_SCALES[order[i]]).toBeLessThan(UPSCALE_SCALES[order[i - 1]]);
  });

  it('plus la résolution interne est basse, plus on trace d’échantillons par image (borné)', () => {
    expect(samplesPerFrame(1)).toBe(1);
    expect(samplesPerFrame(0.5)).toBeGreaterThan(1);
    expect(samplesPerFrame(0.333)).toBeLessThanOrEqual(4);
  });

  it('le débruitage faiblit avec les échantillons puis s’arrête', () => {
    const a = denoiseStrength(1)!;
    const b = denoiseStrength(64)!;
    expect(a.sigma).toBeGreaterThan(b.sigma);
    expect(a.threshold).toBeGreaterThan(b.threshold);
    expect(denoiseStrength(1024)).toBeNull();
  });

  it('réglages présents par défaut et modifiables dans le document', () => {
    expect(SCENE_DEFAULTS.render.upscale).toBe('balanced');
    const doc = SceneDoc.createNew();
    expect(doc.getScene().render.denoise).toBe(true);
    doc.updateRender({ upscale: 'ultra', denoise: false });
    expect(doc.getScene().render).toMatchObject({ upscale: 'ultra', denoise: false });
  });
});
