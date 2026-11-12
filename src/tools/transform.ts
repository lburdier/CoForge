import { BufferGeometry, Float32BufferAttribute, Group, Line, LineBasicMaterial, Matrix4, Points, PointsMaterial, Vector3 } from 'three';
import type { AppContext } from '../app/context';
import type { InteractionMode, Orientation, PivotMode } from '../app/store';
import type { SceneDoc } from '../core/doc/SceneDoc';
import { decompose, worldMatrix } from '../core/doc/transforms';
import type { MeshData, Vec3 } from '../core/doc/schema';
import { buildTopology } from '../core/mesh/topology';
import type { ModalHandler, ModalResult, OperatorDef } from './api';
import {
  AXIS_COLORS,
  AXIS_NAMES,
  editSelectedVerts,
  editTarget,
  fmt,
  objectWorldPos,
  selectedObjects,
  topLevel,
  towardViewer,
  v3,
  vec3,
  viewportCenter,
  viewportPos,
  worldUnitsPerPixel,
} from './util';

/**
 * Transformations : déplacer (G), tourner (R), redimensionner (S).
 *
 * Une `TransformSession` capture l'état de départ (matrices monde des objets,
 * positions des sommets sélectionnés) puis recalcule À CHAQUE FOIS le résultat
 * depuis cet état : l'opération est idempotente et l'annulation (Échap) est
 * assurée par le registre (doc.cancelOp). Les écritures sont limitées à ~60/s.
 *
 * Utilisée par :
 *  - les opérateurs modaux transform.translate / rotate / scale ;
 *  - les mêmes opérateurs exécutés avec des arguments directs (sans modal) ;
 *  - les gizmos (glisser une poignée = modal contraint, validé au relâchement) ;
 *  - `startTranslateModal`, enchaîné par l'extrusion et les duplications.
 */

export type TransformKind = 'translate' | 'rotate' | 'scale';
export type AxisIndex = 0 | 1 | 2;

/** Contrainte : axe, plan (axe exclu) dans le repère global ou local, ou axe monde imposé. */
export type Constraint =
  | { type: 'axis'; index: AxisIndex; space: Orientation }
  | { type: 'plane'; index: AxisIndex; space: Orientation }
  | { type: 'custom'; axis: Vector3 };

export interface TransformOptions {
  constraint?: Constraint | null;
  /** Repère du premier appui sur X/Y/Z (par défaut : store.orientation). */
  orientation?: Orientation;
  /** Point de pivot (par défaut : store.pivot). */
  pivot?: PivotMode;
  /** Validation au relâchement du bouton gauche (glisser d'une poignée de gizmo). */
  releaseConfirm?: boolean;
  /** Texte d'aide affiché dans la barre d'état. */
  status?: string;
  /** Position de départ du pointeur (px CSS du canvas). Par défaut : app.ops.mouse ou le centre du viewport. */
  start?: { x: number; y: number } | null;
}

interface ObjectTarget {
  id: string;
  world0: Matrix4;
  pos0World: Vector3;
  parentInv: Matrix4;
  /** Rotation pure de l'objet dans le monde (orientation locale). */
  basis: Matrix4;
  scl0: Vec3;
  /** Axes locaux de l'objet exprimés dans le monde, unitaires. */
  axes0: Vector3[];
  /** Pivot individuel (mode « origines individuelles »), sinon null. */
  pivot: Vector3 | null;
}

interface VertTarget {
  id: string;
  world0: Vector3;
  pivot: Vector3 | null;
}

interface EditData {
  objectId: string;
  meshId: string;
  inv: Matrix4;
  basis: Matrix4;
  verts: VertTarget[];
}

const IDENTITY = new Matrix4();
const UNIT: Vector3[] = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
const DEG = Math.PI / 180;
const WRITE_INTERVAL = 16;
/** Aimantation aux sommets : rayon de capture à l'écran, et bornes pour rester fluide sur de grosses scènes. */
const SNAP_RADIUS_PX = 24;
const MAX_SNAP_CANDIDATES = 400_000;
const MAX_SNAP_SOURCES = 20_000;

const KIND_LABELS: Record<TransformKind, string> = { translate: 'Déplacer', rotate: 'Tourner', scale: 'Redimensionner' };
const DEFAULT_HINT = 'X/Y/Z : axe (Maj : plan) | Ctrl : aimanter | Maj : précision | Entrée/clic : valider | Échap/clic droit : annuler';

/** Rotation pure (sans échelle ni translation) d'une matrice monde. */
function rotationOf(m: Matrix4): Matrix4 {
  const r = new Matrix4().extractRotation(m);
  r.setPosition(0, 0, 0);
  return r;
}

function columnAxes(m: Matrix4): Vector3[] {
  return [0, 1, 2].map((i) => {
    const v = new Vector3().setFromMatrixColumn(m, i);
    return v.lengthSq() > 1e-20 ? v.normalize() : UNIT[i].clone();
  });
}

function aroundPivot(linear: Matrix4, pivot: Vector3): Matrix4 {
  return new Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z).multiply(linear).multiply(new Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function snapTo(v: number, step: number): number {
  return step > 0 ? Math.round(v / step) * step : v;
}

// ------------------------------------------------------------------ saisie numérique

/** Saisie numérique pendant un modal : chiffres (clavier principal ou pavé, AZERTY compris), point/virgule, moins, Retour arrière. */
export class NumericInput {
  text = '';
  get active(): boolean {
    return this.text.length > 0;
  }
  /** Traite une touche ; renvoie true si elle a été consommée. */
  handle(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.altKey || e.metaKey) return false;
    const digit = digitOf(e);
    if (digit !== null) {
      this.text += digit;
      return true;
    }
    if (e.key === '.' || e.key === ',' || e.code === 'NumpadDecimal') {
      if (!this.text.includes('.')) this.text += this.text === '' || this.text === '-' ? '0.' : '.';
      return true;
    }
    if (e.code === 'NumpadSubtract' || e.code === 'Minus' || (e.key === '-' && !/^Digit\d$/.test(e.code))) {
      this.text = this.text.startsWith('-') ? this.text.slice(1) : '-' + this.text;
      return true;
    }
    if (e.key === 'Backspace') {
      if (!this.text) return false;
      this.text = this.text.slice(0, -1);
      return true;
    }
    return false;
  }
  value(): number | null {
    if (!this.text || this.text === '-') return null;
    const v = parseFloat(this.text);
    return Number.isFinite(v) ? v : null;
  }
  clear(): void {
    this.text = '';
  }
}

/** Chiffre tapé : touche physique (event.code, indépendant de la disposition AZERTY/QWERTY) ou caractère. */
function digitOf(e: KeyboardEvent): string | null {
  const m = /^(?:Digit|Numpad)(\d)$/.exec(e.code ?? '');
  if (m) return m[1];
  if (/^[0-9]$/.test(e.key)) return e.key;
  return null;
}

// ------------------------------------------------------------------ session

export class TransformSession {
  readonly doc: SceneDoc;
  readonly mode: InteractionMode;
  kind: TransformKind;
  constraint: Constraint | null;
  readonly orientation: Orientation;
  readonly pivotMode: PivotMode;
  readonly releaseConfirm: boolean;
  readonly hint: string;
  readonly pivot: Vector3;
  /** Repère de référence de l'orientation locale (objet actif / objet édité). */
  readonly refBasis: Matrix4;
  readonly numeric = new NumericInput();
  /** true si plus rien ne peut être transformé (objets supprimés, document remplacé). */
  dead = false;

  private objects: ObjectTarget[] = [];
  private edit: EditData | null = null;
  private viewAxis: Vector3;
  private pivotScreen: { x: number; y: number };

  // pointeur
  private start: { x: number; y: number };
  private eff: { x: number; y: number };
  private lastRaw: { x: number; y: number };
  private prevPhi = 0;
  private accumAngle = 0;
  private snapping: boolean;
  private ctrl = false;

  // valeur résolue
  private tVec = new Vector3();
  private tLocal = false;
  private angle = 0;
  private rotAxis: { world: Vector3 } | { index: AxisIndex; local: boolean } = { world: new Vector3(0, 0, 1) };
  private sVec = new Vector3(1, 1, 1);
  private sLocal = false;
  private sCustom: Vector3 | null = null;

  // écritures limitées
  private dirty = false;
  private lastWrite = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  // aimantation aux sommets
  /** Sommets cibles (monde, à plat), construits au premier besoin. */
  private snapCandidates: Float32Array | null = null;
  /** Points de la sélection qui peuvent venir se coller sur une cible. */
  private snapSources: Vector3[] = [];
  private snapMarker: Points | null = null;
  /** true tant que la sélection est collée sur un sommet (barre d'état). */
  private snapped = false;

  // aperçu
  private overlay: Group | null = null;
  private overlayKey = '';

  private constructor(
    private app: AppContext,
    kind: TransformKind,
    opts: TransformOptions,
  ) {
    const s = app.store.getState();
    this.doc = app.doc;
    this.mode = s.mode;
    this.kind = kind;
    this.constraint = opts.constraint ?? null;
    this.orientation = opts.orientation ?? s.orientation;
    this.pivotMode = opts.pivot ?? s.pivot;
    this.releaseConfirm = !!opts.releaseConfirm;
    this.hint = opts.status ?? DEFAULT_HINT;
    this.snapping = s.snap;
    this.pivot = new Vector3();
    this.refBasis = new Matrix4();
    this.viewAxis = new Vector3(0, 0, 1);
    const start = opts.start ?? app.ops.mouse ?? null;
    this.start = start ? { ...start } : { x: 0, y: 0 };
    this.eff = { ...this.start };
    this.lastRaw = { ...this.start };
    this.pivotScreen = { ...this.start };
  }

  /** Crée une session sur la sélection courante (objets ou sommets), ou null s'il n'y a rien à transformer. */
  static create(app: AppContext, kind: TransformKind, opts: TransformOptions = {}): TransformSession | null {
    const s = new TransformSession(app, kind, opts);
    if (!s.capture()) return null;
    s.initScreen(opts.start ?? app.ops.mouse ?? null);
    return s;
  }

  private capture(): boolean {
    const app = this.app;
    const doc = this.doc;
    const st = app.store.getState();
    if (this.mode === 'edit') {
      const t = editTarget(app);
      if (!t) return false;
      const ids = editSelectedVerts(t.mesh, st.editSelection);
      if (ids.size === 0) return false;
      const verts: VertTarget[] = [];
      for (const id of ids) {
        const p = t.mesh.verts.get(id);
        if (p) verts.push({ id, world0: v3(p).applyMatrix4(t.matrixWorld), pivot: null });
      }
      if (!verts.length) return false;
      this.edit = { objectId: t.objectId, meshId: t.meshId, inv: t.matrixWorld.clone().invert(), basis: rotationOf(t.matrixWorld), verts };
      this.refBasis.copy(this.edit.basis);
      const median = new Vector3();
      for (const v of verts) median.add(v.world0);
      median.multiplyScalar(1 / verts.length);
      if (this.pivotMode === 'cursor') this.pivot.copy(v3(st.cursor3d));
      else this.pivot.copy(median);
      if (this.pivotMode === 'individual') this.assignIslandPivots(t.mesh, ids);
      return true;
    }

    const selected = selectedObjects(app);
    if (!selected.length) return false;
    for (const id of topLevel(doc, selected)) {
      const obj = doc.getObject(id);
      if (!obj) continue;
      const world0 = worldMatrix(doc, id);
      const parent = doc.effectiveParent(id);
      const parentInv = parent ? worldMatrix(doc, parent).invert() : new Matrix4();
      this.objects.push({
        id,
        world0,
        pos0World: new Vector3().setFromMatrixPosition(world0),
        parentInv,
        basis: rotationOf(world0),
        scl0: [obj.scl[0], obj.scl[1], obj.scl[2]],
        axes0: columnAxes(world0),
        pivot: null,
      });
    }
    if (!this.objects.length) return false;
    const active = st.activeId && doc.hasObject(st.activeId) ? st.activeId : null;
    const ref = active ?? this.objects[0].id;
    this.refBasis.copy(rotationOf(worldMatrix(doc, ref)));
    const median = new Vector3();
    for (const id of selected) median.add(objectWorldPos(doc, id));
    median.multiplyScalar(1 / selected.length);
    if (this.pivotMode === 'cursor') this.pivot.copy(v3(st.cursor3d));
    else if (this.pivotMode === 'active' && active && st.selection.has(active)) this.pivot.copy(objectWorldPos(doc, active));
    else this.pivot.copy(median);
    if (this.pivotMode === 'individual') for (const t of this.objects) t.pivot = t.pos0World.clone();
    // en orientation locale avec plusieurs objets, chacun suit ses propres axes
    return true;
  }

  /** Origines individuelles en mode édition : chaque îlot connexe de sommets sélectionnés tourne autour de son centre. */
  private assignIslandPivots(mesh: MeshData, ids: Set<string>): void {
    if (!this.edit) return;
    const topo = buildTopology(mesh);
    const byId = new Map(this.edit.verts.map((v) => [v.id, v]));
    const seen = new Set<string>();
    for (const startId of byId.keys()) {
      if (seen.has(startId)) continue;
      const island: VertTarget[] = [];
      const stack = [startId];
      seen.add(startId);
      while (stack.length) {
        const cur = stack.pop()!;
        const vt = byId.get(cur);
        if (vt) island.push(vt);
        for (const n of topo.vertNeighbors.get(cur) ?? []) {
          if (ids.has(n) && !seen.has(n)) {
            seen.add(n);
            stack.push(n);
          }
        }
      }
      const c = new Vector3();
      for (const v of island) c.add(v.world0);
      c.multiplyScalar(1 / Math.max(1, island.length));
      for (const v of island) v.pivot = c;
    }
  }

  private initScreen(start: { x: number; y: number } | null): void {
    const ps = this.app.viewport.worldToScreen(this.pivot);
    this.pivotScreen = ps ? { x: ps.x, y: ps.y } : viewportCenter(this.app);
    if (!start) {
      // invoqué sans pointeur (menu, script) : on part d'un point décalé du pivot
      const c = this.pivotScreen;
      this.start = { x: c.x + 80, y: c.y };
    }
    this.eff = { ...this.start };
    this.lastRaw = { ...this.start };
    this.viewAxis = towardViewer(this.app, this.pivot);
    this.prevPhi = Math.atan2(this.start.y - this.pivotScreen.y, this.start.x - this.pivotScreen.x);
    this.accumAngle = 0;
    this.recompute();
  }

  // ---------------------------------------------------------------- entrées

  /** Mouvement du pointeur (px CSS du canvas). */
  pointer(raw: { x: number; y: number }, shift: boolean, ctrl: boolean): void {
    const k = shift ? 0.1 : 1;
    this.eff = { x: this.eff.x + (raw.x - this.lastRaw.x) * k, y: this.eff.y + (raw.y - this.lastRaw.y) * k };
    const phi = Math.atan2(raw.y - this.pivotScreen.y, raw.x - this.pivotScreen.x);
    const dist = Math.hypot(raw.x - this.pivotScreen.x, raw.y - this.pivotScreen.y);
    if (dist > 2) {
      this.accumAngle += wrapAngle(phi - this.prevPhi) * k;
      this.prevPhi = phi;
    }
    this.lastRaw = { ...raw };
    this.setCtrl(ctrl);
    this.recompute();
    this.schedule();
  }

  /** Change l'état de la touche Ctrl (aimantation inversée tant qu'elle est enfoncée). */
  setCtrl(ctrl: boolean): void {
    if (ctrl === this.ctrl) return;
    this.ctrl = ctrl;
    this.snapping = this.app.store.getState().snap !== ctrl;
  }

  /** Appui sur X/Y/Z : 1er appui = repère par défaut, 2e = l'autre repère, 3e = libre. Maj = plan. */
  pressAxis(index: AxisIndex, plane: boolean): void {
    const first = this.orientation;
    const second: Orientation = first === 'global' ? 'local' : 'global';
    const type = plane ? 'plane' : 'axis';
    const c = this.constraint;
    if (c && c.type === type && c.index === index) {
      this.constraint = c.space === first ? { type, index, space: second } : null;
    } else {
      this.constraint = { type, index, space: first };
    }
    this.recompute();
    this.schedule();
  }

  /** Bascule vers une autre transformation (G/R/S pendant le modal) en repartant de l'état initial. */
  switchKind(kind: TransformKind): void {
    if (kind === this.kind) return;
    this.kind = kind;
    this.start = { ...this.lastRaw };
    this.eff = { ...this.lastRaw };
    this.prevPhi = Math.atan2(this.lastRaw.y - this.pivotScreen.y, this.lastRaw.x - this.pivotScreen.x);
    this.accumAngle = 0;
    this.numeric.clear();
    if (this.constraint?.type === 'custom' && kind !== 'translate') this.constraint = null;
    this.recompute();
    this.schedule();
  }

  /** Clavier pendant le modal. */
  key(e: KeyboardEvent): ModalResult {
    if (e.key === 'Escape') return 'cancelled';
    if (e.key === 'Enter' || e.code === 'NumpadEnter') return this.finish();
    if (e.key === 'Control') {
      this.setCtrl(true);
      this.recompute();
      this.schedule();
      return 'running';
    }
    if (this.numeric.handle(e)) {
      if (this.numeric.active && this.kind === 'translate' && !this.constraint) this.constraint = { type: 'axis', index: 0, space: 'global' };
      this.recompute();
      this.schedule();
      return 'running';
    }
    if (!e.ctrlKey && !e.altKey && !e.metaKey) {
      const k = (e.key ?? '').toLowerCase();
      if (k === 'x' || k === 'y' || k === 'z') {
        this.pressAxis(k === 'x' ? 0 : k === 'y' ? 1 : 2, e.shiftKey);
        return 'running';
      }
      if (!e.shiftKey && (k === 'g' || k === 'r' || k === 's')) {
        this.switchKind(k === 'g' ? 'translate' : k === 'r' ? 'rotate' : 'scale');
        return 'running';
      }
    }
    return 'running';
  }

  keyUp(e: KeyboardEvent): void {
    if (e.key === 'Control') {
      this.setCtrl(false);
      this.recompute();
      this.schedule();
    }
  }

  /** Valide : écrit le dernier état puis termine. */
  finish(): ModalResult {
    this.flush();
    return this.dead ? 'cancelled' : 'finished';
  }

  // ---------------------------------------------------------------- valeurs directes (sans modal)

  /** Fixe directement la valeur (opérateurs exécutés avec arguments, scripts, tests). */
  setTranslation(value: Vector3, local: boolean): void {
    this.kind = 'translate';
    this.tVec.copy(value);
    this.tLocal = local;
    this.dirty = true;
  }

  setRotation(angle: number, axis: { world: Vector3 } | { index: AxisIndex; local: boolean }): void {
    this.kind = 'rotate';
    this.angle = angle;
    this.rotAxis = 'world' in axis ? { world: axis.world.clone().normalize() } : axis;
    this.dirty = true;
  }

  setScale(factors: Vector3, local: boolean): void {
    this.kind = 'scale';
    this.sVec.copy(factors);
    this.sLocal = local;
    this.sCustom = null;
    this.dirty = true;
  }

  // ---------------------------------------------------------------- calcul

  /** Axe monde de la contrainte, dans le repère de référence. */
  private constraintAxis(c: Constraint): Vector3 {
    if (c.type === 'custom') return c.axis.clone();
    return UNIT[c.index].clone().applyMatrix4(c.space === 'local' ? this.refBasis : IDENTITY);
  }

  /** Paramètre le long d'un axe monde, mesuré à l'écran depuis le point de départ. */
  private axisParam(axis: Vector3): number {
    const vp = this.app.viewport;
    const a = vp.worldToScreen(this.pivot);
    const upp = worldUnitsPerPixel(this.app, this.pivot);
    const b = vp.worldToScreen(this.pivot.clone().addScaledVector(axis, upp * 100));
    const dx = this.eff.x - this.start.x;
    const dy = this.eff.y - this.start.y;
    if (a && b) {
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const l2 = vx * vx + vy * vy;
      if (l2 > 4) return ((dx * vx + dy * vy) / l2) * upp * 100;
    }
    // axe pointé vers la caméra : déplacement vertical de la souris
    return -dy * upp;
  }

  /** Point d'impact du rayon écran sur un plan, ou null si le plan est vu par la tranche. */
  private hitPlane(p: { x: number; y: number }, normal: Vector3): Vector3 | null {
    const ray = this.app.viewport.screenToRay(p.x, p.y);
    const denom = ray.dir.dot(normal);
    if (Math.abs(denom) < 0.02) return null;
    const t = this.pivot.clone().sub(ray.origin).dot(normal) / denom;
    if (!Number.isFinite(t)) return null;
    return ray.origin.clone().addScaledVector(ray.dir, t);
  }

  /** Déplacement monde dans un plan passant par le pivot. */
  private planeDelta(normal: Vector3): Vector3 {
    const a = this.hitPlane(this.start, normal);
    const b = this.hitPlane(this.eff, normal);
    if (a && b) return b.sub(a);
    const view = this.viewAxis;
    const a2 = this.hitPlane(this.start, view);
    const b2 = this.hitPlane(this.eff, view);
    if (!a2 || !b2) return new Vector3();
    const d = b2.sub(a2);
    return d.addScaledVector(normal, -d.dot(normal));
  }

  // ------------------------------------------------------------------ aimantation aux sommets

  /**
   * Sommets sur lesquels la sélection peut se coller : ceux des maillages visibles qui ne sont
   * pas en train d'être déplacés (mode objet : objets déplacés et leurs enfants exclus ; mode
   * édition : sommets non sélectionnés du maillage édité + autres objets). Ce sont les sommets
   * du maillage de base (avant modificateurs).
   */
  private buildSnapData(): void {
    const doc = this.doc;
    const out: number[] = [];
    const sources: Vector3[] = [];
    const moved = new Set(this.objects.map((o) => o.id));
    const movesWith = (id: string): boolean => {
      let cur: string | null = id;
      for (let d = 0; cur && d < 256; d++) {
        if (moved.has(cur)) return true;
        cur = doc.effectiveParent(cur);
      }
      return false;
    };
    const selectedVerts = this.edit ? new Set(this.edit.verts.map((v) => v.id)) : null;
    const tmp = new Vector3();
    for (const o of doc.listObjects()) {
      if (o.type !== 'mesh' || !o.data || out.length >= MAX_SNAP_CANDIDATES * 3) continue;
      const mesh = doc.getMesh(o.data);
      if (!mesh) continue;
      const isMoved = !this.edit && movesWith(o.id);
      if (!isMoved && !doc.isObjectVisible(o.id)) continue;
      const world = worldMatrix(doc, o.id);
      const isEdited = this.edit?.objectId === o.id;
      for (const [vid, p] of mesh.verts) {
        tmp.set(p[0], p[1], p[2]).applyMatrix4(world);
        if (isMoved) {
          if (moved.has(o.id) && sources.length < MAX_SNAP_SOURCES) sources.push(tmp.clone());
          continue;
        }
        if (isEdited && selectedVerts!.has(vid)) continue;
        if (out.length >= MAX_SNAP_CANDIDATES * 3) break;
        out.push(tmp.x, tmp.y, tmp.z);
      }
    }
    if (this.edit) for (const v of this.edit.verts.slice(0, MAX_SNAP_SOURCES)) sources.push(v.world0.clone());
    else for (const o of this.objects) sources.push(o.pos0World.clone());
    this.snapCandidates = new Float32Array(out);
    this.snapSources = sources;
  }

  /** Sommet cible le plus proche du pointeur à l'écran (dans SNAP_RADIUS_PX) ; à quasi-égalité, le plus près de la caméra. */
  private findSnapVertex(): Vector3 | null {
    if (!this.snapCandidates) this.buildSnapData();
    const pts = this.snapCandidates!;
    const vp = this.app.viewport;
    const p = new Vector3();
    const r2 = SNAP_RADIUS_PX * SNAP_RADIUS_PX;
    let best = -1;
    let bestD2 = Infinity;
    let bestDepth = Infinity;
    for (let i = 0; i < pts.length; i += 3) {
      p.set(pts[i], pts[i + 1], pts[i + 2]);
      const s = vp.worldToScreen(p);
      if (!s) continue;
      const dx = s.x - this.eff.x;
      const dy = s.y - this.eff.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      // Sommets superposés à l'écran (à 2 px près) : celui de devant l'emporte.
      const closer = d2 < bestD2 - 4;
      const tie = Math.abs(d2 - bestD2) <= 4 && s.depth < bestDepth;
      if (closer || tie) {
        best = i;
        bestD2 = d2;
        bestDepth = s.depth;
      }
    }
    return best < 0 ? null : new Vector3(pts[best], pts[best + 1], pts[best + 2]);
  }

  /**
   * Recale le déplacement pour que le point de la sélection le plus proche du sommet visé vienne
   * exactement dessus. Avec une contrainte d'axe ou de plan, seule la composante permise est
   * reprise (comme dans Blender : le sommet visé donne la distance le long de l'axe).
   */
  private applyVertexSnap(c: Constraint | null): void {
    const target = this.findSnapVertex();
    if (!target) {
      this.hideSnapMarker();
      return;
    }
    const basis = this.tLocal ? this.refBasis : IDENTITY;
    const free = this.tVec.clone().applyMatrix4(basis);
    let source: Vector3 | null = null;
    let bestD = Infinity;
    const probe = new Vector3();
    for (const s of this.snapSources) {
      const d = probe.copy(s).add(free).distanceToSquared(target);
      if (d < bestD) {
        bestD = d;
        source = s;
      }
    }
    if (!source) {
      this.hideSnapMarker();
      return;
    }
    const full = target.clone().sub(source);
    if (c && c.type === 'axis') {
      this.tVec.copy(UNIT[c.index]).multiplyScalar(full.dot(this.constraintAxis(c)));
    } else if (c && c.type === 'custom') {
      const len = c.axis.length() || 1;
      this.tVec.copy(c.axis).multiplyScalar(full.dot(c.axis) / (len * len));
    } else if (c && c.type === 'plane') {
      const b = c.space === 'local' ? this.refBasis : IDENTITY;
      const coords = full.applyMatrix4(b.clone().transpose());
      coords.setComponent(c.index, 0);
      this.tVec.copy(coords);
    } else {
      this.tVec.copy(full);
      this.tLocal = false;
    }
    this.snapped = true;
    this.showSnapMarker(target);
  }

  private showSnapMarker(at: Vector3): void {
    if (!this.snapMarker) {
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute([0, 0, 0], 3));
      const m = new PointsMaterial({ color: '#ff9a1f', size: 12, sizeAttenuation: false, depthTest: false, transparent: true });
      const pts = new Points(g, m);
      pts.name = 'cf-snap-vertex';
      pts.renderOrder = 1000;
      pts.frustumCulled = false;
      this.snapMarker = pts;
      this.app.viewport.overlayRoot?.add(pts);
    }
    this.snapMarker.visible = true;
    this.snapMarker.position.copy(at);
    this.snapMarker.updateMatrixWorld();
  }

  private hideSnapMarker(): void {
    this.snapped = false;
    if (this.snapMarker) this.snapMarker.visible = false;
  }

  private disposeSnapMarker(): void {
    const m = this.snapMarker;
    if (!m) return;
    this.snapMarker = null;
    m.parent?.remove(m);
    m.geometry.dispose();
    (m.material as PointsMaterial).dispose();
  }

  /** Recalcule la valeur résolue d'après le pointeur, la contrainte et la saisie numérique. */
  private recompute(): void {
    const st = this.app.store.getState();
    const c = this.constraint;
    const num = this.numeric.value();
    const inc = st.snapIncrement > 0 ? st.snapIncrement : 1;
    if (this.kind === 'translate') {
      this.tLocal = false;
      // Aimantation aux sommets : le déplacement libre est calculé d'abord, puis recalé sur le sommet visé.
      const vertexSnap = this.snapping && st.snapTarget === 'vertex' && num === null;
      const grid = this.snapping && !vertexSnap;
      if (c && c.type === 'axis') {
        let t = num ?? this.axisParam(this.constraintAxis(c));
        if (num === null && grid) t = snapTo(t, inc);
        this.tVec.copy(UNIT[c.index]).multiplyScalar(t);
        this.tLocal = c.space === 'local';
      } else if (c && c.type === 'plane') {
        const coords = new Vector3();
        if (num !== null) {
          coords.setComponent((c.index + 1) % 3, num);
        } else {
          const basis = c.space === 'local' ? this.refBasis : IDENTITY;
          const n = UNIT[c.index].clone().applyMatrix4(basis);
          const d = this.planeDelta(n);
          coords.copy(d.applyMatrix4(basis.clone().transpose()));
          coords.setComponent(c.index, 0);
          if (grid) coords.set(snapTo(coords.x, inc), snapTo(coords.y, inc), snapTo(coords.z, inc));
        }
        this.tVec.copy(coords);
        this.tLocal = c.space === 'local';
      } else if (c && c.type === 'custom') {
        let t = num ?? this.axisParam(c.axis);
        if (num === null && grid) t = snapTo(t, inc);
        this.tVec.copy(c.axis).multiplyScalar(t);
      } else {
        const d = this.planeDelta(this.viewAxis);
        if (grid) d.set(snapTo(d.x, inc), snapTo(d.y, inc), snapTo(d.z, inc));
        this.tVec.copy(d);
      }
      if (vertexSnap) this.applyVertexSnap(c);
      else this.hideSnapMarker();
    } else if (this.kind === 'rotate') {
      let axisWorld: Vector3;
      if (c && c.type !== 'custom') {
        this.rotAxis = { index: c.index, local: c.space === 'local' };
        axisWorld = this.constraintAxis(c);
      } else if (c && c.type === 'custom') {
        this.rotAxis = { world: c.axis.clone() };
        axisWorld = c.axis;
      } else {
        this.rotAxis = { world: this.viewAxis.clone() };
        axisWorld = this.viewAxis;
      }
      let angle: number;
      if (num !== null) angle = num * DEG;
      else {
        const sign = axisWorld.dot(this.viewAxis) >= 0 ? 1 : -1;
        angle = -this.accumAngle * sign;
        if (this.snapping) angle = snapTo(angle, 5 * DEG);
      }
      this.angle = angle;
    } else {
      let f: number;
      if (num !== null) f = num;
      else {
        const d0 = Math.max(1, Math.hypot(this.start.x - this.pivotScreen.x, this.start.y - this.pivotScreen.y));
        const d1 = Math.hypot(this.eff.x - this.pivotScreen.x, this.eff.y - this.pivotScreen.y);
        f = d1 / d0;
        if (this.snapping) f = snapTo(f, 0.1);
      }
      this.sCustom = null;
      this.sLocal = false;
      if (c && c.type === 'axis') {
        this.sVec.set(1, 1, 1).setComponent(c.index, f);
        this.sLocal = c.space === 'local';
      } else if (c && c.type === 'plane') {
        this.sVec.set(f, f, f).setComponent(c.index, 1);
        this.sLocal = c.space === 'local';
      } else if (c && c.type === 'custom') {
        this.sVec.set(f, f, f);
        this.sCustom = c.axis.clone();
      } else {
        this.sVec.set(f, f, f);
      }
    }
    this.dirty = true;
  }

  /** Transformation monde à appliquer à une cible (repère local `basis`, pivot `pivot`). */
  private matrixFor(basis: Matrix4, pivot: Vector3): Matrix4 {
    if (this.kind === 'translate') {
      const d = this.tLocal ? this.tVec.clone().applyMatrix4(basis) : this.tVec;
      return new Matrix4().makeTranslation(d.x, d.y, d.z);
    }
    if (this.kind === 'rotate') {
      const ax = this.rotAxis;
      const axis = 'world' in ax ? ax.world.clone() : UNIT[ax.index].clone().applyMatrix4(ax.local ? basis : IDENTITY);
      if (axis.lengthSq() < 1e-20) return new Matrix4();
      return aroundPivot(new Matrix4().makeRotationAxis(axis.normalize(), this.angle), pivot);
    }
    let lin: Matrix4;
    if (this.sCustom) {
      const a = this.sCustom.clone().normalize();
      const k = this.sVec.x - 1;
      lin = new Matrix4().set(
        1 + k * a.x * a.x, k * a.x * a.y, k * a.x * a.z, 0,
        k * a.y * a.x, 1 + k * a.y * a.y, k * a.y * a.z, 0,
        k * a.z * a.x, k * a.z * a.y, 1 + k * a.z * a.z, 0,
        0, 0, 0, 1,
      );
    } else {
      const B = this.sLocal ? basis : IDENTITY;
      lin = B.clone().multiply(new Matrix4().makeScale(this.sVec.x, this.sVec.y, this.sVec.z)).multiply(B.clone().transpose());
    }
    return aroundPivot(lin, pivot);
  }

  /** Écrit l'état courant dans le document (depuis l'état initial). */
  apply(): void {
    const app = this.app;
    const doc = this.doc;
    if (this.disposed || this.dead) return;
    if (app.doc !== doc) {
      this.dead = true;
      return;
    }
    doc.transact(() => {
      if (this.edit) {
        const e = this.edit;
        const obj = doc.getObject(e.objectId);
        if (!obj || obj.data !== e.meshId || !doc.getMesh(e.meshId)) {
          this.dead = true;
          return;
        }
        const cache = new Map<Vector3 | null, Matrix4>();
        const positions = new Map<string, Vec3>();
        for (const v of e.verts) {
          let m = cache.get(v.pivot);
          if (!m) {
            m = this.matrixFor(e.basis, v.pivot ?? this.pivot);
            cache.set(v.pivot, m);
          }
          positions.set(v.id, vec3(v.world0.clone().applyMatrix4(m).applyMatrix4(e.inv)));
        }
        doc.setMeshVerts(e.meshId, positions);
        return;
      }
      let alive = 0;
      for (const t of this.objects) {
        if (!doc.hasObject(t.id)) continue;
        alive++;
        const m = this.matrixFor(t.basis, t.pivot ?? this.pivot);
        if (this.kind === 'translate') {
          const p = t.pos0World.clone().applyMatrix4(m).applyMatrix4(t.parentInv);
          doc.updateObject(t.id, { pos: vec3(p) });
        } else if (this.kind === 'rotate') {
          const local = t.parentInv.clone().multiply(m.clone().multiply(t.world0));
          const d = decompose(local);
          doc.updateObject(t.id, { pos: d.pos, rot: d.rot });
        } else {
          const p = t.pos0World.clone().applyMatrix4(m).applyMatrix4(t.parentInv);
          const lin = m.clone().setPosition(0, 0, 0);
          const scl: Vec3 = [0, 0, 0];
          for (let j = 0; j < 3; j++) {
            const u = t.axes0[j];
            const w = u.clone().applyMatrix4(lin);
            const sign = w.dot(u) < 0 ? -1 : 1;
            scl[j] = t.scl0[j] * w.length() * sign;
          }
          doc.updateObject(t.id, { pos: vec3(p), scl });
        }
      }
      if (alive === 0) this.dead = true;
    });
    this.updateOverlay();
  }

  // ---------------------------------------------------------------- écritures limitées (~60/s)

  private schedule(): void {
    this.dirty = true;
    if (this.disposed) return;
    const wait = WRITE_INTERVAL - (Date.now() - this.lastWrite);
    if (wait <= 0) this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, wait);
    }
  }

  /** Écrit immédiatement l'état en attente. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty || this.disposed) return;
    this.dirty = false;
    this.lastWrite = Date.now();
    this.apply();
    this.app.ops.setModalStatus(this.statusText());
    this.app.viewport.requestRender();
  }

  // ---------------------------------------------------------------- affichage

  private axisLabel(c: Constraint): string {
    if (c.type === 'custom') return "l'axe imposé";
    return AXIS_NAMES[c.index] + (c.space === 'local' ? ' local' : '');
  }

  private planeLabel(c: Extract<Constraint, { type: 'plane' }>): string {
    const names = [0, 1, 2].filter((i) => i !== c.index).map((i) => AXIS_NAMES[i]);
    return names.join('') + (c.space === 'local' ? ' local' : '');
  }

  /** Texte d'état, ex. « D : 1.25 m le long de X ». */
  statusText(): string {
    const c = this.constraint;
    const typed = this.numeric.active ? `[${this.numeric.text}|] ` : '';
    let text: string;
    if (this.kind === 'translate') {
      if (c && c.type === 'axis') text = `D : ${typed}${fmt(this.tVec.getComponent(c.index))} m le long de ${this.axisLabel(c)}`;
      else if (c && c.type === 'custom') text = `D : ${typed}${fmt(this.tVec.dot(c.axis))} m le long de ${this.axisLabel(c)}`;
      else if (c && c.type === 'plane') text = `D : ${typed}${fmt(this.tVec.x)} | ${fmt(this.tVec.y)} | ${fmt(this.tVec.z)} m (plan ${this.planeLabel(c)})`;
      else text = `D : ${fmt(this.tVec.x)} | ${fmt(this.tVec.y)} | ${fmt(this.tVec.z)} m`;
    } else if (this.kind === 'rotate') {
      const around = c ? (c.type === 'custom' ? "l'axe imposé" : AXIS_NAMES[c.index] + (c.space === 'local' ? ' local' : '')) : 'la vue';
      text = `Rotation : ${typed}${fmt(this.angle / DEG, 2)}° autour de ${around}`;
    } else {
      const f = c && c.type === 'axis' ? this.sVec.getComponent(c.index) : this.sVec.x === 1 && c?.type === 'plane' ? this.sVec.getComponent((c.index + 1) % 3) : this.sVec.x;
      const where = c ? (c.type === 'plane' ? ` (plan ${this.planeLabel(c)})` : ` le long de ${this.axisLabel(c)}`) : '';
      text = `Échelle : ${typed}${fmt(f, 3)}${where}`;
    }
    if (this.pivotMode === 'individual' && this.kind !== 'translate') text += ' (origines individuelles)';
    if (this.kind === 'translate' && this.snapped) text += ' (collé au sommet)';
    return `${KIND_LABELS[this.kind]} — ${text}   ${this.hint}`;
  }

  /** Ligne(s) d'axe de la contrainte, dessinées dans overlayRoot. */
  private updateOverlay(): void {
    const c = this.constraint;
    const key = c ? (c.type === 'custom' ? `c${c.axis.x},${c.axis.y},${c.axis.z}` : `${c.type}${c.index}${c.space}`) : '';
    if (key === this.overlayKey && (this.overlay !== null) === !!c) return;
    this.overlayKey = key;
    this.clearOverlay();
    if (!c) return;
    const lines: { dir: Vector3; color: string }[] = [];
    if (c.type === 'custom') lines.push({ dir: c.axis.clone().normalize(), color: '#ffaa33' });
    else {
      const basis = c.space === 'local' ? this.refBasis : IDENTITY;
      const idx = c.type === 'axis' ? [c.index] : [0, 1, 2].filter((i) => i !== c.index);
      for (const i of idx) lines.push({ dir: UNIT[i].clone().applyMatrix4(basis), color: AXIS_COLORS[i] });
    }
    const group = new Group();
    group.name = 'cf-transform-axis';
    group.renderOrder = 999;
    const L = 1000;
    for (const l of lines) {
      const g = new BufferGeometry();
      const a = this.pivot.clone().addScaledVector(l.dir, -L);
      const b = this.pivot.clone().addScaledVector(l.dir, L);
      g.setAttribute('position', new Float32BufferAttribute([a.x, a.y, a.z, b.x, b.y, b.z], 3));
      const mat = new LineBasicMaterial({ color: l.color, depthTest: false, transparent: true, opacity: 0.9 });
      const line = new Line(g, mat);
      line.renderOrder = 999;
      line.frustumCulled = false;
      group.add(line);
    }
    this.overlay = group;
    this.app.viewport.overlayRoot?.add(group);
  }

  private clearOverlay(): void {
    const g = this.overlay;
    if (!g) return;
    this.overlay = null;
    g.parent?.remove(g);
    g.traverse((o) => {
      const line = o as Line;
      if ((line as any).isLine) {
        line.geometry.dispose();
        (line.material as LineBasicMaterial).dispose();
      }
    });
  }

  /** Fin de session : valide l'écriture en attente si `commit`, puis nettoie (minuterie, aperçu). */
  dispose(commit: boolean): void {
    if (this.disposed) return;
    if (commit) this.flush();
    this.disposed = true;
    this.disposeSnapMarker();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.clearOverlay();
    this.app.viewport.requestRender();
  }
}

// ------------------------------------------------------------------ modal

/** Gestionnaire modal pilotant une session (souris, clavier, validation/annulation). */
export function transformModal(app: AppContext, session: TransformSession): ModalHandler {
  return {
    status: session.statusText(),
    onPointerMove(e) {
      session.pointer(viewportPos(app, e), e.shiftKey, e.ctrlKey);
      return session.dead ? 'cancelled' : 'running';
    },
    onPointerDown(e) {
      if (e.button === 2) return 'cancelled';
      if (e.button === 0 && !session.releaseConfirm) return session.finish();
      return 'running';
    },
    onPointerUp(e) {
      if (e.button === 0 && session.releaseConfirm) return session.finish();
      return 'running';
    },
    onKeyDown(e) {
      const r = session.key(e);
      return session.dead ? 'cancelled' : r;
    },
    onKeyUp(e) {
      session.keyUp(e);
    },
    onEnd(committed) {
      session.dispose(committed);
    },
  };
}

/** Démarre une transformation modale sur la sélection courante, ou null s'il n'y a rien à transformer. */
export function startTransformModal(app: AppContext, kind: TransformKind, opts: TransformOptions = {}): ModalHandler | null {
  const session = TransformSession.create(app, kind, opts);
  return session ? transformModal(app, session) : null;
}

/**
 * Déplacement modal de la sélection courante (objets ou éléments), enchaîné par
 * d'autres opérateurs (extrusion, duplication) à l'intérieur de leur `exec`.
 * `constraint.axis` : axe MONDE imposé (ex. normale d'extrusion) ; X/Y/Z le remplacent.
 * S'il n'y a rien à déplacer, le gestionnaire renvoyé se termine (validé) au premier événement.
 */
export function startTranslateModal(app: AppContext, opts?: { constraint?: { axis: Vec3 } | null; status?: string }): ModalHandler {
  let constraint: Constraint | null = null;
  const ax = opts?.constraint?.axis;
  if (ax) {
    const v = v3(ax);
    if (v.lengthSq() > 1e-20 && Number.isFinite(v.x + v.y + v.z)) constraint = { type: 'custom', axis: v.normalize() };
  }
  const handler = startTransformModal(app, 'translate', { constraint, status: opts?.status });
  if (handler) return handler;
  const done = (): ModalResult => 'finished';
  return { status: opts?.status ?? 'Rien à déplacer', onPointerMove: done, onPointerDown: done, onKeyDown: done };
}

// ------------------------------------------------------------------ opérateurs

/** Y a-t-il quelque chose à transformer (objets sélectionnés, ou sommets sélectionnés en mode édition) ? */
export function hasTransformTargets(app: AppContext): boolean {
  const s = app.store.getState();
  if (s.mode === 'edit') {
    const t = editTarget(app);
    return !!t && editSelectedVerts(t.mesh, s.editSelection).size > 0;
  }
  return selectedObjects(app).length > 0;
}

function parseAxisIndex(v: unknown): AxisIndex | null {
  if (typeof v === 'number' && (v === 0 || v === 1 || v === 2)) return v;
  if (typeof v !== 'string') return null;
  const k = v.toUpperCase();
  return k === 'X' ? 0 : k === 'Y' ? 1 : k === 'Z' ? 2 : null;
}

function parseVec3(v: unknown): Vector3 | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const out = new Vector3(Number(v[0]), Number(v[1]), Number(v[2]));
  return Number.isFinite(out.x + out.y + out.z) ? out : null;
}

function parseOrientation(v: unknown): Orientation | undefined {
  return v === 'global' || v === 'local' ? v : undefined;
}

function parsePivot(v: unknown): PivotMode | undefined {
  return v === 'median' || v === 'active' || v === 'cursor' || v === 'individual' ? v : undefined;
}

/**
 * Contrainte depuis les arguments : `axis: 'X'|'Y'|'Z'` (+ `plane: true` pour le plan
 * perpendiculaire), ou `axis: Vec3` (axe monde imposé).
 */
function parseConstraint(args: Record<string, any>, orientation: Orientation): Constraint | null {
  const idx = parseAxisIndex(args.axis);
  if (idx !== null) return { type: args.plane ? 'plane' : 'axis', index: idx, space: orientation };
  const v = parseVec3(args.axis);
  if (v && v.lengthSq() > 1e-20) return { type: 'custom', axis: v.normalize() };
  return null;
}

function transformOp(kind: TransformKind, id: string, label: string, description: string): OperatorDef {
  return {
    id,
    label,
    description,
    modes: ['object', 'edit'],
    poll: hasTransformTargets,
    exec(app, inv) {
      const a = inv.args;
      const orientation = parseOrientation(a.orientation) ?? app.store.getState().orientation;
      const opts: TransformOptions = {
        constraint: parseConstraint(a, orientation),
        orientation,
        pivot: parsePivot(a.pivot),
        releaseConfirm: !!a.release_confirm,
        start: inv.mouse,
      };
      const session = TransformSession.create(app, kind, opts);
      if (!session) return false;
      const local = orientation === 'local';
      // ---- exécution directe (arguments fournis) : pas de modal
      if (kind === 'translate') {
        const value = parseVec3(a.value);
        if (value) {
          session.setTranslation(value, local);
          session.dispose(true);
          return;
        }
      } else if (kind === 'rotate') {
        if (typeof a.angle === 'number' && Number.isFinite(a.angle)) {
          const idx = parseAxisIndex(a.axis);
          const vec = parseVec3(a.axis);
          const axis = idx !== null ? { index: idx, local } : vec && vec.lengthSq() > 1e-20 ? { world: vec } : { index: 2 as AxisIndex, local };
          session.setRotation(a.angle, axis);
          session.dispose(true);
          return;
        }
      } else {
        const vec = parseVec3(a.value);
        const f = typeof a.value === 'number' && Number.isFinite(a.value) ? a.value : null;
        if (vec || f !== null) {
          session.setScale(vec ?? new Vector3(f!, f!, f!), local);
          session.dispose(true);
          return;
        }
      }
      return transformModal(app, session);
    },
  };
}

/** Opérateurs transform.translate / rotate / scale. */
export function transformOperators(): OperatorDef[] {
  return [
    transformOp(
      'translate',
      'transform.translate',
      'Déplacer',
      'Déplace la sélection (G). Arguments directs : value: [x, y, z], orientation. Modal : axis, plane, release_confirm',
    ),
    transformOp('rotate', 'transform.rotate', 'Tourner', 'Tourne la sélection (R). Arguments directs : angle (radians), axis: X|Y|Z ou [x, y, z]'),
    transformOp('scale', 'transform.scale', 'Redimensionner', 'Redimensionne la sélection (S). Arguments directs : value: facteur ou [x, y, z]'),
  ];
}
