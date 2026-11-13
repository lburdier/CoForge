import type { NodeTreeKind } from '../doc/schema';

export type { NodeTreeKind };

/**
 * CONTRAT des systèmes nodaux (shader et géométrie).
 *
 * Un catalogue de types de nœuds est enregistré par système (`registerNodeTypes`). L'éditeur de
 * nœuds (src/ui/nodes) ne connaît que ce catalogue : il n'a aucune connaissance des évaluateurs.
 * Les évaluateurs (compilation de shader, exécution des nœuds de géométrie) lisent le même
 * catalogue et les données `NodeTreeData` du document.
 *
 * Les identifiants de types reprennent ceux de Blender quand un équivalent existe
 * ('ShaderNodeBsdfPrincipled', 'ShaderNodeTexNoise', 'GeometryNodeMeshCube'…), ce qui sert aussi
 * à l'API Python.
 */

export type SocketType = 'float' | 'int' | 'bool' | 'vector' | 'color' | 'shader' | 'geometry' | 'string' | 'object' | 'material' | 'any';

export interface SocketDef {
  /** Identifiant stable (clé dans `NodeData.inputs` et dans les liens). */
  id: string;
  /** Libellé affiché, en français. */
  label: string;
  type: SocketType;
  /** Valeur par défaut d'une entrée non connectée (nombre, booléen, [x, y, z], '#rrggbb', chaîne, null). */
  default?: unknown;
  min?: number;
  max?: number;
  /** Entrée sans champ de saisie (ne vaut que par son lien). */
  hideValue?: boolean;
  /** Sous-panneau repliable du nœud (« Sous-surface », « Vernis »…), comme dans Blender 4. */
  panel?: string;
  /** Socket affiché seulement si la fonction renvoie true (selon les propriétés du nœud). */
  visible?: (props: Record<string, unknown>) => boolean;
  /** Pas : 0.01 par défaut pour un flottant. */
  step?: number;
  /** Sous-type d'affichage : facteur (curseur 0..1), angle (degrés), distance. */
  subtype?: 'factor' | 'angle' | 'distance' | 'percentage';
}

export interface NodePropDef {
  id: string;
  label: string;
  /**
   * 'curve' : courbes (Courbes RVB / vectorielles / flottante), valeur `CurveMapping` (voir
   * src/core/nodes/shader/factories.ts) ; 'image' : identifiant d'image du document ou null
   * (API dans src/core/nodes/shader/images.ts). Ces deux genres sont des ajouts de la vague 3.
   */
  kind: 'enum' | 'bool' | 'float' | 'int' | 'string' | 'color' | 'ramp' | 'object' | 'material' | 'curve' | 'image';
  default: unknown;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  /** Propriété affichée seulement si la fonction renvoie true. */
  visible?: (props: Record<string, unknown>) => boolean;
}

export interface NodeTypeDef {
  id: string;
  label: string;
  /** Catégorie du menu Ajouter (Maj+A) : « Entrée », « Texture », « Couleur », « Convertisseur », « Shader »… */
  category: string;
  inputs: SocketDef[];
  outputs: SocketDef[];
  props?: NodePropDef[];
  /** Couleur d'en-tête '#rrggbb' (sinon celle de la catégorie). */
  color?: string;
  /** Largeur par défaut en px. */
  width?: number;
  /** Description courte (infobulle du menu Ajouter). */
  description?: string;
  /** Nœud de disposition (cadre, redirection) : ni calcul, ni en-tête de catégorie. */
  layout?: 'frame' | 'reroute';
  /**
   * Rendu temps réel (et aperçu) : 'full' = comme Blender (défaut si absent), 'approx' = approché,
   * 'none' = sans équivalent dans un rastériseur (valeur neutre). `note` dit pourquoi, en français.
   */
  support?: 'full' | 'approx' | 'none';
  note?: string;
}

const catalogs: Record<NodeTreeKind, Map<string, NodeTypeDef>> = { shader: new Map(), geometry: new Map() };

/** Enregistre (ou remplace) des types de nœuds pour un système. */
export function registerNodeTypes(kind: NodeTreeKind, defs: NodeTypeDef[]): void {
  for (const d of defs) catalogs[kind].set(d.id, d);
}

export function nodeType(kind: NodeTreeKind, id: string): NodeTypeDef | null {
  return catalogs[kind].get(id) ?? null;
}

export function nodeTypes(kind: NodeTreeKind): NodeTypeDef[] {
  return [...catalogs[kind].values()];
}

/** Types de sockets connectables : conversions implicites admises, comme dans Blender. */
export function socketsCompatible(from: SocketType, to: SocketType): boolean {
  if (from === to || from === 'any' || to === 'any') return true;
  const numeric: SocketType[] = ['float', 'int', 'bool', 'vector', 'color'];
  return numeric.includes(from) && numeric.includes(to);
}

/** Sockets visibles d'une liste selon les propriétés d'un nœud. */
export function visibleSockets(list: SocketDef[], props: Record<string, unknown>): SocketDef[] {
  return list.filter((s) => !s.visible || s.visible(props));
}

/** Valeurs initiales des entrées et propriétés d'un type de nœud. */
export function nodeDefaults(def: NodeTypeDef): { inputs: Record<string, unknown>; props: Record<string, unknown> } {
  const inputs: Record<string, unknown> = {};
  for (const s of def.inputs) if (s.default !== undefined) inputs[s.id] = cloneValue(s.default);
  const props: Record<string, unknown> = {};
  for (const p of def.props ?? []) props[p.id] = cloneValue(p.default);
  return { inputs, props };
}

function cloneValue(v: unknown): unknown {
  return Array.isArray(v) ? v.map(cloneValue) : v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
}
