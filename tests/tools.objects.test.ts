import { beforeEach, describe, expect, it } from 'vitest';
import { Group, Matrix4, PerspectiveCamera, Vector3 } from 'three';
import type { AppContext } from '../src/app/context';
import { EMPTY_EDIT_SELECTION, initialState, setSelection, store } from '../src/app/store';
import { SceneDoc } from '../src/core/doc/SceneDoc';
import { worldMatrix } from '../src/core/doc/transforms';
import type { MeshData } from '../src/core/doc/schema';
import { evaluateModifiers } from '../src/core/mesh';
import type { IViewport } from '../src/engine/api';
import { OperatorRegistry } from '../src/tools/api';
import { registerBaseOperators } from '../src/tools/operators';
import { KEYMAP, findBindings } from '../src/tools/keymap';

// ------------------------------------------------------------------ faux contexte (Node, sans DOM ni WebGL)

function fakeViewport(getApp: () => AppContext): IViewport {
  const camera = new PerspectiveCamera(50, 800 / 600, 0.1, 1000);
  camera.up.set(0, 0, 1);
  camera.position.set(0, -10, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const W = 800;
  const H = 600;
  const vp: Partial<IViewport> = {
    camera,
    overlayRoot: new Group(),
    dom: undefined as any,
    getSize: () => ({ width: W, height: H }),
    requestRender: () => {},
    worldToScreen(p: any) {
      const v = Array.isArray(p) ? new Vector3(p[0], p[1], p[2]) : (p as Vector3).clone();
      const depth = v.distanceTo(camera.position);
      v.project(camera);
      if (v.z > 1) return null;
      return { x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H, depth };
    },
    screenToRay(x: number, y: number) {
      const ndc = new Vector3((x / W) * 2 - 1, 1 - (y / H) * 2, 0.5).unproject(camera);
      const origin = camera.position.clone();
      return { origin, dir: ndc.sub(origin).normalize() };
    },
    pickObject: () => null,
    pickObjectsInRect: () => [],
    pickElement: () => null,
    pickElementsInRect: () => [],
    raycastSurface: () => null,
    getObject3D: () => null,
    getEvaluatedMesh(id: string) {
      const doc = getApp().doc;
      const o = doc.getObject(id);
      const m = o?.data ? doc.getMesh(o.data) : null;
      return m && o ? evaluateModifiers(m, o.modifiers, { getOperand: () => null }) : null;
    },
    setView: () => {},
    frameSelection: () => {},
    frameAll: () => {},
  };
  return vp as IViewport;
}

function makeApp(): AppContext {
  let doc = SceneDoc.createEmpty();
  const app: any = {
    store,
    get doc() {
      return doc;
    },
    collab: {},
    setDoc(next: SceneDoc) {
      doc = next;
    },
    onDocChange(cb: (d: SceneDoc) => void) {
      cb(doc);
      return () => {};
    },
  };
  app.viewport = fakeViewport(() => app);
  app.ops = new OperatorRegistry(app);
  registerBaseOperators(app);
  return app as AppContext;
}

const key = (k: string, extra: Partial<KeyboardEvent> = {}) => ({ key: k, code: '', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...extra }) as KeyboardEvent;

function worldPos(doc: SceneDoc, id: string): Vector3 {
  return new Vector3().setFromMatrixPosition(worldMatrix(doc, id));
}

function expectMatrixClose(a: Matrix4, b: Matrix4): void {
  a.elements.forEach((v, i) => expect(v).toBeCloseTo(b.elements[i], 5));
}

function meshWorldVerts(doc: SceneDoc, id: string): number[][] {
  const o = doc.getObject(id)!;
  const m = doc.getMesh(o.data!)!;
  const w = worldMatrix(doc, id);
  return [...m.verts.values()].map((p) => new Vector3(...p).applyMatrix4(w).toArray()).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
}

let app: AppContext;

beforeEach(() => {
  store.setState(initialState());
  app = makeApp();
});

function addCube(at: [number, number, number] = [0, 0, 0]): string {
  store.setState({ cursor3d: at });
  expect(app.ops.run('object.add', { kind: 'cube' })).toBe(true);
  return store.getState().activeId!;
}

// ------------------------------------------------------------------ tests

describe('object.add', () => {
  it('crée une primitive au curseur 3D, sélectionnée, annulable', () => {
    store.setState({ cursor3d: [1, 2, 3] });
    expect(app.ops.run('object.add', { kind: 'cube', size: 4 })).toBe(true);
    const id = store.getState().activeId!;
    const obj = app.doc.getObject(id)!;
    expect(obj.type).toBe('mesh');
    expect(obj.pos).toEqual([1, 2, 3]);
    expect([...store.getState().selection]).toEqual([id]);
    const mesh = app.doc.getMesh(obj.data!)!;
    expect(mesh.verts.size).toBe(8);
    for (const p of mesh.verts.values()) expect(Math.abs(p[0])).toBeCloseTo(2);
    expect(store.getState().lastOp?.args.size).toBe(4);
    // les paramètres ajustables suivent le type de la dernière primitive
    expect(app.ops.get('object.add')!.params!.map((p) => p.key)).toEqual(['size']);
    app.doc.undo();
    expect(app.doc.objectIds()).toHaveLength(0);
    expect(app.doc.meshIds()).toHaveLength(0);
  });

  it('ajuste la dernière opération (redoLast)', () => {
    app.ops.run('object.add', { kind: 'uvsphere' });
    expect(app.ops.get('object.add')!.params!.map((p) => p.key)).toEqual(['segments', 'rings', 'radius']);
    expect(app.ops.redoLast({ segments: 8, rings: 4 })).toBe(true);
    expect(app.doc.objectIds()).toHaveLength(1);
    const o = app.doc.listObjects()[0];
    expect(app.doc.getMesh(o.data!)!.verts.size).toBe(8 * 3 + 2);
  });

  it('crée lumières, caméra et vide', () => {
    for (const kind of ['light_point', 'light_sun', 'light_spot', 'light_area', 'camera', 'empty']) expect(app.ops.run('object.add', { kind })).toBe(true);
    const types = app.doc.listObjects().map((o) => o.type);
    expect(types.filter((t) => t === 'light')).toHaveLength(4);
    expect(types).toContain('camera');
    expect(types).toContain('empty');
    const sun = app.doc.listObjects().find((o) => o.type === 'light' && app.doc.getLight(o.data!)!.kind === 'sun');
    expect(sun).toBeTruthy();
    expect(app.doc.getScene().activeCamera).toBeTruthy();
    expect(app.ops.run('object.add', { kind: 'nimporte' })).toBe(false);
  });
});

describe('object.delete', () => {
  it('supprime la sélection, conserve la position monde des enfants, annulable', () => {
    const parent = addCube([2, 0, 0]);
    const child = addCube([5, 1, 0]);
    app.doc.updateObject(child, { parent, pos: [3, 1, 0] });
    app.doc.clearHistory();
    const before = worldPos(app.doc, child);
    setSelection([parent], parent);
    expect(app.ops.run('object.delete')).toBe(true);
    expect(app.doc.hasObject(parent)).toBe(false);
    expect(app.doc.getObject(child)!.parent).toBeNull();
    expect(worldPos(app.doc, child).distanceTo(before)).toBeLessThan(1e-9);
    expect(store.getState().selection.size).toBe(0);
    app.doc.undo();
    expect(app.doc.hasObject(parent)).toBe(true);
    expect(app.doc.getObject(child)!.parent).toBe(parent);
  });
});

describe('object.duplicate', () => {
  it('duplique (copie et lié) sans déplacement', () => {
    const a = addCube();
    expect(app.ops.run('object.duplicate', { move: false })).toBe(true);
    const copy = store.getState().activeId!;
    expect(copy).not.toBe(a);
    expect(app.doc.getObject(copy)!.name).toBe('Cube.001');
    expect(app.doc.getObject(copy)!.data).not.toBe(app.doc.getObject(a)!.data);
    expect(app.ops.run('object.duplicate', { move: false, linked: true })).toBe(true);
    const linked = store.getState().activeId!;
    expect(app.doc.getObject(linked)!.data).toBe(app.doc.getObject(copy)!.data);
    app.doc.undo();
    app.doc.undo();
    expect(app.doc.objectIds()).toEqual([a]);
  });

  it('enchaîne un déplacement modal (saisie numérique) ; Échap annule la copie', () => {
    const a = addCube();
    app.ops.mouse = { x: 400, y: 300 };
    expect(app.ops.run('object.duplicate')).toBe(true);
    expect(app.ops.modalActive).toBe(true);
    const copy = store.getState().activeId!;
    app.ops.dispatchModal('keydown', key('x'));
    app.ops.dispatchModal('keydown', key('&', { code: 'Digit1' })); // AZERTY sans Maj → 1
    app.ops.dispatchModal('keydown', key('.'));
    app.ops.dispatchModal('keydown', key('5'));
    app.ops.dispatchModal('keydown', key('Enter'));
    expect(app.ops.modalActive).toBe(false);
    expect(app.doc.getObject(copy)!.pos[0]).toBeCloseTo(1.5);
    expect(app.doc.getObject(a)!.pos).toEqual([0, 0, 0]);
    // une seule étape d'annulation pour duplication + déplacement
    app.doc.undo();
    expect(app.doc.hasObject(copy)).toBe(false);

    setSelection([a], a);
    app.ops.run('object.duplicate');
    app.ops.dispatchModal('keydown', key('Escape'));
    expect(app.doc.objectIds()).toEqual([a]);
    // la sélection locale est restaurée à l'annulation
    expect([...store.getState().selection]).toEqual([a]);
    expect(store.getState().activeId).toBe(a);
  });

  it("une copie d'enfant suit la copie de son parent", () => {
    const p = addCube();
    const c = addCube([0, 0, 3]);
    app.doc.updateObject(c, { parent: p });
    setSelection([p, c], p);
    app.ops.run('object.duplicate', { move: false });
    const copies = [...store.getState().selection];
    const copyChild = copies.find((id) => app.doc.getObject(id)!.parent && app.doc.getObject(id)!.parent !== p)!;
    expect(copyChild).toBeTruthy();
    expect(copies).toContain(app.doc.getObject(copyChild)!.parent);
  });
});

describe('object.join', () => {
  it("fusionne les maillages dans l'actif en conservant la géométrie monde", () => {
    const a = addCube();
    const b = addCube([3, 0, 0]);
    app.doc.updateObject(b, { rot: [0, 0, 0.5], scl: [1, 2, 1] });
    app.doc.clearHistory();
    const expected = [...meshWorldVerts(app.doc, a), ...meshWorldVerts(app.doc, b)].sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
    setSelection([b, a], a);
    expect(app.ops.run('object.join')).toBe(true);
    expect(app.doc.objectIds()).toEqual([a]);
    const mesh = app.doc.getMesh(app.doc.getObject(a)!.data!)!;
    expect(mesh.verts.size).toBe(16);
    expect(mesh.faces.size).toBe(12);
    const got = meshWorldVerts(app.doc, a);
    got.forEach((p, i) => p.forEach((v, j) => expect(v).toBeCloseTo(expected[i][j], 6)));
    app.doc.undo();
    expect(app.doc.objectIds().sort()).toEqual([a, b].sort());
    expect(app.doc.getMesh(app.doc.getObject(a)!.data!)!.verts.size).toBe(8);
  });
});

describe('object.apply_transform', () => {
  it('intègre la transformation au maillage, objet remis à zéro, enfants inchangés', () => {
    const a = addCube();
    const child = addCube([0, 0, 0]);
    app.doc.updateObject(a, { pos: [1, 2, 3], rot: [0.3, 0, Math.PI / 2], scl: [2, 1, 0.5] });
    app.doc.updateObject(child, { parent: a, pos: [1, 0, 0] });
    app.doc.clearHistory();
    const vertsBefore = meshWorldVerts(app.doc, a);
    const childWorld = worldMatrix(app.doc, child);
    setSelection([a], a);
    expect(app.ops.run('object.apply_transform', { location: true, rotation: true, scale: true })).toBe(true);
    const o = app.doc.getObject(a)!;
    expect(o.pos).toEqual([0, 0, 0]);
    expect(o.rot).toEqual([0, 0, 0]);
    expect(o.scl).toEqual([1, 1, 1]);
    meshWorldVerts(app.doc, a).forEach((p, i) => p.forEach((v, j) => expect(v).toBeCloseTo(vertsBefore[i][j], 6)));
    expectMatrixClose(worldMatrix(app.doc, child), childWorld);
    app.doc.undo();
    expect(app.doc.getObject(a)!.pos).toEqual([1, 2, 3]);
  });

  it("échelle seule : position et rotation conservées ; maillage partagé copié", () => {
    const a = addCube();
    app.ops.run('object.duplicate', { move: false, linked: true });
    const linked = store.getState().activeId!;
    app.doc.updateObject(a, { pos: [1, 0, 0], rot: [0, 0, 1], scl: [3, 3, 3] });
    const vertsBefore = meshWorldVerts(app.doc, a);
    const linkedVerts = meshWorldVerts(app.doc, linked);
    setSelection([a], a);
    app.ops.run('object.apply_transform', { location: false, rotation: false, scale: true });
    const o = app.doc.getObject(a)!;
    expect(o.pos).toEqual([1, 0, 0]);
    expect(o.rot).toEqual([0, 0, 1]);
    expect(o.scl).toEqual([1, 1, 1]);
    expect(o.data).not.toBe(app.doc.getObject(linked)!.data);
    meshWorldVerts(app.doc, a).forEach((p, i) => p.forEach((v, j) => expect(v).toBeCloseTo(vertsBefore[i][j], 6)));
    expect(meshWorldVerts(app.doc, linked)).toEqual(linkedVerts);
  });
});

describe('object.parent_set / parent_clear', () => {
  it('conservent la transformation monde', () => {
    const p = addCube([1, 1, 0]);
    const c = addCube([4, -2, 1]);
    app.doc.updateObject(p, { rot: [0, 0, 0.7], scl: [2, 2, 2] });
    app.doc.updateObject(c, { rot: [0.2, 0.1, 0] });
    app.doc.clearHistory();
    const before = worldMatrix(app.doc, c);
    setSelection([c, p], p);
    expect(app.ops.run('object.parent_set')).toBe(true);
    expect(app.doc.getObject(c)!.parent).toBe(p);
    expectMatrixClose(worldMatrix(app.doc, c), before);
    // un cycle est refusé
    setSelection([p, c], c);
    expect(app.ops.run('object.parent_set')).toBe(false);
    expect(app.doc.getObject(p)!.parent).toBeNull();
    setSelection([c], c);
    expect(app.ops.run('object.parent_clear')).toBe(true);
    expect(app.doc.getObject(c)!.parent).toBeNull();
    expectMatrixClose(worldMatrix(app.doc, c), before);
    app.doc.undo();
    expect(app.doc.getObject(c)!.parent).toBe(p);
    app.doc.undo();
    expect(app.doc.getObject(c)!.parent).toBeNull();
    expect(app.doc.getObject(c)!.pos).toEqual([4, -2, 1]);
  });
});

describe('modificateurs', () => {
  it('modifier_add / move / apply / remove', () => {
    const a = addCube([2, 0, 0]);
    app.doc.clearHistory();
    expect(app.ops.run('object.modifier_add', { type: 'mirror' })).toBe(true);
    expect(app.ops.run('object.modifier_add', { type: 'mirror' })).toBe(true);
    let mods = app.doc.getObject(a)!.modifiers;
    expect(mods.map((m) => m.name)).toEqual(['Miroir', 'Miroir.001']);
    expect(app.ops.run('object.modifier_move', { modifierId: mods[1].id, direction: -1 })).toBe(true);
    expect(app.doc.getObject(a)!.modifiers.map((m) => m.name)).toEqual(['Miroir.001', 'Miroir']);
    expect(app.ops.run('object.modifier_remove', { modifierId: mods[0].id })).toBe(true);
    mods = app.doc.getObject(a)!.modifiers;
    expect(mods).toHaveLength(1);

    const meshBefore = app.doc.getMesh(app.doc.getObject(a)!.data!)!;
    const expected: MeshData = evaluateModifiers(meshBefore, mods, { getOperand: () => null });
    expect(app.ops.run('object.modifier_apply', { modifierId: mods[0].id })).toBe(true);
    const o = app.doc.getObject(a)!;
    expect(o.modifiers).toHaveLength(0);
    const after = app.doc.getMesh(o.data!)!;
    expect(after.verts.size).toBe(expected.verts.size);
    expect(after.faces.size).toBe(expected.faces.size);
    for (const [id, p] of expected.verts) expect(after.verts.get(id)).toEqual(p);

    app.doc.undo();
    expect(app.doc.getObject(a)!.modifiers).toHaveLength(1);
    expect(app.doc.getMesh(app.doc.getObject(a)!.data!)!.verts.size).toBe(8);
    expect(app.ops.run('object.modifier_apply', { modifierId: 'inexistant' })).toBe(false);
  });
});

describe('transformations', () => {
  it('translate / rotate / scale avec arguments directs, hiérarchie respectée', () => {
    const p = addCube([1, 0, 0]);
    const c = addCube([1, 0, 2]);
    app.doc.updateObject(c, { parent: p, pos: [0, 0, 2] });
    setSelection([p, c], p);
    expect(app.ops.run('transform.translate', { value: [1, 2, 0] })).toBe(true);
    expect(app.doc.getObject(p)!.pos).toEqual([2, 2, 0]);
    expect(app.doc.getObject(c)!.pos).toEqual([0, 0, 2]); // pas transformé deux fois
    store.setState({ pivot: 'individual' });
    expect(app.ops.run('transform.rotate', { angle: Math.PI / 2, axis: 'Z' })).toBe(true);
    expect(app.doc.getObject(p)!.rot[2]).toBeCloseTo(Math.PI / 2);
    expect(app.doc.getObject(p)!.pos[0]).toBeCloseTo(2);
    expect(app.ops.run('transform.scale', { value: 2 })).toBe(true);
    expect(app.doc.getObject(p)!.scl[0]).toBeCloseTo(2);
    expect(app.doc.getObject(p)!.scl[2]).toBeCloseTo(2);
    app.doc.undo();
    app.doc.undo();
    app.doc.undo();
    expect(app.doc.getObject(p)!.pos).toEqual([1, 0, 0]);
  });

  it('rotation modale autour du pivot médian, contrainte Z, saisie numérique ; clic droit annule', () => {
    const a = addCube([2, 0, 0]);
    const b = addCube([-2, 0, 0]);
    setSelection([a, b], a);
    app.ops.mouse = { x: 500, y: 300 };
    expect(app.ops.run('transform.rotate')).toBe(true);
    app.ops.dispatchModal('keydown', key('z'));
    app.ops.dispatchModal('keydown', key('9'));
    app.ops.dispatchModal('keydown', key('0'));
    expect(store.getState().modal?.status).toContain('autour de Z');
    app.ops.dispatchModal('pointerdown', { button: 0, clientX: 500, clientY: 300 } as PointerEvent);
    expect(app.ops.modalActive).toBe(false);
    const pa = app.doc.getObject(a)!.pos;
    expect(pa[0]).toBeCloseTo(0);
    expect(pa[1]).toBeCloseTo(2);
    expect(app.doc.getObject(b)!.pos[1]).toBeCloseTo(-2);

    app.ops.run('transform.translate');
    app.ops.dispatchModal('pointermove', { clientX: 600, clientY: 250, shiftKey: false, ctrlKey: false } as PointerEvent);
    app.ops.dispatchModal('pointerdown', { button: 2, clientX: 600, clientY: 250 } as PointerEvent);
    expect(app.doc.getObject(a)!.pos[1]).toBeCloseTo(2);
  });

  it('déplacement libre à la souris dans le plan de vue', () => {
    const a = addCube();
    app.ops.mouse = { x: 400, y: 300 };
    app.ops.run('transform.translate');
    app.ops.dispatchModal('pointermove', { clientX: 500, clientY: 300, shiftKey: false, ctrlKey: false } as PointerEvent);
    app.ops.dispatchModal('keydown', key('Enter'));
    const pos = app.doc.getObject(a)!.pos;
    // caméra en (0,-10,0) regardant +Y : la droite de l'écran = +X monde
    expect(pos[0]).toBeGreaterThan(0.5);
    expect(Math.abs(pos[1])).toBeLessThan(1e-9);
    expect(Math.abs(pos[2])).toBeLessThan(1e-9);
  });

  it('aimantation aux sommets : un sommet de la sélection vient exactement sur le sommet visé', () => {
    const a = addCube();
    const b = addCube([5, 0, 3]);
    const target = meshWorldVerts(app.doc, a).find((p) => p[0] > 0 && p[1] < 0 && p[2] > 0)!;
    const screen = app.viewport.worldToScreen(new Vector3(...target))!;
    store.setState({ snap: true, snapTarget: 'vertex' });
    app.ops.mouse = { x: 700, y: 100 };
    app.ops.run('transform.translate');
    app.ops.dispatchModal('pointermove', { clientX: screen.x + 3, clientY: screen.y - 2, shiftKey: false, ctrlKey: false } as PointerEvent);
    app.ops.dispatchModal('keydown', key('Enter'));
    const moved = meshWorldVerts(app.doc, b);
    const origin = worldPos(app.doc, b).toArray();
    const hit = [...moved, origin].some((p) => Math.hypot(p[0] - target[0], p[1] - target[1], p[2] - target[2]) < 1e-6);
    expect(hit).toBe(true);
    // Le cube visé n'a pas bougé.
    expect(worldPos(app.doc, a).length()).toBeCloseTo(0);

    // Avec une contrainte d'axe, seule la composante le long de l'axe est reprise.
    const before = worldPos(app.doc, b);
    app.ops.run('transform.translate');
    app.ops.dispatchModal('keydown', key('z', { code: 'KeyZ' }));
    app.ops.dispatchModal('pointermove', { clientX: 5, clientY: 5, shiftKey: false, ctrlKey: false } as PointerEvent);
    app.ops.dispatchModal('pointermove', { clientX: screen.x, clientY: screen.y, shiftKey: false, ctrlKey: false } as PointerEvent);
    app.ops.dispatchModal('keydown', key('Enter'));
    const after = worldPos(app.doc, b);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);

    // Loin de tout sommet : pas d'aimantation, déplacement libre.
    store.setState({ snapTarget: 'grid', snap: false });
  });

  it('mode édition : déplace les sommets sélectionnés via setMeshVerts', () => {
    const a = addCube();
    const meshId = app.doc.getObject(a)!.data!;
    const mesh = app.doc.getMesh(meshId)!;
    const top = [...mesh.verts].filter(([, p]) => p[2] > 0).map(([id]) => id);
    expect(app.ops.run('object.mode_toggle')).toBe(true);
    expect(store.getState().mode).toBe('edit');
    store.setState({ editSelection: { verts: new Set(top), edges: new Set(), faces: new Set() } });
    app.doc.updateObject(a, { scl: [2, 2, 2] });
    expect(app.ops.run('transform.translate', { value: [0, 0, 1] })).toBe(true);
    const after = app.doc.getMesh(meshId)!;
    for (const id of top) expect(after.verts.get(id)![2]).toBeCloseTo(1.5); // 1 + 1/2 (échelle 2)
    for (const [id, p] of after.verts) if (!top.includes(id)) expect(p[2]).toBeCloseTo(-1);
    // mode de sélection : sommets → faces
    expect(app.ops.run('mesh.select_mode', { mode: 'face' })).toBe(true);
    expect(store.getState().editSelection.faces.size).toBe(1);
    app.doc.undo();
    expect(app.doc.getMesh(meshId)!.verts.get(top[0])![2]).toBeCloseTo(1);
    app.ops.run('object.mode_toggle');
    expect(store.getState().mode).toBe('object');
    expect(store.getState().editSelection).toBe(EMPTY_EDIT_SELECTION);
  });
});

describe('sélection, visibilité, divers', () => {
  it('select_all, hide/reveal, clear_transform, origin_set, snap', () => {
    const a = addCube([1, 0, 0]);
    const b = addCube([0, 3, 0]);
    app.ops.run('object.select_all', { action: 'deselect' });
    expect(store.getState().selection.size).toBe(0);
    app.ops.run('object.select_all', { action: 'select' });
    expect(store.getState().selection.size).toBe(2);
    setSelection([a], a);
    app.ops.run('object.select_all', { action: 'invert' });
    expect([...store.getState().selection]).toEqual([b]);
    app.ops.run('object.hide');
    expect(app.doc.getObject(b)!.visible).toBe(false);
    app.ops.run('object.reveal');
    expect(app.doc.getObject(b)!.visible).toBe(true);
    expect(store.getState().selection.has(b)).toBe(true);

    setSelection([a], a);
    app.ops.run('object.clear_transform', { what: 'location' });
    expect(app.doc.getObject(a)!.pos).toEqual([0, 0, 0]);

    store.setState({ cursor3d: [0, 0, 5] });
    const before = meshWorldVerts(app.doc, a);
    app.ops.run('object.origin_set', { type: 'cursor' });
    expect(app.doc.getObject(a)!.pos[2]).toBeCloseTo(5);
    meshWorldVerts(app.doc, a).forEach((p, i) => p.forEach((v, j) => expect(v).toBeCloseTo(before[i][j], 6)));
    app.ops.run('object.origin_set', { type: 'geometry' });
    expect(app.doc.getObject(a)!.pos[2]).toBeCloseTo(0);

    store.setState({ cursor3d: [7, 7, 7] });
    app.ops.run('object.snap_to_cursor');
    expect(app.doc.getObject(a)!.pos).toEqual([7, 7, 7]);
    app.ops.run('view.snap_cursor', { to: 'origin' });
    expect(store.getState().cursor3d).toEqual([0, 0, 0]);

    app.ops.run('object.rename', { name: 'Bloc' });
    expect(app.doc.getObject(a)!.name).toBe('Bloc');
    app.ops.run('object.move_to_collection', { name: 'Décor' });
    const col = app.doc.getObject(a)!.collection;
    expect(app.doc.getCollection(col)?.name).toBe('Décor');
    app.ops.run('object.shade', { smooth: true });
    expect(app.doc.getObject(a)!.shadeSmooth).toBe(true);
  });

  it('table des raccourcis : opérateurs enregistrés, pavé numérique et AZERTY', () => {
    const registered = new Set(app.ops.list().map((o) => o.id));
    const appOps = ['file.new', 'file.open', 'file.save', 'file.save_as', 'edit.undo', 'edit.redo', 'view.search', 'render.render', 'render.view', 'screen.workspace_cycle'];
    for (const b of KEYMAP) {
      if (b.op.startsWith('mesh.') && b.op !== 'mesh.select_mode') continue;
      // Opérateurs d'animation : enregistrés par registerAnimOps (src/tools/anim), testés dans anim.ops.test.ts.
      if (b.op.startsWith('anim.') || b.op === 'render.render_animation') continue;
      if (appOps.includes(b.op)) continue;
      expect(registered.has(b.op), b.op).toBe(true);
    }
    const ev = (o: Partial<KeyboardEvent>) => ({ key: '', code: '', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...o }) as KeyboardEvent;
    expect(findBindings(ev({ key: '1', code: 'Numpad1' }), 'object')[0].args).toEqual({ dir: 'front' });
    expect(findBindings(ev({ key: 'End', code: 'Numpad1', ctrlKey: true }), 'object')[0].args).toEqual({ dir: 'back' });
    expect(findBindings(ev({ key: '&', code: 'Digit1' }), 'edit')[0].args).toEqual({ mode: 'vert' });
    expect(findBindings(ev({ key: 'a', code: 'KeyQ' }), 'object')[0].op).toBe('object.select_all'); // AZERTY : touche A
    expect(findBindings(ev({ key: 'g', code: 'KeyG' }), 'edit')[0].op).toBe('transform.translate');
    expect(findBindings(ev({ key: 'S', code: 'KeyS', ctrlKey: true, shiftKey: true }), 'object')[0].op).toBe('file.save_as');
  });
});
