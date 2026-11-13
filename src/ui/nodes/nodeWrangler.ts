import { defineAddon, isAddonEnabled, onAddonsChange } from '../../addons/api';
import { useSyncExternalStore } from 'react';

/**
 * Module complémentaire « Node Wrangler » (comme l'extension de Blender). Ses outils vivent dans
 * l'éditeur de nœuds (treeOps.ts, wrangler.ts) ; leurs raccourcis, leur menu (Maj+W) et leurs
 * gestes souris ne sont actifs que si le module est activé.
 */
export const NODE_WRANGLER = 'node_wrangler';

defineAddon({
  id: NODE_WRANGLER,
  name: 'Node Wrangler',
  description:
    'Outils de l’éditeur de nœuds : aperçu Ctrl+Maj+clic, connexion paresseuse (Alt+clic droit), Lazy Mix (Ctrl+Maj+clic droit), fusion Ctrl+0 / + / − / * / /, coordonnées de texture Ctrl+T, échange Alt+S, modes Alt+flèches, menu Maj+W…',
  category: 'Nœuds',
  defaultEnabled: true,
});

export function nodeWranglerEnabled(): boolean {
  return isAddonEnabled(NODE_WRANGLER);
}

/** Hook React : état du module (se met à jour quand l'utilisateur l'active ou le désactive). */
export function useNodeWrangler(): boolean {
  return useSyncExternalStore(onAddonsChange, nodeWranglerEnabled, nodeWranglerEnabled);
}
