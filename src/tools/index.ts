import type { AppContext } from '../app/context';
import { Gizmo } from './gizmo';
import { InputManager } from './input';
import { registerMeshOps } from './mesh';
import { registerBaseOperators } from './operators';

export { KEYMAP, findBindings, shortcutFor, type KeyBinding, type ShortcutSection } from './keymap';
export { startTranslateModal, startTransformModal, TransformSession, type TransformKind, type TransformOptions } from './transform';
export { baseOperators, registerBaseOperators } from './operators';

/**
 * Point d'entrée des outils : enregistre tous les opérateurs (object.*, mesh.*,
 * transform.*, view.*) dans `app.ops` et branche le gestionnaire d'entrées
 * (clavier, souris) et les gizmos sur le viewport. Renvoie la fonction de nettoyage.
 */
export function registerTools(app: AppContext): () => void {
  registerBaseOperators(app);
  registerMeshOps(app);
  if (typeof window === 'undefined') return () => {};
  const gizmo = new Gizmo(app);
  const input = new InputManager(app, gizmo);
  const detach = input.attach();
  return () => {
    detach();
    gizmo.dispose();
  };
}
