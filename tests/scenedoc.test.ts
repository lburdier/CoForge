import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SceneDoc } from '../src/core/doc/SceneDoc';

/** Relie deux documents comme le ferait le serveur (échange des mises à jour). */
function link(a: SceneDoc, b: SceneDoc): void {
  a.ydoc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') Y.applyUpdate(b.ydoc, u, 'remote');
  });
  b.ydoc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') Y.applyUpdate(a.ydoc, u, 'remote');
  });
  Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc), 'remote');
  Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc), 'remote');
}

describe('SceneDoc', () => {
  it('crée la scène par défaut', () => {
    const doc = SceneDoc.createNew();
    const objs = doc.listObjects();
    expect(objs.map((o) => o.type).sort()).toEqual(['camera', 'light', 'mesh']);
    const cube = objs.find((o) => o.type === 'mesh')!;
    const mesh = doc.getMesh(cube.data!)!;
    expect(mesh.verts.size).toBe(8);
    expect(mesh.faces.size).toBe(6);
    expect(doc.getScene().activeCamera).toBeTruthy();
    expect(doc.canUndo()).toBe(false);
  });

  it('synchronise deux utilisateurs et fusionne les éditions concurrentes', () => {
    const a = SceneDoc.createNew();
    const b = SceneDoc.createEmpty();
    link(a, b);
    expect(b.listObjects().length).toBe(3);
    const cube = a.listObjects().find((o) => o.type === 'mesh')!;
    const [v0, v1] = [...a.getMesh(cube.data!)!.verts.keys()];
    // A déplace un sommet, B un autre et renomme l'objet : tout doit être conservé des deux côtés.
    a.setMeshVerts(cube.data!, { [v0]: [5, 5, 5] });
    b.setMeshVerts(cube.data!, { [v1]: [-5, -5, -5] });
    b.updateObject(cube.id, { name: 'Bloc' });
    a.updateObject(cube.id, { pos: [1, 2, 3] });
    for (const d of [a, b]) {
      const m = d.getMesh(cube.data!)!;
      expect(m.verts.get(v0)).toEqual([5, 5, 5]);
      expect(m.verts.get(v1)).toEqual([-5, -5, -5]);
      expect(d.getObject(cube.id)!.name).toBe('Bloc');
      expect(d.getObject(cube.id)!.pos).toEqual([1, 2, 3]);
    }
  });

  it("n'annule que les actions locales", () => {
    const a = SceneDoc.createNew();
    const b = SceneDoc.createEmpty();
    link(a, b);
    const cube = a.listObjects().find((o) => o.type === 'mesh')!;
    a.beginOp();
    a.updateObject(cube.id, { pos: [1, 0, 0] });
    a.updateObject(cube.id, { pos: [2, 0, 0] });
    a.endOp();
    b.updateObject(cube.id, { name: 'Distant' });
    a.undo();
    expect(a.getObject(cube.id)!.pos).toEqual([0, 0, 0]);
    expect(a.getObject(cube.id)!.name).toBe('Distant');
    expect(b.getObject(cube.id)!.pos).toEqual([0, 0, 0]);
    a.redo();
    expect(b.getObject(cube.id)!.pos).toEqual([2, 0, 0]);
  });

  it('cancelOp défait une opération modale sans laisser de trace', () => {
    const a = SceneDoc.createNew();
    const cube = a.listObjects().find((o) => o.type === 'mesh')!;
    a.beginOp();
    a.updateObject(cube.id, { pos: [9, 9, 9] });
    a.cancelOp();
    expect(a.getObject(cube.id)!.pos).toEqual([0, 0, 0]);
    expect(a.canUndo()).toBe(false);
    expect(a.canRedo()).toBe(false);
  });

  it('ignore les faces dont un sommet a été supprimé par un autre utilisateur', () => {
    const a = SceneDoc.createNew();
    const cube = a.listObjects().find((o) => o.type === 'mesh')!;
    const v0 = [...a.getMesh(cube.data!)!.verts.keys()][0];
    a.applyMeshDelta(cube.data!, { delVerts: [v0] });
    const m = a.getMesh(cube.data!)!;
    expect(m.verts.size).toBe(7);
    expect(m.faces.size).toBe(3);
  });

  it('supprime un objet et son maillage, puis restaure à l’annulation', () => {
    const a = SceneDoc.createNew();
    const cube = a.listObjects().find((o) => o.type === 'mesh')!;
    a.removeObject(cube.id);
    expect(a.getObject(cube.id)).toBeNull();
    expect(a.getMesh(cube.data!)).toBeNull();
    a.undo();
    expect(a.getObject(cube.id)!.name).toBe('Cube');
    expect(a.getMesh(cube.data!)!.faces.size).toBe(6);
  });

  it('sauvegarde et recharge un instantané', () => {
    const a = SceneDoc.createNew('Test');
    const b = SceneDoc.fromUpdate(a.encode());
    expect(b.getScene().name).toBe('Test');
    expect(b.listObjects().length).toBe(3);
  });
});
