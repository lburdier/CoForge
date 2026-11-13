import { describe, expect, it } from 'vitest';
import {
  area,
  areaAt,
  canJoin,
  defaultAreaTree,
  findNode,
  joinAreas,
  layoutAreas,
  leaves,
  sanitizeAreaTree,
  setAreaEditor,
  setRatio,
  split,
  splitArea,
  swapAreas,
  type AreaNode,
  type AreaSplit,
} from '../src/ui/lib/areaTree';
import { parseTabsState, setTabLayout, defaultTabsState } from '../src/ui/lib/workspaces';
import { editorForShortcut } from '../src/ui/layout/editorTypes';

const editors = (t: AreaNode) => leaves(t).map((l) => l.editor);

/** Viewport | (outliner / propriétés). */
function sample(): AreaSplit {
  return split('row', 0.75, area('view3d', 'v'), split('col', 0.3, area('outliner', 'o'), area('properties', 'p'), 'right'), 'root');
}

describe('arbre des zones', () => {
  it('disposition d’origine des modèles : viewport, éditeur du bas, frise, outliner, propriétés', () => {
    expect(editors(defaultAreaTree('layout', { rightW: 320, outlinerH: 240 }))).toEqual(['view3d', 'timeline', 'outliner', 'properties']);
    expect(editors(defaultAreaTree('shading', { rightW: 360, outlinerH: 180 }))).toEqual(['view3d', 'shader_nodes', 'timeline', 'outliner', 'properties']);
    // Identifiants stables d'une lecture à l'autre (l'interface vise une zone par son identifiant).
    expect(defaultAreaTree('shading', { rightW: 360, outlinerH: 180 })).toEqual(defaultAreaTree('shading', { rightW: 360, outlinerH: 180 }));
    expect(editors(defaultAreaTree('animation', { rightW: 320, outlinerH: 200, bottomH: 260 }))).toEqual(['view3d', 'dopesheet', 'timeline', 'outliner', 'properties']);
  });

  it('division : la zone garde sa part, la nouvelle copie son éditeur (sauf le viewport, unique)', () => {
    const { tree, newId } = splitArea(sample(), 'o', 'row', 0.4);
    expect(newId).toBeTruthy();
    const s = findNode(tree, 'right') as AreaSplit;
    const top = s.a as AreaSplit;
    expect(top.kind).toBe('split');
    expect(top.dir).toBe('row');
    expect(top.ratio).toBeCloseTo(0.4);
    expect(top.a).toMatchObject({ id: 'o', editor: 'outliner' });
    expect(top.b).toMatchObject({ id: newId, editor: 'outliner' });
    // Le viewport ne se duplique pas.
    const v = splitArea(sample(), 'v', 'col', 0.5);
    expect(editors(v.tree).filter((e) => e === 'view3d')).toHaveLength(1);
    // Identifiants uniques.
    const ids = [tree, ...leaves(tree)].map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Cible inconnue ou division : rien.
    expect(splitArea(sample(), 'right', 'row').newId).toBeNull();
  });

  it('fusion : seulement si la zone absorbée est simple ; l’autre côté prend toute la place', () => {
    const t = sample();
    // Bord viewport | colonne : on peut absorber le viewport (côté a), pas la colonne (b, divisée).
    expect(canJoin(t, 'root', 'b')).toBe(false);
    expect(joinAreas(t, 'root', 'b')).toBe(t);
    expect(canJoin(t, 'root', 'a')).toBe(true);
    // Bord outliner / propriétés : « vers le bas » supprime les propriétés.
    const j = joinAreas(t, 'right', 'b');
    expect(editors(j)).toEqual(['view3d', 'outliner']);
    expect(findNode(j, 'right')).toBeNull();
    expect(editors(joinAreas(t, 'right', 'a'))).toEqual(['view3d', 'properties']);
  });

  it('échange : les deux côtés et leurs tailles', () => {
    const t = swapAreas(sample(), 'root') as AreaSplit;
    expect(t.a.kind).toBe('split');
    expect(t.b).toMatchObject({ id: 'v' });
    expect(t.ratio).toBeCloseTo(0.25);
    expect(editors(swapAreas(sample(), 'right'))).toEqual(['view3d', 'properties', 'outliner']);
  });

  it('changer d’éditeur ; le viewport 3D (unique) est échangé avec la zone visée', () => {
    expect(editors(setAreaEditor(sample(), 'p', 'timeline'))).toEqual(['view3d', 'outliner', 'timeline']);
    expect(editors(setAreaEditor(sample(), 'p', 'view3d'))).toEqual(['properties', 'outliner', 'view3d']);
    const t = sample();
    expect(setAreaEditor(t, 'p', 'properties')).toBe(t);
  });

  it('parts bornées et rectangles sans chevauchement', () => {
    const t = setRatio(sample(), 'root', 5) as AreaSplit;
    expect(t.ratio).toBeLessThan(1);
    const { areas, edges } = layoutAreas(sample(), { x: 0, y: 0, w: 1000, h: 600 }, 4, 28);
    expect(areas).toHaveLength(3);
    expect(edges).toHaveLength(2);
    const v = areas.find((a) => a.id === 'v')!;
    expect(v).toMatchObject({ x: 0, y: 0, h: 600 });
    expect(v.w).toBe(Math.round(996 * 0.75));
    const total = areas.reduce((s, a) => s + a.w * a.h, 0) + edges.reduce((s, e) => s + e.w * e.h, 0);
    expect(total).toBe(1000 * 600);
    expect(areaAt(areas, 10, 10)?.id).toBe('v');
    expect(areaAt(areas, 990, 590)?.id).toBe('p');
    // Taille minimale respectée quand la place le permet.
    const small = layoutAreas(setRatio(sample(), 'root', 0.03), { x: 0, y: 0, w: 400, h: 600 }, 4, 28);
    expect(small.areas.find((a) => a.id === 'v')!.w).toBe(28);
  });

  it('relecture : arbre abîmé refusé, valeurs corrigées, un seul viewport', () => {
    expect(sanitizeAreaTree(null)).toBeNull();
    expect(sanitizeAreaTree({ kind: 'split', id: 's', dir: 'diag', a: {}, b: {} })).toBeNull();
    expect(sanitizeAreaTree({ kind: 'split', id: 's', dir: 'row', ratio: 0.5, a: { kind: 'area', id: 'x', editor: 'view3d' }, b: { kind: 'area', id: 'x', editor: 'view3d' } })).toBeNull();
    const t = sanitizeAreaTree({
      kind: 'split',
      id: 's',
      dir: 'col',
      ratio: 1e9,
      a: { kind: 'area', id: 'a', editor: 'view3d' },
      b: { kind: 'area', id: 'b', editor: 'view3d' },
    }) as AreaSplit;
    expect(t.ratio).toBeLessThan(1);
    expect(editors(t)).toEqual(['view3d', 'outliner']);
    expect(editors(sanitizeAreaTree({ kind: 'area', id: 'z', editor: 'inconnu' })!)).toEqual(['outliner']);
  });

  it('mémorisé par onglet et relu depuis le stockage', () => {
    const tree = splitArea(sample(), 'p', 'col').tree;
    let st = defaultTabsState();
    st = setTabLayout(st, 'shading', { rightW: 300, outlinerH: 100, areas: tree });
    const back = parseTabsState(JSON.parse(JSON.stringify(st)))!;
    expect(back.tabs.find((t) => t.id === 'shading')!.layout.areas).toEqual(tree);
    // Sans arbre : la disposition reste celle d'avant (compatibilité).
    expect(back.tabs.find((t) => t.id === 'layout')!.layout.areas).toBeUndefined();
  });

  it('raccourcis Maj+F… : Maj+F12 alterne feuille d’exposition et frise', () => {
    expect(editorForShortcut('F5', 'outliner')).toBe('view3d');
    expect(editorForShortcut('F3', 'outliner')).toBe('shader_nodes');
    expect(editorForShortcut('F12', 'outliner')).toBe('dopesheet');
    expect(editorForShortcut('F12', 'dopesheet')).toBe('timeline');
    expect(editorForShortcut('F1', 'outliner')).toBe('files');
    expect(editorForShortcut('F11', 'outliner')).toBe('text');
    expect(editorForShortcut('F2', 'outliner')).toBeNull();
  });
});
