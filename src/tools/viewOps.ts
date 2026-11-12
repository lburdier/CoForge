import { Vector3 } from 'three';
import type { AppContext } from '../app/context';
import { store, type ShadingMode, type ToolId } from '../app/store';
import type { ViewDirection } from '../engine/api';
import type { OpInvoke, OperatorDef } from './api';
import { editSelectionCenter } from './select';
import { activeObjectId, fail, objectWorldPos, selectedObjects, towardViewer, vec3, viewportToClient } from './util';

/**
 * Opérateurs de vue et d'interface : points de vue, caméra, projection, cadrage,
 * panneaux, rayons X, modes d'affichage, outil actif, curseur 3D, menus flottants.
 * Aucun ne modifie le document (undoable: false), sauf view.delete_menu qui
 * délègue à object.delete (annulable par lui-même).
 */

const DIRECTIONS: ViewDirection[] = ['front', 'back', 'left', 'right', 'top', 'bottom'];
const SHADING_CYCLE: ShadingMode[] = ['wireframe', 'solid', 'material', 'rendered'];
const TOOLS: ToolId[] = ['select', 'move', 'rotate', 'scale'];

/** Position (coordonnées fenêtre) où ouvrir un menu flottant. */
function popupPos(app: AppContext, inv: OpInvoke): { x: number; y: number } {
  if (typeof inv.args.x === 'number' && typeof inv.args.y === 'number') return { x: inv.args.x, y: inv.args.y };
  const ev = inv.event as MouseEvent | null;
  if (ev && typeof ev.clientX === 'number' && typeof ev.clientY === 'number' && 'button' in ev) return { x: ev.clientX, y: ev.clientY };
  if (inv.mouse) return viewportToClient(app, inv.mouse);
  const w = typeof window !== 'undefined' ? window : null;
  return w ? { x: w.innerWidth / 2, y: w.innerHeight / 2 } : { x: 0, y: 0 };
}

/** Point 3D sous le pointeur : surface visible, sinon profondeur du curseur 3D actuel. */
function pointUnderMouse(app: AppContext, x: number, y: number): Vector3 | null {
  const hit = app.viewport.raycastSurface(x, y);
  if (hit) return new Vector3(hit.point[0], hit.point[1], hit.point[2]);
  const cur = new Vector3(...store.getState().cursor3d);
  const ray = app.viewport.screenToRay(x, y);
  const n = towardViewer(app, cur);
  const denom = ray.dir.dot(n);
  if (Math.abs(denom) < 1e-9) return null;
  const t = cur.clone().sub(ray.origin).dot(n) / denom;
  if (!Number.isFinite(t)) return null;
  return ray.origin.clone().addScaledVector(ray.dir, t);
}

const ui = { undoable: false };

export function viewOperators(): OperatorDef[] {
  return [
    {
      id: 'view.axis',
      label: 'Point de vue',
      description: "Vue alignée sur un axe, args { dir: 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' }",
      ...ui,
      defaults: { dir: 'front' },
      exec(app, inv) {
        const dir = inv.args.dir as ViewDirection;
        if (!DIRECTIONS.includes(dir)) return false;
        if (store.getState().cameraView) store.setState({ cameraView: false });
        app.viewport.setView(dir);
      },
    },
    {
      id: 'view.camera',
      label: 'Vue caméra',
      description: 'Regarde à travers la caméra active (bascule)',
      ...ui,
      exec(app) {
        const s = store.getState();
        if (!s.cameraView && !app.doc.getScene().activeCamera) return fail('Aucune caméra active dans la scène');
        store.setState({ cameraView: !s.cameraView });
      },
    },
    {
      id: 'view.toggle_ortho',
      label: 'Perspective / Orthographique',
      ...ui,
      exec() {
        const s = store.getState();
        store.setState({ orthographic: !s.orthographic, cameraView: false });
      },
    },
    {
      id: 'view.frame_selected',
      label: 'Cadrer la sélection',
      ...ui,
      exec(app) {
        app.viewport.frameSelection();
      },
    },
    {
      id: 'view.frame_all',
      label: 'Tout cadrer',
      ...ui,
      exec(app) {
        app.viewport.frameAll();
      },
    },
    {
      id: 'view.toggle_toolbar',
      label: "Barre d'outils",
      ...ui,
      exec() {
        store.setState({ showToolbar: !store.getState().showToolbar });
      },
    },
    {
      id: 'view.toggle_sidebar',
      label: 'Panneau latéral',
      ...ui,
      exec() {
        store.setState({ showSidebar: !store.getState().showSidebar });
      },
    },
    {
      id: 'view.toggle_xray',
      label: 'Rayons X',
      ...ui,
      exec() {
        store.setState({ xray: !store.getState().xray });
      },
    },
    {
      id: 'view.shading',
      label: "Mode d'affichage",
      description: "Fil de fer, solide, matériau ou rendu, args { mode? } ; sans mode : mode suivant (Z)",
      ...ui,
      exec(_app, inv) {
        const mode = inv.args.mode as ShadingMode | undefined;
        if (mode !== undefined) {
          if (!SHADING_CYCLE.includes(mode)) return false;
          store.setState({ shading: mode });
          return;
        }
        const cur = SHADING_CYCLE.indexOf(store.getState().shading);
        store.setState({ shading: SHADING_CYCLE[(cur + 1) % SHADING_CYCLE.length] });
      },
    },
    {
      id: 'view.tool',
      label: 'Outil actif',
      description: "args { tool: 'select' | 'move' | 'rotate' | 'scale' }",
      ...ui,
      defaults: { tool: 'select' },
      exec(_app, inv) {
        const tool = inv.args.tool as ToolId;
        if (!TOOLS.includes(tool)) return false;
        store.setState({ tool });
      },
    },
    {
      id: 'view.cursor_place',
      label: 'Placer le curseur 3D',
      description: 'Place le curseur 3D sous le pointeur (sur la surface visée, sinon à la profondeur actuelle du curseur)',
      ...ui,
      exec(app, inv) {
        const m = inv.mouse;
        if (!m) return false;
        const p = pointUnderMouse(app, m.x, m.y);
        if (!p) return false;
        store.setState({ cursor3d: vec3(p) });
      },
    },
    {
      id: 'view.snap_cursor',
      label: 'Aimanter le curseur',
      description: "args { to: 'selected' | 'active' | 'origin' }",
      ...ui,
      defaults: { to: 'selected' },
      exec(app, inv) {
        const to = String(inv.args.to);
        if (to === 'origin') {
          store.setState({ cursor3d: [0, 0, 0] });
          return;
        }
        let p: Vector3 | null = null;
        if (store.getState().mode === 'edit') p = editSelectionCenter(app);
        else if (to === 'active') {
          const a = activeObjectId(app);
          p = a ? objectWorldPos(app.doc, a) : null;
        } else {
          const ids = selectedObjects(app);
          if (ids.length) {
            p = new Vector3();
            for (const id of ids) p.add(objectWorldPos(app.doc, id));
            p.multiplyScalar(1 / ids.length);
          }
        }
        if (!p) return fail('Rien de sélectionné');
        store.setState({ cursor3d: vec3(p) });
      },
    },
    {
      id: 'view.context_menu',
      label: 'Menu contextuel',
      ...ui,
      exec(app, inv) {
        const { x, y } = popupPos(app, inv);
        store.setState({ popup: { kind: 'context', x, y } });
      },
    },
    {
      id: 'view.add_menu',
      label: 'Ajouter',
      ...ui,
      exec(app, inv) {
        const { x, y } = popupPos(app, inv);
        store.setState({ popup: { kind: 'add', x, y } });
      },
    },
    {
      id: 'view.delete_menu',
      label: 'Supprimer',
      description: 'Mode objet : supprime la sélection ; mode édition : ouvre le menu Supprimer',
      ...ui,
      exec(app, inv) {
        if (store.getState().mode === 'edit') {
          const { x, y } = popupPos(app, inv);
          store.setState({ popup: { kind: 'delete', x, y } });
          return;
        }
        if (!app.ops.run('object.delete', {}, inv.event)) return false;
      },
    },
  ];
}
