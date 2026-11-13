import type { AppContext } from '../../app/context';
import { animOperators } from './ops';
import { bindAnimation } from './runtime';

export { animOperators, INSERT_KEY_LABELS } from './ops';
export * from './keyedit';
export { bindAnimation, lastPointer, renderAnimation } from './runtime';

/** Enregistre les opérateurs `anim.*` (et `render.render_animation`) et branche la tête de lecture locale. */
export function registerAnimOps(app: AppContext): () => void {
  app.ops.register(...animOperators());
  return bindAnimation(app);
}
