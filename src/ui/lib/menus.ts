import { getApp } from '../../app/context';
import {
  ADD_MENU,
  CONTEXT_MENU_EDIT,
  CONTEXT_MENU_OBJECT,
  MESH_MENU,
  MESH_PRIMITIVE_KINDS,
  OBJECT_MENU,
  SELECT_MENU_EDIT,
  SELECT_MENU_OBJECT,
  TOP_MENUS,
  VIEW_MENU,
  type MenuItem,
} from '../../tools/menus';
import { normalizeText } from './util';

/**
 * Menu « Ajouter » du mode édition : uniquement les primitives de maillage,
 * lancées par `mesh.add_primitive { kind }` (ajout dans le maillage édité).
 */
export function editAddMenu(): MenuItem[] {
  const kinds = MESH_PRIMITIVE_KINDS as readonly string[];
  const out: MenuItem[] = [];
  for (const group of ADD_MENU) {
    for (const item of group.children ?? []) {
      const kind = item.args?.kind;
      if (item.op === 'object.add' && typeof kind === 'string' && kinds.includes(kind)) {
        out.push({ ...item, op: 'mesh.add_primitive', args: { kind } });
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ recherche d'opérateurs (F3)

export interface SearchEntry {
  key: string;
  op: string;
  args: Record<string, any>;
  label: string;
  /** Chemin de menu (« Ajouter › Maillage ») ou chaîne vide. */
  path: string;
  shortcut?: string;
  /** Texte normalisé pour le filtrage. */
  haystack: string;
}

const MENU_ROOTS: { label: string; items: MenuItem[] }[] = [
  ...TOP_MENUS,
  { label: 'Vue', items: VIEW_MENU },
  { label: 'Sélectionner', items: SELECT_MENU_OBJECT },
  { label: 'Sélectionner', items: SELECT_MENU_EDIT },
  { label: 'Ajouter', items: ADD_MENU },
  { label: 'Objet', items: OBJECT_MENU },
  { label: 'Maillage', items: MESH_MENU },
  { label: 'Objet', items: CONTEXT_MENU_OBJECT },
  { label: 'Maillage', items: CONTEXT_MENU_EDIT },
];

interface FlatItem {
  item: MenuItem;
  path: string;
}

function flatten(items: MenuItem[], path: string, out: FlatItem[]): void {
  for (const item of items) {
    if (item.separator) continue;
    if (item.children) flatten(item.children, item.label ? `${path} › ${item.label}` : path, out);
    else if (item.op) out.push({ item, path });
  }
}

let flatCache: FlatItem[] | null = null;
function flatMenus(): FlatItem[] {
  if (!flatCache) {
    flatCache = [];
    for (const root of MENU_ROOTS) flatten(root.items, root.label, flatCache);
    flatten(editAddMenu(), 'Ajouter › Maillage', flatCache);
  }
  return flatCache;
}

/**
 * Entrées de la palette de recherche : les éléments de menus dont l'opérateur
 * est utilisable maintenant, puis les opérateurs enregistrés absents des menus.
 */
export function buildSearchEntries(): SearchEntry[] {
  const ops = getApp().ops;
  const runnable = new Map<string, boolean>();
  const can = (id: string) => {
    let v = runnable.get(id);
    if (v === undefined) runnable.set(id, (v = ops.canRun(id)));
    return v;
  };
  const out: SearchEntry[] = [];
  const seen = new Set<string>();
  const inMenus = new Set<string>();

  for (const { item, path } of flatMenus()) {
    const op = item.op!;
    inMenus.add(op);
    if (op === 'view.search' || !can(op)) continue;
    const key = `${op}:${JSON.stringify(item.args ?? {})}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = item.label ?? ops.get(op)?.label ?? op;
    out.push({ key, op, args: item.args ?? {}, label, path, shortcut: item.shortcut, haystack: normalizeText(`${label} ${path} ${op}`) });
  }
  for (const def of ops.list()) {
    if (inMenus.has(def.id) || def.id === 'view.search' || !can(def.id)) continue;
    out.push({ key: def.id, op: def.id, args: {}, label: def.label, path: '', haystack: normalizeText(`${def.label} ${def.id} ${def.description ?? ''}`) });
  }
  return out;
}

export function filterSearchEntries(entries: SearchEntry[], query: string): SearchEntry[] {
  const tokens = normalizeText(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return entries;
  const scored: { e: SearchEntry; score: number }[] = [];
  for (const e of entries) {
    if (!tokens.every((t) => e.haystack.includes(t))) continue;
    const label = normalizeText(e.label);
    // Les correspondances en début de libellé passent devant.
    const score = label.startsWith(tokens[0]) ? 0 : label.includes(tokens[0]) ? 1 : 2;
    scored.push({ e, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.map((s) => s.e);
}

// ------------------------------------------------------------------ tableau des raccourcis

export interface ShortcutRow {
  label: string;
  shortcut: string;
  /** Chemin de menu où figure l'action. */
  path: string;
}

/** Raccourcis hors menus (voir la fin de src/tools/menus.ts). */
const EXTRA_SHORTCUTS: ShortcutRow[] = [
  { label: 'Basculer mode objet / mode édition', shortcut: 'Tab', path: 'Viewport' },
  { label: 'Sélection de sommets / arêtes / faces', shortcut: '1 / 2 / 3', path: 'Mode édition' },
  { label: 'Extruder le long des normales', shortcut: 'Alt+E', path: 'Mode édition' },
  { label: "Changer le mode d'ombrage", shortcut: 'Z', path: 'Viewport' },
  { label: 'Outil de sélection', shortcut: 'W', path: 'Viewport' },
  { label: 'Ajouter', shortcut: 'Maj+A', path: 'Viewport' },
  { label: 'Supprimer', shortcut: 'X', path: 'Viewport' },
  { label: 'Menu contextuel', shortcut: 'Clic droit', path: 'Viewport' },
  { label: 'Placer le curseur 3D', shortcut: 'Maj+Clic droit', path: 'Viewport' },
  { label: 'Tourner la vue', shortcut: 'Clic milieu', path: 'Navigation' },
  { label: 'Déplacer la vue', shortcut: 'Maj+Clic milieu', path: 'Navigation' },
  { label: 'Zoomer', shortcut: 'Molette', path: 'Navigation' },
];

/** Tous les raccourcis affichés dans le catalogue des menus, dédoublonnés, groupés par menu racine. */
export function shortcutTable(): { group: string; rows: ShortcutRow[] }[] {
  const ops = getApp().ops;
  const groups = new Map<string, ShortcutRow[]>();
  const seen = new Set<string>();
  const add = (group: string, row: ShortcutRow) => {
    const key = `${row.label}|${row.shortcut}`;
    if (seen.has(key)) return;
    seen.add(key);
    let list = groups.get(group);
    if (!list) groups.set(group, (list = []));
    list.push(row);
  };
  const walk = (items: MenuItem[], root: string, path: string) => {
    for (const item of items) {
      if (item.separator) continue;
      const label = item.label ?? (item.op ? (ops.get(item.op)?.label ?? item.op) : '');
      if (item.shortcut && item.op) add(root, { label, shortcut: item.shortcut, path });
      if (item.children) walk(item.children, root, item.label ? `${path} › ${item.label}` : path);
    }
  };
  for (const root of MENU_ROOTS) walk(root.items, root.label, root.label);
  for (const row of EXTRA_SHORTCUTS) add(row.path === 'Navigation' ? 'Navigation' : 'Viewport', row);
  return [...groups.entries()].map(([group, rows]) => ({ group, rows }));
}
