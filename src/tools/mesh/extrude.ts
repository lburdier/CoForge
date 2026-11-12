import type { AppContext } from '../../app/context';
import type { Vec3 } from '../../core/doc/schema';
import { extrudeEdges, extrudeFaces, extrudeFacesAlongNormals, extrudeVerts } from '../../core/mesh/ops';
import { loopPositions, newellNormal, selectionCenter } from '../../core/mesh/topology';
import type { MeshOpResult } from '../../core/mesh/types';
import type { ModalHandler, ModalResult, OperatorDef } from '../api';
import { startTranslateModal } from '../transform';
import { applyMeshResult, fail, getMeshEditContext, normalToWorld, pollMeshEdit, toWorld, vectorToWorld } from './context';
import { LiveMeshEdit, NumInput, eventPos, fmt, isCancelKey, isConfirmKey, localUnitsPerPixel, project, restoreSelectionOnCancel } from './modal';

/** Extrusion (E) et extrusion le long des normales (Alt+E). */
export function extrudeOperators(): OperatorDef[] {
  const extrude: OperatorDef = {
    id: 'mesh.extrude',
    label: 'Extruder',
    description: 'Extrude la sélection (faces en région, arêtes ou sommets) puis la déplace',
    modes: ['edit'],
    poll: pollMeshEdit,
    defaults: { move: true },
    exec(app: AppContext, inv) {
      const ctx = getMeshEditContext(app);
      if (!ctx) return false;
      const s = ctx.selection;
      const mode = ctx.selectMode;
      let res: MeshOpResult & { normal: Vec3 };
      let fromFaces = false;
      if (mode === 'face' || (mode === 'edge' && s.faces.size > 0)) {
        if (s.faces.size === 0) return fail('Sélectionnez au moins une face');
        res = extrudeFaces(ctx.mesh, s.faces);
        fromFaces = true;
      } else if (mode === 'edge') {
        if (s.edges.size === 0) return fail('Sélectionnez au moins une arête');
        res = extrudeEdges(ctx.mesh, s.edges);
      } else {
        if (s.verts.size < 2) return fail('Sélectionnez au moins deux sommets reliés par une arête');
        res = extrudeVerts(ctx.mesh, s.verts);
        fromFaces = (res.select?.faces.length ?? 0) > 0;
      }
      if (!applyMeshResult(app, ctx, res)) {
        return fail(mode === 'vert' ? 'Extrusion impossible : les sommets sélectionnés doivent être reliés par une arête' : 'Extrusion impossible sur cette sélection');
      }
      if (inv.args.move === false || inv.redo) return;
      const axis = fromFaces ? normalToWorld(ctx, res.normal) : null;
      const translate = startTranslateModal(app, {
        constraint: axis ? { axis } : null,
        status: fromFaces
          ? 'Extruder : déplacez le long de la normale | Entrée/clic : valider | Échap : annuler'
          : 'Extruder : déplacez la sélection | X/Y/Z : axe | Entrée/clic : valider | Échap : annuler',
      });
      return restoreSelectionOnCancel(translate, ctx.rawSelection);
    },
  };

  const extrudeNormals: OperatorDef = {
    id: 'mesh.extrude_normals',
    label: 'Extruder le long des normales',
    description: 'Extrude les faces sélectionnées, chaque sommet suivant la normale moyenne de ses faces',
    modes: ['edit'],
    poll: pollMeshEdit,
    exec(app: AppContext, inv) {
      const ctx = getMeshEditContext(app);
      if (!ctx) return false;
      const faces = [...ctx.selection.faces];
      if (faces.length === 0) return fail('Sélectionnez au moins une face');
      const live = new LiveMeshEdit(app, ctx);
      const mesh = ctx.mesh;

      // Repères écran : centre de la région et projection de sa normale (en unités locales).
      const centerLocal = selectionCenter(mesh, faces) ?? [0, 0, 0];
      const nAcc: Vec3 = [0, 0, 0];
      for (const f of faces) {
        const n = newellNormal(loopPositions(mesh, mesh.faces.get(f) ?? []));
        nAcc[0] += n[0];
        nAcc[1] += n[1];
        nAcc[2] += n[2];
      }
      const nLen = Math.hypot(nAcc[0], nAcc[1], nAcc[2]);
      const nLocal: Vec3 = nLen > 1e-12 ? [nAcc[0] / nLen, nAcc[1] / nLen, nAcc[2] / nLen] : [0, 0, 1];
      const centerWorld = toWorld(ctx, centerLocal);
      const normalWorld = vectorToWorld(ctx, nLocal);
      const upp = localUnitsPerPixel(app, ctx, centerWorld);

      let m0 = inv.mouse ? { ...inv.mouse } : null;
      let distance = 0;
      const numeric = new NumInput();

      const status = () =>
        `Extruder le long des normales : ${numeric.active ? numeric.text : fmt(distance)} | saisie numérique | Entrée/clic : valider | Échap : annuler`;

      const apply = (): ModalResult | void => {
        const d = numeric.active ? (numeric.value() ?? 0) : distance;
        if (!live.update((orig, idGen) => extrudeFacesAlongNormals(orig, faces, d, idGen))) return 'cancelled';
        app.ops.setModalStatus(status());
        app.viewport.requestRender();
      };

      const fromMouse = (m: { x: number; y: number }): number => {
        if (!m0) m0 = { ...m };
        const c = project(app, centerWorld);
        const s = project(app, centerWorld.clone().add(normalWorld));
        if (c && s) {
          const dx = s.x - c.x;
          const dy = s.y - c.y;
          const l2 = dx * dx + dy * dy;
          // Normale suffisamment visible à l'écran : on suit la souris le long de sa projection.
          if (l2 > 4) return ((m.x - m0.x) * dx + (m.y - m0.y) * dy) / l2;
          // Normale face à la caméra : distance au centre.
          return (Math.hypot(m.x - c.x, m.y - c.y) - Math.hypot(m0.x - c.x, m0.y - c.y)) * upp;
        }
        return (m.x - m0.x) * upp;
      };

      // Topologie créée immédiatement (distance nulle), la sélection passe sur les faces du dessus.
      if (!live.update((orig, idGen) => extrudeFacesAlongNormals(orig, faces, 0, idGen))) return false;

      const handler: ModalHandler = {
        status: status(),
        onPointerMove(e) {
          if (numeric.active) return;
          distance = fromMouse(eventPos(app, e));
          return apply();
        },
        onPointerDown(e) {
          if (e.button === 0) return 'finished';
          if (e.button === 2) return 'cancelled';
        },
        onKeyDown(e) {
          if (isCancelKey(e)) return 'cancelled';
          if (isConfirmKey(e)) return 'finished';
          if (numeric.handle(e)) return apply();
        },
        onEnd(committed) {
          if (!committed) live.restoreSelection();
        },
      };
      return handler;
    },
  };

  return [extrude, extrudeNormals];
}
