import { describe, expect, it } from 'vitest';
import { SceneDoc } from '../src/core/doc/SceneDoc';
import { initialState } from '../src/app/store';
import { SceneSync, type SyncHost } from '../src/engine/sceneSync';

/**
 * Mesure du chemin rapide de SceneSync (scène SANS contrainte) : 1 000 objets.
 * Les durées sont affichées (console) pour comparaison avant / après ; le test ne
 * vérifie que la justesse et une borne très large, pour ne pas dépendre de la machine.
 */

function makeSync(doc: SceneDoc) {
  const state = initialState();
  const host: SyncHost = {
    getDoc: () => doc,
    getState: () => state,
    requestRender: () => {},
    markDirty: () => {},
    drawingSize: () => ({ width: 800, height: 600 }),
  };
  const sync = new SceneSync(host);
  sync.attach(doc);
  return sync;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

describe('SceneSync — performances sans contrainte', () => {
  it('1 000 objets : déplacement de tous, puis d’un parent de 999 enfants', () => {
    const doc = SceneDoc.createNew();
    const cube = doc.listObjects().find((o) => o.type === 'mesh')!.id;
    const ids: string[] = [cube];
    doc.transact(() => {
      for (let i = 1; i < 1000; i++) ids.push(doc.duplicateObject(cube, { linked: true })!);
    });
    const sync = makeSync(doc);
    const t0 = performance.now();
    sync.flush();
    const create = performance.now() - t0;

    // A. tous les objets bougent (indépendants)
    const all: number[] = [];
    for (let k = 1; k <= 30; k++) {
      doc.transact(() => {
        for (let i = 0; i < ids.length; i++) doc.updateObject(ids[i], { pos: [i, k, 0] });
      });
      const t = performance.now();
      sync.flush();
      all.push(performance.now() - t);
    }
    expect(sync.nodes.get(ids[999])!.root.matrix.elements[12]).toBeCloseTo(999);
    expect(sync.nodes.get(ids[999])!.root.matrix.elements[13]).toBeCloseTo(30);

    // B. un parent de 999 enfants bouge
    doc.transact(() => {
      for (let i = 1; i < ids.length; i++) doc.updateObject(ids[i], { parent: cube });
    });
    sync.flush();
    const one: number[] = [];
    for (let k = 1; k <= 30; k++) {
      doc.updateObject(cube, { pos: [0, 0, k] });
      const t = performance.now();
      sync.flush();
      one.push(performance.now() - t);
    }
    expect(sync.nodes.get(ids[999])!.root.matrix.elements[14]).toBeCloseTo(30);

    console.log(
      `[perf] 1000 objets sans contrainte — création ${create.toFixed(1)} ms ; tous déplacés : médiane ${median(all).toFixed(2)} ms ; parent de 999 enfants : médiane ${median(one).toFixed(2)} ms`,
    );
    expect(median(all)).toBeLessThan(2000);
  });
});
