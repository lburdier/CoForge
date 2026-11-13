import { describe, expect, it } from 'vitest';
import type { NodeData, NodeLink, NodeTreeData } from '../src/core/doc/schema';
import { compileShaderTree, defaultShaderTree, hexToLinear, linearToHex, materialFallback } from '../src/core/nodes/shaderCompile';
import { SHADER_NODE_TYPES } from '../src/core/nodes/shaderNodes';
import { nodeDefaults, nodeType, socketsCompatible } from '../src/core/nodes/types';

let n = 0;
function node(type: string, inputs: Record<string, unknown> = {}, props: Record<string, unknown> = {}): NodeData {
  const def = nodeType('shader', type);
  if (!def) throw new Error(`type inconnu ${type}`);
  const d = nodeDefaults(def);
  return { id: `n${n++}`, type, x: 0, y: 0, inputs: { ...d.inputs, ...inputs }, props: { ...d.props, ...props } };
}
function link(a: NodeData, out: string, b: NodeData, input: string): NodeLink {
  return { id: `l${n++}`, fromNode: a.id, fromSocket: out, toNode: b.id, toSocket: input };
}
function tree(nodes: NodeData[], links: NodeLink[]): NodeTreeData {
  return { id: 't', name: 't', kind: 'shader', nodes: Object.fromEntries(nodes.map((x) => [x.id, x])), links };
}
/** Principled → Sortie, plus des nœuds en amont. */
function principled(inputs: Record<string, unknown> = {}) {
  const bsdf = node('ShaderNodeBsdfPrincipled', inputs);
  const out = node('ShaderNodeOutputMaterial');
  return { bsdf, out, link: link(bsdf, 'BSDF', out, 'Surface') };
}

describe('compilateur de nœuds de shader', () => {
  it('arbre par défaut : paramètres repris du matériau simple, aucun GLSL', () => {
    const t = defaultShaderTree({ baseColor: '#ff0000', metallic: 0.3, roughness: 0.2, ior: 1.33, alpha: 0.8 });
    const c = compileShaderTree({ id: 't', name: 't', kind: 'shader', ...t });
    expect(c.hasSurface).toBe(true);
    expect(c.varying).toEqual({});
    expect(c.code).toBe('');
    expect(c.params.baseColor[0]).toBeCloseTo(1, 6);
    expect(c.params.baseColor[1]).toBeCloseTo(0, 6);
    expect(c.params.metallic).toBeCloseTo(0.3);
    expect(c.params.roughness).toBeCloseTo(0.2);
    expect(c.params.ior).toBeCloseTo(1.33);
    expect(c.params.alpha).toBeCloseTo(0.8);
    expect(materialFallback({ id: 't', name: 't', kind: 'shader', ...t }).baseColor).toBe('#ff0000');
  });

  it('Principled complet : vernis, lustre, film mince, spéculaire, émission', () => {
    const { bsdf, out, link: l } = principled({
      'Coat Weight': 0.7,
      'Coat Roughness': 0.1,
      'Sheen Weight': 0.4,
      'Sheen Tint': '#ff0000',
      'Thin Film Thickness': 350,
      'Thin Film IOR': 1.4,
      'Specular IOR Level': 0.25,
      'Emission Color': '#00ff00',
      'Emission Strength': 3,
      'Transmission Weight': 0.5,
    });
    const c = compileShaderTree(tree([bsdf, out], [l]));
    expect(c.params.coat).toBeCloseTo(0.7);
    expect(c.params.coatRoughness).toBeCloseTo(0.1);
    expect(c.params.sheen).toBeCloseTo(0.4);
    expect(c.params.sheenTint).toEqual([1, 0, 0]);
    expect(c.params.thinFilmThickness).toBe(350);
    expect(c.params.thinFilmIor).toBeCloseTo(1.4);
    expect(c.params.specularLevel).toBeCloseTo(0.25);
    expect(c.params.emission).toEqual([0, 3, 0]);
    expect(c.params.transmission).toBeCloseTo(0.5);
  });

  it('repli des constantes : Calcul et Mélanger sans GLSL', () => {
    const { bsdf, out, link: l } = principled();
    const v = node('ShaderNodeValue', {}, { value: 0.25 });
    const m = node('ShaderNodeMath', { Value_001: 2 }, { operation: 'MULTIPLY' });
    const rgb1 = node('ShaderNodeRGB', {}, { color: '#ff0000' });
    const rgb2 = node('ShaderNodeRGB', {}, { color: '#0000ff' });
    const mix = node('ShaderNodeMix', { Factor_Float: 0.5 }, { data_type: 'RGBA', blend_type: 'MIX' });
    const c = compileShaderTree(
      tree(
        [bsdf, out, v, m, rgb1, rgb2, mix],
        [l, link(v, 'Value', m, 'Value'), link(m, 'Value', bsdf, 'Roughness'), link(rgb1, 'Color', mix, 'A_Color'), link(rgb2, 'Color', mix, 'B_Color'), link(mix, 'Result_Color', bsdf, 'Base Color')],
      ),
    );
    expect(c.varying).toEqual({});
    expect(c.params.roughness).toBeCloseTo(0.5);
    expect(c.params.baseColor[0]).toBeCloseTo(0.5, 6);
    expect(c.params.baseColor[2]).toBeCloseTo(0.5, 6);
  });

  it('texture de bruit → couleur et relief calculés par pixel (GLSL)', () => {
    const { bsdf, out, link: l } = principled();
    const noise = node('ShaderNodeTexNoise');
    const ramp = node('ShaderNodeValToRGB');
    const bump = node('ShaderNodeBump', { Strength: 0.4 });
    const c = compileShaderTree(
      tree([bsdf, out, noise, ramp, bump], [l, link(noise, 'Fac', ramp, 'Fac'), link(ramp, 'Color', bsdf, 'Base Color'), link(noise, 'Fac', bump, 'Height'), link(bump, 'Normal', bsdf, 'Normal')]),
    );
    expect(c.varying.baseColor).toBeTruthy();
    expect(c.varying.normal).toBeTruthy();
    expect(c.code).toContain('cf_tex_noise');
    expect(c.code).toContain('cf_bump');
    expect(c.library).toContain('cf_noise_perlin');
    expect(c.builtins).toContain('cf_gen');
    // Valeur moyenne pour le path tracer : rampe noir → blanc au milieu.
    expect(c.params.baseColor[0]).toBeGreaterThan(0.1);
    expect(c.params.baseColor[0]).toBeLessThan(0.9);
    expect(c.notes.join(' ')).toMatch(/Path tracing/);
  });

  it('Mélanger les shaders : Principled + Émission à 50 %', () => {
    const p = node('ShaderNodeBsdfPrincipled', { 'Base Color': '#ffffff' });
    const e = node('ShaderNodeEmission', { Color: '#ff0000', Strength: 4 });
    const mix = node('ShaderNodeMixShader', { Fac: 0.5 });
    const out = node('ShaderNodeOutputMaterial');
    const c = compileShaderTree(tree([p, e, mix, out], [link(p, 'BSDF', mix, 'Shader'), link(e, 'Emission', mix, 'Shader_001'), link(mix, 'Shader', out, 'Surface')]));
    expect(c.params.emission[0]).toBeCloseTo(2);
    expect(c.params.baseColor[0]).toBeCloseTo(0.5);
  });

  it('BSDF verre, transparent, diffus', () => {
    const glass = node('ShaderNodeBsdfGlass', { IOR: 1.6, Roughness: 0.1 });
    const out = node('ShaderNodeOutputMaterial');
    let c = compileShaderTree(tree([glass, out], [link(glass, 'BSDF', out, 'Surface')]));
    expect(c.params.transmission).toBe(1);
    expect(c.params.ior).toBeCloseTo(1.6);
    const tr = node('ShaderNodeBsdfTransparent');
    c = compileShaderTree(tree([tr, out], [link(tr, 'BSDF', out, 'Surface')]));
    expect(c.params.alpha).toBe(0);
    const d = node('ShaderNodeBsdfDiffuse', { Color: '#808080' });
    c = compileShaderTree(tree([d, out], [link(d, 'BSDF', out, 'Surface')]));
    expect(c.params.specularLevel).toBe(0);
    expect(c.params.roughness).toBe(1);
  });

  it('sans sortie : noir, et le signale', () => {
    const c = compileShaderTree(tree([node('ShaderNodeBsdfPrincipled')], []));
    expect(c.hasSurface).toBe(false);
    expect(c.params.baseColor).toEqual([0, 0, 0]);
    expect(c.notes.join(' ')).toMatch(/Sortie du matériau/);
  });

  it('boucle dans l’arbre : pas de plantage', () => {
    const { bsdf, out, link: l } = principled();
    const a = node('ShaderNodeMath');
    const b = node('ShaderNodeMath');
    const c = compileShaderTree(tree([bsdf, out, a, b], [l, link(a, 'Value', b, 'Value'), link(b, 'Value', a, 'Value'), link(b, 'Value', bsdf, 'Roughness')]));
    expect(c.notes.join(' ')).toMatch(/Boucle/);
  });

  it('nœud muet : passe sa première entrée', () => {
    const { bsdf, out, link: l } = principled();
    const v = node('ShaderNodeValue', {}, { value: 0.9 });
    const m = node('ShaderNodeMath', { Value_001: 10 }, { operation: 'MULTIPLY' });
    m.muted = true;
    const c = compileShaderTree(tree([bsdf, out, v, m], [l, link(v, 'Value', m, 'Value'), link(m, 'Value', bsdf, 'Roughness')]));
    expect(c.params.roughness).toBeCloseTo(0.9);
  });

  it('chaque type de nœud du catalogue se compile branché sur un Principled', () => {
    for (const def of SHADER_NODE_TYPES) {
      if (def.layout || def.id === 'ShaderNodeOutputMaterial') continue;
      const { bsdf, out, link: l } = principled();
      const x = node(def.id);
      const o = def.outputs[0];
      if (!o) continue; // nœuds de sortie (AOV, monde…) : rien à brancher sur un Principled
      if (o.id === 'Volume') continue; // shaders de volume : non rendus sur une surface (vérifié à part)
      const links = [l];
      let nodes = [bsdf, out, x];
      if (o.type === 'shader') {
        links.length = 0;
        links.push(link(x, o.id, out, 'Surface'));
        nodes = [out, x];
      } else {
        const target = o.type === 'vector' ? 'Normal' : o.type === 'color' ? 'Base Color' : 'Roughness';
        links.push(link(x, o.id, bsdf, target));
      }
      // Les entrées de vecteur / couleur reçoivent une texture pour forcer le chemin GLSL.
      const noise = node('ShaderNodeTexNoise');
      nodes.push(noise);
      const firstNumeric = def.inputs.find((s) => ['float', 'color', 'vector'].includes(s.type));
      if (firstNumeric) links.push(link(noise, firstNumeric.type === 'color' ? 'Color' : 'Fac', x, firstNumeric.id));
      const c = compileShaderTree(tree(nodes, links));
      expect(c.hasSurface, def.id).toBe(true);
      for (const p of Object.values(c.params)) {
        for (const k of Array.isArray(p) ? p : [p]) expect(Number.isFinite(k), `${def.id} ${JSON.stringify(c.params)}`).toBe(true);
      }
    }
  });

  it('conversions de couleur et compatibilité des sockets', () => {
    expect(linearToHex(hexToLinear('#e7e7e7'))).toBe('#e7e7e7');
    expect(hexToLinear('#e7e7e7')[0]).toBeCloseTo(0.8, 2);
    expect(socketsCompatible('float', 'color')).toBe(true);
    expect(socketsCompatible('shader', 'color')).toBe(false);
    expect(socketsCompatible('any', 'shader')).toBe(true);
  });
});
