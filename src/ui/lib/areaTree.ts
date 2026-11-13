/**
 * Arbre des zones d'un espace de travail, comme les « areas » de Blender : chaque nœud est soit
 * une zone (un éditeur), soit une division en deux (côte à côte ou empilées) avec la part du
 * premier enfant. Logique pure (aucune dépendance à React ni au DOM) : diviser, fusionner,
 * échanger, changer d'éditeur, calculer les rectangles à l'écran, relire un arbre enregistré.
 */

/** Éditeurs disponibles dans une zone. */
export const EDITOR_TYPES = [
  'view3d',
  'image',
  'uv',
  'geometry_nodes',
  'compositor',
  'shader_nodes',
  'sequencer',
  'dopesheet',
  'timeline',
  'graph',
  'nla',
  'text',
  'console',
  'info',
  'outliner',
  'properties',
  'files',
  'spreadsheet',
  'preferences',
] as const;
export type EditorType = (typeof EDITOR_TYPES)[number];

/** Éditeurs qui ne peuvent exister qu'une fois (le moteur n'a qu'un viewport 3D). */
export const UNIQUE_EDITORS: ReadonlySet<EditorType> = new Set<EditorType>();
/**
 * Plusieurs viewports 3D sont possibles (comme dans Blender) ; au-delà de ce nombre, les suivants
 * sont relus comme des outliners (chaque viewport supplémentaire a un coût de rendu).
 */
export const MAX_VIEW3D = 4;

export interface AreaLeaf {
  kind: 'area';
  id: string;
  editor: EditorType;
}

/**
 * Division : `row` = enfants côte à côte (bord vertical), `col` = enfants empilés (bord
 * horizontal). `ratio` = part du premier enfant (`a`, à gauche ou en haut).
 */
export interface AreaSplit {
  kind: 'split';
  id: string;
  dir: 'row' | 'col';
  ratio: number;
  a: AreaNode;
  b: AreaNode;
}

export type AreaNode = AreaLeaf | AreaSplit;

export const MIN_RATIO = 0.03;
export const MAX_RATIO = 1 - MIN_RATIO;
const MAX_DEPTH = 24;
const MAX_AREAS = 48;

const clampRatio = (r: number) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, r));

// ------------------------------------------------------------------ construction

let seq = 0;
/** Identifiant de nœud inédit dans `tree` (si fourni). */
export function newAreaId(tree?: AreaNode | null): string {
  const taken = tree ? new Set(allNodes(tree).map((n) => n.id)) : new Set<string>();
  for (;;) {
    const id = `ar-${(Date.now() % 1e6).toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    if (!taken.has(id)) return id;
  }
}

export function area(editor: EditorType, id = newAreaId()): AreaLeaf {
  return { kind: 'area', id, editor };
}

export function split(dir: 'row' | 'col', ratio: number, a: AreaNode, b: AreaNode, id = newAreaId()): AreaSplit {
  return { kind: 'split', id, dir, ratio: clampRatio(ratio), a, b };
}

// ------------------------------------------------------------------ lecture

export function allNodes(tree: AreaNode): AreaNode[] {
  const out: AreaNode[] = [];
  const walk = (n: AreaNode) => {
    out.push(n);
    if (n.kind === 'split') {
      walk(n.a);
      walk(n.b);
    }
  };
  walk(tree);
  return out;
}

export function leaves(tree: AreaNode): AreaLeaf[] {
  return allNodes(tree).filter((n): n is AreaLeaf => n.kind === 'area');
}

export function findNode(tree: AreaNode, id: string): AreaNode | null {
  return allNodes(tree).find((n) => n.id === id) ?? null;
}

export function hasEditor(tree: AreaNode, editor: EditorType): boolean {
  return leaves(tree).some((l) => l.editor === editor);
}

/** Remplace le nœud `id` par le résultat de `fn` (copie sur le chemin, le reste est partagé). */
function replaceNode(tree: AreaNode, id: string, fn: (n: AreaNode) => AreaNode): AreaNode {
  if (tree.id === id) return fn(tree);
  if (tree.kind === 'area') return tree;
  const a = replaceNode(tree.a, id, fn);
  const b = replaceNode(tree.b, id, fn);
  return a === tree.a && b === tree.b ? tree : { ...tree, a, b };
}

// ------------------------------------------------------------------ opérations

/** Change la part du premier enfant d'une division. */
export function setRatio(tree: AreaNode, splitId: string, ratio: number): AreaNode {
  return replaceNode(tree, splitId, (n) => (n.kind === 'split' ? { ...n, ratio: clampRatio(ratio) } : n));
}

/** Nombre de zones affichant cet éditeur. */
export function countEditor(tree: AreaNode, editor: EditorType): number {
  return leaves(tree).filter((l) => l.editor === editor).length;
}

/** Éditeur donné à la nouvelle zone d'une division : le même, sauf s'il est unique. */
export function editorForCopy(editor: EditorType): EditorType {
  return UNIQUE_EDITORS.has(editor) ? 'outliner' : editor;
}

/**
 * Divise la zone `areaId` : `row` = côte à côte (division verticale), `col` = empilées (division
 * horizontale). L'ancienne zone garde la part `ratio` (à gauche / en haut), la nouvelle prend le
 * reste avec l'éditeur `editor` (par défaut : copie de l'éditeur divisé).
 */
export function splitArea(
  tree: AreaNode,
  areaId: string,
  dir: 'row' | 'col',
  ratio = 0.5,
  editor?: EditorType,
): { tree: AreaNode; newId: string | null } {
  const target = findNode(tree, areaId);
  if (!target || target.kind !== 'area' || leaves(tree).length >= MAX_AREAS) return { tree, newId: null };
  let ed = editor && !(UNIQUE_EDITORS.has(editor) && hasEditor(tree, editor)) ? editor : editorForCopy(target.editor);
  if (ed === 'view3d' && countEditor(tree, 'view3d') >= MAX_VIEW3D) ed = 'outliner';
  const newLeaf = area(ed, newAreaId(tree));
  // Les identifiants successifs diffèrent toujours (compteur), même entre eux.
  const s = split(dir, ratio, target, newLeaf, newAreaId(tree));
  return { tree: replaceNode(tree, areaId, () => s), newId: newLeaf.id };
}

/** Côté supprimé par une fusion : `b` (« vers la droite / le bas ») ou `a` (« vers la gauche / le haut »). */
export type JoinSide = 'a' | 'b';

/**
 * Une fusion n'est possible que si la zone absorbée est une zone simple (comme dans Blender, les
 * deux zones doivent partager le bord en entier).
 */
export function canJoin(tree: AreaNode, splitId: string, removed: JoinSide): boolean {
  const s = findNode(tree, splitId);
  return !!s && s.kind === 'split' && s[removed].kind === 'area';
}

/** Fusionne à travers le bord de `splitId` : la zone `removed` disparaît, l'autre côté s'étend. */
export function joinAreas(tree: AreaNode, splitId: string, removed: JoinSide): AreaNode {
  if (!canJoin(tree, splitId, removed)) return tree;
  return replaceNode(tree, splitId, (n) => (n.kind === 'split' ? (removed === 'a' ? n.b : n.a) : n));
}

/** Échange les deux côtés d'un bord (les tailles suivent le contenu). */
export function swapAreas(tree: AreaNode, splitId: string): AreaNode {
  return replaceNode(tree, splitId, (n) => (n.kind === 'split' ? { ...n, a: n.b, b: n.a, ratio: clampRatio(1 - n.ratio) } : n));
}

/**
 * Change l'éditeur d'une zone. Pour un éditeur unique déjà affiché ailleurs (viewport 3D), les
 * deux zones échangent leurs éditeurs.
 */
export function setAreaEditor(tree: AreaNode, areaId: string, editor: EditorType): AreaNode {
  const target = findNode(tree, areaId);
  if (!target || target.kind !== 'area' || target.editor === editor) return tree;
  if (editor === 'view3d' && countEditor(tree, 'view3d') >= MAX_VIEW3D) return tree;
  let next = tree;
  if (UNIQUE_EDITORS.has(editor)) {
    const other = leaves(tree).find((l) => l.editor === editor && l.id !== areaId);
    if (other) next = replaceNode(next, other.id, (n) => ({ ...(n as AreaLeaf), editor: target.editor }));
  }
  return replaceNode(next, areaId, (n) => ({ ...(n as AreaLeaf), editor }));
}

// ------------------------------------------------------------------ géométrie

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AreaRect extends Rect {
  id: string;
  editor: EditorType;
}

/** Bord entre les deux enfants d'une division (poignée de redimensionnement). */
export interface EdgeRect extends Rect {
  splitId: string;
  dir: 'row' | 'col';
  /** Taille de la division le long de son axe (px), pour convertir un glissement en part. */
  span: number;
  /** Position de départ de la division le long de son axe (px). */
  start: number;
}

/**
 * Rectangles des zones et des bords dans `rect`. `gap` = épaisseur des bords, `min` = taille
 * minimale souhaitée d'une zone (respectée quand la place le permet).
 */
export function layoutAreas(tree: AreaNode, rect: Rect, gap = 4, min = 28): { areas: AreaRect[]; edges: EdgeRect[] } {
  const areas: AreaRect[] = [];
  const edges: EdgeRect[] = [];
  const walk = (n: AreaNode, r: Rect) => {
    if (n.kind === 'area') {
      areas.push({ id: n.id, editor: n.editor, ...r });
      return;
    }
    const row = n.dir === 'row';
    const span = row ? r.w : r.h;
    const start = row ? r.x : r.y;
    const avail = Math.max(0, span - gap);
    let sa = Math.round(avail * n.ratio);
    if (avail >= 2 * min) sa = Math.min(avail - min, Math.max(min, sa));
    const sb = avail - sa;
    if (row) {
      walk(n.a, { x: r.x, y: r.y, w: sa, h: r.h });
      edges.push({ splitId: n.id, dir: n.dir, x: r.x + sa, y: r.y, w: gap, h: r.h, span, start });
      walk(n.b, { x: r.x + sa + gap, y: r.y, w: sb, h: r.h });
    } else {
      walk(n.a, { x: r.x, y: r.y, w: r.w, h: sa });
      edges.push({ splitId: n.id, dir: n.dir, x: r.x, y: r.y + sa, w: r.w, h: gap, span, start });
      walk(n.b, { x: r.x, y: r.y + sa + gap, w: r.w, h: sb });
    }
  };
  walk(tree, rect);
  return { areas, edges };
}

/** Zone contenant le point (x, y), ou null. */
export function areaAt(areas: readonly AreaRect[], x: number, y: number): AreaRect | null {
  return areas.find((a) => x >= a.x && x < a.x + a.w && y >= a.y && y < a.y + a.h) ?? null;
}

// ------------------------------------------------------------------ dispositions par défaut

/** Tailles d'origine d'un modèle d'espace de travail (px), converties en parts. */
export interface LegacySizes {
  rightW: number;
  outlinerH: number;
  bottomH?: number;
}

/** Éditeur du bas de chaque modèle d'espace de travail. */
const PRESET_BOTTOM: Record<string, EditorType | undefined> = {
  shading: 'shader_nodes',
  animation: 'dopesheet',
  geometry: 'geometry_nodes',
};

/** Taille de référence pour convertir les tailles en px des modèles en parts. */
const REF_W = 1600;
const REF_H = 860;
const TIMELINE_H = 130;

/**
 * Disposition d'origine d'un modèle : viewport 3D (avec l'éditeur du bas du modèle) et frise à
 * gauche, outliner au-dessus des propriétés à droite.
 */
export function defaultAreaTree(presetId: string, sizes: LegacySizes): AreaNode {
  // Identifiants fixes : l'arbre d'origine est reconstruit à chaque lecture tant que l'onglet n'a
  // pas d'arbre enregistré, et une action doit retrouver la zone visée d'une lecture à l'autre.
  const bottom = PRESET_BOTTOM[presetId];
  const mainH = REF_H;
  const timelineRatio = 1 - TIMELINE_H / mainH;
  let top: AreaNode = area('view3d', 'd-view3d');
  if (presetId === 'geometry') {
    // Comme dans Blender : tableur à gauche du viewport, nœuds de géométrie dessous.
    top = split('row', 0.32, area('spreadsheet', 'd-side'), top, 'd-upper');
  } else if (presetId === 'scripting') {
    // Viewport et éditeur de texte côte à côte, console et Info dessous.
    const upper = split('row', 0.45, top, area('text', 'd-text'), 'd-upper');
    const lower = split('row', 0.6, area('console', 'd-console'), area('info', 'd-info'), 'd-lower');
    top = split('col', 0.62, upper, lower, 'd-top');
  }
  if (bottom) {
    const upper = mainH * timelineRatio;
    const bottomH = sizes.bottomH ?? 300;
    top = split('col', 1 - bottomH / upper, top, area(bottom, 'd-bottom'), 'd-top');
  }
  const main = split('col', timelineRatio, top, area('timeline', 'd-timeline'), 'd-main');
  const right = split('col', sizes.outlinerH / REF_H, area('outliner', 'd-outliner'), area('properties', 'd-properties'), 'd-right');
  return split('row', 1 - sizes.rightW / REF_W, main, right, 'd-root');
}

// ------------------------------------------------------------------ relecture validée

/**
 * Relit un arbre venu du stockage local : structure, éditeurs connus, parts bornées,
 * identifiants uniques, au plus un viewport 3D. Renvoie null si l'arbre est inutilisable.
 */
export function sanitizeAreaTree(raw: unknown): AreaNode | null {
  const ids = new Set<string>();
  let count = 0;
  let view3d = 0;
  const read = (v: unknown, depth: number): AreaNode | null => {
    if (!v || typeof v !== 'object' || depth > MAX_DEPTH) return null;
    const o = v as Record<string, unknown>;
    if (typeof o.id !== 'string' || !o.id || o.id.length > 64 || ids.has(o.id)) return null;
    ids.add(o.id);
    if (o.kind === 'area') {
      if (++count > MAX_AREAS) return null;
      let editor = (EDITOR_TYPES as readonly string[]).includes(o.editor as string) ? (o.editor as EditorType) : 'outliner';
      if (editor === 'view3d') {
        if (view3d >= MAX_VIEW3D) editor = 'outliner';
        else view3d++;
      }
      return { kind: 'area', id: o.id, editor };
    }
    if (o.kind !== 'split' || (o.dir !== 'row' && o.dir !== 'col')) return null;
    const ratio = typeof o.ratio === 'number' && Number.isFinite(o.ratio) ? clampRatio(o.ratio) : 0.5;
    const a = read(o.a, depth + 1);
    const b = read(o.b, depth + 1);
    if (!a || !b) return null;
    return { kind: 'split', id: o.id, dir: o.dir, ratio, a, b };
  };
  return read(raw, 0);
}
