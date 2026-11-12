import type { AppContext } from '../app/context';
import type { OperatorDef } from './api';
import { objectOperators } from './objectOps';
import { selectOperators } from './select';
import { transformOperators } from './transform';
import { viewOperators } from './viewOps';

/** Tous les opérateurs de base (hors `mesh.*` d'édition), sans dépendance au DOM. */
export function baseOperators(): OperatorDef[] {
  return [...transformOperators(), ...selectOperators(), ...objectOperators(), ...viewOperators()];
}

/** Enregistre les opérateurs de base dans `app.ops`. */
export function registerBaseOperators(app: AppContext): void {
  app.ops.register(...baseOperators());
}
