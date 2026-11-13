import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { UpdateStatus } from './platform';

/**
 * Store LOCAL de l'application (zustand) : tout ce qui est propre à cet
 * utilisateur et n'est pas dans le document partagé : mode, sélection, options
 * d'affichage, état de la session réseau, état de l'interface.
 *
 * Règle : les ensembles (Set) sont immuables : on remplace toujours l'ensemble
 * par un nouveau, on ne le modifie jamais en place.
 */

export type InteractionMode = 'object' | 'edit';
export type SelectMode = 'vert' | 'edge' | 'face';
export type ShadingMode = 'wireframe' | 'solid' | 'material' | 'rendered';
export type ToolId = 'select' | 'move' | 'rotate' | 'scale';
/**
 * Espace de travail actif : identifiant d'un onglet (src/ui/lib/workspaces.ts). Les onglets par
 * défaut portent l'identifiant de leur modèle ; les onglets ajoutés par l'utilisateur, un identifiant libre.
 */
export type Workspace = 'layout' | 'modeling' | 'shading' | 'rendering' | 'geometry' | 'scripting' | 'animation' | (string & {});
export type PivotMode = 'median' | 'active' | 'cursor' | 'individual';
export type SnapTarget = 'grid' | 'vertex';
export type Orientation = 'global' | 'local';
export type PropertiesTab =
  | 'tool'
  | 'render'
  | 'output'
  | 'viewlayer'
  | 'scene'
  | 'world'
  | 'collection'
  | 'object'
  | 'modifiers'
  | 'particles'
  | 'physics'
  | 'constraints'
  | 'data'
  | 'material'
  | 'texture';

/** Sélection d'éléments en mode édition (arêtes = clés edgeKey(a,b)). */
export interface EditSelection {
  verts: ReadonlySet<string>;
  edges: ReadonlySet<string>;
  faces: ReadonlySet<string>;
}

export const EMPTY_EDIT_SELECTION: EditSelection = { verts: new Set(), edges: new Set(), faces: new Set() };

export interface PeerInfo {
  /** Identifiant de connexion (clientID Yjs), unique dans la session. */
  clientId: number;
  userId: string;
  name: string;
  color: string;
}

export type SessionStatus = 'offline' | 'connecting' | 'connected' | 'reconnecting';

export interface SessionState {
  status: SessionStatus;
  /** true si cette instance héberge le serveur de la session. */
  hosting: boolean;
  url: string | null;
  room: string | null;
  /** Adresses à communiquer aux invités quand on héberge (ex. ws://192.168.1.20:4455). */
  shareAddresses: string[];
  error: string | null;
  /** Autres utilisateurs connectés (sans soi-même). */
  peers: PeerInfo[];
}

export interface LocalUser {
  id: string;
  name: string;
  color: string;
}

export interface ModalState {
  opId: string;
  /** Texte d'aide affiché dans l'en-tête du viewport / la barre d'état pendant l'opération. */
  status: string;
}

export interface LastOpState {
  opId: string;
  label: string;
  args: Record<string, any>;
}

export interface RenderJobState {
  running: boolean;
  /** 0..1 */
  progress: number;
  samples: number;
  /** Image finale (data URL PNG) quand le rendu est terminé. */
  imageUrl: string | null;
  open: boolean;
}

export interface Overlays {
  grid: boolean;
  axes: boolean;
  wireframe: boolean;
  stats: boolean;
  /** Avatars et sélections des autres utilisateurs. */
  presence: boolean;
  lightsAndCameras: boolean;
}

export type DialogId = 'host' | 'join' | 'about' | 'shortcuts' | 'preferences' | 'rename' | 'chat' | 'import_report';

/** Travail long en cours (import d'un fichier, évaluation par Blender…) : l'interface affiche un voile et suspend les entrées. */
export interface BusyState {
  /** Ex. « Import de « scène.blend »… », « Évaluation par Blender 5.1… ». */
  text: string;
}

/** Ce qu'un import a produit, pour le dialogue « Rapport d'import » (`dialog: 'import_report'`). */
export interface ImportReport {
  fileName: string;
  /** 'append' : ajouté à la scène courante ; 'open' : ouvert comme nouvelle scène. */
  mode: 'append' | 'open';
  counts: { objects: number; meshes: number; lights: number; cameras: number; empties: number; materials: number; collections: number };
  /** Ce qui n'a pas pu être repris tel quel, une phrase par ligne. */
  warnings: string[];
  /**
   * Rôle du Blender installé dans cet import, ou null s'il n'était pas concerné (autre format,
   * navigateur, rien à évaluer). `used` : il a fourni géométrie finale ou conversion ; `missing` :
   * il aurait servi mais aucun n'est installé ; `failed` : il a échoué (`error`).
   */
  blender: { status: 'used' | 'missing' | 'failed'; version: string | null; error: string | null } | null;
  /** L'import a été écrit dans une session collaborative : visible par tous les participants. */
  shared: boolean;
}

/** Menu flottant ouvert à une position écran (px CSS, relatifs à la fenêtre). */
export interface PopupState {
  kind: 'context' | 'add' | 'delete' | 'search';
  x: number;
  y: number;
}

export interface AppState {
  /** Incrémenté à chaque remplacement du document (nouvelle scène, ouverture, connexion). */
  docEpoch: number;
  /** Chemin du fichier courant (Electron) ou null. */
  filePath: string | null;
  dirty: boolean;

  mode: InteractionMode;
  /** Objets sélectionnés (mode objet). */
  selection: ReadonlySet<string>;
  /** Objet actif (dernier sélectionné), c'est lui qu'on édite en mode édition. */
  activeId: string | null;
  selectMode: SelectMode;
  editSelection: EditSelection;

  tool: ToolId;
  pivot: PivotMode;
  orientation: Orientation;
  snap: boolean;
  /** Cible de l'aimantation : pas de grille, ou sommets des maillages de la scène. */
  snapTarget: SnapTarget;
  /** Pas de la grille d'aimantation en mètres. */
  snapIncrement: number;
  /** Curseur 3D (repère Z-up, mètres). */
  cursor3d: [number, number, number];

  shading: ShadingMode;
  overlays: Overlays;
  /** Le viewport regarde à travers la caméra active. */
  cameraView: boolean;
  /** Vue orthographique du viewport. */
  orthographic: boolean;
  xray: boolean;

  workspace: Workspace;
  showToolbar: boolean;
  showSidebar: boolean;
  propertiesTab: PropertiesTab;
  /** Éditeur affiché sous le viewport (identifiant de src/ui/lib/areas.ts) ou null. */
  bottomEditor: string | null;
  /** La vue caméra entraîne la caméra active quand on navigue (« Verrouiller la caméra à la vue »). */
  lockCameraToView: boolean;

  user: LocalUser;
  session: SessionState;
  /** Utilisateur distant dont on suit la caméra (clientId) ou null. */
  followClientId: number | null;
  /** Utilisateur distant dont on suit la tête de lecture (clientId) ou null. */
  followPlaybackClientId: number | null;

  /** Boîte de dialogue ouverte. */
  dialog: DialogId | null;
  /** Menu flottant ouvert (contextuel, Ajouter, Supprimer, recherche F3). */
  popup: PopupState | null;

  modal: ModalState | null;
  lastOp: LastOpState | null;
  render: RenderJobState;
  /** Message transitoire affiché dans la barre d'état. */
  toast: { text: string; kind: 'info' | 'error'; time: number } | null;
  canUndo: boolean;
  canRedo: boolean;

  /** Travail long en cours, ou null. Tant qu'il n'est pas null, aucun autre import ne démarre. */
  busy: BusyState | null;
  /** Mises à jour automatiques de l'application (voir src/app/updates.ts). */
  update: UpdateStatus;
  /** Des fichiers sont en train d'être glissés au-dessus de la fenêtre. */
  dropActive: boolean;
  /** Rapport du dernier import qui a produit des avertissements. */
  importReport: ImportReport | null;

  // ---------------------------------------------------------------- animation (état LOCAL : chaque utilisateur a sa tête de lecture)
  /** Image courante de CET utilisateur (jamais écrite dans le document partagé). */
  frame: number;
  /** Lecture en cours : 1 avant, -1 arrière, 0 arrêt. */
  playing: 0 | 1 | -1;
  /** Auto-key (bouton rond de la timeline). */
  autoKey: boolean;
  /** Images clés sélectionnées (identifiants de clés). */
  keySelection: ReadonlySet<string>;
  /** Poignées sélectionnées dans l'éditeur de courbes : `${idClé}:l` ou `${idClé}:r`. */
  handleSelection: ReadonlySet<string>;
  /** Courbes masquées dans l'éditeur de courbes (clés de courbe). */
  hiddenCurves: ReadonlySet<string>;
  /** Les éditeurs d'animation ne montrent que les objets sélectionnés. */
  animOnlySelected: boolean;
  /** Éditeur affiché dans la zone d'animation du bas : frise, feuille d'exposition, courbes. */
  animEditor: AnimEditorId;
  /** Éditeur de courbes : courbes normalisées entre -1 et 1. */
  graphNormalize: boolean;
  /** Menu « Insérer une image clé » (I) ouvert à une position écran, ou null. */
  keyframeMenu: { x: number; y: number } | null;

  /**
   * Types d'objets sélectionnables dans le viewport (clic, rectangle, A), réglés dans les
   * filtres de l'outliner et dans l'en-tête du viewport. Préférence LOCALE, persistée.
   */
  objectTypeSelectable: Readonly<Record<ObjectTypeCategory, boolean>>;
}

export type AnimEditorId = 'timeline' | 'dopesheet' | 'graph';

// ------------------------------------------------------------------ types d'objets sélectionnables (préférence locale)

/** Catégories des filtres « Types d'objets » (comme Blender) ; 'other' : tout type non reconnu. */
export type ObjectTypeCategory = 'mesh' | 'camera' | 'light' | 'empty' | 'other';
export const OBJECT_TYPE_CATEGORIES: readonly ObjectTypeCategory[] = ['mesh', 'camera', 'light', 'empty', 'other'];
const TYPE_SELECTABLE_KEY = 'coforge.objectTypeSelectable';

export function objectTypeCategory(type: unknown): ObjectTypeCategory {
  return type === 'mesh' || type === 'camera' || type === 'light' || type === 'empty' ? type : 'other';
}

/** Ce type d'objet est-il sélectionnable dans le viewport d'après les préférences locales ? */
export function isTypeSelectable(state: Pick<AppState, 'objectTypeSelectable'>, type: unknown): boolean {
  return state.objectTypeSelectable?.[objectTypeCategory(type)] !== false;
}

function loadTypeSelectable(): Record<ObjectTypeCategory, boolean> {
  const out = { mesh: true, camera: true, light: true, empty: true, other: true };
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(TYPE_SELECTABLE_KEY) ?? 'null');
    if (raw && typeof raw === 'object') for (const k of OBJECT_TYPE_CATEGORIES) if (typeof raw[k] === 'boolean') out[k] = raw[k];
  } catch {
    /* stockage indisponible ou valeur illisible */
  }
  return out;
}

export function setObjectTypeSelectable(patch: Partial<Record<ObjectTypeCategory, boolean>>): void {
  const next = { ...store.getState().objectTypeSelectable, ...patch };
  store.setState({ objectTypeSelectable: next });
  try {
    globalThis.localStorage?.setItem(TYPE_SELECTABLE_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

const USER_KEY = 'coforge.user';
const PALETTE = ['#f5a623', '#4fc3f7', '#ef5350', '#66bb6a', '#ab47bc', '#ffee58', '#26c6da', '#ff7043', '#ec407a', '#9ccc65'];

function loadUser(): LocalUser {
  try {
    const raw = globalThis.localStorage?.getItem(USER_KEY);
    if (raw) {
      const u = JSON.parse(raw);
      if (u && typeof u.id === 'string' && typeof u.name === 'string' && typeof u.color === 'string') return u;
    }
  } catch {
    /* stockage indisponible */
  }
  const id = Math.random().toString(36).slice(2, 10);
  const user = { id, name: `Artiste-${id.slice(0, 3).toUpperCase()}`, color: PALETTE[Math.floor(Math.random() * PALETTE.length)] };
  try {
    globalThis.localStorage?.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    /* ignore */
  }
  return user;
}

export const initialState = (): AppState => ({
  docEpoch: 0,
  filePath: null,
  dirty: false,
  mode: 'object',
  selection: new Set(),
  activeId: null,
  selectMode: 'vert',
  editSelection: EMPTY_EDIT_SELECTION,
  tool: 'select',
  pivot: 'median',
  orientation: 'global',
  snap: false,
  snapTarget: 'grid',
  snapIncrement: 0.25,
  cursor3d: [0, 0, 0],
  shading: 'solid',
  overlays: { grid: true, axes: true, wireframe: false, stats: true, presence: true, lightsAndCameras: true },
  cameraView: false,
  orthographic: false,
  xray: false,
  workspace: 'layout',
  showToolbar: true,
  showSidebar: false,
  propertiesTab: 'object',
  bottomEditor: null,
  lockCameraToView: false,
  user: loadUser(),
  session: { status: 'offline', hosting: false, url: null, room: null, shareAddresses: [], error: null, peers: [] },
  followClientId: null,
  followPlaybackClientId: null,
  dialog: null,
  popup: null,
  modal: null,
  lastOp: null,
  render: { running: false, progress: 0, samples: 0, imageUrl: null, open: false },
  toast: null,
  canUndo: false,
  canRedo: false,
  busy: null,
  update: { state: 'disabled' },
  dropActive: false,
  importReport: null,
  frame: 1,
  playing: 0,
  autoKey: false,
  keySelection: new Set(),
  handleSelection: new Set(),
  hiddenCurves: new Set(),
  animOnlySelected: true,
  animEditor: 'timeline',
  graphNormalize: false,
  keyframeMenu: null,
  objectTypeSelectable: loadTypeSelectable(),
});

export const store = createStore<AppState>(() => initialState());

export type AppStore = typeof store;

/** Hook React : `const mode = useApp(s => s.mode)`. */
export function useApp<T>(selector: (s: AppState) => T): T {
  return useStore(store, selector);
}

// ------------------------------------------------------------------ actions utilitaires

export function setUser(patch: Partial<LocalUser>): void {
  const user = { ...store.getState().user, ...patch };
  store.setState({ user });
  try {
    globalThis.localStorage?.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    /* ignore */
  }
}

/** Remplace la sélection d'objets. `active` par défaut = dernier de la liste. */
export function setSelection(ids: Iterable<string>, active?: string | null): void {
  const selection = new Set(ids);
  let activeId = active === undefined ? ([...selection].pop() ?? null) : active;
  if (activeId && !selection.has(activeId)) activeId = [...selection].pop() ?? null;
  store.setState({ selection, activeId });
}

export function setEditSelection(sel: Partial<EditSelection>): void {
  const cur = store.getState().editSelection;
  store.setState({
    editSelection: {
      verts: sel.verts ?? cur.verts,
      edges: sel.edges ?? cur.edges,
      faces: sel.faces ?? cur.faces,
    },
  });
}

export function toast(text: string, kind: 'info' | 'error' = 'info'): void {
  store.setState({ toast: { text, kind, time: Date.now() } });
}

/** Affiche (texte) ou retire (null) l'état « occupé ». */
export function setBusy(text: string | null): void {
  const current = store.getState().busy;
  if (text === null ? current === null : current?.text === text) return;
  store.setState({ busy: text === null ? null : { text } });
}

export function patchSession(patch: Partial<SessionState>): void {
  store.setState({ session: { ...store.getState().session, ...patch } });
}

export function patchRender(patch: Partial<RenderJobState>): void {
  store.setState({ render: { ...store.getState().render, ...patch } });
}

export function setOverlay<K extends keyof Overlays>(key: K, value: Overlays[K]): void {
  store.setState({ overlays: { ...store.getState().overlays, [key]: value } });
}

/** Déplace la tête de lecture LOCALE (arrondie au centième d'image). */
export function setFrame(frame: number): void {
  if (!Number.isFinite(frame)) return;
  const f = Math.round(frame * 100) / 100;
  if (f !== store.getState().frame) store.setState({ frame: f });
}

/** Remplace la sélection d'images clés (et, facultativement, de poignées). */
export function setKeySelection(keys: Iterable<string>, handles: Iterable<string> = []): void {
  store.setState({ keySelection: new Set(keys), handleSelection: new Set(handles) });
}
