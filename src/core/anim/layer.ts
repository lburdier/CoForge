import { ANIM_CURVE_DEFAULTS, curveKey, type AnimCurveFlags, type KeyframeData } from '../doc/schema';
import { buildCurve, evaluatePoints, type CurveEval } from './fcurve';
import { ANIM_PROPS, animProp, writeProp, type AnimOwnerKind, type AnimPropDef, type AnimTarget } from './props';

/**
 * Couche d'animation LOCALE d'un document (aucun accès Yjs : SceneDoc l'alimente).
 *
 *  - index des clés par courbe et par propriétaire, courbes évaluées en cache ;
 *  - valeurs animées à l'image courante de CET utilisateur (`frame`) ;
 *  - valeurs temporaires : propriété animée modifiée sans « auto-key », gardée jusqu'au
 *    prochain changement d'image (comme Blender).
 *
 * Rien de tout cela n'est partagé : chaque utilisateur a sa tête de lecture.
 */

interface CurveEntry {
  raw: Map<string, KeyframeData>;
  eval: CurveEval | null;
}

type Comps = (number | undefined)[];

function sameComps(a: Comps | undefined, b: Comps | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class AnimLayer {
  frame = 1;
  private keys = new Map<string, KeyframeData>();
  private curveOfKey = new Map<string, string>();
  private curves = new Map<string, CurveEntry>();
  private ownerCurves = new Map<string, Set<string>>();
  private flags = new Map<string, AnimCurveFlags>();
  /** propriétaire → champ → composantes animées (undefined = non animée). */
  private overlay = new Map<string, Map<string, Comps>>();
  /** propriétaire → champ → valeur temporaire. */
  private temp = new Map<string, Map<string, unknown>>();

  // ---------------------------------------------------------------- index

  /** Ajoute / remplace (k) ou retire (null) une clé. Renvoie les propriétaires touchés. */
  setKey(id: string, k: KeyframeData | null): string[] {
    const touched: string[] = [];
    const oldCurve = this.curveOfKey.get(id);
    if (oldCurve) {
      const e = this.curves.get(oldCurve);
      if (e) {
        e.raw.delete(id);
        e.eval = null;
        const owner = this.keys.get(id)?.owner;
        if (e.raw.size === 0) {
          this.curves.delete(oldCurve);
          if (owner) {
            const set = this.ownerCurves.get(owner);
            set?.delete(oldCurve);
            if (set && !set.size) this.ownerCurves.delete(owner);
          }
        }
        if (owner) touched.push(owner);
      }
      this.curveOfKey.delete(id);
      this.keys.delete(id);
    }
    if (k && typeof k.owner === 'string' && animProp(k.path)) {
      const key: KeyframeData = { ...k, id, index: Number(k.index) || 0 };
      const ck = curveKey(key.owner, key.path, key.index);
      let e = this.curves.get(ck);
      if (!e) {
        this.curves.set(ck, (e = { raw: new Map(), eval: null }));
        let set = this.ownerCurves.get(key.owner);
        if (!set) this.ownerCurves.set(key.owner, (set = new Set()));
        set.add(ck);
      }
      e.raw.set(id, key);
      e.eval = null;
      this.keys.set(id, key);
      this.curveOfKey.set(id, ck);
      touched.push(key.owner);
    }
    return touched;
  }

  setFlags(ck: string, f: Partial<AnimCurveFlags> | null): void {
    if (!f) this.flags.delete(ck);
    else this.flags.set(ck, { ...ANIM_CURVE_DEFAULTS, ...f });
    const e = this.curves.get(ck);
    if (e) e.eval = null;
  }

  flagsOf(ck: string): AnimCurveFlags {
    return this.flags.get(ck) ?? ANIM_CURVE_DEFAULTS;
  }

  getKey(id: string): KeyframeData | null {
    return this.keys.get(id) ?? null;
  }

  curveOf(id: string): string | null {
    return this.curveOfKey.get(id) ?? null;
  }

  curve(ck: string): CurveEval | null {
    const e = this.curves.get(ck);
    if (!e) return null;
    if (!e.eval) e.eval = buildCurve(e.raw.values(), this.flagsOf(ck).smoothing);
    return e.eval;
  }

  curveKeysOf(owner: string): string[] {
    return [...(this.ownerCurves.get(owner) ?? [])];
  }

  owners(): string[] {
    return [...this.ownerCurves.keys()];
  }

  allCurveKeys(): string[] {
    return [...this.curves.keys()];
  }

  hasAnimation(owner: string): boolean {
    return this.ownerCurves.has(owner);
  }

  /** Composantes animées d'un champ (indices qui ont une courbe non vide). */
  animatedIndices(owner: string, path: string): number[] {
    const out: number[] = [];
    for (const ck of this.ownerCurves.get(owner) ?? []) {
      const [, p, i] = ck.split('|');
      if (p === path) out.push(Number(i));
    }
    return out;
  }

  // ---------------------------------------------------------------- évaluation

  /** Valeur d'une courbe à une image (null si vide ou muette). */
  evaluate(ck: string, frame = this.frame): number | null {
    if (this.flagsOf(ck).mute) return null;
    const c = this.curve(ck);
    return c ? evaluatePoints(c.points, frame) : null;
  }

  /** Recalcule les valeurs animées d'un propriétaire à l'image courante. Renvoie les champs changés. */
  evaluateOwner(owner: string): string[] {
    const next = new Map<string, Comps>();
    for (const ck of this.ownerCurves.get(owner) ?? []) {
      const [, path, idx] = ck.split('|');
      const def = animProp(path);
      if (!def) continue;
      const v = this.evaluate(ck);
      if (v === null) continue;
      let comps = next.get(def.field);
      if (!comps) next.set(def.field, (comps = new Array(def.size).fill(undefined)));
      const i = Number(idx);
      if (i >= 0 && i < def.size) comps[i] = v;
    }
    const prev = this.overlay.get(owner);
    const changed: string[] = [];
    const fields = new Set([...(prev?.keys() ?? []), ...next.keys()]);
    for (const f of fields) if (!sameComps(prev?.get(f), next.get(f))) changed.push(f);
    if (next.size) this.overlay.set(owner, next);
    else this.overlay.delete(owner);
    return changed;
  }

  /** Propriétaires qui ont des valeurs animées ou temporaires. */
  overlaidOwners(): string[] {
    return [...new Set([...this.overlay.keys(), ...this.temp.keys()])];
  }

  /** Applique valeurs animées puis temporaires à un instantané (modifié en place, puis renvoyé). */
  apply<T extends AnimTarget>(owner: string, kind: AnimOwnerKind, data: T, aspect: number): T {
    const ov = this.overlay.get(owner);
    const tmp = this.temp.get(owner);
    if (!ov && !tmp) return data;
    const rec = data as unknown as Record<string, unknown>;
    if (ov) {
      for (const [field, comps] of ov) {
        const def = ANIM_FIELD.get(`${kind}:${field}`);
        if (def) rec[field] = writeProp(def, data, comps, aspect);
      }
    }
    if (tmp) for (const [field, v] of tmp) rec[field] = Array.isArray(v) ? [...v] : v;
    return data;
  }

  // ---------------------------------------------------------------- valeurs temporaires

  setTemp(owner: string, field: string, value: unknown): void {
    let m = this.temp.get(owner);
    if (!m) this.temp.set(owner, (m = new Map()));
    m.set(field, Array.isArray(value) ? [...value] : value);
  }

  /** Retire les valeurs temporaires (d'un propriétaire, ou toutes). Renvoie les propriétaires touchés. */
  clearTemp(owner?: string): string[] {
    if (owner === undefined) {
      const all = [...this.temp.keys()];
      this.temp.clear();
      return all;
    }
    return this.temp.delete(owner) ? [owner] : [];
  }

  hasTemp(owner: string, field?: string): boolean {
    const m = this.temp.get(owner);
    return !!m && (field === undefined || m.has(field));
  }

  snapshotTemp(): Map<string, Map<string, unknown>> {
    return new Map([...this.temp].map(([k, v]) => [k, new Map(v)]));
  }

  restoreTemp(snap: Map<string, Map<string, unknown>>): string[] {
    const touched = new Set([...this.temp.keys(), ...snap.keys()]);
    this.temp = new Map([...snap].map(([k, v]) => [k, new Map(v)]));
    return [...touched];
  }

  clear(): void {
    this.keys.clear();
    this.curveOfKey.clear();
    this.curves.clear();
    this.ownerCurves.clear();
    this.flags.clear();
    this.overlay.clear();
    this.temp.clear();
  }
}

const ANIM_FIELD = new Map<string, AnimPropDef>(ANIM_PROPS.map((d) => [`${d.owner}:${d.field}`, d]));
