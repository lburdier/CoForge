import { Vector3 } from 'three';
import type { AppContext } from '../app/context';
import { EMPTY_EDIT_SELECTION, setSelection, store, type SelectMode } from '../app/store';
import { edgeKey, edgeVerts } from '../core/doc/schema';
import { edgeLoop, expandSelection, faceLoop } from '../core/mesh/select';
import { buildTopology } from '../core/mesh/topology';
import type { OperatorDef } from './api';
import { distToSegment, editSelectedVerts, editTarget, primaryElements, storeEditSelection, v3, type EditTarget } from './util';

/**
 * Sélection au clic et au rectangle, en mode objet et en mode édition.
 *   clic          remplace la sélection (dans le vide : désélectionne tout)
 *   Maj+clic      ajoute / bascule
 *   Ctrl+clic     retire
 *   Alt+clic      boucle d'arêtes (sommets/arêtes) ou boucle de faces (faces) — mode édition
 * La sélection d'édition est toujours gardée cohérente (sommets, arêtes, faces) via expandSelection.
 */

export type SelectAction = 'set' | 'extend' | 'subtract';

/** Action de sélection d'après les modificateurs (Maj = étendre, Ctrl = retirer). */
export function selectActionOf(e: { shiftKey: boolean; ctrlKey: boolean; metaKey?: boolean }): SelectAction {
  if (e.ctrlKey || e.metaKey) return 'subtract';
  if (e.shiftKey) return 'extend';
  return 'set';
}

// ------------------------------------------------------------------ mode objet

/** Clic de sélection en mode objet. */
export function clickSelectObject(app: AppContext, x: number, y: number, action: SelectAction): void {
  const s = store.getState();
  const id = app.viewport.pickObject(x, y);
  if (!id || !app.doc.hasObject(id)) {
    if (action === 'set') setSelection([], null);
    return;
  }
  const sel = new Set([...s.selection].filter((o) => app.doc.hasObject(o)));
  if (action === 'set') {
    setSelection([id], id);
  } else if (action === 'extend') {
    if (sel.has(id)) {
      if (s.activeId === id) {
        sel.delete(id);
        setSelection(sel, [...sel].pop() ?? null);
      } else setSelection(sel, id);
    } else {
      sel.add(id);
      setSelection(sel, id);
    }
  } else {
    sel.delete(id);
    setSelection(sel, s.activeId === id ? ([...sel].pop() ?? null) : s.activeId);
  }
}

/** Rectangle de sélection en mode objet (coordonnées canvas). */
export function boxSelectObjects(app: AppContext, x0: number, y0: number, x1: number, y1: number, action: SelectAction): void {
  const s = store.getState();
  const hits = app.viewport.pickObjectsInRect(Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)).filter((id) => app.doc.hasObject(id));
  let next: Set<string>;
  if (action === 'set') next = new Set(hits);
  else {
    next = new Set([...s.selection].filter((id) => app.doc.hasObject(id)));
    for (const id of hits) {
      if (action === 'extend') next.add(id);
      else next.delete(id);
    }
  }
  const active = s.activeId && next.has(s.activeId) ? s.activeId : action === 'extend' && hits.length ? hits[hits.length - 1] : ([...next][0] ?? null);
  setSelection(next, active);
}

// ------------------------------------------------------------------ mode édition

function combine(current: Iterable<string>, hits: Iterable<string>, action: SelectAction, toggle: boolean): Set<string> {
  if (action === 'set') return new Set(hits);
  const out = new Set(current);
  for (const h of hits) {
    if (action === 'subtract') out.delete(h);
    else if (toggle && out.has(h)) out.delete(h);
    else out.add(h);
  }
  return out;
}

/** Éléments principaux existants du mode courant. */
function currentPrimary(t: EditTarget, mode: SelectMode): Set<string> {
  const sel = store.getState().editSelection;
  const out = new Set<string>();
  for (const id of primaryElements(sel, mode)) {
    if (mode === 'vert' ? t.mesh.verts.has(id) : mode === 'face' ? t.mesh.faces.has(id) : edgeExists(t, id)) out.add(id);
  }
  return out;
}

function edgeExists(t: EditTarget, key: string): boolean {
  const [a, b] = edgeVerts(key);
  return t.mesh.verts.has(a) && t.mesh.verts.has(b);
}

function writeSelection(t: EditTarget, primary: Iterable<string>, mode: SelectMode): void {
  storeEditSelection(expandSelection(t.mesh, primary, mode));
}

/** Arête d'une face la plus proche du pointeur, à l'écran. */
function nearestEdgeOfFace(app: AppContext, t: EditTarget, faceId: string, x: number, y: number): string | null {
  const loop = t.mesh.faces.get(faceId);
  if (!loop) return null;
  const pts = loop.map((v) => {
    const p = t.mesh.verts.get(v);
    return p ? app.viewport.worldToScreen(v3(p).applyMatrix4(t.matrixWorld)) : null;
  });
  let best: string | null = null;
  let bestD = Infinity;
  for (let i = 0; i < loop.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % loop.length];
    if (!a || !b) continue;
    const d = distToSegment(x, y, a.x, a.y, b.x, b.y);
    if (d < bestD) {
      bestD = d;
      best = edgeKey(loop[i], loop[(i + 1) % loop.length]);
    }
  }
  return best;
}

/** Arête visée par un Alt+clic. */
function pickLoopEdge(app: AppContext, t: EditTarget, x: number, y: number, mode: SelectMode): string | null {
  if (mode !== 'face') {
    const e = app.viewport.pickElement(x, y, 'edge');
    if (e && edgeExists(t, e.id)) return e.id;
  }
  const f = app.viewport.pickElement(x, y, 'face');
  if (f && t.mesh.faces.has(f.id)) return nearestEdgeOfFace(app, t, f.id, x, y);
  return null;
}

/** Clic de sélection en mode édition (Alt = boucle). */
export function clickSelectElement(app: AppContext, x: number, y: number, action: SelectAction, loop: boolean): void {
  const t = editTarget(app);
  if (!t) return;
  const mode = store.getState().selectMode;
  if (loop) {
    const key = pickLoopEdge(app, t, x, y, mode);
    if (!key) {
      if (action === 'set') store.setState({ editSelection: EMPTY_EDIT_SELECTION });
      return;
    }
    const topo = buildTopology(t.mesh);
    let hits: string[];
    if (mode === 'face') {
      hits = faceLoop(t.mesh, key, topo);
    } else {
      const edges = edgeLoop(t.mesh, key, topo);
      if (mode === 'edge') hits = edges;
      else {
        const verts = new Set<string>();
        for (const k of edges) for (const v of edgeVerts(k)) verts.add(v);
        hits = [...verts];
      }
    }
    if (!hits.length) return;
    writeSelection(t, combine(currentPrimary(t, mode), hits, action, false), mode);
    return;
  }
  const hit = app.viewport.pickElement(x, y, mode);
  const valid = hit && hit.type === mode && (mode === 'vert' ? t.mesh.verts.has(hit.id) : mode === 'face' ? t.mesh.faces.has(hit.id) : edgeExists(t, hit.id));
  if (!hit || !valid) {
    if (action === 'set') store.setState({ editSelection: EMPTY_EDIT_SELECTION });
    return;
  }
  writeSelection(t, combine(currentPrimary(t, mode), [hit.id], action, true), mode);
}

/** Rectangle de sélection en mode édition (coordonnées canvas). */
export function boxSelectElements(app: AppContext, x0: number, y0: number, x1: number, y1: number, action: SelectAction): void {
  const t = editTarget(app);
  if (!t) return;
  const mode = store.getState().selectMode;
  const hits = app.viewport.pickElementsInRect(Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1), mode);
  writeSelection(t, combine(currentPrimary(t, mode), hits, action, false), mode);
}

// ------------------------------------------------------------------ opérateurs

/** Sélection d'édition convertie vers un autre mode (sommets ↔ arêtes ↔ faces). */
export function convertEditSelection(app: AppContext, mode: SelectMode): void {
  const t = editTarget(app);
  if (!t) return;
  const s = store.getState();
  // sélection complète d'après le mode courant (la sélection stockée peut n'être que partielle)
  let full = expandSelection(t.mesh, primaryElements(s.editSelection, s.selectMode), s.selectMode);
  if (!full.verts.size) full = expandSelection(t.mesh, editSelectedVerts(t.mesh, s.editSelection), 'vert');
  let primary: Iterable<string>;
  if (mode === 'vert') primary = full.verts;
  else if (mode === 'edge') {
    // arêtes cohérentes + arêtes des faces sélectionnées
    const edges = new Set(full.edges);
    for (const f of full.faces) {
      const loop = t.mesh.faces.get(f);
      if (loop) for (let i = 0; i < loop.length; i++) edges.add(edgeKey(loop[i], loop[(i + 1) % loop.length]));
    }
    primary = edges;
  } else primary = full.faces;
  writeSelection(t, primary, mode);
}

/** Centre monde des éléments sélectionnés en mode édition, ou null. */
export function editSelectionCenter(app: AppContext): Vector3 | null {
  const t = editTarget(app);
  if (!t) return null;
  const ids = editSelectedVerts(t.mesh, store.getState().editSelection);
  if (!ids.size) return null;
  const c = new Vector3();
  for (const id of ids) c.add(v3(t.mesh.verts.get(id)!).applyMatrix4(t.matrixWorld));
  return c.multiplyScalar(1 / ids.size);
}

export function selectOperators(): OperatorDef[] {
  return [
    {
      id: 'object.select_all',
      label: 'Tout sélectionner',
      description: "Sélectionne, désélectionne ou inverse la sélection d'objets — args { action: 'select' | 'deselect' | 'invert' | 'toggle' }",
      modes: ['object'],
      undoable: false,
      defaults: { action: 'toggle' },
      exec(app, inv) {
        const doc = app.doc;
        const s = store.getState();
        const visible = doc.objectIds().filter((id) => doc.isObjectVisible(id));
        const current = new Set([...s.selection].filter((id) => doc.hasObject(id)));
        let action = String(inv.args.action ?? 'toggle');
        if (action === 'toggle') action = current.size ? 'deselect' : 'select';
        let next: Set<string>;
        if (action === 'select') next = new Set([...current, ...visible]);
        else if (action === 'deselect') next = new Set();
        else if (action === 'invert') next = new Set(visible.filter((id) => !current.has(id)));
        else return false;
        const active = s.activeId && next.has(s.activeId) ? s.activeId : ([...next].pop() ?? null);
        setSelection(next, active);
      },
    },
    {
      id: 'mesh.select_mode',
      label: 'Mode de sélection',
      description: "Sélection de sommets (1), d'arêtes (2) ou de faces (3) — args { mode: 'vert' | 'edge' | 'face' }",
      undoable: false,
      defaults: { mode: 'vert' },
      exec(app, inv) {
        const mode = inv.args.mode as SelectMode;
        if (mode !== 'vert' && mode !== 'edge' && mode !== 'face') return false;
        if (store.getState().mode === 'edit') convertEditSelection(app, mode);
        store.setState({ selectMode: mode });
      },
    },
  ];
}
