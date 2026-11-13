import { getApp } from '../../app/context';
import { newId } from '../../core/ids';
import {
  MODIFIER_DEFAULTS,
  MODIFIER_LABELS,
  type MeshData,
  type ModifierData,
  type ModifierType,
  type ObjectData,
} from '../../core/doc/schema';
import type { SceneDoc } from '../../core/doc/SceneDoc';
import { decompose, worldMatrix } from '../../core/doc/transforms';
import { evaluateModifiers, type ModifierContext } from '../../core/mesh';
import { Matrix4 } from 'three';
import { toast } from '../../app/store';
import { withOp } from '../lib/util';
import { defaultGeometryTree } from '../../core/nodes/geometryNodes';

/**
 * Lance un opérateur du registre. S'il n'est pas (encore) enregistré, la
 * solution de repli `fallback` est exécutée comme UNE étape d'annulation.
 * Si l'opérateur démarre une opération modale (ex. une duplication suivie d'un
 * déplacement à la souris), elle est validée immédiatement : depuis un panneau,
 * il n'y a pas de pointeur dans le viewport pour la piloter.
 * Renvoie true si quelque chose a été exécuté.
 */
export function runOp(id: string, args: Record<string, any> = {}, fallback?: (doc: SceneDoc) => void): boolean {
  const app = getApp();
  if (app.ops.get(id)) {
    const ok = app.ops.run(id, args);
    if (app.ops.modalActive) app.ops.endModal(true);
    return ok;
  }
  if (!fallback) return false;
  withOp(fallback);
  app.viewport?.requestRender();
  return true;
}

/** L'opérateur est-il utilisable, ou au moins remplaçable par une solution de repli ? */
export function opAvailable(id: string, hasFallback: boolean): boolean {
  const ops = getApp().ops;
  if (ops.get(id)) return ops.canRun(id);
  return hasFallback;
}

// ------------------------------------------------------------------ modificateurs

function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Nom unique d'un nouveau modificateur dans la pile (« Miroir », « Miroir.001 »…). */
export function uniqueModifierName(mods: ModifierData[], base: string): string {
  const names = new Set(mods.map((m) => m.name));
  if (!names.has(base)) return base;
  for (let i = 1; i < 1000; i++) {
    const n = `${base}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
  return `${base}.${newId(4)}`;
}

export function makeModifier(type: ModifierType, existing: ModifierData[]): ModifierData {
  return {
    id: newId(8),
    type,
    name: uniqueModifierName(existing, MODIFIER_LABELS[type]),
    enabled: true,
    params: cloneJson(MODIFIER_DEFAULTS[type]),
  } as ModifierData;
}

/**
 * Remplace un modificateur de l'objet en relisant l'état COURANT du document
 * (pas un instantané périmé du rendu) : indispensable pendant un glissement
 * continu ou quand un autre utilisateur édite la même pile.
 */
export function patchModifier(objectId: string, modifierId: string, fn: (m: ModifierData) => ModifierData): void {
  const doc = getApp().doc;
  const obj = doc.getObject(objectId);
  if (!obj) return;
  const idx = obj.modifiers.findIndex((m) => m.id === modifierId);
  if (idx < 0) return;
  const next = obj.modifiers.map((m) => cloneJson(m));
  next[idx] = fn(next[idx]);
  doc.updateObject(objectId, { modifiers: next });
}

/** Modifie un paramètre d'un modificateur. */
export function setModifierParam(objectId: string, modifierId: string, key: string, value: unknown): void {
  patchModifier(objectId, modifierId, (m) => ({ ...m, params: { ...(m.params as any), [key]: value } }));
}

export function addModifier(obj: ObjectData, type: ModifierType): void {
  runOp('object.modifier_add', { type }, (doc) => {
    const cur = doc.getObject(obj.id);
    if (!cur) return;
    doc.updateObject(obj.id, { modifiers: [...cur.modifiers.map(cloneJson), makeModifier(type, cur.modifiers)] });
  });
}

export function removeModifier(obj: ObjectData, modifierId: string): void {
  runOp('object.modifier_remove', { modifierId }, (doc) => {
    const cur = doc.getObject(obj.id);
    if (!cur) return;
    doc.updateObject(obj.id, { modifiers: cur.modifiers.filter((m) => m.id !== modifierId).map(cloneJson) });
  });
}

/**
 * Applique un modificateur au maillage (et ceux situés au-dessus de lui d'abord), puis les retire
 * de la pile. Passe par l'opérateur `object.modifier_apply` s'il est enregistré ; sinon le calcul
 * est fait ici avec `evaluateModifiers`. Un maillage partagé par plusieurs objets n'est pas
 * modifié : l'objet reçoit une copie (comme le ferait une application sur une instance liée).
 */
export function applyModifier(obj: ObjectData, modifierId: string): void {
  const objectId = obj.id;
  runOp('object.modifier_apply', { modifierId }, (doc) => {
    const cur = doc.getObject(objectId);
    if (!cur || cur.type !== 'mesh' || !cur.data) return;
    const idx = cur.modifiers.findIndex((m) => m.id === modifierId);
    if (idx < 0) return;
    if (!cur.modifiers[idx].enabled) {
      toast('Modificateur désactivé : activez-le avant de l’appliquer', 'error');
      return;
    }
    const mesh = doc.getMesh(cur.data);
    if (!mesh) return;
    const result = evaluateModifiers(mesh, cur.modifiers.slice(0, idx + 1).map(cloneJson), operandContext(doc, objectId));
    const rest = cur.modifiers.slice(idx + 1).map(cloneJson);
    const users = doc.listObjects().filter((o) => o.type === 'mesh' && o.data === cur.data).length;
    if (users > 1) {
      const copy = doc.createMesh(result, doc.getMeshName(cur.data));
      doc.updateObject(objectId, { data: copy, modifiers: rest });
    } else {
      doc.replaceMesh(cur.data, result);
      doc.updateObject(objectId, { modifiers: rest });
    }
  });
}

/** Contexte d'évaluation : opérandes booléens évalués (avec leurs propres modificateurs), sans récursion infinie. */
function operandContext(doc: SceneDoc, selfId: string): ModifierContext {
  const selfInv = worldMatrix(doc, selfId).invert();
  const visiting = new Set<string>([selfId]);
  const ctx: ModifierContext = {
    getOperand(id: string): { mesh: MeshData; toLocal: Matrix4 } | null {
      if (visiting.has(id)) return null;
      const o = doc.getObject(id);
      if (!o || o.type !== 'mesh' || !o.data) return null;
      const m = doc.getMesh(o.data);
      if (!m) return null;
      visiting.add(id);
      let evaluated: MeshData;
      try {
        evaluated = evaluateModifiers(m, o.modifiers, ctx);
      } finally {
        visiting.delete(id);
      }
      return { mesh: evaluated, toLocal: selfInv.clone().multiply(worldMatrix(doc, id)) };
    },
    getNodeTree: (treeId) => doc.getNodeTree(treeId),
  };
  return ctx;
}

export function moveModifier(obj: ObjectData, modifierId: string, direction: -1 | 1): void {
  runOp('object.modifier_move', { modifierId, direction }, (doc) => {
    const cur = doc.getObject(obj.id);
    if (!cur) return;
    const mods = cur.modifiers.map(cloneJson);
    const i = mods.findIndex((m) => m.id === modifierId);
    const j = i + direction;
    if (i < 0 || j < 0 || j >= mods.length) return;
    [mods[i], mods[j]] = [mods[j], mods[i]];
    doc.updateObject(obj.id, { modifiers: mods });
  });
}

// ------------------------------------------------------------------ parentage

/** `candidate` est-il `ancestor` lui-même ou l'un de ses descendants ? (hiérarchie effective, sans cycle) */
export function isSelfOrDescendant(doc: SceneDoc, candidate: string | null, ancestor: string): boolean {
  let cur: string | null = candidate;
  for (let depth = 0; cur && depth < 256; depth++) {
    if (cur === ancestor) return true;
    cur = doc.effectiveParent(cur);
  }
  return false;
}

/**
 * Change le parent de plusieurs objets en conservant leur transformation MONDE.
 *
 * Toutes les matrices sont calculées AVANT la moindre écriture : les
 * instantanés de SceneDoc (getObject, effectiveParent) restent en cache jusqu'à
 * la fin de la transaction, si bien qu'une lecture après écriture dans la même
 * transaction verrait l'ancien parent. Les objets dont un ancêtre fait aussi
 * partie de la liste gardent leur parent (la sous-hiérarchie est conservée).
 * Les objets qui créeraient une boucle, ou disparus, sont ignorés.
 * À appeler dans une opération (withOp) pour obtenir une seule étape d'annulation.
 * Renvoie le nombre d'objets effectivement reparentés et le nombre de refus.
 */
export function reparentKeepWorld(doc: SceneDoc, ids: string[], parent: string | null): { done: number; refused: number } {
  if (parent && !doc.getObject(parent)) return { done: 0, refused: ids.length };
  const set = new Set(ids.filter((id) => doc.getObject(id)));
  const parentWorld = parent ? worldMatrix(doc, parent).clone().invert() : new Matrix4();
  const writes: { id: string; local: ReturnType<typeof decompose> }[] = [];
  let refused = 0;
  for (const id of set) {
    // Un ancêtre est aussi déplacé : on garde la relation existante.
    let anc = doc.effectiveParent(id);
    let skip = false;
    for (let depth = 0; anc && depth < 256; depth++) {
      if (set.has(anc)) {
        skip = true;
        break;
      }
      anc = doc.effectiveParent(anc);
    }
    if (skip) continue;
    if (parent && isSelfOrDescendant(doc, parent, id)) {
      refused++;
      continue;
    }
    if (doc.effectiveParent(id) === parent) continue;
    const local = parentWorld.clone().multiply(worldMatrix(doc, id));
    writes.push({ id, local: decompose(local) });
  }
  if (writes.length) {
    doc.transact(() => {
      for (const w of writes) doc.updateObject(w.id, { parent, ...w.local });
    });
  }
  return { done: writes.length, refused };
}

/**
 * Nœuds de géométrie : crée un arbre neuf (Entrée → Sortie du groupe) et l'affecte au modificateur
 * `modifierId`, ou à un nouveau modificateur « Nœuds de géométrie » ajouté en fin de pile.
 * Une seule étape d'annulation. Renvoie l'identifiant de l'arbre.
 */
export function newGeometryNodes(objectId: string, modifierId?: string | null): string | null {
  let treeId: string | null = null;
  withOp((doc) => {
    const cur = doc.getObject(objectId);
    if (!cur || cur.type !== 'mesh') return;
    treeId = doc.addNodeTree({ kind: 'geometry', name: 'Nœuds de géométrie', ...defaultGeometryTree() });
    const mods = cur.modifiers.map(cloneJson);
    const i = modifierId ? mods.findIndex((m) => m.id === modifierId) : -1;
    if (i >= 0) mods[i] = { ...mods[i], params: { ...(mods[i].params as object), tree: treeId } } as ModifierData;
    else mods.push({ ...makeModifier('nodes', cur.modifiers), params: { tree: treeId } } as ModifierData);
    doc.updateObject(objectId, { modifiers: mods });
  });
  getApp().viewport?.requestRender();
  return treeId;
}
