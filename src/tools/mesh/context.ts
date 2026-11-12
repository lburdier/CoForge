import { Matrix3, Matrix4, Vector3 } from 'three';
import type { AppContext } from '../../app/context';
import { setEditSelection, toast, type EditSelection, type SelectMode } from '../../app/store';
import type { SceneDoc } from '../../core/doc/SceneDoc';
import { worldMatrix } from '../../core/doc/transforms';
import type { MeshData, ObjectData, Vec3 } from '../../core/doc/schema';
import { expandSelection, selectionToVerts, type SelectionSets } from '../../core/mesh/select';
import { isEmptyDelta } from '../../core/mesh/topology';
import type { MeshOpResult } from '../../core/mesh/types';

/**
 * Utilitaires communs aux opérateurs `mesh.*` (mode édition).
 *
 * Toute lecture passe par `getMeshEditContext`, qui renvoie null dès qu'un maillon
 * manque : un autre utilisateur peut supprimer l'objet ou son maillage à tout instant.
 */

export interface MeshEditContext {
  /** Document lu au moment de la création du contexte (comparer à `app.doc` pour détecter un remplacement). */
  doc: SceneDoc;
  objectId: string;
  object: ObjectData;
  meshId: string;
  /** Instantané (LECTURE SEULE) du maillage au moment de la création du contexte. */
  mesh: MeshData;
  selectMode: SelectMode;
  /** Sélection brute du store. */
  rawSelection: EditSelection;
  /** Sélection complète et cohérente (sommets, arêtes, faces) déduite du mode de sélection, éléments inexistants retirés. */
  selection: SelectionSets;
  /** Matrice monde de l'objet. */
  matrixWorld: Matrix4;
}

/** Contexte d'édition de l'objet actif, ou null (pas en mode édition, objet disparu, pas un maillage…). */
export function getMeshEditContext(app: AppContext): MeshEditContext | null {
  const state = app.store.getState();
  if (state.mode !== 'edit') return null;
  const objectId = state.activeId;
  if (!objectId) return null;
  const doc = app.doc;
  const object = doc.getObject(objectId);
  if (!object || object.type !== 'mesh' || !object.data) return null;
  const mesh = doc.getMesh(object.data);
  if (!mesh) return null;
  const selection = resolveSelection(mesh, state.editSelection, state.selectMode);
  return {
    doc,
    objectId,
    object,
    meshId: object.data,
    mesh,
    selectMode: state.selectMode,
    rawSelection: state.editSelection,
    selection,
    matrixWorld: worldMatrix(doc, objectId),
  };
}

/** Le contexte est-il toujours valable (même document, objet et maillage encore présents) ? */
export function contextAlive(app: AppContext, ctx: MeshEditContext): boolean {
  if (app.doc !== ctx.doc) return false;
  const obj = ctx.doc.getObject(ctx.objectId);
  if (!obj || obj.data !== ctx.meshId) return false;
  return ctx.doc.getMesh(ctx.meshId) !== null;
}

/** Condition de disponibilité commune : mode édition sur un objet maillage valide. */
export function pollMeshEdit(app: AppContext): boolean {
  return getMeshEditContext(app) !== null;
}

function selectionEmpty(s: SelectionSets): boolean {
  return s.verts.size === 0 && s.edges.size === 0 && s.faces.size === 0;
}

/**
 * Sélection complète déduite des éléments du mode courant. Si le mode courant n'a aucun élément
 * sélectionné (sélection faite dans un autre mode), on repart de tous les sommets touchés.
 */
export function resolveSelection(mesh: MeshData, sel: EditSelection, mode: SelectMode): SelectionSets {
  const primary = mode === 'face' ? sel.faces : mode === 'edge' ? sel.edges : sel.verts;
  const out = expandSelection(mesh, primary, mode);
  if (!selectionEmpty(out)) return out;
  const verts = selectionToVerts(mesh, sel, 'vert');
  for (const v of selectionToVerts(mesh, sel, 'edge')) verts.add(v);
  for (const v of selectionToVerts(mesh, sel, 'face')) verts.add(v);
  return expandSelection(mesh, verts, 'vert');
}

/**
 * Sélection cohérente à partir du `select` d'un MeshOpResult : on part des éléments du mode
 * courant s'il y en a, sinon du type le plus « riche » disponible (faces, puis arêtes, puis sommets).
 */
export function coherentSelection(mesh: MeshData, select: { verts: string[]; edges: string[]; faces: string[] }, mode: SelectMode): SelectionSets {
  if (mode === 'face' && select.faces.length) return expandSelection(mesh, select.faces, 'face');
  if (mode === 'edge' && select.edges.length) return expandSelection(mesh, select.edges, 'edge');
  if (mode === 'vert' && select.verts.length) return expandSelection(mesh, select.verts, 'vert');
  if (select.faces.length) return expandSelection(mesh, select.faces, 'face');
  if (select.edges.length) return expandSelection(mesh, select.edges, 'edge');
  return expandSelection(mesh, select.verts, 'vert');
}

/** Retire de la sélection courante les éléments qui n'existent plus, en restant cohérent avec le mode. */
export function pruneSelection(mesh: MeshData, sel: EditSelection, mode: SelectMode): SelectionSets {
  const primary = mode === 'face' ? sel.faces : mode === 'edge' ? sel.edges : sel.verts;
  return expandSelection(mesh, primary, mode);
}

/** Écrit une sélection dans le store (toujours de nouveaux ensembles). */
export function storeSelection(sel: { verts: Iterable<string>; edges: Iterable<string>; faces: Iterable<string> }): void {
  setEditSelection({ verts: new Set(sel.verts), edges: new Set(sel.edges), faces: new Set(sel.faces) });
}

/**
 * Applique un MeshOpResult au maillage du contexte : delta puis sélection cohérente.
 * Renvoie false si le maillage a disparu ou si le delta est vide (rien n'a été fait).
 */
export function applyMeshResult(app: AppContext, ctx: MeshEditContext, result: MeshOpResult): boolean {
  if (!contextAlive(app, ctx)) return false;
  if (isEmptyDelta(result.delta)) return false;
  ctx.doc.applyMeshDelta(ctx.meshId, result.delta);
  const after = ctx.doc.getMesh(ctx.meshId);
  if (!after) return false;
  const mode = app.store.getState().selectMode;
  if (result.select) storeSelection(coherentSelection(after, result.select, mode));
  else storeSelection(pruneSelection(after, app.store.getState().editSelection, mode));
  return true;
}

// ------------------------------------------------------------------ rejeu (« Ajuster la dernière opération »)

let remembered: { opId: string; doc: SceneDoc; objectId: string | null; selection: EditSelection } | null = null;

/**
 * Le panneau « Ajuster la dernière opération » annule l'opération puis la rejoue : le document
 * revient en arrière, mais pas la sélection (locale). On mémorise donc la sélection d'entrée à
 * chaque exécution normale et on la remet en place avant un rejeu.
 */
export function prepareSelectionForRun(app: AppContext, opId: string, redo: boolean): void {
  const st = app.store.getState();
  if (redo && remembered && remembered.opId === opId && remembered.doc === app.doc && remembered.objectId === st.activeId) {
    setEditSelection(remembered.selection);
    return;
  }
  remembered = { opId, doc: app.doc, objectId: st.activeId, selection: st.editSelection };
}

/** Affiche un message d'erreur et renvoie false (raccourci pour `exec`). */
export function fail(message: string): false {
  toast(message, 'error');
  return false;
}

// ------------------------------------------------------------------ conversions local ↔ monde

export function toWorld(ctx: MeshEditContext, p: Vec3): Vector3 {
  return new Vector3(p[0], p[1], p[2]).applyMatrix4(ctx.matrixWorld);
}

export function worldToLocal(ctx: MeshEditContext, p: Vec3): Vec3 {
  const inv = ctx.matrixWorld.clone().invert();
  const v = new Vector3(p[0], p[1], p[2]).applyMatrix4(inv);
  return [v.x, v.y, v.z];
}

/** Direction locale → direction monde unitaire (normale : matrice normale de l'objet). */
export function normalToWorld(ctx: MeshEditContext, n: Vec3): Vec3 {
  const nm = new Matrix3().getNormalMatrix(ctx.matrixWorld);
  const v = new Vector3(n[0], n[1], n[2]).applyMatrix3(nm);
  if (v.lengthSq() < 1e-20) return [0, 0, 1];
  v.normalize();
  return [v.x, v.y, v.z];
}

/** Vecteur local → vecteur monde (partie linéaire de la matrice, longueur conservée selon l'échelle). */
export function vectorToWorld(ctx: MeshEditContext, d: Vec3): Vector3 {
  return new Vector3(d[0], d[1], d[2]).applyMatrix3(new Matrix3().setFromMatrix4(ctx.matrixWorld));
}
