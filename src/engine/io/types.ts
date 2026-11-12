import type { Matrix4 } from 'three';
import type { MaterialData, MeshData } from '../../core/doc/schema';

/** Un objet à exporter : maillage évalué (repère local, Z-up) et sa matrice monde. */
export interface ExportItem {
  name: string;
  mesh: MeshData;
  matrixWorld: Matrix4;
  material: MaterialData | null;
  smooth: boolean;
  autoSmoothAngle: number;
}

/**
 * Maillage évalué par Blender lui-même (pont Electron, voir electron/blenderBridge.ts) pour un
 * objet que le lecteur natif ne sait pas reconstruire : courbe, texte, métaballe, nœuds de
 * géométrie, modificateur non pris en charge… Repère LOCAL de l'objet, Z vers le haut.
 */
export interface BlendEvalMesh {
  /** Positions à plat (x, y, z…). */
  positions: number[];
  /** Polygones (indices de sommets), n-gones conservés. */
  polygons: number[][];
  /** Emplacement de matériau par polygone. */
  slots?: number[];
  /** Nom du matériau de chaque emplacement (null = vide). */
  materials?: (string | null)[];
  smooth?: boolean;
}

export interface BlendEvalRequest {
  /** Noms (Blender) des objets dont on veut le maillage final. */
  objects: string[];
  /**
   * Noms des matériaux dont la couleur de base est pilotée par une texture image : CoForge n'a
   * pas de textures, on en demande la couleur moyenne pour garder l'aspect général.
   */
  materials?: string[];
}

export interface BlendEvalResult {
  /** Clé : nom de l'objet dans Blender. */
  meshes: Record<string, BlendEvalMesh>;
  /** Couleur moyenne '#rrggbb' de la texture de couleur de base, par nom de matériau. */
  materialColors?: Record<string, string>;
  /** Objets bien évalués par Blender mais sans aucune face (volume, nuage de points, nœuds vides…). */
  empty?: string[];
  /** Version du Blender utilisé, ex. « 5.1.0 ». */
  blenderVersion?: string;
}

/** Fonction fournie par l'application quand un Blender est installé ; null si l'évaluation échoue. */
export type BlendEvaluator = (request: BlendEvalRequest) => Promise<BlendEvalResult | null>;

/**
 * Conversion complète du .blend en glTF binaire (.glb) par un Blender installé : repli quand le
 * lecteur natif ne sait pas lire le fichier. Renvoie null si aucun Blender n'est disponible.
 */
export type BlendConverter = () => Promise<ArrayBuffer | null>;
