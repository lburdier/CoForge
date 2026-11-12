import { Vector3 } from 'three';
import type { AppContext } from '../../app/context';
import type { EditSelection } from '../../app/store';
import { newId } from '../../core/ids';
import type { MeshData, Vec3 } from '../../core/doc/schema';
import { applyDelta, diffMesh, isEmptyDelta } from '../../core/mesh/topology';
import type { MeshOpResult } from '../../core/mesh/types';
import type { ModalHandler } from '../api';
import { coherentSelection, contextAlive, storeSelection, type MeshEditContext } from './context';

/**
 * Briques communes des opérateurs modaux du mode édition (incrustation, biseau,
 * extrusion le long des normales, coupe en boucle).
 *
 * Principe : l'instantané du maillage pris au départ (`orig`) ne change jamais ; à
 * chaque mouvement on recalcule l'opération sur cet instantané, puis on écrit dans le
 * document uniquement la différence entre le résultat précédent et le nouveau. Les
 * éléments que l'opération ne touche pas ne sont jamais réécrits (les éditions
 * simultanées d'un autre utilisateur ailleurs dans le maillage sont préservées).
 * L'annulation (Échap) est faite par le registre (doc.cancelOp).
 */

/**
 * Générateur d'identifiants stable : après `reset()`, il redonne les mêmes identifiants
 * dans le même ordre. Recalculer une opération avec d'autres paramètres réutilise donc
 * les mêmes sommets/faces au lieu d'en créer de nouveaux à chaque mouvement de souris.
 */
export class StableIds {
  private pool: string[] = [];
  private index = 0;
  readonly next = (): string => {
    if (this.index >= this.pool.length) this.pool.push(newId(8));
    return this.pool[this.index++];
  };
  reset(): void {
    this.index = 0;
  }
}

/** Édition « en direct » d'un maillage à partir d'un instantané fixe. */
export class LiveMeshEdit {
  readonly orig: MeshData;
  readonly ids = new StableIds();
  private prev: MeshData;
  /** Dernier maillage résultat (instantané + opération). */
  get current(): MeshData {
    return this.prev;
  }

  constructor(
    private app: AppContext,
    readonly ctx: MeshEditContext,
  ) {
    this.orig = ctx.mesh;
    this.prev = ctx.mesh;
  }

  /** Le contexte est-il toujours valable ? (sinon l'opération doit être annulée) */
  alive(): boolean {
    return contextAlive(this.app, this.ctx);
  }

  /**
   * Recalcule : `compute` reçoit l'instantané d'origine et le générateur d'identifiants stable
   * (déjà réinitialisé). Renvoie false si le maillage a disparu.
   */
  update(compute: (orig: MeshData, idGen: () => string) => MeshOpResult): boolean {
    if (!this.alive()) return false;
    this.ids.reset();
    const result = compute(this.orig, this.ids.next);
    const target = applyDelta(this.orig, result.delta);
    const delta = diffMesh(this.prev, target);
    if (!isEmptyDelta(delta)) this.ctx.doc.applyMeshDelta(this.ctx.meshId, delta);
    this.prev = target;
    const mode = this.app.store.getState().selectMode;
    if (result.select) storeSelection(coherentSelection(target, result.select, mode));
    return true;
  }

  /** Revient à l'instantané d'origine (sans quitter l'opération), sélection d'origine comprise. */
  revert(): boolean {
    const ok = this.update(() => ({ delta: {} }));
    if (ok) this.restoreSelection();
    return ok;
  }

  /** Remet la sélection du store telle qu'elle était au démarrage. */
  restoreSelection(): void {
    storeSelection(this.ctx.rawSelection);
  }
}

/**
 * Enveloppe un ModalHandler (par exemple celui de `startTranslateModal`) pour remettre la
 * sélection d'origine si l'opération est annulée : le registre défait le document
 * (doc.cancelOp) mais la sélection, locale, n'en fait pas partie.
 */
export function restoreSelectionOnCancel(handler: ModalHandler, selection: EditSelection): ModalHandler {
  const wrapped: ModalHandler = {
    status: handler.status,
    onEnd(committed) {
      try {
        handler.onEnd?.(committed);
      } finally {
        if (!committed) storeSelection(selection);
      }
    },
  };
  if (handler.onPointerMove) wrapped.onPointerMove = (e) => handler.onPointerMove!(e);
  if (handler.onPointerDown) wrapped.onPointerDown = (e) => handler.onPointerDown!(e);
  if (handler.onPointerUp) wrapped.onPointerUp = (e) => handler.onPointerUp!(e);
  if (handler.onKeyDown) wrapped.onKeyDown = (e) => handler.onKeyDown!(e);
  if (handler.onKeyUp) wrapped.onKeyUp = (e) => handler.onKeyUp!(e);
  if (handler.onWheel) wrapped.onWheel = (e) => handler.onWheel!(e);
  return wrapped;
}

// ------------------------------------------------------------------ saisie numérique

/**
 * Saisie numérique au clavier pendant un modal (comme dans Blender : taper « 0.25 »).
 * Chiffres, point/virgule, signe moins, Retour arrière.
 */
export class NumInput {
  text = '';
  get active(): boolean {
    return this.text.length > 0;
  }
  /** Traite une touche ; renvoie true si elle a été consommée. */
  handle(e: KeyboardEvent): boolean {
    const k = e.key;
    if (/^[0-9]$/.test(k)) {
      this.text += k;
      return true;
    }
    if (k === '.' || k === ',') {
      if (!this.text.includes('.')) this.text += this.text === '' || this.text === '-' ? '0.' : '.';
      return true;
    }
    if (k === '-') {
      this.text = this.text.startsWith('-') ? this.text.slice(1) : '-' + this.text;
      return true;
    }
    if (k === 'Backspace') {
      if (!this.text) return false;
      this.text = this.text.slice(0, -1);
      return true;
    }
    return false;
  }
  /** Valeur saisie, ou null si rien d'exploitable n'est saisi. */
  value(): number | null {
    if (!this.text) return null;
    const v = parseFloat(this.text);
    return Number.isFinite(v) ? v : null;
  }
  clear(): void {
    this.text = '';
  }
}

// ------------------------------------------------------------------ souris et écran

/** Position du pointeur relative au canvas du viewport (px CSS). */
export function eventPos(app: AppContext, e: { clientX: number; clientY: number }): { x: number; y: number } {
  const dom = app.viewport.dom as HTMLCanvasElement | undefined;
  if (dom && typeof dom.getBoundingClientRect === 'function') {
    const r = dom.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  return { x: e.clientX, y: e.clientY };
}

/** Projection écran d'un point monde, null s'il est derrière la caméra. */
export function project(app: AppContext, p: Vector3 | Vec3): { x: number; y: number } | null {
  const s = app.viewport.worldToScreen(p);
  return s ? { x: s.x, y: s.y } : null;
}

/**
 * Nombre d'unités LOCALES de l'objet par pixel écran autour d'un point monde
 * (sert à convertir un déplacement de souris en épaisseur, largeur…).
 */
export function localUnitsPerPixel(app: AppContext, ctx: MeshEditContext, centerWorld: Vector3): number {
  const cam = app.viewport.camera;
  const right = new Vector3(1, 0, 0);
  if (cam && cam.matrixWorld) right.setFromMatrixColumn(cam.matrixWorld, 0);
  if (right.lengthSq() < 1e-12) right.set(1, 0, 0);
  right.normalize();
  const a = project(app, centerWorld);
  const b = project(app, centerWorld.clone().add(right));
  const scale = Math.max(1e-9, ctx.matrixWorld.getMaxScaleOnAxis());
  let ppu = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
  if (!Number.isFinite(ppu) || ppu < 1e-6) ppu = 100;
  return 1 / ppu / scale;
}

export function isConfirmKey(e: KeyboardEvent): boolean {
  return e.key === 'Enter' || e.code === 'NumpadEnter';
}

export function isCancelKey(e: KeyboardEvent): boolean {
  return e.key === 'Escape';
}

/** Arrondi d'affichage pour la barre d'état. */
export function fmt(v: number, digits = 4): string {
  return (Math.round(v * 10 ** digits) / 10 ** digits).toString();
}
