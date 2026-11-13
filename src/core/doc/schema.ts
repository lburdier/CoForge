/**
 * Schéma du document de scène partagé.
 *
 * Tout ce qui est décrit ici vit dans un Y.Doc (CRDT Yjs) et est donc
 * synchronisé entre tous les utilisateurs d'une session. Ce qui est propre à
 * un utilisateur (sélection, mode, caméra du viewport) n'est PAS dans le
 * document : c'est dans le store local (src/app/store.ts) et diffusé aux
 * autres par la « présence » (src/net/api.ts).
 *
 * Conventions :
 *  - repère Z vers le haut (comme Blender), unités en mètres ;
 *  - rotations en Euler XYZ, radians ;
 *  - couleurs en chaîne hexadécimale sRGB '#rrggbb' ;
 *  - angles « utilisateur » (fov, spotAngle, autoSmoothAngle…) en degrés.
 */

export type Vec3 = [number, number, number];

export type ObjectType = 'mesh' | 'light' | 'camera' | 'empty';

/** Identifiant de la collection racine (« Scene Collection »). Elle est implicite, jamais stockée. */
export const ROOT_COLLECTION = 'root';

// ---------------------------------------------------------------- modificateurs

export type ModifierType =
  | 'mirror'
  | 'array'
  | 'bevel'
  | 'subsurf'
  | 'solidify'
  | 'boolean'
  | 'triangulate'
  | 'weld'
  | 'decimate'
  | 'edgesplit'
  | 'wireframe'
  | 'screw'
  | 'simpledeform'
  | 'cast'
  | 'smooth'
  | 'displace'
  | 'shrinkwrap'
  | 'remesh'
  | 'wave'
  | 'skin'
  | 'nodes';

export interface MirrorParams {
  axisX: boolean;
  axisY: boolean;
  axisZ: boolean;
  /** Soude les sommets situés sur le plan de symétrie. */
  merge: boolean;
  mergeDist: number;
}
export interface ArrayParams {
  count: number;
  /** Décalage relatif à la boîte englobante (facteur par axe). */
  relative: Vec3;
  /** Décalage constant en mètres, ajouté au décalage relatif. */
  constant: Vec3;
}
export interface BevelParams {
  width: number;
  segments: number;
  /** Seules les arêtes dont l'angle entre faces dépasse cette limite (degrés) sont biseautées. */
  angleLimit: number;
}
export interface SubsurfParams {
  levels: number;
}
export interface SolidifyParams {
  thickness: number;
  /** -1 = vers l'intérieur, 0 = centré, 1 = vers l'extérieur. */
  offset: number;
}
export interface BooleanParams {
  operation: 'difference' | 'union' | 'intersect';
  /** Objet maillage utilisé comme opérande. */
  target: string | null;
}

export type Axis = 'x' | 'y' | 'z';

export interface TriangulateParams {
  /** Seules les faces d'au moins ce nombre de côtés sont triangulées (4 = quads et n-gones). */
  minVerts: number;
}
export interface WeldParams {
  distance: number;
}
export interface DecimateParams {
  /** collapse : fusion d'arêtes jusqu'au ratio ; unsubdiv : inverse d'une subdivision ; planar : dissout les faces coplanaires. */
  mode: 'collapse' | 'unsubdiv' | 'planar';
  /** Proportion de faces conservées (collapse), 0..1. */
  ratio: number;
  iterations: number;
  /** Angle limite en degrés (planar). */
  angleLimit: number;
}
export interface EdgeSplitParams {
  /** Les arêtes dont l'angle entre faces dépasse cette limite (degrés) sont dédoublées. */
  angle: number;
}
export interface WireframeParams {
  thickness: number;
  /** true : remplace le maillage ; false : ajoute le fil de fer au maillage d'origine. */
  replace: boolean;
}
export interface ScrewParams {
  axis: Axis;
  /** Angle total en degrés. */
  angle: number;
  steps: number;
  /** Déplacement le long de l'axe sur la révolution complète (mètres). */
  screwOffset: number;
  iterations: number;
  merge: boolean;
}
export interface SimpleDeformParams {
  mode: 'twist' | 'bend' | 'taper' | 'stretch';
  axis: Axis;
  /** Angle en degrés (twist, bend). */
  angle: number;
  /** Facteur (taper, stretch). */
  factor: number;
}
export interface CastParams {
  shape: 'sphere' | 'cylinder' | 'cuboid';
  factor: number;
  /** 0 = rayon déduit de la boîte englobante. */
  radius: number;
  axisX: boolean;
  axisY: boolean;
  axisZ: boolean;
}
export interface SmoothParams {
  factor: number;
  iterations: number;
  axisX: boolean;
  axisY: boolean;
  axisZ: boolean;
}
export interface DisplaceParams {
  strength: number;
  midLevel: number;
  direction: 'normal' | Axis;
  /** Texture procédurale : none = déplacement uniforme. */
  texture: 'none' | 'noise' | 'voronoi' | 'wave';
  /** Taille des motifs en mètres. */
  scale: number;
  seed: number;
}
export interface ShrinkwrapParams {
  /** Objet maillage cible. */
  target: string | null;
  mode: 'nearest' | 'project';
  offset: number;
  /** Axe de projection (mode project), dans les deux sens. */
  axis: Axis;
}
export interface RemeshParams {
  mode: 'voxel' | 'blocks';
  /** Taille d'un voxel en mètres. */
  voxelSize: number;
}
export interface WaveParams {
  axisX: boolean;
  axisY: boolean;
  height: number;
  width: number;
  /** Position dans le temps (pas d'animation : c'est une phase). */
  phase: number;
}
export interface SkinParams {
  /** Rayon de la peau autour de chaque arête du maillage. */
  radius: number;
  segments: number;
}
export interface NodesModifierParams {
  /** Arbre de nœuds de géométrie (table `nodeTrees`). */
  tree: string | null;
}

export interface ModifierParamsMap {
  triangulate: TriangulateParams;
  weld: WeldParams;
  decimate: DecimateParams;
  edgesplit: EdgeSplitParams;
  wireframe: WireframeParams;
  screw: ScrewParams;
  simpledeform: SimpleDeformParams;
  cast: CastParams;
  smooth: SmoothParams;
  displace: DisplaceParams;
  shrinkwrap: ShrinkwrapParams;
  remesh: RemeshParams;
  wave: WaveParams;
  skin: SkinParams;
  nodes: NodesModifierParams;
  mirror: MirrorParams;
  array: ArrayParams;
  bevel: BevelParams;
  subsurf: SubsurfParams;
  solidify: SolidifyParams;
  boolean: BooleanParams;
}

export interface ModifierData<T extends ModifierType = ModifierType> {
  id: string;
  type: T;
  name: string;
  enabled: boolean;
  params: ModifierParamsMap[T];
}

export const MODIFIER_DEFAULTS: { [K in ModifierType]: ModifierParamsMap[K] } = {
  mirror: { axisX: true, axisY: false, axisZ: false, merge: true, mergeDist: 0.001 },
  array: { count: 2, relative: [1, 0, 0], constant: [0, 0, 0] },
  bevel: { width: 0.02, segments: 2, angleLimit: 30 },
  subsurf: { levels: 1 },
  solidify: { thickness: 0.05, offset: -1 },
  boolean: { operation: 'difference', target: null },
  triangulate: { minVerts: 4 },
  weld: { distance: 0.001 },
  decimate: { mode: 'collapse', ratio: 0.5, iterations: 1, angleLimit: 5 },
  edgesplit: { angle: 30 },
  wireframe: { thickness: 0.02, replace: true },
  screw: { axis: 'z', angle: 360, steps: 16, screwOffset: 0, iterations: 1, merge: true },
  simpledeform: { mode: 'twist', axis: 'z', angle: 45, factor: 0.5 },
  cast: { shape: 'sphere', factor: 0.5, radius: 0, axisX: true, axisY: true, axisZ: true },
  smooth: { factor: 0.5, iterations: 1, axisX: true, axisY: true, axisZ: true },
  displace: { strength: 0.1, midLevel: 0.5, direction: 'normal', texture: 'noise', scale: 0.5, seed: 0 },
  shrinkwrap: { target: null, mode: 'nearest', offset: 0, axis: 'z' },
  remesh: { mode: 'voxel', voxelSize: 0.1 },
  wave: { axisX: true, axisY: true, height: 0.2, width: 1.5, phase: 0 },
  skin: { radius: 0.05, segments: 8 },
  nodes: { tree: null },
};

export const MODIFIER_LABELS: Record<ModifierType, string> = {
  mirror: 'Miroir',
  array: 'Réseau',
  bevel: 'Biseau',
  subsurf: 'Subdivision',
  solidify: 'Solidifier',
  boolean: 'Booléen',
  triangulate: 'Trianguler',
  weld: 'Souder',
  decimate: 'Décimer',
  edgesplit: 'Séparer les arêtes',
  wireframe: 'Fil de fer',
  screw: 'Vis',
  simpledeform: 'Déformation simple',
  cast: 'Projeter (Cast)',
  smooth: 'Lisser',
  displace: 'Déplacer',
  shrinkwrap: 'Rétrécir-envelopper',
  remesh: 'Remailler',
  wave: 'Vague',
  skin: 'Peau',
  nodes: 'Nœuds de géométrie',
};

// ---------------------------------------------------------------- contraintes d'objet

export type ConstraintType =
  | 'copy_location'
  | 'copy_rotation'
  | 'copy_scale'
  | 'copy_transforms'
  | 'limit_location'
  | 'limit_rotation'
  | 'limit_scale'
  | 'limit_distance'
  | 'track_to'
  | 'damped_track'
  | 'locked_track'
  | 'child_of'
  | 'floor';

/**
 * Contrainte d'objet (évaluée dans l'ordre de la pile, après la transformation propre de
 * l'objet et son parent, comme dans Blender). Champs utilisés selon le type :
 *  - copy_* : `target`, `useX/Y/Z`, `invertX/Y/Z`, `offset` (ajoute au lieu de remplacer) ;
 *  - limit_location/rotation/scale : `min`, `max` (degrés pour la rotation), `useMin`, `useMax` ;
 *  - limit_distance : `target`, `distance`, `limitMode` ;
 *  - track_to / damped_track / locked_track : `target`, `trackAxis`, `upAxis` ;
 *  - child_of : `target` (parent supplémentaire, avec matrice inverse figée `inverse`) ;
 *  - floor : `target`, `floorOffset`.
 * Tous : `influence` 0..1.
 */
export interface ConstraintData {
  id: string;
  type: ConstraintType;
  name: string;
  enabled: boolean;
  influence: number;
  target: string | null;
  useX: boolean;
  useY: boolean;
  useZ: boolean;
  invertX: boolean;
  invertY: boolean;
  invertZ: boolean;
  offset: boolean;
  min: Vec3;
  max: Vec3;
  useMin: [boolean, boolean, boolean];
  useMax: [boolean, boolean, boolean];
  distance: number;
  limitMode: 'inside' | 'outside' | 'surface';
  /** Axe local pointé vers la cible : x, y, z ou leurs opposés. */
  trackAxis: 'x' | 'y' | 'z' | '-x' | '-y' | '-z';
  upAxis: Axis;
  /** Matrice inverse du parent figée par « Définir l'inverse » (16 nombres, ordre colonne), null = identité. */
  inverse: number[] | null;
  floorOffset: number;
}

export const CONSTRAINT_DEFAULTS: Omit<ConstraintData, 'id' | 'type' | 'name'> = {
  enabled: true,
  influence: 1,
  target: null,
  useX: true,
  useY: true,
  useZ: true,
  invertX: false,
  invertY: false,
  invertZ: false,
  offset: false,
  min: [0, 0, 0],
  max: [0, 0, 0],
  useMin: [false, false, false],
  useMax: [false, false, false],
  distance: 1,
  limitMode: 'inside',
  trackAxis: '-z',
  upAxis: 'y',
  inverse: null,
  floorOffset: 0,
};

export const CONSTRAINT_LABELS: Record<ConstraintType, string> = {
  copy_location: 'Copier la position',
  copy_rotation: 'Copier la rotation',
  copy_scale: 'Copier l’échelle',
  copy_transforms: 'Copier les transformations',
  limit_location: 'Limiter la position',
  limit_rotation: 'Limiter la rotation',
  limit_scale: 'Limiter l’échelle',
  limit_distance: 'Limiter la distance',
  track_to: 'Suivre (Track To)',
  damped_track: 'Suivi amorti',
  locked_track: 'Suivi verrouillé',
  child_of: 'Enfant de',
  floor: 'Sol',
};

// ---------------------------------------------------------------- objets

export interface ObjectData {
  id: string;
  name: string;
  type: ObjectType;
  /** Objet parent (hiérarchie de transformations) ou null. */
  parent: string | null;
  /** Collection qui contient l'objet (ROOT_COLLECTION par défaut). */
  collection: string;
  pos: Vec3;
  rot: Vec3;
  scl: Vec3;
  /** Visible dans le viewport. */
  visible: boolean;
  /** Pris en compte au rendu final. */
  renderable: boolean;
  /** Identifiant du bloc de données : maillage, lumière ou caméra selon `type` (null pour un empty). */
  data: string | null;
  /** Matériau affecté (objets maillage). */
  material: string | null;
  modifiers: ModifierData[];
  shadeSmooth: boolean;
  /** Angle (degrés) au-delà duquel une arête reste vive en ombrage lisse. */
  autoSmoothAngle: number;
  /** Affichage viewport. */
  displayAs: 'solid' | 'wire' | 'bounds';
  /** Pile de contraintes d'objet. */
  constraints: ConstraintData[];
  /** Affichage viewport (onglet Objet › Affichage) : nom, axes, toujours devant. */
  showName: boolean;
  showAxes: boolean;
  showInFront: boolean;
  /** Sélectionnable au clic dans le viewport. */
  selectable: boolean;
  /** Couleur d'objet (mode Solide « couleur par objet »). */
  color: string;
  /** Objets vides : forme et taille du gizmo. */
  emptyDisplay: 'axes' | 'arrows' | 'single_arrow' | 'cube' | 'sphere' | 'circle' | 'cone';
  emptySize: number;
}

export const OBJECT_DEFAULTS: Omit<ObjectData, 'id' | 'name' | 'type'> = {
  parent: null,
  collection: ROOT_COLLECTION,
  pos: [0, 0, 0],
  rot: [0, 0, 0],
  scl: [1, 1, 1],
  visible: true,
  renderable: true,
  data: null,
  material: null,
  modifiers: [],
  shadeSmooth: false,
  autoSmoothAngle: 30,
  displayAs: 'solid',
  constraints: [],
  showName: false,
  showAxes: false,
  showInFront: false,
  selectable: true,
  color: '#ffffff',
  emptyDisplay: 'axes',
  emptySize: 1,
};

// ---------------------------------------------------------------- maillages

/**
 * Maillage polygonal. Les arêtes sont implicites (déduites des faces).
 * Une face est une boucle de 3 sommets ou plus, dans le sens antihoraire vu
 * depuis l'extérieur (la normale suit la règle de la main droite).
 *
 * Dans le Y.Doc, chaque sommet et chaque face est une entrée indépendante :
 * deux utilisateurs peuvent donc éditer en même temps des parties différentes
 * du même maillage sans conflit.
 *
 * IMPORTANT : un instantané MeshData renvoyé par SceneDoc.getMesh() est
 * partagé (mis en cache), il est en LECTURE SEULE. Clonez-le avant de le modifier.
 */
export interface MeshData {
  verts: Map<string, Vec3>;
  faces: Map<string, string[]>;
}

/** Modification atomique d'un maillage, appliquée en une seule transaction. */
export interface MeshDelta {
  /** Sommets créés ou déplacés. */
  setVerts?: Record<string, Vec3>;
  /** Faces créées ou redéfinies. */
  setFaces?: Record<string, string[]>;
  delVerts?: string[];
  delFaces?: string[];
}

/** Clé canonique d'une arête : les deux identifiants de sommets triés, joints par '|'. */
export function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
export function edgeVerts(key: string): [string, string] {
  const i = key.indexOf('|');
  return [key.slice(0, i), key.slice(i + 1)];
}

// ---------------------------------------------------------------- lumières, caméras, matériaux

export type LightKind = 'point' | 'sun' | 'spot' | 'area';

export interface LightData {
  id: string;
  kind: LightKind;
  color: string;
  /** Puissance en watts (point, spot, area) ou intensité en W/m² (sun), comme dans Blender. */
  power: number;
  /** Rayon de la source (ombres douces en path tracing). */
  radius: number;
  /** Angle total du cône (spot), en degrés. */
  spotAngle: number;
  /** Adoucissement du bord du cône, 0..1. */
  spotBlend: number;
  /** Dimensions (area). */
  sizeX: number;
  sizeY: number;
  castShadow: boolean;
}

export const LIGHT_DEFAULTS: Omit<LightData, 'id'> = {
  kind: 'point',
  color: '#ffffff',
  power: 1000,
  radius: 0.1,
  spotAngle: 45,
  spotBlend: 0.15,
  sizeX: 1,
  sizeY: 1,
  castShadow: true,
};

export interface CameraData {
  id: string;
  kind: 'persp' | 'ortho';
  /** Champ de vision vertical en degrés (perspective). */
  fov: number;
  /** Hauteur visible en mètres (orthographique). */
  orthoScale: number;
  near: number;
  far: number;
  dofEnabled: boolean;
  focusDistance: number;
  fstop: number;
  /**
   * Capteur (mm). `fov` reste la référence (champ VERTICAL en degrés) ; la focale affichée s'en
   * déduit : focale = (sensorHeight / 2) / tan(fov / 2) en cadrage vertical, et par la largeur
   * du capteur et le rapport de l'image en cadrage horizontal (auto = plus grande dimension).
   */
  sensorFit: 'auto' | 'horizontal' | 'vertical';
  sensorWidth: number;
  sensorHeight: number;
  /** Décalage de l'objectif (shift), en fraction de la plus grande dimension de l'image. */
  shiftX: number;
  shiftY: number;
  /** Objet sur lequel faire la mise au point (prioritaire sur `focusDistance`). */
  focusObject: string | null;
  /** Diaphragme : nombre de lames (0 = rond), rotation en degrés, rapport d'anamorphose. */
  apertureBlades: number;
  apertureRotation: number;
  apertureRatio: number;
  /** Affichage en vue caméra. */
  showPassepartout: boolean;
  passepartoutAlpha: number;
  guideThirds: boolean;
  guideCenter: boolean;
  guideCenterDiagonal: boolean;
  guideGolden: boolean;
  guideGoldenTriangleA: boolean;
  guideGoldenTriangleB: boolean;
  guideHarmonyTriangleA: boolean;
  guideHarmonyTriangleB: boolean;
  showSafeAreas: boolean;
  /** Affichage du gizmo : limites (near/far), distance de mise au point, capteur, taille. */
  showLimits: boolean;
  showFocus: boolean;
  showSensor: boolean;
  displaySize: number;
}

export const CAMERA_DEFAULTS: Omit<CameraData, 'id'> = {
  kind: 'persp',
  fov: 40,
  orthoScale: 6,
  near: 0.1,
  far: 1000,
  dofEnabled: false,
  focusDistance: 10,
  fstop: 2.8,
  sensorFit: 'auto',
  sensorWidth: 36,
  sensorHeight: 24,
  shiftX: 0,
  shiftY: 0,
  focusObject: null,
  apertureBlades: 0,
  apertureRotation: 0,
  apertureRatio: 1,
  showPassepartout: true,
  passepartoutAlpha: 0.5,
  guideThirds: false,
  guideCenter: false,
  guideCenterDiagonal: false,
  guideGolden: false,
  guideGoldenTriangleA: false,
  guideGoldenTriangleB: false,
  guideHarmonyTriangleA: false,
  guideHarmonyTriangleB: false,
  showSafeAreas: false,
  showLimits: false,
  showFocus: false,
  showSensor: false,
  displaySize: 1,
};

/** Matériau de type « Principled » simplifié. */
export interface MaterialData {
  id: string;
  name: string;
  baseColor: string;
  metallic: number;
  roughness: number;
  emission: string;
  emissionStrength: number;
  /** Opacité 0..1. */
  alpha: number;
  /** Transmission (verre) 0..1. */
  transmission: number;
  ior: number;
  /**
   * Arbre de nœuds de shader (table `nodeTrees`) ; null = matériau simple ci-dessus. Les champs
   * ci-dessus restent le repli (path tracing, export) quand l'arbre ne se réduit pas à des constantes.
   */
  nodeTree?: string | null;
  /** false : l'arbre est conservé mais ignoré (bouton « Utiliser les nœuds » désactivé). */
  useNodes?: boolean;
}

export const MATERIAL_DEFAULTS: Omit<MaterialData, 'id' | 'name'> = {
  baseColor: '#cccccc',
  metallic: 0,
  roughness: 0.5,
  emission: '#000000',
  emissionStrength: 0,
  alpha: 1,
  transmission: 0,
  ior: 1.45,
  nodeTree: null,
};

// ---------------------------------------------------------------- arbres de nœuds, textes

export type NodeTreeKind = 'shader' | 'geometry';

export interface NodeData {
  id: string;
  /** Type de nœud, identifiant du catalogue (src/core/nodes) : 'ShaderNodeBsdfPrincipled', 'GeometryNodeTransform'… */
  type: string;
  /** Position dans l'éditeur (px). */
  x: number;
  y: number;
  label?: string;
  /** Valeurs des entrées non connectées, par identifiant de socket. */
  inputs: Record<string, unknown>;
  /** Propriétés du nœud (listes déroulantes, cases…), par identifiant. */
  props: Record<string, unknown>;
  /** Cadre (frame) parent, replié, muet. */
  parent?: string | null;
  collapsed?: boolean;
  muted?: boolean;
  /** Largeur et hauteur (cadres), couleur d'en-tête personnalisée. */
  width?: number;
  height?: number;
  color?: string | null;
}

export interface NodeLink {
  id: string;
  fromNode: string;
  fromSocket: string;
  toNode: string;
  toSocket: string;
}

/**
 * Arbre de nœuds. Dans le document, `nodes` et `links` sont deux champs entiers : deux
 * utilisateurs qui modifient le même arbre au même instant voient gagner la dernière écriture.
 */
export interface NodeTreeData {
  id: string;
  name: string;
  kind: NodeTreeKind;
  nodes: Record<string, NodeData>;
  links: NodeLink[];
}

/** Bloc de texte (scripts Python de l'éditeur de texte). */
export interface TextData {
  id: string;
  name: string;
  content: string;
}

export interface CollectionData {
  id: string;
  name: string;
  /** Collection parente (ROOT_COLLECTION si au premier niveau). */
  parent: string;
  visible: boolean;
}

// ---------------------------------------------------------------- réglages de scène

export interface WorldSettings {
  /** 'color' : couleur unie ; 'sky' : ciel procédural avec soleil ; 'hdri' : image d'environnement (.hdr, .exr, .png, .jpg). */
  mode: 'color' | 'sky' | 'hdri';
  color: string;
  strength: number;
  /** Ciel procédural : élévation et azimut du soleil en degrés. */
  sunElevation: number;
  sunAzimuth: number;
  /** Image d'environnement (identifiant d'image du document, voir core/nodes/shader/images.ts) ou null. */
  hdriImage: string | null;
  /** Rotation de l'image d'environnement autour de Z, en degrés. */
  hdriRotation: number;
}

/**
 * Moteurs de rendu :
 *  - 'realtime'  : rastérisation temps réel (dans l'esprit d'EEVEE) ;
 *  - 'pathtrace' : path tracing progressif GPU (dans l'esprit de Cycles).
 */
export type RenderEngine = 'realtime' | 'pathtrace';

export interface RenderSettings {
  engine: RenderEngine;
  resX: number;
  resY: number;
  /** Path tracing : nombre d'échantillons du rendu final. */
  samples: number;
  /** Path tracing : échantillons max dans le viewport. */
  viewportSamples: number;
  /** Path tracing : nombre de rebonds. */
  bounces: number;
  /**
   * Path tracing (viewport) : résolution interne réduite puis remise à l'échelle, à la manière
   * des modes de DLSS (qualité 67 %, équilibré 58 %, performance 50 %, ultra 33 %).
   */
  upscale: 'off' | 'quality' | 'balanced' | 'performance' | 'ultra';
  /** Path tracing : débruitage de l'image tant qu'elle n'a pas convergé. */
  denoise: boolean;
  /** Temps réel : occlusion ambiante. */
  ao: boolean;
  /** Temps réel : bloom. */
  bloom: boolean;
  /** Temps réel : qualité des ombres. */
  shadows: 'off' | 'low' | 'high';
  exposure: number;
  toneMapping: 'agx' | 'filmic' | 'standard';
  transparentBg: boolean;
  /** Sortie : pourcentage de la résolution, format et qualité du fichier image. */
  resPercent: number;
  format: 'png' | 'jpeg' | 'webp';
  quality: number;

  // --- Path tracing (ajouts de la v0.4, tous facultatifs : lire avec repli, voir engine/render/settings.ts)
  /**
   * Débruiteur du viewport (actif si `denoise` est vrai) : 'fast' = bilatéral,
   * 'hq' = à-trous guidé par l'albédo et les normales, 'none' = aucun.
   */
  viewportDenoiser?: 'none' | 'fast' | 'hq';
  /** Débruiter le rendu final. */
  denoiseFinal?: boolean;
  /** Débruiteur du rendu final (actif si `denoiseFinal` est vrai). */
  denoiser?: 'none' | 'fast' | 'hq';
  /** Débruiteur haute qualité : itérations de l'à-trous (1 à 6) et poids des guides. */
  denoiseIterations?: number;
  denoiseStrength?: number;
  denoiseNormalWeight?: number;
  denoiseAlbedoWeight?: number;
  /** Bloom du path tracing (sur l'image HDR linéaire, avant le tone mapping). */
  ptBloom?: boolean;
  ptBloomIntensity?: number;
  /** Seuil de luminance linéaire au-delà duquel la lumière « bave ». */
  ptBloomThreshold?: number;
  /** Étalement du halo (0 à 1). */
  ptBloomRadius?: number;
  /** Rebonds supplémentaires réservés à la transmission (verre, liquides). */
  transmissionBounces?: number;
  /** Filtre glossy : adoucit les reflets après des rebonds diffus (moins de lucioles). */
  filterGlossy?: number;
  /** Viewport : échantillons à accumuler avant d'afficher l'image tracée. */
  viewportMinSamples?: number;
  /** Rendu final : limite de temps en secondes (0 = aucune). */
  timeLimit?: number;
  /** Graine du bruit d'échantillonnage. */
  seed?: number;
  /** Écrêtage des lucioles : valeur maximale d'un échantillon (0 = désactivé). */
  sampleClamp?: number;
}

export interface SceneSettings {
  name: string;
  activeCamera: string | null;
  world: WorldSettings;
  render: RenderSettings;
}

export const SCENE_DEFAULTS: SceneSettings = {
  name: 'Scène',
  activeCamera: null,
  world: { mode: 'color', color: '#3d3d3d', strength: 1, sunElevation: 40, sunAzimuth: 135, hdriImage: null, hdriRotation: 0 },
  render: {
    engine: 'realtime',
    resX: 1920,
    resY: 1080,
    samples: 128,
    viewportSamples: 64,
    bounces: 5,
    upscale: 'balanced',
    denoise: true,
    ao: true,
    bloom: false,
    shadows: 'high',
    exposure: 0,
    toneMapping: 'agx',
    transparentBg: false,
    resPercent: 100,
    format: 'png',
    quality: 90,
    viewportDenoiser: 'fast',
    denoiseFinal: true,
    denoiser: 'hq',
    denoiseIterations: 4,
    denoiseStrength: 1,
    denoiseNormalWeight: 1,
    denoiseAlbedoWeight: 1,
    ptBloom: false,
    ptBloomIntensity: 0.3,
    ptBloomThreshold: 1,
    ptBloomRadius: 0.5,
    transmissionBounces: 8,
    filterGlossy: 0.5,
    viewportMinSamples: 1,
    timeLimit: 0,
    seed: 0,
    sampleClamp: 0,
  },
};

export interface ChatMessage {
  id: string;
  userId: string;
  userName: string;
  color: string;
  text: string;
  time: number;
}

// ---------------------------------------------------------------- marqueurs, compositing

/**
 * Marqueur de la frise / plan du montage vidéo. Lié à une caméra, il fait de celle-ci la caméra
 * active à partir de son image (comme les marqueurs liés aux caméras de Blender). Stocké dans la
 * table `scene` sous la clé `m:<id>` : deux utilisateurs qui posent des marqueurs ne se gênent pas.
 */
export interface MarkerData {
  id: string;
  name: string;
  frame: number;
  /** Objet caméra activé à partir de ce marqueur, ou null. */
  camera: string | null;
}

/**
 * Note d'équipe (revue) : un commentaire posé dans la scène, sur un objet ou à un point. Stockée dans
 * la table `scene` sous la clé `n:<id>` (une entrée par note : aucune collision entre auteurs).
 */
export interface NoteData {
  id: string;
  text: string;
  author: string;
  color: string;
  /** Position monde (ou décalage par rapport à l'origine de l'objet si `objectId`). */
  pos: Vec3;
  objectId: string | null;
  time: number;
  done: boolean;
}

/** Réglages du compositeur (table `scene`, clés `c:<champ>`), appliqués au rendu final. */
export interface CompositorSettings {
  /** Utiliser les nœuds : applique la chaîne au rendu affiché et enregistré. */
  use: boolean;
  /** Exposition en IL (diaphs) et gamma. */
  exposure: number;
  gamma: number;
  useExposure: boolean;
  /** Contraste et saturation (1 = neutre), teinte multiplicative. */
  contrast: number;
  saturation: number;
  tint: string;
  useColor: boolean;
  /** Vignettage 0..1. */
  vignette: number;
  useVignette: boolean;
}

export const COMPOSITOR_DEFAULTS: CompositorSettings = {
  use: false,
  exposure: 0,
  gamma: 1,
  useExposure: true,
  contrast: 1,
  saturation: 1,
  tint: '#ffffff',
  useColor: true,
  vignette: 0.3,
  useVignette: false,
};

/** Extension des fichiers de scène (instantané binaire du Y.Doc). */
export const FILE_EXTENSION = 'coforge';
/** Version du schéma, stockée dans le document. */
export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------- animation (images clés)

/**
 * Animation par images clés, PENSÉE POUR LE COLLABORATIF.
 *
 * Dans le Y.Doc :
 *   animKeys    Y.Map<idClé, KeyframeData>    une entrée INDÉPENDANTE par image clé (table plate)
 *   animCurves  Y.Map<cléCourbe, AnimCurveFlags>   réglages partagés d'une courbe (verrou, muet, lissage)
 *   scene       clés 'a:frameStart', 'a:frameEnd', 'a:fps'
 *
 * Une « courbe » (F-Curve) n'est pas stockée en tant que telle : c'est l'ensemble des clés qui
 * partagent (owner, path, index) ; sa clé est `curveKey(owner, path, index)`. La table est plate
 * pour qu'aucun conteneur ne soit créé en concurrence (deux utilisateurs qui créent « la même »
 * sous-table Yjs au même instant perdraient le contenu de l'un d'eux) : deux utilisateurs qui
 * posent des clés sur la même courbe ajoutent simplement des entrées différentes.
 *
 * Règle de fusion (déterministe, identique chez tous) : si plusieurs clés d'une courbe tombent à
 * la même image (écart < ANIM_FRAME_EPS), une seule est effective : celle dont `t` (horodatage
 * de la dernière écriture) est le plus grand, puis, à égalité, celle dont l'identifiant est le
 * plus grand (ordre lexicographique). Les autres sont « masquées » : ignorées par l'évaluation et
 * l'affichage, et supprimées dès qu'un utilisateur réécrit une clé à cette image.
 *
 * Une clé est un objet JSON écrit d'un bloc (dernier écrivain gagne sur la clé entière) : image,
 * valeur et poignées restent toujours cohérentes entre elles.
 *
 * L'image courante n'est PAS dans le document : chaque utilisateur a sa propre tête de lecture
 * (store local), et la scène affichée = valeurs de base + courbes évaluées à cette image.
 */

/** Propriétés animables (chemins de données à la Blender). */
export type AnimPath =
  | 'location'
  | 'rotation_euler'
  | 'scale'
  | 'visible'
  | 'light.color'
  | 'light.energy'
  | 'camera.lens'
  | 'material.base_color'
  | 'material.metallic'
  | 'material.roughness'
  | 'material.alpha'
  | 'material.emission_strength';

export type Interpolation =
  | 'CONSTANT'
  | 'LINEAR'
  | 'BEZIER'
  | 'SINE'
  | 'QUAD'
  | 'CUBIC'
  | 'QUART'
  | 'QUINT'
  | 'EXPO'
  | 'CIRC'
  | 'BACK'
  | 'BOUNCE'
  | 'ELASTIC';

/** Atténuation des interpolations « dynamiques » (SINE…ELASTIC), ignorée pour CONSTANT/LINEAR/BEZIER. */
export type Easing = 'AUTO' | 'EASE_IN' | 'EASE_OUT' | 'EASE_IN_OUT';

/** Types de poignées de Blender (AUTO_CLAMPED = « Auto Clamped », défaut). */
export type HandleType = 'FREE' | 'ALIGNED' | 'VECTOR' | 'AUTO' | 'AUTO_CLAMPED';

/** Lissage des poignées automatiques d'une courbe (Blender : « Auto Handle Smoothing »). */
export type CurveSmoothing = 'NONE' | 'CONT_ACCEL';

export interface KeyframeData {
  id: string;
  /** Identifiant du propriétaire : objet, lumière, caméra ou matériau selon `path`. */
  owner: string;
  path: AnimPath;
  /** Composante (0..2 pour les vecteurs et couleurs, 0 pour un scalaire). */
  index: number;
  frame: number;
  value: number;
  /** Interpolation du segment qui COMMENCE à cette clé. */
  interp: Interpolation;
  easing: Easing;
  /** Poignées gauche et droite (image, valeur), absolues ; recalculées à l'évaluation sauf FREE / ALIGNED. */
  hl: [number, number];
  hr: [number, number];
  hlType: HandleType;
  hrType: HandleType;
  /** Horodatage (ms) de la dernière écriture : sert à la règle de fusion. */
  t: number;
  /** Utilisateur qui a écrit la clé en dernier (identifiant local), pour l'affichage. */
  by?: string;
}

export interface AnimCurveFlags {
  /** Verrouillée : personne ne peut en modifier les clés. */
  lock: boolean;
  /** Muette : ignorée à l'évaluation. */
  mute: boolean;
  smoothing: CurveSmoothing;
}

export const ANIM_CURVE_DEFAULTS: AnimCurveFlags = { lock: false, mute: false, smoothing: 'CONT_ACCEL' };

export interface AnimSettings {
  frameStart: number;
  frameEnd: number;
  /** Images par seconde (préréglages 24, 25, 30, 60). */
  fps: number;
}

export const ANIM_DEFAULTS: AnimSettings = { frameStart: 1, frameEnd: 250, fps: 24 };

/** Écart sous lequel deux clés d'une courbe sont « à la même image » (BEZT_BINARYSEARCH_THRESH de Blender). */
export const ANIM_FRAME_EPS = 0.01;

/** Clé canonique d'une courbe. */
export function curveKey(owner: string, path: AnimPath, index: number): string {
  return `${owner}|${path}|${index}`;
}
export function parseCurveKey(key: string): { owner: string; path: AnimPath; index: number } {
  const [owner, path, index] = key.split('|');
  return { owner, path: path as AnimPath, index: Number(index) || 0 };
}
