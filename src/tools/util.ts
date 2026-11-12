import { Matrix4, Vector3 } from 'three';
import type { AppContext } from '../app/context';
import { setEditSelection, toast, type EditSelection, type SelectMode } from '../app/store';
import type { SceneDoc } from '../core/doc/SceneDoc';
import { worldMatrix } from '../core/doc/transforms';
import { edgeVerts, type MeshData, type Vec3 } from '../core/doc/schema';

/**
 * Utilitaires communs aux outils de base (sélection, transformations, gizmos,
 * opérateurs objet et vue). Tout accès par identifiant tolère `null` : un autre
 * utilisateur peut supprimer un objet ou un maillage à tout instant.
 */

/** Couleurs des axes (X rouge, Y vert, Z bleu), comme dans Blender. */
export const AXIS_COLORS = ['#ff3352', '#8bdc00', '#2890ff'] as const;
export const AXIS_NAMES = ['X', 'Y', 'Z'] as const;
export const HIGHLIGHT_COLOR = '#ffdd55';

/** Position d'un événement souris relative au canvas du viewport (px CSS). */
export function viewportPos(app: AppContext, e: { clientX: number; clientY: number }): { x: number; y: number } {
  const dom = app.viewport.dom as HTMLCanvasElement | undefined;
  if (dom && typeof dom.getBoundingClientRect === 'function') {
    const r = dom.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  return { x: e.clientX, y: e.clientY };
}

/** Coordonnées canvas → coordonnées fenêtre (clientX/clientY). */
export function viewportToClient(app: AppContext, p: { x: number; y: number }): { x: number; y: number } {
  const dom = app.viewport.dom as HTMLCanvasElement | undefined;
  if (dom && typeof dom.getBoundingClientRect === 'function') {
    const r = dom.getBoundingClientRect();
    return { x: p.x + r.left, y: p.y + r.top };
  }
  return { x: p.x, y: p.y };
}

/** Centre du viewport (px CSS relatifs au canvas). */
export function viewportCenter(app: AppContext): { x: number; y: number } {
  const s = app.viewport.getSize();
  return { x: s.width / 2, y: s.height / 2 };
}

/** L'élément est-il un champ de saisie (où les frappes clavier ne doivent pas être interprétées) ? */
export function isEditableElement(el: EventTarget | Element | null | undefined): boolean {
  if (!el || typeof (el as Element).tagName !== 'string') return false;
  const e = el as HTMLElement;
  const tag = e.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') {
    const type = ((e as HTMLInputElement).type || 'text').toLowerCase();
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(type);
  }
  return e.isContentEditable === true;
}

/** Arrondi d'affichage. */
export function fmt(v: number, digits = 4): string {
  const r = Math.round(v * 10 ** digits) / 10 ** digits;
  return (Object.is(r, -0) ? 0 : r).toString();
}

export function vec3(v: Vector3): Vec3 {
  return [v.x, v.y, v.z];
}

export function v3(p: Vec3): Vector3 {
  return new Vector3(p[0], p[1], p[2]);
}

/** Message d'erreur dans la barre d'état ; renvoie false (raccourci pour `exec`). */
export function fail(message: string): false {
  toast(message, 'error');
  return false;
}

// ------------------------------------------------------------------ sélection d'objets

/** Objets sélectionnés qui existent encore dans le document. */
export function selectedObjects(app: AppContext): string[] {
  const doc = app.doc;
  return [...app.store.getState().selection].filter((id) => doc.hasObject(id));
}

/** Objet actif s'il existe encore. */
export function activeObjectId(app: AppContext): string | null {
  const id = app.store.getState().activeId;
  return id && app.doc.hasObject(id) ? id : null;
}

/** Un ancêtre de `id` fait-il partie de `set` ? */
export function hasAncestorIn(doc: SceneDoc, id: string, set: ReadonlySet<string>): boolean {
  let cur = doc.effectiveParent(id);
  for (let depth = 0; cur && depth < 256; depth++) {
    if (set.has(cur)) return true;
    cur = doc.effectiveParent(cur);
  }
  return false;
}

/** Sélection sans les objets dont un ancêtre est aussi sélectionné (pour ne pas les transformer deux fois). */
export function topLevel(doc: SceneDoc, ids: Iterable<string>): string[] {
  const set = new Set(ids);
  return [...set].filter((id) => doc.hasObject(id) && !hasAncestorIn(doc, id, set));
}

/** Position monde de l'origine d'un objet. */
export function objectWorldPos(doc: SceneDoc, id: string): Vector3 {
  return new Vector3().setFromMatrixPosition(worldMatrix(doc, id));
}

// ------------------------------------------------------------------ mode édition

export interface EditTarget {
  doc: SceneDoc;
  objectId: string;
  meshId: string;
  mesh: MeshData;
  matrixWorld: Matrix4;
}

/** Objet maillage en cours d'édition (mode édition), ou null. */
export function editTarget(app: AppContext): EditTarget | null {
  const s = app.store.getState();
  if (s.mode !== 'edit' || !s.activeId) return null;
  const doc = app.doc;
  const obj = doc.getObject(s.activeId);
  if (!obj || obj.type !== 'mesh' || !obj.data) return null;
  const mesh = doc.getMesh(obj.data);
  if (!mesh) return null;
  return { doc, objectId: obj.id, meshId: obj.data, mesh, matrixWorld: worldMatrix(doc, obj.id) };
}

/** Éléments « principaux » d'une sélection d'édition selon le mode (sommets, arêtes ou faces). */
export function primaryElements(sel: EditSelection, mode: SelectMode): ReadonlySet<string> {
  return mode === 'face' ? sel.faces : mode === 'edge' ? sel.edges : sel.verts;
}

/** Tous les sommets couverts par la sélection d'édition (sommets, extrémités d'arêtes, sommets de faces), existants. */
export function editSelectedVerts(mesh: MeshData, sel: EditSelection): Set<string> {
  const out = new Set<string>();
  for (const v of sel.verts) if (mesh.verts.has(v)) out.add(v);
  for (const k of sel.edges) {
    const [a, b] = edgeVerts(k);
    if (mesh.verts.has(a) && mesh.verts.has(b)) {
      out.add(a);
      out.add(b);
    }
  }
  for (const f of sel.faces) for (const v of mesh.faces.get(f) ?? []) if (mesh.verts.has(v)) out.add(v);
  return out;
}

/** Écrit une sélection d'édition dans le store (toujours de nouveaux ensembles). */
export function storeEditSelection(sel: { verts: Iterable<string>; edges: Iterable<string>; faces: Iterable<string> }): void {
  setEditSelection({ verts: new Set(sel.verts), edges: new Set(sel.edges), faces: new Set(sel.faces) });
}

// ------------------------------------------------------------------ écran

/** Unités monde par pixel écran autour d'un point monde (sert aux tailles constantes à l'écran). */
export function worldUnitsPerPixel(app: AppContext, p: Vector3): number {
  const cam = app.viewport.camera;
  const right = new Vector3(1, 0, 0);
  if (cam && cam.matrixWorld) right.setFromMatrixColumn(cam.matrixWorld, 0);
  if (right.lengthSq() < 1e-12) right.set(1, 0, 0);
  right.normalize();
  const a = app.viewport.worldToScreen(p);
  const b = app.viewport.worldToScreen(p.clone().add(right));
  let ppu = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
  if (!Number.isFinite(ppu) || ppu < 1e-6) ppu = 100;
  return 1 / ppu;
}

/** Direction (monde, unitaire) du point `p` vers l'observateur. */
export function towardViewer(app: AppContext, p: Vector3): Vector3 {
  const cam = app.viewport.camera as any;
  const out = new Vector3();
  if (cam && cam.isPerspectiveCamera && cam.matrixWorld) {
    out.setFromMatrixPosition(cam.matrixWorld).sub(p);
    if (out.lengthSq() > 1e-12) return out.normalize();
  }
  if (cam && cam.matrixWorld) {
    // axe +Z local de la caméra = vers l'observateur
    out.setFromMatrixColumn(cam.matrixWorld, 2);
    if (out.lengthSq() > 1e-12) return out.normalize();
  }
  return out.set(0, 0, 1);
}

/** Distance d'un point à un segment, en 2D. */
export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 1e-12 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
