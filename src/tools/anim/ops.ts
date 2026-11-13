import type { AppContext } from '../../app/context';
import { patchRender, setFrame, setKeySelection, store, toast } from '../../app/store';
import type { AnimPath, Easing, HandleType, Interpolation, KeyframeData } from '../../core/doc/schema';
import { animProp } from '../../core/anim/props';
import type { OperatorDef } from '../api';
import { buildChannels, flatCurves, handleTypePatch, selectedKeys, startKeyTransform, visibleCurves, type KeyEditView, type KeyTransformMode } from './keyedit';
import { lastPointer, renderAnimation } from './runtime';

/**
 * Opérateurs d'animation (`anim.*`). Lecture et déplacement de la tête de lecture : jamais
 * d'écriture dans le document (undoable: false). Pose, suppression et édition des clés : une
 * étape d'annulation par geste (registre d'opérateurs).
 */

const OBJ = { modes: ['object' as const] };

function selectedObjects(app: AppContext): string[] {
  return [...store.getState().selection].filter((id) => app.doc.hasObject(id));
}

/** Propriétaires d'animation des objets sélectionnés (objet, lumière / caméra, matériau). */
function selectedOwners(app: AppContext): string[] {
  const set = new Set<string>();
  for (const id of selectedObjects(app)) for (const { owner } of app.doc.objectAnimOwners(id)) set.add(owner);
  return [...set];
}

const INSERT_PATHS: Record<string, AnimPath[]> = {
  location: ['location'],
  rotation: ['rotation_euler'],
  scale: ['scale'],
  locrot: ['location', 'rotation_euler'],
  locscale: ['location', 'scale'],
  rotscale: ['rotation_euler', 'scale'],
  locrotscale: ['location', 'rotation_euler', 'scale'],
  visibility: ['visible'],
};

export const INSERT_KEY_LABELS: Record<string, string> = {
  location: 'Position',
  rotation: 'Rotation',
  scale: 'Échelle',
  locrot: 'Position et rotation',
  locscale: 'Position et échelle',
  rotscale: 'Rotation et échelle',
  locrotscale: 'Position, rotation et échelle',
  visibility: 'Visibilité',
  available: 'Disponibles (courbes existantes)',
};

const hasKeySelection = () => store.getState().keySelection.size > 0 || store.getState().handleSelection.size > 0;

export function animOperators(): OperatorDef[] {
  const ops: OperatorDef[] = [];

  // ---------------------------------------------------------------- lecture (locale)
  ops.push(
    {
      id: 'anim.play',
      label: "Lire l'animation",
      description: 'Lance ou arrête la lecture (args { reverse } : à rebours). Locale : ne modifie pas le document.',
      undoable: false,
      exec(_app, inv) {
        const dir = inv.args.reverse ? -1 : 1;
        const cur = store.getState().playing;
        store.setState({ playing: cur === dir ? 0 : dir });
      },
    },
    {
      id: 'anim.stop',
      label: 'Arrêter la lecture',
      undoable: false,
      poll: () => store.getState().playing !== 0,
      exec() {
        store.setState({ playing: 0 });
      },
    },
    {
      id: 'anim.frame_offset',
      label: "Image suivante / précédente",
      description: 'Avance la tête de lecture de args { delta } images',
      undoable: false,
      defaults: { delta: 1 },
      exec(_app, inv) {
        setFrame(Math.round(store.getState().frame) + (Number(inv.args.delta) || 0));
      },
    },
    {
      id: 'anim.frame_jump',
      label: 'Aller au début / à la fin',
      description: "Tête de lecture à l'image de début (ou de fin avec args { end: true })",
      undoable: false,
      exec(app, inv) {
        const a = app.doc.getAnimSettings();
        setFrame(inv.args.end ? a.frameEnd : a.frameStart);
      },
    },
    {
      id: 'anim.frame_set',
      label: "Aller à l'image",
      undoable: false,
      exec(_app, inv) {
        const f = Number(inv.args.frame);
        if (!Number.isFinite(f)) return false;
        setFrame(f);
      },
    },
    {
      id: 'anim.keyframe_jump',
      label: 'Image clé suivante / précédente',
      description: 'Saute à la clé suivante (args { next: false } : précédente) des objets sélectionnés',
      undoable: false,
      defaults: { next: true },
      exec(app, inv) {
        const owners = selectedOwners(app);
        const frames = app.doc.keyframeFrames(owners.length ? owners : app.doc.animOwners());
        const f = store.getState().frame;
        const target = inv.args.next ? frames.find((x) => x > f + 1e-6) : [...frames].reverse().find((x) => x < f - 1e-6);
        if (target === undefined) {
          toast(inv.args.next ? "Pas d'image clé après" : "Pas d'image clé avant");
          return false;
        }
        setFrame(target);
      },
    },
    {
      id: 'anim.autokey_toggle',
      label: 'Auto-key',
      description: 'Pose automatiquement une clé à chaque modification d’une propriété animable',
      undoable: false,
      exec() {
        store.setState({ autoKey: !store.getState().autoKey });
      },
    },
  );

  // ---------------------------------------------------------------- clés des objets (viewport)
  ops.push(
    {
      id: 'anim.keyframe_insert_menu',
      label: 'Insérer une image clé…',
      description: 'Ouvre le menu « Insérer une image clé » (Position, Rotation, Échelle…)',
      ...OBJ,
      undoable: false,
      poll: (app) => selectedObjects(app).length > 0,
      exec() {
        const p = lastPointer();
        store.setState({ keyframeMenu: { x: p.x, y: p.y } });
      },
    },
    {
      id: 'anim.keyframe_insert',
      label: 'Insérer une image clé',
      description: "Pose des clés à l'image courante sur les objets sélectionnés (args { type: location | rotation | scale | locrotscale | visibility | available })",
      ...OBJ,
      defaults: { type: 'locrotscale' },
      poll: (app) => selectedObjects(app).length > 0,
      exec(app, inv) {
        const doc = app.doc;
        const type = String(inv.args.type ?? 'locrotscale');
        let n = 0;
        doc.transact(() => {
          for (const id of selectedObjects(app)) {
            if (type === 'available') {
              for (const { owner } of doc.objectAnimOwners(id)) {
                for (const ck of doc.animCurveKeys(owner)) {
                  const c = doc.getAnimCurve(ck);
                  if (c) n += doc.keyframeProperty(owner, c.path, { indices: [c.index] }).length;
                }
              }
            } else for (const path of INSERT_PATHS[type] ?? []) n += doc.keyframeProperty(id, path).length;
          }
        });
        if (!n) {
          toast(type === 'available' ? 'Aucune courbe existante à compléter' : 'Aucune clé posée (courbes verrouillées ?)', 'error');
          return false;
        }
        toast(`${n} image${n > 1 ? 's' : ''} clé${n > 1 ? 's' : ''} insérée${n > 1 ? 's' : ''} (${INSERT_KEY_LABELS[type] ?? type})`);
      },
    },
    {
      id: 'anim.keyframe_delete',
      label: "Supprimer les images clés",
      description: "Supprime les clés des objets sélectionnés à l'image courante",
      ...OBJ,
      poll: (app) => selectedOwners(app).some((o) => app.doc.isAnimated(o)),
      exec(app) {
        const f = store.getState().frame;
        let n = 0;
        app.doc.transact(() => {
          for (const o of selectedOwners(app)) n += app.doc.removeKeyframesAt(o, f);
        });
        if (!n) {
          toast("Aucune image clé à l'image courante", 'error');
          return false;
        }
        toast(`${n} image${n > 1 ? 's' : ''} clé${n > 1 ? 's' : ''} supprimée${n > 1 ? 's' : ''}`);
      },
    },
    {
      id: 'anim.keyframe_clear',
      label: "Effacer l'animation",
      description: "Supprime toutes les clés des objets sélectionnés (ils gardent leur valeur à l'image courante)",
      ...OBJ,
      poll: (app) => selectedOwners(app).some((o) => app.doc.isAnimated(o)),
      exec(app) {
        app.doc.transact(() => {
          for (const o of selectedOwners(app)) app.doc.clearAnimation(o);
        });
        setKeySelection([]);
      },
    },
  );

  // ---------------------------------------------------------------- clés d'une propriété (panneaux)
  const propArgs = (inv: { args: Record<string, any> }) => {
    const owner = String(inv.args.owner ?? '');
    const path = String(inv.args.path ?? '') as AnimPath;
    const index = inv.args.index === undefined || inv.args.index === null ? undefined : Number(inv.args.index);
    return { owner, path, index, ok: !!owner && !!animProp(path) };
  };
  ops.push(
    {
      id: 'anim.property_keyframe_insert',
      label: 'Insérer une image clé',
      description: 'Clé sur une propriété (args { owner, path, index? } ; sans index : toutes les composantes)',
      exec(app, inv) {
        const a = propArgs(inv);
        if (!a.ok) return false;
        const ids = app.doc.keyframeProperty(a.owner, a.path, { indices: a.index === undefined ? undefined : [a.index] });
        if (!ids.length) {
          toast('Courbe verrouillée : aucune clé posée', 'error');
          return false;
        }
      },
    },
    {
      id: 'anim.property_keyframe_delete',
      label: "Supprimer l'image clé",
      description: "Supprime la clé de la propriété à l'image courante (args { owner, path, index? })",
      exec(app, inv) {
        const a = propArgs(inv);
        if (!a.ok) return false;
        const ids: string[] = [];
        const def = animProp(a.path)!;
        for (let i = 0; i < def.size; i++) {
          if (a.index !== undefined && a.index !== i) continue;
          const k = app.doc.keyframeAt(a.owner, a.path, i);
          if (k) ids.push(k.id);
        }
        if (!ids.length) return false;
        app.doc.removeKeyframes(ids);
      },
    },
    {
      id: 'anim.property_clear',
      label: "Effacer les images clés",
      description: "Supprime toute l'animation d'une propriété (args { owner, path })",
      exec(app, inv) {
        const a = propArgs(inv);
        if (!a.ok || !app.doc.isAnimated(a.owner, a.path)) return false;
        app.doc.clearAnimation(a.owner, [a.path]);
      },
    },
  );

  // ---------------------------------------------------------------- édition des clés (éditeurs)
  ops.push(
    {
      id: 'anim.keys_select_all',
      label: 'Sélectionner les images clés',
      description: 'args { action: select | deselect | invert | toggle, graph? } (graph : ignore les courbes masquées)',
      undoable: false,
      defaults: { action: 'toggle' },
      exec(app, inv) {
        const s = store.getState();
        const graph = typeof inv.args.graph === 'boolean' ? inv.args.graph : s.animEditor === 'graph';
        const all = visibleCurves(app.doc, { graph }).flatMap((c) => c.keys.map((k) => k.id));
        let action = String(inv.args.action);
        if (action === 'toggle') action = s.keySelection.size || s.handleSelection.size ? 'deselect' : 'select';
        if (action === 'select') setKeySelection(all);
        else if (action === 'deselect') setKeySelection([]);
        else setKeySelection(all.filter((id) => !s.keySelection.has(id)));
      },
    },
    {
      id: 'anim.keys_select_column',
      label: "Sélectionner les clés de l'image courante",
      undoable: false,
      exec(app) {
        const f = store.getState().frame;
        const ids = visibleCurves(app.doc).flatMap((c) => c.keys.filter((k) => Math.abs(k.frame - f) < 0.01).map((k) => k.id));
        setKeySelection(ids);
      },
    },
    {
      id: 'anim.keys_delete',
      label: 'Supprimer les images clés sélectionnées',
      poll: hasKeySelection,
      exec(app) {
        const ids = [...store.getState().keySelection];
        if (!ids.length) return false;
        app.doc.removeKeyframes(ids);
        setKeySelection([]);
      },
    },
    {
      id: 'anim.keys_duplicate',
      label: 'Dupliquer les images clés',
      description: 'Copie les clés sélectionnées décalées de args { offset } images (1 par défaut) et sélectionne les copies',
      poll: hasKeySelection,
      defaults: { offset: 1 },
      exec(app, inv) {
        const doc = app.doc;
        const off = Number(inv.args.offset) || 0;
        const created: string[] = [];
        doc.transact(() => {
          for (const k of selectedKeys(doc)) {
            const id = doc.insertKeyframe({ owner: k.owner, path: k.path, index: k.index, frame: k.frame + off, value: k.value, interp: k.interp, easing: k.easing, hlType: k.hlType, hrType: k.hrType });
            if (id) {
              doc.updateKeyframes([{ id, hl: [k.hl[0] + off, k.hl[1]], hr: [k.hr[0] + off, k.hr[1]] }]);
              created.push(id);
            }
          }
        });
        if (!created.length) return false;
        setKeySelection(created);
      },
    },
    {
      id: 'anim.keys_interpolation',
      label: "Mode d'interpolation",
      description: 'args { type: CONSTANT | LINEAR | BEZIER | SINE | QUAD | CUBIC | QUART | QUINT | EXPO | CIRC | BACK | BOUNCE | ELASTIC }',
      poll: hasKeySelection,
      exec(app, inv) {
        const type = String(inv.args.type) as Interpolation;
        const keys = selectedKeys(app.doc);
        if (!keys.length) return false;
        app.doc.updateKeyframes(keys.map((k) => ({ id: k.id, interp: type })));
      },
    },
    {
      id: 'anim.keys_easing',
      label: 'Atténuation',
      description: 'args { easing: AUTO | EASE_IN | EASE_OUT | EASE_IN_OUT }',
      poll: hasKeySelection,
      exec(app, inv) {
        const easing = String(inv.args.easing) as Easing;
        const keys = selectedKeys(app.doc);
        if (!keys.length) return false;
        app.doc.updateKeyframes(keys.map((k) => ({ id: k.id, easing })));
      },
    },
    {
      id: 'anim.keys_handle_type',
      label: 'Type de poignée',
      description: 'args { type: FREE | ALIGNED | VECTOR | AUTO | AUTO_CLAMPED } pour les clés (ou poignées) sélectionnées',
      poll: hasKeySelection,
      exec(app, inv) {
        const doc = app.doc;
        const type = String(inv.args.type) as HandleType;
        const s = store.getState();
        const patches: (Partial<KeyframeData> & { id: string })[] = [];
        const sides = new Map<string, Set<'l' | 'r'>>();
        for (const id of s.keySelection) sides.set(id, new Set(['l', 'r']));
        for (const h of s.handleSelection) {
          const id = h.slice(0, -2);
          if (!sides.has(id)) sides.set(id, new Set());
          sides.get(id)!.add(h.endsWith(':l') ? 'l' : 'r');
        }
        for (const [id, set] of sides) {
          const k = doc.getKeyframe(id);
          if (!k) continue;
          patches.push(handleTypePatch(doc, k, set.size === 2 ? 'both' : set.has('l') ? 'l' : 'r', type));
        }
        if (!patches.length) return false;
        doc.updateKeyframes(patches);
      },
    },
    {
      id: 'anim.keys_transform',
      label: 'Transformer les images clés',
      description: 'Modal : args { mode: translate | scale | rotate, view: KeyEditView, x, y } (lancé par les éditeurs)',
      poll: hasKeySelection,
      exec(app, inv) {
        const view = inv.args.view as KeyEditView | undefined;
        if (!view) return false;
        const mode = (inv.args.mode ?? 'translate') as KeyTransformMode;
        return startKeyTransform(app, view, mode, { x: Number(inv.args.x) || 0, y: Number(inv.args.y) || 0 }, { release: !!inv.args.release });
      },
    },
    {
      id: 'anim.keys_jump',
      label: 'Aller aux clés sélectionnées',
      description: 'Tête de lecture à la moyenne des clés sélectionnées',
      undoable: false,
      poll: hasKeySelection,
      exec(app) {
        const keys = selectedKeys(app.doc);
        if (!keys.length) return false;
        setFrame(Math.round(keys.reduce((a, k) => a + k.frame, 0) / keys.length));
      },
    },
    {
      id: 'anim.curve_flags',
      label: 'Verrouiller / rendre muette une courbe',
      description: 'args { curve | curves: string[], lock?, mute? } (partagé avec les autres participants)',
      exec(app, inv) {
        const list: string[] = Array.isArray(inv.args.curves) ? inv.args.curves.map(String) : inv.args.curve ? [String(inv.args.curve)] : [];
        const cks = list.filter(Boolean);
        if (!cks.length) return false;
        const patch: { lock?: boolean; mute?: boolean } = {};
        if (typeof inv.args.lock === 'boolean') patch.lock = inv.args.lock;
        if (typeof inv.args.mute === 'boolean') patch.mute = inv.args.mute;
        if (!Object.keys(patch).length) return false;
        app.doc.transact(() => {
          for (const ck of cks) app.doc.setAnimCurveFlags(ck, patch);
        });
      },
    },
    {
      id: 'anim.channels_clear',
      label: 'Effacer les canaux sélectionnés',
      description: 'Supprime les courbes des clés sélectionnées',
      poll: hasKeySelection,
      exec(app) {
        const doc = app.doc;
        const curves = new Set(selectedKeys(doc).map((k) => doc.keyframeCurve(k.id)).filter((c): c is string => !!c));
        const all = flatCurves(buildChannels(doc, false));
        doc.transact(() => {
          for (const c of all) if (curves.has(c.key)) doc.clearAnimation(c.owner, [c.path]);
        });
        setKeySelection([]);
      },
    },
  );

  // ---------------------------------------------------------------- réglages et rendu
  ops.push(
    {
      id: 'anim.set_range',
      label: "Plage d'images",
      description: 'args { frameStart?, frameEnd?, fps? } (partagés)',
      exec(app, inv) {
        const patch: Record<string, number> = {};
        for (const k of ['frameStart', 'frameEnd', 'fps']) if (Number.isFinite(Number(inv.args[k])) && inv.args[k] !== undefined) patch[k] = Number(inv.args[k]);
        if (!Object.keys(patch).length) return false;
        const cur = app.doc.getAnimSettings();
        const start = patch.frameStart ?? cur.frameStart;
        const end = patch.frameEnd ?? cur.frameEnd;
        if (patch.frameStart !== undefined && start > end) patch.frameEnd = start;
        if (patch.frameEnd !== undefined && end < start) patch.frameStart = end;
        app.doc.updateAnimSettings(patch);
      },
    },
    {
      id: 'render.render_animation',
      label: "Rendre l'animation",
      description: "Rend chaque image de la plage (début → fin) avec la caméra active et enregistre une suite d'images numérotées",
      undoable: false,
      poll: () => !store.getState().render.running,
      exec(app) {
        if (!app.doc.getScene().activeCamera) {
          toast('Aucune caméra active dans la scène (Ajouter › Caméra)', 'error');
          return false;
        }
        renderAnimation(app).catch((err) => {
          patchRender({ running: false });
          const msg = (err as Error)?.message ?? String(err);
          if (!/annul/i.test(msg)) toast(`Rendu de l'animation impossible : ${msg}`, 'error');
        });
      },
    },
  );

  return ops;
}

export type { KeyEditView };
