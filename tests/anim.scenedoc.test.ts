import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SceneDoc } from '../src/core/doc/SceneDoc';
import { curveKey, type KeyframeData } from '../src/core/doc/schema';

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

/** Copie de `a` (même état initial, non reliée). */
function fork(a: SceneDoc): SceneDoc {
  return SceneDoc.fromUpdate(Y.encodeStateAsUpdate(a.ydoc));
}

function cubeOf(doc: SceneDoc): string {
  return doc.listObjects().find((o) => o.type === 'mesh')!.id;
}

const X = (owner: string) => curveKey(owner, 'location', 0);

function key(doc: SceneDoc, owner: string, frame: number, value: number): string {
  doc.beginOp();
  const id = doc.insertKeyframe({ owner, path: 'location', index: 0, frame, value });
  doc.endOp();
  return id!;
}

function curveState(doc: SceneDoc, ck: string): { keys: Pick<KeyframeData, 'id' | 'frame' | 'value'>[]; samples: number[] } {
  const c = doc.getAnimCurve(ck);
  const keys = (c?.keys ?? []).map((k) => ({ id: k.id, frame: k.frame, value: k.value }));
  const samples = [0, 1, 3.5, 7, 10, 12.25, 20, 30].map((f) => doc.evaluateCurve(ck, f) ?? NaN);
  return { keys, samples };
}

describe('animation : SceneDoc', () => {
  it('ancien document sans animation : réglages par défaut, aucune courbe', () => {
    const doc = SceneDoc.createNew();
    expect(doc.getAnimSettings()).toEqual({ frameStart: 1, frameEnd: 250, fps: 24 });
    expect(doc.animOwners()).toEqual([]);
    const cube = cubeOf(doc);
    expect(doc.isAnimated(cube)).toBe(false);
    expect(doc.getObject(cube)!.pos).toEqual([0, 0, 0]);
  });

  it('réglages de scène partagés, image courante locale', () => {
    const a = SceneDoc.createNew();
    const b = SceneDoc.createEmpty();
    link(a, b);
    a.updateAnimSettings({ frameStart: 10, frameEnd: 120, fps: 30 });
    expect(b.getAnimSettings()).toEqual({ frameStart: 10, frameEnd: 120, fps: 30 });
    a.setAnimFrame(42);
    expect(a.animFrame).toBe(42);
    expect(b.animFrame).not.toBe(42);
  });

  it('la scène affichée = valeurs de base + courbes évaluées à l’image locale', () => {
    const doc = SceneDoc.createNew();
    const cube = cubeOf(doc);
    key(doc, cube, 1, 0);
    key(doc, cube, 11, 10);
    doc.updateKeyframes(doc.getAnimCurve(X(cube))!.keys.map((k) => ({ id: k.id, interp: 'LINEAR' as const })));
    doc.setAnimFrame(6);
    expect(doc.getObject(cube)!.pos[0]).toBeCloseTo(5, 6);
    // composantes non animées : valeur de base
    expect(doc.getObject(cube)!.pos[1]).toBe(0);
    doc.setAnimFrame(100);
    expect(doc.getObject(cube)!.pos[0]).toBeCloseTo(10, 6); // extrapolation constante
  });

  it('changer d’image n’écrit rien dans le document partagé', () => {
    const doc = SceneDoc.createNew();
    const cube = cubeOf(doc);
    key(doc, cube, 1, 0);
    key(doc, cube, 20, 4);
    let updates = 0;
    doc.ydoc.on('update', () => updates++);
    for (let f = 1; f <= 30; f++) doc.setAnimFrame(f);
    expect(updates).toBe(0);
    expect(doc.canUndo()).toBe(true);
  });

  it('clés concurrentes sur la même courbe à des images différentes : aucune perte, même résultat', () => {
    const a = SceneDoc.createNew();
    const b = fork(a);
    const cube = cubeOf(a);
    key(a, cube, 1, 0);
    key(a, cube, 20, 5);
    key(b, cube, 10, 8);
    key(b, cube, 30, -2);
    link(a, b);
    const sa = curveState(a, X(cube));
    const sb = curveState(b, X(cube));
    expect(sa.keys.map((k) => k.frame)).toEqual([1, 10, 20, 30]);
    expect(sb).toEqual(sa);
  });

  it('clés concurrentes à la MÊME image : règle de fusion déterministe identique des deux côtés', () => {
    const a = SceneDoc.createNew();
    const b = fork(a);
    const cube = cubeOf(a);
    const ia = key(a, cube, 5, 1);
    const ib = key(b, cube, 5, 2);
    link(a, b);
    const ca = a.getAnimCurve(X(cube))!;
    const cb = b.getAnimCurve(X(cube))!;
    // Une seule clé effective (l'autre est masquée), la même des deux côtés.
    expect(ca.keys.length).toBe(1);
    expect(ca.shadowed.length).toBe(1);
    expect(cb.keys[0].id).toBe(ca.keys[0].id);
    // Gagnante : écriture la plus récente (t), puis identifiant le plus grand.
    const ka = a.getKeyframe(ia)!;
    const kb = a.getKeyframe(ib)!;
    const expected = ka.t !== kb.t ? (ka.t > kb.t ? ia : ib) : ia > ib ? ia : ib;
    expect(ca.keys[0].id).toBe(expected);
    expect(a.evaluateCurve(X(cube), 5)).toBe(b.evaluateCurve(X(cube), 5));
    // Réécrire à cette image remplace la clé effective et supprime le doublon masqué.
    key(b, cube, 5, 3);
    expect(a.getAnimCurve(X(cube))!.shadowed.length).toBe(0);
    expect(a.getAnimCurve(X(cube))!.keys.map((k) => k.value)).toEqual([3]);
    expect(curveState(b, X(cube))).toEqual(curveState(a, X(cube)));
  });

  it('édition simultanée de clés différentes d’une même courbe : chaque clé garde son édition', () => {
    const a = SceneDoc.createNew();
    const b = SceneDoc.createEmpty();
    link(a, b);
    const cube = cubeOf(a);
    const k1 = key(a, cube, 1, 0);
    const k2 = key(a, cube, 10, 1);
    a.updateKeyframes([{ id: k1, value: 7 }]);
    b.updateKeyframes([{ id: k2, interp: 'CONSTANT' }]);
    for (const d of [a, b]) {
      expect(d.getKeyframe(k1)!.value).toBe(7);
      expect(d.getKeyframe(k2)!.interp).toBe('CONSTANT');
    }
  });

  it('annuler : une étape par geste', () => {
    const doc = SceneDoc.createNew();
    const cube = cubeOf(doc);
    doc.beginOp();
    doc.keyframeProperty(cube, 'location');
    doc.keyframeProperty(cube, 'scale');
    doc.endOp();
    expect(doc.animCurveKeys(cube).length).toBe(6);
    doc.undo();
    expect(doc.animCurveKeys(cube).length).toBe(0);
    expect(doc.isAnimated(cube)).toBe(false);
    doc.redo();
    expect(doc.animCurveKeys(cube).length).toBe(6);
  });

  it('sans auto-key : valeur temporaire jusqu’au changement d’image', () => {
    const doc = SceneDoc.createNew();
    const cube = cubeOf(doc);
    doc.setAnimFrame(1);
    key(doc, cube, 1, 0);
    key(doc, cube, 10, 0);
    const before = curveState(doc, X(cube));
    doc.updateObject(cube, { pos: [3, 0, 0] });
    expect(doc.getObject(cube)!.pos[0]).toBe(3);
    expect(doc.hasTempValue(cube, 'location')).toBe(true);
    expect(curveState(doc, X(cube))).toEqual(before);
    doc.setAnimFrame(2);
    expect(doc.hasTempValue(cube, 'location')).toBe(false);
    expect(doc.getObject(cube)!.pos[0]).toBeCloseTo(0, 9);
  });

  it('avec auto-key : modifier une propriété pose une clé à l’image courante', () => {
    const doc = SceneDoc.createNew();
    const cube = cubeOf(doc);
    doc.setAutoKey(true);
    doc.setAnimFrame(12);
    doc.updateObject(cube, { pos: [1, 2, 3] });
    expect(doc.animCurveKeys(cube).filter((ck) => ck.includes('|location|')).length).toBe(3);
    expect(doc.keyframeAt(cube, 'location', 1, 12)!.value).toBe(2);
    doc.setAnimFrame(1);
    expect(doc.getObject(cube)!.pos).toEqual([1, 2, 3]);
    // une seconde modification à la même image met à jour la même clé
    doc.setAnimFrame(12);
    doc.updateObject(cube, { pos: [5, 2, 3] });
    expect(doc.getAnimCurve(X(cube))!.keys.map((k) => k.value)).toEqual([5]);
  });

  it('effacer l’animation garde la valeur courante ; supprimer l’objet supprime ses clés', () => {
    const doc = SceneDoc.createNew();
    const cube = cubeOf(doc);
    key(doc, cube, 1, 0);
    doc.insertKeyframe({ owner: cube, path: 'location', index: 0, frame: 11, value: 10 });
    doc.updateKeyframes(doc.getAnimCurve(X(cube))!.keys.map((k) => ({ id: k.id, interp: 'LINEAR' as const })));
    doc.setAnimFrame(6);
    doc.clearAnimation(cube);
    expect(doc.isAnimated(cube)).toBe(false);
    expect(doc.getObject(cube)!.pos[0]).toBeCloseTo(5, 6);

    key(doc, cube, 1, 0);
    const copy = doc.duplicateObject(cube)!;
    expect(doc.isAnimated(copy, 'location')).toBe(true);
    doc.removeObject(cube);
    expect(doc.animOwners()).toEqual([copy]);
  });

  it('courbe verrouillée : aucune écriture ; courbe muette : n’agit plus', () => {
    const doc = SceneDoc.createNew();
    const cube = cubeOf(doc);
    const id = key(doc, cube, 1, 4);
    doc.setAnimCurveFlags(X(cube), { lock: true });
    expect(doc.insertKeyframe({ owner: cube, path: 'location', index: 0, frame: 5, value: 1 })).toBeNull();
    doc.updateKeyframes([{ id, value: 9 }]);
    expect(doc.getKeyframe(id)!.value).toBe(4);
    doc.setAnimCurveFlags(X(cube), { lock: false, mute: true });
    doc.setAnimFrame(3);
    expect(doc.getObject(cube)!.pos[0]).toBe(0);
  });
});
