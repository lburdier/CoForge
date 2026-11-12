import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Matrix4 } from 'three';
import type { AppContext } from '../src/app/context';
import {
  buildImportReport,
  classifyDropped,
  importFilters,
  importModel,
  importSource,
  importSummary,
  isDocRetained,
  openDroppedFiles,
  openFilters,
  openScene,
  type SourceFile,
} from '../src/app/files';
import type { NativeBridge } from '../src/app/platform';
import { initialState, setSelection, store } from '../src/app/store';
import { SceneDoc } from '../src/core/doc/SceneDoc';
import { FILE_EXTENSION } from '../src/core/doc/schema';
import { setAppContext } from '../src/app/context';
import { IMPORT_EXTENSIONS, type ImportOptions } from '../src/engine/io/importFile';
import { applyImportedScene, type ImportResult, type ImportedScene } from '../src/engine/io/scene';

/**
 * Logique d'import et d'ouverture de src/app/files.ts, sans DOM ni WebGL : vrai document, vrai
 * store, vraie écriture de scène importée (`applyImportedScene`) ; seuls le viewport (lecture
 * du fichier) et le pont Electron (`window.coforge`) sont simulés.
 */

type Reader = (name: string, options: ImportOptions) => Promise<ImportedScene>;

/** Scène importée minimale : `n` cubes d'un triangle chacun, plus les avertissements donnés. */
function sceneOf(n: number, warnings: string[] = [], name?: string): ImportedScene {
  return {
    name,
    objects: Array.from({ length: n }, (_, i) => ({
      name: `Objet ${i + 1}`,
      type: 'mesh' as const,
      parent: null,
      matrixWorld: new Matrix4().makeTranslation(i * 2, 0, 0),
      collection: null,
      mesh: 0,
    })),
    meshes: [{ name: 'Triangle', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], polygons: [[0, 1, 2]], weld: false }],
    materials: [],
    collections: [],
    warnings,
  };
}

interface Harness {
  app: AppContext;
  /** Lecture simulée du fichier (remplaçable par test). */
  reader: { read: Reader };
  setDocCalls: SceneDoc[];
  frames: string[];
  destroyed: Set<SceneDoc>;
}

function makeHarness(): Harness {
  let doc = SceneDoc.createNew('Travail');
  const reader: { read: Reader } = { read: async () => sceneOf(2) };
  const setDocCalls: SceneDoc[] = [];
  const frames: string[] = [];
  const destroyed = new Set<SceneDoc>();
  const app: any = {
    store,
    get doc() {
      return doc;
    },
    collab: {},
    ops: { modalActive: false, endModal: () => {} },
    // Même comportement que src/app/main.tsx pour ce qui concerne les fichiers.
    setDoc(next: SceneDoc, opts?: { filePath?: string | null }) {
      if (next === doc) return;
      const old = doc;
      doc = next;
      setDocCalls.push(next);
      store.setState({ filePath: opts?.filePath ?? null, dirty: false, mode: 'object', selection: new Set(), activeId: null });
      if (!isDocRetained(old)) destroyed.add(old);
    },
    onDocChange: () => () => {},
    viewport: {
      frameSelection: () => frames.push('selection'),
      frameAll: () => frames.push('all'),
      // Comme le moteur : lecture asynchrone, puis écriture en une opération imbriquée.
      async importScene(name: string, _data: ArrayBuffer, options: ImportOptions = {}): Promise<ImportResult> {
        const target = doc;
        const scene = await reader.read(name, options);
        target.beginOp();
        try {
          return applyImportedScene(target, scene, options);
        } finally {
          target.endOp();
        }
      },
    },
  };
  setAppContext(app as AppContext);
  return { app: app as AppContext, reader, setDocCalls, frames, destroyed };
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const file = (name: string, path: string | null = null): SourceFile => ({ name, data: bytes('BLENDER-v405 contenu de test'), path });
const toastText = (): string => store.getState().toast?.text ?? '';

/** `window` minimal : confirmations acceptées, pont Electron optionnel. */
function setWindow(bridge?: Partial<NativeBridge>, confirm: () => boolean = () => true): void {
  (globalThis as any).window = { confirm, coforge: bridge };
}

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let h: Harness;

beforeEach(() => {
  store.setState(initialState(), true);
  setWindow();
  h = makeHarness();
});

afterEach(() => {
  delete (globalThis as any).window;
});

describe('filtres des boîtes de fichiers', () => {
  it('Importer : tous les formats du moteur, puis un filtre par format', () => {
    const filters = importFilters(IMPORT_EXTENSIONS);
    expect(filters[0]).toEqual({ name: 'Tous les formats 3D', extensions: [...IMPORT_EXTENSIONS] });
    expect(filters.map((f) => f.name)).toEqual([
      'Tous les formats 3D',
      'Blender (.blend)',
      'glTF (.glb, .gltf)',
      'FBX (.fbx)',
      'Wavefront OBJ (.obj)',
      'STL (.stl)',
      'PLY (.ply)',
      'Collada (.dae)',
    ]);
    // Chaque extension importable est proposée par un filtre de format.
    expect(new Set(filters.slice(1).flatMap((f) => f.extensions))).toEqual(new Set(IMPORT_EXTENSIONS));
  });

  it('sous-menu : le format choisi est présélectionné', () => {
    expect(importFilters(IMPORT_EXTENSIONS, 'blend')[0]).toEqual({ name: 'Blender (.blend)', extensions: ['blend'] });
    expect(importFilters(IMPORT_EXTENSIONS, 'gltf')[0].extensions).toEqual(['glb', 'gltf']);
    const misc = importFilters(IMPORT_EXTENSIONS, 'misc');
    expect(misc[0]).toEqual({ name: 'STL, PLY, Collada', extensions: ['stl', 'ply', 'dae'] });
    expect(misc[misc.length - 1].name).toBe('Tous les formats 3D');
  });

  it('un format inconnu de la liste garde une entrée, un format retiré disparaît', () => {
    const filters = importFilters(['obj', 'xyz']);
    expect(filters.map((f) => f.name)).toEqual(['Tous les formats 3D', 'Wavefront OBJ (.obj)', 'XYZ (.xyz)']);
  });

  it('Ouvrir : scènes CoForge et fichiers 3D, .blend compris', () => {
    const filters = openFilters(IMPORT_EXTENSIONS);
    expect(filters[0].extensions).toEqual([FILE_EXTENSION, ...IMPORT_EXTENSIONS]);
    expect(filters[1]).toEqual({ name: 'Scène CoForge', extensions: [FILE_EXTENSION] });
    expect(filters.some((f) => f.extensions.includes('blend') && f.name.startsWith('Blender'))).toBe(true);
  });
});

describe('import dans la scène courante', () => {
  it('ajoute, sélectionne et cadre les objets importés ; une seule étape d’annulation', async () => {
    const doc = h.app.doc;
    const before = doc.objectIds();
    expect(doc.canUndo()).toBe(false);

    expect(await importSource(file('pièces.obj'))).toBe(true);

    const added = doc.objectIds().filter((id) => !before.includes(id));
    expect(added.length).toBe(2);
    expect([...store.getState().selection].sort()).toEqual([...added].sort());
    expect(h.frames).toEqual(['selection']);
    expect(store.getState().busy).toBeNull();
    expect(toastText()).toBe('2 objets importés depuis « pièces.obj »');
    expect(store.getState().toast?.kind).toBe('info');
    // Aucun avertissement : pas de rapport.
    expect(store.getState().dialog).toBeNull();

    doc.undo();
    expect(doc.objectIds().sort()).toEqual([...before].sort());
    expect(doc.canUndo()).toBe(false);
  });

  it('en mode édition la sélection d’objets n’est pas touchée', async () => {
    const doc = h.app.doc;
    const cube = doc.objectIds()[0];
    setSelection([cube]);
    store.setState({ mode: 'edit' });
    expect(await importSource(file('pièces.obj'))).toBe(true);
    expect([...store.getState().selection]).toEqual([cube]);
    expect(h.frames).toEqual([]);
  });

  it('avertissements : rapport d’import ouvert, comptes par type', async () => {
    h.reader.read = async () => sceneOf(3, ['2 objet(s) à plusieurs matériaux découpé(s).']);
    expect(await importSource(file('ville.fbx'))).toBe(true);
    const s = store.getState();
    expect(s.dialog).toBe('import_report');
    expect(s.importReport).toMatchObject({
      fileName: 'ville.fbx',
      mode: 'append',
      counts: { objects: 3, meshes: 3, lights: 0, cameras: 0 },
      warnings: ['2 objet(s) à plusieurs matériaux découpé(s).'],
      blender: null,
      shared: false,
    });
    expect(toastText()).toBe('3 objets importés depuis « ville.fbx » — 1 avertissement (voir le rapport d\'import)');
  });

  it('en session collaborative le rapport rappelle que l’import est partagé', async () => {
    store.setState({ session: { ...store.getState().session, status: 'connected', room: 'atelier' } });
    h.reader.read = async () => sceneOf(1, ['à vérifier']);
    await importSource(file('a.glb'));
    expect(store.getState().importReport?.shared).toBe(true);
  });

  it('erreur de lecture : message en français, document et sélection inchangés', async () => {
    const doc = h.app.doc;
    const before = doc.encode();
    setSelection([doc.objectIds()[0]]);
    const selection = store.getState().selection;
    h.reader.read = async () => {
      throw new Error('Lecture de « cassé.fbx » impossible : fichier tronqué');
    };
    expect(await importSource(file('cassé.fbx'))).toBe(false);
    expect(store.getState().toast).toMatchObject({ kind: 'error', text: 'Lecture de « cassé.fbx » impossible : fichier tronqué' });
    expect(doc.encode()).toEqual(before);
    expect(doc.canUndo()).toBe(false);
    expect(store.getState().selection).toBe(selection);
    expect(store.getState().busy).toBeNull();
    expect(store.getState().dialog).toBeNull();
  });

  it('erreur après un début d’écriture : tout est défait (cancelOp), rien dans l’historique', async () => {
    const doc = h.app.doc;
    const ids = doc.objectIds().sort();
    (h.app.viewport as any).importScene = async () => {
      doc.beginOp();
      doc.addObject({ type: 'empty', name: 'À moitié importé' });
      doc.endOp();
      throw new Error('écriture interrompue');
    };
    expect(await importSource(file('moitié.glb'))).toBe(false);
    expect(doc.objectIds().sort()).toEqual(ids);
    expect(doc.canUndo()).toBe(false);
    expect(doc.canRedo()).toBe(false);
    expect(toastText()).toBe('Import de « moitié.glb » impossible : écriture interrompue');
    // Le document reste utilisable : l'opération suivante est une étape d'annulation normale.
    doc.beginOp();
    doc.addObject({ type: 'empty', name: 'Après' });
    doc.endOp();
    expect(doc.canUndo()).toBe(true);
  });

  it('état occupé visible pendant l’import ; un second import est refusé', async () => {
    const gate = deferred<ImportedScene>();
    h.reader.read = () => gate.promise;
    const first = importSource(file('lourd.blend'));
    await vi.waitFor(() => expect(store.getState().busy).toEqual({ text: 'Import de « lourd.blend »…' }));

    expect(await importSource(file('autre.obj'))).toBe(false);
    expect(store.getState().toast).toMatchObject({ kind: 'error', text: 'Un import est déjà en cours.' });
    await importModel(); // refusé avant même d'ouvrir la boîte de fichiers
    expect(store.getState().busy).toEqual({ text: 'Import de « lourd.blend »…' });

    gate.resolve(sceneOf(1));
    expect(await first).toBe(true);
    expect(store.getState().busy).toBeNull();
    expect(toastText()).toBe('1 objet importé depuis « lourd.blend »');
  });

  it('une opération modale en cours est validée avant l’import', async () => {
    const ended: boolean[] = [];
    (h.app as any).ops = { modalActive: true, endModal: (commit: boolean) => ended.push(commit) };
    await importSource(file('a.obj'));
    expect(ended).toEqual([true]);
  });
});

describe('pont Blender', () => {
  it('dans un navigateur : aucune option d’évaluation ni de conversion', async () => {
    let seen: ImportOptions = {};
    h.reader.read = async (_n, options) => {
      seen = options;
      return sceneOf(1);
    };
    await importSource(file('scène.blend'));
    expect(seen.mode).toBe('append');
    expect(seen.evaluateBlend).toBeUndefined();
    expect(seen.convertBlend).toBeUndefined();
  });

  it('dans l’application : évaluation par chemin, état occupé, notes et version au rapport', async () => {
    const calls: any[] = [];
    const busyDuring: (string | undefined)[] = [];
    setWindow({
      blenderInfo: async () => ({ version: '5.1.0' }),
      blenderEvaluate: async (source, request) => {
        calls.push({ source, request });
        busyDuring.push(store.getState().busy?.text);
        return { meshes: {}, materialColors: { Brique: '#aa5533' }, blenderVersion: '5.1.0', notes: ['12 instance(s) réalisée(s).'] };
      },
    });
    let evaluated: unknown;
    h.reader.read = async (_n, options) => {
      evaluated = await options.evaluateBlend!({ objects: ['Courbe'], materials: ['Brique'] });
      busyDuring.push(store.getState().busy?.text);
      return sceneOf(2, ['1 objet(s) évalué(s) par Blender 5.1.0.']);
    };
    await importSource(file('scène.blend', 'D:\\projets\\scène.blend'));

    expect(calls).toEqual([{ source: { path: 'D:\\projets\\scène.blend' }, request: { objects: ['Courbe'], materials: ['Brique'] } }]);
    expect(busyDuring).toEqual(['Évaluation par Blender 5.1…', 'Import de « scène.blend »…']);
    expect((evaluated as any).materialColors).toEqual({ Brique: '#aa5533' });
    const report = store.getState().importReport!;
    expect(report.blender).toEqual({ status: 'used', version: '5.1.0', error: null });
    expect(report.warnings).toEqual(['1 objet(s) évalué(s) par Blender 5.1.0.', '12 instance(s) réalisée(s).']);
  });

  it('sans chemin connu (fichier déposé depuis un navigateur, .blend1) : par octets', async () => {
    const sources: any[] = [];
    setWindow({
      blenderInfo: async () => ({ version: '4.3.2' }),
      blenderEvaluate: async (source) => {
        sources.push(source);
        return { meshes: {} };
      },
    });
    h.reader.read = async (_n, options) => {
      await options.evaluateBlend!({ objects: ['Texte'] });
      return sceneOf(1);
    };
    const dropped = file('scène.blend');
    await importSource(dropped);
    await importSource(file('scène.blend1', 'D:\\projets\\scène.blend1'));
    expect(sources.length).toBe(2);
    expect(sources[0]).toEqual({ data: dropped.data });
    expect(sources[1].path).toBeUndefined();
    expect(sources[1].data).toBeInstanceOf(Uint8Array);
  });

  it('Blender non trouvé : l’évaluation rend null, le rapport le dit', async () => {
    let evaluateCalled = false;
    setWindow({
      blenderInfo: async () => null,
      blenderEvaluate: async () => {
        evaluateCalled = true;
        return null;
      },
    });
    let evaluated: unknown = 'pas appelé';
    h.reader.read = async (_n, options) => {
      evaluated = await options.evaluateBlend!({ objects: ['Courbe'] });
      return sceneOf(1);
    };
    expect(await importSource(file('scène.blend', 'D:\\scène.blend'))).toBe(true);
    expect(evaluated).toBeNull();
    expect(evaluateCalled).toBe(false);
    expect(store.getState().importReport?.blender).toEqual({ status: 'missing', version: null, error: null });
    // Même sans avertissement du lecteur, le rapport s'ouvre pour signaler l'absence de Blender.
    expect(store.getState().dialog).toBe('import_report');
  });

  it('Blender en échec : pas d’exception vers le lecteur, erreur au rapport', async () => {
    setWindow({
      blenderInfo: async () => ({ version: '5.0.0' }),
      blenderEvaluate: async () => {
        throw new Error("Blender n'a pas répondu en 180 s : évaluation abandonnée.");
      },
    });
    let evaluated: unknown = 'pas appelé';
    h.reader.read = async (_n, options) => {
      evaluated = await options.evaluateBlend!({ objects: ['Courbe'] });
      return sceneOf(1, ['Non évalué par Blender : 1 × courbe.']);
    };
    expect(await importSource(file('scène.blend', 'D:\\scène.blend'))).toBe(true);
    expect(evaluated).toBeNull();
    expect(store.getState().importReport?.blender).toEqual({
      status: 'failed',
      version: '5.0.0',
      error: "Blender n'a pas répondu en 180 s : évaluation abandonnée.",
    });
    expect(store.getState().busy).toBeNull();
  });

  it('conversion complète : octets .glb transmis au lecteur', async () => {
    const glb = bytes('glTF....contenu');
    setWindow({ blenderInfo: async () => ({ version: '5.1.0' }), blenderConvert: async () => glb });
    let converted: ArrayBuffer | null = null;
    let busy: string | undefined;
    (window as any).coforge.blenderConvert = async () => {
      busy = store.getState().busy?.text;
      return glb;
    };
    h.reader.read = async (_n, options) => {
      converted = await options.convertBlend!();
      return sceneOf(1, ['Lecture directe impossible : scène convertie par Blender.']);
    };
    await importSource(file('récent.blend', 'D:\\récent.blend'));
    expect(busy).toBe('Conversion par Blender 5.1…');
    expect(new Uint8Array(converted!)).toEqual(glb);
    expect(store.getState().importReport?.blender?.status).toBe('used');
  });

  it('lecture et conversion en échec : le message dit pourquoi Blender n’a pas aidé', async () => {
    setWindow({ blenderInfo: async () => null });
    h.reader.read = async (_n, options) => {
      const glb = await options.convertBlend!();
      if (!glb) throw new Error('Lecture de « récent.blend » impossible : format non reconnu');
      return sceneOf(1);
    };
    expect(await importSource(file('récent.blend', 'D:\\récent.blend'))).toBe(false);
    expect(toastText()).toBe(
      'Lecture de « récent.blend » impossible : format non reconnu — Blender non trouvé : installez Blender pour que CoForge lui fasse convertir ce fichier.',
    );
  });

  it('autre format que .blend : Blender n’est pas sollicité', async () => {
    setWindow({ blenderInfo: async () => ({ version: '5.1.0' }) });
    let seen: ImportOptions = {};
    h.reader.read = async (_n, options) => {
      seen = options;
      return sceneOf(1);
    };
    await importSource({ name: 'a.glb', data: bytes('glTF'), path: 'D:\\a.glb' });
    expect(seen.evaluateBlend).toBeUndefined();
    expect(seen.convertBlend).toBeUndefined();
  });
});

describe('ouvrir', () => {
  const picked = (name: string, path: string) => ({ name, path, data: bytes('BLENDER-v405 contenu de test') });

  it('un .blend devient une nouvelle scène non enregistrée, au nom du fichier', async () => {
    const previous = h.app.doc;
    const asked: any[] = [];
    setWindow({
      openFile: async (filters, title) => {
        asked.push({ first: filters[0], title });
        return picked('Ville basse.blend', 'D:\\projets\\Ville basse.blend');
      },
    });
    let seen: ImportOptions = {};
    h.reader.read = async (_n, options) => {
      seen = options;
      return sceneOf(3);
    };
    store.setState({ filePath: 'D:\\ancien.coforge' });

    await openScene();

    expect(asked[0].title).toBe('Ouvrir');
    expect(asked[0].first.extensions).toContain('blend');
    expect(asked[0].first.extensions).toContain(FILE_EXTENSION);
    const doc = h.app.doc;
    expect(doc).not.toBe(previous);
    expect(seen.mode).toBe('open');
    // Ni cube, ni lumière, ni caméra, ni matériau par défaut : seulement le contenu du fichier.
    expect(doc.listObjects().map((o) => o.name).sort()).toEqual(['Objet 1', 'Objet 2', 'Objet 3']);
    expect(doc.listMaterials()).toEqual([]);
    expect(doc.meshIds().length).toBe(1);
    expect(doc.getScene().name).toBe('Ville basse');
    expect(doc.getScene().activeCamera).toBeNull();
    const s = store.getState();
    expect(s.filePath).toBeNull();
    expect(s.dirty).toBe(false);
    expect(doc.canUndo()).toBe(false);
    expect(s.busy).toBeNull();
    expect(h.frames).toEqual(['all']);
    expect(toastText()).toBe('« Ville basse.blend » ouvert : 3 objets');
    expect(h.destroyed.has(previous)).toBe(false); // gardée pendant l'import…
    expect(isDocRetained(previous)).toBe(false); // …puis libérée
  });

  it('le nom de scène du fichier Blender l’emporte quand le lecteur le fournit', async () => {
    setWindow({ openFile: async () => picked('fichier.blend', 'D:\\fichier.blend') });
    h.reader.read = async () => sceneOf(1, [], 'Plan séquence');
    await openScene();
    expect(h.app.doc.getScene().name).toBe('Plan séquence');
  });

  it('échec de l’import : la scène précédente revient telle quelle (chemin, modifications, historique)', async () => {
    const previous = h.app.doc;
    previous.beginOp();
    const mine = previous.addObject({ type: 'empty', name: 'Mon travail' });
    previous.endOp();
    setSelection([mine]);
    store.setState({ filePath: 'D:\\travail.coforge', dirty: true });
    setWindow({ openFile: async () => picked('cassé.blend', 'D:\\cassé.blend') });
    h.reader.read = async () => {
      throw new Error('Lecture de « cassé.blend » impossible : non implémenté');
    };

    await openScene();

    expect(h.app.doc).toBe(previous);
    expect(h.destroyed.has(previous)).toBe(false);
    expect(previous.hasObject(mine)).toBe(true);
    expect(previous.canUndo()).toBe(true);
    const s = store.getState();
    expect(s.filePath).toBe('D:\\travail.coforge');
    expect(s.dirty).toBe(true);
    expect([...s.selection]).toEqual([mine]);
    expect(s.activeId).toBe(mine);
    expect(s.toast).toMatchObject({ kind: 'error', text: 'Lecture de « cassé.blend » impossible : non implémenté' });
    expect(s.busy).toBeNull();
    // La scène vide provisoire a été jetée.
    expect(h.destroyed.size).toBe(1);
  });

  it('un .coforge est chargé tel quel, avec son chemin', async () => {
    const saved = SceneDoc.createNew('Enregistrée');
    const id = saved.addObject({ type: 'empty', name: 'Repère' });
    setWindow({ openFile: async () => ({ name: 'scène.coforge', path: 'D:\\scène.coforge', data: saved.encode() }) });
    await openScene();
    expect(h.app.doc.getScene().name).toBe('Enregistrée');
    expect(h.app.doc.hasObject(id)).toBe(true);
    expect(store.getState().filePath).toBe('D:\\scène.coforge');
    expect(toastText()).toBe('« scène.coforge » ouvert');
  });

  it('confirmation refusée ou boîte annulée : rien ne change', async () => {
    const previous = h.app.doc;
    store.setState({ dirty: true });
    let opened = 0;
    setWindow(
      {
        openFile: async () => {
          opened++;
          return null;
        },
      },
      () => false,
    );
    await openScene();
    expect(opened).toBe(0);
    (window as any).confirm = () => true;
    await openScene();
    expect(opened).toBe(1);
    expect(h.app.doc).toBe(previous);
    expect(h.setDocCalls).toEqual([]);
  });
});

describe('fichiers déposés', () => {
  it('tri : la scène CoForge l’emporte, les fichiers 3D s’importent, le reste est signalé', () => {
    const files = [{ name: 'notes.txt' }, { name: 'a.OBJ' }, { name: 'scène.coforge' }, { name: 'b.blend' }, { name: 'autre.coforge' }];
    const sorted = classifyDropped(files, (f) => /\.(obj|blend)$/i.test(f.name));
    expect(sorted.scene?.name).toBe('scène.coforge');
    expect(sorted.imports.map((f) => f.name)).toEqual(['a.OBJ', 'b.blend']);
    expect(sorted.unknown.map((f) => f.name)).toEqual(['notes.txt']);
  });

  it('fichiers 3D : importés l’un après l’autre dans la scène courante', async () => {
    const doc = h.app.doc;
    const before = doc.objectIds().length;
    const names: string[] = [];
    h.reader.read = async (name) => {
      names.push(name);
      return sceneOf(1);
    };
    await openDroppedFiles([file('a.blend'), { name: 'b.obj', data: bytes('v 0 0 0\n'), path: null }]);
    expect(names).toEqual(['a.blend', 'b.obj']);
    expect(h.app.doc).toBe(doc);
    expect(doc.objectIds().length).toBe(before + 2);
    // Deux imports = deux étapes d'annulation.
    doc.undo();
    doc.undo();
    expect(doc.objectIds().length).toBe(before);
  });

  it('.coforge : ouvert après la confirmation habituelle', async () => {
    const saved = SceneDoc.createNew('Déposée');
    const dropped: SourceFile = { name: 'déposée.coforge', data: saved.encode(), path: 'D:\\déposée.coforge' };
    const previous = h.app.doc;
    store.setState({ dirty: true });
    const questions: string[] = [];
    (window as any).confirm = (q: string) => {
      questions.push(q);
      return false;
    };
    await openDroppedFiles([dropped]);
    expect(questions.length).toBe(1);
    expect(questions[0]).toContain('modifications non enregistrées');
    expect(h.app.doc).toBe(previous);

    (window as any).confirm = () => true;
    await openDroppedFiles([dropped, file('ignoré.blend')]);
    expect(h.app.doc.getScene().name).toBe('Déposée');
    expect(store.getState().filePath).toBe('D:\\déposée.coforge');
  });

  it('format inconnu : message d’erreur, rien d’importé', async () => {
    const before = h.app.doc.encode();
    await openDroppedFiles([{ name: 'photo.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]), path: null }]);
    expect(store.getState().toast).toMatchObject({ kind: 'error', text: 'Format non pris en charge : photo.png' });
    expect(h.app.doc.encode()).toEqual(before);
  });
});

describe('textes du rapport', () => {
  const result: ImportResult = {
    objectIds: ['a'],
    counts: { objects: 1, meshes: 1, lights: 0, cameras: 0, empties: 0, materials: 1, collections: 0 },
    warnings: [],
  };

  it('singulier, pluriel, ouverture', () => {
    const trace = { status: 'unused' as const, version: null, error: null, notes: [] };
    expect(importSummary(buildImportReport('a.obj', 'append', result, trace, false))).toBe('1 objet importé depuis « a.obj »');
    const many = { ...result, counts: { ...result.counts, objects: 42 }, warnings: ['x', 'y'] };
    expect(importSummary(buildImportReport('b.blend', 'append', many, trace, false))).toBe(
      '42 objets importés depuis « b.blend » — 2 avertissements (voir le rapport d\'import)',
    );
    expect(importSummary(buildImportReport('c.blend', 'open', many, { ...trace, notes: ['z'] }, true))).toBe(
      '« c.blend » ouvert : 42 objets — 3 avertissements (voir le rapport d\'import)',
    );
  });
});
