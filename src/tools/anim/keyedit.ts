import type { AppContext } from '../../app/context';
import { store } from '../../app/store';
import type { SceneDoc } from '../../core/doc/SceneDoc';
import { ANIM_FRAME_EPS, type AnimPath, type HandleType, type KeyframeData } from '../../core/doc/schema';
import type { BezPoint } from '../../core/anim/fcurve';
import { channelColor, channelLabel, type AnimOwnerKind } from '../../core/anim/props';
import type { ModalHandler, ModalResult } from '../api';

/**
 * Données et opérations communes aux éditeurs d'animation (frise, feuille d'exposition,
 * éditeur de courbes) : canaux visibles, sélection de clés, transformation modale des clés et
 * poignées. Les éditeurs ne lisent que ce module et SceneDoc ; ils n'écrivent que par les
 * opérateurs (annulables, une étape par geste).
 */

// ------------------------------------------------------------------ canaux

export interface ChannelCurve {
  key: string;
  owner: string;
  path: AnimPath;
  index: number;
  label: string;
  color: string;
  keys: KeyframeData[];
  points: BezPoint[];
  lock: boolean;
  mute: boolean;
}

export interface ChannelOwner {
  owner: string;
  kind: AnimOwnerKind;
  label: string;
  curves: ChannelCurve[];
}

export interface ChannelObject {
  objectId: string;
  name: string;
  owners: ChannelOwner[];
}

const KIND_LABEL: Record<AnimOwnerKind, string> = { object: 'Objet', light: 'Lumière', camera: 'Caméra', material: 'Matériau' };

/** Objets dont les éditeurs montrent l'animation (sélection, ou tous selon `animOnlySelected`). */
export function animatedObjects(doc: SceneDoc, onlySelected = store.getState().animOnlySelected): string[] {
  const s = store.getState();
  const ids = onlySelected ? [...s.selection] : doc.objectIds();
  return ids.filter((id) => doc.hasObject(id));
}

/** Arborescence des canaux : objet → propriétaire (objet, lumière…) → courbes. */
export function buildChannels(doc: SceneDoc, onlySelected?: boolean): ChannelObject[] {
  const out: ChannelObject[] = [];
  const seenOwners = new Set<string>();
  const objs = animatedObjects(doc, onlySelected);
  const names = new Map(objs.map((id) => [id, doc.getObject(id)?.name ?? id]));
  objs.sort((a, b) => names.get(a)!.localeCompare(names.get(b)!));
  for (const id of objs) {
    const owners: ChannelOwner[] = [];
    for (const { owner, kind } of doc.objectAnimOwners(id)) {
      if (seenOwners.has(owner) && kind !== 'object') continue;
      const curves: ChannelCurve[] = [];
      for (const ck of doc.animCurveKeys(owner)) {
        const c = doc.getAnimCurve(ck);
        if (!c) continue;
        curves.push({
          key: ck,
          owner,
          path: c.path,
          index: c.index,
          label: channelLabel(c.path, c.index),
          color: channelColor(c.path, c.index),
          keys: c.keys,
          points: c.points,
          lock: c.flags.lock,
          mute: c.flags.mute,
        });
      }
      if (!curves.length) continue;
      seenOwners.add(owner);
      const label =
        kind === 'object'
          ? KIND_LABEL.object
          : kind === 'material'
            ? `${KIND_LABEL.material} « ${doc.getMaterial(owner)?.name ?? ''} »`
            : KIND_LABEL[kind];
      owners.push({ owner, kind, label, curves });
    }
    if (owners.length) out.push({ objectId: id, name: names.get(id)!, owners });
  }
  return out;
}

export function flatCurves(channels: ChannelObject[]): ChannelCurve[] {
  return channels.flatMap((c) => c.owners.flatMap((o) => o.curves));
}

/** Courbes visibles (et modifiables si `editable`) des éditeurs. */
export function visibleCurves(doc: SceneDoc, opts: { editable?: boolean; graph?: boolean } = {}): ChannelCurve[] {
  const hidden = store.getState().hiddenCurves;
  return flatCurves(buildChannels(doc)).filter((c) => (!opts.graph || !hidden.has(c.key)) && (!opts.editable || !c.lock));
}

// ------------------------------------------------------------------ sélection

export function selectedKeys(doc: SceneDoc): KeyframeData[] {
  const out: KeyframeData[] = [];
  for (const id of store.getState().keySelection) {
    const k = doc.getKeyframe(id);
    if (k) out.push(k);
  }
  return out;
}

/** Nettoie la sélection des clés disparues (supprimées, éventuellement par un autre utilisateur). */
export function pruneKeySelection(doc: SceneDoc): void {
  const s = store.getState();
  const keys = [...s.keySelection].filter((id) => doc.getKeyframe(id));
  const handles = [...s.handleSelection].filter((h) => doc.getKeyframe(h.slice(0, -2)));
  if (keys.length !== s.keySelection.size || handles.length !== s.handleSelection.size) store.setState({ keySelection: new Set(keys), handleSelection: new Set(handles) });
}

/** Poignées effectives (après recalcul) d'une clé, ou null. */
export function keyPoint(doc: SceneDoc, id: string): BezPoint | null {
  const ck = doc.keyframeCurve(id);
  const c = ck ? doc.getAnimCurve(ck) : null;
  return c?.points.find((p) => p.id === id) ?? null;
}

/**
 * Nouveaux types de poignées : FREE / ALIGNED figent les positions affichées (la courbe ne
 * bouge pas au changement de type), comme Blender.
 */
export function handleTypePatch(doc: SceneDoc, k: KeyframeData, side: 'both' | 'l' | 'r', type: HandleType): Partial<KeyframeData> & { id: string } {
  const p = keyPoint(doc, k.id);
  const patch: Partial<KeyframeData> & { id: string } = { id: k.id };
  if (side !== 'r') patch.hlType = type;
  if (side !== 'l') patch.hrType = type;
  if (p) {
    patch.hl = [p.hl[0], p.hl[1]];
    patch.hr = [p.hr[0], p.hr[1]];
  }
  return patch;
}

// ------------------------------------------------------------------ transformation modale

/** Correspondance écran ↔ (image, valeur) fournie par l'éditeur qui lance la transformation. */
export interface KeyEditView {
  kind: 'timeline' | 'dopesheet' | 'graph';
  /** Point écran (clientX, clientY) → (image, valeur affichée). */
  toGraph(x: number, y: number): [number, number];
  /** (image, valeur affichée) → point écran. */
  toClient(f: number, v: number): [number, number];
  /** Valeur affichée = (valeur - offset) × scale (normalisation de l'éditeur de courbes). */
  norm?(curveKey: string): { scale: number; offset: number };
  /** Demande un nouveau dessin (aperçu pendant la transformation). */
  redraw?(): void;
}

export type KeyTransformMode = 'translate' | 'scale' | 'rotate';

interface Elem {
  id: string;
  ck: string;
  /** Ce qui bouge : clé entière (avec ses poignées), poignée gauche ou droite. */
  part: 'key' | 'l' | 'r';
  start: KeyframeData;
  /** Poignées effectives au départ. */
  hl: [number, number];
  hr: [number, number];
  scale: number;
  offset: number;
}

const near = (a: number, b: number) => Math.abs(a - b) < ANIM_FRAME_EPS;

/**
 * Démarre la transformation modale des clés / poignées sélectionnées. Image arrondie à l'entier
 * (Ctrl : désactive l'arrondi) ; X / Y contraignent l'axe (éditeur de courbes) ; Entrée ou clic :
 * valider ; Échap ou clic droit : annuler (le registre défait tout). À la validation, les clés
 * non déplacées recouvertes par une clé déplacée sont supprimées (fusion, comme Blender).
 */
export function startKeyTransform(
  app: AppContext,
  view: KeyEditView,
  mode: KeyTransformMode,
  start: { x: number; y: number },
  opts: { release?: boolean } = {},
): ModalHandler | false {
  const doc = app.doc;
  const s = store.getState();
  const elems: Elem[] = [];
  const graph = view.kind === 'graph';
  const push = (id: string, part: Elem['part']) => {
    const k = doc.getKeyframe(id);
    const ck = doc.keyframeCurve(id);
    if (!k || !ck) return;
    const c = doc.getAnimCurve(ck);
    if (!c || c.flags.lock) return;
    const p = c.points.find((q) => q.id === id);
    const n = view.norm?.(ck) ?? { scale: 1, offset: 0 };
    elems.push({ id, ck, part, start: k, hl: p ? [p.hl[0], p.hl[1]] : [...k.hl], hr: p ? [p.hr[0], p.hr[1]] : [...k.hr], scale: n.scale || 1, offset: n.offset });
  };
  for (const id of s.keySelection) push(id, 'key');
  if (graph) {
    for (const h of s.handleSelection) {
      const id = h.slice(0, -2);
      if (s.keySelection.has(id)) continue;
      push(id, h.endsWith(':l') ? 'l' : 'r');
    }
  }
  if (!elems.length) return false;
  if (!graph && mode === 'rotate') return false;

  // Pivot : image courante (frise / feuille d'exposition), centre de la sélection (courbes).
  let pf = 0;
  let pv = 0;
  if (graph) {
    let n = 0;
    for (const e of elems) {
      const [f, v] = e.part === 'key' ? [e.start.frame, e.start.value] : e.part === 'l' ? e.hl : e.hr;
      pf += f;
      pv += (v - e.offset) * e.scale;
      n++;
    }
    pf /= n;
    pv /= n;
  } else pf = s.frame;
  const [px, py] = view.toClient(pf, pv);
  const [sf, sv] = view.toGraph(start.x, start.y);
  let constraint: 'none' | 'x' | 'y' = 'none';
  let last = { x: start.x, y: start.y, ctrl: false };

  const statusFor = () => {
    const base = mode === 'translate' ? 'Déplacer' : mode === 'scale' ? 'Redimensionner' : 'Tourner';
    const axis = graph ? ` | X / Y : axe${constraint !== 'none' ? ` (${constraint.toUpperCase()})` : ''}` : '';
    return `${base} les images clés${axis} | Ctrl : sans arrondi | Entrée : valider | Échap : annuler`;
  };

  const apply = () => {
    const [cf, cv] = view.toGraph(last.x, last.y);
    let df = cf - sf;
    let dv = cv - sv;
    if (!graph) dv = 0;
    if (constraint === 'x') dv = 0;
    if (constraint === 'y') df = 0;
    if (mode === 'translate' && !last.ctrl && elems.some((e) => e.part === 'key')) df = Math.round(df);
    let factor = 1;
    let angle = 0;
    if (mode === 'scale') {
      const d0 = graph ? Math.hypot(start.x - px, start.y - py) : Math.abs(start.x - px);
      const d1 = graph ? Math.hypot(last.x - px, last.y - py) : last.x - px;
      factor = d0 > 1 ? (graph ? d1 / d0 : d1 / (start.x - px)) : 1;
    } else if (mode === 'rotate') {
      angle = Math.atan2(last.y - py, last.x - px) - Math.atan2(start.y - py, start.x - px);
    }
    // Transformation d'un point affiché (image, valeur affichée).
    const tf = (f: number, v: number): [number, number] => {
      if (mode === 'translate') return [f + df, v + dv];
      if (mode === 'scale') {
        const nf = constraint === 'y' ? f : pf + (f - pf) * factor;
        const nv = !graph || constraint === 'x' ? v : pv + (v - pv) * factor;
        return [nf, nv];
      }
      // rotation en espace écran (sinon l'aspect des axes déforme la rotation)
      const [x, y] = view.toClient(f, v);
      const c = Math.cos(angle);
      const sn = Math.sin(angle);
      const rx = px + (x - px) * c - (y - py) * sn;
      const ry = py + (x - px) * sn + (y - py) * c;
      return view.toGraph(rx, ry);
    };
    const patches: (Partial<KeyframeData> & { id: string })[] = [];
    for (const e of elems) {
      const toDisp = (v: number) => (v - e.offset) * e.scale;
      const fromDisp = (v: number) => v / e.scale + e.offset;
      const k = e.start;
      if (e.part === 'key') {
        let [nf, nv] = tf(k.frame, toDisp(k.value));
        if (mode !== 'translate' && !last.ctrl) nf = Math.round(nf);
        nv = fromDisp(nv);
        const ddf = nf - k.frame;
        const ddv = nv - k.value;
        patches.push({ id: e.id, frame: nf, value: nv, hl: [e.hl[0] + ddf, e.hl[1] + ddv], hr: [e.hr[0] + ddf, e.hr[1] + ddv] });
      } else {
        const own = e.part === 'l' ? e.hl : e.hr;
        const other = e.part === 'l' ? e.hr : e.hl;
        const [nf, nvd] = tf(own[0], toDisp(own[1]));
        const nv = fromDisp(nvd);
        const ownType = e.part === 'l' ? k.hlType : k.hrType;
        const otherType = e.part === 'l' ? k.hrType : k.hlType;
        // Comme Blender : déplacer une poignée automatique la rend alignée, une poignée vecteur la rend libre.
        const newOwnType: HandleType = ownType === 'VECTOR' ? 'FREE' : ownType === 'AUTO' || ownType === 'AUTO_CLAMPED' ? 'ALIGNED' : ownType;
        const newOtherType: HandleType = otherType === 'AUTO' || otherType === 'AUTO_CLAMPED' ? 'ALIGNED' : otherType;
        let o: [number, number] = [other[0], other[1]];
        if (newOwnType === 'ALIGNED' && newOtherType === 'ALIGNED') {
          const len = Math.hypot(other[0] - k.frame, other[1] - k.value);
          const dx = k.frame - nf;
          const dy = k.value - nv;
          const l = Math.hypot(dx, dy);
          if (l > 1e-9) o = [k.frame + (dx / l) * len, k.value + (dy / l) * len];
        }
        // Une poignée reste de son côté de la clé.
        const own2: [number, number] = [e.part === 'l' ? Math.min(nf, k.frame) : Math.max(nf, k.frame), nv];
        const patch: Partial<KeyframeData> & { id: string } = { id: e.id };
        if (e.part === 'l') {
          patch.hl = own2;
          patch.hr = o;
          patch.hlType = newOwnType;
          patch.hrType = newOtherType;
        } else {
          patch.hr = own2;
          patch.hl = o;
          patch.hrType = newOwnType;
          patch.hlType = newOtherType;
        }
        patches.push(patch);
      }
    }
    doc.updateKeyframes(patches);
    view.redraw?.();
  };

  const finish = (): ModalResult => {
    // Fusion : une clé déplacée remplace les clés immobiles qu'elle recouvre sur sa courbe.
    const moved = new Set(elems.filter((e) => e.part === 'key').map((e) => e.id));
    const drop: string[] = [];
    const curves = new Set(elems.filter((e) => e.part === 'key').map((e) => e.ck));
    for (const ck of curves) {
      const c = doc.getAnimCurve(ck);
      if (!c) continue;
      const all = [...c.keys, ...c.shadowed];
      const movedFrames = all.filter((k) => moved.has(k.id)).map((k) => k.frame);
      for (const k of all) if (!moved.has(k.id) && movedFrames.some((f) => near(f, k.frame))) drop.push(k.id);
    }
    if (drop.length) doc.removeKeyframes(drop);
    return 'finished';
  };

  app.ops.setModalStatus(statusFor());
  return {
    status: statusFor(),
    onPointerMove(e) {
      last = { x: e.clientX, y: e.clientY, ctrl: e.ctrlKey || e.metaKey };
      apply();
    },
    onPointerDown(e) {
      if (e.button === 0) return finish();
      if (e.button === 2) return 'cancelled';
    },
    onPointerUp(e) {
      // Glisser-déposer d'une clé (« tweak ») : validé au relâchement.
      if (opts.release && e.button === 0) return finish();
    },
    onKeyDown(e) {
      const k = e.key.toLowerCase();
      if (k === 'escape') return 'cancelled';
      if (k === 'enter' || k === ' ') return finish();
      if (graph && (k === 'x' || k === 'y')) {
        constraint = constraint === k ? 'none' : k;
        app.ops.setModalStatus(statusFor());
        apply();
      }
      if (k === 'control') {
        last = { ...last, ctrl: true };
        apply();
      }
    },
    onKeyUp(e) {
      if (e.key === 'Control') {
        last = { ...last, ctrl: false };
        apply();
      }
    },
    onEnd() {
      view.redraw?.();
    },
  };
}
