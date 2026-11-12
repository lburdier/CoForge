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
} from './schema';

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
 *
 * Tolérance aux conflits : comme les éditions sont concurrentes, une référence
 * peut pointer vers un élément supprimé par quelqu'un d'autre. Les lecteurs
 * normalisent : parent/matériau/collection inexistants → valeur par défaut,
 * faces dont un sommet a disparu → ignorées.
 */

export type DataTable = 'lights' | 'cameras' | 'materials' | 'collections' | 'nodeTrees' | 'texts';

export interface DocEvents {
  /** Émis une fois après toute transaction ayant modifié le document. */
  change: { local: boolean };
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

    this.undoManager = new Y.UndoManager(
      [this.yObjects, this.yMeshes, this.yTables.lights, this.yTables.cameras, this.yTables.materials, this.yTables.collections, this.yTables.nodeTrees, this.yTables.texts, this.yScene],
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
  }

  endOp(): void {
    if (this.opDepth === 0) return;
    this.opDepth--;
    if (this.opDepth === 0) {
      this.undoManager.stopCapturing();
      this.lastLooseTransact = 0;
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
    this.transact(() => {
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'id' || v === undefined) continue;
        y.set(k, clone(v));
      }
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
      if (this.yScene.get('activeCamera') === id) this.yScene.set('activeCamera', null);
      if (obj.data) {
        const stillUsed = this.listObjects().some((o) => o.id !== id && o.data === obj.data && o.type === obj.type);
        if (!stillUsed) {
          if (obj.type === 'mesh') this.yMeshes.delete(obj.data);
          else if (obj.type === 'light') this.yTables.lights.delete(obj.data);
          else if (obj.type === 'camera') this.yTables.cameras.delete(obj.data);
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
      return this.addObject(copy);
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
    return { ...clone(defaults), ...(y.toJSON() as object), id } as T;
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
    this.transact(() => {
      for (const [k, v] of Object.entries(patch)) {
        if (k !== 'id' && v !== undefined) y.set(k, clone(v));
      }
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
