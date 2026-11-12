import type { SceneDoc } from '../core/doc/SceneDoc';
import type { IViewport } from '../engine/api';
import type { ICollab } from '../net/api';
import type { OperatorRegistry } from '../tools/api';
import type { AppStore } from './store';

/**
 * Contexte applicatif : l'unique objet partagé par tous les modules.
 *
 *   doc       document de scène courant (CRDT). ATTENTION : il est REMPLACÉ lors
 *             d'un « Nouveau », « Ouvrir » ou « Rejoindre » — ne gardez jamais une
 *             référence longue durée, lisez toujours `app.doc`, et réabonnez-vous
 *             via `app.onDocChange`.
 *   store     état local (mode, sélection, interface) — src/app/store.ts
 *   viewport  moteur 3D — src/engine/api.ts
 *   collab    client réseau — src/net/api.ts
 *   ops       registre d'opérateurs — src/tools/api.ts
 */
export interface AppContext {
  readonly doc: SceneDoc;
  readonly store: AppStore;
  readonly viewport: IViewport;
  readonly collab: ICollab;
  readonly ops: OperatorRegistry;

  /** Remplace le document courant (réinitialise sélection et mode, rebranche viewport et interface). */
  setDoc(doc: SceneDoc, opts?: { filePath?: string | null }): void;
  /**
   * Appelle `cb` immédiatement avec le document courant puis à chaque
   * remplacement. `cb` peut renvoyer une fonction de nettoyage, appelée avant le
   * prochain appel. Renvoie la fonction de désabonnement.
   */
  onDocChange(cb: (doc: SceneDoc) => void | (() => void)): () => void;
}

let current: AppContext | null = null;

export function setAppContext(app: AppContext): void {
  current = app;
}

/** Accès global au contexte (disponible après le démarrage de l'application). */
export function getApp(): AppContext {
  if (!current) throw new Error('AppContext non initialisé');
  return current;
}
