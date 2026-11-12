import { createRoot } from 'react-dom/client';
import { SceneDoc } from '../core/doc/SceneDoc';
import { createViewport } from '../engine';
import { createCollab } from '../net';
import { registerTools } from '../tools';
import { OperatorRegistry } from '../tools/api';
import { App } from '../ui/App';
import { registerAppOps } from './appOps';
import { setAppContext, type AppContext } from './context';
import { installFileDrop, isDocRetained, loadSceneData } from './files';
import { platform } from './platform';
import { EMPTY_EDIT_SELECTION, store, toast } from './store';

/**
 * Assemblage de l'application : crée le contexte, branche le document sur le
 * store, le viewport et le réseau, puis monte l'interface.
 */

type DocListener = (doc: SceneDoc) => void | (() => void);

function createApp(): AppContext {
  let doc = SceneDoc.createNew();
  const listeners = new Map<DocListener, void | (() => void)>();

  const notify = (cb: DocListener) => {
    const prev = listeners.get(cb);
    if (typeof prev === 'function') {
      try {
        prev();
      } catch (err) {
        console.error(err);
      }
    }
    try {
      listeners.set(cb, cb(doc));
    } catch (err) {
      console.error(err);
      listeners.set(cb, undefined);
    }
  };

  const app = {
    store,
    get doc() {
      return doc;
    },
    setDoc(next: SceneDoc, opts?: { filePath?: string | null }) {
      if (next === doc) return;
      app.ops.endModal(false);
      const old = doc;
      doc = next;
      store.setState({
        docEpoch: store.getState().docEpoch + 1,
        filePath: opts?.filePath ?? null,
        dirty: false,
        mode: 'object',
        selection: new Set(),
        activeId: null,
        editSelection: EMPTY_EDIT_SELECTION,
        lastOp: null,
        cameraView: false,
        canUndo: doc.canUndo(),
        canRedo: doc.canRedo(),
      });
      app.viewport.setDoc(doc);
      for (const cb of [...listeners.keys()]) notify(cb);
      // L'ancien document n'est détruit que s'il n'est plus relié au réseau. Exception : pendant
      // l'ouverture d'un fichier 3D, la scène précédente est gardée pour y revenir si l'import échoue.
      if (!isDocRetained(old)) setTimeout(() => old.destroy(), 0);
    },
    onDocChange(cb: DocListener) {
      listeners.set(cb, undefined);
      notify(cb);
      return () => {
        const cleanup = listeners.get(cb);
        if (typeof cleanup === 'function') cleanup();
        listeners.delete(cb);
      };
    },
  } as unknown as AppContext & { viewport: AppContext['viewport']; collab: AppContext['collab']; ops: OperatorRegistry };

  (app as any).viewport = createViewport(app);
  (app as any).collab = createCollab(app);
  (app as any).ops = new OperatorRegistry(app);
  return app;
}

/** Garde le store cohérent avec le document (annulation, sélection d'éléments supprimés, titre). */
function bindDocToStore(app: AppContext): void {
  app.onDocChange((doc) => {
    const offs = [
      doc.on('undo', (e) => store.setState({ canUndo: e.canUndo, canRedo: e.canRedo })),
      doc.on('change', (e) => {
        if (e.local && !store.getState().dirty) store.setState({ dirty: true });
      }),
      doc.on('objects', (e) => {
        const s = store.getState();
        if (e.removed.length) {
          const gone = e.removed.filter((id) => !doc.hasObject(id));
          if (gone.some((id) => s.selection.has(id) || s.activeId === id)) {
            const selection = new Set([...s.selection].filter((id) => doc.hasObject(id)));
            const activeLost = !!s.activeId && !doc.hasObject(s.activeId);
            const activeId = activeLost ? ([...selection].pop() ?? null) : s.activeId;
            if (activeLost && s.mode === 'edit') {
              app.ops.endModal(false);
              store.setState({ mode: 'object', editSelection: EMPTY_EDIT_SELECTION });
              if (!e.local) toast("L'objet en cours d'édition a été supprimé par un autre utilisateur", 'error');
            }
            store.setState({ selection, activeId });
          }
        }
      }),
      doc.on('mesh', (e) => {
        // Retire de la sélection d'édition les éléments supprimés (par soi ou par un autre).
        const s = store.getState();
        if (s.mode !== 'edit' || !s.activeId || !(e.topologyChanged || e.removed)) return;
        const obj = doc.getObject(s.activeId);
        if (!obj || obj.data !== e.id) return;
        const mesh = doc.getMesh(e.id);
        const sel = s.editSelection;
        if (!mesh) {
          store.setState({ editSelection: EMPTY_EDIT_SELECTION });
          return;
        }
        const verts = [...sel.verts].filter((v) => mesh.verts.has(v));
        const faces = [...sel.faces].filter((f) => mesh.faces.has(f));
        const edges = [...sel.edges].filter((k) => {
          const i = k.indexOf('|');
          return mesh.verts.has(k.slice(0, i)) && mesh.verts.has(k.slice(i + 1));
        });
        if (verts.length !== sel.verts.size || faces.length !== sel.faces.size || edges.length !== sel.edges.size) {
          store.setState({ editSelection: { verts: new Set(verts), edges: new Set(edges), faces: new Set(faces) } });
        }
      }),
      doc.on('scene', () => updateTitle(app)),
    ];
    updateTitle(app);
    return () => offs.forEach((off) => off());
  });

  let last = { filePath: store.getState().filePath, dirty: store.getState().dirty };
  store.subscribe((s) => {
    if (s.filePath !== last.filePath || s.dirty !== last.dirty) {
      last = { filePath: s.filePath, dirty: s.dirty };
      updateTitle(app);
    }
  });
}

function updateTitle(app: AppContext): void {
  const s = store.getState();
  const name = s.filePath ? s.filePath.split(/[\\/]/).pop() : app.doc.getScene().name;
  platform.setTitle(`${name}${s.dirty ? ' *' : ''} - CoForge`);
}

/** Diffuse aux autres utilisateurs ce que fait l'utilisateur local (sélection, mode, identité). */
function bindPresence(app: AppContext): void {
  let prev = store.getState();
  const publish = (force = false) => {
    const s = store.getState();
    if (s.session.status !== 'connected') {
      prev = s;
      return;
    }
    const patch: Record<string, unknown> = {};
    if (force || s.user !== prev.user) patch.user = s.user;
    if (force || s.selection !== prev.selection) patch.selection = [...s.selection].slice(0, 500);
    if (force || s.activeId !== prev.activeId) patch.activeId = s.activeId;
    if (force || s.mode !== prev.mode) patch.mode = s.mode;
    if (force || s.editSelection !== prev.editSelection || s.mode !== prev.mode) {
      patch.editVerts = s.mode === 'edit' ? [...s.editSelection.verts].slice(0, 400) : [];
    }
    const becameConnected = prev.session.status !== 'connected';
    prev = s;
    if (becameConnected && !force) return publish(true);
    if (Object.keys(patch).length) app.collab.setPresence(patch);
  };
  store.subscribe(() => publish());
}

async function start(): Promise<void> {
  const app = createApp();
  setAppContext(app);
  registerAppOps(app);
  registerTools(app);
  bindDocToStore(app);
  bindPresence(app);

  platform.onCloseRequest(() => {
    const s = store.getState();
    if (!s.dirty) return true;
    return window.confirm('La scène a des modifications non enregistrées. Quitter quand même ?');
  });

  // Glisser-déposer : .coforge → ouvrir, fichiers 3D (.blend, glTF, FBX…) → importer.
  installFileDrop();

  createRoot(document.getElementById('root')!).render(<App />);

  try {
    const file = await platform.getStartupFile();
    if (file) loadSceneData(file.data, file.path);
  } catch (err) {
    toast((err as Error).message, 'error');
  }

  // Accès de diagnostic (console, mesures de performance) : en développement, ou avec ?debug.
  if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) (window as any).__app = app;
}

void start();
