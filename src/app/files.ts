import { compositeImageUrl } from './composite';
import { SceneDoc } from '../core/doc/SceneDoc';
import { FILE_EXTENSION } from '../core/doc/schema';
import type { ImportOptions } from '../engine/io/importFile';
import type { ImportResult } from '../engine/io/scene';
import { getApp } from './context';
import { platform, type BlendSource, type FileFilter, type OpenedFile } from './platform';
import { leaveSession } from './session';
import { setBusy, setSelection, store, toast, type ImportReport } from './store';

const SCENE_FILTERS: FileFilter[] = [{ name: 'Scène CoForge', extensions: [FILE_EXTENSION] }];

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Extension en minuscules, sans le point (chaîne vide s'il n'y en a pas). */
function extensionOf(name: string): string {
  return name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
}

/** Nom de fichier sans dossier ni extension : nom par défaut de la scène ouverte depuis ce fichier. */
function stem(name: string): string {
  return baseName(name).replace(/\.[^.]+$/, '') || 'Scène';
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ------------------------------------------------------------------ formats et filtres

/**
 * Lecteurs de fichiers 3D du moteur, chargés à la demande (comme le fait le viewport) :
 * la liste des extensions importables et la détection de format y sont définies.
 */
type ImportModule = typeof import('../engine/io/importFile');
let importModule: Promise<ImportModule> | null = null;
function engineImport(): Promise<ImportModule> {
  return (importModule ??= import('../engine/io/importFile'));
}

/** Entrées du sous-menu Fichier › Importer ('all' : tous les formats). */
export type ImportGroup = 'all' | 'blend' | 'gltf' | 'fbx' | 'obj' | 'misc';

const FORMAT_FILTERS: (FileFilter & { group: Exclude<ImportGroup, 'all'> })[] = [
  { group: 'blend', name: 'Blender (.blend)', extensions: ['blend'] },
  { group: 'gltf', name: 'glTF (.glb, .gltf)', extensions: ['glb', 'gltf'] },
  { group: 'fbx', name: 'FBX (.fbx)', extensions: ['fbx'] },
  { group: 'obj', name: 'Wavefront OBJ (.obj)', extensions: ['obj'] },
  { group: 'misc', name: 'STL (.stl)', extensions: ['stl'] },
  { group: 'misc', name: 'PLY (.ply)', extensions: ['ply'] },
  { group: 'misc', name: 'Collada (.dae)', extensions: ['dae'] },
];

/** Un filtre par format réellement importable (`extensions` = IMPORT_EXTENSIONS du moteur). */
function formatFilters(extensions: readonly string[]): (FileFilter & { group: string })[] {
  const known = FORMAT_FILTERS.map((f) => ({ ...f, extensions: f.extensions.filter((e) => extensions.includes(e)) })).filter(
    (f) => f.extensions.length > 0,
  );
  // Un format ajouté au moteur sans être décrit ici garde une entrée à son nom.
  const listed = new Set(known.flatMap((f) => f.extensions));
  const extra = extensions.filter((e) => !listed.has(e)).map((e) => ({ group: 'misc', name: `${e.toUpperCase()} (.${e})`, extensions: [e] }));
  return [...known, ...extra];
}

const plain = (f: FileFilter): FileFilter => ({ name: f.name, extensions: [...f.extensions] });

/**
 * Filtres de la boîte « Importer ». 'all' : « Tous les formats 3D » puis un filtre par format ;
 * un groupe précis : ses formats d'abord (présélectionnés), puis « Tous les formats 3D ».
 */
export function importFilters(extensions: readonly string[], group: ImportGroup = 'all'): FileFilter[] {
  const all: FileFilter = { name: 'Tous les formats 3D', extensions: [...extensions] };
  const formats = formatFilters(extensions);
  if (group === 'all') return [all, ...formats.map(plain)];
  const mine = formats.filter((f) => f.group === group);
  if (mine.length === 0) return [all, ...formats.map(plain)];
  const merged: FileFilter[] = mine.length > 1 ? [{ name: mine.map((f) => f.name.replace(/ \(.*\)$/, '')).join(', '), extensions: mine.flatMap((f) => f.extensions) }] : [];
  return [...merged, ...mine.map(plain), all];
}

/** Filtres de la boîte « Ouvrir » : scènes CoForge et fichiers 3D (ouverts comme nouvelle scène). */
export function openFilters(extensions: readonly string[]): FileFilter[] {
  return [
    { name: 'Scènes et fichiers 3D', extensions: [FILE_EXTENSION, ...extensions] },
    ...SCENE_FILTERS.map(plain),
    ...formatFilters(extensions).map(plain),
  ];
}

// ------------------------------------------------------------------ nouvelle scène, ouverture, enregistrement

/** Demande confirmation si la scène a des modifications non enregistrées ou si une session est en cours. */
async function confirmDiscard(action: string): Promise<boolean> {
  const s = store.getState();
  if (s.session.status !== 'offline') {
    if (!window.confirm(`${action} va vous faire quitter la session en cours. Continuer ?`)) return false;
    await leaveSession();
    return true;
  }
  if (s.dirty && !window.confirm(`La scène a des modifications non enregistrées. ${action} quand même ?`)) return false;
  return true;
}

/** Un import est en cours : rien d'autre ne doit toucher au document. */
function refuseWhileBusy(): boolean {
  if (!store.getState().busy) return false;
  toast('Un import est déjà en cours.', 'error');
  return true;
}

export async function newScene(): Promise<void> {
  if (refuseWhileBusy()) return;
  if (!(await confirmDiscard('Créer une nouvelle scène'))) return;
  getApp().setDoc(SceneDoc.createNew(), { filePath: null });
}

export function loadSceneData(data: Uint8Array, path: string | null): void {
  let doc: SceneDoc;
  try {
    doc = SceneDoc.fromUpdate(data);
  } catch {
    throw new Error("Ce fichier n'est pas une scène CoForge valide.");
  }
  getApp().setDoc(doc, { filePath: path });
}

/** Fichier à ouvrir ou importer. `path` : vrai chemin sur le disque quand il est connu (Electron), sinon null. */
export interface SourceFile {
  name: string;
  data: Uint8Array;
  path: string | null;
}

function sourceOf(file: OpenedFile): SourceFile {
  return { name: file.name, data: file.data, path: platform.isElectron ? file.path : null };
}

/**
 * Ouvre un fichier comme scène courante : un .coforge est chargé tel quel ; un fichier 3D
 * (.blend, glTF, FBX…) devient une nouvelle scène non enregistrée. Renvoie true si c'est fait.
 */
async function openSource(src: SourceFile): Promise<boolean> {
  if (extensionOf(src.name) !== FILE_EXTENSION) {
    const { detectFormat } = await engineImport();
    if (detectFormat(src.name, toArrayBuffer(src.data)) !== null) return runImport(src, 'open');
  }
  try {
    loadSceneData(src.data, src.path);
    toast(`« ${src.name} » ouvert`);
    return true;
  } catch (err) {
    toast(errorMessage(err), 'error');
    return false;
  }
}

/** Fichier › Ouvrir : scène CoForge, ou fichier 3D ouvert comme nouvelle scène. */
export async function openScene(): Promise<void> {
  if (refuseWhileBusy()) return;
  if (!(await confirmDiscard('Ouvrir une autre scène'))) return;
  const { IMPORT_EXTENSIONS } = await engineImport();
  const file = await platform.openFile(openFilters(IMPORT_EXTENSIONS), 'Ouvrir');
  if (!file) return;
  await openSource(sourceOf(file));
}

export async function saveScene(saveAs = false): Promise<boolean> {
  const app = getApp();
  const s = store.getState();
  const sceneName = app.doc.getScene().name.replace(/[<>:"/\\|?*]/g, '_') || 'scene';
  const target = saveAs ? null : s.filePath;
  try {
    const path = await platform.saveFile(app.doc.encode(), target, `${sceneName}.${FILE_EXTENSION}`, SCENE_FILTERS);
    if (!path) return false;
    store.setState({ filePath: platform.isElectron ? path : null, dirty: false });
    toast(`Enregistré : ${baseName(path)}`);
    return true;
  } catch (err) {
    toast(`Échec de l'enregistrement : ${(err as Error).message}`, 'error');
    return false;
  }
}

// ------------------------------------------------------------------ import de fichiers 3D

/** Fichier › Importer : ajoute le contenu d'un fichier 3D à la scène courante. */
export async function importModel(group: ImportGroup = 'all'): Promise<void> {
  if (refuseWhileBusy()) return;
  const { IMPORT_EXTENSIONS } = await engineImport();
  const file = await platform.openFile(importFilters(IMPORT_EXTENSIONS, group), 'Importer');
  if (!file) return;
  await runImport(sourceOf(file), 'append');
}

/** Ajoute un fichier 3D déjà lu à la scène courante (glisser-déposer). Renvoie true si l'import a réussi. */
export function importSource(src: SourceFile): Promise<boolean> {
  return runImport(src, 'append');
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  // Vue sur tout son tampon : pas de copie (un .blend peut peser plusieurs centaines de Mo).
  if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength && data.buffer instanceof ArrayBuffer) return data.buffer;
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

/** Laisse l'interface afficher l'état « occupé » avant un traitement lourd. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    // Fenêtre masquée ou réduite : pas d'image à attendre, le délai de garde suffit.
    const guard = setTimeout(resolve, 120);
    if (typeof requestAnimationFrame !== 'function') return;
    requestAnimationFrame(() =>
      setTimeout(() => {
        clearTimeout(guard);
        resolve();
      }, 0),
    );
  });
}

const plural = (n: number, one: string, many: string): string => `${n} ${n > 1 ? many : one}`;

/** « 5.1.0 » → « 5.1 » (texte de l'état occupé). */
function shortVersion(version: string): string {
  return version.split('.').slice(0, 2).join('.');
}

/** Ce que le Blender installé a fait (ou pas) pendant un import. */
export interface BlenderTrace {
  status: 'unused' | 'used' | 'missing' | 'failed';
  version: string | null;
  error: string | null;
  /** Remarques du pont (instances réalisées, limites atteintes…). */
  notes: string[];
}

const newTrace = (): BlenderTrace => ({ status: 'unused', version: null, error: null, notes: [] });

/**
 * Options d'import branchées sur le Blender installé (application Windows uniquement) : le
 * lecteur natif lui demande la géométrie finale de ce qu'il ne sait pas reconstruire et la
 * couleur moyenne des textures, ou la conversion complète du fichier s'il ne sait pas le lire.
 * Les deux fonctions renvoient null en cas d'échec (jamais d'exception) et notent dans `trace`
 * ce qui s'est passé. Le fichier est désigné par son chemin quand il est connu, sinon par ses octets.
 */
function blenderOptions(src: SourceFile, trace: BlenderTrace, busyText: string): Pick<ImportOptions, 'evaluateBlend' | 'convertBlend'> {
  if (!platform.isElectron) return {};
  const source: BlendSource = src.path && /\.blend$/i.test(src.path) ? { path: src.path } : { data: src.data };

  async function withBlender<T>(label: string, call: () => Promise<T | null>): Promise<T | null> {
    try {
      const info = await platform.blenderInfo();
      if (!info) {
        trace.status = 'missing';
        return null;
      }
      trace.version = info.version;
      setBusy(`${label} par Blender ${shortVersion(info.version)}…`);
      const result = await call();
      // Blender désinstallé entre-temps : même cas que « non trouvé ».
      trace.status = result === null ? 'missing' : 'used';
      return result;
    } catch (err) {
      trace.status = 'failed';
      trace.error = errorMessage(err);
      return null;
    } finally {
      setBusy(busyText);
    }
  }

  return {
    evaluateBlend: (request) =>
      withBlender('Évaluation', async () => {
        const result = await platform.blenderEvaluate(source, request);
        if (result?.notes) trace.notes.push(...result.notes);
        return result;
      }),
    convertBlend: () =>
      withBlender('Conversion', async () => {
        const glb = await platform.blenderConvert(source);
        return glb ? toArrayBuffer(glb) : null;
      }),
  };
}

/** Rapport d'un import réussi : comptes, avertissements du lecteur et du pont, rôle de Blender. */
export function buildImportReport(fileName: string, mode: 'append' | 'open', result: ImportResult, trace: BlenderTrace, shared: boolean): ImportReport {
  return {
    fileName,
    mode,
    counts: { ...result.counts },
    warnings: [...result.warnings, ...trace.notes],
    blender: trace.status === 'unused' ? null : { status: trace.status, version: trace.version, error: trace.error },
    shared,
  };
}

/** Message de la barre d'état après un import réussi. */
export function importSummary(report: ImportReport): string {
  const n = report.counts.objects;
  const base =
    report.mode === 'open'
      ? `« ${report.fileName} » ouvert : ${plural(n, 'objet', 'objets')}`
      : `${plural(n, 'objet importé', 'objets importés')} depuis « ${report.fileName} »`;
  const w = report.warnings.length;
  return w > 0 ? `${base}, ${plural(w, 'avertissement', 'avertissements')} (voir le rapport d'import)` : base;
}

/** Le rapport mérite d'être montré : avertissements, ou Blender absent / en échec alors qu'il aurait servi. */
function reportWorthShowing(report: ImportReport): boolean {
  return report.warnings.length > 0 || (report.blender !== null && report.blender.status !== 'used');
}

/** Message d'échec d'un import, complété par ce qui est arrivé du côté de Blender. */
function importFailure(src: SourceFile, err: unknown, trace: BlenderTrace): string {
  const msg = errorMessage(err);
  let text = msg.includes(src.name) ? msg : `Import de « ${src.name} » impossible : ${msg}`;
  if (trace.status === 'failed') text += `. Blender${trace.version ? ` ${trace.version}` : ''} n'a pas pu prendre le relais : ${trace.error}`;
  else if (trace.status === 'missing') text += '. Blender non trouvé : installez Blender pour que CoForge lui fasse convertir ce fichier.';
  return text;
}

/**
 * Documents que `setDoc` ne doit pas détruire quand il les remplace : pendant l'ouverture d'un
 * fichier 3D, la scène précédente est gardée intacte (historique compris) pour y revenir si
 * l'import échoue.
 */
const retainedDocs = new Set<SceneDoc>();

export function isDocRetained(doc: SceneDoc): boolean {
  return retainedDocs.has(doc);
}

/** Scène vide (réglages par défaut, aucun objet) qui recevra le contenu d'un fichier 3D. */
function emptyScene(name: string): SceneDoc {
  const doc = SceneDoc.createNew(name);
  doc.transact(() => {
    for (const id of doc.objectIds()) doc.removeObject(id);
    for (const id of doc.materialIds()) doc.removeMaterial(id);
  });
  doc.clearHistory();
  return doc;
}

/**
 * Import d'un fichier 3D par le viewport (`importScene`), en mode ajout ou ouverture.
 *
 * Pendant tout l'import l'état « occupé » est affiché (lecture, puis éventuelle évaluation par
 * Blender, jusqu'à 3 min) : l'interface reste animée mais ses entrées sont suspendues, et un
 * second import est refusé. Ajout : une seule étape d'annulation ; en cas d'erreur tout est
 * défait (`cancelOp`). Ouverture : la scène précédente est rétablie telle quelle en cas d'erreur.
 */
async function runImport(src: SourceFile, mode: 'append' | 'open'): Promise<boolean> {
  if (refuseWhileBusy()) return false;
  const app = getApp();
  // Une opération modale en cours (déplacement…) est validée : elle ne doit pas se mêler à l'import.
  if (app.ops.modalActive) app.ops.endModal(true);
  const busyText = `${mode === 'open' ? 'Ouverture' : 'Import'} de « ${src.name} »…`;
  setBusy(busyText);
  const trace = newTrace();
  try {
    await nextPaint();
    const { detectFormat } = await engineImport();
    const buffer = toArrayBuffer(src.data);
    const options: ImportOptions = { mode, ...(detectFormat(src.name, buffer) === 'blend' ? blenderOptions(src, trace, busyText) : {}) };
    const shared = store.getState().session.status !== 'offline';

    let result: ImportResult;
    if (mode === 'open') {
      const opened = await importAsNewScene(src, buffer, options, trace);
      if (!opened) return false;
      result = opened;
    } else {
      const doc = app.doc;
      doc.beginOp();
      try {
        result = await app.viewport.importScene(src.name, buffer, options);
        doc.endOp();
      } catch (err) {
        doc.cancelOp();
        toast(importFailure(src, err, trace), 'error');
        return false;
      }
      // Sélection des objets importés et cadrage (mode objet ; le document a pu être remplacé entre-temps).
      if (app.doc === doc && store.getState().mode === 'object') {
        setSelection(result.objectIds.filter((id) => doc.hasObject(id)));
        frame(() => app.viewport.frameSelection?.());
      }
    }

    const report = buildImportReport(src.name, mode, result, trace, shared);
    toast(importSummary(report));
    if (reportWorthShowing(report)) store.setState({ importReport: report, dialog: 'import_report', popup: null });
    return true;
  } catch (err) {
    toast(importFailure(src, err, trace), 'error');
    return false;
  } finally {
    setBusy(null);
  }
}

/** Cadrage de la vue : accessoire, ne doit jamais faire échouer un import réussi. */
function frame(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error(err);
  }
}

/**
 * Ouvre un fichier 3D comme nouvelle scène : scène vide au nom du fichier, puis import en mode
 * « ouvrir » (nom de la scène d'origine, monde, rendu et caméra active repris). `filePath`
 * reste null : Enregistrer proposera un .coforge. Renvoie null (scène précédente rétablie,
 * erreur affichée) si l'import échoue.
 */
async function importAsNewScene(src: SourceFile, buffer: ArrayBuffer, options: ImportOptions, trace: BlenderTrace): Promise<ImportResult | null> {
  const app = getApp();
  const previous = app.doc;
  const before = store.getState();
  const doc = emptyScene(stem(src.name));
  retainedDocs.add(previous);
  let restored = false;
  try {
    app.setDoc(doc, { filePath: null });
    let result: ImportResult;
    try {
      result = await app.viewport.importScene(src.name, buffer, { ...options, mode: 'open' });
    } catch (err) {
      if (app.doc === doc) {
        app.setDoc(previous, { filePath: before.filePath });
        store.setState({
          dirty: before.dirty,
          selection: new Set([...before.selection].filter((id) => previous.hasObject(id))),
          activeId: before.activeId && previous.hasObject(before.activeId) ? before.activeId : null,
        });
        restored = true;
      }
      toast(importFailure(src, err, trace), 'error');
      return null;
    }
    if (app.doc === doc) {
      // Le contenu du fichier est l'état initial de la scène : ni annulable, ni « modifié ».
      doc.clearHistory();
      store.setState({ dirty: false });
      frame(() => app.viewport.frameAll?.());
    }
    return result;
  } finally {
    retainedDocs.delete(previous);
    // La scène précédente n'est plus affichée et n'a pas été rétablie : elle peut être libérée.
    if (!restored && app.doc !== previous) setTimeout(() => previous.destroy(), 0);
  }
}

// ------------------------------------------------------------------ glisser-déposer

/** Tri des fichiers déposés : la première scène CoForge l'emporte, sinon les fichiers 3D reconnus. */
export function classifyDropped<T extends { name: string }>(files: T[], isImportable: (file: T) => boolean): { scene: T | null; imports: T[]; unknown: T[] } {
  const scene = files.find((f) => extensionOf(f.name) === FILE_EXTENSION) ?? null;
  const rest = files.filter((f) => f !== scene && extensionOf(f.name) !== FILE_EXTENSION);
  return { scene, imports: rest.filter(isImportable), unknown: rest.filter((f) => !isImportable(f)) };
}

/**
 * Fichiers déposés sur la fenêtre : un .coforge est ouvert (avec la confirmation habituelle),
 * les fichiers 3D sont importés l'un après l'autre dans la scène courante.
 */
export async function openDroppedFiles(files: SourceFile[]): Promise<void> {
  if (files.length === 0 || refuseWhileBusy()) return;
  const { detectFormat } = await engineImport();
  const { scene, imports, unknown } = classifyDropped(files, (f) => detectFormat(f.name, toArrayBuffer(f.data)) !== null);
  if (scene) {
    if (!(await confirmDiscard(`Ouvrir « ${scene.name} »`))) return;
    await openSource(scene);
    return;
  }
  if (imports.length === 0) {
    toast(`Format non pris en charge : ${unknown.map((f) => f.name).join(', ')}`, 'error');
    return;
  }
  for (const file of imports) {
    if (!(await runImport(file, 'append'))) return;
  }
}

/** Lit des fichiers déposés (objets File du navigateur) ; leur chemin n'est connu que dans l'application. */
async function readDropped(files: File[]): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  for (const file of files) {
    out.push({ name: file.name, data: new Uint8Array(await file.arrayBuffer()), path: platform.pathForFile(file) });
  }
  return out;
}

/**
 * Branche le glisser-déposer de fichiers sur la fenêtre ; renvoie la fonction de débranchement.
 * Pendant le survol, `store.dropActive` est vrai (l'interface affiche une zone de dépôt). Sans
 * ces écouteurs, un fichier lâché sur la fenêtre remplacerait la page de l'application.
 */
export function installFileDrop(target: Window = window): () => void {
  const carriesFiles = (e: DragEvent): boolean => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
  // Le survol dure tant que des `dragover` arrivent (au moins toutes les 550 ms d'après la norme) :
  // ce délai de garde couvre les sorties de fenêtre que `dragleave` ne signale pas nettement.
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const setActive = (active: boolean): void => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = active ? setTimeout(() => setActive(false), 900) : null;
    if (store.getState().dropActive !== active) store.setState({ dropActive: active });
  };
  const onOver = (e: DragEvent): void => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    const busy = store.getState().busy !== null;
    if (e.dataTransfer) e.dataTransfer.dropEffect = busy ? 'none' : 'copy';
    setActive(!busy);
  };
  const onLeave = (e: DragEvent): void => {
    // Le pointeur a quitté la fenêtre (et pas seulement un élément de l'interface).
    const outside = e.clientX <= 0 || e.clientY <= 0 || e.clientX >= target.innerWidth || e.clientY >= target.innerHeight;
    if (e.relatedTarget === null && outside) setActive(false);
  };
  const onDrop = (e: DragEvent): void => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    setActive(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0 || refuseWhileBusy()) return;
    readDropped(files)
      .then(openDroppedFiles)
      .catch((err) => toast(`Lecture du fichier déposé impossible : ${errorMessage(err)}`, 'error'));
  };
  const onEnd = (): void => setActive(false);
  target.addEventListener('dragenter', onOver);
  target.addEventListener('dragover', onOver);
  target.addEventListener('dragleave', onLeave);
  target.addEventListener('drop', onDrop);
  target.addEventListener('dragend', onEnd);
  target.addEventListener('blur', onEnd);
  return () => {
    setActive(false);
    target.removeEventListener('dragenter', onOver);
    target.removeEventListener('dragover', onOver);
    target.removeEventListener('dragleave', onLeave);
    target.removeEventListener('drop', onDrop);
    target.removeEventListener('dragend', onEnd);
    target.removeEventListener('blur', onEnd);
  };
}

// ------------------------------------------------------------------ export

export async function exportScene(format: 'glb' | 'obj'): Promise<void> {
  const app = getApp();
  const sceneName = app.doc.getScene().name.replace(/[<>:"/\\|?*]/g, '_') || 'scene';
  const selectionOnly = false;
  try {
    let data: Uint8Array;
    if (format === 'glb') data = new Uint8Array(await app.viewport.exportGLB({ selectionOnly }));
    else data = new TextEncoder().encode(app.viewport.exportOBJ({ selectionOnly }));
    const filters: FileFilter[] = format === 'glb' ? [{ name: 'glTF binaire', extensions: ['glb'] }] : [{ name: 'Wavefront OBJ', extensions: ['obj'] }];
    const path = await platform.saveFile(data, null, `${sceneName}.${format}`, filters);
    if (path) toast(`Exporté : ${baseName(path)}`);
  } catch (err) {
    toast(`Export impossible : ${(err as Error).message}`, 'error');
  }
}

/** Enregistre l'image du dernier rendu (store.render.imageUrl) en PNG. */
export async function saveRenderImage(): Promise<void> {
  const url = store.getState().render.imageUrl;
  if (!url) {
    toast('Aucun rendu à enregistrer', 'error');
    return;
  }
  let composited: string | null = null;
  try {
    const comp = getApp().doc.getCompositor();
    if (comp.use) composited = await compositeImageUrl(url, comp);
    const bytes = new Uint8Array(await (await fetch(composited ?? url)).arrayBuffer());
    const sceneName = getApp().doc.getScene().name.replace(/[<>:"/\\|?*]/g, '_') || 'rendu';
    const path = await platform.saveFile(bytes, null, `${sceneName}.png`, [{ name: 'Image PNG', extensions: ['png'] }]);
    if (path) toast(`Image enregistrée : ${baseName(path)}${composited ? ' (compositing appliqué)' : ''}`);
  } catch (err) {
    toast(`Échec de l'enregistrement : ${(err as Error).message}`, 'error');
  } finally {
    if (composited) URL.revokeObjectURL(composited);
  }
}
