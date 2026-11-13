import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import { initialState, setSelection, store } from '../src/app/store';
import { SceneDoc } from '../src/core/doc/SceneDoc';
import { curveKey } from '../src/core/doc/schema';
import type { IViewport } from '../src/engine/api';
import { OperatorRegistry } from '../src/tools/api';
import { registerAnimOps } from '../src/tools/anim';

// ------------------------------------------------------------------ faux contexte (Node, sans DOM ni WebGL)

function makeApp(): AppContext {
  let doc = SceneDoc.createNew();
  const subs = new Set<(d: SceneDoc) => void | (() => void)>();
  const app: any = {
    store,
    get doc() {
      return doc;
    },
    collab: {},
    viewport: { requestRender: () => {} } as Partial<IViewport>,
    setDoc(next: SceneDoc) {
      doc = next;
      subs.forEach((cb) => cb(doc));
    },
    onDocChange(cb: (d: SceneDoc) => void | (() => void)) {
      subs.add(cb);
      const clean = cb(doc);
      return () => {
        subs.delete(cb);
        if (typeof clean === 'function') clean();
      };
    },
  };
  app.ops = new OperatorRegistry(app);
  return app as AppContext;
}

let app: AppContext;
let unbind: () => void;
let cube: string;

beforeEach(() => {
  store.setState(initialState());
  app = makeApp();
  unbind = registerAnimOps(app);
  cube = app.doc.listObjects().find((o) => o.type === 'mesh')!.id;
  setSelection([cube], cube);
});

afterEach(() => unbind());

describe('animation : opérateurs', () => {
  it('I → Position, rotation et échelle : 9 courbes, une seule étape d’annulation', () => {
    expect(app.ops.run('anim.keyframe_insert', { type: 'locrotscale' })).toBe(true);
    expect(app.doc.animCurveKeys(cube).length).toBe(9);
    app.doc.undo();
    expect(app.doc.animCurveKeys(cube).length).toBe(0);
  });

  it('la tête de lecture est locale : ← / → / Maj+→ ne modifient pas le document', () => {
    app.ops.run('anim.keyframe_insert', { type: 'location' });
    let updates = 0;
    app.doc.ydoc.on('update', () => updates++);
    app.ops.run('anim.frame_offset', { delta: 1 });
    expect(store.getState().frame).toBe(2);
    expect(app.doc.animFrame).toBe(2);
    app.ops.run('anim.frame_jump', { end: true });
    expect(store.getState().frame).toBe(250);
    app.ops.run('anim.frame_jump', { end: false });
    expect(store.getState().frame).toBe(1);
    expect(updates).toBe(0);
  });

  it('↑ / ↓ : image clé suivante / précédente', () => {
    for (const f of [1, 15, 40]) {
      app.ops.run('anim.frame_set', { frame: f });
      app.ops.run('anim.keyframe_insert', { type: 'location' });
    }
    app.ops.run('anim.frame_set', { frame: 20 });
    app.ops.run('anim.keyframe_jump', { next: true });
    expect(store.getState().frame).toBe(40);
    app.ops.run('anim.keyframe_jump', { next: false });
    expect(store.getState().frame).toBe(15);
  });

  it('auto-key : déplacer l’objet pose une clé', () => {
    app.ops.run('anim.autokey_toggle');
    expect(store.getState().autoKey).toBe(true);
    app.ops.run('anim.frame_set', { frame: 8 });
    app.doc.updateObject(cube, { pos: [2, 0, 0] });
    expect(app.doc.keyframeAt(cube, 'location', 0, 8)!.value).toBe(2);
  });

  it('Alt+I supprime les clés de l’image courante, clé de propriété par composante', () => {
    app.ops.run('anim.keyframe_insert', { type: 'locrotscale' });
    expect(app.ops.run('anim.property_keyframe_delete', { owner: cube, path: 'scale', index: 2 })).toBe(true);
    expect(app.doc.isAnimated(cube, 'scale', 2)).toBe(false);
    expect(app.ops.run('anim.keyframe_delete')).toBe(true);
    expect(app.doc.isAnimated(cube)).toBe(false);
  });

  it('éditeurs : sélection, interpolation, duplication, suppression', () => {
    app.ops.run('anim.keyframe_insert', { type: 'location' });
    app.ops.run('anim.keys_select_all', { action: 'select' });
    expect(store.getState().keySelection.size).toBe(3);
    app.ops.run('anim.keys_interpolation', { type: 'LINEAR' });
    const ck = curveKey(cube, 'location', 0);
    expect(app.doc.getAnimCurve(ck)!.keys[0].interp).toBe('LINEAR');
    expect(app.ops.run('anim.keys_duplicate', { offset: 10 })).toBe(true);
    expect(app.doc.getAnimCurve(ck)!.keys.map((k) => k.frame)).toEqual([1, 11]);
    app.ops.run('anim.keys_delete');
    expect(app.doc.getAnimCurve(ck)!.keys.map((k) => k.frame)).toEqual([1]);
  });

  it('plage d’images et i/s partagés', () => {
    app.ops.run('anim.set_range', { frameStart: 20, frameEnd: 10, fps: 60 });
    const s = app.doc.getAnimSettings();
    expect(s.fps).toBe(60);
    expect(s.frameStart).toBeLessThanOrEqual(s.frameEnd);
  });
});
