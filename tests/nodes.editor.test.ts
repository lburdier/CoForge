import { describe, expect, it } from 'vitest';
import '../src/core/nodes/shaderCompile';
import { nodeType, nodeTypes, type NodeTypeDef } from '../src/core/nodes/types';
import {
  addMenuTypes,
  applyBox,
  boxHits,
  categoryRank,
  curveAdd,
  curveMove,
  curvePoints,
  curveRemove,
  englishName,
  frameView,
  orderedCategories,
  screenToTree,
  searchNodeTypes,
  supportNote,
  treeToScreen,
  zoomAt,
} from '../src/ui/nodes/editorLogic';
import { nodeLayout, nodeRects, IMAGE_H, CURVE_H } from '../src/ui/nodes/layout';
import { applyPatch, cloneTree, createNode, diffTrees, connect, type Tree } from '../src/ui/nodes/treeOps';

describe('vue : transformations écran / arbre', () => {
  it('aller-retour exact', () => {
    const v = { x: 120, y: -40, z: 1.7 };
    const p = screenToTree(v, 300, 200);
    const s = treeToScreen(v, p.x, p.y);
    expect(s.x).toBeCloseTo(300);
    expect(s.y).toBeCloseTo(200);
  });

  it('le zoom garde fixe le point sous le curseur', () => {
    const v = { x: 50, y: 30, z: 1 };
    const before = screenToTree(v, 400, 250);
    const v2 = zoomAt(v, 400, 250, -200);
    expect(v2.z).toBeGreaterThan(1);
    const after = screenToTree(v2, 400, 250);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('le zoom est borné', () => {
    expect(zoomAt({ x: 0, y: 0, z: 1 }, 0, 0, -100000).z).toBe(3);
    expect(zoomAt({ x: 0, y: 0, z: 1 }, 0, 0, 100000).z).toBe(0.15);
  });

  it('cadrage : tous les rectangles visibles et centrés', () => {
    const rects = [
      { x: 0, y: 0, w: 100, h: 50 },
      { x: 900, y: 400, w: 150, h: 200 },
    ];
    const v = frameView(rects, 800, 400)!;
    const a = treeToScreen(v, 0, 0);
    const b = treeToScreen(v, 1050, 600);
    expect(a.x).toBeGreaterThanOrEqual(0);
    expect(a.y).toBeGreaterThanOrEqual(0);
    expect(b.x).toBeLessThanOrEqual(800);
    expect(b.y).toBeLessThanOrEqual(400);
    expect((a.x + b.x) / 2).toBeCloseTo(400);
    expect(frameView([], 800, 400)).toBeNull();
  });
});

describe('sélection rectangle', () => {
  const rects = new Map([
    ['a', { x: 0, y: 0, w: 100, h: 100 }],
    ['b', { x: 200, y: 0, w: 100, h: 100 }],
    ['frame', { x: -20, y: -20, w: 340, h: 140 }],
  ]);
  const isFrame = (id: string) => id === 'frame';

  it('touche les nœuds chevauchés, coins dans n’importe quel ordre', () => {
    expect(boxHits(rects, isFrame, 150, 50, 50, -10).sort()).toEqual(['a']);
    expect(boxHits(rects, isFrame, 250, 50, 50, 60).sort()).toEqual(['a', 'b']);
  });

  it('un cadre n’est pris que s’il est entièrement couvert', () => {
    expect(boxHits(rects, isFrame, -10, -10, 310, 110)).not.toContain('frame');
    expect(boxHits(rects, isFrame, -30, -30, 330, 130)).toContain('frame');
  });

  it('modes remplacer / ajouter / retirer', () => {
    expect([...applyBox(new Set(['b']), 'b', ['a'], 'set').sel]).toEqual(['a']);
    const add = applyBox(new Set(['b']), 'b', ['a'], 'add');
    expect([...add.sel].sort()).toEqual(['a', 'b']);
    expect(add.active).toBe('a');
    const sub = applyBox(new Set(['a', 'b']), 'b', ['b'], 'sub');
    expect([...sub.sel]).toEqual(['a']);
    expect(sub.active).toBeNull();
  });
});

describe('menu Ajouter', () => {
  const defs = nodeTypes('shader');

  it('catégories dans l’ordre de Blender', () => {
    const cats = orderedCategories(defs);
    const idx = (c: string) => cats.indexOf(c);
    for (const c of ['Entrée', 'Sortie', 'Shader', 'Texture', 'Couleur', 'Vecteur', 'Convertisseur', 'Disposition']) expect(idx(c)).toBeGreaterThanOrEqual(0);
    expect(idx('Entrée')).toBeLessThan(idx('Sortie'));
    expect(idx('Sortie')).toBeLessThan(idx('Shader'));
    expect(idx('Shader')).toBeLessThan(idx('Couleur'));
    expect(idx('Couleur')).toBeLessThan(idx('Texture'));
    expect(idx('Texture')).toBeLessThan(idx('Vecteur'));
    expect(idx('Vecteur')).toBeLessThan(idx('Convertisseur'));
    expect(cats[cats.length - 1]).toBe('Disposition');
    // Les libellés anglais sont reconnus aussi.
    expect(categoryRank('Input')).toBe(categoryRank('Entrée'));
  });

  it('recherche par nom français, sans accents', () => {
    const r = searchNodeTypes(defs, 'melanger les shaders');
    expect(r[0]?.id).toBe('ShaderNodeMixShader');
  });

  it('recherche par nom anglais de Blender et par identifiant', () => {
    expect(searchNodeTypes(defs, 'color ramp')[0]?.id).toBe('ShaderNodeValToRGB');
    expect(searchNodeTypes(defs, 'Noise Texture')[0]?.id).toBe('ShaderNodeTexNoise');
    expect(searchNodeTypes(defs, 'principled')[0]?.id).toBe('ShaderNodeBsdfPrincipled');
    expect(searchNodeTypes(defs, 'ShaderNodeMath').map((d) => d.id)).toContain('ShaderNodeMath');
    expect(searchNodeTypes(defs, '')).toEqual([]);
    expect(searchNodeTypes(defs, 'zzzz introuvable')).toEqual([]);
  });

  it('nom anglais déduit de l’identifiant', () => {
    expect(englishName({ id: 'ShaderNodeTexFoo' })).toBe('Foo Texture');
    expect(englishName({ id: 'ShaderNodeBsdfBar' })).toBe('Bar BSDF');
    expect(englishName({ id: 'ShaderNodeSeparateXYZ' })).toBe('Separate XYZ');
  });

  it('lien en attente : seuls les types branchables, jamais la sortie', () => {
    const fromShader = addMenuTypes(defs, { fromOutput: true, type: 'shader' });
    expect(fromShader.some((d) => d.id === 'ShaderNodeMixShader')).toBe(true);
    expect(fromShader.some((d) => d.id === 'ShaderNodeTexNoise')).toBe(false);
    expect(fromShader.some((d) => d.id.startsWith('ShaderNodeOutput'))).toBe(false);
    const toColor = addMenuTypes(defs, { fromOutput: false, type: 'color' });
    expect(toColor.some((d) => d.id === 'ShaderNodeTexNoise')).toBe(true);
    expect(toColor.some((d) => d.id === 'ShaderNodeBsdfPrincipled')).toBe(false);
  });
});

describe('indication de support du catalogue', () => {
  const base: NodeTypeDef = { id: 'X', label: 'X', category: 'Texture', inputs: [], outputs: [] };
  it('rien pour un nœud complet', () => {
    expect(supportNote(base)).toBeNull();
    expect(supportNote({ ...base, support: 'full' })).toBeNull();
    expect(supportNote(null)).toBeNull();
  });
  it('approché / non rendu, avec la note du catalogue', () => {
    expect(supportNote({ ...base, support: 'approx', note: 'Sans UV.' })).toEqual({ level: 'approx', text: 'Sans UV.' });
    expect(supportNote({ ...base, support: 'none' })?.level).toBe('none');
  });
  it('les nœuds du catalogue marqués « approx » sont signalés', () => {
    const img = nodeType('shader', 'ShaderNodeTexImage');
    if (img?.support === 'approx') expect(supportNote(img)?.level).toBe('approx');
  });
});

describe('mise en page des widgets', () => {
  it('texture image et courbes ont la place de leur widget', () => {
    const img = nodeType('shader', 'ShaderNodeTexImage');
    if (img) {
      const n = createNode('shader', img.id, 0, 0);
      expect(nodeLayout('shader', n, new Set()).rows.some((r) => r.kind === 'prop' && r.prop?.kind === 'image' && r.h === IMAGE_H)).toBe(true);
    }
    const curves = nodeTypes('shader').find((d) => d.props?.some((p) => p.kind === 'curve'));
    if (curves) {
      const n = createNode('shader', curves.id, 0, 0);
      expect(nodeLayout('shader', n, new Set()).rows.some((r) => r.kind === 'prop' && r.h === CURVE_H)).toBe(true);
    }
  });
});

describe('courbes', () => {
  it('points lus du document : triés, repli identité', () => {
    expect(curvePoints([{ x: 1, y: 1 }, { x: 0, y: 0.2 }])).toEqual([{ x: 0, y: 0.2 }, { x: 1, y: 1 }]);
    expect(curvePoints('n’importe quoi')).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
    expect(curvePoints([{ x: 0.5, y: 0.5 }], -1, 1)).toEqual([{ x: -1, y: -1 }, { x: 1, y: 1 }]);
  });
  it('ajout trié, déplacement borné par les voisins, retrait limité à deux points', () => {
    const base = curvePoints(null);
    const { pts, index } = curveAdd(base, 0.5, 2);
    expect(index).toBe(1);
    expect(pts[1]).toEqual({ x: 0.5, y: 1 });
    const moved = curveMove(pts, 1, 5, -3);
    expect(moved[1].x).toBeLessThan(1);
    expect(moved[1].y).toBe(0);
    expect(curveRemove(moved, 1)).toHaveLength(2);
    expect(curveRemove(base, 0)).toHaveLength(2);
  });
});

describe('collaboration : un geste rejoué sur un arbre modifié entre-temps', () => {
  it('les modifications distantes sont conservées', () => {
    const a = createNode('shader', 'ShaderNodeRGB', 0, 0);
    const b = createNode('shader', 'ShaderNodeBsdfDiffuse', 300, 0);
    const start: Tree = { nodes: { [a.id]: a, [b.id]: b }, links: [] };
    // Geste local : ajout d'un nœud Valeur.
    const local = cloneTree(start);
    const v = createNode('shader', 'ShaderNodeValue', 100, 100);
    local.nodes[v.id] = v;
    const patch = diffTrees(start, local);
    // Pendant ce temps, un autre utilisateur déplace A et relie A → B.
    const remote = cloneTree(start);
    remote.nodes[a.id].x = 999;
    expect(connect('shader', remote, a.id, 'Color', b.id, 'Color')).toBe(true);
    applyPatch(remote, patch);
    expect(remote.nodes[v.id]).toBeTruthy();
    expect(remote.nodes[a.id].x).toBe(999);
    expect(remote.links).toHaveLength(1);
  });

  it('un lien du geste dont un bout a été supprimé à distance est ignoré', () => {
    const a = createNode('shader', 'ShaderNodeRGB', 0, 0);
    const b = createNode('shader', 'ShaderNodeBsdfDiffuse', 300, 0);
    const start: Tree = { nodes: { [a.id]: a, [b.id]: b }, links: [] };
    const local = cloneTree(start);
    connect('shader', local, a.id, 'Color', b.id, 'Color');
    const patch = diffTrees(start, local);
    const remote = cloneTree(start);
    delete remote.nodes[b.id];
    applyPatch(remote, patch);
    expect(remote.links).toHaveLength(0);
  });

  it('cloneTree nettoie un arbre mal formé venu d’un autre client', () => {
    const t = cloneTree({ nodes: { x: { id: 'x', type: 'ShaderNodeRGB', x: NaN, y: 0, inputs: {}, props: {} } }, links: [{ id: 'l', fromNode: 'x', fromSocket: 'Color', toNode: 'absent', toSocket: 'Color' }] });
    expect(t.links).toHaveLength(0);
    expect(Number.isFinite(t.nodes.x.x)).toBe(true);
    expect(nodeRects('shader', t).size).toBe(1);
  });
});
