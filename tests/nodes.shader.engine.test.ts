import { describe, expect, it } from 'vitest';
import { SceneDoc } from '../src/core/doc/SceneDoc';
import type { NodeData, NodeLink, NodeTreeData } from '../src/core/doc/schema';
import { evalCurve, prepareCurve, texNoise } from '../src/core/nodes/shader/cpu';
import { addImage, getImage, IMAGE_MAX_BYTES, ImageError, listImages, removeImage, fitImageSize } from '../src/core/nodes/shader/images';
import { bakeBaseColor, compileShaderTree, evaluateShaderAt, evaluateShaderConstants, hexToLinear } from '../src/core/nodes/shaderCompile';
import { SHADER_CATEGORIES, SHADER_NODE_TYPES } from '../src/core/nodes/shaderNodes';
import { nodeDefaults, nodeType } from '../src/core/nodes/types';

let n = 0;
function node(type: string, inputs: Record<string, unknown> = {}, props: Record<string, unknown> = {}): NodeData {
  const def = nodeType('shader', type);
  if (!def) throw new Error(`type inconnu ${type}`);
  const d = nodeDefaults(def);
  return { id: `n${n++}`, type, x: 0, y: 0, inputs: { ...d.inputs, ...inputs }, props: { ...d.props, ...props } };
}
const link = (a: NodeData, out: string, b: NodeData, input: string): NodeLink => ({ id: `l${n++}`, fromNode: a.id, fromSocket: out, toNode: b.id, toSocket: input });
const tree = (nodes: NodeData[], links: NodeLink[]): NodeTreeData => ({ id: 't', name: 't', kind: 'shader', nodes: Object.fromEntries(nodes.map((x) => [x.id, x])), links });

/** Valeur → Principled(entrée) → Sortie. */
function into(src: NodeData, out: string, input: string, extra: NodeData[] = [], extraLinks: NodeLink[] = []) {
  const bsdf = node('ShaderNodeBsdfPrincipled');
  const o = node('ShaderNodeOutputMaterial');
  return tree([bsdf, o, src, ...extra], [link(bsdf, 'BSDF', o, 'Surface'), link(src, out, bsdf, input), ...extraLinks]);
}

describe('catalogue complet des nœuds de shader', () => {
  const ids = new Set(SHADER_NODE_TYPES.map((d) => d.id));
  it('contient les nœuds de chaque menu de Blender', () => {
    const expected = [
      // Entrée
      'ShaderNodeAmbientOcclusion', 'ShaderNodeAttribute', 'ShaderNodeBevel', 'ShaderNodeCameraData', 'ShaderNodeVertexColor', 'ShaderNodeFresnel', 'ShaderNodeNewGeometry',
      'ShaderNodeLayerWeight', 'ShaderNodeLightPath', 'ShaderNodeObjectInfo', 'ShaderNodePointInfo', 'ShaderNodeRGB', 'ShaderNodeTangent', 'ShaderNodeTexCoord', 'ShaderNodeUVMap',
      'ShaderNodeValue', 'ShaderNodeVolumeInfo', 'ShaderNodeWireframe', 'ShaderNodeHairInfo', 'ShaderNodeParticleInfo',
      // Shader
      'ShaderNodeAddShader', 'ShaderNodeBsdfDiffuse', 'ShaderNodeEmission', 'ShaderNodeBsdfGlass', 'ShaderNodeBsdfGlossy', 'ShaderNodeBsdfHair', 'ShaderNodeHoldout',
      'ShaderNodeBsdfMetallic', 'ShaderNodeMixShader', 'ShaderNodeBsdfPrincipled', 'ShaderNodeBsdfHairPrincipled', 'ShaderNodeVolumePrincipled', 'ShaderNodeBsdfRayPortal',
      'ShaderNodeBsdfRefraction', 'ShaderNodeBsdfSheen', 'ShaderNodeEeveeSpecular', 'ShaderNodeSubsurfaceScattering', 'ShaderNodeBsdfToon', 'ShaderNodeBsdfTranslucent',
      'ShaderNodeBsdfTransparent', 'ShaderNodeVolumeAbsorption', 'ShaderNodeVolumeScatter',
      // Texture
      'ShaderNodeTexBrick', 'ShaderNodeTexChecker', 'ShaderNodeTexEnvironment', 'ShaderNodeTexGabor', 'ShaderNodeTexGradient', 'ShaderNodeTexIES', 'ShaderNodeTexImage',
      'ShaderNodeTexMagic', 'ShaderNodeTexNoise', 'ShaderNodeTexPointDensity', 'ShaderNodeTexSky', 'ShaderNodeTexVoronoi', 'ShaderNodeTexWave', 'ShaderNodeTexWhiteNoise',
      // Couleur
      'ShaderNodeBrightContrast', 'ShaderNodeGamma', 'ShaderNodeHueSaturation', 'ShaderNodeInvert', 'ShaderNodeLightFalloff', 'ShaderNodeMix', 'ShaderNodeRGBCurve',
      // Vecteur
      'ShaderNodeBump', 'ShaderNodeDisplacement', 'ShaderNodeMapping', 'ShaderNodeNormal', 'ShaderNodeNormalMap', 'ShaderNodeVectorCurve', 'ShaderNodeVectorDisplacement',
      'ShaderNodeVectorRotate', 'ShaderNodeVectorTransform',
      // Convertisseur
      'ShaderNodeBlackbody', 'ShaderNodeClamp', 'ShaderNodeValToRGB', 'ShaderNodeCombineColor', 'ShaderNodeSeparateColor', 'ShaderNodeCombineXYZ', 'ShaderNodeSeparateXYZ',
      'ShaderNodeFloatCurve', 'ShaderNodeMapRange', 'ShaderNodeMath', 'ShaderNodeRGBToBW', 'ShaderNodeShaderToRGB', 'ShaderNodeVectorMath', 'ShaderNodeWavelength',
      // Sortie, disposition
      'ShaderNodeOutputMaterial', 'ShaderNodeOutputAOV', 'NodeFrame', 'NodeReroute',
    ];
    for (const id of expected) expect(ids.has(id), id).toBe(true);
  });

  it('catégories connues, ordre du menu (catégories groupées), aucun doublon', () => {
    const cats = SHADER_CATEGORIES.map((c) => c.id);
    for (const d of SHADER_NODE_TYPES) expect(cats, d.id).toContain(d.category);
    expect(ids.size).toBe(SHADER_NODE_TYPES.length);
    const seq = SHADER_NODE_TYPES.map((d) => d.category).filter((c, i, a) => i === 0 || a[i - 1] !== c);
    expect(new Set(seq).size).toBe(seq.length);
  });

  it('les nœuds sans équivalent temps réel le disent (support / note)', () => {
    for (const id of ['ShaderNodeVolumePrincipled', 'ShaderNodeAmbientOcclusion', 'ShaderNodeBevel', 'ShaderNodeWireframe']) {
      const d = nodeType('shader', id)!;
      expect(d.support, id).toBe('none');
      expect(d.note).toBeTruthy();
    }
    expect(nodeType('shader', 'ShaderNodeLightPath')!.support).toBe('approx');
    expect(nodeType('shader', 'ShaderNodeTexBrick')!.support).toBeUndefined();
  });

  it('Principled BSDF : tous les sockets de Blender 5', () => {
    const d = nodeType('shader', 'ShaderNodeBsdfPrincipled')!;
    const s = d.inputs.map((x) => x.id);
    for (const id of ['Base Color', 'Metallic', 'Roughness', 'IOR', 'Alpha', 'Normal', 'Diffuse Roughness', 'Subsurface Weight', 'Subsurface Radius', 'Subsurface Scale', 'Subsurface IOR',
      'Subsurface Anisotropy', 'Specular IOR Level', 'Specular Tint', 'Anisotropic', 'Anisotropic Rotation', 'Tangent', 'Transmission Weight', 'Coat Weight', 'Coat Roughness', 'Coat IOR',
      'Coat Tint', 'Coat Normal', 'Sheen Weight', 'Sheen Roughness', 'Sheen Tint', 'Emission Color', 'Emission Strength', 'Thin Film Thickness', 'Thin Film IOR']) expect(s).toContain(id);
  });
});

describe('compilation GLSL : une fonction attendue par catégorie', () => {
  const noise = () => node('ShaderNodeTexNoise');
  const cases: [string, () => NodeTreeData, string][] = [
    ['Entrée (Fresnel)', () => { const f = node('ShaderNodeFresnel'); return into(f, 'Fac', 'Roughness'); }, 'cf_fresnel'],
    ['Entrée (Caméra)', () => { const f = node('ShaderNodeCameraData'); return into(f, 'View Distance', 'Roughness'); }, 'cf_cam'],
    ['Texture (briques)', () => { const t = node('ShaderNodeTexBrick'); return into(t, 'Color', 'Base Color'); }, 'cf_tex_brick'],
    ['Texture (Voronoï N-sphère)', () => { const t = node('ShaderNodeTexVoronoi', {}, { feature: 'N_SPHERE_RADIUS' }); return into(t, 'Radius', 'Roughness'); }, 'cf_tex_voronoi2'],
    ['Texture (bruit à crêtes)', () => { const t = node('ShaderNodeTexNoise', {}, { noise_type: 'RIDGED_MULTIFRACTAL' }); return into(t, 'Fac', 'Roughness'); }, 'cf_tex_noise2'],
    ['Texture (Gabor)', () => { const t = node('ShaderNodeTexGabor'); return into(t, 'Value', 'Roughness'); }, 'cf_tex_gabor'],
    ['Texture (ciel)', () => { const t = node('ShaderNodeTexSky'); return into(t, 'Color', 'Base Color'); }, 'cf_sky'],
    ['Texture (image)', () => { const t = node('ShaderNodeTexImage', {}, { image: 'img1', projection: 'BOX' }); return into(t, 'Color', 'Base Color'); }, 'cf_tex_image(cf_img0'],
    ['Couleur (Mélanger, incrustation)', () => { const z = noise(); const m = node('ShaderNodeMix', {}, { blend_type: 'OVERLAY' }); return into(m, 'Result_Color', 'Base Color', [z], [link(z, 'Color', m, 'A_Color')]); }, 'cf_blend(8'],
    ['Couleur (courbes RVB)', () => { const z = noise(); const m = node('ShaderNodeRGBCurve'); return into(m, 'Color', 'Base Color', [z], [link(z, 'Color', m, 'Color')]); }, 'cf_curve_lut'],
    ['Vecteur (rotation)', () => { const z = noise(); const m = node('ShaderNodeVectorRotate', { Angle: 1 }); const t = node('ShaderNodeTexChecker'); return into(t, 'Fac', 'Roughness', [z, m], [link(z, 'Color', m, 'Vector'), link(m, 'Vector', t, 'Vector')]); }, 'cf_vector_rotate'],
    ['Vecteur (carte de normales)', () => { const z = noise(); const m = node('ShaderNodeNormalMap'); return into(m, 'Normal', 'Normal', [z], [link(z, 'Color', m, 'Color')]); }, 'cf_normal_map_tangent'],
    ['Convertisseur (corps noir)', () => { const z = noise(); const m = node('ShaderNodeMapRange', { 'To Min': 1000, 'To Max': 9000 }); const b = node('ShaderNodeBlackbody'); return into(b, 'Color', 'Base Color', [z, m], [link(z, 'Fac', m, 'Value'), link(m, 'Result', b, 'Temperature')]); }, 'cf_blackbody'],
    ['Convertisseur (longueur d’onde)', () => { const z = noise(); const b = node('ShaderNodeWavelength'); return into(b, 'Color', 'Base Color', [z], [link(z, 'Fac', b, 'Wavelength')]); }, 'cf_wavelength'],
  ];
  for (const [label, make, fn] of cases) {
    it(label, () => {
      const c = compileShaderTree(make());
      expect(c.code + c.library).toContain(fn);
      expect(c.code).toContain(fn.split('(')[0]);
      expect(c.hasSurface).toBe(true);
    });
  }

  it('Déplacement de la sortie du matériau → relief', () => {
    const bsdf = node('ShaderNodeBsdfPrincipled');
    const o = node('ShaderNodeOutputMaterial');
    const z = noise();
    const d = node('ShaderNodeDisplacement');
    const c = compileShaderTree(tree([bsdf, o, z, d], [link(bsdf, 'BSDF', o, 'Surface'), link(z, 'Fac', d, 'Height'), link(d, 'Displacement', o, 'Displacement')]));
    expect(c.varying.normal).toBeTruthy();
    expect(c.code).toContain('cf_bump');
  });

  it('volume sur la surface : pas de surface, et le signale', () => {
    const v = node('ShaderNodeVolumePrincipled');
    const o = node('ShaderNodeOutputMaterial');
    const c = compileShaderTree(tree([v, o], [link(v, 'Volume', o, 'Surface')]));
    expect(c.hasSurface).toBe(false);
    expect(c.notes.join(' ')).toMatch(/[Vv]olume/);
  });
});

describe('cache par signature : une valeur changée = uniforme', () => {
  it('même clé et même code, uniformes différents', () => {
    const z = node('ShaderNodeTexNoise', { Scale: 5 });
    const t1 = into(z, 'Fac', 'Roughness');
    const c1 = compileShaderTree(t1);
    const t2 = structuredClone(t1);
    t2.nodes[z.id].inputs.Scale = 12;
    const c2 = compileShaderTree(t2);
    expect(c2.key).toBe(c1.key);
    expect(c2.code).toBe(c1.code);
    expect([...c1.uniforms]).toContain(5);
    expect([...c2.uniforms]).toContain(12);
    expect([...c2.uniforms]).not.toContain(5);
  });

  it('rampe de couleurs : déplacer un arrêt ne change pas la clé', () => {
    const z = node('ShaderNodeTexNoise');
    const r = node('ShaderNodeValToRGB');
    const t1 = into(r, 'Color', 'Base Color', [z], [link(z, 'Fac', r, 'Fac')]);
    const c1 = compileShaderTree(t1);
    const t2 = structuredClone(t1);
    (t2.nodes[r.id].props.color_ramp as { elements: { position: number }[] }).elements[1].position = 0.7;
    const c2 = compileShaderTree(t2);
    expect(c2.key).toBe(c1.key);
    expect([...c2.uniforms].some((x) => Math.abs(x - 0.7) < 1e-6)).toBe(true);
  });

  it('changer d’opération recompile (clé différente)', () => {
    const z = node('ShaderNodeTexNoise');
    const m = node('ShaderNodeMath', {}, { operation: 'ADD' });
    const t1 = into(m, 'Value', 'Roughness', [z], [link(z, 'Fac', m, 'Value')]);
    const t2 = structuredClone(t1);
    t2.nodes[m.id].props.operation = 'POWER';
    expect(compileShaderTree(t2).key).not.toBe(compileShaderTree(t1).key);
  });
});

describe('évaluation CPU', () => {
  const at = (t: NodeTreeData) => evaluateShaderAt(t, [0.3, 0.6, 0.2]);

  it('Calcul (puissance, modulo, comparer)', () => {
    const m = node('ShaderNodeMath', { Value: 0.5, Value_001: 2 }, { operation: 'POWER' });
    expect(at(into(m, 'Value', 'Roughness')).roughness).toBeCloseTo(0.25, 6);
    const m2 = node('ShaderNodeMath', { Value: -0.75, Value_001: 0.5 }, { operation: 'FLOORED_MODULO' });
    expect(at(into(m2, 'Value', 'Roughness')).roughness).toBeCloseTo(0.25, 6);
    const m3 = node('ShaderNodeMath', { Value: 0.3, Value_001: 0.31, Value_002: 0.05 }, { operation: 'COMPARE' });
    expect(at(into(m3, 'Value', 'Roughness')).roughness).toBe(1);
  });

  it('Remapper : linéaire, paliers, adouci, vecteur', () => {
    const lin = node('ShaderNodeMapRange', { Value: 5, 'From Min': 0, 'From Max': 10, 'To Min': 0, 'To Max': 1 });
    expect(at(into(lin, 'Result', 'Roughness')).roughness).toBeCloseTo(0.5, 6);
    const st = node('ShaderNodeMapRange', { Value: 0.6, Steps: 4 }, { interpolation_type: 'STEPPED' });
    expect(at(into(st, 'Result', 'Roughness')).roughness).toBeCloseTo(0.75, 6);
    const sm = node('ShaderNodeMapRange', { Value: 0.25 }, { interpolation_type: 'SMOOTHSTEP' });
    expect(at(into(sm, 'Result', 'Roughness')).roughness).toBeCloseTo(0.15625, 6);
    const vec = node('ShaderNodeMapRange', { Vector: [0.5, 0, 1] }, { data_type: 'FLOAT_VECTOR' });
    const sep = node('ShaderNodeSeparateXYZ');
    const t = into(sep, 'X', 'Roughness', [vec], [link(vec, 'Vector', sep, 'Vector')]);
    expect(at(t).roughness).toBeCloseTo(0.5, 6);
  });

  it('Rampe de couleurs : linéaire et constante', () => {
    const elements = [{ position: 0, color: '#000000', alpha: 1 }, { position: 1, color: '#ffffff', alpha: 1 }];
    const r = node('ShaderNodeValToRGB', { Fac: 0.5 }, { color_ramp: { interpolation: 'LINEAR', elements } });
    expect(at(into(r, 'Color', 'Base Color')).baseColor[0]).toBeCloseTo(0.5, 6);
    const c = node('ShaderNodeValToRGB', { Fac: 0.5 }, { color_ramp: { interpolation: 'CONSTANT', elements } });
    expect(at(into(c, 'Color', 'Base Color')).baseColor[0]).toBe(0);
  });

  it('Mélanger la couleur : modes de fusion', () => {
    const a = hexToLinear('#808080');
    const mul = node('ShaderNodeMix', { Factor_Float: 1, A_Color: '#808080', B_Color: '#808080' }, { blend_type: 'MULTIPLY' });
    expect(at(into(mul, 'Result_Color', 'Base Color')).baseColor[0]).toBeCloseTo(a[0] * a[0], 6);
    const add = node('ShaderNodeMix', { Factor_Float: 0.5, A_Color: '#000000', B_Color: '#ffffff' }, { blend_type: 'ADD' });
    expect(at(into(add, 'Result_Color', 'Base Color')).baseColor[1]).toBeCloseTo(0.5, 6);
    const diff = node('ShaderNodeMix', { Factor_Float: 1, A_Color: '#ffffff', B_Color: '#ffffff' }, { blend_type: 'DIFFERENCE' });
    expect(at(into(diff, 'Result_Color', 'Base Color')).baseColor[2]).toBeCloseTo(0, 6);
  });

  it('Texture de bruit : déterministe, dans [0, 1], moyenne proche de 0,5', () => {
    const a = texNoise([0.3, 0.6, 0.2], 0, 5, 2, 0.5, 2, 0, 1, 0, 3, true);
    const b = texNoise([0.3, 0.6, 0.2], 0, 5, 2, 0.5, 2, 0, 1, 0, 3, true);
    expect(a).toEqual(b);
    let sum = 0;
    for (let i = 0; i < 200; i++) {
      const [f] = texNoise([i * 0.037, i * 0.051, i * 0.013], 0, 5, 2, 0.5, 2, 0, 1, 0, 3, true);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
      sum += f;
    }
    expect(Math.abs(sum / 200 - 0.5)).toBeLessThan(0.08);
    // Le même bruit, branché dans un arbre et évalué au même point, donne la même valeur.
    const z = node('ShaderNodeTexNoise');
    expect(at(into(z, 'Fac', 'Roughness')).roughness).toBeCloseTo(Math.min(1, Math.max(0, a[0])), 6);
  });

  it('courbes : identité, et courbe monotone entre ses points', () => {
    const id = prepareCurve([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
    expect(evalCurve(id, 0.3)).toBeCloseTo(0.3, 6);
    const c = prepareCurve([{ x: 0, y: 0 }, { x: 0.5, y: 0.8 }, { x: 1, y: 1 }]);
    expect(evalCurve(c, 0.5)).toBeCloseTo(0.8, 6);
    expect(evalCurve(c, 0.25)).toBeGreaterThan(0);
    expect(evalCurve(c, 0.25)).toBeLessThan(0.8);
    expect(evalCurve(c, 2)).toBe(1);
  });

  it('evaluateShaderConstants : RVB rouge, Mélanger à 0,5, moyenne d’une texture', () => {
    const rgb = node('ShaderNodeRGB', {}, { color: '#ff0000' });
    expect(evaluateShaderConstants(into(rgb, 'Color', 'Base Color')).baseColor).toBe('#ff0000');
    const m = node('ShaderNodeMix', { Factor_Float: 0.5, A_Color: '#000000', B_Color: '#ffffff' });
    const lin = hexToLinear(evaluateShaderConstants(into(m, 'Result_Color', 'Base Color')).baseColor!);
    expect(lin[0]).toBeCloseTo(0.5, 2);
    const ch = node('ShaderNodeTexChecker', { Color1: '#000000', Color2: '#ffffff' });
    const avg = hexToLinear(evaluateShaderConstants(into(ch, 'Color', 'Base Color')).baseColor!);
    expect(avg[0]).toBeGreaterThan(0.25);
    expect(avg[0]).toBeLessThan(0.75);
  });

  it('cuisson de la couleur par sommet (path tracer)', () => {
    const ch = node('ShaderNodeTexChecker', { Color1: '#000000', Color2: '#ffffff', Scale: 1 });
    const t = into(ch, 'Color', 'Base Color');
    const pos = [0.1, 0.1, 0.1, 0.9, 0.1, 0.1];
    const cols = bakeBaseColor(t, pos, null, [0, 0, 0], [1, 1, 1])!;
    expect(cols.length).toBe(8);
    expect(cols[3]).toBe(1);
    const rgb = node('ShaderNodeRGB');
    expect(bakeBaseColor(into(rgb, 'Color', 'Base Color'), pos, null, [0, 0, 0], [1, 1, 1])).toBeNull();
  });
});

describe('images du document', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  it('ajout, lecture, liste, suppression', () => {
    const doc = SceneDoc.createNew();
    const id = addImage(doc, 'brique.png', png, 'image/png', { width: 4, height: 2 });
    const img = getImage(doc, id)!;
    expect(img.mime).toBe('image/png');
    expect(img.width).toBe(4);
    expect([...img.bytes]).toEqual([...png]);
    expect(listImages(doc).map((x) => x.id)).toEqual([id]);
    removeImage(doc, id);
    expect(getImage(doc, id)).toBeNull();
  });
  it('refuse les formats inconnus et les images trop lourdes (message clair)', () => {
    const doc = SceneDoc.createNew();
    expect(() => addImage(doc, 'x.gif', new Uint8Array([0x47, 0x49, 0x46]), 'image/gif')).toThrow(ImageError);
    const big = new Uint8Array(IMAGE_MAX_BYTES + 1);
    big.set(png);
    expect(() => addImage(doc, 'big.png', big, 'image/png')).toThrow(/limite/);
  });
  it('réduction à 2048 px sur le plus grand côté', () => {
    expect(fitImageSize(4096, 1024)).toEqual({ width: 2048, height: 512 });
    expect(fitImageSize(800, 600)).toEqual({ width: 800, height: 600 });
  });
  it('un nœud Texture image sans image est magenta, comme Blender', () => {
    const t = node('ShaderNodeTexImage');
    const p = evaluateShaderAt(into(t, 'Color', 'Base Color'), [0.5, 0.5, 0.5]);
    expect(p.baseColor).toEqual([1, 0, 1]);
  });
});
