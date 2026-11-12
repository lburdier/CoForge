import type { NodeTreeKind } from '../doc/schema';

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

export type SocketType = 'float' | 'int' | 'bool' | 'vector' | 'color' | 'shader' | 'geometry' | 'string' | 'object' | 'material';

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
}

export interface NodePropDef {
  id: string;
  label: string;
  kind: 'enum' | 'bool' | 'float' | 'int' | 'string' | 'color' | 'ramp' | 'object' | 'material';
  default: unknown;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
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
  if (from === to) return true;
  const numeric: SocketType[] = ['float', 'int', 'bool', 'vector', 'color'];
  return numeric.includes(from) && numeric.includes(to);
}
