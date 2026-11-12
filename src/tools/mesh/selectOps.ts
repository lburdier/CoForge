import type { AppContext } from '../../app/context';
import { EMPTY_EDIT_SELECTION, setEditSelection } from '../../app/store';
import { expandSelection, selectLess, selectLinked, selectMore } from '../../core/mesh/select';
import { buildTopology } from '../../core/mesh/topology';
import type { OperatorDef } from '../api';
import { fail, getMeshEditContext, pollMeshEdit, storeSelection } from './context';

/** Opérateurs de sélection du mode édition (n'écrivent pas dans le document : non annulables). */
export function selectOperators(): OperatorDef[] {
  const selectAll: OperatorDef = {
    id: 'mesh.select_all',
    label: 'Tout sélectionner / désélectionner',
    description: 'Sélectionne, désélectionne ou inverse la sélection des éléments du maillage',
    modes: ['edit'],
    poll: pollMeshEdit,
    undoable: false,
    defaults: { action: 'toggle' },
    exec(app: AppContext, inv) {
      const ctx = getMeshEditContext(app);
      if (!ctx) return false;
      const mesh = ctx.mesh;
      const mode = ctx.selectMode;
      let action = String(inv.args.action ?? 'toggle');
      if (action === 'toggle') {
        const any = ctx.selection.verts.size > 0 || ctx.selection.edges.size > 0 || ctx.selection.faces.size > 0;
        action = any ? 'deselect' : 'select';
      }
      if (action === 'deselect') {
        setEditSelection(EMPTY_EDIT_SELECTION);
        return;
      }
      if (action === 'select') {
        storeSelection(expandSelection(mesh, mesh.verts.keys(), 'vert'));
        return;
      }
      if (action === 'invert') {
        if (mode === 'face') {
          const faces: string[] = [];
          for (const f of mesh.faces.keys()) if (!ctx.selection.faces.has(f)) faces.push(f);
          storeSelection(expandSelection(mesh, faces, 'face'));
        } else if (mode === 'edge') {
          const edges: string[] = [];
          for (const e of buildTopology(mesh).edges.keys()) if (!ctx.selection.edges.has(e)) edges.push(e);
          storeSelection(expandSelection(mesh, edges, 'edge'));
        } else {
          const verts: string[] = [];
          for (const v of mesh.verts.keys()) if (!ctx.selection.verts.has(v)) verts.push(v);
          storeSelection(expandSelection(mesh, verts, 'vert'));
        }
        return;
      }
      return fail(`Action de sélection inconnue : ${action}`);
    },
  };

  const needSelection = (app: AppContext) => {
    const ctx = getMeshEditContext(app);
    if (!ctx) return null;
    const s = ctx.selection;
    if (s.verts.size === 0 && s.edges.size === 0 && s.faces.size === 0) {
      fail('Sélectionnez au moins un élément');
      return null;
    }
    return ctx;
  };

  const linked: OperatorDef = {
    id: 'mesh.select_linked',
    label: 'Sélectionner les éléments liés',
    description: 'Étend la sélection à toutes les parties connexes qu’elle touche',
    modes: ['edit'],
    poll: pollMeshEdit,
    undoable: false,
    exec(app) {
      const ctx = needSelection(app);
      if (!ctx) return false;
      storeSelection(selectLinked(ctx.mesh, ctx.selection));
    },
  };

  const more: OperatorDef = {
    id: 'mesh.select_more',
    label: 'Étendre la sélection',
    description: 'Ajoute les éléments voisins de la sélection',
    modes: ['edit'],
    poll: pollMeshEdit,
    undoable: false,
    exec(app) {
      const ctx = needSelection(app);
      if (!ctx) return false;
      storeSelection(selectMore(ctx.mesh, ctx.selection));
    },
  };

  const less: OperatorDef = {
    id: 'mesh.select_less',
    label: 'Réduire la sélection',
    description: 'Retire les éléments situés en bordure de la sélection',
    modes: ['edit'],
    poll: pollMeshEdit,
    undoable: false,
    exec(app) {
      const ctx = needSelection(app);
      if (!ctx) return false;
      storeSelection(selectLess(ctx.mesh, ctx.selection));
    },
  };

  return [selectAll, linked, more, less];
}
