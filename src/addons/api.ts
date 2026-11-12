/**
 * CONTRAT des modules complémentaires (« add-ons »).
 *
 * Un module complémentaire regroupe des opérateurs, entrées de menu et raccourcis que
 * l'utilisateur active ou non dans Édition › Préférences › Modules. L'état activé/désactivé est
 * propre à la machine (localStorage), pas à la scène partagée.
 *
 * Ce fichier ne dépend de rien : n'importe quelle zone peut interroger `isAddonEnabled`.
 */

export interface AddonDef {
  /** Identifiant stable, façon Blender : 'node_wrangler', 'mesh_looptools', 'mesh_f2'… */
  id: string;
  name: string;
  description: string;
  /** Catégorie affichée : « Nœuds », « Maillage », « Objet », « Import-Export », « Interface »… */
  category: string;
  /** Activé à la première utilisation. */
  defaultEnabled: boolean;
  /**
   * Appelé à l'activation ; renvoie la fonction de désactivation (qui retire opérateurs, menus et
   * raccourcis ajoutés). `app` est l'AppContext (src/app/context.ts), typé `unknown` ici pour ne
   * créer aucune dépendance.
   */
  register?(app: unknown): void | (() => void);
}

const KEY = 'coforge.addons';
const defs = new Map<string, AddonDef>();
const listeners = new Set<() => void>();
let state: Record<string, boolean> | null = null;

function load(): Record<string, boolean> {
  if (state) return state;
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    state = parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {};
  } catch {
    state = {};
  }
  return state;
}

/** Déclare un module (sans l'activer : voir `setAddonEnabled` et le gestionnaire de src/addons). */
export function defineAddon(def: AddonDef): void {
  defs.set(def.id, def);
  listeners.forEach((l) => l());
}

export function listAddons(): AddonDef[] {
  return [...defs.values()].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

export function getAddon(id: string): AddonDef | null {
  return defs.get(id) ?? null;
}

export function isAddonEnabled(id: string): boolean {
  const s = load();
  if (typeof s[id] === 'boolean') return s[id];
  return defs.get(id)?.defaultEnabled ?? false;
}

export function setAddonEnabled(id: string, enabled: boolean): void {
  const s = load();
  if (isAddonEnabled(id) === enabled && typeof s[id] === 'boolean') return;
  s[id] = enabled;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* stockage indisponible : l'état reste valable pour la session */
  }
  listeners.forEach((l) => l());
}

/** S'abonne aux changements (déclaration ou activation). Renvoie la fonction de désabonnement. */
export function onAddonsChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
