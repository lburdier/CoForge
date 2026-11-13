import type { Matrix4 } from 'three';
import type { MeshData, MeshDelta, ModifierData, NodeTreeData, Vec3 } from '../doc/schema';

/**
 * Contrat du noyau de modélisation (src/core/mesh).
 *
 * Tout ici est PUR : pas de DOM, pas de Yjs, pas d'état global. Les fonctions
 * reçoivent un instantané MeshData (en lecture seule) et renvoient soit un
 * nouveau MeshData, soit un MeshDelta à appliquer au document
 * (SceneDoc.applyMeshDelta). Les modules doivent tourner aussi bien dans le
 * navigateur que dans Node (tests).
 *
 * Les signatures marquées « CONTRAT » sont consommées par le moteur 3D et les
 * outils : elles doivent être exportées telles quelles par src/core/mesh/index.ts.
 */

/** Sélection d'éléments (structurellement identique à EditSelection du store). */
export interface MeshSelection {
  verts: ReadonlySet<string>;
  edges: ReadonlySet<string>;
  faces: ReadonlySet<string>;
}

/** Résultat d'une opération d'édition. */
export interface MeshOpResult {
  /** Modification à appliquer au document. */
  delta: MeshDelta;
  /** Sélection à adopter après l'opération (absente = inchangée). */
  select?: { verts: string[]; edges: string[]; faces: string[] };
}

// ------------------------------------------------------------------ CONTRAT : géométrie d'affichage

export interface TriangulateOptions {
  smooth: boolean;
  /** Angle (degrés) au-delà duquel une arête reste vive quand smooth = true. */
  autoSmoothAngle: number;
}

/** Géométrie prête pour three.js, non indexée. */
export interface RenderMesh {
  /** 9 flottants par triangle. */
  positions: Float32Array;
  /** Normales par sommet de triangle (plates ou lissées selon les options). */
  normals: Float32Array;
  /** Identifiant de la face d'origine de chaque triangle (longueur = nombre de triangles). */
  triFace: string[];
  /** Arêtes polygonales (sans les diagonales de triangulation) : 6 flottants par arête. */
  edgePositions: Float32Array;
  /** Clé (edgeKey) de chaque arête de edgePositions. */
  edgeKeys: string[];
}

/** CONTRAT : `triangulate(mesh, opts)` : géométrie d'affichage d'un maillage (polygones concaves gérés). */
export type TriangulateFn = (mesh: MeshData, opts: TriangulateOptions) => RenderMesh;

// ------------------------------------------------------------------ CONTRAT : modificateurs

export interface ModifierContext {
  /**
   * Maillage ÉVALUÉ d'un autre objet (opérande booléen), avec la matrice qui
   * amène ses coordonnées locales dans l'espace local de l'objet en cours
   * d'évaluation. Renvoie null si l'objet n'existe pas ou n'est pas un maillage.
   */
  getOperand(objectId: string): { mesh: MeshData; toLocal: Matrix4 } | null;
  /** Arbre de nœuds de géométrie (modificateur « Nœuds de géométrie »), null s'il n'existe pas. */
  getNodeTree?(treeId: string): Pick<NodeTreeData, 'nodes' | 'links' | 'kind'> | null;
}

/**
 * CONTRAT : `evaluateModifiers(mesh, modifiers, ctx)` : applique la pile de
 * modificateurs activés, dans l'ordre, et renvoie le maillage résultant (le
 * maillage d'entrée lui-même si la pile est vide). Ne lève jamais d'exception :
 * un modificateur qui échoue est ignoré.
 * Les identifiants du résultat sont quelconques mais DÉTERMINISTES (mêmes entrées → mêmes identifiants).
 */
export type EvaluateModifiersFn = (mesh: MeshData, modifiers: ModifierData[], ctx: ModifierContext) => MeshData;

/** CONTRAT : `meshBounds(mesh)` : boîte englobante, null si le maillage est vide. */
export type MeshBoundsFn = (mesh: MeshData) => { min: Vec3; max: Vec3 } | null;
