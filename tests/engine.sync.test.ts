import { describe, expect, it } from 'vitest';
import { Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { SceneDoc } from '../src/core/doc/SceneDoc';
import { initialState, type AppState } from '../src/app/store';
import { SceneSync, type SyncHost } from '../src/engine/sceneSync';
import { MeshEvaluator } from '../src/engine/meshCache';
import {
  distToSegment2D,
  makeProjector,
  meshEdges,
  normRect,
  Picker,
  pointInTriangle2D,
  projectSegment,
  segmentIntersectsRect,
  type PickEnv,
} from '../src/engine/picking';
import { buildCageArrays } from '../src/engine/editOverlay';
import { axisViewQuaternion, lookQuaternion } from '../src/engine/navigation';

/** Tests de la logique pure du moteur (sans WebGL). */

function makeSync(doc: SceneDoc, state: AppState = initialState()) {
  const dirty: string[] = [];
  const host: SyncHost = {
    getDoc: () => doc,
    getState: () => state,
    requestRender: () => {},
    markDirty: (k) => dirty.push(k),
    drawingSize: () => ({ width: 800, height: 600 }),
  };
  const sync = new SceneSync(host);
  sync.attach(doc);
  return { sync, dirty, state };
}

function cubeId(doc: SceneDoc): string {
  return doc.listObjects().find((o) => o.type === 'mesh')!.id;
}

describe('SceneSync', () => {
  it('reflète la scène par défaut et respecte le contrat de géométrie', () => {
    const doc = SceneDoc.createNew();
    const { sync } = makeSync(doc);
    sync.flush();
    expect(sync.nodes.size).toBe(3);
    const cube = sync.nodes.get(cubeId(doc))!;
    expect(cube.surface).toBeTruthy();
    const g = cube.surface!.geometry;
    expect(g.index).toBeNull();
    expect(Object.keys(g.attributes).sort()).toEqual(['normal', 'position']);
    // 6 quads → 12 triangles
    expect(g.getAttribute('position').count).toBe(36);
    // lumière three.js présente dans la scène, gizmo dans l'overlay
    const light = [...sync.nodes.values()].find((n) => n.type === 'light')!;
    expect(light.light).toBeTruthy();
    expect(light.gizmo).toBeTruthy();
    let inScene = false;
    sync.scene.traverse((o) => {
      if (o === light.gizmo) inScene = true;
    });
    expect(inScene).toBe(false);
  });

  it('met à jour la transformation sans reconstruire la géométrie, et regroupe les événements', () => {
    const doc = SceneDoc.createNew();
    const { sync, dirty } = makeSync(doc);
    sync.flush();
    const id = cubeId(doc);
    const n = sync.nodes.get(id)!;
    const geo = n.surface!.geometry;
    dirty.length = 0;
    for (let i = 1; i <= 10; i++) doc.updateObject(id, { pos: [i, 0, 0] });
    // rien n'est appliqué avant le flush
    expect(n.root.matrix.elements[12]).toBe(0);
    sync.flush();
    expect(n.root.matrix.elements[12]).toBeCloseTo(10);
    expect(n.surface!.geometry).toBe(geo);
    expect(dirty).toContain('geometry');
  });

  it('propage les transformations aux enfants', () => {
    const doc = SceneDoc.createNew();
    const { sync } = makeSync(doc);
    const parent = cubeId(doc);
    const child = doc.addObject({ type: 'empty', name: 'Enfant', parent, pos: [0, 0, 2] });
    sync.flush();
    doc.updateObject(parent, { pos: [5, 0, 0], scl: [2, 2, 2] });
    sync.flush();
    const m = sync.nodes.get(child)!.root.matrix;
    expect(m.elements[12]).toBeCloseTo(5);
    expect(m.elements[14]).toBeCloseTo(4);
  });

  it('reconstruit seulement le maillage modifié et partage les duplications liées', () => {
    const doc = SceneDoc.createNew();
    const { sync } = makeSync(doc);
    const id = cubeId(doc);
    const linked = doc.duplicateObject(id, { linked: true })!;
    sync.flush();
    const a = sync.nodes.get(id)!;
    const b = sync.nodes.get(linked)!;
    expect(a.surface!.geometry).toBe(b.surface!.geometry);
    const before = a.surface!.geometry;
    const mesh = doc.getMesh(a.obj.data!)!;
    const vid = [...mesh.verts.keys()][0];
    doc.setMeshVerts(a.obj.data!, { [vid]: [3, 3, 3] });
    sync.flush();
    expect(a.surface!.geometry).not.toBe(before);
    expect(a.surface!.geometry).toBe(b.surface!.geometry);
  });

  it('tolère la suppression d’objets et de données à tout moment', () => {
    const doc = SceneDoc.createNew();
    const { sync } = makeSync(doc);
    sync.flush();
    const id = cubeId(doc);
    const meshId = doc.getObject(id)!.data!;
    doc.updateObject(id, { pos: [1, 1, 1] });
    doc.removeMesh(meshId);
    sync.flush();
    expect(sync.nodes.get(id)?.surface ?? null).toBeNull();
    doc.removeObject(id);
    sync.flush();
    expect(sync.nodes.has(id)).toBe(false);
  });

  it('applique visibilité objet + collection', () => {
    const doc = SceneDoc.createNew();
    const { sync } = makeSync(doc);
    const col = doc.addCollection({ name: 'C' });
    const id = cubeId(doc);
    doc.updateObject(id, { collection: col });
    sync.flush();
    expect(sync.nodes.get(id)!.root.visible).toBe(true);
    doc.updateCollection(col, { visible: false });
    sync.flush();
    expect(sync.nodes.get(id)!.root.visible).toBe(false);
  });
});

describe('MeshEvaluator', () => {
  it('met en cache par (maillage, modificateurs) et refuse les booléens circulaires', () => {
    const doc = SceneDoc.createNew();
    const a = cubeId(doc);
    const b = doc.duplicateObject(a)!;
    const ev = new MeshEvaluator(() => doc);
    const r1 = ev.renderMesh(a)!;
    expect(ev.renderMesh(a)).toBe(r1);
    // cycle A → B → A : l'évaluation doit terminer sans lever
    doc.updateObject(a, { modifiers: [{ id: 'm1', type: 'boolean', name: 'B', enabled: true, params: { operation: 'difference', target: b } }] });
    doc.updateObject(b, { modifiers: [{ id: 'm2', type: 'boolean', name: 'B', enabled: true, params: { operation: 'union', target: a } }] });
    expect(() => ev.evaluate(a)).not.toThrow();
    expect(() => ev.evaluate(b)).not.toThrow();
    expect(ev.evaluate(a)).toBeTruthy();
    // auto-référence
    doc.updateObject(a, { modifiers: [{ id: 'm3', type: 'boolean', name: 'B', enabled: true, params: { operation: 'difference', target: a } }] });
    expect(() => ev.evaluate(a)).not.toThrow();
  });

  it('réévalue un booléen quand l’opérande bouge', () => {
    const doc = SceneDoc.createNew();
    const a = cubeId(doc);
    const b = doc.duplicateObject(a)!;
    doc.updateObject(b, { pos: [0.5, 0, 0] });
    const ev = new MeshEvaluator(() => doc);
    doc.updateObject(a, { modifiers: [{ id: 'm1', type: 'boolean', name: 'B', enabled: true, params: { operation: 'difference', target: b } }] });
    const r1 = ev.evaluate(a);
    expect(ev.evaluate(a)).toBe(r1);
    doc.updateObject(b, { pos: [0.7, 0, 0] });
    // la dépendance (matrice de l'opérande) a changé : le résultat n'est plus réutilisé tel quel
    const r2 = ev.evaluate(a);
    expect(r2).toBeTruthy();
    expect(ev.evaluate(a)).toBe(r2);
  });
});

describe('géométrie écran', () => {
  it('segments, rectangles, triangles', () => {
    const r = normRect(10, 10, 0, 0);
    expect(r).toEqual({ x0: 0, y0: 0, x1: 10, y1: 10 });
    expect(segmentIntersectsRect(-5, 5, 15, 5, r)).toBe(true);
    expect(segmentIntersectsRect(-5, -5, -1, 20, r)).toBe(false);
    expect(segmentIntersectsRect(-5, 12, 12, -5, r)).toBe(true);
    expect(distToSegment2D(5, 5, 0, 0, 10, 0).d).toBeCloseTo(5);
    expect(distToSegment2D(5, 5, 0, 0, 10, 0).t).toBeCloseTo(0.5);
    expect(pointInTriangle2D(1, 1, 0, 0, 4, 0, 0, 4)).toBe(true);
    expect(pointInTriangle2D(3, 3, 0, 0, 4, 0, 0, 4)).toBe(false);
  });

  it('projette et découpe les segments derrière la caméra', () => {
    const cam = new PerspectiveCamera(60, 1, 0.1, 100);
    cam.position.set(0, 0, 0);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    const m = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
    const proj = makeProjector(m, 100, 100);
    const out = { x: 0, y: 0, w: 0 };
    expect(proj(0, 0, -5, out)).toBe(true);
    expect(out.x).toBeCloseTo(50);
    expect(out.y).toBeCloseTo(50);
    expect(proj(0, 0, 5, out)).toBe(false);
    const s = projectSegment(m, 100, 100, [0, 0, -5], [0, 0, 5]);
    expect(s).not.toBeNull();
    expect(s![5]).toBeLessThan(1);
    expect(projectSegment(m, 100, 100, [0, 0, 1], [0, 0, 5])).toBeNull();
  });

  it('orientations des vues axiales (Z-up, conventions Blender)', () => {
    const right = (q: ReturnType<typeof axisViewQuaternion>) => new Vector3(1, 0, 0).applyQuaternion(q);
    const fwd = (q: ReturnType<typeof axisViewQuaternion>) => new Vector3(0, 0, -1).applyQuaternion(q);
    expect(fwd(axisViewQuaternion('front')).y).toBeCloseTo(1);
    expect(right(axisViewQuaternion('front')).x).toBeCloseTo(1);
    expect(fwd(axisViewQuaternion('top')).z).toBeCloseTo(-1);
    expect(right(axisViewQuaternion('top')).x).toBeCloseTo(1);
    expect(right(axisViewQuaternion('right')).y).toBeCloseTo(1);
    expect(right(axisViewQuaternion('bottom')).x).toBeCloseTo(1);
  });
});

describe('Picker', () => {
  function setup(state: AppState = initialState()) {
    const doc = SceneDoc.createNew();
    const { sync } = makeSync(doc, state);
    sync.flush();
    const cam = new PerspectiveCamera(40, 1, 0.1, 1000);
    const eye = new Vector3(0, -10, 0);
    cam.position.copy(eye);
    lookQuaternion(eye, new Vector3(), undefined, cam.quaternion);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    const env: PickEnv = { doc, state, camera: cam, width: 400, height: 400, sync, xray: false };
    return { doc, sync, env, picker: new Picker(sync) };
  }

  it('pickObject, pickObjectsInRect et raycastSurface (BVH)', () => {
    const { doc, env, picker } = setup();
    const id = cubeId(doc);
    expect(picker.pickObject(env, 200, 200)).toBe(id);
    expect(picker.pickObject(env, 5, 5)).toBeNull();
    expect(picker.pickObjectsInRect(env, normRect(150, 150, 250, 250))).toContain(id);
    expect(picker.pickObjectsInRect(env, normRect(0, 0, 20, 20))).not.toContain(id);
    // rectangle entièrement à l'intérieur de la face avant
    expect(picker.pickObjectsInRect(env, normRect(198, 198, 202, 202))).toContain(id);
    const hit = picker.raycastSurface(env, 200, 200, false)!;
    expect(hit.objectId).toBe(id);
    expect(hit.point[1]).toBeCloseTo(-1, 3);
    expect(hit.normal[1]).toBeCloseTo(-1, 3);
  });

  it('pickElement / pickElementsInRect avec occultation', () => {
    const doc0 = SceneDoc.createNew();
    const id = cubeId(doc0);
    const state: AppState = { ...initialState(), mode: 'edit', activeId: id, selection: new Set([id]) };
    // on reprend le même document pour garder l'identifiant
    const { sync } = makeSync(doc0, state);
    sync.flush();
    const cam = new PerspectiveCamera(40, 1, 0.1, 1000);
    const eye = new Vector3(4, -6, 5);
    cam.position.copy(eye);
    lookQuaternion(eye, new Vector3(), undefined, cam.quaternion);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    const env: PickEnv = { doc: doc0, state, camera: cam, width: 400, height: 400, sync, xray: false };
    const picker = new Picker(sync);
    const mesh = doc0.getMesh(doc0.getObject(id)!.data!)!;

    const all = picker.pickElementsInRect(env, normRect(0, 0, 400, 400), 'vert');
    // cube vu de trois-quarts : 7 sommets visibles, le sommet opposé est caché
    expect(all.length).toBe(7);
    const hidden = [...mesh.verts.keys()].find((v) => !all.includes(v))!;
    const hp = mesh.verts.get(hidden)!;
    expect(hp[0] < 0 && hp[1] > 0 && hp[2] < 0).toBe(true);
    expect(picker.pickElementsInRect({ ...env, xray: true }, normRect(0, 0, 400, 400), 'vert').length).toBe(8);

    const face = picker.pickElement(env, 200, 200, 'face');
    expect(face?.type).toBe('face');
    expect(mesh.faces.has(face!.id)).toBe(true);

    // sommet le plus proche du pointeur : on vise la projection du sommet (1, -1, 1)
    const target = [...mesh.verts].find(([, p]) => p[0] > 0 && p[1] < 0 && p[2] > 0)![0];
    const p = new Vector3(1, -1, 1).project(cam);
    const sx = (p.x * 0.5 + 0.5) * 400;
    const sy = (0.5 - p.y * 0.5) * 400;
    expect(picker.pickElement(env, sx + 3, sy - 2, 'vert')?.id).toBe(target);
    const edge = picker.pickElement(env, sx + 2, sy + 30, 'edge');
    expect(edge && meshEdges(mesh).has(edge.id)).toBe(true);
  });
});

describe('cage d’édition', () => {
  it('surligne la sélection selon le mode', () => {
    const doc = SceneDoc.createNew();
    const mesh = doc.getMesh(doc.getObject(cubeId(doc))!.data!)!;
    const vids = [...mesh.verts.keys()];
    const fid = [...mesh.faces.keys()][0];
    const tris = { positions: new Float32Array(0), triFace: [] as string[] };
    const a = buildCageArrays(mesh, { verts: new Set([vids[0]]), edges: new Set(), faces: new Set() }, 'vert', tris);
    expect(a.vertPos.length).toBe(24);
    expect(a.edgePos.length).toBe(12 * 6);
    // un seul sommet orange
    let orange = 0;
    for (let i = 0; i < 8; i++) if (a.vertCol[i * 4] > 0.5) orange++;
    expect(orange).toBe(1);
    const f = buildCageArrays(mesh, { verts: new Set(), edges: new Set(), faces: new Set([fid]) }, 'face', tris);
    expect(f.dotPos.length).toBe(18);
    let selEdges = 0;
    for (let i = 0; i < 12; i++) if (f.edgeCol[i * 8] > 0.5) selEdges++;
    expect(selEdges).toBe(4);
  });
});
