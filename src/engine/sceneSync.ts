import {
  Box3,
  Color,
  DirectionalLight,
  Group,
  LineSegments,
  Matrix4,
  Mesh,
  Scene,
  Sphere,
  Vector3,
  type BufferGeometry,
  type Material,
  type MeshPhysicalMaterial,
  type ShaderMaterial,
} from 'three';
import type { AppState, ShadingMode } from '../app/store';
import type { SceneDoc } from '../core/doc/SceneDoc';
import { localMatrix } from '../core/doc/transforms';
import type { CameraData, LightData, LightKind, ObjectData, ObjectType, RenderSettings, SceneSettings } from '../core/doc/schema';
import { SCENE_DEFAULTS } from '../core/doc/schema';
import type { RenderMesh } from '../core/mesh/types';
import { GeometryPool, type GeoEntry } from './geometryPool';
import {
  applyLightData,
  boxGizmoGeometry,
  cameraGizmoGeometry,
  createLight,
  disposeLight,
  emptyGizmoGeometry,
  lightGizmoGeometry,
  placeSun,
  travelDirection,
  type SceneLight,
} from './lights';
import { createStudioMaterial, MaterialLibrary } from './materials';
import { nodeSurfaceBeforeRender } from './nodeMaterial';
import { MeshEvaluator, booleanTargets } from './meshCache';
import { createOccluderMaterial, createOutlineMaterial, LineMaterialCache, ORDER } from './overlayMaterials';
import { COLOR_ACTIVE, COLOR_SELECTED, COLOR_VIEWPORT_BG, finite } from './util';
import type { WorldEnv, WorldState } from './world';

/**
 * Synchronisation INCRÉMENTALE document → scène three.js.
 *
 * Les événements du document ne font que marquer des drapeaux « sale » ; tout
 * est reconstruit en une fois par `flush()`, appelé au début de chaque image
 * (et avant chaque picking) : un déplacement modal ou les éditions d'un autre
 * utilisateur ne déclenchent donc jamais de reconstruction synchrone par événement.
 *
 * Chaque objet du document a un nœud (ObjNode) :
 *  - `root`  (scène rendue)  : surface du maillage ou lumière three.js, matrice = matrice MONDE ;
 *  - `ov`    (scène d'overlay) : occulteur, fil de fer, contour, gizmo.
 * La hiérarchie est aplatie (chaque nœud porte sa matrice monde) : masquer un
 * parent ne masque pas ses enfants, comme dans Blender.
 */

const F_TRANSFORM = 1;
const F_GEOMETRY = 2;
const F_MATERIAL = 4;
const F_VISIBILITY = 8;
const F_DATA = 16;
const F_STYLE = 32;
const F_ALL = 63;

export type DirtyKind = 'geometry' | 'materials' | 'lights' | 'environment' | 'camera';

export interface SyncHost {
  getDoc(): SceneDoc;
  getState(): AppState;
  requestRender(): void;
  markDirty(kind: DirtyKind): void;
  /** Taille du tampon de dessin (pixels physiques), pour les contours en espace écran. */
  drawingSize(): { width: number; height: number };
}

export interface ObjNode {
  id: string;
  type: ObjectType;
  obj: ObjectData;
  root: Group;
  ov: Group;
  /** Visibilité effective dans le viewport (objet + collections). */
  visible: boolean;
  dataId: string | null;
  // maillage
  rm: RenderMesh | null;
  geo: GeoEntry | null;
  surface: Mesh | null;
  occluder: Mesh | null;
  wire: LineSegments | null;
  outline: Mesh | null;
  peerOutline: Mesh | null;
  bounds: LineSegments | null;
  boundsKey: string;
  // lumière / caméra / empty
  light: SceneLight | null;
  lightKind: LightKind | null;
  gizmo: LineSegments | null;
  gizmoKey: string;
  /** État de sélection appliqué : 0 aucun, 1 sélectionné, 2 actif. */
  selState: number;
  peerColor: string | null;
}

function emptyNode(id: string, obj: ObjectData): ObjNode {
  const root = new Group();
  root.name = obj.name;
  root.matrixAutoUpdate = false;
  root.userData.objectId = id;
  const ov = new Group();
  ov.matrixAutoUpdate = false;
  ov.userData.objectId = id;
  return {
    id,
    type: obj.type,
    obj,
    root,
    ov,
    visible: true,
    dataId: obj.data,
    rm: null,
    geo: null,
    surface: null,
    occluder: null,
    wire: null,
    outline: null,
    peerOutline: null,
    bounds: null,
    boundsKey: '',
    light: null,
    lightKind: null,
    gizmo: null,
    gizmoKey: '',
    selState: -1,
    peerColor: null,
  };
}

const TRANSFORM_KEYS = new Set(['pos', 'rot', 'scl', 'parent']);
const GEOMETRY_KEYS = new Set(['modifiers', 'shadeSmooth', 'autoSmoothAngle']);
const VISIBILITY_KEYS = new Set(['visible', 'collection', 'displayAs', 'renderable']);

export class SceneSync {
  readonly scene = new Scene();
  readonly overlay = new Scene();
  readonly pool = new GeometryPool();
  readonly evaluator: MeshEvaluator;
  readonly materials = new MaterialLibrary();
  readonly lineMats = new LineMaterialCache();
  readonly nodes = new Map<string, ObjNode>();

  private studio: ShaderMaterial = createStudioMaterial();
  private studioXray: ShaderMaterial = createStudioMaterial();
  private occluderMat = createOccluderMaterial();
  private outlineSel = createOutlineMaterial(COLOR_SELECTED, 1.5);
  private outlineActive = createOutlineMaterial(COLOR_ACTIVE, 1.5);
  private peerOutlineMats = new Map<string, ShaderMaterial>();

  private dirty = new Map<string, number>();
  private created = new Set<string>();
  private removed = new Set<string>();
  private meshUsers = new Map<string, Set<string>>();
  private boolOwners = new Set<string>();
  private globalFlags = 0;
  private worldDirty = true;
  private sceneSettings: SceneSettings = SCENE_DEFAULTS;
  private worldEnv: WorldEnv | null = null;
  private worldState: WorldState | null = null;
  private worldSun: DirectionalLight | null = null;
  private sceneBounds = new Sphere(new Vector3(), 10);
  private boundsDirty = true;
  private docOffs: (() => void)[] = [];
  private doc: SceneDoc | null = null;
  private peerSel = new Map<string, string>();
  private finalOverride = false;
  /**
   * La profondeur de la scène est-elle disponible quand l'overlay est dessiné ?
   * (RenderPipeline la conserve ou la reconstruit par une pré-passe.) Si oui, les
   * occulteurs ne servent qu'en rayons X, pour découper les contours de sélection.
   */
  sceneDepthAvailable = false;
  /** Mode d'ombrage effectivement appliqué. */
  private shading: ShadingMode = 'solid';
  private xray = false;

  constructor(private host: SyncHost) {
    // Matériau à nœuds modifié hors événement du document (image décodée) : redessiner.
    this.materials.onAsyncChange = () => this.host.markDirty('materials');
    this.evaluator = new MeshEvaluator(
      () => this.host.getDoc(),
      (id) => {
        const n = this.nodes.get(id);
        return n ? n.root.matrix : new Matrix4();
      },
    );
    this.studioXray.transparent = true;
    this.studioXray.depthWrite = false;
    this.studioXray.uniforms.uOpacity.value = 0.3;
    this.scene.name = 'Scène';
    this.overlay.name = 'Overlay';
    this.scene.background = new Color(COLOR_VIEWPORT_BG);
  }

  /** Branche le générateur d'environnement (exige un contexte WebGL). */
  setWorldEnv(env: WorldEnv | null): void {
    this.worldEnv = env;
    this.worldDirty = true;
  }

  get settings(): SceneSettings {
    return this.sceneSettings;
  }

  get render(): RenderSettings {
    return this.sceneSettings.render;
  }

  get world(): WorldState | null {
    return this.worldState;
  }

  get bounds(): Sphere {
    return this.sceneBounds;
  }

  get effectiveShading(): ShadingMode {
    return this.shading;
  }

  // ------------------------------------------------------------------ document

  attach(doc: SceneDoc): void {
    this.detach();
    this.doc = doc;
    this.sceneSettings = doc.getScene();
    this.worldDirty = true;
    this.docOffs = [
      doc.on('objects', (e) => {
        for (const id of e.removed) {
          this.removed.add(id);
          this.created.delete(id);
        }
        for (const id of e.added) {
          this.created.add(id);
        }
        for (const c of e.changed) this.onObjectChanged(c.id, c.keys);
        if (e.removed.length || e.added.length) this.boundsDirty = true;
        this.host.requestRender();
      }),
      doc.on('mesh', (e) => {
        const users = this.meshUsers.get(e.id);
        if (users) for (const id of users) this.mark(id, F_GEOMETRY);
        this.host.requestRender();
      }),
      doc.on('data', (e) => {
        const ids = [...e.added, ...e.removed, ...e.changed];
        if (e.table === 'materials') {
          for (const id of [...e.changed, ...e.removed]) this.materials.update(doc, id);
          if (e.added.length || e.removed.length) for (const n of this.nodes.values()) if (n.type === 'mesh') this.mark(n.id, F_MATERIAL);
          this.host.markDirty('materials');
        } else if (e.table === 'nodeTrees') {
          if (this.materials.updateTrees(doc, ids)) this.host.markDirty('materials');
        } else if (e.table === 'collections') {
          for (const n of this.nodes.values()) this.mark(n.id, F_VISIBILITY);
        } else {
          const set = new Set(ids);
          const type = e.table === 'lights' ? 'light' : 'camera';
          for (const n of this.nodes.values()) if (n.type === type && n.dataId && set.has(n.dataId)) this.mark(n.id, F_DATA);
          if (type === 'light') this.host.markDirty('lights');
          else this.host.markDirty('camera');
        }
        this.host.requestRender();
      }),
      doc.on('scene', (e) => {
        this.sceneSettings = doc.getScene();
        let lights = false;
        for (const k of e.keys) {
          if (k.startsWith('w:')) this.worldDirty = true;
          else if (k === 'r:shadows') lights = true;
          else if (k === 'r:resX' || k === 'r:resY' || k === 'activeCamera') {
            for (const n of this.nodes.values()) if (n.type === 'camera') this.mark(n.id, F_DATA | F_STYLE);
            this.host.markDirty('camera');
          }
        }
        if (lights) {
          for (const n of this.nodes.values()) if (n.type === 'light') this.mark(n.id, F_DATA);
          this.host.markDirty('lights');
        }
        this.host.requestRender();
      }),
    ];
    for (const id of doc.objectIds()) this.created.add(id);
    this.host.requestRender();
  }

  detach(): void {
    for (const off of this.docOffs) off();
    this.docOffs = [];
    for (const id of [...this.nodes.keys()]) this.destroyNode(id);
    this.nodes.clear();
    this.dirty.clear();
    this.created.clear();
    this.removed.clear();
    this.meshUsers.clear();
    this.boolOwners.clear();
    this.evaluator.clear();
    this.materials.clear();
    this.doc = null;
  }

  private onObjectChanged(id: string, keys: string[]): void {
    let f = 0;
    for (const k of keys) {
      if (TRANSFORM_KEYS.has(k)) f |= F_TRANSFORM;
      else if (GEOMETRY_KEYS.has(k)) f |= F_GEOMETRY;
      else if (k === 'material') f |= F_MATERIAL;
      else if (VISIBILITY_KEYS.has(k)) f |= F_VISIBILITY;
      else if (k === 'data' || k === 'type') {
        // changement de nature : on recrée le nœud
        this.removed.add(id);
        this.created.add(id);
      } else if (k === 'name') {
        const n = this.nodes.get(id);
        const o = this.doc?.getObject(id);
        if (n && o) n.root.name = o.name;
      }
    }
    if (f) this.mark(id, f);
    if (f & (F_TRANSFORM | F_VISIBILITY)) this.boundsDirty = true;
  }

  private mark(id: string, flags: number): void {
    this.dirty.set(id, (this.dirty.get(id) ?? 0) | flags);
  }

  /** Marque tous les nœuds (changement global : ombrage, sélection, overlays…). */
  markAll(flags: number): void {
    for (const id of this.nodes.keys()) this.mark(id, flags);
  }

  /** Sélection locale ou mode d'interaction changés. */
  markSelection(): void {
    this.markAll(F_STYLE);
  }

  /** Options d'overlay changées (fil de fer, lumières et caméras, présence). */
  markOverlays(): void {
    this.markAll(F_STYLE | F_VISIBILITY);
  }

  /** Force la remise à jour de l'affichage d'un objet. */
  invalidateNode(id: string): void {
    if (this.nodes.has(id)) this.mark(id, F_VISIBILITY | F_STYLE | F_DATA);
  }

  /** Sélections des autres utilisateurs : objet → couleur. */
  setPeerSelection(map: Map<string, string>): void {
    let same = map.size === this.peerSel.size;
    if (same) for (const [k, v] of map) if (this.peerSel.get(k) !== v) same = false;
    if (same) return;
    this.peerSel = new Map(map);
    this.markAll(F_STYLE);
    this.host.requestRender();
  }

  /** Bascule l'état « rendu final » : ombrage rendu, objets `renderable` uniquement, pas de rayons X. */
  setFinalRender(on: boolean): void {
    if (this.finalOverride === on) return;
    this.finalOverride = on;
    this.globalFlags |= 1;
  }

  get finalRender(): boolean {
    return this.finalOverride;
  }

  /** Taille de dessin changée : met à jour les uniformes des contours. */
  setResolution(w: number, h: number): void {
    const mats = [this.outlineSel, this.outlineActive, ...this.peerOutlineMats.values()];
    for (const m of mats) m.uniforms.uResolution.value.set(Math.max(1, w), Math.max(1, h));
  }

  /** Nombre de nœuds ou drapeaux en attente. */
  get pending(): boolean {
    return this.dirty.size > 0 || this.created.size > 0 || this.removed.size > 0 || this.globalFlags !== 0 || this.worldDirty;
  }

  // ------------------------------------------------------------------ flush

  /** Applique toutes les modifications en attente. Renvoie true si quelque chose a changé. */
  flush(): boolean {
    const doc = this.doc;
    if (!doc) return false;
    const st = this.host.getState();
    const shading: ShadingMode = this.finalOverride ? 'rendered' : st.shading;
    const xray = this.finalOverride ? false : st.xray || shading === 'wireframe';
    if (shading !== this.shading || xray !== this.xray) {
      const lightsChanged = (shading === 'rendered') !== (this.shading === 'rendered');
      this.shading = shading;
      this.xray = xray;
      this.materials.setXray(doc, xray && shading === 'material');
      this.lineMats.setDepthTest(!xray);
      this.markAll(F_MATERIAL | F_VISIBILITY | F_STYLE);
      this.worldDirty = true;
      this.host.markDirty('materials');
      if (lightsChanged) this.host.markDirty('lights');
    }
    if (this.globalFlags) {
      this.globalFlags = 0;
      this.markAll(F_ALL);
      this.worldDirty = true;
      this.boundsDirty = true;
    }
    if (!this.dirty.size && !this.created.size && !this.removed.size && !this.worldDirty && !this.boundsDirty) return false;

    let geometryChanged = false;
    let lightsChanged = false;

    // 1. suppressions / créations
    for (const id of this.removed) {
      if (this.nodes.has(id)) {
        this.destroyNode(id);
        geometryChanged = true;
      }
      this.dirty.delete(id);
      this.evaluator.forget(id);
    }
    this.removed.clear();
    for (const id of this.created) {
      const obj = doc.getObject(id);
      if (!obj) continue;
      if (this.nodes.has(id)) this.destroyNode(id);
      const n = emptyNode(id, obj);
      this.nodes.set(id, n);
      this.scene.add(n.root);
      this.overlay.add(n.ov);
      this.indexData(n);
      this.mark(id, F_ALL);
      geometryChanged = true;
    }
    this.created.clear();

    // 2. instantanés des objets marqués ; les objets disparus sans événement sont retirés
    const work = [...this.dirty];
    this.dirty.clear();
    const flagsOf = new Map<string, number>();
    for (const [id, f] of work) {
      const n = this.nodes.get(id);
      if (!n) continue;
      const obj = doc.getObject(id);
      if (!obj) {
        this.destroyNode(id);
        geometryChanged = true;
        continue;
      }
      n.obj = obj;
      flagsOf.set(id, f);
    }

    // 3. transformations (avec propagation aux descendants)
    const tDirty = [...flagsOf].filter(([, f]) => f & F_TRANSFORM).map(([id]) => id);
    if (tDirty.length) {
      this.updateTransforms(doc, tDirty, flagsOf);
      geometryChanged = true;
    }

    // 4. booléens : tout changement de géométrie ou de transformation peut affecter un opérande
    const anyGeo = geometryChanged || [...flagsOf.values()].some((f) => f & (F_GEOMETRY | F_TRANSFORM | F_VISIBILITY));
    if (anyGeo) for (const id of this.boolOwners) if (this.nodes.has(id)) flagsOf.set(id, (flagsOf.get(id) ?? 0) | F_GEOMETRY);

    // 5. contenu de chaque nœud
    for (const [id, f] of flagsOf) {
      const n = this.nodes.get(id);
      if (!n) continue;
      if (n.type === 'mesh') {
        if (f & F_GEOMETRY) {
          if (this.updateGeometry(n)) geometryChanged = true;
        }
        if (f & (F_GEOMETRY | F_MATERIAL)) this.applySurfaceMaterial(n);
        if (f & (F_GEOMETRY | F_VISIBILITY | F_STYLE | F_MATERIAL)) {
          this.applyMeshVisibility(doc, n, st);
          if (f & F_VISIBILITY) geometryChanged = true;
        }
      } else {
        if (f & (F_DATA | F_VISIBILITY | F_TRANSFORM)) {
          if (n.type === 'light') {
            this.updateLight(doc, n);
            lightsChanged = true;
          }
        }
        if (f & (F_DATA | F_VISIBILITY | F_STYLE)) this.updateGizmo(doc, n, st);
        if (f & F_VISIBILITY && n.type === 'light') lightsChanged = true;
      }
      this.updateBooleanIndex(n);
    }

    if (geometryChanged) {
      this.boundsDirty = true;
      this.host.markDirty('geometry');
    }
    if (this.boundsDirty) {
      this.boundsDirty = false;
      this.computeBounds();
      lightsChanged = true;
    }
    if (this.worldDirty) {
      this.worldDirty = false;
      this.applyWorld();
      lightsChanged = true;
      this.host.markDirty('environment');
    }
    if (lightsChanged) {
      this.placeSuns();
      this.host.markDirty('lights');
    }
    return true;
  }

  // ------------------------------------------------------------------ transformations

  private updateTransforms(doc: SceneDoc, ids: string[], flagsOf: Map<string, number>): void {
    // index enfants (parent effectif, sans cycle)
    const children = new Map<string, string[]>();
    const parentOf = new Map<string, string | null>();
    for (const id of this.nodes.keys()) {
      const p = doc.effectiveParent(id);
      parentOf.set(id, p);
      if (p) {
        let arr = children.get(p);
        if (!arr) children.set(p, (arr = []));
        arr.push(id);
      }
    }
    const todo = new Set<string>();
    const stack = [...ids];
    while (stack.length) {
      const id = stack.pop()!;
      if (todo.has(id)) continue;
      todo.add(id);
      const ch = children.get(id);
      if (ch) stack.push(...ch);
    }
    const done = new Set<string>();
    const tmp = new Matrix4();
    const compute = (id: string, depth: number): Matrix4 | null => {
      const n = this.nodes.get(id);
      if (!n) return null;
      if (done.has(id) || !todo.has(id) || depth > 256) return n.root.matrix;
      const obj = doc.getObject(id);
      if (!obj) return n.root.matrix;
      n.obj = obj;
      const p = parentOf.get(id) ?? null;
      const pm = p ? compute(p, depth + 1) : null;
      localMatrix(obj, tmp);
      if (pm) n.root.matrix.multiplyMatrices(pm, tmp);
      else n.root.matrix.copy(tmp);
      n.root.matrixWorld.copy(n.root.matrix);
      n.root.matrixWorldNeedsUpdate = false;
      n.ov.matrix.copy(n.root.matrix);
      n.ov.matrixWorld.copy(n.root.matrix);
      n.root.updateMatrixWorld(true);
      n.ov.updateMatrixWorld(true);
      done.add(id);
      return n.root.matrix;
    };
    for (const id of todo) {
      compute(id, 0);
      // les lumières suivent leur objet ; les gizmos de caméra/lumière aussi (pas de reconstruction)
      const n = this.nodes.get(id);
      if (n && n.type === 'light') flagsOf.set(id, (flagsOf.get(id) ?? 0) | F_DATA);
    }
  }

  // ------------------------------------------------------------------ maillages

  private indexData(n: ObjNode): void {
    if (n.type !== 'mesh' || !n.dataId) return;
    let set = this.meshUsers.get(n.dataId);
    if (!set) this.meshUsers.set(n.dataId, (set = new Set()));
    set.add(n.id);
  }

  private unindexData(n: ObjNode): void {
    if (!n.dataId) return;
    const set = this.meshUsers.get(n.dataId);
    if (!set) return;
    set.delete(n.id);
    if (!set.size) this.meshUsers.delete(n.dataId);
  }

  private updateBooleanIndex(n: ObjNode): void {
    if (n.type === 'mesh' && booleanTargets(n.obj.modifiers).length > 0) this.boolOwners.add(n.id);
    else this.boolOwners.delete(n.id);
  }

  /** Reconstruit la géométrie affichée ; renvoie true si elle a changé. */
  private updateGeometry(n: ObjNode): boolean {
    const rm = this.evaluator.renderMesh(n.id);
    if (rm === n.rm && n.geo) return false;
    const prev = n.geo;
    n.rm = rm;
    // Chemin rapide (déplacement de sommets) : mêmes tailles, géométrie non partagée → mise à jour sur place.
    const inPlace = rm ? this.pool.replaceInPlace(prev, rm) : null;
    if (inPlace) {
      // Contours : recalculés seulement s'ils sont affichés (jamais en mode édition) ;
      // sinon ils seront rattachés à la géométrie courante au moment de les montrer.
      if (n.outline?.visible) n.outline.geometry = this.pool.hull(inPlace);
      if (n.peerOutline?.visible) n.peerOutline.geometry = this.pool.hull(inPlace);
      n.boundsKey = '';
      return true;
    }
    n.geo = rm ? this.pool.acquire(rm) : null;
    const g = n.geo;
    if (g) {
      if (!n.surface) {
        n.surface = new Mesh(g.surface, this.materials.fallback);
        n.surface.onBeforeRender = nodeSurfaceBeforeRender;
        n.surface.castShadow = true;
        n.surface.receiveShadow = true;
        n.surface.userData.objectId = n.id;
        n.root.add(n.surface);
      } else n.surface.geometry = g.surface;
      if (!n.occluder) {
        n.occluder = new Mesh(g.surface, this.occluderMat);
        n.occluder.renderOrder = ORDER.occluder;
        n.ov.add(n.occluder);
      } else n.occluder.geometry = g.surface;
      if (!n.wire) {
        n.wire = new LineSegments(g.edges, this.lineMats.get('#000000', 0.5));
        n.wire.renderOrder = ORDER.wire;
        n.ov.add(n.wire);
      } else n.wire.geometry = g.edges;
      if (n.outline?.visible) n.outline.geometry = this.pool.hull(g);
      if (n.peerOutline?.visible) n.peerOutline.geometry = this.pool.hull(g);
      for (const o of [n.surface, n.occluder, n.wire, n.outline, n.peerOutline]) if (o) o.updateMatrixWorld(true);
    } else {
      for (const o of [n.surface, n.occluder, n.wire, n.outline, n.peerOutline]) o?.removeFromParent();
      n.surface = n.occluder = n.wire = n.outline = n.peerOutline = null;
    }
    this.pool.release(prev);
    n.boundsKey = '';
    return true;
  }

  private applySurfaceMaterial(n: ObjNode): void {
    if (!n.surface) return;
    const doc = this.doc;
    let mat: Material;
    if (this.shading === 'solid') mat = this.xray ? this.studioXray : this.studio;
    else mat = this.materials.get(doc, n.obj.material);
    if (n.surface.material !== mat) n.surface.material = mat;
  }

  /** Visibilité effective dans le viewport (ou au rendu final). */
  private computeVisible(doc: SceneDoc, n: ObjNode): boolean {
    if (this.finalOverride) return n.obj.renderable !== false;
    return doc.isObjectVisible(n.id);
  }

  private selStateOf(n: ObjNode, st: AppState): number {
    if (this.finalOverride) return 0;
    if (st.activeId === n.id && st.selection.has(n.id)) return 2;
    return st.selection.has(n.id) ? 1 : 0;
  }

  private applyMeshVisibility(doc: SceneDoc, n: ObjNode, st: AppState): void {
    const visible = this.computeVisible(doc, n);
    n.visible = visible;
    n.root.visible = visible;
    n.ov.visible = visible && !this.finalOverride;
    const display = this.finalOverride ? 'solid' : n.obj.displayAs;
    const solid = display === 'solid' && this.shading !== 'wireframe';
    if (n.surface) n.surface.visible = visible && solid;

    const editing = st.mode === 'edit' && st.activeId === n.id;
    const sel = this.selStateOf(n, st);
    n.selState = sel;
    const peer = this.finalOverride ? null : (this.peerSel.get(n.id) ?? null);
    n.peerColor = peer;
    const hasOutline = solid && !editing && (sel > 0 || (peer !== null && st.overlays.presence));

    // occulteur : partout hors rayons X ; en rayons X, seulement pour découper le contour
    if (n.occluder) n.occluder.visible = solid && (this.xray ? hasOutline : !this.sceneDepthAvailable);

    // fil de fer
    if (n.wire) {
      const showWire = display === 'wire' || this.shading === 'wireframe' || (st.overlays.wireframe && display === 'solid');
      n.wire.visible = showWire && !(editing && display === 'solid' && this.shading !== 'wireframe');
      let color = '#000000';
      let opacity = this.shading === 'wireframe' || display === 'wire' ? 0.85 : 0.35;
      if (sel === 2) {
        color = COLOR_ACTIVE;
        opacity = 1;
      } else if (sel === 1) {
        color = COLOR_SELECTED;
        opacity = 1;
      } else if (peer && st.overlays.presence) {
        color = peer;
        opacity = 0.9;
      } else if (this.shading === 'wireframe' || display === 'wire') color = '#111111';
      n.wire.material = this.lineMats.get(color, opacity);
    }

    // contour local
    const g = n.geo;
    if (g && hasOutline && sel > 0) {
      if (!n.outline) {
        n.outline = new Mesh(this.pool.hull(g), this.outlineSel);
        n.outline.renderOrder = ORDER.outline;
        n.ov.add(n.outline);
        n.outline.updateMatrixWorld(true);
      }
      n.outline.material = sel === 2 ? this.outlineActive : this.outlineSel;
      const hull = this.pool.hull(g);
      if (n.outline.geometry !== hull) n.outline.geometry = hull;
      n.outline.visible = true;
    } else if (n.outline) n.outline.visible = false;

    // contour d'un autre utilisateur
    if (g && hasOutline && peer && st.overlays.presence) {
      if (!n.peerOutline) {
        n.peerOutline = new Mesh(this.pool.hull(g), this.peerOutlineMaterial(peer));
        n.peerOutline.renderOrder = ORDER.peerOutline;
        n.ov.add(n.peerOutline);
        n.peerOutline.updateMatrixWorld(true);
      }
      n.peerOutline.material = this.peerOutlineMaterial(peer);
      const hull = this.pool.hull(g);
      if (n.peerOutline.geometry !== hull) n.peerOutline.geometry = hull;
      n.peerOutline.visible = true;
    } else if (n.peerOutline) n.peerOutline.visible = false;

    // boîte englobante (affichage « bounds »)
    if (display === 'bounds' && g && !g.bounds.isEmpty()) {
      const key = `${g.bounds.min.toArray().join(',')}|${g.bounds.max.toArray().join(',')}`;
      if (!n.bounds || n.boundsKey !== key) {
        n.bounds?.geometry.dispose();
        const geom = boxGizmoGeometry(g.bounds.min.toArray() as any, g.bounds.max.toArray() as any);
        if (!n.bounds) {
          n.bounds = new LineSegments(geom, this.lineMats.get('#000000', 0.85));
          n.bounds.renderOrder = ORDER.wire;
          n.ov.add(n.bounds);
          n.bounds.updateMatrixWorld(true);
        } else n.bounds.geometry = geom;
        n.boundsKey = key;
      }
      n.bounds.material = this.lineMats.get(sel === 2 ? COLOR_ACTIVE : sel === 1 ? COLOR_SELECTED : (peer ?? '#000000'), sel ? 1 : 0.85);
      n.bounds.visible = true;
    } else if (n.bounds) n.bounds.visible = false;
  }

  private peerOutlineMaterial(color: string): ShaderMaterial {
    let m = this.peerOutlineMats.get(color);
    if (!m) {
      m = createOutlineMaterial(color, 3.5);
      const { width, height } = this.host.drawingSize();
      m.uniforms.uResolution.value.set(Math.max(1, width), Math.max(1, height));
      this.peerOutlineMats.set(color, m);
    }
    return m;
  }

  // ------------------------------------------------------------------ lumières, caméras, empties

  private updateLight(doc: SceneDoc, n: ObjNode): void {
    const data: LightData | null = n.dataId ? doc.getLight(n.dataId) : null;
    n.visible = this.computeVisible(doc, n);
    n.ov.visible = n.visible && !this.finalOverride;
    if (!data) {
      if (n.light) {
        disposeLight(n.light);
        n.light = null;
        n.lightKind = null;
      }
      return;
    }
    if (!n.light || n.lightKind !== data.kind) {
      if (n.light) disposeLight(n.light);
      n.light = createLight(data.kind);
      n.lightKind = data.kind;
      n.light.userData.objectId = n.id;
      // le soleil est placé en coordonnées monde (voir placeSuns) ; les autres suivent leur objet
      if (data.kind === 'sun') this.scene.add(n.light);
      else n.root.add(n.light);
    }
    applyLightData(n.light, data, this.render.shadows);
    n.light.visible = n.visible && this.shading === 'rendered';
    n.light.updateMatrixWorld(true);
  }

  private updateGizmo(doc: SceneDoc, n: ObjNode, st: AppState): void {
    n.visible = this.computeVisible(doc, n);
    n.ov.visible = n.visible && !this.finalOverride;
    let key = '';
    let build: (() => BufferGeometry) | null = null;
    if (n.type === 'light') {
      const d = n.dataId ? doc.getLight(n.dataId) : null;
      if (d) {
        key = `L|${d.kind}|${d.spotAngle}|${d.sizeX}|${d.sizeY}|${d.radius}`;
        build = () => lightGizmoGeometry(d);
      }
    } else if (n.type === 'camera') {
      const d: CameraData | null = n.dataId ? doc.getCamera(n.dataId) : null;
      if (d) {
        const r = this.render;
        const aspect = finite(r.resX, 1920) / Math.max(1, finite(r.resY, 1080));
        key = `C|${d.kind}|${d.fov}|${d.orthoScale}|${aspect}`;
        build = () => cameraGizmoGeometry(d, aspect);
      }
    } else if (n.type === 'empty') {
      key = 'E';
      build = emptyGizmoGeometry;
    }
    if (!build) {
      if (n.gizmo) {
        n.gizmo.geometry.dispose();
        n.gizmo.removeFromParent();
        n.gizmo = null;
        n.gizmoKey = '';
      }
      return;
    }
    if (!n.gizmo || n.gizmoKey !== key) {
      const geom = build();
      if (!n.gizmo) {
        n.gizmo = new LineSegments(geom, this.lineMats.get('#000000', 0.9));
        n.gizmo.renderOrder = ORDER.gizmo;
        n.gizmo.userData.objectId = n.id;
        n.ov.add(n.gizmo);
        n.gizmo.updateMatrixWorld(true);
      } else {
        n.gizmo.geometry.dispose();
        n.gizmo.geometry = geom;
      }
      n.gizmoKey = key;
    }
    const sel = this.selStateOf(n, st);
    n.selState = sel;
    const peer = this.peerSel.get(n.id) ?? null;
    n.peerColor = peer;
    const isActiveCam = n.type === 'camera' && this.settings.activeCamera === n.id;
    const color = sel === 2 ? COLOR_ACTIVE : sel === 1 ? COLOR_SELECTED : peer && st.overlays.presence ? peer : '#000000';
    n.gizmo.material = this.lineMats.get(color, sel || isActiveCam ? 1 : 0.8);
    n.gizmo.visible = n.type === 'empty' || st.overlays.lightsAndCameras;
  }

  /** Gizmo (lumière / caméra / empty) affiché et pickable ? */
  gizmoPickable(n: ObjNode): boolean {
    return !!n.gizmo && n.visible && n.gizmo.visible;
  }

  // ------------------------------------------------------------------ monde, soleils, englobant

  private computeBounds(): void {
    const box = new Box3();
    const tmp = new Box3();
    for (const n of this.nodes.values()) {
      if (n.type !== 'mesh' || !n.visible || !n.geo || n.geo.bounds.isEmpty()) continue;
      tmp.copy(n.geo.bounds).applyMatrix4(n.root.matrix);
      box.union(tmp);
    }
    if (box.isEmpty()) this.sceneBounds.set(new Vector3(), 10);
    else box.getBoundingSphere(this.sceneBounds);
  }

  private placeSuns(): void {
    const c = this.sceneBounds.center;
    const r = Math.max(1, this.sceneBounds.radius * 1.2);
    const dir = new Vector3();
    for (const n of this.nodes.values()) {
      if (n.lightKind !== 'sun' || !n.light) continue;
      travelDirection(n.root, dir);
      placeSun(n.light as DirectionalLight, dir, c, r);
      n.light.updateMatrixWorld(true);
      n.light.visible = n.visible && this.shading === 'rendered';
    }
    const ws = this.worldState;
    if (ws?.sun && this.shading === 'rendered') {
      if (!this.worldSun) {
        this.worldSun = createLight('sun') as DirectionalLight;
        this.worldSun.name = 'Soleil du ciel';
        this.scene.add(this.worldSun);
      }
      const s = this.worldSun;
      s.color.copy(ws.sun.color);
      s.intensity = ws.sun.intensity;
      const shadows = this.render.shadows;
      s.castShadow = shadows !== 'off';
      const size = shadows === 'high' ? 4096 : 1024;
      if (s.shadow.mapSize.x !== size) {
        s.shadow.mapSize.set(size, size);
        s.shadow.map?.dispose();
        (s.shadow as any).map = null;
      }
      s.shadow.radius = shadows === 'high' ? 3 : 2;
      placeSun(s, ws.sun.travel, c, r);
      s.updateMatrixWorld(true);
      s.visible = ws.sun.intensity > 0;
    } else if (this.worldSun) this.worldSun.visible = false;
  }

  private applyWorld(): void {
    const scene = this.scene;
    const bg = new Color(COLOR_VIEWPORT_BG);
    if (this.shading === 'rendered') {
      const env = this.worldEnv;
      if (env) {
        try {
          this.worldState = env.update(this.settings.world);
        } catch (err) {
          console.error("[engine] mise à jour de l'environnement impossible", err);
          this.worldState = null;
        }
      }
      const ws = this.worldState;
      scene.background = ws?.background ?? bg;
      scene.environment = ws?.environment ?? null;
      scene.environmentIntensity = ws?.intensity ?? 1;
      scene.backgroundIntensity = ws?.intensity ?? 1;
      scene.userData.ptEnvironment = ws?.ptEnvironment ?? null;
      scene.userData.worldIntensity = ws?.intensity ?? 1;
    } else if (this.shading === 'material') {
      scene.background = bg;
      let studio = null;
      try {
        studio = this.worldEnv ? this.worldEnv.studio : null;
      } catch (err) {
        console.error('[engine] environnement studio indisponible', err);
      }
      scene.environment = studio;
      scene.environmentIntensity = 1;
      scene.backgroundIntensity = 1;
      scene.userData.ptEnvironment = null;
      scene.userData.worldIntensity = 1;
    } else {
      scene.background = bg;
      scene.environment = null;
      scene.userData.ptEnvironment = null;
    }
    for (const n of this.nodes.values()) if (n.light) n.light.visible = n.visible && this.shading === 'rendered';
  }

  // ------------------------------------------------------------------ accès

  /** Matériau physique d'un objet maillage (export). */
  physicalMaterialOf(id: string): MeshPhysicalMaterial {
    const n = this.nodes.get(id);
    return this.materials.get(this.doc, n?.obj.material ?? null);
  }

  get visibleXray(): boolean {
    return this.xray;
  }

  private destroyNode(id: string): void {
    const n = this.nodes.get(id);
    if (!n) return;
    this.nodes.delete(id);
    this.unindexData(n);
    this.boolOwners.delete(id);
    if (n.light) disposeLight(n.light);
    n.gizmo?.geometry.dispose();
    n.bounds?.geometry.dispose();
    this.pool.release(n.geo);
    n.geo = null;
    n.root.removeFromParent();
    n.ov.removeFromParent();
    n.root.clear();
    n.ov.clear();
  }

  dispose(): void {
    this.detach();
    this.pool.clear();
    this.materials.dispose();
    this.lineMats.dispose();
    this.studio.dispose();
    this.studioXray.dispose();
    this.occluderMat.dispose();
    this.outlineSel.dispose();
    this.outlineActive.dispose();
    for (const m of this.peerOutlineMats.values()) m.dispose();
    this.peerOutlineMats.clear();
    if (this.worldSun) disposeLight(this.worldSun);
    this.worldSun = null;
    this.scene.clear();
    this.overlay.clear();
  }
}
