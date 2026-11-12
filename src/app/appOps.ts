import type { AppContext } from './context';
import { exportScene, importModel, newScene, openScene, saveScene, type ImportGroup } from './files';
import { leaveSession } from './session';
import { patchRender, store, toast, type DialogId } from './store';

const IMPORT_GROUPS: readonly ImportGroup[] = ['all', 'blend', 'gltf', 'fbx', 'obj', 'misc'];

/** Argument `format` de `file.import` (entrées du sous-menu Fichier › Importer) ; inconnu : tous les formats. */
function importGroup(value: unknown): ImportGroup {
  return IMPORT_GROUPS.includes(value as ImportGroup) ? (value as ImportGroup) : 'all';
}

/** Opérateurs applicatifs : fichiers, annulation, rendu, session, dialogues. */
export function registerAppOps(app: AppContext): void {
  const report = (p: Promise<unknown>) => void p.catch((err) => toast((err as Error)?.message ?? String(err), 'error'));

  app.ops.register(
    { id: 'file.new', label: 'Nouveau', undoable: false, exec: () => report(newScene()) },
    { id: 'file.open', label: 'Ouvrir…', undoable: false, exec: () => report(openScene()) },
    { id: 'file.save', label: 'Enregistrer', undoable: false, exec: () => report(saveScene(false)) },
    { id: 'file.save_as', label: 'Enregistrer sous…', undoable: false, exec: () => report(saveScene(true)) },
    {
      // L'import gère lui-même son étape d'annulation (une seule, défaite en cas d'erreur).
      id: 'file.import',
      label: 'Importer…',
      description: 'Importer un fichier 3D : Blender (.blend), glTF, FBX, OBJ, STL, PLY, Collada',
      undoable: false,
      defaults: { format: 'all' },
      poll: () => store.getState().busy === null,
      exec: (_a, inv) => report(importModel(importGroup(inv.args.format))),
    },
    {
      id: 'file.export',
      label: 'Exporter',
      undoable: false,
      defaults: { format: 'glb' },
      exec: (_a, inv) => report(exportScene(inv.args.format === 'obj' ? 'obj' : 'glb')),
    },
    {
      id: 'edit.undo',
      label: 'Annuler',
      undoable: false,
      poll: (a) => a.doc.canUndo(),
      exec: (a) => {
        a.doc.undo();
        store.setState({ lastOp: null });
      },
    },
    {
      id: 'edit.redo',
      label: 'Rétablir',
      undoable: false,
      poll: (a) => a.doc.canRedo(),
      exec: (a) => {
        a.doc.redo();
        store.setState({ lastOp: null });
      },
    },
    {
      id: 'render.render',
      label: "Rendre l'image",
      undoable: false,
      poll: () => !store.getState().render.running,
      exec: (a) => {
        if (!a.doc.getScene().activeCamera) {
          toast('Aucune caméra active dans la scène (Ajouter › Caméra)', 'error');
          return false;
        }
        patchRender({ open: true, imageUrl: null, progress: 0, samples: 0 });
        a.viewport.renderFinal().catch((err) => {
          patchRender({ running: false });
          const msg = (err as Error)?.message ?? String(err);
          if (!/annul/i.test(msg)) toast(`Rendu impossible : ${msg}`, 'error');
        });
      },
    },
    {
      id: 'render.view',
      label: 'Voir le rendu',
      undoable: false,
      exec: () => patchRender({ open: !store.getState().render.open }),
    },
    {
      id: 'session.leave',
      label: 'Quitter la session',
      undoable: false,
      poll: () => store.getState().session.status !== 'offline',
      exec: () => report(leaveSession().then(() => toast('Session quittée, la scène reste ouverte en local'))),
    },
    {
      id: 'ui.dialog',
      label: 'Ouvrir un dialogue',
      undoable: false,
      exec: (_a, inv) => store.setState({ dialog: (inv.args.dialog as DialogId) ?? null, popup: null }),
    },
    {
      id: 'view.search',
      label: 'Rechercher un opérateur…',
      undoable: false,
      exec: () => store.setState({ popup: { kind: 'search', x: window.innerWidth / 2, y: window.innerHeight / 3 } }),
    },
  );
}
