import * as Y from 'yjs';
import { newId } from '../ids';
import {
  CAMERA_DEFAULTS,
  LIGHT_DEFAULTS,
  MATERIAL_DEFAULTS,
  type NodeTreeData,
  type TextData,
  OBJECT_DEFAULTS,
  ROOT_COLLECTION,
  SCENE_DEFAULTS,
  SCHEMA_VERSION,
  type CameraData,
  type ChatMessage,
  type CollectionData,
  type LightData,
  type MaterialData,
  type MeshData,
  type MeshDelta,
  type ObjectData,
  type RenderSettings,
  type SceneSettings,
  type Vec3,
  type WorldSettings,
  ANIM_CURVE_DEFAULTS,
  ANIM_DEFAULTS,
  ANIM_FRAME_EPS,
  curveKey,
  type AnimCurveFlags,
  type AnimPath,
  type AnimSettings,
  type KeyframeData,
} from './schema';
import { AnimLayer } from '../anim/layer';
import { evaluatePoints, keyAtFrame, type CurveEval } from '../anim/fcurve';
import { animProp, animPropByField, animPropsOf, fieldComponents, propOrder, readProp, type AnimOwnerKind, type AnimTarget } from '../anim/props';

/**
 * SceneDoc : façade typée au-dessus du Y.Doc partagé.
 *
 * C'est LE point d'accès unique aux données de scène. Personne d'autre ne
 * manipule directement les types Yjs : on lit des instantanés JS simples
 * (getObject, getMesh…) et on écrit par les méthodes ci-dessous. Chaque
 * écriture locale passe par `transact`, ce qui la rend annulable (Ctrl+Z ne
 * défait que les actions de l'utilisateur local) et la diffuse aux autres.
 *
 * Structure du Y.Doc :
 *   objects     Y.Map<id, Y.Map<clé, valeur JSON>>   (une clé = une propriété, dernier écrivain gagne par propriété)
 *   meshes      Y.Map<id, Y.Map{ name, verts: Y.Map<vid, Vec3>, faces: Y.Map<fid, vid[]> }>
 *   lights / cameras / materials / collections   Y.Map<id, Y.Map<clé, valeur>>
 *   scene       Y.Map (clés 'name', 'activeCamera', 'w:<clé monde>', 'r:<clé rendu>')
 *   chat        Y.Array<ChatMessage>
 *   meta        Y.Map { schema }
 *   animKeys    Y.Map<idClé, KeyframeData>   images clés, une entrée indépendante chacune (voir schema.ts)
 *   animCurves  Y.Map<cléCourbe, AnimCurveFlags>
 *
 * Animation : les lecteurs (getObject, getLight, getCamera, getMaterial) renvoient la scène
 * ÉVALUÉE à l'image courante LOCALE (`setAnimFrame`), comme les propriétés de Blender après un
 * changement d'image. Modifier une propriété animée sans auto-key la change temporairement (jusqu'au
 * prochain changement d'image) ; avec auto-key (`setAutoKey(true)`) une clé est posée / mise à jour.
 *
 * Tolérance aux conflits : comme les éditions sont concurrentes, une référence
 * peut pointer vers un élément supprimé par quelqu'un d'autre. Les lecteurs
 * normalisent : parent/matériau/collection inexistants → valeur par défaut,
 * faces dont un sommet a disparu → ignorées.
 */

export type DataTable = 'lights' | 'cameras' | 'materials' | 'collections' | 'nodeTrees' | 'texts';

export interface DocEvents {
  /**
   * Émis une fois après toute transaction ayant modifié le document. Aussi émis (local: false,
   * anim: true) quand la scène ÉVALUÉE change sans que le document change (changement d'image).
   */
  change: { local: boolean; anim?: boolean };
  /** Des images clés ou des réglages de courbe ont changé (propriétaires concernés). */
  anim: { owners: string[]; local: boolean };
  objects: {
    added: string[];
    removed: string[];
    /** Objets existants dont des propriétés ont changé, avec la liste des clés. */
    changed: { id: string; keys: string[] }[];
    local: boolean;
  };
  mesh: {
    id: string;
    /** Sommets dont seule la position a changé (vide si topologyChanged). */
    vertsChanged: string[];
    /** Des sommets ou faces ont été ajoutés/supprimés/redéfinis (ou le maillage vient d'être créé). */
    topologyChanged: boolean;
    removed: boolean;
    local: boolean;
  };
  data: { table: DataTable; added: string[]; removed: string[]; changed: string[]; local: boolean };
  scene: { keys: string[]; local: boolean };
  chat: { local: boolean };
  /** La pile d'annulation a changé. */
  undo: { canUndo: boolean; canRedo: boolean };
}

type Listener<K extends keyof DocEvents> = (e: DocEvents[K]) => void;

const WORLD_KEYS = Object.keys(SCENE_DEFAULTS.world) as (keyof WorldSettings)[];
const RENDER_KEYS = Object.keys(SCENE_DEFAULTS.render) as (keyof RenderSettings)[];

function clone<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  return JSON.parse(JSON.stringify(v)) as T;
}

export class SceneDoc {
  readonly ydoc: Y.Doc;
  /** Origine des transactions locales (sert au suivi d'annulation). */
  readonly localOrigin = { coforge: 'local' };

  private yObjects: Y.Map<Y.Map<any>>;
  private yMeshes: Y.Map<Y.Map<any>>;
  private yTables: Record<DataTable, Y.Map<Y.Map<any>>>;
  private yScene: Y.Map<any>;
  private yChat: Y.Array<ChatMessage>;
  private yMeta: Y.Map<any>;
  private yAnimKeys: Y.Map<KeyframeData>;
  private yAnimCurves: Y.Map<Partial<AnimCurveFlags>>;

  /** Évaluation locale de l'animation (tête de lecture, valeurs animées et temporaires). */
  private anim = new AnimLayer();
  private autoKeyOn = false;
  private animAuthor: string | undefined;
  private tempAtOpStart: Map<string, Map<string, unknown>> | null = null;

  private undoManager: Y.UndoManager;
  private opDepth = 0;
  private opStackLength = 0;
  private lastLooseTransact = 0;

  private listeners = new Map<keyof DocEvents, Set<Listener<any>>>();
  private meshCache = new Map<string, MeshData>();
  private objectCache = new Map<string, ObjectData>();
  private destroyed = false;

  constructor(ydoc?: Y.Doc) {
    this.ydoc = ydoc ?? new Y.Doc();
    this.yObjects = this.ydoc.getMap('objects');
    this.yMeshes = this.ydoc.getMap('meshes');
    this.yTables = {
      lights: this.ydoc.getMap('lights'),
      cameras: this.ydoc.getMap('cameras'),
      materials: this.ydoc.getMap('materials'),
      collections: this.ydoc.getMap('collections'),
      nodeTrees: this.ydoc.getMap('nodeTrees'),
      texts: this.ydoc.getMap('texts'),
    };
    this.yScene = this.ydoc.getMap('scene');
    this.yChat = this.ydoc.getArray('chat');
    this.yMeta = this.ydoc.getMap('meta');
    this.yAnimKeys = this.ydoc.getMap('animKeys');
    this.yAnimCurves = this.ydoc.getMap('animCurves');
    // Documents existants (fichier ouvert) : index des clés ; un document sans animation est simplement vide.
    this.yAnimCurves.forEach((f, ck) => this.anim.setFlags(ck, f && typeof f === 'object' ? f : null));
    this.yAnimKeys.forEach((k, id) => this.anim.setKey(id, k && typeof k === 'object' ? k : null));
    for (const owner of this.anim.owners()) this.anim.evaluateOwner(owner);

    this.undoManager = new Y.UndoManager(
      [
        this.yObjects,
        this.yMeshes,
        this.yTables.lights,
        this.yTables.cameras,
        this.yTables.materials,
        this.yTables.collections,
        this.yTables.nodeTrees,
        this.yTables.texts,
        this.yScene,
        this.yAnimKeys,
        this.yAnimCurves,
      ],
      { trackedOrigins: new Set([this.localOrigin]), captureTimeout: 1e9 },
    );
    const emitUndo = () => this.emit('undo', { canUndo: this.canUndo(), canRedo: this.canRedo() });
    this.undoManager.on('stack-item-added', emitUndo);
    this.undoManager.on('stack-item-popped', emitUndo);
    this.undoManager.on('stack-cleared', emitUndo);

    this.observe();
  }

  // ------------------------------------------------------------------ création / (dé)sérialisation

  /** Document vide, sans contenu : à utiliser pour REJOINDRE une session (le contenu arrive du serveur). */
  static createEmpty(): SceneDoc {
    return new SceneDoc();
  }

  /** Nouvelle scène locale avec le contenu par défaut (cube, lumière, caméra). */
  static createNew(name = 'Scène'): SceneDoc {
    const doc = new SceneDoc();
    doc.ydoc.transact(() => {
      doc.yMeta.set('schema', SCHEMA_VERSION);
      doc.yScene.set('name', name);
      const mat = doc.addMaterial({ name: 'Matériau' });
      const cube = doc.createMesh(defaultCube(), 'Cube');
      doc.addObject({ name: 'Cube', type: 'mesh', data: cube, material: mat });
      const light = doc.addLight({ kind: 'point', power: 1000 });
      doc.addObject({ name: 'Lumière', type: 'light', data: light, pos: [4.08, 1.0, 5.9] });
      const cam = doc.addCamera({});
      const camObj = doc.addObject({
        name: 'Caméra',
        type: 'camera',
        data: cam,
        pos: [7.36, -6.93, 4.96],
        rot: [1.1093, 0, 0.8149],
      });
      doc.yScene.set('activeCamera', camObj);
    });
    // Le contenu initial ne doit pas être annulable.
    doc.undoManager.clear();
    return doc;
  }

  /** Recharge un document depuis un instantané binaire (fichier .coforge). */
  static fromUpdate(update: Uint8Array): SceneDoc {
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, update);
    return new SceneDoc(ydoc);
  }

  /** Instantané binaire complet du document (contenu d'un fichier .coforge). */
  encode(): Uint8Array {
    return Y.encodeStateAsUpdate(this.ydoc);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.undoManager.destroy();
    this.listeners.clear();
    this.ydoc.destroy();
  }

  // ------------------------------------------------------------------ événements

  on<K extends keyof DocEvents>(event: K, cb: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  }

  private emit<K extends keyof DocEvents>(event: K, payload: DocEvents[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(payload);
      } catch (err) {
        console.error(`[SceneDoc] erreur dans un écouteur '${event}'`, err);
      }
    }
  }

  private observe(): void {
    this.yObjects.observeDeep((events, tr) => {
      const added: string[] = [];
      const removed: string[] = [];
      const changed = new Map<string, Set<string>>();
      for (const ev of events) {
        if (ev.path.length === 0) {
          ev.changes.keys.forEach((change, key) => {
            this.objectCache.delete(key);
            if (change.action === 'add') added.push(key);
            else if (change.action === 'delete') removed.push(key);
            else {
              removed.push(key);
              added.push(key);
            }
          });
        } else {
          const id = String(ev.path[0]);
          this.objectCache.delete(id);
          let set = changed.get(id);
          if (!set) changed.set(id, (set = new Set()));
          ev.changes.keys.forEach((_c, key) => set!.add(key));
        }
      }
      this.emit('objects', {
        added,
        removed,
        changed: [...changed].filter(([id]) => !added.includes(id)).map(([id, keys]) => ({ id, keys: [...keys] })),
        local: tr.local,
      });
    });

    this.yMeshes.observeDeep((events, tr) => {
      const perMesh = new Map<string, { verts: Set<string>; topo: boolean; removed: boolean }>();
      const entry = (id: string) => {
        let e = perMesh.get(id);
        if (!e) perMesh.set(id, (e = { verts: new Set(), topo: false, removed: false }));
        return e;
      };
      for (const ev of events) {
        if (ev.path.length === 0) {
          ev.changes.keys.forEach((change, key) => {
            const e = entry(key);
            if (change.action === 'delete') e.removed = true;
            else {
              e.topo = true;
              e.removed = false;
            }
          });
        } else {
          const id = String(ev.path[0]);
          const e = entry(id);
          const sub = ev.path[1];
          if (sub === 'verts') {
            ev.changes.keys.forEach((change, key) => {
              if (change.action === 'update') e.verts.add(key);
              else e.topo = true;
            });
          } else if (sub === 'faces') {
            e.topo = true;
          } else {
            // remplacement des sous-maps verts/faces ou changement de nom
            ev.changes.keys.forEach((_c, key) => {
              if (key === 'verts' || key === 'faces') e.topo = true;
            });
          }
        }
      }
      for (const [id, e] of perMesh) {
        const old = this.meshCache.get(id);
        this.meshCache.delete(id);
        if (old && !e.topo && !e.removed && e.verts.size > 0) {
          // Déplacement pur (cas de G/R/S, glisser…) : instantané incrémental. La table des faces
          // est RÉUTILISÉE telle quelle (même identité) : les caches de topologie en aval
          // (triangulation, cage d'édition) la reconnaissent et ne recalculent que des positions.
          const yv = (this.yMeshes.get(id)?.get('verts') as Y.Map<Vec3> | undefined) ?? null;
          if (yv) {
            const verts = new Map(old.verts);
            let ok = true;
            for (const vid of e.verts) {
              const p = yv.get(vid);
              if (!Array.isArray(p) || p.length !== 3 || !verts.has(vid)) {
                ok = false;
                break;
              }
              verts.set(vid, p);
            }
            if (ok) this.meshCache.set(id, { verts, faces: old.faces });
          }
        }
        this.emit('mesh', {
          id,
          vertsChanged: e.topo || e.removed ? [] : [...e.verts],
          topologyChanged: e.topo && !e.removed,
          removed: e.removed,
          local: tr.local,
        });
      }
    });

    (Object.keys(this.yTables) as DataTable[]).forEach((table) => {
      this.yTables[table].observeDeep((events, tr) => {
        const added: string[] = [];
        const removed: string[] = [];
        const changed = new Set<string>();
        for (const ev of events) {
          if (ev.path.length === 0) {
            ev.changes.keys.forEach((change, key) => {
              if (change.action === 'add') added.push(key);
              else if (change.action === 'delete') removed.push(key);
              else changed.add(key);
            });
          } else changed.add(String(ev.path[0]));
        }
        if (table === 'collections' || table === 'materials') this.objectCache.clear();
        this.emit('data', { table, added, removed, changed: [...changed].filter((id) => !added.includes(id)), local: tr.local });
      });
    });

    this.yScene.observe((ev, tr) => {
      this.emit('scene', { keys: [...ev.changes.keys.keys()], local: tr.local });
    });
    this.yChat.observe((_ev, tr) => this.emit('chat', { local: tr.local }));

    this.yAnimKeys.observe((ev, tr) => {
      const owners = new Set<string>();
      ev.changes.keys.forEach((_c, id) => {
        const k = this.yAnimKeys.get(id);
        for (const o of this.anim.setKey(id, k && typeof k === 'object' ? k : null)) owners.add(o);
      });
      this.afterAnimChange(owners, tr.local);
    });
    this.yAnimCurves.observe((ev, tr) => {
      const owners = new Set<string>();
      ev.changes.keys.forEach((_c, ck) => {
        const f = this.yAnimCurves.get(ck);
        this.anim.setFlags(ck, f && typeof f === 'object' ? f : null);
        owners.add(ck.split('|')[0]);
      });
      this.afterAnimChange(owners, tr.local);
    });

    this.ydoc.on('afterTransaction', (tr: Y.Transaction) => {
      if (tr.changed.size > 0) this.emit('change', { local: tr.local });
    });
  }

  // ------------------------------------------------------------------ transactions et annulation

  /**
   * Regroupe des écritures en une transaction locale (une seule diffusion
   * réseau, un seul lot d'événements). Toutes les méthodes d'écriture de
   * SceneDoc l'utilisent déjà ; appelez-la pour grouper plusieurs écritures.
   */
  transact<T>(fn: () => T): T {
    if (this.opDepth === 0) {
      // Hors opération explicite : on regroupe les rafales (ex. glisser d'un curseur
      // de propriété) et on sépare ce qui est espacé de plus de 400 ms.
      const now = Date.now();
      if (now - this.lastLooseTransact > 400) this.undoManager.stopCapturing();
      this.lastLooseTransact = now;
    }
    return this.ydoc.transact(fn, this.localOrigin) as T;
  }

  /**
   * Ouvre une opération utilisateur : toutes les écritures jusqu'à `endOp`
   * formeront UNE seule étape d'annulation, quel que soit le temps écoulé
   * (ex. un déplacement modal qui écrit à chaque mouvement de souris).
   * Les appels peuvent être imbriqués.
   */
  beginOp(): void {
    if (this.opDepth === 0) {
      this.undoManager.stopCapturing();
      this.opStackLength = this.undoManager.undoStack.length;
      this.tempAtOpStart = this.anim.snapshotTemp();
    }
    this.opDepth++;
  }

  /**
   * Annule l'opération en cours (ouverte par `beginOp`) : tout ce qu'elle a
   * écrit est défait, sans laisser de trace dans l'historique (ni annuler ni
   * rétablir). C'est le mécanisme universel du « Échap / clic droit » des
   * opérations modales : elles n'ont rien à restaurer elles-mêmes.
   */
  cancelOp(): void {
    if (this.opDepth === 0) return;
    this.opDepth = 0;
    this.undoManager.stopCapturing();
    this.lastLooseTransact = 0;
    if (this.undoManager.undoStack.length > this.opStackLength) {
      this.undoManager.undo();
      this.undoManager.redoStack.pop();
      this.emit('undo', { canUndo: this.canUndo(), canRedo: this.canRedo() });
    }
    // Valeurs temporaires (propriétés animées modifiées sans auto-key) : remises comme avant l'opération.
    const snap = this.tempAtOpStart;
    this.tempAtOpStart = null;
    if (snap) this.emitAnimValues(new Set(this.anim.restoreTemp(snap)), true);
  }

  endOp(): void {
    if (this.opDepth === 0) return;
    this.opDepth--;
    if (this.opDepth === 0) {
      this.undoManager.stopCapturing();
      this.lastLooseTransact = 0;
      this.tempAtOpStart = null;
    }
  }

  undo(): void {
    this.undoManager.undo();
  }
  redo(): void {
    this.undoManager.redo();
  }
  canUndo(): boolean {
    return this.undoManager.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.undoManager.redoStack.length > 0;
  }
  clearHistory(): void {
    this.undoManager.clear();
  }

  // ------------------------------------------------------------------ objets

  objectIds(): string[] {
    return [...this.yObjects.keys()];
  }

  hasObject(id: string): boolean {
    return this.yObjects.has(id);
  }

  /** Instantané (en cache, LECTURE SEULE) d'un objet, références normalisées. */
  getObject(id: string): ObjectData | null {
    const cached = this.objectCache.get(id);
    if (cached) return cached;
    const y = this.yObjects.get(id);
    if (!y) return null;
    const raw = y.toJSON() as Partial<ObjectData>;
    const obj: ObjectData = {
      ...clone(OBJECT_DEFAULTS),
      name: 'Objet',
      type: 'empty',
      ...raw,
      id,
    };
    if (obj.parent && (obj.parent === id || !this.yObjects.has(obj.parent))) obj.parent = null;
    if (obj.collection !== ROOT_COLLECTION && !this.yTables.collections.has(obj.collection)) obj.collection = ROOT_COLLECTION;
    if (obj.material && !this.yTables.materials.has(obj.material)) obj.material = null;
    if (!Array.isArray(obj.modifiers)) obj.modifiers = [];
    this.anim.apply(id, 'object', obj, this.renderAspect());
    this.objectCache.set(id, obj);
    return obj;
  }

  listObjects(): ObjectData[] {
    const out: ObjectData[] = [];
    for (const id of this.yObjects.keys()) {
      const o = this.getObject(id);
      if (o) out.push(o);
    }
    return out;
  }

  /**
   * Parent effectif d'un objet, garanti sans cycle. Deux utilisateurs peuvent
   * créer un cycle en parentant simultanément A→B et B→A : dans ce cas le
   * membre du cycle au plus petit identifiant est traité comme racine.
   * À utiliser partout où l'on parcourt la hiérarchie (matrices, outliner).
   */
  effectiveParent(id: string): string | null {
    const obj = this.getObject(id);
    if (!obj || !obj.parent) return null;
    const seen = [id];
    let cur: string | null = obj.parent;
    while (cur) {
      if (cur === id) {
        // cycle contenant `id` : seul le plus petit identifiant devient racine
        const min = seen.reduce((a, b) => (a < b ? a : b));
        return min === id ? null : obj.parent;
      }
      if (seen.includes(cur)) return obj.parent; // cycle plus haut, qui ne contient pas `id`
      seen.push(cur);
      cur = this.getObject(cur)?.parent ?? null;
    }
    return obj.parent;
  }

  childrenOf(id: string | null): string[] {
    const out: string[] = [];
    for (const oid of this.yObjects.keys()) {
      if (this.effectiveParent(oid) === id) out.push(oid);
    }
    return out;
  }

  /** Nom unique à la Blender : « Cube », « Cube.001 », « Cube.002 »… */
  uniqueName(base: string): string {
    const names = new Set(this.listObjects().map((o) => o.name));
    const stem = base.replace(/\.\d{3}$/, '');
    if (!names.has(stem)) return stem;
    for (let i = 1; i < 10000; i++) {
      const n = `${stem}.${String(i).padStart(3, '0')}`;
      if (!names.has(n)) return n;
    }
    return `${stem}.${newId(4)}`;
  }

  addObject(init: Partial<ObjectData> & Pick<ObjectData, 'type'>): string {
    const id = init.id ?? newId();
    return this.transact(() => {
      const y = new Y.Map<any>();
      const full: ObjectData = {
        ...clone(OBJECT_DEFAULTS),
        ...clone(init),
        name: this.uniqueName(init.name ?? defaultObjectName(init.type)),
        id,
      };
      for (const [k, v] of Object.entries(full)) {
        if (k !== 'id') y.set(k, v);
      }
      this.yObjects.set(id, y);
      return id;
    });
  }

  /** Modifie des propriétés d'un objet (une clé = une propriété synchronisée indépendamment). */
  updateObject(id: string, patch: Partial<Omit<ObjectData, 'id'>>): void {
    const y = this.yObjects.get(id);
    if (!y) return;
    const before = this.getObject(id);
    this.transact(() => {
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'id' || v === undefined) continue;
        y.set(k, clone(v));
      }
      if (before) this.animIntercept('object', id, before, patch);
    });
  }

  /**
   * Supprime un objet. Ses enfants sont rattachés à son parent (sans conserver
   * leur transformation monde, utilisez les utilitaires de transforms.ts avant
   * si nécessaire). Le bloc de données (maillage, lumière, caméra) est supprimé
   * s'il n'est plus utilisé par aucun autre objet.
   */
  removeObject(id: string): void {
    const obj = this.getObject(id);
    if (!obj) return;
    this.transact(() => {
      for (const child of this.childrenOf(id)) this.yObjects.get(child)?.set('parent', obj.parent);
      this.yObjects.delete(id);
      this.dropAnimOf(id);
      if (this.yScene.get('activeCamera') === id) this.yScene.set('activeCamera', null);
      if (obj.data) {
        const stillUsed = this.listObjects().some((o) => o.id !== id && o.data === obj.data && o.type === obj.type);
        if (!stillUsed) {
          if (obj.type === 'mesh') this.yMeshes.delete(obj.data);
          else if (obj.type === 'light') this.yTables.lights.delete(obj.data);
          else if (obj.type === 'camera') this.yTables.cameras.delete(obj.data);
          if (obj.type === 'light' || obj.type === 'camera') this.dropAnimOf(obj.data);
        }
      }
    });
  }

  /**
   * Duplique un objet. `linked` = true partage le même bloc de données
   * (instance), sinon le maillage/la lumière/la caméra est copié.
   */
  duplicateObject(id: string, opts: { linked?: boolean } = {}): string | null {
    const obj = this.getObject(id);
    if (!obj) return null;
    return this.transact(() => {
      let data = obj.data;
      if (data && !opts.linked) {
        if (obj.type === 'mesh') {
          const mesh = this.getMesh(data);
          data = mesh ? this.createMesh(mesh, this.getMeshName(data)) : null;
        } else if (obj.type === 'light') {
          const l = this.getLight(data);
          data = l ? this.addLight({ ...l, id: undefined }) : null;
        } else if (obj.type === 'camera') {
          const c = this.getCamera(data);
          data = c ? this.addCamera({ ...c, id: undefined }) : null;
        }
      }
      const copy: Partial<ObjectData> & Pick<ObjectData, 'type'> = { ...clone(obj), data };
      delete copy.id;
      copy.modifiers = obj.modifiers.map((m) => ({ ...clone(m), id: newId(8) }));
      const newIdent = this.addObject(copy);
      // L'animation suit la copie (comme « Dupliquer les données : action » de Blender).
      this.copyAnimTo(id, newIdent);
      if (data && obj.data && data !== obj.data && (obj.type === 'light' || obj.type === 'camera')) this.copyAnimTo(obj.data, data);
      return newIdent;
    });
  }

  // ------------------------------------------------------------------ maillages

  meshIds(): string[] {
    return [...this.yMeshes.keys()];
  }

  getMeshName(id: string): string {
    return (this.yMeshes.get(id)?.get('name') as string) ?? 'Maillage';
  }

  /**
   * Instantané (en cache, LECTURE SEULE) d'un maillage. Les faces dégénérées ou
   * référençant un sommet supprimé sont ignorées. Le cache est invalidé à
   * chaque modification : un nouvel objet MeshData est alors renvoyé.
   */
  getMesh(id: string): MeshData | null {
    const cached = this.meshCache.get(id);
    if (cached) return cached;
    const y = this.yMeshes.get(id);
    if (!y) return null;
    const yv = y.get('verts') as Y.Map<Vec3> | undefined;
    const yf = y.get('faces') as Y.Map<string[]> | undefined;
    const verts = new Map<string, Vec3>();
    const faces = new Map<string, string[]>();
    yv?.forEach((p, vid) => {
      if (Array.isArray(p) && p.length === 3) verts.set(vid, p);
    });
    yf?.forEach((loop, fid) => {
      if (!Array.isArray(loop) || loop.length < 3) return;
      for (const v of loop) if (!verts.has(v)) return;
      if (new Set(loop).size !== loop.length) return;
      faces.set(fid, loop);
    });
    const mesh: MeshData = { verts, faces };
    this.meshCache.set(id, mesh);
    return mesh;
  }

  createMesh(data: MeshData, name = 'Maillage'): string {
    const id = newId();
    this.transact(() => {
      const y = new Y.Map<any>();
      const yv = new Y.Map<Vec3>();
      const yf = new Y.Map<string[]>();
      data.verts.forEach((p, vid) => yv.set(vid, [p[0], p[1], p[2]]));
      data.faces.forEach((loop, fid) => yf.set(fid, [...loop]));
      y.set('name', name);
      y.set('verts', yv);
      y.set('faces', yf);
      this.yMeshes.set(id, y);
    });
    return id;
  }

  /** Applique une modification atomique (création/déplacement/suppression de sommets et faces). */
  applyMeshDelta(id: string, delta: MeshDelta): void {
    const y = this.yMeshes.get(id);
    if (!y) return;
    const yv = y.get('verts') as Y.Map<Vec3>;
    const yf = y.get('faces') as Y.Map<string[]>;
    this.transact(() => {
      if (delta.delFaces) for (const f of delta.delFaces) yf.delete(f);
      if (delta.delVerts) for (const v of delta.delVerts) yv.delete(v);
      if (delta.setVerts) for (const [vid, p] of Object.entries(delta.setVerts)) yv.set(vid, [p[0], p[1], p[2]]);
      if (delta.setFaces) for (const [fid, loop] of Object.entries(delta.setFaces)) yf.set(fid, [...loop]);
    });
  }

  /** Raccourci : déplace des sommets existants (aucun changement de topologie). */
  setMeshVerts(id: string, positions: Map<string, Vec3> | Record<string, Vec3>): void {
    const y = this.yMeshes.get(id);
    if (!y) return;
    const yv = y.get('verts') as Y.Map<Vec3>;
    const entries = positions instanceof Map ? positions.entries() : Object.entries(positions);
    this.transact(() => {
      for (const [vid, p] of entries) {
        if (yv.has(vid)) yv.set(vid, [p[0], p[1], p[2]]);
      }
    });
  }

  /** Remplace entièrement le contenu d'un maillage (par différence, pour limiter les conflits). */
  replaceMesh(id: string, data: MeshData): void {
    const current = this.getMesh(id);
    if (!current) return;
    const delta: MeshDelta = { setVerts: {}, setFaces: {}, delVerts: [], delFaces: [] };
    for (const vid of current.verts.keys()) if (!data.verts.has(vid)) delta.delVerts!.push(vid);
    for (const fid of current.faces.keys()) if (!data.faces.has(fid)) delta.delFaces!.push(fid);
    data.verts.forEach((p, vid) => {
      const old = current.verts.get(vid);
      if (!old || old[0] !== p[0] || old[1] !== p[1] || old[2] !== p[2]) delta.setVerts![vid] = p;
    });
    data.faces.forEach((loop, fid) => {
      const old = current.faces.get(fid);
      if (!old || old.length !== loop.length || old.some((v, i) => v !== loop[i])) delta.setFaces![fid] = loop;
    });
    // Les faces invalides stockées (non visibles dans l'instantané) sont aussi nettoyées.
    const yf = this.yMeshes.get(id)!.get('faces') as Y.Map<string[]>;
    yf.forEach((_l, fid) => {
      if (!current.faces.has(fid) && !data.faces.has(fid)) delta.delFaces!.push(fid);
    });
    this.applyMeshDelta(id, delta);
  }

  removeMesh(id: string): void {
    this.transact(() => this.yMeshes.delete(id));
  }

  // ------------------------------------------------------------------ tables génériques

  private tableGet<T extends { id: string }>(table: DataTable, id: string, defaults: object): T | null {
    const y = this.yTables[table].get(id);
    if (!y) return null;
    const out = { ...clone(defaults), ...(y.toJSON() as object), id } as T;
    const kind = TABLE_ANIM_KIND[table];
    if (kind) this.anim.apply(id, kind, out as unknown as AnimTarget, this.renderAspect());
    return out;
  }

  private tableAdd(table: DataTable, values: Record<string, any>, id = newId()): string {
    this.transact(() => {
      const y = new Y.Map<any>();
      for (const [k, v] of Object.entries(values)) {
        if (k !== 'id' && v !== undefined) y.set(k, clone(v));
      }
      this.yTables[table].set(id, y);
    });
    return id;
  }

  private tableUpdate(table: DataTable, id: string, patch: Record<string, any>): void {
    const y = this.yTables[table].get(id);
    if (!y) return;
    const kind = TABLE_ANIM_KIND[table];
    const before = kind ? this.animTarget(kind, id) : null;
    this.transact(() => {
      for (const [k, v] of Object.entries(patch)) {
        if (k !== 'id' && v !== undefined) y.set(k, clone(v));
      }
      if (kind && before) this.animIntercept(kind, id, before, patch);
    });
  }

  // lumières
  getLight(id: string): LightData | null {
    return this.tableGet<LightData>('lights', id, LIGHT_DEFAULTS);
  }
  addLight(init: Partial<LightData>): string {
    return this.tableAdd('lights', { ...LIGHT_DEFAULTS, ...init });
  }
  updateLight(id: string, patch: Partial<Omit<LightData, 'id'>>): void {
    this.tableUpdate('lights', id, patch);
  }

  // caméras
  getCamera(id: string): CameraData | null {
    return this.tableGet<CameraData>('cameras', id, CAMERA_DEFAULTS);
  }
  addCamera(init: Partial<CameraData>): string {
    return this.tableAdd('cameras', { ...CAMERA_DEFAULTS, ...init });
  }
  updateCamera(id: string, patch: Partial<Omit<CameraData, 'id'>>): void {
    this.tableUpdate('cameras', id, patch);
  }

  // arbres de nœuds
  nodeTreeIds(): string[] {
    return [...this.yTables.nodeTrees.keys()];
  }
  getNodeTree(id: string): NodeTreeData | null {
    return this.tableGet<NodeTreeData>('nodeTrees', id, { name: 'Arbre de nœuds', kind: 'shader', nodes: {}, links: [] });
  }
  listNodeTrees(kind?: NodeTreeData['kind']): NodeTreeData[] {
    return this.nodeTreeIds()
      .map((id) => this.getNodeTree(id)!)
      .filter((t) => t && (!kind || t.kind === kind))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  addNodeTree(init: Partial<NodeTreeData> & { kind: NodeTreeData['kind'] }): string {
    return this.tableAdd('nodeTrees', { name: init.kind === 'geometry' ? 'Nœuds de géométrie' : 'Nœuds de shader', nodes: {}, links: [], ...init });
  }
  /** `patch.nodes` et `patch.links` remplacent chacun le champ ENTIER. */
  updateNodeTree(id: string, patch: Partial<Omit<NodeTreeData, 'id'>>): void {
    this.tableUpdate('nodeTrees', id, patch);
  }
  /** Supprime un arbre et le détache des matériaux ; les modificateurs « nodes » qui le citent deviennent inertes. */
  removeNodeTree(id: string): void {
    this.transact(() => {
      this.yTables.nodeTrees.delete(id);
      this.yTables.materials.forEach((y) => {
        if (y.get('nodeTree') === id) y.set('nodeTree', null);
      });
    });
  }

  // textes (scripts)
  listTexts(): TextData[] {
    return [...this.yTables.texts.keys()]
      .map((id) => this.getText(id)!)
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  getText(id: string): TextData | null {
    return this.tableGet<TextData>('texts', id, { name: 'Texte', content: '' });
  }
  addText(init: Partial<TextData>): string {
    return this.tableAdd('texts', { name: 'Texte', content: '', ...init });
  }
  updateText(id: string, patch: Partial<Omit<TextData, 'id'>>): void {
    this.tableUpdate('texts', id, patch);
  }
  removeText(id: string): void {
    this.transact(() => this.yTables.texts.delete(id));
  }

  // matériaux
  materialIds(): string[] {
    return [...this.yTables.materials.keys()];
  }
  getMaterial(id: string): MaterialData | null {
    return this.tableGet<MaterialData>('materials', id, { ...MATERIAL_DEFAULTS, name: 'Matériau' });
  }
  listMaterials(): MaterialData[] {
    return this.materialIds()
      .map((id) => this.getMaterial(id)!)
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  addMaterial(init: Partial<MaterialData>): string {
    const names = new Set(this.listMaterials().map((m) => m.name));
    let name = init.name ?? 'Matériau';
    if (names.has(name)) {
      const stem = name.replace(/\.\d{3}$/, '');
      for (let i = 1; i < 10000; i++) {
        name = `${stem}.${String(i).padStart(3, '0')}`;
        if (!names.has(name)) break;
      }
    }
    return this.tableAdd('materials', { ...MATERIAL_DEFAULTS, ...init, name });
  }
  updateMaterial(id: string, patch: Partial<Omit<MaterialData, 'id'>>): void {
    this.tableUpdate('materials', id, patch);
  }
  /** Supprime un matériau ; les objets qui l'utilisaient n'ont plus de matériau. */
  removeMaterial(id: string): void {
    this.transact(() => {
      this.yTables.materials.delete(id);
      this.dropAnimOf(id);
      this.yObjects.forEach((y) => {
        if (y.get('material') === id) y.set('material', null);
      });
    });
  }

  // collections
  getCollection(id: string): CollectionData | null {
    const c = this.tableGet<CollectionData>('collections', id, { name: 'Collection', parent: ROOT_COLLECTION, visible: true });
    if (c && c.parent !== ROOT_COLLECTION && (c.parent === id || !this.yTables.collections.has(c.parent))) c.parent = ROOT_COLLECTION;
    return c;
  }
  listCollections(): CollectionData[] {
    return [...this.yTables.collections.keys()].map((id) => this.getCollection(id)!).filter(Boolean);
  }
  addCollection(init: Partial<CollectionData> = {}): string {
    const names = new Set(this.listCollections().map((c) => c.name));
    let name = init.name ?? 'Collection';
    for (let i = 1; names.has(name) && i < 10000; i++) name = `${init.name ?? 'Collection'} ${i + 1}`;
    return this.tableAdd('collections', { parent: ROOT_COLLECTION, visible: true, ...init, name });
  }
  updateCollection(id: string, patch: Partial<Omit<CollectionData, 'id'>>): void {
    this.tableUpdate('collections', id, patch);
  }
  /** Supprime une collection ; son contenu (objets et sous-collections) remonte dans sa collection parente. */
  removeCollection(id: string): void {
    const col = this.getCollection(id);
    if (!col) return;
    this.transact(() => {
      this.yObjects.forEach((y) => {
        if (y.get('collection') === id) y.set('collection', col.parent);
      });
      this.yTables.collections.forEach((y, cid) => {
        if (cid !== id && y.get('parent') === id) y.set('parent', col.parent);
      });
      this.yTables.collections.delete(id);
    });
  }
  /** Une collection est-elle visible, en tenant compte de ses ancêtres ? (sans cycle possible : garde de profondeur) */
  isCollectionVisible(id: string): boolean {
    let cur = id;
    for (let depth = 0; depth < 64 && cur !== ROOT_COLLECTION; depth++) {
      const c = this.getCollection(cur);
      if (!c) return true;
      if (!c.visible) return false;
      cur = c.parent;
    }
    return true;
  }
  /** Visibilité effective d'un objet dans le viewport : son drapeau ET celui de ses collections. */
  isObjectVisible(id: string): boolean {
    const o = this.getObject(id);
    return !!o && o.visible && this.isCollectionVisible(o.collection);
  }

  // ------------------------------------------------------------------ réglages de scène

  getScene(): SceneSettings {
    const world = { ...SCENE_DEFAULTS.world } as any;
    for (const k of WORLD_KEYS) {
      const v = this.yScene.get(`w:${k}`);
      if (v !== undefined) world[k] = v;
    }
    const render = { ...SCENE_DEFAULTS.render } as any;
    for (const k of RENDER_KEYS) {
      const v = this.yScene.get(`r:${k}`);
      if (v !== undefined) render[k] = v;
    }
    let activeCamera = (this.yScene.get('activeCamera') as string | null) ?? null;
    if (activeCamera && !this.yObjects.has(activeCamera)) activeCamera = null;
    return { name: (this.yScene.get('name') as string) ?? SCENE_DEFAULTS.name, activeCamera, world, render };
  }

  setSceneName(name: string): void {
    this.transact(() => this.yScene.set('name', name));
  }
  setActiveCamera(objectId: string | null): void {
    this.transact(() => this.yScene.set('activeCamera', objectId));
  }
  updateWorld(patch: Partial<WorldSettings>): void {
    this.transact(() => {
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) this.yScene.set(`w:${k}`, v);
    });
  }
  updateRender(patch: Partial<RenderSettings>): void {
    this.transact(() => {
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) this.yScene.set(`r:${k}`, v);
    });
  }

  // ------------------------------------------------------------------ animation : réglages partagés

  getAnimSettings(): AnimSettings {
    const num = (k: keyof AnimSettings) => {
      const v = this.yScene.get(`a:${k}`);
      return typeof v === 'number' && Number.isFinite(v) ? v : ANIM_DEFAULTS[k];
    };
    const frameStart = Math.round(num('frameStart'));
    const frameEnd = Math.max(frameStart, Math.round(num('frameEnd')));
    const fps = Math.max(1, Math.min(240, num('fps')));
    return { frameStart, frameEnd, fps };
  }

  updateAnimSettings(patch: Partial<AnimSettings>): void {
    this.transact(() => {
      for (const [k, v] of Object.entries(patch)) {
        if (typeof v === 'number' && Number.isFinite(v)) this.yScene.set(`a:${k}`, k === 'fps' ? v : Math.round(v));
      }
    });
  }

  // ------------------------------------------------------------------ animation : état local

  /** Image courante LOCALE (non partagée) à laquelle la scène est évaluée. */
  get animFrame(): number {
    return this.anim.frame;
  }

  /**
   * Change l'image courante locale : la scène lue (getObject…) est réévaluée, les valeurs
   * temporaires sont oubliées. N'écrit RIEN dans le document partagé.
   */
  setAnimFrame(frame: number): void {
    if (!Number.isFinite(frame) || frame === this.anim.frame) return;
    this.anim.frame = frame;
    const hadTemp = this.anim.clearTemp();
    this.emitAnimValues(new Set([...this.anim.owners(), ...hadTemp]), true, { force: new Set(hadTemp), notify: true });
  }

  get autoKey(): boolean {
    return this.autoKeyOn;
  }

  /** Auto-key : modifier une propriété animable pose ou met à jour une clé à l'image courante. */
  setAutoKey(on: boolean): void {
    this.autoKeyOn = !!on;
  }

  /** Utilisateur local, noté dans les clés qu'il écrit (`KeyframeData.by`). */
  setAnimAuthor(userId: string | undefined): void {
    this.animAuthor = userId;
  }

  // ------------------------------------------------------------------ animation : lecture

  /** Propriétaires (objets, lumières, caméras, matériaux EXISTANTS) qui ont des clés. */
  animOwners(): string[] {
    return this.anim.owners().filter((o) => this.ownerKind(o) !== null);
  }

  /** Type d'un propriétaire d'animation, ou null s'il n'existe pas (ou plus). */
  ownerKind(owner: string): AnimOwnerKind | null {
    if (this.yObjects.has(owner)) return 'object';
    if (this.yTables.lights.has(owner)) return 'light';
    if (this.yTables.cameras.has(owner)) return 'camera';
    if (this.yTables.materials.has(owner)) return 'material';
    return null;
  }

  /** Propriétaires d'animation liés à un objet : lui-même, sa lumière / caméra, son matériau. */
  objectAnimOwners(objectId: string): { owner: string; kind: AnimOwnerKind }[] {
    const o = this.getObject(objectId);
    if (!o) return [];
    const out: { owner: string; kind: AnimOwnerKind }[] = [{ owner: objectId, kind: 'object' }];
    if (o.type === 'light' && o.data && this.yTables.lights.has(o.data)) out.push({ owner: o.data, kind: 'light' });
    if (o.type === 'camera' && o.data && this.yTables.cameras.has(o.data)) out.push({ owner: o.data, kind: 'camera' });
    if (o.type === 'mesh' && o.material && this.yTables.materials.has(o.material)) out.push({ owner: o.material, kind: 'material' });
    return out;
  }

  /** Clés de courbe d'un propriétaire, dans l'ordre d'affichage (propriété, composante). */
  animCurveKeys(owner: string): string[] {
    return this.anim.curveKeysOf(owner).sort((a, b) => {
      const [, pa, ia] = a.split('|');
      const [, pb, ib] = b.split('|');
      return propOrder(pa) - propOrder(pb) || Number(ia) - Number(ib);
    });
  }

  /** Courbe évaluée (clés effectives triées, clés masquées, points avec poignées) et ses réglages. */
  getAnimCurve(ck: string): (CurveEval & { key: string; owner: string; path: AnimPath; index: number; flags: AnimCurveFlags }) | null {
    const c = this.anim.curve(ck);
    if (!c || c.keys.length === 0) return null;
    const [owner, path, index] = ck.split('|');
    return { ...c, key: ck, owner, path: path as AnimPath, index: Number(index), flags: this.anim.flagsOf(ck) };
  }

  getKeyframe(id: string): KeyframeData | null {
    return this.anim.getKey(id);
  }

  /** Clé de courbe d'une image clé, ou null. */
  keyframeCurve(id: string): string | null {
    return this.anim.curveOf(id);
  }

  /** La propriété (ou une de ses composantes) a-t-elle des clés ? */
  isAnimated(owner: string, path?: AnimPath, index?: number): boolean {
    if (path === undefined) return this.anim.hasAnimation(owner);
    const idx = this.anim.animatedIndices(owner, path);
    return index === undefined ? idx.length > 0 : idx.includes(index);
  }

  /** Clé effective d'une composante à une image (par défaut l'image courante), ou null. */
  keyframeAt(owner: string, path: AnimPath, index: number, frame = this.anim.frame): KeyframeData | null {
    const c = this.anim.curve(curveKey(owner, path, index));
    return c ? keyAtFrame(c.keys, frame) : null;
  }

  /** Valeur d'une courbe à une image (null si vide). */
  evaluateCurve(ck: string, frame = this.anim.frame): number | null {
    const c = this.anim.curve(ck);
    return c ? evaluatePoints(c.points, frame) : null;
  }

  /** Images (triées, sans doublon) où les propriétaires donnés ont au moins une clé. */
  keyframeFrames(owners: Iterable<string>): number[] {
    const set = new Set<number>();
    for (const o of owners) for (const ck of this.anim.curveKeysOf(o)) for (const k of this.anim.curve(ck)?.keys ?? []) set.add(k.frame);
    return [...set].sort((a, b) => a - b);
  }

  /** La propriété a-t-elle une valeur temporaire (modifiée sans auto-key depuis le dernier changement d'image) ? */
  hasTempValue(owner: string, path: AnimPath): boolean {
    const def = animProp(path);
    return !!def && this.anim.hasTemp(owner, def.field);
  }

  // ------------------------------------------------------------------ animation : écriture

  /**
   * Pose une clé (ou met à jour la clé effective à cette image : même identifiant, poignées
   * décalées avec la valeur). Les clés masquées à cette image (doublons concurrents) sont
   * supprimées. Renvoie l'identifiant de la clé, ou null (courbe verrouillée, valeur invalide).
   */
  insertKeyframe(p: Pick<KeyframeData, 'owner' | 'path' | 'index' | 'frame' | 'value'> & Partial<Pick<KeyframeData, 'interp' | 'easing' | 'hlType' | 'hrType'>>): string | null {
    const def = animProp(p.path);
    if (!def || !Number.isFinite(p.frame) || !Number.isFinite(p.value) || p.index < 0 || p.index >= def.size) return null;
    const ck = curveKey(p.owner, p.path, p.index);
    if (this.anim.flagsOf(ck).lock) return null;
    const c = this.anim.curve(ck);
    const existing = c ? keyAtFrame(c.keys, p.frame) : null;
    const now = Date.now();
    return this.transact(() => {
      if (c) for (const s of c.shadowed) if (Math.abs(s.frame - p.frame) < ANIM_FRAME_EPS) this.yAnimKeys.delete(s.id);
      if (existing) {
        const dv = p.value - existing.value;
        const k: KeyframeData = {
          ...existing,
          value: p.value,
          hl: [existing.hl[0], existing.hl[1] + dv],
          hr: [existing.hr[0], existing.hr[1] + dv],
          interp: p.interp ?? existing.interp,
          easing: p.easing ?? existing.easing,
          hlType: p.hlType ?? existing.hlType,
          hrType: p.hrType ?? existing.hrType,
          t: Math.max(now, (existing.t ?? 0) + 1),
          by: this.animAuthor,
        };
        this.yAnimKeys.set(existing.id, cleanKey(k));
        return existing.id;
      }
      const id = newId();
      const k: KeyframeData = {
        id,
        owner: p.owner,
        path: p.path,
        index: p.index,
        frame: p.frame,
        value: p.value,
        interp: p.interp ?? (def.kind === 'bool' ? 'CONSTANT' : 'BEZIER'),
        easing: p.easing ?? 'AUTO',
        hl: [p.frame - 1, p.value],
        hr: [p.frame + 1, p.value],
        hlType: p.hlType ?? 'AUTO_CLAMPED',
        hrType: p.hrType ?? 'AUTO_CLAMPED',
        t: now,
        by: this.animAuthor,
      };
      this.yAnimKeys.set(id, cleanKey(k));
      return id;
    });
  }

  /**
   * Pose des clés sur une propriété avec sa valeur ACTUELLE (affichée) : toutes les composantes,
   * ou seulement `indices`. Renvoie les identifiants des clés écrites.
   */
  keyframeProperty(owner: string, path: AnimPath, opts: { frame?: number; indices?: number[] } = {}): string[] {
    const def = animProp(path);
    if (!def) return [];
    const target = this.animTarget(def.owner, owner);
    if (!target) return [];
    const comps = readProp(def, target, this.renderAspect());
    const frame = opts.frame ?? this.anim.frame;
    const out: string[] = [];
    this.transact(() => {
      for (let i = 0; i < def.size; i++) {
        if (opts.indices && !opts.indices.includes(i)) continue;
        const id = this.insertKeyframe({ owner, path, index: i, frame, value: comps[i] });
        if (id) out.push(id);
      }
    });
    return out;
  }

  /** Modifie des clés (image, valeur, interpolation, poignées…). Propriétaire et chemin sont immuables. */
  updateKeyframes(patches: (Partial<Omit<KeyframeData, 'owner' | 'path' | 'index'>> & { id: string })[]): void {
    const now = Date.now();
    this.transact(() => {
      for (const p of patches) {
        const cur = this.yAnimKeys.get(p.id);
        if (!cur || typeof cur !== 'object') continue;
        if (this.anim.flagsOf(curveKey(cur.owner, cur.path, cur.index)).lock) continue;
        const next: KeyframeData = { ...cur, id: p.id, t: Math.max(now, (cur.t ?? 0) + 1), by: this.animAuthor };
        for (const k of ['frame', 'value', 'interp', 'easing', 'hl', 'hr', 'hlType', 'hrType'] as const) {
          if (p[k] !== undefined) (next as any)[k] = clone(p[k]);
        }
        if (!Number.isFinite(next.frame) || !Number.isFinite(next.value)) continue;
        this.yAnimKeys.set(p.id, cleanKey(next));
      }
    });
  }

  /** Supprime des clés (celles des courbes verrouillées sont conservées). */
  removeKeyframes(ids: Iterable<string>): void {
    this.transact(() => {
      for (const id of ids) {
        const cur = this.yAnimKeys.get(id);
        if (!cur) continue;
        if (typeof cur === 'object' && this.anim.flagsOf(curveKey(cur.owner, cur.path, cur.index)).lock) continue;
        this.yAnimKeys.delete(id);
      }
    });
  }

  /** Supprime les clés d'un propriétaire à une image (toutes ses propriétés, ou `paths`). Renvoie le nombre supprimé. */
  removeKeyframesAt(owner: string, frame: number, paths?: AnimPath[]): number {
    const ids: string[] = [];
    for (const ck of this.anim.curveKeysOf(owner)) {
      if (paths && !paths.includes(ck.split('|')[1] as AnimPath)) continue;
      const c = this.anim.curve(ck);
      if (!c) continue;
      for (const k of [...c.keys, ...c.shadowed]) if (Math.abs(k.frame - frame) < ANIM_FRAME_EPS) ids.push(k.id);
    }
    const before = ids.filter((id) => this.yAnimKeys.has(id)).length;
    this.removeKeyframes(ids);
    return before - ids.filter((id) => this.yAnimKeys.has(id)).length;
  }

  /**
   * Efface l'animation d'un propriétaire (toutes ses propriétés, ou `paths`). Comme dans Blender,
   * la propriété garde la valeur qu'elle avait à l'image courante (écrite comme valeur de base).
   */
  clearAnimation(owner: string, paths?: AnimPath[]): void {
    const kind = this.ownerKind(owner);
    const target = kind ? this.animTarget(kind, owner) : null;
    this.transact(() => {
      for (const ck of this.anim.curveKeysOf(owner)) {
        const path = ck.split('|')[1] as AnimPath;
        if (paths && !paths.includes(path)) continue;
        if (this.anim.flagsOf(ck).lock) continue;
        const c = this.anim.curve(ck);
        for (const k of [...(c?.keys ?? []), ...(c?.shadowed ?? [])]) this.yAnimKeys.delete(k.id);
        if (this.yAnimCurves.has(ck)) this.yAnimCurves.delete(ck);
        const def = animProp(path);
        if (def && target && kind) this.writeBase(kind, owner, def.field, (target as unknown as Record<string, unknown>)[def.field]);
      }
    });
  }

  /** Verrou / muet / lissage d'une courbe (partagés). */
  setAnimCurveFlags(ck: string, patch: Partial<AnimCurveFlags>): void {
    const cur = { ...ANIM_CURVE_DEFAULTS, ...(this.yAnimCurves.get(ck) ?? {}) };
    this.transact(() => this.yAnimCurves.set(ck, { ...cur, ...patch }));
  }

  // ------------------------------------------------------------------ animation : interne

  private renderAspect(): number {
    const x = this.yScene.get('r:resX');
    const y = this.yScene.get('r:resY');
    const w = typeof x === 'number' && x > 0 ? x : SCENE_DEFAULTS.render.resX;
    const h = typeof y === 'number' && y > 0 ? y : SCENE_DEFAULTS.render.resY;
    return w / h;
  }

  private animTarget(kind: AnimOwnerKind, id: string): AnimTarget | null {
    switch (kind) {
      case 'object':
        return this.getObject(id);
      case 'light':
        return this.getLight(id);
      case 'camera':
        return this.getCamera(id);
      default:
        return this.getMaterial(id);
    }
  }

  /** Écrit une valeur de base sans passer par l'interception d'animation. */
  private writeBase(kind: AnimOwnerKind, id: string, field: string, value: unknown): void {
    if (value === undefined) return;
    const y = kind === 'object' ? this.yObjects.get(id) : this.yTables[kind === 'light' ? 'lights' : kind === 'camera' ? 'cameras' : 'materials'].get(id);
    y?.set(field, clone(value));
  }

  /** Écriture locale d'une propriété animable : auto-key, ou valeur temporaire si elle est animée. */
  private animIntercept(kind: AnimOwnerKind, owner: string, before: AnimTarget, patch: Record<string, any>): void {
    const aspect = this.renderAspect();
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      const def = animPropByField(kind, field);
      if (!def) continue;
      const animated = this.anim.animatedIndices(owner, def.path).length > 0;
      let keyed = false;
      if (this.autoKeyOn) {
        const comps = fieldComponents(def, value, before, aspect);
        for (let i = 0; i < def.size; i++) {
          if (Number.isFinite(comps[i]) && this.insertKeyframe({ owner, path: def.path, index: i, frame: this.anim.frame, value: comps[i] })) keyed = true;
        }
      }
      if (!keyed && animated) this.anim.setTemp(owner, field, clone(value));
    }
  }

  private afterAnimChange(owners: Set<string>, local: boolean): void {
    if (!owners.size) return;
    for (const o of owners) this.anim.clearTemp(o);
    this.emitAnimValues(owners, local, { force: owners });
    this.emit('anim', { owners: [...owners], local });
  }

  /**
   * Réévalue les propriétaires donnés à l'image courante et émet les événements de lecture
   * (objects / data) pour ceux dont la valeur affichée a changé (ou listés dans `force`).
   */
  private emitAnimValues(owners: Set<string>, local: boolean, opts: { force?: Set<string>; notify?: boolean } = {}): void {
    const objChanged: { id: string; keys: string[] }[] = [];
    const tables: Record<'lights' | 'cameras' | 'materials', string[]> = { lights: [], cameras: [], materials: [] };
    for (const o of owners) {
      const fields = this.anim.evaluateOwner(o);
      const forced = opts.force?.has(o) ?? false;
      if (!fields.length && !forced) continue;
      const kind = this.ownerKind(o);
      if (!kind) continue;
      if (kind === 'object') {
        this.objectCache.delete(o);
        const keys = forced ? animPropsOf('object').map((d) => d.field) : fields;
        objChanged.push({ id: o, keys });
      } else tables[kind === 'light' ? 'lights' : kind === 'camera' ? 'cameras' : 'materials'].push(o);
    }
    if (objChanged.length) this.emit('objects', { added: [], removed: [], changed: objChanged, local });
    for (const table of ['lights', 'cameras', 'materials'] as const) {
      if (tables[table].length) this.emit('data', { table, added: [], removed: [], changed: tables[table], local });
    }
    if (opts.notify && (objChanged.length || tables.lights.length || tables.cameras.length || tables.materials.length)) this.emit('change', { local: false, anim: true });
  }

  /** Supprime les clés et réglages de courbe d'un propriétaire (dans la transaction courante). */
  private dropAnimOf(owner: string): void {
    for (const ck of this.anim.curveKeysOf(owner)) {
      const c = this.anim.curve(ck);
      for (const k of [...(c?.keys ?? []), ...(c?.shadowed ?? [])]) this.yAnimKeys.delete(k.id);
    }
    this.yAnimCurves.forEach((_f, ck) => {
      if (ck.startsWith(`${owner}|`)) this.yAnimCurves.delete(ck);
    });
  }

  /** Copie l'animation (clés effectives) d'un propriétaire vers un autre (dans la transaction courante). */
  private copyAnimTo(from: string, to: string): void {
    const now = Date.now();
    for (const ck of this.anim.curveKeysOf(from)) {
      for (const k of this.anim.curve(ck)?.keys ?? []) {
        const id = newId();
        this.yAnimKeys.set(id, cleanKey({ ...k, id, owner: to, t: now, by: this.animAuthor }));
      }
      const f = this.yAnimCurves.get(ck);
      if (f) this.yAnimCurves.set(ck.replace(`${from}|`, `${to}|`), { ...f });
    }
  }

  // ------------------------------------------------------------------ discussion

  getChat(): ChatMessage[] {
    return this.yChat.toArray();
  }
  postChat(msg: Omit<ChatMessage, 'id' | 'time'>): void {
    // Hors pile d'annulation : origine différente de localOrigin.
    this.ydoc.transact(() => {
      this.yChat.push([{ ...msg, id: newId(8), time: Date.now() }]);
      if (this.yChat.length > 500) this.yChat.delete(0, this.yChat.length - 500);
    }, 'chat');
  }

  // ------------------------------------------------------------------ statistiques

  stats(): { objects: number; verts: number; faces: number } {
    let verts = 0;
    let faces = 0;
    for (const id of this.yMeshes.keys()) {
      const m = this.getMesh(id);
      if (m) {
        verts += m.verts.size;
        faces += m.faces.size;
      }
    }
    return { objects: this.yObjects.size, verts, faces };
  }
}

/** Tables dont les entrées peuvent porter de l'animation. */
const TABLE_ANIM_KIND: Partial<Record<DataTable, AnimOwnerKind>> = { lights: 'light', cameras: 'camera', materials: 'material' };

/** Clé prête à stocker : JSON pur, sans champ indéfini. */
function cleanKey(k: KeyframeData): KeyframeData {
  const out: Record<string, unknown> = {};
  for (const [f, v] of Object.entries(k)) if (v !== undefined) out[f] = Array.isArray(v) ? [Number(v[0]), Number(v[1])] : v;
  return out as unknown as KeyframeData;
}

function defaultObjectName(type: ObjectData['type']): string {
  switch (type) {
    case 'mesh':
      return 'Maillage';
    case 'light':
      return 'Lumière';
    case 'camera':
      return 'Caméra';
    default:
      return 'Vide';
  }
}

/** Cube de 2 m centré à l'origine (identifiants de sommets/faces neufs à chaque appel). */
function defaultCube(): MeshData {
  const ids = Array.from({ length: 8 }, () => newId(8));
  const coords: Vec3[] = [
    [-1, -1, -1],
    [1, -1, -1],
    [1, 1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
    [1, -1, 1],
    [1, 1, 1],
    [-1, 1, 1],
  ];
  const verts = new Map<string, Vec3>();
  ids.forEach((id, i) => verts.set(id, coords[i]));
  const quads = [
    [0, 3, 2, 1], // bas (-Z)
    [4, 5, 6, 7], // haut (+Z)
    [0, 1, 5, 4], // -Y
    [1, 2, 6, 5], // +X
    [2, 3, 7, 6], // +Y
    [3, 0, 4, 7], // -X
  ];
  const faces = new Map<string, string[]>();
  for (const q of quads) faces.set(newId(8), q.map((i) => ids[i]));
  return { verts, faces };
}
