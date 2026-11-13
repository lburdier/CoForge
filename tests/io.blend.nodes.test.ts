import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SceneDoc } from '../src/core/doc/SceneDoc';
import { compileShaderTree, hexToLinear } from '../src/core/nodes/shaderCompile';
import { readScene } from '../src/engine/io/importFile';
import { applyImportedScene, type ImportedMaterial } from '../src/engine/io/scene';

/**
 * Import des arbres de nœuds de shader depuis des .blend écrits par Blender 3.6, 4.3 et 5.1
 * (scripts/blend-fixtures/make_nodes.py), comparés à la vérité exportée par bpy : positions,
 * cadres, nœuds réduits et muets, valeurs des entrées, liens, et TOUTES les valeurs des
 * énumérations (opérations de calcul, modes de fusion, types de dégradé…).
 */

const DIR = join(__dirname, 'fixtures', 'blend-nodes');
const buf = (name: string) => {
  const b = readFileSync(join(DIR, name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

interface TruthNode {
  idname: string;
  label: string;
  location: [number, number];
  location_absolute: [number, number];
  hide: boolean;
  mute: boolean;
  parent: string | null;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  ramp?: { interpolation: string; elements: { position: number; color: number[] }[] };
}

/** Types qui changent de nom dans CoForge (anciens nœuds). */
const ALIAS: Record<string, string> = { ShaderNodeMixRGB: 'ShaderNodeMix', ShaderNodeBsdfAnisotropic: 'ShaderNodeBsdfGlossy' };
/** Valeurs d'énumération sans équivalent : remplacées. */
const REPLACED: Record<string, string> = {}; // N-sphère : prise en charge depuis la vague 3
/** Énumérations non relues (sans effet sur le rendu de CoForge). */
const IGNORED_PROPS = new Set(['distribution']);

for (const tag of ['n36', 'n43', 'n51']) {
  describe(`arbres de nœuds importés de Blender ${tag.slice(1, 2)}.${tag.slice(2)}`, async () => {
    const truth = JSON.parse(readFileSync(join(DIR, `${tag}.json`), 'utf8')) as { version: number[]; nodes: Record<string, TruthNode>; links: string[][]; enums: Record<string, string[]> };
    const scene = await readScene(`${tag}.blend`, buf(`${tag}.blend`));
    const mat = scene.materials.find((m) => m.name === 'Noeuds') as ImportedMaterial;
    const tree = mat?.shaderTree;
    const nodes = tree ? Object.values(tree.nodes) : [];

    /** Position absolue de vérité (avant 4.4, `location` est relative au cadre parent). */
    const absOf = (name: string): [number, number] => {
      const n = truth.nodes[name];
      const relative = truth.version[0] < 4 || (truth.version[0] === 4 && truth.version[1] < 4);
      if (!relative) return n.location_absolute;
      const p = n.parent ? absOf(n.parent) : [0, 0];
      return [n.location[0] + p[0], n.location[1] + p[1]];
    };
    const find = (name: string) => {
      const t = truth.nodes[name];
      const [x, y] = absOf(name);
      return nodes.find((n) => n.type === (ALIAS[t.idname] ?? t.idname) && Math.abs(n.x - x) < 1 && Math.abs(n.y + y) < 1 && (n.label ?? '') === t.label);
    };

    it('le matériau porte un arbre de nœuds complet', () => {
      expect(tree).toBeTruthy();
      expect(nodes.length).toBe(Object.keys(truth.nodes).length);
    });

    it('positions, cadres, nœuds réduits et muets', () => {
      for (const [name, t] of Object.entries(truth.nodes)) {
        const n = find(name);
        expect(n, `${name} (${t.idname}) introuvable`).toBeTruthy();
        expect(!!n!.collapsed, `${name} réduit`).toBe(t.hide);
        expect(!!n!.muted, `${name} muet`).toBe(t.mute);
        if (t.parent) expect(n!.parent, `${name} parent`).toBe(find(t.parent)!.id);
      }
    });

    it('toutes les valeurs des énumérations', () => {
      let checked = 0;
      for (const t of Object.values(truth.nodes)) {
        const m = /^enum:([a-z_]+):(.+)$/.exec(t.label);
        if (!m || IGNORED_PROPS.has(m[1])) continue;
        const name = Object.keys(truth.nodes).find((k) => truth.nodes[k] === t)!;
        const n = find(name)!;
        const expected = REPLACED[`${m[1]}:${m[2]}`] ?? m[2];
        expect(n.props[m[1]], `${t.idname}.${m[1]} = ${m[2]}`).toBe(expected);
        checked++;
      }
      expect(checked).toBeGreaterThan(130);
    });

    it('valeurs des entrées du Principled (noms de Blender 3.x convertis)', () => {
      const p = nodes.find((n) => n.type === 'ShaderNodeBsdfPrincipled')!;
      expect(p.label).toBe('Surface principale');
      expect(p.inputs.Metallic).toBeCloseTo(0.25, 5);
      expect(p.inputs.IOR).toBeCloseTo(1.6, 5);
      expect(p.inputs.Alpha).toBeCloseTo(0.9, 5);
      expect(p.inputs['Coat Weight']).toBeCloseTo(0.4, 5);
      expect(p.inputs['Coat Roughness']).toBeCloseTo(0.12, 5);
      expect(p.inputs['Sheen Weight']).toBeCloseTo(0.2, 5);
      expect(p.inputs['Specular IOR Level']).toBeCloseTo(0.7, 5);
      expect(p.inputs['Transmission Weight']).toBeCloseTo(0.1, 5);
      expect(p.inputs['Emission Strength']).toBeCloseTo(2.5, 5);
      const em = hexToLinear(p.inputs['Emission Color']);
      expect(em[0]).toBeCloseTo(0, 2);
      expect(em[1]).toBeCloseTo(0.5, 2);
      expect(em[2]).toBeCloseTo(1, 2);
    });

    it('rampe de couleurs, mappage, calcul, RVB et valeur', () => {
      const rampTruth = Object.values(truth.nodes).find((n) => n.idname === 'ShaderNodeValToRGB' && n.ramp)!;
      const ramp = nodes.find((n) => n.type === 'ShaderNodeValToRGB')!.props.color_ramp as { interpolation: string; elements: { position: number; color: string }[] };
      expect(ramp.interpolation).toBe(rampTruth.ramp!.interpolation);
      expect(ramp.elements.map((e) => +e.position.toFixed(4)).sort()).toEqual(rampTruth.ramp!.elements.map((e) => +e.position.toFixed(4)).sort());
      const mapping = nodes.find((n) => n.type === 'ShaderNodeMapping' && !n.label)!;
      expect(mapping.props.vector_type).toBe('TEXTURE');
      expect(mapping.inputs.Location).toEqual([expect.closeTo(0.1, 5), expect.closeTo(0.2, 5), expect.closeTo(0.3, 5)]);
      expect((mapping.inputs.Scale as number[])[0]).toBeCloseTo(2, 5);
      const math = nodes.find((n) => n.type === 'ShaderNodeMath' && !n.label)!;
      expect(math.props.operation).toBe('MULTIPLY');
      expect(math.props.use_clamp).toBe(true);
      expect(nodes.find((n) => n.type === 'ShaderNodeBump' && !n.label)!.props.invert).toBe(true);
      expect(hexToLinear(nodes.find((n) => n.type === 'ShaderNodeRGB')!.props.color)[0]).toBeCloseTo(0.8, 2);
      expect(nodes.find((n) => n.type === 'ShaderNodeValue')!.props.value).toBeCloseTo(0.42, 5);
    });

    it('liens identiques à ceux de Blender', () => {
      const typeOf = (name: string) => ALIAS[truth.nodes[name].idname] ?? truth.nodes[name].idname;
      const expected = truth.links.map(([a, as, b, bs]) => `${typeOf(a)}.${as}→${typeOf(b)}.${bs}`).sort();
      const got = tree!.links.map((l) => `${tree!.nodes[l.fromNode].type}.${l.fromSocket}→${tree!.nodes[l.toNode].type}.${l.toSocket}`).sort();
      expect(got).toEqual(expected);
    });

    it('dans le document : matériau à nœuds, arbre compilable avec textures procédurales', () => {
      const doc = SceneDoc.createEmpty();
      applyImportedScene(doc, scene);
      const m = doc.listMaterials().find((x) => x.name === 'Noeuds')!;
      expect(m.useNodes).toBe(true);
      const t = doc.getNodeTree(m.nodeTree!)!;
      expect(Object.keys(t.nodes).length).toBe(nodes.length);
      const c = compileShaderTree(t);
      expect(c.hasSurface).toBe(true);
      expect(c.varying.baseColor).toBeTruthy();
      expect(c.varying.roughness).toBeTruthy();
      expect(c.params.coat).toBeCloseTo(0.4, 5);
    });
  });
}
