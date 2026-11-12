import { Group, Matrix4, Vector3 } from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/app/context';
import { initialState, store } from '../src/app/store';
import { SceneDoc } from '../src/core/doc/SceneDoc';
import { edgeKey, type MeshData, type Vec3 } from '../src/core/doc/schema';
import { faceNormal } from '../src/core/mesh/topology';
import type { ElementHit, IViewport } from '../src/engine/api';
import { OperatorRegistry, type ModalHandler } from '../src/tools/api';
import { registerMeshOps } from '../src/tools/mesh';

/**
 * Opérateurs `mesh.*` sur un cube, sans DOM ni WebGL : vrai SceneDoc, vrai store, vrai registre,
 * faux viewport (projection orthographique simple : x écran = 400 + 100·X, y écran = 300 − 100·Z).
 * Le déplacement modal des outils de base (startTranslateModal) est remplacé par une doublure.
 */

const translate = vi.hoisted(() => ({
  calls: [] as { constraint?: { axis: [number, number, number] } | null; status?: string }[],
}));

vi.mock('../src/tools/transform', () => ({
  startTranslateModal: (_app: unknown, opts?: { constraint?: { axis: [number, number, number] } | null; status?: string }): ModalHandler => {
    translate.calls.push(opts ?? {});
    return {
      status: opts?.status ?? 'Déplacer',
      onKeyDown: (e: KeyboardEvent) => (e.key === 'Escape' ? 'cancelled' : e.key === 'Enter' ? 'finished' : undefined),
    };
  },
}));

let pickResult: ElementHit | null = null;

function fakeViewport(): IViewport {
  const camera = { matrixWorld: new Matrix4() };
  const vp = {
    dom: undefined,
    camera,
    overlayRoot: new Group(),
    requestRender() {},
    getSize: () => ({ width: 800, height: 600 }),
    worldToScreen(p: Vec3 | Vector3) {
      const v = Array.isArray(p) ? new Vector3(p[0], p[1], p[2]) : p;
      return { x: 400 + v.x * 100, y: 300 - v.z * 100, depth: 10 - v.y };
    },
    screenToRay: (x: number, y: number) => ({ origin: new Vector3((x - 400) / 100, -10, (300 - y) / 100), dir: new Vector3(0, 1, 0) }),
    pickElement: () => pickResult,
    pickElementsInRect: () => [],
    pickObject: () => null,
    pickObjectsInRect: () => [],
    raycastSurface: () => null,
    getObject3D: () => null,
    getEvaluatedMesh: () => null,
  };
  return vp as unknown as IViewport;
}

interface TestApp {
  app: AppContext;
  ops: OperatorRegistry;
  doc: SceneDoc;
  objectId: string;
  meshId: string;
}

function setup(): TestApp {
  const doc = SceneDoc.createNew();
  const obj = doc.listObjects().find((o) => o.type === 'mesh')!;
  const holder: { doc: SceneDoc } = { doc };
  const app = {
    get doc() {
      return holder.doc;
    },
    store,
    viewport: fakeViewport(),
    collab: {} as AppContext['collab'],
    ops: null as unknown as OperatorRegistry,
    setDoc(d: SceneDoc) {
      holder.doc = d;
    },
    onDocChange(cb: (d: SceneDoc) => void | (() => void)) {
      cb(holder.doc);
      return () => {};
    },
  } as AppContext & { ops: OperatorRegistry };
  const ops = new OperatorRegistry(app);
  (app as { ops: OperatorRegistry }).ops = ops;
  registerMeshOps(app);
  store.setState({
    ...initialState(),
    mode: 'edit',
    selection: new Set([obj.id]),
    activeId: obj.id,
    selectMode: 'face',
  });
  return { app, ops, doc, objectId: obj.id, meshId: obj.data! };
}

const mesh = (t: TestApp): MeshData => t.doc.getMesh(t.meshId)!;

/** Face du dessus du cube (tous ses sommets à z = 1). */
function topFace(t: TestApp): string {
  const m = mesh(t);
  for (const [fid, loop] of m.faces) if (loop.every((v) => m.verts.get(v)![2] > 0.99)) return fid;
  throw new Error('face du dessus introuvable');
}

function topVerts(t: TestApp): string[] {
  const m = mesh(t);
  return [...m.verts].filter(([, p]) => p[2] > 0.99).map(([v]) => v);
}

function selectFaces(t: TestApp, faces: string[]): void {
  const m = mesh(t);
  const verts = new Set<string>();
  const edges = new Set<string>();
  for (const f of faces) {
    const loop = m.faces.get(f)!;
    loop.forEach((v, i) => {
      verts.add(v);
      edges.add(edgeKey(v, loop[(i + 1) % loop.length]));
    });
  }
  store.setState({ selectMode: 'face', editSelection: { verts, edges, faces: new Set(faces) } });
}

function selectVerts(t: TestApp, verts: string[]): void {
  void t;
  store.setState({ selectMode: 'vert', editSelection: { verts: new Set(verts), edges: new Set(), faces: new Set() } });
}

function selectEdges(edges: string[]): void {
  store.setState({ selectMode: 'edge', editSelection: { verts: new Set(), edges: new Set(edges), faces: new Set() } });
}

const ev = (o: Record<string, unknown>) => o as unknown as Event;

describe('opérateurs mesh.* (mode édition)', () => {
  let t: TestApp;
  beforeEach(() => {
    translate.calls.length = 0;
    pickResult = null;
    t = setup();
  });

  it('enregistre tous les opérateurs du catalogue', () => {
    const ids = [
      'mesh.select_all',
      'mesh.select_linked',
      'mesh.select_more',
      'mesh.select_less',
      'mesh.extrude',
      'mesh.extrude_normals',
      'mesh.inset',
      'mesh.bevel',
      'mesh.loop_cut',
      'mesh.subdivide',
      'mesh.fill',
      'mesh.bridge',
      'mesh.triangulate',
      'mesh.duplicate',
      'mesh.separate',
      'mesh.merge',
      'mesh.flip_normals',
      'mesh.recalc_normals',
      'mesh.delete',
      'mesh.dissolve',
      'mesh.add_primitive',
    ];
    for (const id of ids) expect(t.ops.get(id), id).toBeTruthy();
    expect(t.ops.canRun('mesh.subdivide')).toBe(true);
    store.setState({ mode: 'object' });
    expect(t.ops.canRun('mesh.subdivide')).toBe(false);
  });

  it('refuse proprement une sélection vide (toast, rien d’écrit)', () => {
    store.setState({ editSelection: { verts: new Set(), edges: new Set(), faces: new Set() } });
    expect(t.ops.run('mesh.subdivide')).toBe(false);
    expect(store.getState().toast?.text).toMatch(/face/);
    expect(t.doc.canUndo()).toBe(false);
  });

  it('refuse si l’objet actif a disparu', () => {
    t.doc.removeObject(t.objectId);
    expect(t.ops.run('mesh.select_all', { action: 'select' })).toBe(false);
  });

  it('select_all / invert / select_more', () => {
    t.ops.run('mesh.select_all', { action: 'select' });
    expect(store.getState().editSelection.faces.size).toBe(6);
    expect(store.getState().editSelection.verts.size).toBe(8);
    selectFaces(t, [topFace(t)]);
    t.ops.run('mesh.select_all', { action: 'invert' });
    expect(store.getState().editSelection.faces.size).toBe(5);
    selectFaces(t, [topFace(t)]);
    t.ops.run('mesh.select_more');
    expect(store.getState().editSelection.verts.size).toBe(8);
    t.ops.run('mesh.select_all', { action: 'deselect' });
    expect(store.getState().editSelection.verts.size).toBe(0);
  });

  it('subdivide, puis ajustement (rejeu) et annulation', () => {
    selectFaces(t, [topFace(t)]);
    expect(t.ops.run('mesh.subdivide', { cuts: 1 })).toBe(true);
    expect(mesh(t).faces.size).toBe(9);
    expect(mesh(t).verts.size).toBe(13);
    expect(store.getState().lastOp?.opId).toBe('mesh.subdivide');
    // Panneau « Ajuster la dernière opération » : 2 coupes sur la face d'origine.
    expect(t.ops.redoLast({ cuts: 2 })).toBe(true);
    expect(mesh(t).faces.size).toBe(14);
    expect(mesh(t).verts.size).toBe(20);
    t.doc.undo();
    expect(mesh(t).faces.size).toBe(6);
    expect(mesh(t).verts.size).toBe(8);
  });

  it('delete faces puis fill', () => {
    selectFaces(t, [topFace(t)]);
    expect(t.ops.run('mesh.delete', { what: 'faces' })).toBe(true);
    expect(mesh(t).faces.size).toBe(5);
    expect(mesh(t).verts.size).toBe(8);
    selectVerts(t, topVerts(t));
    expect(t.ops.run('mesh.fill')).toBe(true);
    expect(mesh(t).faces.size).toBe(6);
    t.doc.undo();
    expect(mesh(t).faces.size).toBe(5);
    t.doc.undo();
    expect(mesh(t).faces.size).toBe(6);
  });

  it('triangulate', () => {
    t.ops.run('mesh.select_all', { action: 'select' });
    expect(t.ops.run('mesh.triangulate')).toBe(true);
    expect(mesh(t).faces.size).toBe(12);
    for (const loop of mesh(t).faces.values()) expect(loop.length).toBe(3);
    t.doc.undo();
    expect(mesh(t).faces.size).toBe(6);
  });

  it('flip_normals', () => {
    const top = topFace(t);
    selectFaces(t, [top]);
    expect(faceNormal(mesh(t), top)[2]).toBeCloseTo(1);
    expect(t.ops.run('mesh.flip_normals')).toBe(true);
    expect(faceNormal(mesh(t), top)[2]).toBeCloseTo(-1);
    t.doc.undo();
    expect(faceNormal(mesh(t), top)[2]).toBeCloseTo(1);
  });

  it('merge au centre', () => {
    selectVerts(t, topVerts(t));
    expect(t.ops.run('mesh.merge', { at: 'center' })).toBe(true);
    const m = mesh(t);
    expect(m.verts.size).toBe(5);
    const apex = [...m.verts.values()].find((p) => p[2] > 0.99)!;
    expect(apex[0]).toBeCloseTo(0);
    expect(apex[1]).toBeCloseTo(0);
    t.doc.undo();
    expect(mesh(t).verts.size).toBe(8);
  });

  it('separate : nouvel objet, même transformation et matériau', () => {
    t.doc.updateObject(t.objectId, { pos: [1, 2, 3] });
    const before = t.doc.getObject(t.objectId)!;
    selectFaces(t, [topFace(t)]);
    const n0 = t.doc.listObjects().length;
    expect(t.ops.run('mesh.separate')).toBe(true);
    const objs = t.doc.listObjects();
    expect(objs.length).toBe(n0 + 1);
    const created = objs.find((o) => o.type === 'mesh' && o.id !== t.objectId)!;
    expect(created.pos).toEqual([1, 2, 3]);
    expect(created.material).toBe(before.material);
    const extracted = t.doc.getMesh(created.data!)!;
    expect(extracted.faces.size).toBe(1);
    expect(extracted.verts.size).toBe(4);
    expect(mesh(t).faces.size).toBe(5);
    t.doc.undo();
    expect(t.doc.listObjects().length).toBe(n0);
    expect(mesh(t).faces.size).toBe(6);
  });

  it('duplicate sans déplacement', () => {
    selectFaces(t, [topFace(t)]);
    expect(t.ops.run('mesh.duplicate', { move: false })).toBe(true);
    expect(mesh(t).faces.size).toBe(7);
    expect(mesh(t).verts.size).toBe(12);
    expect(store.getState().editSelection.faces.size).toBe(1);
    expect(t.ops.modalActive).toBe(false);
    t.doc.undo();
    expect(mesh(t).faces.size).toBe(6);
  });

  it('duplicate puis déplacement annulé : tout est défait, sélection rendue', () => {
    const top = topFace(t);
    selectFaces(t, [top]);
    expect(t.ops.run('mesh.duplicate')).toBe(true);
    expect(t.ops.modalActive).toBe(true);
    expect(translate.calls.length).toBe(1);
    expect(mesh(t).faces.size).toBe(7);
    t.ops.dispatchModal('keydown', ev({ key: 'Escape' }));
    expect(t.ops.modalActive).toBe(false);
    expect(mesh(t).faces.size).toBe(6);
    expect([...store.getState().editSelection.faces]).toEqual([top]);
    expect(t.doc.canUndo()).toBe(false);
  });

  it('extrude (E) : région puis déplacement contraint à la normale', () => {
    selectFaces(t, [topFace(t)]);
    expect(t.ops.run('mesh.extrude')).toBe(true);
    expect(mesh(t).faces.size).toBe(10);
    expect(mesh(t).verts.size).toBe(12);
    const axis = translate.calls[0].constraint!.axis;
    expect(axis[2]).toBeCloseTo(1);
    t.ops.dispatchModal('keydown', ev({ key: 'Enter' }));
    expect(t.ops.modalActive).toBe(false);
    expect(mesh(t).faces.size).toBe(10);
    t.doc.undo();
    expect(mesh(t).faces.size).toBe(6);
  });

  it('add_primitive au curseur 3D', () => {
    t.doc.updateObject(t.objectId, { pos: [1, 0, 0] });
    store.setState({ cursor3d: [1, 0, 5] });
    expect(t.ops.run('mesh.add_primitive', { kind: 'cube', size: 1 })).toBe(true);
    const m = mesh(t);
    expect(m.faces.size).toBe(12);
    // Cube de 1 m centré sur le curseur (5 m de haut), exprimé dans le repère local de l'objet.
    const high = [...m.verts.values()].filter((p) => p[2] > 4);
    expect(high.length).toBe(8);
    for (const p of high) expect(Math.abs(p[0])).toBeCloseTo(0.5);
    expect(store.getState().editSelection.faces.size).toBe(6);
  });

  it('inset (modal) : épaisseur à la souris, annulation complète', () => {
    const top = topFace(t);
    selectFaces(t, [top]);
    t.ops.mouse = { x: 600, y: 300 };
    expect(t.ops.run('mesh.inset')).toBe(true);
    expect(t.ops.modalActive).toBe(true);
    t.ops.dispatchModal('pointermove', ev({ clientX: 600, clientY: 300 }));
    t.ops.dispatchModal('pointermove', ev({ clientX: 580, clientY: 290 }));
    expect(mesh(t).faces.size).toBe(10);
    t.ops.dispatchModal('keydown', ev({ key: 'Escape' }));
    expect(mesh(t).faces.size).toBe(6);
    expect([...store.getState().editSelection.faces]).toEqual([top]);
  });

  it('inset (modal) : saisie numérique et validation', () => {
    selectFaces(t, [topFace(t)]);
    t.ops.run('mesh.inset');
    for (const key of ['0', '.', '2']) t.ops.dispatchModal('keydown', ev({ key }));
    t.ops.dispatchModal('keydown', ev({ key: 'Enter' }));
    expect(t.ops.modalActive).toBe(false);
    const m = mesh(t);
    expect(m.faces.size).toBe(10);
    // Face intérieure : côtés de 2 − 2 × 0,2 = 1,6 m.
    const inner = [...store.getState().editSelection.faces][0];
    const xs = m.faces.get(inner)!.map((v) => m.verts.get(v)![0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(1.6);
    t.doc.undo();
    expect(mesh(t).faces.size).toBe(6);
  });

  it('bevel (modal) : largeur, molette, annulation', () => {
    const m = mesh(t);
    // Arête avant du dessus (y = −1, z = 1) : son milieu se projette en (400, 200).
    const front = [...m.verts].filter(([, p]) => p[1] < -0.99 && p[2] > 0.99).map(([v]) => v);
    selectEdges([edgeKey(front[0], front[1])]);
    t.ops.mouse = { x: 410, y: 210 };
    expect(t.ops.run('mesh.bevel')).toBe(true);
    t.ops.dispatchModal('pointermove', ev({ clientX: 410, clientY: 210 }));
    t.ops.dispatchModal('pointermove', ev({ clientX: 430, clientY: 210 }));
    expect(mesh(t).faces.size).toBeGreaterThan(6);
    const after1 = mesh(t).faces.size;
    t.ops.dispatchModal('wheel', ev({ deltaY: -1 }));
    expect(mesh(t).faces.size).toBeGreaterThan(after1);
    t.ops.dispatchModal('keydown', ev({ key: 'Escape' }));
    expect(mesh(t).faces.size).toBe(6);
    expect(mesh(t).verts.size).toBe(8);
  });

  it('loop_cut (modal) : survol, aperçu, clic puis validation', () => {
    const m = mesh(t);
    // Arête verticale du cube (x = 1, y = -1).
    const ids = [...m.verts].filter(([, p]) => p[0] > 0.99 && p[1] < -0.99).map(([v]) => v);
    pickResult = { type: 'edge', id: edgeKey(ids[0], ids[1]), point: [1, -1, 0] };
    t.ops.mouse = { x: 500, y: 300 };
    expect(t.ops.run('mesh.loop_cut')).toBe(true);
    expect(t.app.viewport.overlayRoot.children.length).toBe(1);
    t.ops.dispatchModal('pointerdown', ev({ clientX: 500, clientY: 300, button: 0 }));
    expect(t.app.viewport.overlayRoot.children.length).toBe(0);
    expect(mesh(t).verts.size).toBe(12);
    expect(mesh(t).faces.size).toBe(10);
    t.ops.dispatchModal('keydown', ev({ key: 'Enter' }));
    expect(t.ops.modalActive).toBe(false);
    expect(mesh(t).faces.size).toBe(10);
    t.doc.undo();
    expect(mesh(t).faces.size).toBe(6);
  });
});
