import { MathUtils, Matrix4, OrthographicCamera, PerspectiveCamera, Quaternion, Vector3, type Camera } from 'three';
import type { ViewDirection } from './api';
import type { PresenceCamera } from '../net/api';
import { clamp, finite, toVec3 } from './util';

/**
 * Caméra du viewport et navigation à la Blender (repère Z-up) :
 *  - orbite « turntable » (bouton du milieu) autour du point d'orbite,
 *    lacet autour de Z monde, tangage autour de l'axe X de la vue ;
 *  - panoramique (Maj + milieu, Ctrl/Maj + molette), zoom (molette, Ctrl + milieu) ;
 *  - vues axiales, perspective / orthographique (avec « perspective automatique »),
 *  - transitions animées (vues, cadrages, suivi d'un autre utilisateur).
 *
 * La pose de vue est (cible, orientation, distance). La caméra regarde selon −Z
 * local, comme toute caméra three.js ; `up` vaut (0, 0, 1).
 */

export const WORLD_UP = new Vector3(0, 0, 1);
const ANIM_MS = 260;
const MIN_DIST = 1e-3;
const MAX_DIST = 1e5;

export interface ViewPose {
  target: Vector3;
  quat: Quaternion;
  dist: number;
}

/** Orientation d'une caméra placée en `eye` et visant `target` (haut = Z, ou `up`). */
export function lookQuaternion(eye: Vector3, target: Vector3, up: Vector3 = WORLD_UP, out = new Quaternion()): Quaternion {
  const m = new Matrix4();
  const dir = new Vector3().subVectors(eye, target);
  if (dir.lengthSq() < 1e-12) dir.set(0, -1, 0);
  // vue exactement verticale : on prend +Y comme haut pour éviter la dégénérescence
  const u = Math.abs(dir.clone().normalize().dot(up)) > 0.99999 ? new Vector3(0, 1, 0) : up;
  m.lookAt(eye, target, u);
  return out.setFromRotationMatrix(m);
}

/** Orientation des vues axiales (mêmes conventions que le pavé numérique de Blender). */
export function axisViewQuaternion(dir: ViewDirection): Quaternion {
  const o = new Vector3();
  switch (dir) {
    case 'front':
      return lookQuaternion(new Vector3(0, -1, 0), o);
    case 'back':
      return lookQuaternion(new Vector3(0, 1, 0), o);
    case 'right':
      return lookQuaternion(new Vector3(1, 0, 0), o);
    case 'left':
      return lookQuaternion(new Vector3(-1, 0, 0), o);
    case 'top':
      return lookQuaternion(new Vector3(0, 0, 1), o, new Vector3(0, 1, 0));
    case 'bottom':
      return lookQuaternion(new Vector3(0, 0, -1), o, new Vector3(0, -1, 0));
  }
}

function smooth(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

export interface NavigationHost {
  /** La vue a changé (redessiner, diffuser la présence). */
  onViewChanged(): void;
  /** Une opération modale est en cours (la molette lui revient). */
  isModal(): boolean;
  /** Vue caméra active ? */
  inCameraView(): boolean;
  /** Quitte la vue caméra en reprenant la pose de la caméra de scène. */
  leaveCameraView(): void;
  /** Zoom du cadre en vue caméra. */
  zoomCameraFrame(factor: number): void;
  /** La navigation manuelle interrompt le suivi d'un autre utilisateur. */
  stopFollowing(): void;
  /** Bascule perspective/orthographique demandée par la navigation (perspective automatique). */
  setOrthographic(ortho: boolean): void;
}

type DragMode = 'orbit' | 'pan' | 'zoom';

export class Navigation {
  readonly persp = new PerspectiveCamera(40, 1, 0.01, 1000);
  readonly ortho = new OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  readonly target = new Vector3();
  readonly quat = new Quaternion();
  dist = 12;
  /** Champ de vision vertical (degrés). */
  fov = 40;
  orthographic = false;
  /** L'orthographique a été activée automatiquement par une vue axiale. */
  autoOrtho = false;
  width = 1;
  height = 1;

  private anim: { from: ViewPose; to: ViewPose; start: number; dur: number } | null = null;
  private drag: { mode: DragMode; pointerId: number; x: number; y: number } | null = null;
  private dom: HTMLElement | null = null;
  private offs: (() => void)[] = [];

  constructor(private host: NavigationHost) {
    for (const c of [this.persp, this.ortho]) c.up.copy(WORLD_UP);
    this.resetDefault();
    this.apply();
  }

  /** Vue par défaut, proche de celle de Blender. */
  resetDefault(): void {
    // Assez loin et décalé pour voir la caméra et la lumière de la scène par défaut
    // (en 7.36, -6.93, 4.96 on était sur la caméra de la scène, dont le gizmo masquait la vue).
    const eye = new Vector3(9.5, -12.5, 8.0);
    this.target.set(0, 0, 0);
    this.dist = eye.length();
    lookQuaternion(eye, this.target, WORLD_UP, this.quat);
    this.anim = null;
  }

  get camera(): PerspectiveCamera | OrthographicCamera {
    return this.orthographic ? this.ortho : this.persp;
  }

  get aspect(): number {
    return this.width / Math.max(1, this.height);
  }

  get animating(): boolean {
    return this.anim !== null;
  }

  get dragging(): boolean {
    return this.drag !== null;
  }

  pose(): ViewPose {
    return { target: this.target.clone(), quat: this.quat.clone(), dist: this.dist };
  }

  /** Position de l'œil (perspective). */
  eye(out = new Vector3()): Vector3 {
    return out.set(0, 0, 1).applyQuaternion(this.quat).multiplyScalar(this.dist).add(this.target);
  }

  /** Direction de visée (normalisée). */
  forward(out = new Vector3()): Vector3 {
    return out.set(0, 0, -1).applyQuaternion(this.quat);
  }

  setSize(w: number, h: number): void {
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
    this.apply();
  }

  /** Taille d'un pixel écran à la distance du point d'orbite, en mètres. */
  worldPerPixel(): number {
    const halfH = this.dist * Math.tan(MathUtils.degToRad(this.fov) / 2);
    return (2 * halfH) / this.height;
  }

  /** Recalcule les deux caméras à partir de la pose. */
  apply(): void {
    const a = this.aspect;
    const eye = this.eye();
    const p = this.persp;
    p.fov = clamp(this.fov, 1, 170);
    p.aspect = a;
    p.near = clamp(this.dist * 0.002, 0.001, 0.5);
    p.far = Math.max(2000, this.dist * 200);
    p.position.copy(eye);
    p.quaternion.copy(this.quat);
    p.updateProjectionMatrix();
    p.updateMatrixWorld(true);

    const o = this.ortho;
    const hh = this.dist * Math.tan(MathUtils.degToRad(p.fov) / 2);
    o.left = -hh * a;
    o.right = hh * a;
    o.top = hh;
    o.bottom = -hh;
    const range = Math.max(500, this.dist * 20);
    o.near = -range;
    o.far = range;
    o.position.copy(eye);
    o.quaternion.copy(this.quat);
    o.updateProjectionMatrix();
    o.updateMatrixWorld(true);
  }

  /** Avance l'animation ; renvoie true tant qu'elle n'est pas terminée. */
  update(now: number): boolean {
    const an = this.anim;
    if (!an) return false;
    const t = smooth((now - an.start) / an.dur);
    this.target.lerpVectors(an.from.target, an.to.target, t);
    this.quat.slerpQuaternions(an.from.quat, an.to.quat, t);
    // interpolation géométrique de la distance (zoom perçu comme régulier)
    this.dist = Math.exp(Math.log(an.from.dist) + (Math.log(an.to.dist) - Math.log(an.from.dist)) * t);
    if (t >= 1) {
      this.target.copy(an.to.target);
      this.quat.copy(an.to.quat);
      this.dist = an.to.dist;
      this.anim = null;
    }
    this.apply();
    return this.anim !== null;
  }

  /** Destination de l'animation en cours (ou pose courante). */
  destination(): ViewPose {
    return this.anim ? { target: this.anim.to.target.clone(), quat: this.anim.to.quat.clone(), dist: this.anim.to.dist } : this.pose();
  }

  setPose(to: ViewPose, animate: boolean): void {
    const dist = clamp(finite(to.dist, this.dist), MIN_DIST, MAX_DIST);
    const target = to.target.clone();
    const quat = to.quat.clone().normalize();
    if (!animate) {
      this.anim = null;
      this.target.copy(target);
      this.quat.copy(quat);
      this.dist = dist;
      this.apply();
    } else {
      // chemin le plus court sur la sphère des orientations
      const from = this.pose();
      if (from.quat.dot(quat) < 0) quat.set(-quat.x, -quat.y, -quat.z, -quat.w);
      this.anim = { from, to: { target, quat, dist }, start: performance.now(), dur: ANIM_MS };
    }
    this.host.onViewChanged();
  }

  setView(dir: ViewDirection, animate = true): void {
    this.setPose({ target: this.target.clone(), quat: axisViewQuaternion(dir), dist: this.dist }, animate);
  }

  /** Cadre une sphère (centre, rayon) en monde. */
  frameSphere(center: Vector3, radius: number, animate = true): void {
    const r = Math.max(0.05, finite(radius, 1));
    const vHalf = MathUtils.degToRad(clamp(this.fov, 1, 170)) / 2;
    const hHalf = Math.atan(Math.tan(vHalf) * this.aspect);
    const half = Math.min(vHalf, hHalf);
    const dist = this.orthographic ? (r * 1.15) / Math.tan(vHalf) / Math.min(1, this.aspect) : (r * 1.1) / Math.sin(half);
    this.setPose({ target: center.clone(), quat: this.quat.clone(), dist }, animate);
  }

  /** Vue axiale alignée ? Renvoie l'axe monde regardé ('x' | 'y' | 'z') ou null. */
  alignedAxis(): 'x' | 'y' | 'z' | null {
    const f = this.forward(new Vector3());
    if (Math.abs(f.x) > 0.9999) return 'x';
    if (Math.abs(f.y) > 0.9999) return 'y';
    if (Math.abs(f.z) > 0.9999) return 'z';
    return null;
  }

  // ------------------------------------------------------------------ gestes élémentaires

  orbit(dxPx: number, dyPx: number): void {
    this.anim = null;
    const k = 0.0075;
    const yaw = new Quaternion().setFromAxisAngle(WORLD_UP, -dxPx * k);
    const right = new Vector3(1, 0, 0);
    const pitch = new Quaternion().setFromAxisAngle(right, -dyPx * k);
    this.quat.premultiply(yaw).multiply(pitch).normalize();
    if (this.autoOrtho && this.orthographic) {
      this.autoOrtho = false;
      this.orthographic = false;
      this.host.setOrthographic(false);
    }
    this.apply();
    this.host.onViewChanged();
  }

  pan(dxPx: number, dyPx: number): void {
    this.anim = null;
    const s = this.worldPerPixel();
    const right = new Vector3(1, 0, 0).applyQuaternion(this.quat);
    const up = new Vector3(0, 1, 0).applyQuaternion(this.quat);
    this.target.addScaledVector(right, -dxPx * s).addScaledVector(up, dyPx * s);
    this.apply();
    this.host.onViewChanged();
  }

  dolly(factor: number): void {
    this.anim = null;
    this.dist = clamp(this.dist * factor, MIN_DIST, MAX_DIST);
    this.apply();
    this.host.onViewChanged();
  }

  // ------------------------------------------------------------------ présence

  viewState(): PresenceCamera {
    return {
      pos: toVec3(this.eye()),
      target: toVec3(this.target),
      fov: this.fov,
      ortho: this.orthographic,
      aspect: this.aspect,
    };
  }

  /** Pose correspondant à un état de caméra de présence. */
  poseFromState(view: PresenceCamera): ViewPose | null {
    const ok = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(x));
    if (!view || !ok(view.pos) || !ok(view.target)) return null;
    const eye = new Vector3(view.pos[0], view.pos[1], view.pos[2]);
    const target = new Vector3(view.target[0], view.target[1], view.target[2]);
    const dist = Math.max(MIN_DIST, eye.distanceTo(target));
    return { target, quat: lookQuaternion(eye, target), dist };
  }

  // ------------------------------------------------------------------ entrées souris

  attach(dom: HTMLElement): void {
    this.detach();
    this.dom = dom;
    const opts = { capture: true } as const;
    const down = (e: PointerEvent) => this.onPointerDown(e);
    const move = (e: PointerEvent) => this.onPointerMove(e);
    const up = (e: PointerEvent) => this.onPointerUp(e);
    const wheel = (e: WheelEvent) => this.onWheel(e);
    const aux = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    };
    dom.addEventListener('pointerdown', down, opts);
    dom.addEventListener('pointermove', move, opts);
    dom.addEventListener('pointerup', up, opts);
    dom.addEventListener('pointercancel', up, opts);
    dom.addEventListener('wheel', wheel, { capture: true, passive: false });
    dom.addEventListener('mousedown', aux, opts);
    dom.addEventListener('auxclick', aux, opts);
    this.offs.push(() => {
      dom.removeEventListener('pointerdown', down, opts);
      dom.removeEventListener('pointermove', move, opts);
      dom.removeEventListener('pointerup', up, opts);
      dom.removeEventListener('pointercancel', up, opts);
      dom.removeEventListener('wheel', wheel, { capture: true });
      dom.removeEventListener('mousedown', aux, opts);
      dom.removeEventListener('auxclick', aux, opts);
    });
  }

  detach(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.drag = null;
    this.dom = null;
  }

  /** Démarre un glisser de navigation (utilisé aussi par les boutons du gizmo). */
  beginDrag(mode: DragMode, e: PointerEvent, captureOn: Element | null): void {
    this.host.stopFollowing();
    if (mode === 'orbit' && this.host.inCameraView()) this.host.leaveCameraView();
    this.drag = { mode, pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    try {
      (captureOn as any)?.setPointerCapture?.(e.pointerId);
    } catch {
      /* capture impossible : le glisser continue tant que le pointeur reste sur l'élément */
    }
  }

  /** Applique le déplacement d'un glisser en cours ; renvoie true si l'événement a été consommé. */
  dragMove(e: PointerEvent): boolean {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return false;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    if (dx === 0 && dy === 0) return true;
    if (d.mode === 'orbit') this.orbit(dx, dy);
    else if (d.mode === 'pan') {
      if (this.host.inCameraView()) this.host.leaveCameraView();
      this.pan(dx, dy);
    } else {
      const f = Math.pow(1.01, dy);
      if (this.host.inCameraView()) this.host.zoomCameraFrame(1 / f);
      else this.dolly(f);
    }
    return true;
  }

  endDrag(e: PointerEvent): boolean {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return false;
    this.drag = null;
    return true;
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 1) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const mode: DragMode = e.shiftKey ? 'pan' : e.ctrlKey ? 'zoom' : 'orbit';
    this.beginDrag(mode, e, this.dom);
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.dragMove(e)) e.stopImmediatePropagation();
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.endDrag(e)) {
      e.stopImmediatePropagation();
      try {
        this.dom?.releasePointerCapture?.(e.pointerId);
      } catch {
        /* ignore */
      }
    }
  }

  private onWheel(e: WheelEvent): void {
    if (this.host.isModal()) return;
    e.preventDefault();
    this.host.stopFollowing();
    // normalisation : lignes / pages → pixels
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dy = e.deltaY * unit;
    const dx = e.deltaX * unit;
    if (e.ctrlKey) {
      if (this.host.inCameraView()) this.host.leaveCameraView();
      this.pan(-(dy || dx) * 0.5, 0);
      return;
    }
    if (e.shiftKey) {
      if (this.host.inCameraView()) this.host.leaveCameraView();
      this.pan(0, -(dy || dx) * 0.5);
      return;
    }
    if (dy === 0) return;
    const f = Math.pow(1.0015, clamp(dy, -400, 400));
    if (this.host.inCameraView()) this.host.zoomCameraFrame(1 / f);
    else this.dolly(f);
  }
}

/** Caméra three.js à partir d'une caméra du document, pour un rapport largeur/hauteur donné. */
export function makeSceneCamera(kind: 'persp' | 'ortho'): PerspectiveCamera | OrthographicCamera {
  const c = kind === 'ortho' ? new OrthographicCamera(-1, 1, 1, -1, 0.1, 1000) : new PerspectiveCamera(40, 1, 0.1, 1000);
  c.up.copy(WORLD_UP);
  return c;
}

export function isOrthoCamera(c: Camera): c is OrthographicCamera {
  return (c as any).isOrthographicCamera === true;
}
