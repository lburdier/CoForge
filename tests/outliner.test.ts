import { describe, expect, it, beforeEach } from 'vitest';
import { Matrix4, PerspectiveCamera } from 'three';
import { SceneDoc } from '../src/core/doc/SceneDoc';
import { initialState, isTypeSelectable, objectTypeCategory, setObjectTypeSelectable, store } from '../src/app/store';
import { Picker, type PickEnv } from '../src/engine/picking';
import { isViewportSelectable, selectableInViewport, selectOperators } from '../src/tools/select';
import {
  buildTree,
  colKey,
  DEFAULT_FILTERS,
  filtersActive,
  flattenTree,
  keysToReveal,
  normalizeFilters,
  objKey,
  ROOT_KEY,
  rowIndexOf,
  scrollToReveal,
  type OutlinerFilters,
} from '../src/ui/outliner/tree';

/** Scène de test : collection « Props » avec un parent et son enfant, plus une lumière, une caméra et un vide à la racine. */
function scene() {
  const doc = new SceneDoc();
  const col = doc.addCollection({ name: 'Props' });
  const table = doc.addObject({ type: 'mesh', name: 'Table', collection: col });
  const cup = doc.addObject({ type: 'mesh', name: 'Tasse', collection: col, parent: table });
  const lamp = doc.addObject({ type: 'light', name: 'Lampe', data: doc.addLight({}) });
  const cam = doc.addObject({ type: 'camera', name: 'Caméra', data: doc.addCamera({}) });
  const empty = doc.addObject({ type: 'empty', name: 'Repère', visible: false });
  return { doc, col, table, cup, lamp, cam, empty };
}

const names = (rows: ReturnType<typeof flattenTree>) => rows.map((r) => r.node.name);
const f = (patch: Partial<OutlinerFilters>): OutlinerFilters => ({ ...DEFAULT_FILTERS, ...patch, types: { ...DEFAULT_FILTERS.types, ...(patch.types ?? {}) } });

beforeEach(() => {
  store.setState(initialState());
  setObjectTypeSelectable({ mesh: true, camera: true, light: true, empty: true, other: true });
});

describe('outliner : arbre et filtres', () => {
  it('range les enfants sous leur parent, contenu en tête', () => {
    const s = scene();
    s.doc.updateObject(s.table, { modifiers: [{ id: 'm1', type: 'bevel', name: 'Biseau', enabled: true, params: {} } as any] });
    const tree = buildTree(s.doc);
    const table = tree.nodes.get(objKey(s.table))!;
    expect(table.children.map((k) => tree.nodes.get(k)!.kind)).toEqual(['content', 'object']);
    expect(tree.nodes.get(objKey(s.cup))!.parentKey).toBe(objKey(s.table));
    expect(tree.typeCounts).toEqual({ mesh: 2, camera: 1, light: 1, empty: 1, other: 0 });
  });

  it('filtre par type (les enfants d’un objet masqué remontent)', () => {
    const s = scene();
    const tree = buildTree(s.doc);
    const all = names(flattenTree(tree, new Set(), '', f({ contents: false })));
    expect(all).toEqual(['Collection de scène', 'Props', 'Table', 'Tasse', 'Caméra', 'Lampe', 'Repère']);
    const noLights = names(flattenTree(tree, new Set(), '', f({ contents: false, types: { light: false } as any })));
    expect(noLights).not.toContain('Lampe');
    // Le parent est un maillage masqué, l'enfant (vide) passe : il remonte dans la collection.
    const child = s.doc.addObject({ type: 'empty', name: 'Poignée', collection: s.col, parent: s.cup });
    const t2 = buildTree(s.doc);
    const rows = flattenTree(t2, new Set(), '', f({ contents: false, types: { mesh: false } as any }));
    const r = rows.find((x) => x.node.id === child)!;
    expect(r.depth).toBe(2);
    expect(names(rows)).not.toContain('Tasse');
  });

  it('filtre visibles / sélectionnés / actif', () => {
    const s = scene();
    const tree = buildTree(s.doc);
    expect(names(flattenTree(tree, new Set(), '', f({ contents: false, objects: 'visible' })))).not.toContain('Repère');
    const ctx = { selection: new Set([s.cup, s.lamp]), activeId: s.lamp };
    const sel = names(flattenTree(tree, new Set(), '', f({ contents: false, objects: 'selected' }), ctx));
    expect(sel).toEqual(['Collection de scène', 'Props', 'Tasse', 'Lampe']);
    const act = names(flattenTree(tree, new Set(), '', f({ contents: false, objects: 'active' }), ctx));
    expect(act).toEqual(['Collection de scène', 'Props', 'Lampe']);
  });

  it('enfants à plat, sans collections, contenu, et recherche combinée aux filtres', () => {
    const s = scene();
    s.doc.updateObject(s.table, { modifiers: [{ id: 'm1', type: 'bevel', name: 'Biseau', enabled: true, params: {} } as any] });
    const tree = buildTree(s.doc);
    const flat = flattenTree(tree, new Set(), '', f({ contents: false, children: false }));
    expect(flat.find((r) => r.node.id === s.cup)!.depth).toBe(2);
    const noCols = names(flattenTree(tree, new Set(), '', f({ contents: false, collections: false })));
    expect(noCols).not.toContain('Props');
    expect(noCols).toContain('Tasse');
    const withContent = names(flattenTree(tree, new Set(), '', f({})));
    expect(withContent).toContain('Modificateurs');
    expect(withContent).toContain('Biseau');
    // Recherche « ta » + filtre « pas de maillages » : ni Table ni Tasse.
    const q = names(flattenTree(tree, new Set(), 'ta', f({ types: { mesh: false } as any })));
    expect(q).not.toContain('Table');
    expect(q).not.toContain('Tasse');
    expect(names(flattenTree(tree, new Set(), 'tasse', f({})))).toEqual(['Collection de scène', 'Props', 'Table', 'Tasse']);
  });

  it('indicateur et relecture des filtres mémorisés', () => {
    expect(filtersActive(DEFAULT_FILTERS)).toBe(false);
    expect(filtersActive(f({ colSelectable: true }))).toBe(false);
    expect(filtersActive(f({ types: { camera: false } as any }))).toBe(true);
    const n = normalizeFilters({ objects: 'n’importe quoi', types: { mesh: false }, contents: 3 });
    expect(n.objects).toBe('all');
    expect(n.types.mesh).toBe(false);
    expect(n.types.light).toBe(true);
    expect(n.contents).toBe(true);
  });
});

describe('outliner : suivi de l’objet actif', () => {
  it('déplie les parents repliés et donne l’index de la ligne', () => {
    const s = scene();
    const tree = buildTree(s.doc);
    const collapsed = new Set([colKey(s.col), objKey(s.table), ROOT_KEY]);
    const open = keysToReveal(tree, objKey(s.cup), collapsed);
    expect(open).toEqual([ROOT_KEY, colKey(s.col), objKey(s.table)]);
    const after = new Set([...collapsed].filter((k) => !open.includes(k)));
    const rows = flattenTree(tree, after, '', f({ contents: false }));
    expect(rowIndexOf(rows, objKey(s.cup))).toBe(3);
    // Sans « Enfants », le parent n'est pas sur le chemin affiché.
    expect(keysToReveal(tree, objKey(s.cup), collapsed, f({ children: false }))).toEqual([ROOT_KEY, colKey(s.col)]);
  });

  it('ne défile que si la ligne n’est pas entièrement visible', () => {
    expect(scrollToReveal(5, 22, 0, 400)).toBeNull();
    expect(scrollToReveal(30, 22, 0, 400)).toBe(30 * 22 + 22 - 400);
    expect(scrollToReveal(2, 22, 100, 400)).toBe(44);
  });
});

describe('types non sélectionnables dans le viewport', () => {
  it('préférence locale par type', () => {
    expect(objectTypeCategory('mesh')).toBe('mesh');
    expect(objectTypeCategory('curve')).toBe('other');
    setObjectTypeSelectable({ light: false });
    const st = store.getState();
    expect(isTypeSelectable(st, 'light')).toBe(false);
    expect(isTypeSelectable(st, 'mesh')).toBe(true);
    expect(isViewportSelectable(st, { type: 'mesh', selectable: false })).toBe(false);
  });

  it('A (tout sélectionner) ignore les types et objets non sélectionnables', () => {
    const s = scene();
    setObjectTypeSelectable({ camera: false });
    s.doc.updateObject(s.cup, { selectable: false });
    const op = selectOperators().find((o) => o.id === 'object.select_all')!;
    op.exec({ doc: s.doc } as any, { args: { action: 'select' } } as any);
    const sel = store.getState().selection;
    expect(sel.has(s.table)).toBe(true);
    expect(sel.has(s.lamp)).toBe(true);
    expect(sel.has(s.cam)).toBe(false);
    expect(sel.has(s.cup)).toBe(false);
    expect(sel.has(s.empty)).toBe(false); // masqué
    expect(selectableInViewport(s.doc, store.getState(), [s.table, s.cam])).toEqual([s.table]);
  });

  it('rectangle et clic du viewport ignorent un type non sélectionnable', () => {
    const camera = new PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, -10, 0);
    camera.up.set(0, 0, 1);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const node = (id: string, type: 'empty' | 'light', selectable = true) => ({
      id,
      type,
      obj: { selectable },
      visible: true,
      root: { matrix: new Matrix4() },
      gizmo: { visible: true, geometry: { getAttribute: () => undefined } },
    });
    const sync = {
      nodes: new Map<string, any>([
        ['e', node('e', 'empty')],
        ['l', node('l', 'light')],
        ['x', node('x', 'empty', false)],
      ]),
      gizmoPickable: () => true,
      effectiveShading: 'solid',
    };
    const picker = new Picker(sync as any);
    const env = (): PickEnv => ({ doc: null as any, state: store.getState(), camera, width: 200, height: 200, sync: sync as any, xray: false });
    const rect = { x0: 0, y0: 0, x1: 200, y1: 200 };
    expect(picker.pickObjectsInRect(env(), rect).sort()).toEqual(['e', 'l']);
    setObjectTypeSelectable({ empty: false });
    expect(picker.pickObjectsInRect(env(), rect)).toEqual(['l']);
    expect(picker.pickObject(env(), 100, 100)).toBe('l');
    setObjectTypeSelectable({ light: false });
    expect(picker.pickObject(env(), 100, 100)).toBeNull();
  });
});
