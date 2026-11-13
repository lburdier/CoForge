import { Matrix4 } from 'three';
import type { SceneDoc } from '../core/doc/SceneDoc';
import type { BooleanParams, MeshData, ModifierData } from '../core/doc/schema';
import { worldMatrix } from '../core/doc/transforms';
import { evaluateModifiers, triangulate } from '../core/mesh';
import type { ModifierContext, RenderMesh } from '../core/mesh/types';

/**
 * Cache d'évaluation des maillages affichés.
 *
 *  - maillage évalué = `evaluateModifiers(maillage, modificateurs actifs)` ;
 *  - géométrie d'affichage = `triangulate(maillage évalué, ombrage)`.
 *
 * Les clés de cache reposent sur l'IDENTITÉ des instantanés MeshData renvoyés
 * par SceneDoc.getMesh (un nouvel objet est créé à chaque modification) et sur
 * la pile de modificateurs sérialisée. Les piles sans booléen sont partagées
 * entre objets (duplications liées) ; les piles avec booléen dépendent d'un
 * autre objet et de sa transformation : chaque résultat mémorise ses
 * dépendances et est revalidé à la demande.
 *
 * Module PUR (aucun accès WebGL ni DOM) : il tourne sous Node pour les tests.
 */

const MODIFIER_TYPES = new Set(['mirror', 'array', 'bevel', 'subsurf', 'solidify', 'boolean', 'nodes']);

interface Dep {
  id: string;
  /** Maillage évalué de l'opérande au moment du calcul (null : opérande ignoré). */
  mesh: MeshData | null;
  /** Matrice opérande → local (éléments), vide si mesh = null. */
  matrix: number[];
}

interface EvalEntry {
  base: MeshData;
  modsKey: string;
  deps: Dep[];
  result: MeshData;
}

const EMPTY_RENDER_MESH: RenderMesh = {
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  triFace: [],
  edgePositions: new Float32Array(0),
  edgeKeys: [],
};

/** Modificateurs activés et bien formés (une donnée réseau peut être corrompue). */
export function activeModifiers(mods: readonly ModifierData[] | undefined): ModifierData[] {
  if (!Array.isArray(mods)) return [];
  return mods.filter((m) => !!m && typeof m === 'object' && m.enabled !== false && MODIFIER_TYPES.has(m.type) && !!m.params);
}

/**
 * La pile dépend-elle d'autres objets ou de données hors de l'objet ? (booléen, nœuds de géométrie :
 * « Infos d'objet » lit un autre objet, et l'arbre de nœuds vit dans sa propre table)
 */
export function hasExternalDeps(mods: readonly ModifierData[] | undefined): boolean {
  return activeModifiers(mods).some((m) => m.type === 'boolean' || m.type === 'nodes');
}

/** Cibles booléennes actives d'une pile. */
export function booleanTargets(mods: readonly ModifierData[] | undefined): string[] {
  const out: string[] = [];
  for (const m of activeModifiers(mods)) {
    if (m.type !== 'boolean') continue;
    const t = (m.params as BooleanParams).target;
    if (typeof t === 'string' && t) out.push(t);
  }
  return out;
}

function sameMatrix(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class MeshEvaluator {
  private perObject = new Map<string, EvalEntry>();
  private shared = new WeakMap<MeshData, Map<string, MeshData>>();
  private renderCache = new WeakMap<MeshData, Map<string, RenderMesh>>();
  private evaluating = new Set<string>();
  private worldOf: (id: string) => Matrix4;

  /**
   * @param getDoc document courant (relu à chaque appel : il peut être remplacé)
   * @param getWorld matrice monde d'un objet (par défaut recalculée depuis le document)
   */
  constructor(
    private getDoc: () => SceneDoc,
    getWorld?: (id: string) => Matrix4,
  ) {
    this.worldOf = getWorld ?? ((id) => worldMatrix(this.getDoc(), id));
  }

  /** Oublie tout (changement de document). */
  clear(): void {
    this.perObject.clear();
    this.shared = new WeakMap();
    this.renderCache = new WeakMap();
    this.evaluating.clear();
  }

  /** Oublie le résultat mémorisé d'un objet (objet supprimé). */
  forget(id: string): void {
    this.perObject.delete(id);
  }

  /** Ne conserve que les entrées des objets listés. */
  retain(ids: Set<string>): void {
    for (const id of [...this.perObject.keys()]) if (!ids.has(id)) this.perObject.delete(id);
  }

  /** L'objet a-t-il un modificateur booléen actif ? */
  hasBoolean(id: string): boolean {
    const obj = this.getDoc().getObject(id);
    return !!obj && booleanTargets(obj.modifiers).length > 0;
  }

  /**
   * L'objet `from` peut-il être atteint en suivant les cibles booléennes depuis
   * `start` ? (sert à refuser les dépendances circulaires, de façon symétrique
   * et indépendante de l'ordre d'évaluation).
   */
  private reaches(start: string, from: string): boolean {
    const doc = this.getDoc();
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === from) return true;
      if (seen.has(cur) || seen.size > 4096) continue;
      seen.add(cur);
      const o = doc.getObject(cur);
      if (o && o.type === 'mesh') stack.push(...booleanTargets(o.modifiers));
    }
    return false;
  }

  /** État courant d'un opérande booléen vu depuis l'objet `owner`. */
  private operandState(owner: string, target: string): { mesh: MeshData; toLocal: Matrix4 } | null {
    if (!target || target === owner) return null;
    if (this.reaches(target, owner)) return null;
    if (this.evaluating.has(target)) return null;
    const doc = this.getDoc();
    const t = doc.getObject(target);
    if (!t || t.type !== 'mesh') return null;
    const mesh = this.evaluate(target);
    if (!mesh) return null;
    const toLocal = this.worldOf(owner).clone().invert().multiply(this.worldOf(target));
    return { mesh, toLocal };
  }

  private depsValid(owner: string, deps: Dep[]): boolean {
    for (const d of deps) {
      const cur = this.operandState(owner, d.id);
      if (!cur) {
        if (d.mesh !== null) return false;
        continue;
      }
      if (cur.mesh !== d.mesh) return false;
      if (!sameMatrix(cur.toLocal.elements, d.matrix)) return false;
    }
    return true;
  }

  private safeEvaluate(base: MeshData, mods: ModifierData[], ctx: ModifierContext): MeshData {
    try {
      const out = evaluateModifiers(base, mods, ctx);
      return out && out.verts instanceof Map && out.faces instanceof Map ? out : base;
    } catch (err) {
      console.error('[engine] échec de l\'évaluation des modificateurs', err);
      return base;
    }
  }

  /**
   * Maillage ÉVALUÉ d'un objet maillage (coordonnées locales), ou null si
   * l'objet n'existe pas, n'est pas un maillage ou n'a pas de données.
   */
  evaluate(id: string): MeshData | null {
    const doc = this.getDoc();
    const obj = doc.getObject(id);
    if (!obj || obj.type !== 'mesh' || !obj.data) return null;
    const base = doc.getMesh(obj.data);
    if (!base) return null;
    const mods = activeModifiers(obj.modifiers);
    if (mods.length === 0) {
      this.perObject.delete(id);
      return base;
    }
    let modsKey: string;
    try {
      // ni l'identifiant ni le nom n'influent sur le résultat : deux duplications liées partagent le cache
      // nœuds de géométrie : le contenu de l'arbre fait partie de la clé (il change sans toucher l'objet)
      modsKey = JSON.stringify(
        mods.map((m) => {
          if (m.type !== 'nodes') return [m.type, m.params];
          const tid = (m.params as { tree?: unknown }).tree;
          const t = typeof tid === 'string' && tid ? doc.getNodeTree(tid) : null;
          return [m.type, m.params, t ? [t.kind, t.nodes, t.links] : null];
        }),
      );
    } catch {
      modsKey = String(Math.random());
    }
    const hasBool = mods.some((m) => m.type === 'boolean' || m.type === 'nodes');
    const getNodeTree = (tid: string) => doc.getNodeTree(tid);
    const nullCtx: ModifierContext = { getOperand: () => null, getNodeTree };

    if (!hasBool) {
      this.perObject.delete(id);
      let byKey = this.shared.get(base);
      if (!byKey) this.shared.set(base, (byKey = new Map()));
      const hit = byKey.get(modsKey);
      if (hit) return hit;
      const result = this.safeEvaluate(base, mods, nullCtx);
      byKey.set(modsKey, result);
      return result;
    }

    if (this.evaluating.has(id)) return base;
    this.evaluating.add(id);
    try {
      const entry = this.perObject.get(id);
      if (entry && entry.base === base && entry.modsKey === modsKey && this.depsValid(id, entry.deps)) return entry.result;
      const deps: Dep[] = [];
      const ctx: ModifierContext = {
        getOperand: (target: string) => {
          const st = this.operandState(id, target);
          deps.push(st ? { id: target, mesh: st.mesh, matrix: [...st.toLocal.elements] } : { id: target, mesh: null, matrix: [] });
          return st;
        },
        getNodeTree,
      };
      const result = this.safeEvaluate(base, mods, ctx);
      this.perObject.set(id, { base, modsKey, deps, result });
      return result;
    } finally {
      this.evaluating.delete(id);
    }
  }

  /** Géométrie d'affichage d'un maillage quelconque, en cache par (maillage, ombrage). */
  renderMeshOf(mesh: MeshData, smooth: boolean, autoSmoothAngle: number): RenderMesh {
    const key = smooth ? `s${autoSmoothAngle}` : 'f';
    let byKey = this.renderCache.get(mesh);
    if (!byKey) this.renderCache.set(mesh, (byKey = new Map()));
    const hit = byKey.get(key);
    if (hit) return hit;
    let rm: RenderMesh;
    try {
      rm = triangulate(mesh, { smooth, autoSmoothAngle });
    } catch (err) {
      console.error('[engine] échec de la triangulation', err);
      rm = EMPTY_RENDER_MESH;
    }
    byKey.set(key, rm);
    return rm;
  }

  /** Géométrie d'affichage d'un objet (modificateurs appliqués), ou null. */
  renderMesh(id: string): RenderMesh | null {
    const obj = this.getDoc().getObject(id);
    if (!obj) return null;
    const mesh = this.evaluate(id);
    if (!mesh) return null;
    const angle = Number.isFinite(obj.autoSmoothAngle) ? obj.autoSmoothAngle : 30;
    return this.renderMeshOf(mesh, !!obj.shadeSmooth, angle);
  }
}
