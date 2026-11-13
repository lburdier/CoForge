import type { AppContext } from '../app/context';
import { store } from '../app/store';
import { Gizmo } from './gizmo';
import { findBindings, findMouseBinding } from './keymap';
import { boxSelectElements, boxSelectObjects, clickSelectElement, clickSelectObject, selectActionOf, type SelectAction } from './select';
import { isEditableElement, viewportPos } from './util';

/**
 * Gestionnaire d'entrées des outils.
 *
 * Écoute le canvas du viewport (clic, clic droit, molette ; sans capture, la navigation du
 * moteur passe d'abord) et la fenêtre (mouvement, relâchement, clavier) et :
 *  - tient `app.ops.mouse` à jour (position dans le canvas, null hors du viewport) ;
 *  - route d'abord tout vers l'opération modale en cours (`app.ops.dispatchModal`) ;
 *  - gère la sélection au clic, le rectangle de sélection (glisser), les gizmos ;
 *  - clic droit : menu contextuel, Maj+clic droit : curseur 3D ;
 *  - applique les raccourcis de KEYMAP, sauf si le focus est dans un champ de saisie
 *    ou qu'un dialogue / menu flottant est ouvert.
 * La navigation (bouton du milieu, molette) reste au moteur.
 */

const DRAG_THRESHOLD = 4;

interface Press {
  pointerId: number;
  x: number;
  y: number;
  action: SelectAction;
  alt: boolean;
  boxing: boolean;
}

export class InputManager {
  private press: Press | null = null;
  private box: HTMLDivElement | null = null;
  /** Le clic droit qui suit a été consommé (annulation d'un modal) : pas de menu contextuel. */
  private swallowContextMenu = false;
  private overViewport = false;
  /** Pointeur au-dessus d'une autre zone que le viewport (éditeur de nœuds, frise…). */
  private overOtherArea = false;

  constructor(
    private app: AppContext,
    private gizmo: Gizmo | null,
  ) {}

  private get canvas(): HTMLCanvasElement | null {
    return (this.app.viewport.dom as HTMLCanvasElement | undefined) ?? null;
  }

  private isCanvas(target: EventTarget | null): boolean {
    const c = this.canvas;
    return !!c && target === c;
  }

  /** Le point (coordonnées fenêtre) est-il dans le rectangle du canvas ? */
  private insideCanvas(e: { clientX: number; clientY: number }): boolean {
    const c = this.canvas;
    if (!c || !c.isConnected) return false;
    const r = c.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom;
  }

  private trackMouse(e: PointerEvent | MouseEvent): void {
    const inside = this.insideCanvas(e);
    if (inside || this.app.ops.modalActive || this.press) this.app.ops.mouse = viewportPos(this.app, e);
    else this.app.ops.mouse = null;
    this.overViewport = this.isCanvas(e.target);
    const t = e.target as Element | null;
    this.overOtherArea = !inside && typeof t?.closest === 'function' && !!t.closest('.cf-area-slot');
  }

  // ---------------------------------------------------------------- pointeur

  private onPointerMove = (e: PointerEvent): void => {
    this.trackMouse(e);
    const ops = this.app.ops;
    if (ops.modalActive) {
      ops.dispatchModal('pointermove', e);
      return;
    }
    const p = this.press;
    if (p && p.pointerId === e.pointerId) {
      const pos = viewportPos(this.app, e);
      if (!p.boxing && Math.hypot(pos.x - p.x, pos.y - p.y) > DRAG_THRESHOLD) p.boxing = true;
      if (p.boxing) this.drawBox(p.x, p.y, pos.x, pos.y);
      return;
    }
    if (this.gizmo) {
      const over = this.isCanvas(e.target) && e.buttons === 0;
      if (over) {
        const pos = viewportPos(this.app, e);
        this.gizmo.setHover(this.gizmo.hitTest(pos.x, pos.y));
      } else if (e.buttons === 0) this.gizmo.setHover(null);
    }
  };

  private onPointerDown = (e: PointerEvent): void => {
    this.trackMouse(e);
    const ops = this.app.ops;
    if (ops.modalActive) {
      ops.dispatchModal('pointerdown', e);
      if (e.button === 0 || e.button === 2) {
        if (e.button === 2) this.swallowContextMenu = true;
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (!this.isCanvas(e.target) || e.button !== 0) return;
    const s = store.getState();
    if (s.popup) return; // le menu flottant se ferme de lui-même
    const pos = viewportPos(this.app, e);
    // gizmo : glisser une poignée = transformation contrainte validée au relâchement
    if (this.gizmo) {
      const h = this.gizmo.hitTest(pos.x, pos.y);
      if (h) {
        const { op, args } = Gizmo.operatorFor(h);
        this.gizmo.setHover(null);
        if (ops.run(op, args, e)) {
          e.preventDefault();
          e.stopPropagation();
          this.capture(e.pointerId);
          return;
        }
      }
    }
    this.press = { pointerId: e.pointerId, x: pos.x, y: pos.y, action: selectActionOf(e), alt: e.altKey, boxing: false };
    this.capture(e.pointerId);
    e.preventDefault();
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.trackMouse(e);
    const ops = this.app.ops;
    if (ops.modalActive) {
      ops.dispatchModal('pointerup', e);
      if (e.button === 0 || e.button === 2) e.stopPropagation();
      this.release(e.pointerId);
      return;
    }
    this.release(e.pointerId);
    const p = this.press;
    if (!p || p.pointerId !== e.pointerId || e.button !== 0) return;
    this.press = null;
    const pos = viewportPos(this.app, e);
    const edit = store.getState().mode === 'edit';
    if (p.boxing) {
      this.hideBox();
      if (edit) boxSelectElements(this.app, p.x, p.y, pos.x, pos.y, p.action);
      else boxSelectObjects(this.app, p.x, p.y, pos.x, pos.y, p.action);
    } else if (edit) clickSelectElement(this.app, p.x, p.y, p.action, p.alt);
    else clickSelectObject(this.app, p.x, p.y, p.action);
    this.app.viewport.requestRender();
  };

  private onPointerCancel = (e: PointerEvent): void => {
    if (this.press && this.press.pointerId === e.pointerId) this.cancelPress();
  };

  private onContextMenu = (e: MouseEvent): void => {
    if (!this.isCanvas(e.target)) return;
    e.preventDefault();
    if (this.swallowContextMenu) {
      this.swallowContextMenu = false;
      return;
    }
    const ops = this.app.ops;
    if (ops.modalActive || this.press) return;
    this.trackMouse(e);
    const b = findMouseBinding('right', e, store.getState().mode);
    if (b && ops.canRun(b.op)) ops.run(b.op, { ...(b.args ?? {}) }, e);
  };

  private onWheel = (e: WheelEvent): void => {
    if (this.app.ops.modalActive) this.app.ops.dispatchModal('wheel', e);
  };

  // ---------------------------------------------------------------- clavier

  private onKeyDown = (e: KeyboardEvent): void => {
    if (isEditableElement(e.target) || isEditableElement(typeof document !== 'undefined' ? document.activeElement : null)) return;
    const ops = this.app.ops;
    if (ops.modalActive) {
      ops.dispatchModal('keydown', e);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.defaultPrevented) return;
    if (e.key === 'Escape' && this.press) {
      this.cancelPress();
      e.preventDefault();
      return;
    }
    const s = store.getState();
    if (s.dialog || s.popup) return;
    // Raccourcis du viewport : seulement si le pointeur est sur le viewport ou qu'aucun widget
    // n'a le focus (sinon la frappe appartient au widget : liste, bouton…). Les raccourcis
    // généraux (fichier, annulation, rendu) s'appliquent partout hors des champs de saisie.
    // Comme dans Blender, la frappe va à la zone sous le pointeur : au-dessus d'un autre
    // éditeur (nœuds, frise, texte…), les raccourcis du viewport ne s'appliquent pas.
    const viewportKeys = this.app.ops.mouse !== null || (this.focusFree() && !this.overOtherArea);
    const bindings = findBindings(e, s.mode).filter((b) => viewportKeys || b.section === 'Général');
    if (!bindings.length) return;
    e.preventDefault();
    for (const b of bindings) {
      if (e.repeat && !b.repeat) return;
      if (!ops.canRun(b.op)) continue;
      ops.run(b.op, { ...(b.args ?? {}) }, e);
      return;
    }
  };

  /** Aucun widget n'a le focus (document, corps de page ou canvas du viewport). */
  private focusFree(): boolean {
    if (typeof document === 'undefined') return true;
    const ae = document.activeElement;
    return !ae || ae === document.body || ae === document.documentElement || ae === this.canvas;
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    if (this.app.ops.modalActive) {
      this.app.ops.dispatchModal('keyup', e);
      e.preventDefault();
    }
  };

  private onBlur = (): void => {
    this.cancelPress();
  };

  // ---------------------------------------------------------------- rectangle de sélection

  private drawBox(x0: number, y0: number, x1: number, y1: number): void {
    const c = this.canvas;
    if (!c || typeof document === 'undefined') return;
    if (!this.box) {
      const d = document.createElement('div');
      d.className = 'cf-select-box';
      Object.assign(d.style, {
        position: 'fixed',
        pointerEvents: 'none',
        border: '1px dashed rgba(255, 255, 255, 0.85)',
        background: 'rgba(255, 255, 255, 0.06)',
        boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.35)',
        zIndex: '900',
      } as Partial<CSSStyleDeclaration>);
      document.body.appendChild(d);
      this.box = d;
    }
    const r = c.getBoundingClientRect();
    const left = Math.min(x0, x1) + r.left;
    const top = Math.min(y0, y1) + r.top;
    Object.assign(this.box.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${Math.abs(x1 - x0)}px`,
      height: `${Math.abs(y1 - y0)}px`,
      display: 'block',
    });
  }

  private hideBox(): void {
    if (this.box) this.box.style.display = 'none';
  }

  private cancelPress(): void {
    if (this.press) this.release(this.press.pointerId);
    this.press = null;
    this.hideBox();
  }

  private capture(pointerId: number): void {
    try {
      this.canvas?.setPointerCapture(pointerId);
    } catch {
      /* pointeur déjà relâché */
    }
  }

  private release(pointerId: number): void {
    try {
      if (this.canvas?.hasPointerCapture(pointerId)) this.canvas.releasePointerCapture(pointerId);
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------- branchement

  /**
   * Hors du canvas, un clic pendant une opération modale la valide / l'annule quand même
   * (comme dans Blender) ; sur le canvas, c'est l'écouteur du canvas qui s'en charge.
   */
  private onWindowPointerDown = (e: PointerEvent): void => {
    if (this.isCanvas(e.target) || !this.app.ops.modalActive) return;
    this.trackMouse(e);
    this.app.ops.dispatchModal('pointerdown', e);
    if (e.button === 2) this.swallowContextMenu = true;
  };

  /**
   * Branche les écouteurs ; renvoie la fonction de débranchement.
   * Convention d'intégration : le moteur intercepte en phase de CAPTURE sur le canvas le bouton
   * du milieu et la molette (navigation, stopImmediatePropagation ; molette laissée à l'opérateur
   * pendant un modal). Les outils écoutent donc le canvas SANS capture, et la fenêtre (phase
   * de propagation) pour suivre le pointeur hors du canvas pendant un modal ou un rectangle.
   */
  attach(): () => void {
    const w = window;
    const canvas = this.canvas;
    canvas?.addEventListener('pointerdown', this.onPointerDown);
    canvas?.addEventListener('contextmenu', this.onContextMenu);
    canvas?.addEventListener('wheel', this.onWheel, { passive: true });
    w.addEventListener('pointerdown', this.onWindowPointerDown);
    w.addEventListener('pointermove', this.onPointerMove);
    w.addEventListener('pointerup', this.onPointerUp);
    w.addEventListener('pointercancel', this.onPointerCancel);
    w.addEventListener('keydown', this.onKeyDown);
    w.addEventListener('keyup', this.onKeyUp);
    w.addEventListener('blur', this.onBlur);
    // Une opération modale qui se termine ou un changement de mode libère l'état du pointeur.
    const unsub = store.subscribe((s, prev) => {
      if (prev.modal && !s.modal && this.press) this.cancelPress();
      if (s.mode !== prev.mode && this.press) this.cancelPress();
    });
    return () => {
      canvas?.removeEventListener('pointerdown', this.onPointerDown);
      canvas?.removeEventListener('contextmenu', this.onContextMenu);
      canvas?.removeEventListener('wheel', this.onWheel);
      w.removeEventListener('pointerdown', this.onWindowPointerDown);
      w.removeEventListener('pointermove', this.onPointerMove);
      w.removeEventListener('pointerup', this.onPointerUp);
      w.removeEventListener('pointercancel', this.onPointerCancel);
      w.removeEventListener('keydown', this.onKeyDown);
      w.removeEventListener('keyup', this.onKeyUp);
      w.removeEventListener('blur', this.onBlur);
      unsub();
      this.cancelPress();
      this.box?.remove();
      this.box = null;
    };
  }

  /** Le pointeur est-il actuellement sur le canvas du viewport ? */
  get pointerOverViewport(): boolean {
    return this.overViewport;
  }
}
