import { describe, expect, it } from 'vitest';
import * as ptLib from 'three-gpu-pathtracer';

// Exporté par le paquet mais absent de ses typages.
const { PhysicalPathTracingMaterial } = ptLib as any;
import { patchSampleClamp } from '../src/engine/render/pathtracer';

describe('écrêtage des lucioles : injection dans le shader de three-gpu-pathtracer', () => {
  it('le shader installé possède le point d’insertion et reçoit un uniform (pas de define)', () => {
    const mat = new PhysicalPathTracingMaterial() as any;
    const defines = JSON.stringify(mat.defines);
    expect(patchSampleClamp(mat)).toBe(true);
    expect(mat.fragmentShader).toContain('uniform float cfSampleClamp;');
    expect(mat.fragmentShader.indexOf('cfSampleClamp > 0.0')).toBeLessThan(mat.fragmentShader.indexOf('gl_FragColor.a *= opacity;'));
    expect(mat.uniforms.cfSampleClamp.value).toBe(0);
    expect(JSON.stringify(mat.defines)).toBe(defines);
    // Idempotent.
    const once = mat.fragmentShader;
    expect(patchSampleClamp(mat)).toBe(true);
    expect(mat.fragmentShader).toBe(once);
    mat.dispose();
  });

  it('shader inconnu : refus propre, rien de modifié', () => {
    const mat = { fragmentShader: 'void main() { gl_FragColor = vec4(1.0); }', uniforms: {} as Record<string, { value: unknown }>, needsUpdate: false };
    expect(patchSampleClamp(mat)).toBe(false);
    expect(mat.fragmentShader).toBe('void main() { gl_FragColor = vec4(1.0); }');
    expect(mat.uniforms.cfSampleClamp).toBeUndefined();
  });
});
