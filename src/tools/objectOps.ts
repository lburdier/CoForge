import { Matrix4, Vector3 } from 'three';
import type { AppContext } from '../app/context';
import { EMPTY_EDIT_SELECTION, setSelection, store, toast } from '../app/store';
import type { SceneDoc } from '../core/doc/SceneDoc';
import { decompose, localMatrix, setParent, setWorldMatrix, worldMatrix } from '../core/doc/transforms';
import {
  MODIFIER_DEFAULTS,
  MODIFIER_LABELS,
  ROOT_COLLECTION,
  type LightKind,
  type MeshData,
  type ModifierData,
  type ModifierType,
  type ObjectData,
  type Vec3,
} from '../core/doc/schema';
import { newId } from '../core/ids';
import { evaluateModifiers } from '../core/mesh';
import { PRIMITIVE_PARAMS, createPrimitive, resolvePrimitiveParams, type PrimitiveKind } from '../core/mesh/primitives';
import { transformMesh } from '../core/mesh/topology';
import type { ModifierContext } from '../core/mesh/types';
import type { OperatorDef, ParamDef } from './api';
import { MESH_PRIMITIVE_KINDS } from './menus';
import { startTranslateModal } from './transform';
import { activeObjectId, fail, selectedObjects, topLevel, v3, vec3 } from './util';

/**
 * Opérateurs du mode objet : ajout, suppression, duplication, jointure,
 * transformations (appliquer, effacer, origine), parentage, collections,
 * ombrage, visibilité, renommage, bascule de mode, caméra active, modificateurs.
 */

const OBJECT_MODE = { modes: ['object' as const] };

const PRIMITIVE_NAMES: Record<PrimitiveKind, string> = {
  plane: 'Plan',
  cube: 'Cube',
  circle: 'Cercle',
  uvsphere: 'Sphère',
  icosphere: 'Icosphère',
  cylinder: 'Cylindre',
  cone: 'Cône',
  torus: 'Tore',
};

const LIGHT_KINDS: Record<string, { kind: LightKind; name: string; power: number }> = {
  light_point: { kind: 'point', name: 'Ponctuelle', power: 1000 },
  light_sun: { kind: 'sun', name: 'Soleil', power: 3 },
  light_spot: { kind: 'spot', name: 'Projecteur', power: 1000 },
  light_area: { kind: 'area', name: 'Surfacique', power: 500 },
};

function isPrimitiveKind(k: string): k is PrimitiveKind {
  return (MESH_PRIMITIVE_KINDS as readonly string[]).includes(k);
}

function hasSelection(app: AppContext): boolean {
  return selectedObjects(app).length > 0;
}

function activeObject(app: AppContext): ObjectData | null {
  const id = activeObjectId(app);
  return id ? app.doc.getObject(id) : null;
}

function selectedMeshObjects(app: AppContext): ObjectData[] {
  const doc = app.doc;
  return selectedObjects(app)
    .map((id) => doc.getObject(id))
    .filter((o): o is ObjectData => !!o && o.type === 'mesh' && !!o.data && doc.getMesh(o.data) !== null);
}

/** Profondeur dans la hiérarchie (pour traiter les parents avant leurs enfants). */
function depthOf(doc: SceneDoc, id: string): number {
  let d = 0;
  let cur = doc.effectiveParent(id);
  while (cur && d < 256) {
    d++;
    cur = doc.effectiveParent(cur);
  }
  return d;
}

/**
 * Garantit que l'objet est le seul utilisateur de son maillage (copie sinon) et
 * renvoie l'identifiant du maillage, ou null.
 */
export function singleUserMesh(doc: SceneDoc, objectId: string): string | null {
  const obj = doc.getObject(objectId);
  if (!obj || obj.type !== 'mesh' || !obj.data) return null;
  const mesh = doc.getMesh(obj.data);
  if (!mesh) return null;
  const shared = doc.listObjects().some((o) => o.id !== objectId && o.type === 'mesh' && o.data === obj.data);
  if (!shared) return obj.data;
  const copy = doc.createMesh(mesh, doc.getMeshName(obj.data));
  doc.updateObject(objectId, { data: copy });
  return copy;
}

/** Maillage avec de nouveaux identifiants de sommets et de faces. */
function remapIds(mesh: MeshData): MeshData {
  const vmap = new Map<string, string>();
  const verts = new Map<string, Vec3>();
  for (const [id, p] of mesh.verts) {
    const nid = newId(8);
    vmap.set(id, nid);
    verts.set(nid, [p[0], p[1], p[2]]);
  }
  const faces = new Map<string, string[]>();
  for (const loop of mesh.faces.values()) faces.set(newId(8), loop.map((v) => vmap.get(v)!));
  return { verts, faces };
}

function uniqueModifierName(mods: ModifierData[], base: string): string {
  const names = new Set(mods.map((m) => m.name));
  if (!names.has(base)) return base;
  for (let i = 1; i < 1000; i++) {
    const n = `${base}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
  return `${base}.${newId(4)}`;
}

function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Objet portant le modificateur `modifierId` (objet indiqué, puis actif, puis recherche). */
function findModifierOwner(app: AppContext, modifierId: string, objectId?: unknown): { obj: ObjectData; index: number } | null {
  const doc = app.doc;
  const candidates: string[] = [];
  if (typeof objectId === 'string') candidates.push(objectId);
  const active = activeObjectId(app);
  if (active) candidates.push(active);
  for (const id of candidates) {
    const o = doc.getObject(id);
    const i = o ? o.modifiers.findIndex((m) => m.id === modifierId) : -1;
    if (o && i >= 0) return { obj: o, index: i };
  }
  for (const o of doc.listObjects()) {
    const i = o.modifiers.findIndex((m) => m.id === modifierId);
    if (i >= 0) return { obj: o, index: i };
  }
  return null;
}

/** Contexte d'évaluation des modificateurs (opérande booléen ramené dans le repère local de l'objet). */
function modifierContext(app: AppContext, selfId: string): ModifierContext {
  return {
    getOperand(objectId: string) {
      const doc = app.doc;
      const other = doc.getObject(objectId);
      if (!other || other.type !== 'mesh' || !other.data || objectId === selfId) return null;
      const mesh = app.viewport.getEvaluatedMesh(objectId) ?? doc.getMesh(other.data);
      if (!mesh) return null;
      const toLocal = worldMatrix(doc, selfId).invert().multiply(worldMatrix(doc, objectId));
      return { mesh, toLocal };
    },
  };
}

// ------------------------------------------------------------------ opérateurs

export function objectOperators(): OperatorDef[] {
  const ops: OperatorDef[] = [];

  // ---------------------------------------------------------------- ajouter
  ops.push({
    id: 'object.add',
    label: 'Ajouter un objet',
    description: 'Ajoute une primitive, une lumière, une caméra ou un vide au curseur 3D — args { kind, …paramètres }',
    ...OBJECT_MODE,
    defaults: { kind: 'cube' },
    // Les paramètres ajustables dépendent du type de primitive de la dernière exécution.
    get params(): ParamDef[] {
      const last = store.getState().lastOp;
      const kind = last?.opId === 'object.add' ? String(last.args.kind) : 'cube';
      if (!isPrimitiveKind(kind)) return [];
      return PRIMITIVE_PARAMS[kind].map((d) => ({ key: d.key, label: d.label, type: d.type, min: d.min, max: d.max, step: d.step }));
    },
    exec(app, inv) {
      const doc = app.doc;
      const kind = String(inv.args.kind ?? 'cube');
      const cursor = store.getState().cursor3d;
      const pos: Vec3 = Array.isArray(inv.args.location) && inv.args.location.length === 3 ? (inv.args.location.map(Number) as Vec3) : [cursor[0], cursor[1], cursor[2]];
      const rot: Vec3 = Array.isArray(inv.args.rotation) && inv.args.rotation.length === 3 ? (inv.args.rotation.map(Number) as Vec3) : [0, 0, 0];
      let id: string;
      if (isPrimitiveKind(kind)) {
        const raw: Record<string, number> = {};
        for (const d of PRIMITIVE_PARAMS[kind]) if (typeof inv.args[d.key] === 'number') raw[d.key] = inv.args[d.key];
        const params = resolvePrimitiveParams(kind, raw);
        // valeurs effectives recopiées dans les arguments (panneau « Ajuster la dernière opération »)
        Object.assign(inv.args, params);
        const name = PRIMITIVE_NAMES[kind];
        const mesh = doc.createMesh(createPrimitive(kind, params), name);
        id = doc.addObject({ type: 'mesh', name, data: mesh, pos, rot });
      } else if (LIGHT_KINDS[kind]) {
        const l = LIGHT_KINDS[kind];
        const light = doc.addLight({ kind: l.kind, power: l.power });
        id = doc.addObject({ type: 'light', name: l.name, data: light, pos, rot });
      } else if (kind === 'camera') {
        const cam = doc.addCamera({});
        id = doc.addObject({ type: 'camera', name: 'Caméra', data: cam, pos, rot });
        if (!doc.getScene().activeCamera) doc.setActiveCamera(id);
      } else if (kind === 'empty') {
        id = doc.addObject({ type: 'empty', name: 'Vide', pos, rot });
      } else {
        return fail(`Type d'objet inconnu : ${kind}`);
      }
      setSelection([id], id);
    },
  });

  // ---------------------------------------------------------------- supprimer
  ops.push({
    id: 'object.delete',
    label: 'Supprimer',
    description: 'Supprime les objets sélectionnés (leurs enfants conservent leur position)',
    ...OBJECT_MODE,
    poll: hasSelection,
    exec(app) {
      const doc = app.doc;
      const ids = selectedObjects(app);
      if (!ids.length) return false;
      const set = new Set(ids);
      // enfants survivants : on mémorise leur matrice monde
      const keep = new Map<string, Matrix4>();
      for (const id of ids) for (const c of doc.childrenOf(id)) if (!set.has(c)) keep.set(c, worldMatrix(doc, c));
      // Pas de transaction englobante : SceneDoc ne rafraîchit ses instantanés qu'en fin de
      // transaction, or on relit la hiérarchie après chaque suppression (une seule étape
      // d'annulation quand même : le registre encadre l'opérateur par beginOp/endOp).
      for (const id of ids) doc.removeObject(id);
      for (const [c, w] of keep) if (doc.hasObject(c)) setWorldMatrix(doc, c, w);
      setSelection([], null);
    },
  });

  // ---------------------------------------------------------------- dupliquer
  ops.push({
    id: 'object.duplicate',
    label: 'Dupliquer',
    description: 'Duplique les objets sélectionnés puis les déplace — args { linked: partage les données, move: false pour ne pas déplacer }',
    ...OBJECT_MODE,
    poll: hasSelection,
    defaults: { linked: false },
    exec(app, inv) {
      const doc = app.doc;
      const ids = selectedObjects(app);
      if (!ids.length) return false;
      const map = new Map<string, string>();
      doc.transact(() => {
        for (const id of ids) {
          const copy = doc.duplicateObject(id, { linked: !!inv.args.linked });
          if (copy) map.set(id, copy);
        }
        // une copie d'enfant suit la copie de son parent
        for (const [orig, copy] of map) {
          const parent = doc.getObject(orig)?.parent;
          if (parent && map.has(parent)) doc.updateObject(copy, { parent: map.get(parent)! });
        }
      });
      if (!map.size) return false;
      const before = store.getState();
      const prevSelection = [...before.selection];
      const prevActive = before.activeId;
      setSelection(map.values(), prevActive && map.has(prevActive) ? map.get(prevActive)! : undefined);
      if (inv.args.move !== false && !inv.redo) {
        const handler = startTranslateModal(app, { constraint: null, status: 'Dupliquer : déplacez la copie | X/Y/Z : axe | Entrée/clic : valider | Échap : annuler la duplication' });
        // La sélection locale ne suit pas doc.cancelOp() : on la restaure nous-mêmes à l'annulation.
        const end = handler.onEnd;
        handler.onEnd = (committed) => {
          try {
            end?.call(handler, committed);
          } finally {
            if (!committed) setSelection(prevSelection.filter((id) => app.doc.hasObject(id)), prevActive);
          }
        };
        return handler;
      }
    },
  });

  // ---------------------------------------------------------------- joindre
  ops.push({
    id: 'object.join',
    label: 'Joindre',
    description: "Fusionne les maillages sélectionnés dans l'objet actif",
    ...OBJECT_MODE,
    poll: (app) => {
      const a = activeObject(app);
      return !!a && a.type === 'mesh' && selectedMeshObjects(app).some((o) => o.id !== a.id);
    },
    exec(app) {
      const doc = app.doc;
      const active = activeObject(app);
      if (!active || active.type !== 'mesh' || !active.data || !doc.getMesh(active.data)) return fail("L'objet actif doit être un maillage");
      const others = selectedMeshObjects(app).filter((o) => o.id !== active.id);
      if (!others.length) return fail('Sélectionnez au moins deux maillages');
      const othersSet = new Set(others.map((o) => o.id));
      const invActive = worldMatrix(doc, active.id).invert();
      const setVerts: Record<string, Vec3> = {};
      const setFaces: Record<string, string[]> = {};
      for (const o of others) {
        const mesh = doc.getMesh(o.data!);
        if (!mesh) continue;
        const m = invActive.clone().multiply(worldMatrix(doc, o.id));
        const part = remapIds(transformMesh(mesh, m));
        for (const [id, p] of part.verts) setVerts[id] = p;
        for (const [id, loop] of part.faces) setFaces[id] = loop;
      }
      doc.applyMeshDelta(active.data!, { setVerts, setFaces });
      for (const o of others) {
        for (const c of doc.childrenOf(o.id)) if (!othersSet.has(c)) setParent(doc, c, active.id, true);
        doc.removeObject(o.id);
      }
      setSelection([active.id], active.id);
    },
  });

  // ---------------------------------------------------------------- appliquer les transformations
  ops.push({
    id: 'object.apply_transform',
    label: 'Appliquer les transformations',
    description: 'Intègre position / rotation / échelle au maillage — args { location, rotation, scale }',
    ...OBJECT_MODE,
    poll: (app) => selectedMeshObjects(app).length > 0,
    defaults: { location: true, rotation: true, scale: true },
    params: [
      { key: 'location', label: 'Position', type: 'bool' },
      { key: 'rotation', label: 'Rotation', type: 'bool' },
      { key: 'scale', label: 'Échelle', type: 'bool' },
    ],
    exec(app, inv) {
      const doc = app.doc;
      const { location, rotation, scale } = inv.args;
      if (!location && !rotation && !scale) return false;
      const objs = selectedMeshObjects(app).sort((a, b) => depthOf(doc, a.id) - depthOf(doc, b.id));
      if (!objs.length) return fail('Aucun maillage sélectionné');
      let changed = 0;
      for (const o0 of objs) {
        const o = doc.getObject(o0.id);
        if (!o) continue;
        const L = localMatrix(o);
        const next = { pos: location ? ([0, 0, 0] as Vec3) : o.pos, rot: rotation ? ([0, 0, 0] as Vec3) : o.rot, scl: scale ? ([1, 1, 1] as Vec3) : o.scl };
        const X = localMatrix(next).invert().multiply(L);
        const meshId = singleUserMesh(doc, o.id);
        const mesh = meshId ? doc.getMesh(meshId) : null;
        if (!meshId || !mesh) continue;
        doc.replaceMesh(meshId, transformMesh(mesh, X));
        doc.updateObject(o.id, next);
        for (const c of doc.childrenOf(o.id)) {
          const child = doc.getObject(c);
          if (!child) continue;
          const d = decompose(X.clone().multiply(localMatrix(child)));
          doc.updateObject(c, d);
        }
        changed++;
      }
      if (!changed) return false;
    },
  });

  // ---------------------------------------------------------------- effacer les transformations
  ops.push({
    id: 'object.clear_transform',
    label: 'Effacer les transformations',
    description: "Remet à zéro la position, la rotation ou l'échelle — args { what: 'location' | 'rotation' | 'scale' | 'all' }",
    ...OBJECT_MODE,
    poll: hasSelection,
    defaults: { what: 'location' },
    exec(app, inv) {
      const doc = app.doc;
      const what = String(inv.args.what);
      const patch: Partial<ObjectData> = {};
      if (what === 'location' || what === 'all') patch.pos = [0, 0, 0];
      if (what === 'rotation' || what === 'all') patch.rot = [0, 0, 0];
      if (what === 'scale' || what === 'all') patch.scl = [1, 1, 1];
      if (!Object.keys(patch).length) return false;
      doc.transact(() => {
        for (const id of selectedObjects(app)) doc.updateObject(id, patch);
      });
    },
  });

  // ---------------------------------------------------------------- origine
  ops.push({
    id: 'object.origin_set',
    label: "Définir l'origine",
    description: "Déplace l'origine des maillages sélectionnés sans bouger la géométrie — args { type: 'geometry' | 'cursor' }",
    ...OBJECT_MODE,
    poll: (app) => selectedMeshObjects(app).length > 0,
    defaults: { type: 'geometry' },
    exec(app, inv) {
      const doc = app.doc;
      const type = String(inv.args.type);
      if (type !== 'geometry' && type !== 'cursor') return false;
      const cursor = v3(store.getState().cursor3d);
      let changed = 0;
      for (const o0 of selectedMeshObjects(app)) {
        const o = doc.getObject(o0.id);
        if (!o) continue;
        const meshId = singleUserMesh(doc, o.id);
        const mesh = meshId ? doc.getMesh(meshId) : null;
        if (!meshId || !mesh || mesh.verts.size === 0) continue;
        let origin: Vector3;
        if (type === 'cursor') origin = cursor.clone().applyMatrix4(worldMatrix(doc, o.id).invert());
        else {
          origin = new Vector3();
          for (const p of mesh.verts.values()) origin.add(v3(p));
          origin.multiplyScalar(1 / mesh.verts.size);
        }
        if (origin.lengthSq() < 1e-24) continue;
        doc.replaceMesh(meshId, transformMesh(mesh, new Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z)));
        const newPos = origin.clone().applyMatrix4(localMatrix(o));
        doc.updateObject(o.id, { pos: vec3(newPos) });
        for (const c of doc.childrenOf(o.id)) {
          const child = doc.getObject(c);
          if (!child) continue;
          const d = decompose(new Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z).multiply(localMatrix(child)));
          doc.updateObject(c, d);
        }
        changed++;
      }
      if (!changed) return false;
    },
  });

  // ---------------------------------------------------------------- sélection → curseur
  ops.push({
    id: 'object.snap_to_cursor',
    label: 'Sélection → curseur',
    description: 'Place les objets sélectionnés sur le curseur 3D',
    ...OBJECT_MODE,
    poll: hasSelection,
    exec(app) {
      const doc = app.doc;
      const cursor = v3(store.getState().cursor3d);
      doc.transact(() => {
        for (const id of topLevel(doc, selectedObjects(app))) {
          const parent = doc.effectiveParent(id);
          const p = parent ? cursor.clone().applyMatrix4(worldMatrix(doc, parent).invert()) : cursor;
          doc.updateObject(id, { pos: vec3(p) });
        }
      });
    },
  });

  // ---------------------------------------------------------------- parentage
  ops.push({
    id: 'object.parent_set',
    label: "Parenter à l'objet actif",
    description: "Rattache les objets sélectionnés à l'objet actif en conservant leur transformation monde",
    ...OBJECT_MODE,
    poll: (app) => {
      const a = activeObjectId(app);
      return !!a && selectedObjects(app).some((id) => id !== a);
    },
    defaults: { keep_transform: true },
    exec(app, inv) {
      const doc = app.doc;
      const active = activeObjectId(app);
      if (!active) return false;
      let done = 0;
      let refused = 0;
      for (const id of selectedObjects(app)) {
        if (id === active) continue;
        if (setParent(doc, id, active, inv.args.keep_transform !== false)) done++;
        else refused++;
      }
      if (refused) toast(`${refused} objet(s) non parenté(s) : cela créerait une boucle de parenté`, 'error');
      if (!done) return false;
    },
  });

  ops.push({
    id: 'object.parent_clear',
    label: 'Libérer le parent',
    description: 'Détache les objets sélectionnés de leur parent en conservant leur transformation monde',
    ...OBJECT_MODE,
    poll: (app) => selectedObjects(app).some((id) => app.doc.effectiveParent(id) !== null),
    defaults: { keep_transform: true },
    exec(app, inv) {
      const doc = app.doc;
      let done = 0;
      for (const id of selectedObjects(app)) {
        if (doc.getObject(id)?.parent == null) continue;
        if (setParent(doc, id, null, inv.args.keep_transform !== false)) done++;
      }
      if (!done) return false;
    },
  });

  // ---------------------------------------------------------------- collections
  ops.push({
    id: 'object.move_to_collection',
    label: 'Déplacer vers une collection',
    description: 'Déplace les objets sélectionnés dans une collection (nouvelle par défaut) — args { collection?, name? }',
    ...OBJECT_MODE,
    poll: hasSelection,
    exec(app, inv) {
      const doc = app.doc;
      const ids = selectedObjects(app);
      if (!ids.length) return false;
      let target = typeof inv.args.collection === 'string' ? inv.args.collection : null;
      if (target && target !== ROOT_COLLECTION && !doc.getCollection(target)) return fail('Cette collection n’existe plus');
      doc.transact(() => {
        if (!target) target = doc.addCollection({ name: typeof inv.args.name === 'string' && inv.args.name.trim() ? inv.args.name.trim() : 'Collection' });
        for (const id of ids) doc.updateObject(id, { collection: target! });
      });
    },
  });

  // ---------------------------------------------------------------- ombrage
  ops.push({
    id: 'object.shade',
    label: 'Ombrage',
    description: 'Ombrage lisse ou plat des maillages sélectionnés — args { smooth, angle? (degrés) }',
    ...OBJECT_MODE,
    poll: (app) => selectedMeshObjects(app).length > 0,
    defaults: { smooth: true },
    exec(app, inv) {
      const doc = app.doc;
      const patch: Partial<ObjectData> = { shadeSmooth: !!inv.args.smooth };
      if (typeof inv.args.angle === 'number' && Number.isFinite(inv.args.angle)) patch.autoSmoothAngle = Math.max(0, Math.min(180, inv.args.angle));
      doc.transact(() => {
        for (const o of selectedMeshObjects(app)) doc.updateObject(o.id, patch);
      });
    },
  });

  // ---------------------------------------------------------------- visibilité
  ops.push({
    id: 'object.hide',
    label: 'Masquer la sélection',
    description: 'Masque les objets sélectionnés (args { unselected: true } : masque les autres)',
    ...OBJECT_MODE,
    poll: hasSelection,
    exec(app, inv) {
      const doc = app.doc;
      const sel = new Set(selectedObjects(app));
      const targets = inv.args.unselected ? doc.objectIds().filter((id) => !sel.has(id) && doc.getObject(id)?.visible) : [...sel];
      if (!targets.length) return false;
      doc.transact(() => {
        for (const id of targets) doc.updateObject(id, { visible: false });
      });
      if (!inv.args.unselected) setSelection([], null);
    },
  });

  ops.push({
    id: 'object.reveal',
    label: 'Tout réafficher',
    description: 'Réaffiche les objets masqués et les sélectionne',
    ...OBJECT_MODE,
    poll: (app) => app.doc.listObjects().some((o) => !o.visible),
    exec(app) {
      const doc = app.doc;
      const hidden = doc.listObjects().filter((o) => !o.visible).map((o) => o.id);
      if (!hidden.length) return false;
      doc.transact(() => {
        for (const id of hidden) doc.updateObject(id, { visible: true });
      });
      const s = store.getState();
      setSelection([...s.selection, ...hidden].filter((id) => doc.hasObject(id)), s.activeId && doc.hasObject(s.activeId) ? s.activeId : undefined);
    },
  });

  // ---------------------------------------------------------------- renommer
  ops.push({
    id: 'object.rename',
    label: 'Renommer',
    description: "Renomme l'objet actif — args { name? } ; sans nom, ouvre la boîte de dialogue",
    poll: (app) => activeObjectId(app) !== null,
    exec(app, inv) {
      const doc = app.doc;
      const id = activeObjectId(app);
      if (!id) return false;
      if (typeof inv.args.name !== 'string') {
        store.setState({ dialog: 'rename', popup: null });
        return;
      }
      const name = inv.args.name.trim();
      if (!name) return fail('Le nom ne peut pas être vide');
      const obj = doc.getObject(id);
      if (!obj || obj.name === name) return false;
      const taken = doc.listObjects().some((o) => o.id !== id && o.name === name);
      doc.updateObject(id, { name: taken ? doc.uniqueName(name) : name });
    },
  });

  // ---------------------------------------------------------------- mode
  ops.push({
    id: 'object.mode_toggle',
    label: 'Mode édition',
    description: "Bascule entre mode objet et mode édition de l'objet actif — args { mode?: 'object' | 'edit' }",
    undoable: false,
    poll: (app) => {
      if (store.getState().mode === 'edit') return true;
      const a = activeObject(app);
      return !!a && a.type === 'mesh' && !!a.data && app.doc.getMesh(a.data) !== null;
    },
    exec(app, inv) {
      const s = store.getState();
      const wanted = inv.args.mode === 'object' || inv.args.mode === 'edit' ? inv.args.mode : s.mode === 'edit' ? 'object' : 'edit';
      if (wanted === s.mode) return false;
      if (wanted === 'object') {
        store.setState({ mode: 'object', editSelection: EMPTY_EDIT_SELECTION });
        return;
      }
      const a = activeObject(app);
      if (!a || a.type !== 'mesh' || !a.data || !app.doc.getMesh(a.data)) return fail('Le mode édition nécessite un objet maillage actif');
      if (!s.selection.has(a.id)) setSelection([...s.selection, a.id], a.id);
      store.setState({ mode: 'edit', editSelection: EMPTY_EDIT_SELECTION });
    },
  });

  // ---------------------------------------------------------------- caméra active
  ops.push({
    id: 'object.set_active_camera',
    label: "Définir l'objet actif comme caméra",
    description: "La caméra active sert au rendu et à la vue caméra",
    poll: (app) => activeObject(app)?.type === 'camera',
    exec(app) {
      const a = activeObject(app);
      if (!a || a.type !== 'camera') return fail("L'objet actif n'est pas une caméra");
      app.doc.setActiveCamera(a.id);
      store.setState({ cameraView: true });
    },
  });

  // ---------------------------------------------------------------- modificateurs
  ops.push({
    id: 'object.modifier_add',
    label: 'Ajouter un modificateur',
    description: "Ajoute un modificateur à l'objet actif — args { type, objectId? }",
    poll: (app) => activeObject(app)?.type === 'mesh',
    defaults: { type: 'subsurf' },
    exec(app, inv) {
      const doc = app.doc;
      const type = inv.args.type as ModifierType;
      if (!(type in MODIFIER_DEFAULTS)) return fail(`Modificateur inconnu : ${String(type)}`);
      const id = typeof inv.args.objectId === 'string' ? inv.args.objectId : activeObjectId(app);
      const obj = id ? doc.getObject(id) : null;
      if (!obj || obj.type !== 'mesh') return fail('Les modificateurs ne s’appliquent qu’aux maillages');
      const mod = {
        id: newId(8),
        type,
        name: uniqueModifierName(obj.modifiers, MODIFIER_LABELS[type]),
        enabled: true,
        params: cloneJson(MODIFIER_DEFAULTS[type]),
      } as ModifierData;
      doc.updateObject(obj.id, { modifiers: [...obj.modifiers.map(cloneJson), mod] });
      store.setState({ propertiesTab: 'modifiers' });
    },
  });

  ops.push({
    id: 'object.modifier_remove',
    label: 'Supprimer le modificateur',
    description: 'args { modifierId, objectId? }',
    exec(app, inv) {
      const found = findModifierOwner(app, String(inv.args.modifierId), inv.args.objectId);
      if (!found) return fail('Ce modificateur n’existe plus');
      app.doc.updateObject(found.obj.id, { modifiers: found.obj.modifiers.filter((_m, i) => i !== found.index).map(cloneJson) });
    },
  });

  ops.push({
    id: 'object.modifier_move',
    label: 'Déplacer le modificateur',
    description: 'Monte (-1) ou descend (1) un modificateur dans la pile — args { modifierId, direction, objectId? }',
    defaults: { direction: -1 },
    exec(app, inv) {
      const found = findModifierOwner(app, String(inv.args.modifierId), inv.args.objectId);
      if (!found) return fail('Ce modificateur n’existe plus');
      const dir = Number(inv.args.direction) < 0 ? -1 : 1;
      const mods = found.obj.modifiers.map(cloneJson);
      const j = found.index + dir;
      if (j < 0 || j >= mods.length) return false;
      [mods[found.index], mods[j]] = [mods[j], mods[found.index]];
      app.doc.updateObject(found.obj.id, { modifiers: mods });
    },
  });

  ops.push({
    id: 'object.modifier_apply',
    label: 'Appliquer le modificateur',
    description: 'Intègre le modificateur (et ceux au-dessus de lui) au maillage — args { modifierId, objectId? }',
    exec(app, inv) {
      const doc = app.doc;
      const found = findModifierOwner(app, String(inv.args.modifierId), inv.args.objectId);
      if (!found) return fail('Ce modificateur n’existe plus');
      const { obj, index } = found;
      const mod = obj.modifiers[index];
      if (!mod.enabled) return fail('Le modificateur est désactivé : activez-le avant de l’appliquer');
      if (obj.type !== 'mesh' || !obj.data) return fail('Les modificateurs ne s’appliquent qu’aux maillages');
      const mesh = doc.getMesh(obj.data);
      if (!mesh) return fail('Le maillage de cet objet n’existe plus');
      const stack = obj.modifiers.slice(0, index + 1).filter((m) => m.enabled);
      const result = evaluateModifiers(mesh, stack, modifierContext(app, obj.id));
      const remaining = obj.modifiers.filter((m, i) => i > index || !m.enabled).map(cloneJson);
      const meshId = singleUserMesh(doc, obj.id);
      if (!meshId) return false;
      doc.replaceMesh(meshId, result);
      doc.updateObject(obj.id, { modifiers: remaining });
      if (stack.length > 1) toast(`${stack.length} modificateurs appliqués (ceux situés au-dessus d'abord)`);
    },
  });

  return ops;
}
