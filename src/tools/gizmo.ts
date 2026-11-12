import {
  BoxGeometry,
  BufferGeometry,
  ConeGeometry,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import type { AppContext } from '../app/context';
import { store, type ToolId } from '../app/store';
import type { SceneDoc } from '../core/doc/SceneDoc';
import { worldMatrix } from '../core/doc/transforms';
import { hasTransformTargets } from './transform';
import { AXIS_COLORS, AXIS_NAMES, HIGHLIGHT_COLOR, distToSegment, editSelectedVerts, editTarget, objectWorldPos, selectedObjects, v3, worldUnitsPerPixel } from './util';

/**
 * Gizmos des outils Déplacer / Tourner / Redimensionner (store.tool) :
 * flèches, anneaux et cubes colorés par axe, dessinés dans `overlayRoot`, de
 * taille constante à l'écran. Glisser une poignée lance l'opérateur
 * transform.* correspondant contraint à l'axe et validé au relâchement
 * (même code que le modal clavier). Survol = surbrillance.
 */

/** Taille du gizmo à l'écran, en pixels (longueur d'une flèche). */
const GIZMO_PX = 90;
const PICK_PX = 8;
const UNIT = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];

export type GizmoAxis = 0 | 1 | 2 | 'free';

export interface GizmoHandle {
  tool: Exclude<ToolId, 'select'>;
  axis: GizmoAxis;
}

interface Part {
  handle: GizmoHandle;
  objects: Object3D[];
  color: string;
}

function basicMat(color: string): MeshBasicMaterial {
  return new MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95, toneMapped: false });
}

function lineMat(color: string): LineBasicMaterial {
  return new LineBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95, toneMapped: false });
}

function segment(a: Vector3, b: Vector3, color: string): Line {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute([a.x, a.y, a.z, b.x, b.y, b.z], 3));
  return new Line(g, lineMat(color));
}

/** Rotation qui amène +Y (axe des cônes de three.js) sur l'axe `i`. */
function alignY(i: number): Quaternion {
  return new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), UNIT[i]);
}

/** Rotation qui amène +Z (normale des tores de three.js) sur l'axe `i`. */
function alignZ(i: number): Quaternion {
  return new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), UNIT[i]);
}

/** Pivot et repère du gizmo pour la sélection courante, ou null. */
export function gizmoFrame(app: AppContext): { pivot: Vector3; basis: Matrix4 } | null {
  if (!hasTransformTargets(app)) return null;
  const s = store.getState();
  const doc: SceneDoc = app.doc;
  const basis = new Matrix4();
  let pivot: Vector3 | null = null;
  if (s.mode === 'edit') {
    const t = editTarget(app);
    if (!t) return null;
    const ids = editSelectedVerts(t.mesh, s.editSelection);
    if (!ids.size) return null;
    pivot = new Vector3();
    for (const id of ids) pivot.add(v3(t.mesh.verts.get(id)!).applyMatrix4(t.matrixWorld));
    pivot.multiplyScalar(1 / ids.size);
    if (s.orientation === 'local') basis.extractRotation(t.matrixWorld);
  } else {
    const ids = selectedObjects(app);
    if (!ids.length) return null;
    const active = s.activeId && doc.hasObject(s.activeId) ? s.activeId : null;
    if (s.pivot === 'active' && active && s.selection.has(active)) pivot = objectWorldPos(doc, active);
    else {
      pivot = new Vector3();
      for (const id of ids) pivot.add(objectWorldPos(doc, id));
      pivot.multiplyScalar(1 / ids.length);
    }
    if (s.orientation === 'local') basis.extractRotation(worldMatrix(doc, active ?? ids[0]));
  }
  if (s.pivot === 'cursor') pivot = v3(s.cursor3d);
  return { pivot, basis };
}

export class Gizmo {
  readonly root = new Group();
  private groups: Record<GizmoHandle['tool'], Group> = { move: new Group(), rotate: new Group(), scale: new Group() };
  private parts: Part[] = [];
  private viewRing: Mesh;
  private hover: Part | null = null;
  private frame: { pivot: Vector3; basis: Matrix4 } | null = null;
  private frameDirty = true;
  private lastKey = '';
  private raf = 0;
  private offs: (() => void)[] = [];
  private disposed = false;

  constructor(private app: AppContext) {
    this.root.name = 'cf-gizmo';
    this.root.renderOrder = 1000;
    this.root.visible = false;
    this.buildMove();
    this.buildRotate();
    this.buildScale();
    this.viewRing = this.groups.rotate.getObjectByName('view-ring') as Mesh;
    for (const g of Object.values(this.groups)) {
      g.visible = false;
      this.root.add(g);
    }
    this.root.traverse((o) => {
      o.renderOrder = 1000;
      o.frustumCulled = false;
    });
    app.viewport.overlayRoot?.add(this.root);

    this.offs.push(store.subscribe(() => (this.frameDirty = true)));
    this.offs.push(
      app.onDocChange((doc) => {
        this.frameDirty = true;
        const off = doc.on('change', () => (this.frameDirty = true));
        return off;
      }),
    );
    if (typeof requestAnimationFrame === 'function') this.raf = requestAnimationFrame(this.tick);
  }

  // ---------------------------------------------------------------- construction

  private addPart(tool: GizmoHandle['tool'], axis: GizmoAxis, color: string, objects: Object3D[]): void {
    const g = this.groups[tool];
    for (const o of objects) g.add(o);
    this.parts.push({ handle: { tool, axis }, objects, color });
  }

  private buildMove(): void {
    for (let i = 0; i < 3; i++) {
      const c = AXIS_COLORS[i];
      const line = segment(UNIT[i].clone().multiplyScalar(0.15), UNIT[i].clone().multiplyScalar(0.85), c);
      const cone = new Mesh(new ConeGeometry(0.055, 0.2, 16), basicMat(c));
      cone.position.copy(UNIT[i]).multiplyScalar(0.9);
      cone.quaternion.copy(alignY(i));
      this.addPart('move', i as GizmoAxis, c, [line, cone]);
    }
    const center = new Mesh(new SphereGeometry(0.06, 16, 12), basicMat('#ffffff'));
    this.addPart('move', 'free', '#ffffff', [center]);
  }

  private buildRotate(): void {
    for (let i = 0; i < 3; i++) {
      const c = AXIS_COLORS[i];
      const ring = new Mesh(new TorusGeometry(0.8, 0.012, 6, 72), basicMat(c));
      ring.quaternion.copy(alignZ(i));
      this.addPart('rotate', i as GizmoAxis, c, [ring]);
    }
    const view = new Mesh(new TorusGeometry(1.0, 0.01, 6, 96), basicMat('#ffffff'));
    view.name = 'view-ring';
    this.addPart('rotate', 'free', '#ffffff', [view]);
  }

  private buildScale(): void {
    for (let i = 0; i < 3; i++) {
      const c = AXIS_COLORS[i];
      const line = segment(UNIT[i].clone().multiplyScalar(0.15), UNIT[i].clone().multiplyScalar(0.84), c);
      const cube = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), basicMat(c));
      cube.position.copy(UNIT[i]).multiplyScalar(0.9);
      this.addPart('scale', i as GizmoAxis, c, [line, cube]);
    }
    const center = new Mesh(new SphereGeometry(0.07, 16, 12), basicMat('#ffffff'));
    this.addPart('scale', 'free', '#ffffff', [center]);
  }

  // ---------------------------------------------------------------- mise à jour

  private activeTool(): GizmoHandle['tool'] | null {
    const s = store.getState();
    if (s.modal || s.tool === 'select') return null;
    return s.tool;
  }

  private tick = (): void => {
    if (this.disposed) return;
    try {
      this.update();
    } catch (err) {
      console.error('[gizmo]', err);
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  /** Recalcule position, orientation et taille (appelé à chaque image). */
  update(): void {
    const tool = this.activeTool();
    if (this.frameDirty) {
      this.frameDirty = false;
      this.frame = tool ? gizmoFrame(this.app) : null;
    }
    const visible = !!tool && !!this.frame;
    let changed = visible !== this.root.visible;
    this.root.visible = visible;
    for (const [k, g] of Object.entries(this.groups)) {
      const v = visible && k === tool;
      if (g.visible !== v) changed = true;
      g.visible = v;
    }
    if (!visible || !this.frame) {
      if (this.hover) this.setHover(null);
      if (changed) this.app.viewport.requestRender();
      return;
    }
    const { pivot, basis } = this.frame;
    const size = worldUnitsPerPixel(this.app, pivot) * GIZMO_PX;
    const cam = this.app.viewport.camera;
    const camKey = cam?.matrixWorld ? cam.matrixWorld.elements.map((e) => e.toFixed(5)).join(',') : '';
    const key = `${tool}|${pivot.toArray().join(',')}|${basis.elements.join(',')}|${size.toFixed(6)}|${camKey}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.root.position.copy(pivot);
      this.root.quaternion.setFromRotationMatrix(basis);
      this.root.scale.setScalar(size);
      // l'anneau de vue fait face à la caméra
      if (cam) {
        const camQ = new Quaternion();
        cam.getWorldQuaternion(camQ);
        this.viewRing.quaternion.copy(this.root.quaternion.clone().invert().multiply(camQ));
      }
      this.root.updateMatrixWorld(true);
      changed = true;
    }
    if (changed) this.app.viewport.requestRender();
  }

  // ---------------------------------------------------------------- picking

  /** Poignée sous le pointeur (coordonnées canvas), ou null. */
  hitTest(x: number, y: number): GizmoHandle | null {
    const tool = this.activeTool();
    if (!tool) return null;
    if (this.frameDirty) this.update();
    const f = this.frame;
    if (!f) return null;
    const vp = this.app.viewport;
    const size = worldUnitsPerPixel(this.app, f.pivot) * GIZMO_PX;
    const center = vp.worldToScreen(f.pivot);
    if (!center) return null;
    const axisWorld = (i: number) => UNIT[i].clone().applyMatrix4(f.basis).normalize();
    let best: GizmoHandle | null = null;
    let bestD = PICK_PX;
    const consider = (h: GizmoHandle, d: number) => {
      if (d < bestD) {
        bestD = d;
        best = h;
      }
    };
    if (tool === 'move' || tool === 'scale') {
      const dc = Math.hypot(x - center.x, y - center.y);
      if (dc < PICK_PX + 4) return { tool, axis: 'free' };
      for (let i = 0; i < 3; i++) {
        const a = vp.worldToScreen(f.pivot.clone().addScaledVector(axisWorld(i), size * 0.15));
        const b = vp.worldToScreen(f.pivot.clone().addScaledVector(axisWorld(i), size * 1.0));
        if (a && b) consider({ tool, axis: i as GizmoAxis }, distToSegment(x, y, a.x, a.y, b.x, b.y));
      }
      return best;
    }
    // rotation : anneaux d'axe (rayon 0.8) et anneau de vue (rayon 1.0, cercle écran)
    for (let i = 0; i < 3; i++) {
      // cercle dans le plan perpendiculaire à l'axe i
      const u = axisWorld((i + 1) % 3);
      const w = axisWorld((i + 2) % 3);
      let prev: { x: number; y: number } | null = null;
      let dMin = Infinity;
      const N = 64;
      for (let k = 0; k <= N; k++) {
        const t = (k / N) * Math.PI * 2;
        const p = f.pivot.clone().addScaledVector(u, Math.cos(t) * size * 0.8).addScaledVector(w, Math.sin(t) * size * 0.8);
        const s = vp.worldToScreen(p);
        if (s && prev) dMin = Math.min(dMin, distToSegment(x, y, prev.x, prev.y, s.x, s.y));
        prev = s;
      }
      consider({ tool, axis: i as GizmoAxis }, dMin);
    }
    if (!best) {
      const r = GIZMO_PX * 1.0;
      const d = Math.abs(Math.hypot(x - center.x, y - center.y) - r);
      if (d < PICK_PX) return { tool, axis: 'free' };
    }
    return best;
  }

  /** Surbrillance de la poignée survolée (null = aucune). */
  setHover(h: GizmoHandle | null): void {
    const part = h ? (this.parts.find((p) => p.handle.tool === h.tool && p.handle.axis === h.axis) ?? null) : null;
    if (part === this.hover) return;
    const paint = (p: Part, color: string) => {
      for (const o of p.objects) {
        const m = (o as Mesh).material as Material & { color?: { set(c: string): void } };
        m?.color?.set(color);
      }
    };
    if (this.hover) paint(this.hover, this.hover.color);
    this.hover = part;
    if (part) paint(part, HIGHLIGHT_COLOR);
    this.app.viewport.requestRender();
  }

  /** Opérateur et arguments à lancer pour une poignée. */
  static operatorFor(h: GizmoHandle): { op: string; args: Record<string, any> } {
    const op = h.tool === 'move' ? 'transform.translate' : h.tool === 'rotate' ? 'transform.rotate' : 'transform.scale';
    const args: Record<string, any> = { release_confirm: true, orientation: store.getState().orientation };
    if (h.axis !== 'free') args.axis = AXIS_NAMES[h.axis];
    return { op, args };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf);
    for (const off of this.offs) off();
    this.root.parent?.remove(this.root);
    this.root.traverse((o) => {
      const m = o as Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as Material | Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
    this.app.viewport.requestRender();
  }
}
