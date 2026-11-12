import type { Camera, Group, Object3D, Vector3 } from 'three';
import type { ImportOptions } from './io/importFile';
import type { ImportResult } from './io/scene';
import type { SceneDoc } from '../core/doc/SceneDoc';
import type { MeshData, Vec3 } from '../core/doc/schema';
import type { SelectMode } from '../app/store';
import type { PresenceCamera } from '../net/api';

/**
 * Contrat du viewport 3D (implémenté dans src/engine/, fabrique `createViewport(app)`).
 *
 * Le moteur :
 *  - reflète le SceneDoc dans une scène three.js (repère Z-up) et se met à jour
 *    tout seul en écoutant les événements du document ;
 *  - lit le store (mode, sélection, shading, overlays…) et s'y abonne ;
 *  - gère SEUL la navigation (orbite molette/bouton du milieu, pan, zoom, pavé numérique via les opérateurs view.*) ;
 *  - ne gère PAS le clic gauche ni le clavier : c'est le rôle des outils (src/tools), qui s'appuient sur l'API ci-dessous.
 *
 * Toutes les coordonnées écran sont en pixels CSS relatifs au coin haut-gauche du canvas.
 */

export type ViewDirection = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

export interface ElementHit {
  type: SelectMode;
  /** Identifiant de sommet, clé d'arête (edgeKey) ou identifiant de face. */
  id: string;
  /** Point d'impact en coordonnées MONDE. */
  point: Vec3;
}

export interface SurfaceHit {
  objectId: string;
  /** Point et normale en coordonnées monde. */
  point: Vec3;
  normal: Vec3;
}

export interface FinalRenderOptions {
  /** Par défaut : réglages de rendu de la scène. */
  width?: number;
  height?: number;
  samples?: number;
}

export interface IViewport {
  /** Insère le canvas dans `container` (qui dicte la taille, suivie par ResizeObserver) et démarre la boucle de rendu. */
  mount(container: HTMLElement): void;
  unmount(): void;
  /** Rebranche le viewport sur un autre document (nouvelle scène, fichier ouvert, session rejointe). */
  setDoc(doc: SceneDoc): void;
  dispose(): void;

  readonly dom: HTMLCanvasElement;
  /** Caméra courante du viewport (perspective, orthographique, ou caméra de scène en vue caméra). */
  readonly camera: Camera;
  /**
   * Groupe three.js rendu PAR-DESSUS la scène dans le viewport uniquement
   * (jamais dans le rendu final) : les outils y ajoutent gizmos et aperçus.
   */
  readonly overlayRoot: Group;
  getSize(): { width: number; height: number };
  /** Demande un nouveau rendu (le viewport ne redessine que si nécessaire). */
  requestRender(): void;

  // ------------------------------------------------------------ navigation
  setView(dir: ViewDirection): void;
  /** Cadre les objets sélectionnés (ou les éléments sélectionnés en mode édition). */
  frameSelection(): void;
  frameAll(): void;
  getViewState(): PresenceCamera;
  /** Place la caméra du viewport (sert au « suivre un utilisateur »). */
  setViewState(view: PresenceCamera, animate?: boolean): void;
  /** Point d'orbite courant, en monde. */
  getOrbitTarget(): Vec3;

  // ------------------------------------------------------------ conversions
  screenToRay(x: number, y: number): { origin: Vector3; dir: Vector3 };
  /** Projette un point monde ; null s'il est derrière la caméra. `depth` : distance à la caméra. */
  worldToScreen(p: Vec3 | Vector3): { x: number; y: number; depth: number } | null;

  // ------------------------------------------------------------ sélection / picking
  /** Objet sous le pointeur (maillage, lumière, caméra, empty), le plus proche d'abord. */
  pickObject(x: number, y: number): string | null;
  /** Objets dont la projection touche le rectangle écran. */
  pickObjectsInRect(x0: number, y0: number, x1: number, y1: number): string[];
  /**
   * Mode édition : élément de l'objet actif le plus proche du pointeur
   * (tolérance en pixels pour sommets et arêtes ; face sous le pointeur).
   * Sans X-Ray, les éléments cachés par la surface sont ignorés.
   */
  pickElement(x: number, y: number, mode: SelectMode): ElementHit | null;
  /** Mode édition : éléments de l'objet actif dans le rectangle écran. */
  pickElementsInRect(x0: number, y0: number, x1: number, y1: number, mode: SelectMode): string[];
  /** Intersection du pointeur avec les surfaces visibles de la scène (aimantation, placement du curseur 3D). */
  raycastSurface(x: number, y: number, opts?: { excludeSelection?: boolean }): SurfaceHit | null;

  // ------------------------------------------------------------ accès scène
  /** Object3D racine correspondant à un objet du document (sa matrice monde est à jour). */
  getObject3D(id: string): Object3D | null;
  /** Maillage ÉVALUÉ d'un objet (modificateurs appliqués), en coordonnées locales de l'objet. */
  getEvaluatedMesh(id: string): MeshData | null;

  // ------------------------------------------------------------ rendu final
  /**
   * Rendu de l'image finale depuis la caméra active avec le moteur de la
   * scène ('realtime' ou 'pathtrace'). Met à jour `store.render`
   * (running/progress/samples/imageUrl) et résout avec une data URL PNG.
   * Rejette s'il n'y a pas de caméra active ou si le rendu est annulé.
   */
  renderFinal(opts?: FinalRenderOptions): Promise<string>;
  cancelRender(): void;

  // ------------------------------------------------------------ import / export
  /** Exporte la scène (ou la sélection) en glTF binaire (.glb), modificateurs appliqués, Y-up. */
  exportGLB(opts?: { selectionOnly?: boolean }): Promise<ArrayBuffer>;
  /** Exporte en Wavefront OBJ (texte), faces polygonales conservées. */
  exportOBJ(opts?: { selectionOnly?: boolean }): string;
  /** Importe un fichier 3D dans le document (forme courte de `importScene`). Renvoie les objets créés. */
  importFile(name: string, data: ArrayBuffer): Promise<string[]>;
  /**
   * Importe un fichier .blend / .glb / .gltf / .fbx / .obj / .stl / .ply / .dae : objets, hiérarchie,
   * maillages, lumières, caméras, matériaux, collections, modificateurs pris en charge.
   * `mode: 'open'` reprend aussi le monde, le rendu et la caméra active du fichier.
   */
  importScene(name: string, data: ArrayBuffer, options?: ImportOptions): Promise<ImportResult>;
}
