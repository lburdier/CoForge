import { Matrix4 } from 'three';
import type { AppContext } from '../../app/context';
import { EMPTY_EDIT_SELECTION, setEditSelection, setSelection, store, toast } from '../../app/store';
import { newId } from '../../core/ids';
import type { MeshData, Vec3 } from '../../core/doc/schema';
import {
  appendMesh,
  bridgeEdgeLoops,
  deleteElements,
  dissolveElements,
  duplicateFaces,
  extractFaces,
  fillFromVerts,
  flipFaces,
  mergeByDistance,
  mergeVerts,
  recalcNormalsOutside,
  subdivideFaces,
  triangulateFaces,
} from '../../core/mesh/ops';
import { PRIMITIVE_PARAMS, createPrimitive, resolvePrimitiveParams, type PrimitiveKind } from '../../core/mesh/primitives';
import { isEmptyDelta, selectionCenter, selectionOfFaces, transformMesh } from '../../core/mesh/topology';
import type { OperatorDef, ParamDef } from '../api';
import { MESH_PRIMITIVE_KINDS } from '../menus';
import { startTranslateModal } from '../transform';
import { applyMeshResult, fail, getMeshEditContext, pollMeshEdit, prepareSelectionForRun, storeSelection, worldToLocal, type MeshEditContext } from './context';
import { restoreSelectionOnCancel } from './modal';

/**
 * Opérateurs d'édition non modaux du mode édition. Ceux qui ont des paramètres les déclarent
 * (`params` + `defaults`) pour le panneau « Ajuster la dernière opération ».
 */

const EDIT: Pick<OperatorDef, 'modes' | 'poll'> = { modes: ['edit'], poll: pollMeshEdit };

function ctxOrFail(app: AppContext): MeshEditContext | false {
  const ctx = getMeshEditContext(app);
  if (!ctx) return fail('Aucun maillage en cours d’édition');
  return ctx;
}

function needFaces(ctx: MeshEditContext): string[] | false {
  const faces = [...ctx.selection.faces];
  if (faces.length === 0) return fail('Sélectionnez au moins une face');
  return faces;
}

function num(v: unknown, def: number): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : def;
}

function int(v: unknown, def: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(num(v, def))));
}

export function editOperators(): OperatorDef[] {
  const ops: OperatorDef[] = [];

  // ---------------------------------------------------------------- subdiviser
  ops.push({
    id: 'mesh.subdivide',
    label: 'Subdiviser',
    description: 'Découpe les faces sélectionnées en faces plus petites',
    ...EDIT,
    defaults: { cuts: 1 },
    params: [{ key: 'cuts', label: 'Nombre de coupes', type: 'int', min: 1, max: 32, step: 1 }],
    exec(app, inv) {
      const ctx = ctxOrFail(app);
      if (!ctx) return false;
      const faces = needFaces(ctx);
      if (!faces) return false;
      const cuts = int(inv.args.cuts, 1, 1, 32);
      inv.args.cuts = cuts;
      if (!applyMeshResult(app, ctx, subdivideFaces(ctx.mesh, faces, cuts))) return fail('Subdivision impossible sur cette sélection');
    },
  });

  // ---------------------------------------------------------------- créer arête / face
  ops.push({
    id: 'mesh.fill',
    label: 'Créer arête / face',
    description: 'Crée une face à partir des sommets ou de la boucle d’arêtes sélectionnés',
    ...EDIT,
    exec(app) {
      const ctx = ctxOrFail(app);
      if (!ctx) return false;
      const verts = [...ctx.selection.verts];
      if (verts.length < 3) return fail('Sélectionnez au moins 3 sommets');
      if (!applyMeshResult(app, ctx, fillFromVerts(ctx.mesh, verts))) return fail('Impossible de créer une face avec cette sélection');
    },
  });

  // ---------------------------------------------------------------- pont
  ops.push({
    id: 'mesh.bridge',
    label: 'Relier deux boucles (pont)',
    description: 'Relie deux boucles d’arêtes sélectionnées par une bande de faces',
    ...EDIT,
    exec(app) {
      const ctx = ctxOrFail(app);
      if (!ctx) return false;
      const edges = [...ctx.selection.edges];
      if (edges.length < 2) return fail('Sélectionnez deux boucles d’arêtes');
      if (!applyMeshResult(app, ctx, bridgeEdgeLoops(ctx.mesh, edges))) return fail('Impossible de relier : sélectionnez deux boucles d’arêtes de bord');
    },
  });

  // ---------------------------------------------------------------- trianguler
  ops.push({
    id: 'mesh.triangulate',
    label: 'Trianguler',
    description: 'Découpe les faces sélectionnées en triangles',
    ...EDIT,
    exec(app) {
      const ctx = ctxOrFail(app);
      if (!ctx) return false;
      const faces = needFaces(ctx);
      if (!faces) return false;
      if (!applyMeshResult(app, ctx, triangulateFaces(ctx.mesh, faces))) return fail('Les faces sélectionnées sont déjà des triangles');
    },
  });

  // ---------------------------------------------------------------- dupliquer
  ops.push({
    id: 'mesh.duplicate',
    label: 'Dupliquer',
    description: 'Duplique les faces sélectionnées puis les déplace',
    ...EDIT,
    defaults: { move: true },
    exec(app, inv) {
      const ctx = ctxOrFail(app);
      if (!ctx) return false;
      const faces = needFaces(ctx);
      if (!faces) return false;
      if (!applyMeshResult(app, ctx, duplicateFaces(ctx.mesh, faces))) return fail('Duplication impossible');
      if (inv.args.move !== false && !inv.redo) {
        const translate = startTranslateModal(app, { constraint: null, status: 'Dupliquer : déplacez la copie | X/Y/Z : axe | Entrée : valider | Échap : annuler' });
        return restoreSelectionOnCancel(translate, ctx.rawSelection);
      }
    },
  });

  // ---------------------------------------------------------------- séparer
  ops.push({
    id: 'mesh.separate',
    label: 'Séparer la sélection',
    description: 'Déplace les faces sélectionnées dans un nouvel objet',
    ...EDIT,
    exec(app) {
      const ctx = ctxOrFail(app);
      if (!ctx) return false;
      const faces = needFaces(ctx);
      if (!faces) return false;
      if (faces.length === ctx.mesh.faces.size) return fail('Toutes les faces sont sélectionnées : rien à séparer');
      const { delta, extracted } = extractFaces(ctx.mesh, faces);
      if (isEmptyDelta(delta) || extracted.faces.size === 0) return fail('Séparation impossible');
      const doc = ctx.doc;
      const obj = ctx.object;
      doc.applyMeshDelta(ctx.meshId, delta);
      const meshId = doc.createMesh(extracted, doc.getMeshName(ctx.meshId));
      const newObj = doc.addObject({
        type: 'mesh',
        name: obj.name,
        data: meshId,
        parent: obj.parent,
        collection: obj.collection,
        pos: [...obj.pos] as Vec3,
        rot: [...obj.rot] as Vec3,
        scl: [...obj.scl] as Vec3,
        material: obj.material,
        modifiers: obj.modifiers.map((m) => ({ ...JSON.parse(JSON.stringify(m)), id: newId(8) })),
        shadeSmooth: obj.shadeSmooth,
        autoSmoothAngle: obj.autoSmoothAngle,
        displayAs: obj.displayAs,
        visible: obj.visible,
        renderable: obj.renderable,
      });
      setEditSelection(EMPTY_EDIT_SELECTION);
      const st = app.store.getState();
      setSelection([...st.selection, newObj], ctx.objectId);
      toast(`Faces séparées dans « ${doc.getObject(newObj)?.name ?? obj.name} »`);
    },
  });

  // ---------------------------------------------------------------- fusionner
  ops.push({
    id: 'mesh.merge',
    label: 'Fusionner',
    description: 'Fusionne les sommets sélectionnés (au centre, au curseur 3D ou par distance)',
    ...EDIT,
    defaults: { at: 'center', distance: 0.0001 },
    params: [
      {
        key: 'at',
        label: 'Position',
        type: 'enum',
        options: [
          { value: 'center', label: 'Au centre' },
          { value: 'cursor', label: 'Au curseur 3D' },
          { value: 'distance', label: 'Par distance' },
        ],
      },
      { key: 'distance', label: 'Distance de fusion', type: 'float', min: 0, max: 10, step: 0.0001 },
    ],
    exec(app, inv) {
      const ctx = ctxOrFail(app);
      if (!ctx) return false;
      const verts = [...ctx.selection.verts];
      const at = String(inv.args.at ?? 'center');
      if (at === 'distance') {
        if (verts.length < 2) return fail('Sélectionnez au moins 2 sommets');
        const distance = Math.max(0, num(inv.args.distance, 0.0001));
        inv.args.distance = distance;
        const res = mergeByDistance(ctx.mesh, verts, distance);
        const merged = res.merged ?? 0;
        if (merged <= 0 || !applyMeshResult(app, ctx, res)) {
          toast('Aucun sommet fusionné');
          return;
        }
        toast(`${merged} sommet${merged > 1 ? 's' : ''} supprimé${merged > 1 ? 's' : ''}`);
        return;
      }
      let target: Vec3 | null;
      if (at === 'cursor') {
        if (verts.length < 1) return fail('Sélectionnez au moins un sommet');
        target = worldToLocal(ctx, app.store.getState().cursor3d);
      } else if (at === 'center') {
        if (verts.length < 2) return fail('Sélectionnez au moins 2 sommets');
        target = selectionCenter(ctx.mesh, verts);
      } else return fail(`Mode de fusion inconnu : ${at}`);
      if (!target) return fail('Sélectionnez au moins un sommet');
      if (!applyMeshResult(app, ctx, mergeVerts(ctx.mesh, verts, target))) return fail('Fusion impossible');
    },
  });

  // ---------------------------------------------------------------- normales
  ops.push({
    id: 'mesh.flip_normals',
    label: 'Inverser les normales',
    description: 'Inverse l’orientation des faces sélectionnées',
    ...EDIT,
    exec(app) {
      const ctx = ctxOrFail(app);
      if (!ctx) return false;
      const faces = needFaces(ctx);
      if (!faces) return false;
      if (!applyMeshResult(app, ctx, flipFaces(ctx.mesh, faces))) return fail('Impossible d’inverser les normales');
    },
  });

  ops.push({
    id: 'mesh.recalc_normals',
    label: 'Recalculer les normales vers l’extérieur',
    description: 'Oriente les faces sélectionnées de façon cohérente, vers l’extérieur',
    ...EDIT,
    exec(app) {
      const ctx = ctxOrFail(app);
      if (!ctx) return false;
      const faces = needFaces(ctx);
      if (!faces) return false;
      if (!applyMeshResult(app, ctx, recalcNormalsOutside(ctx.mesh, faces))) toast('Les normales sont déjà orientées vers l’extérieur');
    },
  });

  // ---------------------------------------------------------------- supprimer / dissoudre
  ops.push({
    id: 'mesh.delete',
    label: 'Supprimer',
    description: 'Supprime les sommets, arêtes ou faces sélectionnés',
    ...EDIT,
    defaults: { what: 'verts' },
    exec(app, inv) {
      const ctx = ctxOrFail(app);
      if (!ctx) return false;
      const what = String(inv.args.what ?? 'verts');
      const s = ctx.selection;
      if (what === 'verts') {
        if (s.verts.size === 0) return fail('Sélectionnez au moins un sommet');
      } else if (what === 'edges') {
        if (s.edges.size === 0) return fail('Sélectionnez au moins une arête');
      } else if (what === 'faces' || what === 'only_faces') {
        if (s.faces.size === 0) return fail('Sélectionnez au moins une face');
      } else return fail(`Type de suppression inconnu : ${what}`);
      const res = deleteElements(ctx.mesh, s, what as 'verts' | 'edges' | 'faces' | 'only_faces');
      if (!applyMeshResult(app, ctx, { delta: res.delta })) return fail('Rien à supprimer');
      storeSelection({ verts: [], edges: [], faces: [] });
    },
  });

  ops.push({
    id: 'mesh.dissolve',
    label: 'Dissoudre',
    description: 'Retire les éléments sélectionnés en conservant la surface (les faces voisines sont fusionnées)',
    ...EDIT,
    exec(app, inv) {
      const ctx = ctxOrFail(app);
      if (!ctx) return false;
      const raw = inv.args.mode;
      const mode: 'vert' | 'edge' | 'face' = raw === 'vert' || raw === 'edge' || raw === 'face' ? raw : ctx.selectMode;
      const s = ctx.selection;
      if (mode === 'vert' && s.verts.size === 0) return fail('Sélectionnez au moins un sommet');
      if (mode === 'edge' && s.edges.size === 0) return fail('Sélectionnez au moins une arête');
      if (mode === 'face' && s.faces.size === 0) return fail('Sélectionnez au moins une face');
      if (!applyMeshResult(app, ctx, dissolveElements(ctx.mesh, s, mode))) return fail('Dissolution impossible sur cette sélection');
    },
  });

  // ---------------------------------------------------------------- ajouter une primitive (mode édition)
  const primitiveOp: OperatorDef = {
    id: 'mesh.add_primitive',
    label: 'Ajouter une primitive',
    description: 'Ajoute une primitive au maillage en cours d’édition, au curseur 3D',
    ...EDIT,
    defaults: { kind: 'cube' },
    // Les paramètres dépendent du type de primitive de la dernière exécution.
    get params(): ParamDef[] {
      const last = store.getState().lastOp;
      const kind = last?.opId === 'mesh.add_primitive' ? String(last.args.kind) : 'cube';
      const defs = PRIMITIVE_PARAMS[kind as PrimitiveKind] ?? PRIMITIVE_PARAMS.cube;
      return defs.map((d) => ({ key: d.key, label: d.label, type: d.type, min: d.min, max: d.max, step: d.step }));
    },
    exec(app, inv) {
      const ctx = ctxOrFail(app);
      if (!ctx) return false;
      const kind = String(inv.args.kind ?? 'cube') as PrimitiveKind;
      if (!(MESH_PRIMITIVE_KINDS as readonly string[]).includes(kind)) return fail(`Primitive inconnue : ${kind}`);
      const raw: Record<string, number> = {};
      for (const d of PRIMITIVE_PARAMS[kind]) if (typeof inv.args[d.key] === 'number') raw[d.key] = inv.args[d.key];
      const params = resolvePrimitiveParams(kind, raw);
      // Les valeurs effectives sont recopiées dans les arguments (affichées par le panneau d'ajustement).
      Object.assign(inv.args, params);
      const prim = createPrimitive(kind, params);
      const cursor = app.store.getState().cursor3d;
      const toLocal = ctx.matrixWorld.clone().invert().multiply(new Matrix4().makeTranslation(cursor[0], cursor[1], cursor[2]));
      const placed: MeshData = transformMesh(prim, toLocal);
      const res = appendMesh(ctx.mesh, placed);
      const select = res.select ?? selectionOfFaces(placed.faces);
      if (!applyMeshResult(app, ctx, { delta: res.delta, select })) return fail('Impossible d’ajouter la primitive');
    },
  };
  ops.push(primitiveOp);

  // Opérateurs rejouables : la sélection d'entrée est remise en place avant chaque rejeu.
  // (On remplace `exec` sur l'objet lui-même pour conserver l'accesseur `params` de mesh.add_primitive.)
  for (const def of ops) {
    if (!def.params) continue;
    const run = def.exec;
    def.exec = (app, inv) => {
      prepareSelectionForRun(app, def.id, inv.redo);
      return run.call(def, app, inv);
    };
  }

  return ops;
}
