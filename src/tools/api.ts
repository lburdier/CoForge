import type { AppContext } from '../app/context';
import { store, toast, type InteractionMode } from '../app/store';

/**
 * Système d'opérateurs (à la Blender) : toute action utilisateur est un
 * opérateur identifié ('mesh.extrude', 'object.delete'…), déclenché par un
 * raccourci, un menu, un bouton ou la recherche (F3).
 *
 * Le registre s'occupe de l'annulation : chaque exécution est encadrée par
 * doc.beginOp()/endOp() (= une étape de Ctrl+Z). Un opérateur modal (G, R, S,
 * extrusion…) écrit dans le document à chaque mouvement de souris ; s'il est
 * annulé, le registre appelle doc.cancelOp() qui défait tout : un opérateur
 * n'a JAMAIS à restaurer l'état lui-même.
 */

export type ModalResult = 'running' | 'finished' | 'cancelled';

export interface ModalHandler {
  /** Texte d'aide initial (ex. « G : déplacer | X/Y/Z : axe | Entrée : valider | Échap : annuler »). */
  status?: string;
  onPointerMove?(e: PointerEvent): ModalResult | void;
  onPointerDown?(e: PointerEvent): ModalResult | void;
  onPointerUp?(e: PointerEvent): ModalResult | void;
  onKeyDown?(e: KeyboardEvent): ModalResult | void;
  onKeyUp?(e: KeyboardEvent): ModalResult | void;
  onWheel?(e: WheelEvent): ModalResult | void;
  /** Nettoyage (aperçus, curseur…), appelé une fois, que l'opération soit validée ou annulée. */
  onEnd?(committed: boolean): void;
}

export interface ParamDef {
  key: string;
  label: string;
  type: 'float' | 'int' | 'bool' | 'enum';
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
}

export interface OpInvoke {
  /** Arguments de l'opérateur (valeurs par défaut déjà fusionnées). */
  args: Record<string, any>;
  /** Événement déclencheur éventuel. */
  event: Event | null;
  /** Dernière position connue du pointeur dans le viewport (px CSS), ou null. */
  mouse: { x: number; y: number } | null;
  /** true quand l'opérateur est rejoué depuis le panneau « Ajuster la dernière opération ». */
  redo: boolean;
}

export interface OperatorDef {
  id: string;
  label: string;
  description?: string;
  /** Modes où l'opérateur est disponible (tous si absent). */
  modes?: InteractionMode[];
  /** Condition supplémentaire de disponibilité. */
  poll?(app: AppContext): boolean;
  /** Arguments par défaut. */
  defaults?: Record<string, any>;
  /**
   * Paramètres ajustables après coup (panneau « Ajuster la dernière opération »).
   * Uniquement pour les opérateurs NON modaux : le registre annule puis rejoue exec avec les nouveaux arguments.
   */
  params?: ParamDef[];
  /** false : l'opérateur ne modifie pas le document (navigation, sélection, interface). Par défaut true. */
  undoable?: boolean;
  /**
   * Exécute l'opérateur. Renvoie un ModalHandler pour démarrer une opération
   * modale, sinon rien. Renvoyer `false` signifie « rien fait » (annulé).
   */
  exec(app: AppContext, inv: OpInvoke): void | false | ModalHandler;
}

interface ActiveModal {
  def: OperatorDef;
  handler: ModalHandler;
  args: Record<string, any>;
}

export class OperatorRegistry {
  private ops = new Map<string, OperatorDef>();
  private active: ActiveModal | null = null;
  /** Dernière position du pointeur dans le viewport ; tenue à jour par le gestionnaire d'entrées. */
  mouse: { x: number; y: number } | null = null;

  constructor(private app: AppContext) {}

  register(...defs: OperatorDef[]): void {
    for (const def of defs) this.ops.set(def.id, def);
  }

  get(id: string): OperatorDef | undefined {
    return this.ops.get(id);
  }

  list(): OperatorDef[] {
    return [...this.ops.values()];
  }

  /** L'opérateur existe-t-il et est-il utilisable dans le contexte courant ? */
  canRun(id: string): boolean {
    const def = this.ops.get(id);
    if (!def) return false;
    if (def.modes && !def.modes.includes(store.getState().mode)) return false;
    try {
      return def.poll ? def.poll(this.app) : true;
    } catch {
      return false;
    }
  }

  get modalActive(): boolean {
    return this.active !== null;
  }

  /**
   * Lance un opérateur. Si une opération modale est en cours, elle est d'abord
   * validée. Renvoie true si l'opérateur a été exécuté (ou a démarré en modal).
   */
  run(id: string, args: Record<string, any> = {}, event: Event | null = null): boolean {
    const def = this.ops.get(id);
    if (!def) {
      console.warn(`[ops] opérateur inconnu : ${id}`);
      return false;
    }
    if (this.active) this.endModal(true);
    if (!this.canRun(id)) return false;
    return this.execute(def, { ...def.defaults, ...args }, event, false);
  }

  private execute(def: OperatorDef, args: Record<string, any>, event: Event | null, redo: boolean): boolean {
    const doc = this.app.doc;
    const undoable = def.undoable !== false;
    if (undoable) doc.beginOp();
    let result: void | false | ModalHandler;
    try {
      result = def.exec(this.app, { args, event, mouse: this.mouse, redo });
    } catch (err) {
      console.error(`[ops] ${def.id} a échoué`, err);
      if (undoable) doc.cancelOp();
      toast(`${def.label} : ${(err as Error)?.message ?? 'erreur'}`, 'error');
      return false;
    }
    if (result === false) {
      if (undoable) doc.cancelOp();
      return false;
    }
    if (result && typeof result === 'object') {
      this.active = { def, handler: result, args };
      store.setState({ modal: { opId: def.id, status: result.status ?? def.label } });
      return true;
    }
    if (undoable) {
      doc.endOp();
      store.setState({ lastOp: { opId: def.id, label: def.label, args } });
    }
    this.app.viewport.requestRender();
    return true;
  }

  /**
   * Transmet un événement d'entrée à l'opération modale en cours.
   * Renvoie true si une opération modale était active (l'événement est alors consommé).
   */
  dispatchModal(kind: 'pointermove' | 'pointerdown' | 'pointerup' | 'keydown' | 'keyup' | 'wheel', e: Event): boolean {
    const a = this.active;
    if (!a) return false;
    let res: ModalResult | void;
    try {
      switch (kind) {
        case 'pointermove':
          res = a.handler.onPointerMove?.(e as PointerEvent);
          break;
        case 'pointerdown':
          res = a.handler.onPointerDown?.(e as PointerEvent);
          break;
        case 'pointerup':
          res = a.handler.onPointerUp?.(e as PointerEvent);
          break;
        case 'keydown':
          res = a.handler.onKeyDown?.(e as KeyboardEvent);
          break;
        case 'keyup':
          res = a.handler.onKeyUp?.(e as KeyboardEvent);
          break;
        case 'wheel':
          res = a.handler.onWheel?.(e as WheelEvent);
          break;
      }
    } catch (err) {
      console.error(`[ops] ${a.def.id} (modal) a échoué`, err);
      this.endModal(false);
      return true;
    }
    if (res === 'finished') this.endModal(true);
    else if (res === 'cancelled') this.endModal(false);
    return true;
  }

  /** Met à jour le texte d'aide de l'opération modale en cours. */
  setModalStatus(status: string): void {
    const m = store.getState().modal;
    if (m && this.active) store.setState({ modal: { ...m, status } });
  }

  /** Termine l'opération modale en cours : validée (commit) ou annulée (tout est défait). */
  endModal(commit: boolean): void {
    const a = this.active;
    if (!a) return;
    this.active = null;
    try {
      a.handler.onEnd?.(commit);
    } catch (err) {
      console.error(err);
    }
    const undoable = a.def.undoable !== false;
    if (undoable) {
      if (commit) this.app.doc.endOp();
      else this.app.doc.cancelOp();
    }
    store.setState({ modal: null });
    this.app.viewport.requestRender();
  }

  /**
   * Panneau « Ajuster la dernière opération » : annule la dernière opération
   * non modale et la rejoue avec de nouveaux arguments.
   */
  redoLast(args: Record<string, any>): boolean {
    const last = store.getState().lastOp;
    if (!last || this.active) return false;
    const def = this.ops.get(last.opId);
    if (!def || !def.params?.length) return false;
    this.app.doc.undo();
    return this.execute(def, { ...last.args, ...args }, null, true);
  }
}
