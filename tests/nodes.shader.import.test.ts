import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileShaderTree } from '../src/core/nodes/shaderCompile';
import { readScene } from '../src/engine/io/importFile';
import type { ImportedMaterial } from '../src/engine/io/scene';

/**
 * Import des énumérations et réglages des nœuds ajoutés en vague 3, sur des .blend écrits par
 * Blender 4.3, 5.0 et 5.1 (tests/fixtures/blend-nodes/make_enums_v3.py) : chaque nœud est nommé
 * « idname|propriété|valeur » dans le fichier ; on retrouve le nœud importé par sa position.
 */

const DIR = join(__dirname, 'fixtures', 'blend-nodes');
const buf = (name: string) => {
  const b = readFileSync(join(DIR, name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const ALIAS: Record<string, string> = { ShaderNodeBsdfAnisotropic: 'ShaderNodeBsdfGlossy' };
/** Valeurs renommées dans CoForge (Blender 4.x). */
const RENAMED: Record<string, string> = { 'sky_type:NISHITA': 'MULTIPLE_SCATTERING' };

for (const tag of ['e43', 'e50', 'e51']) {
  describe(`nœuds de la vague 3 importés de Blender ${tag.slice(1, 2)}.${tag.slice(2)}`, async () => {
    const truth = JSON.parse(readFileSync(join(DIR, `${tag}.json`), 'utf8')) as { version: number[]; nodes: Record<string, Record<string, unknown>> };
    const scene = await readScene(`${tag}.blend`, buf(`${tag}.blend`));
    const mat = scene.materials.find((m) => m.name === 'Enums') as ImportedMaterial;
    const tree = mat?.shaderTree;
    const nodes = tree ? Object.values(tree.nodes) : [];

    it('tous les nœuds sont repris (aucun type inconnu)', () => {
      expect(tree).toBeTruthy();
      // + Principled et Sortie du matériau, absents de la vérité.
      expect(nodes.length).toBe(Object.keys(truth.nodes).length + 2);
    });

    it('chaque valeur d’énumération', () => {
      // Les nœuds d'énumération sont posés en colonne x = 0, y = 0, -300, -600… dans l'ordre du JSON.
      const enumNames = Object.keys(truth.nodes).filter((k) => k.includes('|'));
      let checked = 0;
      enumNames.forEach((name, i) => {
        const t = truth.nodes[name];
        const n = nodes.find((x) => x.x === 0 && x.y === i * 300);
        expect(n, name).toBeTruthy();
        expect(n!.type, name).toBe(ALIAS[t.idname as string] ?? t.idname);
        if (!t.prop) return;
        const expected = RENAMED[`${t.prop}:${t.value}`] ?? t.value;
        expect(n!.props[t.prop as string], name).toBe(expected);
        checked++;
      });
      expect(checked).toBeGreaterThan(70);
    });

    it('réglages numériques, courbes, Voronoï normalisé', () => {
      const at = (y: number) => nodes.find((x) => x.x === 600 && x.y === y)!;
      const brick = at(0);
      expect(brick.props.offset).toBeCloseTo(0.3, 5);
      expect(brick.props.offset_frequency).toBe(3);
      expect(brick.props.squash).toBeCloseTo(1.7, 5);
      expect(brick.props.squash_frequency).toBe(4);
      const sky = at(300);
      expect(sky.props.sun_elevation).toBeCloseTo((0.5 * 180) / Math.PI, 3);
      expect(sky.props.sun_intensity).toBeCloseTo(2, 5);
      expect(sky.props.sun_disc).toBe(false);
      expect(at(600).props.normalize).toBe(true);
      const curves = at(900).props.mapping as { curves: { points: { x: number; y: number }[] }[] };
      const tc = truth.nodes.curves.curves as number[][][];
      expect(curves.curves.length).toBe(4);
      curves.curves.forEach((c, i) => {
        expect(c.points.map((p) => [+p.x.toFixed(4), +p.y.toFixed(4)])).toEqual(tc[i].map((p) => [+p[0].toFixed(4), +p[1].toFixed(4)]));
      });
      const fc = at(1200).props.mapping as { curves: { points: { x: number; y: number }[] }[] };
      expect(fc.curves[0].points[0].y).toBeCloseTo(0.25, 5);
    });

    it('l’arbre importé se compile (briques → Principled)', () => {
      const c = compileShaderTree({ id: 't', name: 't', kind: 'shader', ...tree! });
      expect(c.hasSurface).toBe(true);
      expect(c.code).toContain('cf_tex_brick');
    });
  });
}
