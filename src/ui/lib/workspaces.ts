import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { getApp } from '../../app/context';
import { store, type AppState, type PropertiesTab, type ShadingMode, type Workspace } from '../../app/store';
import type { AppContext } from '../../app/context';
import { runOp } from './ops';

/**
 * Espaces de travail (onglets de la barre supérieure) : chacun ajuste le mode
 * d'ombrage, l'onglet de propriétés et la disposition des zones, comme les
 * espaces de travail de Blender.
 */

export interface AreaLayout {
  /** Largeur de la colonne de droite (outliner + propriétés), px. */
  rightW: number;
  /** Hauteur de l'outliner dans la colonne de droite, px. */
  outlinerH: number;
  /** Hauteur de l'éditeur du bas (nœuds, texte…), px. */
  bottomH?: number;
}

export interface WorkspacePreset {
  id: Workspace;
  label: string;
  tip: string;
  apply: Partial<AppState>;
  layout: AreaLayout;
}

/** Hauteur par défaut de l'éditeur du bas (px). */
export const DEFAULT_BOTTOM_H = 300;

export const WORKSPACES: WorkspacePreset[] = [
  {
    id: 'layout',
    label: 'Disposition',
    tip: 'Disposition générale : mise en place de la scène',
    apply: { shading: 'solid', showToolbar: true, bottomEditor: null },
    layout: { rightW: 320, outlinerH: 240 },
  },
  {
    id: 'modeling',
    label: 'Modélisation',
    tip: 'Modélisation : mode édition, viewport élargi',
    apply: { shading: 'solid', showToolbar: true, bottomEditor: null },
    layout: { rightW: 280, outlinerH: 200 },
  },
  {
    id: 'shading',
    label: 'Shading',
    tip: 'Shading : aperçu des matériaux et réglage de l’éclairage',
    apply: { shading: 'material', propertiesTab: 'material', bottomEditor: 'shader_nodes' },
    layout: { rightW: 360, outlinerH: 180 },
  },
  {
    id: 'animation',
    label: 'Animation',
    tip: 'Animation : images clés, feuille d’exposition et éditeur de courbes',
    apply: { shading: 'solid', showToolbar: true, bottomEditor: 'dope_sheet' },
    layout: { rightW: 320, outlinerH: 200, bottomH: 260 },
  },
  {
    id: 'rendering',
    label: 'Rendu',
    tip: 'Rendu : aperçu final et réglages du moteur de rendu',
    apply: { shading: 'rendered', propertiesTab: 'render', bottomEditor: null },
    layout: { rightW: 380, outlinerH: 160 },
  },
  {
    id: 'geometry',
    label: 'Nœuds de géométrie',
    tip: 'Nœuds de géométrie : modélisation procédurale par graphe de nœuds',
    apply: { shading: 'solid', propertiesTab: 'modifiers', bottomEditor: 'geometry_nodes' },
    layout: { rightW: 320, outlinerH: 200 },
  },
  {
    id: 'scripting',
    label: 'Script',
    tip: 'Script : éditeur de texte et console Python',
    apply: { shading: 'solid', bottomEditor: 'python' },
    layout: { rightW: 320, outlinerH: 200 },
  },
];

export function workspacePreset(id: Workspace): WorkspacePreset {
  return WORKSPACES.find((w) => w.id === id) ?? WORKSPACES[0];
}

/**
 * Active un espace de travail. `id` est l'identifiant d'un onglet ou, à défaut,
 * celui d'un modèle (WORKSPACES) : on active alors le premier onglet issu de ce
 * modèle, ou on en crée un s'il n'y en a plus.
 */
export function applyWorkspace(id: Workspace): void {
  const st = workspaceTabs.getState();
  const tab = st.tabs.find((t) => t.id === id) ?? st.tabs.find((t) => t.preset === id);
  if (tab) {
    activateTab(tab.id);
    return;
  }
  if (!WORKSPACES.some((w) => w.id === id)) return;
  const next = addTabFromPreset(st, id);
  workspaceTabs.setState({ tabs: next.tabs, active: st.active }, true);
  activateTab(next.active);
}

// ------------------------------------------------------------------ onglets modifiables (logique pure)

/** Réglages d'affichage mémorisés par onglet. */
export interface WorkspaceView {
  shading: ShadingMode;
  showToolbar: boolean;
  bottomEditor: string | null;
  /** Onglet de l'éditeur de propriétés (absent : on garde l'onglet courant). */
  propertiesTab?: PropertiesTab;
}

/** Un onglet d'espace de travail : préférence LOCALE (jamais dans le document partagé). */
export interface WorkspaceTab {
  id: string;
  name: string;
  /** Modèle d'origine (identifiant de WORKSPACES), utilisé par « Réinitialiser ». */
  preset: string;
  layout: AreaLayout;
  view: WorkspaceView;
}

export interface WorkspaceTabsState {
  tabs: WorkspaceTab[];
  /** Identifiant de l'onglet actif. */
  active: string;
}

export const MAX_TAB_NAME = 64;
const DEFAULT_TAB_NAME = 'Espace de travail';
const SHADINGS: readonly ShadingMode[] = ['wireframe', 'solid', 'material', 'rendered'];
const PROPERTIES_TABS: readonly PropertiesTab[] = [
  'tool',
  'render',
  'output',
  'viewlayer',
  'scene',
  'world',
  'collection',
  'object',
  'modifiers',
  'particles',
  'physics',
  'constraints',
  'data',
  'material',
  'texture',
];

/** Réglages d'affichage d'origine d'un modèle. */
export function presetView(p: WorkspacePreset): WorkspaceView {
  const a = p.apply;
  const v: WorkspaceView = { shading: a.shading ?? 'solid', showToolbar: a.showToolbar ?? true, bottomEditor: a.bottomEditor ?? null };
  if (a.propertiesTab) v.propertiesTab = a.propertiesTab;
  return v;
}

function tabFromPreset(p: WorkspacePreset, id: string, name: string): WorkspaceTab {
  return { id, name, preset: p.id, layout: { ...p.layout }, view: presetView(p) };
}

/** Onglets par défaut : un par modèle, identifiant = identifiant du modèle. */
export function defaultTabsState(layouts: Record<string, unknown> = {}): WorkspaceTabsState {
  const tabs = WORKSPACES.map((p) => {
    const t = tabFromPreset(p, p.id, p.label);
    t.layout = sanitizeLayout(layouts[p.id], p.layout);
    return t;
  });
  return { tabs, active: tabs[0].id };
}

/** Nom libre : `wanted` s'il n'est pas pris, sinon `base.001`, `base.002`… (comme Blender). */
export function uniqueTabName(wanted: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  const name = wanted.trim().slice(0, MAX_TAB_NAME) || DEFAULT_TAB_NAME;
  if (!names.has(name)) return name;
  const base = name.replace(/\.\d{3,}$/, '') || DEFAULT_TAB_NAME;
  for (let i = 1; ; i++) {
    const candidate = `${base}.${String(i).padStart(3, '0')}`;
    if (!names.has(candidate)) return candidate;
  }
}

/** Identifiant d'onglet inédit. */
export function newTabId(taken: Iterable<string>): string {
  const ids = new Set(taken);
  for (;;) {
    const id = `ws-${Math.random().toString(36).slice(2, 10)}`;
    if (!ids.has(id)) return id;
  }
}

function indexOfTab(st: WorkspaceTabsState, id: string): number {
  return st.tabs.findIndex((t) => t.id === id);
}

function insertAfter(st: WorkspaceTabsState, after: string, tab: WorkspaceTab): WorkspaceTabsState {
  const i = indexOfTab(st, after);
  const tabs = st.tabs.slice();
  tabs.splice(i < 0 ? tabs.length : i + 1, 0, tab);
  return { tabs, active: tab.id };
}

/** Nouvel onglet créé depuis un modèle, inséré après `after` (l'onglet actif par défaut) et activé. */
export function addTabFromPreset(st: WorkspaceTabsState, presetId: string, after: string = st.active): WorkspaceTabsState {
  const p = WORKSPACES.find((w) => w.id === presetId);
  if (!p) return st;
  const tab = tabFromPreset(p, newTabId(st.tabs.map((t) => t.id)), uniqueTabName(p.label, st.tabs.map((t) => t.name)));
  return insertAfter(st, after, tab);
}

/** Copie d'un onglet (disposition et réglages courants), insérée juste après lui et activée. */
export function duplicateTab(st: WorkspaceTabsState, id: string): WorkspaceTabsState {
  const src = st.tabs.find((t) => t.id === id);
  if (!src) return st;
  const tab: WorkspaceTab = {
    id: newTabId(st.tabs.map((t) => t.id)),
    name: uniqueTabName(src.name, st.tabs.map((t) => t.name)),
    preset: src.preset,
    layout: { ...src.layout },
    view: { ...src.view },
  };
  return insertAfter(st, id, tab);
}

/** Renomme un onglet ; un nom vide est refusé, un nom déjà pris reçoit un suffixe .001… */
export function renameTab(st: WorkspaceTabsState, id: string, name: string): WorkspaceTabsState {
  const i = indexOfTab(st, id);
  const wanted = name.trim().slice(0, MAX_TAB_NAME);
  if (i < 0 || !wanted || wanted === st.tabs[i].name) return st;
  const finalName = uniqueTabName(wanted, st.tabs.filter((t) => t.id !== id).map((t) => t.name));
  const tabs = st.tabs.slice();
  tabs[i] = { ...tabs[i], name: finalName };
  return { ...st, tabs };
}

/** Supprime un onglet (refusé pour le dernier) ; si c'était l'onglet actif, le voisin devient actif. */
export function removeTab(st: WorkspaceTabsState, id: string): WorkspaceTabsState {
  const i = indexOfTab(st, id);
  if (i < 0 || st.tabs.length <= 1) return st;
  const tabs = st.tabs.filter((t) => t.id !== id);
  const active = st.active === id ? (tabs[i] ?? tabs[i - 1]).id : st.active;
  return { tabs, active };
}

/** Déplace un onglet à la position `to` (bornée). */
export function moveTab(st: WorkspaceTabsState, id: string, to: number): WorkspaceTabsState {
  const i = indexOfTab(st, id);
  if (i < 0) return st;
  const j = Math.max(0, Math.min(st.tabs.length - 1, Math.round(to)));
  if (i === j) return st;
  const tabs = st.tabs.slice();
  const [tab] = tabs.splice(i, 1);
  tabs.splice(j, 0, tab);
  return { ...st, tabs };
}

/** Déplace un onglet de `delta` places (-1 : à gauche, +1 : à droite). */
export function moveTabBy(st: WorkspaceTabsState, id: string, delta: number): WorkspaceTabsState {
  const i = indexOfTab(st, id);
  return i < 0 ? st : moveTab(st, id, i + delta);
}

/** Rétablit la disposition et les réglages d'origine du modèle de l'onglet (le nom est conservé). */
export function resetTab(st: WorkspaceTabsState, id: string): WorkspaceTabsState {
  const i = indexOfTab(st, id);
  if (i < 0) return st;
  const p = workspacePreset(st.tabs[i].preset);
  const tabs = st.tabs.slice();
  tabs[i] = { ...tabs[i], layout: { ...p.layout }, view: presetView(p) };
  return { ...st, tabs };
}

/** Onglet suivant (dir = 1) ou précédent (dir = -1), en boucle. */
export function cycleTab(st: WorkspaceTabsState, dir: 1 | -1): WorkspaceTabsState {
  const n = st.tabs.length;
  if (n < 2) return st;
  const i = Math.max(0, indexOfTab(st, st.active));
  return { ...st, active: st.tabs[(i + dir + n) % n].id };
}

export function setTabLayout(st: WorkspaceTabsState, id: string, layout: AreaLayout): WorkspaceTabsState {
  const i = indexOfTab(st, id);
  if (i < 0) return st;
  const tabs = st.tabs.slice();
  tabs[i] = { ...tabs[i], layout: sanitizeLayout(layout, tabs[i].layout) };
  return { ...st, tabs };
}

export function setTabView(st: WorkspaceTabsState, id: string, view: WorkspaceView): WorkspaceTabsState {
  const i = indexOfTab(st, id);
  if (i < 0) return st;
  const cur = st.tabs[i].view;
  if (
    cur.shading === view.shading &&
    cur.showToolbar === view.showToolbar &&
    cur.bottomEditor === view.bottomEditor &&
    cur.propertiesTab === view.propertiesTab
  )
    return st;
  const tabs = st.tabs.slice();
  tabs[i] = { ...tabs[i], view: { ...view } };
  return { ...st, tabs };
}

// ------------------------------------------------------------------ relecture validée

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function sanitizeLayout(raw: unknown, fallback: AreaLayout): AreaLayout {
  const l = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: AreaLayout = {
    rightW: finite(l.rightW) && l.rightW > 0 ? l.rightW : fallback.rightW,
    outlinerH: finite(l.outlinerH) && l.outlinerH > 0 ? l.outlinerH : fallback.outlinerH,
  };
  const bottomH = finite(l.bottomH) && l.bottomH > 0 ? l.bottomH : fallback.bottomH;
  if (bottomH !== undefined) out.bottomH = bottomH;
  return out;
}

function sanitizeView(raw: unknown, fallback: WorkspaceView): WorkspaceView {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: WorkspaceView = {
    shading: SHADINGS.includes(v.shading as ShadingMode) ? (v.shading as ShadingMode) : fallback.shading,
    showToolbar: typeof v.showToolbar === 'boolean' ? v.showToolbar : fallback.showToolbar,
    bottomEditor: v.bottomEditor === null || (typeof v.bottomEditor === 'string' && v.bottomEditor.length <= 64) ? (v.bottomEditor as string | null) : fallback.bottomEditor,
  };
  const pt = PROPERTIES_TABS.includes(v.propertiesTab as PropertiesTab) ? (v.propertiesTab as PropertiesTab) : fallback.propertiesTab;
  if (pt) out.propertiesTab = pt;
  return out;
}

/**
 * Relit un état d'onglets venu du stockage local. Les entrées invalides sont
 * écartées ; renvoie null si rien d'utilisable ne reste (on repart des onglets par défaut).
 */
export function parseTabsState(raw: unknown): WorkspaceTabsState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.tabs)) return null;
  const tabs: WorkspaceTab[] = [];
  const ids = new Set<string>();
  const names: string[] = [];
  for (const item of r.tabs.slice(0, 100)) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    if (typeof t.id !== 'string' || !t.id || t.id.length > 64 || ids.has(t.id)) continue;
    const preset = typeof t.preset === 'string' && WORKSPACES.some((w) => w.id === t.preset) ? t.preset : WORKSPACES[0].id;
    const p = workspacePreset(preset);
    const name = uniqueTabName(typeof t.name === 'string' ? t.name : p.label, names);
    ids.add(t.id);
    names.push(name);
    tabs.push({ id: t.id, name, preset, layout: sanitizeLayout(t.layout, p.layout), view: sanitizeView(t.view, presetView(p)) });
  }
  if (!tabs.length) return null;
  const active = typeof r.active === 'string' && ids.has(r.active) ? r.active : tabs[0].id;
  return { tabs, active };
}

// ------------------------------------------------------------------ persistance (préférence locale)

/** Accès minimal au stockage (localStorage, ou substitut dans les tests). */
export interface TabsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const TABS_STORAGE_KEY = 'coforge.ui.workspaces';
/** Ancienne préférence : tailles des zones par espace de travail (reprise à la première ouverture). */
const LEGACY_LAYOUT_KEY = 'coforge.ui.layout';

function defaultStorage(): TabsStorage | null {
  try {
    return (globalThis.localStorage as TabsStorage | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Lit les onglets enregistrés ; une préférence absente ou corrompue redonne les onglets par défaut. */
export function loadTabsState(storage: TabsStorage | null = defaultStorage()): WorkspaceTabsState {
  if (!storage) return defaultTabsState();
  try {
    const raw = storage.getItem(TABS_STORAGE_KEY);
    if (raw) {
      const parsed = parseTabsState(JSON.parse(raw));
      if (parsed) return parsed;
    }
  } catch {
    /* préférence illisible : onglets par défaut */
  }
  try {
    const legacy = storage.getItem(LEGACY_LAYOUT_KEY);
    const layouts = legacy ? JSON.parse(legacy) : null;
    if (layouts && typeof layouts === 'object' && !Array.isArray(layouts)) return defaultTabsState(layouts as Record<string, unknown>);
  } catch {
    /* ignorée */
  }
  return defaultTabsState();
}

export function saveTabsState(st: WorkspaceTabsState, storage: TabsStorage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(TABS_STORAGE_KEY, JSON.stringify(st));
  } catch {
    /* stockage plein ou indisponible */
  }
}

// ------------------------------------------------------------------ état vivant et liaison avec le store

/** Onglets d'espaces de travail de CET utilisateur. */
export const workspaceTabs = createStore<WorkspaceTabsState>(() => loadTabsState());

export function useWorkspaceTabs<T>(sel: (s: WorkspaceTabsState) => T): T {
  return useStore(workspaceTabs, sel);
}

/** Onglet actif (toujours défini : la liste n'est jamais vide). */
export function activeTab(st: WorkspaceTabsState = workspaceTabs.getState()): WorkspaceTab {
  return st.tabs.find((t) => t.id === st.active) ?? st.tabs[0];
}

/** Remplace l'état des onglets ; si l'onglet actif change, ses réglages sont appliqués. */
export function commitTabs(next: WorkspaceTabsState): void {
  const prev = workspaceTabs.getState();
  if (next === prev) return;
  if (next.active !== prev.active) {
    workspaceTabs.setState({ tabs: next.tabs, active: prev.active }, true);
    activateTab(next.active);
  } else {
    workspaceTabs.setState(next, true);
  }
}

/** Modifie la disposition (tailles des zones) d'un onglet. */
export function updateTabLayout(id: string, fn: (cur: AreaLayout) => AreaLayout): void {
  const st = workspaceTabs.getState();
  const tab = st.tabs.find((t) => t.id === id);
  if (tab) workspaceTabs.setState(setTabLayout(st, id, fn(tab.layout)), true);
}

function currentView(): WorkspaceView {
  const s = store.getState();
  return { shading: s.shading, showToolbar: s.showToolbar, bottomEditor: s.bottomEditor, propertiesTab: s.propertiesTab };
}

/** Vrai pendant l'application des réglages d'un onglet : le suivi du store est suspendu. */
let applying = false;

function applyTabView(tab: WorkspaceTab, fromUser: boolean): void {
  const v = tab.view;
  const s = store.getState();
  applying = true;
  try {
    store.setState({ workspace: tab.id, showToolbar: v.showToolbar, bottomEditor: v.bottomEditor, ...(v.propertiesTab ? { propertiesTab: v.propertiesTab } : {}) });
    // L'ombrage passe par l'opérateur s'il existe (il peut prévenir le moteur), sinon directement.
    if (v.shading !== s.shading) runOp('view.shading', { mode: v.shading }, () => store.setState({ shading: v.shading }));
  } finally {
    applying = false;
  }
  // Modélisation : on entre en mode édition sur l'objet actif s'il s'agit d'un maillage.
  if (fromUser && tab.preset === 'modeling' && s.mode === 'object' && s.activeId) {
    const obj = getApp().doc.getObject(s.activeId);
    if (obj?.type === 'mesh') runOp('object.mode_toggle');
  }
}

/** Active un onglet : les réglages de l'onglet quitté sont mémorisés, ceux de l'onglet visé appliqués. */
export function activateTab(id: string): void {
  let st = workspaceTabs.getState();
  const tab = st.tabs.find((t) => t.id === id);
  if (!tab) return;
  if (st.active !== id) st = setTabView(st, st.active, currentView());
  workspaceTabs.setState({ tabs: st.tabs, active: id }, true);
  applyTabView(tab, true);
}

/** Rétablit le modèle d'origine d'un onglet ; s'il est actif, ses réglages sont réappliqués. */
export function resetWorkspaceTab(id: string): void {
  const next = resetTab(workspaceTabs.getState(), id);
  workspaceTabs.setState(next, true);
  if (next.active === id) applyTabView(activeTab(next), false);
}

/** Opérateurs des espaces de travail (raccourcis Ctrl+PgPréc / Ctrl+PgSuiv). */
function registerWorkspaceOps(app: AppContext): void {
  if (app.ops.get('screen.workspace_cycle')) return;
  app.ops.register({
    id: 'screen.workspace_cycle',
    label: 'Espace de travail suivant / précédent',
    description: 'Active l’onglet d’espace de travail suivant (args { dir: 1 }) ou précédent (dir: -1)',
    defaults: { dir: 1 },
    undoable: false,
    poll: () => workspaceTabs.getState().tabs.length > 1,
    exec(_app, inv) {
      const dir = inv.args.dir === -1 ? -1 : 1;
      commitTabs(cycleTab(workspaceTabs.getState(), dir));
    },
  });
}

/**
 * Branche les onglets sur l'application (appelé une fois par la barre
 * supérieure) : applique l'onglet enregistré, suit les réglages du store pour
 * l'onglet actif, enregistre chaque changement, déclare les opérateurs.
 * Renvoie la fonction de débranchement.
 */
export function installWorkspaceTabs(app: AppContext): () => void {
  registerWorkspaceOps(app);
  applyTabView(activeTab(), false);
  const offStore = store.subscribe((s, p) => {
    if (applying) return;
    if (s.shading === p.shading && s.showToolbar === p.showToolbar && s.bottomEditor === p.bottomEditor && s.propertiesTab === p.propertiesTab) return;
    const st = workspaceTabs.getState();
    if (s.workspace !== st.active) return;
    const next = setTabView(st, st.active, currentView());
    if (next !== st) workspaceTabs.setState(next, true);
  });
  const offSave = workspaceTabs.subscribe((st) => saveTabsState(st));
  return () => {
    offStore();
    offSave();
  };
}
