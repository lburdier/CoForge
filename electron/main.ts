import { app, BrowserWindow, dialog, ipcMain, Menu, net, shell } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { listShareAddresses } from '../server/addresses';
import { CollabServer } from '../server/CollabServer';
import type { BlenderEvalResult, BlenderInfo, FileFilter, HostInfo, HostOptions, OpenedFile } from '../src/app/platform';
import type { BlendEvalRequest } from '../src/engine/io/types';
import { convertBlendBytesToGLB, convertBlendToGLB, evaluateBlend, evaluateBlendBytes, findBlender, shutdownBlenderBridge } from './blenderBridge';
import { INVITE_SCHEME, parseInviteLink } from '../src/net/invite';
import { isValidRoomName } from '../src/net/protocol';
import { IPC } from './ipc';
import { checkForUpdates, currentUpdateStatus, initUpdater, installUpdateNow } from './updater';

/**
 * Processus principal : fenêtre unique, fichiers, serveur de session embarqué.
 * Bundlé en dist-electron/main.cjs (le renderer est dans dist/, à côté).
 */

const DEV_URL = app.isPackaged ? undefined : process.env.VITE_DEV_SERVER_URL || undefined;
/** Délai accordé au renderer pour accuser réception d'une demande de fermeture. */
const CLOSE_TIMEOUT_MS = 3000;

let mainWindow: BrowserWindow | null = null;
let server: CollabServer | null = null;

// ------------------------------------------------------------------ liens d'invitation coforge://

/** Lien d'invitation reçu du système et pas encore remis au renderer. */
let pendingInviteLink: string | null = null;

/** Premier argument qui est un lien d'invitation VALIDE (les autres sont ignorés). */
function findInviteLink(argv: string[]): string | null {
  for (const arg of argv.slice(1)) {
    if (typeof arg !== 'string' || arg.length > 2048 || !arg.toLowerCase().startsWith(`${INVITE_SCHEME}:`)) continue;
    if (parseInviteLink(arg).ok) return arg;
    console.warn('Lien d’invitation invalide ignoré');
  }
  return null;
}

/** Garde le lien et prévient la fenêtre (qui viendra le chercher, même si elle n'est pas encore prête). */
function receiveInviteLink(link: string): void {
  pendingInviteLink = link;
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (!win.webContents.isLoading()) win.webContents.send(IPC.inviteLink);
}

/** Associe coforge:// à CoForge (l'installateur le fait aussi ; en développement, seulement sur demande). */
function registerProtocol(): void {
  try {
    if (app.isPackaged) app.setAsDefaultProtocolClient(INVITE_SCHEME);
    else if (process.env.COFORGE_REGISTER_PROTOCOL === '1' && process.argv[1]) app.setAsDefaultProtocolClient(INVITE_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  } catch (err) {
    console.error(`Enregistrement du protocole coforge:// impossible : ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Adresse IP publique, demandée à api.ipify.org (seulement quand l'utilisateur le demande). */
async function fetchPublicAddress(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await net.fetch('https://api.ipify.org/?format=text', { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) fail(`Service d'adresse publique indisponible (HTTP ${res.status})`);
    const text = (await res.text()).trim();
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(text) && !/^[0-9a-f:]{2,45}$/i.test(text)) fail('Réponse inattendue du service d’adresse publique');
    return text;
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') fail('Le service d’adresse publique ne répond pas');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ fermeture concertée

/** Le renderer a enregistré un callback `onCloseRequest`. */
let closeRegistered = false;
/** La fermeture a été autorisée : l'événement `close` suivant passe. */
let closeAllowed = false;
let closeRequestId = 0;
let closePending: { id: number; timer: ReturnType<typeof setTimeout> | null } | null = null;
/** « Redémarrer et mettre à jour » : une fois la fermeture acceptée, l'installateur prend le relais. */
let installAfterClose = false;

function clearClosePending(): void {
  if (closePending?.timer) clearTimeout(closePending.timer);
  closePending = null;
}

function forceClose(): void {
  clearClosePending();
  closeAllowed = true;
  if (installAfterClose) {
    installAfterClose = false;
    installUpdateNow();
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
}

function requestClose(win: BrowserWindow): void {
  if (closePending) return; // une demande est déjà en cours (ex. confirmation affichée)
  const contents = win.webContents;
  if (!closeRegistered || contents.isDestroyed() || contents.isCrashed()) {
    forceClose();
    return;
  }
  const id = ++closeRequestId;
  // Sans accusé de réception sous 3 s, le renderer est considéré comme bloqué : on ferme.
  closePending = { id, timer: setTimeout(forceClose, CLOSE_TIMEOUT_MS) };
  contents.send(IPC.closeRequest, id);
}

// ------------------------------------------------------------------ fichiers

function readOpenedFile(filePath: string): OpenedFile {
  const data = fs.readFileSync(filePath);
  return { path: filePath, name: path.basename(filePath), data: new Uint8Array(data) };
}

function findStartupFile(argv: string[]): string | null {
  for (const arg of argv.slice(1)) {
    if (!/\.coforge$/i.test(arg)) continue;
    const full = path.resolve(arg);
    try {
      if (fs.statSync(full).isFile()) return full;
    } catch {
      /* pas un fichier : argument ignoré */
    }
  }
  return null;
}

/** Écriture atomique : un plantage en cours d'enregistrement ne détruit pas le fichier existant. */
async function writeFileAtomic(filePath: string, data: Uint8Array): Promise<void> {
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.promises.writeFile(tmp, data);
    await fs.promises.rename(tmp, filePath);
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
}

function cleanFilters(filters: unknown): FileFilter[] {
  if (!Array.isArray(filters)) return [];
  return filters
    .filter((f) => f && typeof f.name === 'string' && Array.isArray(f.extensions))
    .map((f) => ({ name: f.name as string, extensions: (f.extensions as unknown[]).filter((e): e is string => typeof e === 'string') }));
}

/** Les messages d'erreur d'`ipcMain.handle` sont préfixés par Electron ; on garde un texte français lisible. */
function fail(message: string): never {
  throw new Error(message);
}

// ------------------------------------------------------------------ pont Blender : validation des arguments

/** Nombre maximal de noms dans une requête d'évaluation, et longueur maximale d'un nom. */
const MAX_NAMES = 100_000;
const MAX_NAME_LENGTH = 255;

type BlendInput = { path: string } | { data: Uint8Array };

/** Signature d'un .blend : en clair (« BLENDER »), compressé zstd (Blender 3.0+) ou gzip (avant). */
function looksLikeBlend(data: Uint8Array): boolean {
  if (data.byteLength < 12) return false;
  if (String.fromCharCode(...data.subarray(0, 7)) === 'BLENDER') return true;
  if (data[0] === 0x28 && data[1] === 0xb5 && data[2] === 0x2f && data[3] === 0xfd) return true;
  return data[0] === 0x1f && data[1] === 0x8b;
}

/**
 * Le renderer ne peut faire ouvrir par Blender qu'un fichier existant nommé « *.blend »
 * (chemin absolu), ou des octets qui ont la signature d'un .blend.
 */
function blendInput(source: unknown): BlendInput {
  if (!source || typeof source !== 'object') fail('Source .blend invalide');
  const s = source as { path?: unknown; data?: unknown };
  if (s.path !== undefined && s.path !== null) {
    if (typeof s.path !== 'string' || !path.isAbsolute(s.path) || !/\.blend$/i.test(s.path)) fail('Le chemin doit désigner un fichier .blend');
    let isFile = false;
    try {
      isFile = fs.statSync(s.path).isFile();
    } catch {
      /* chemin inexistant */
    }
    if (!isFile) fail(`Fichier introuvable : ${s.path}`);
    return { path: s.path };
  }
  if (!(s.data instanceof Uint8Array) || s.data.byteLength === 0) fail('Source .blend invalide : chemin ou octets attendus');
  if (!looksLikeBlend(s.data)) fail('Ces données ne sont pas un fichier .blend');
  return { data: s.data };
}

function nameList(value: unknown, what: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_NAMES) fail(`Requête d'évaluation invalide (${what})`);
  for (const name of value) {
    if (typeof name !== 'string' || name.length > MAX_NAME_LENGTH) fail(`Requête d'évaluation invalide (${what})`);
  }
  return value as string[];
}

function evalRequest(request: unknown): BlendEvalRequest {
  if (!request || typeof request !== 'object') fail("Requête d'évaluation invalide");
  const r = request as { objects?: unknown; materials?: unknown };
  return { objects: nameList(r.objects, 'objets'), materials: nameList(r.materials, 'matériaux') };
}

// ------------------------------------------------------------------ IPC

function registerIpc(): void {
  ipcMain.handle(IPC.hostStart, async (_event, opts: HostOptions): Promise<HostInfo> => {
    const port = Number(opts?.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail('Numéro de port invalide (1 à 65535)');
    const room = typeof opts?.room === 'string' ? opts.room.trim() : '';
    if (room !== '' && !isValidRoomName(room)) fail('Nom de session invalide');
    const given = typeof opts?.password === 'string' && opts.password !== '' ? opts.password.slice(0, 200) : undefined;
    const access = opts?.access === 'invite' || opts?.access === 'password' || opts?.access === 'open' ? opts.access : given ? 'password' : 'open';
    if (access === 'password' && !given) fail('Indiquez un mot de passe');
    // Sur invitation : mot de passe aléatoire que seul l'hôte utilise ; les invités entrent par jeton.
    const secret = access === 'invite' ? crypto.randomBytes(24).toString('base64url') : undefined;
    const password = access === 'invite' ? secret : access === 'password' ? given : undefined;
    if (server) {
      await server.stop();
      server = null;
    }
    // Serveur embarqué SANS persistance : la room vit en mémoire, l'hôte y apporte sa scène courante.
    const instance = new CollabServer();
    try {
      const started = await instance.start({
        port,
        password,
        rooms: room ? [room] : undefined,
        host: '0.0.0.0',
        log: (message) => console.log(`[serveur] ${message}`),
      });
      server = instance;
      return { port: started.port, addresses: listShareAddresses(started.port), secret };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE') fail(`Le port ${port} est déjà utilisé`);
      if (code === 'EACCES') fail(`Accès refusé au port ${port}`);
      fail(`Impossible de démarrer le serveur : ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  ipcMain.handle(IPC.hostStop, async (): Promise<void> => {
    const instance = server;
    server = null;
    if (instance) await instance.stop();
  });

  ipcMain.handle(IPC.openFile, async (_event, filters: unknown, title: unknown): Promise<OpenedFile | null> => {
    // Plusieurs filtres = plusieurs entrées dans la liste « Type de fichier » de la boîte native.
    const options: Electron.OpenDialogOptions = { properties: ['openFile'], filters: cleanFilters(filters) };
    if (typeof title === 'string' && title !== '') options.title = title.slice(0, 120);
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    try {
      return readOpenedFile(result.filePaths[0]);
    } catch (err) {
      fail(`Lecture impossible : ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  ipcMain.handle(IPC.saveFile, async (_event, data: Uint8Array, filePath: string | null, suggestedName: string, filters: unknown): Promise<string | null> => {
    if (!(data instanceof Uint8Array)) fail('Données à enregistrer invalides');
    let target = typeof filePath === 'string' && filePath !== '' ? filePath : null;
    if (!target) {
      const options: Electron.SaveDialogOptions = {
        defaultPath: path.join(app.getPath('documents'), typeof suggestedName === 'string' && suggestedName ? suggestedName : 'Sans titre'),
        filters: cleanFilters(filters),
      };
      const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return null;
      target = result.filePath;
    }
    try {
      await writeFileAtomic(target, data);
    } catch (err) {
      fail(`Enregistrement impossible : ${err instanceof Error ? err.message : String(err)}`);
    }
    return target;
  });

  ipcMain.handle(IPC.getStartupFile, async (): Promise<OpenedFile | null> => {
    const file = findStartupFile(process.argv);
    if (!file) return null;
    try {
      return readOpenedFile(file);
    } catch {
      return null;
    }
  });

  // Pont Blender : null quand aucun Blender n'est installé ; erreur en français si Blender échoue.
  ipcMain.handle(IPC.blenderInfo, async (): Promise<BlenderInfo | null> => {
    const blender = await findBlender();
    return blender ? { version: blender.version } : null;
  });

  ipcMain.handle(IPC.blenderEvaluate, async (_event, source: unknown, request: unknown): Promise<BlenderEvalResult | null> => {
    const input = blendInput(source);
    const req = evalRequest(request);
    if (!(await findBlender())) return null;
    return 'path' in input ? evaluateBlend(input.path, req) : evaluateBlendBytes(input.data, req);
  });

  ipcMain.handle(IPC.blenderConvert, async (_event, source: unknown): Promise<Uint8Array | null> => {
    const input = blendInput(source);
    if (!(await findBlender())) return null;
    return 'path' in input ? convertBlendToGLB(input.path) : convertBlendBytesToGLB(input.data);
  });

  ipcMain.on(IPC.setTitle, (event, title: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && typeof title === 'string') win.setTitle(title);
  });

  ipcMain.on(IPC.closeRegistered, (event) => {
    if (mainWindow && event.sender === mainWindow.webContents) closeRegistered = true;
  });
  ipcMain.on(IPC.closeAck, (_event, id: number) => {
    // Le renderer est vivant et traite la demande (éventuelle confirmation à l'écran) : on attend sa réponse.
    if (closePending && closePending.id === id && closePending.timer) {
      clearTimeout(closePending.timer);
      closePending.timer = null;
    }
  });
  ipcMain.on(IPC.closeResponse, (_event, id: number, allowed: boolean) => {
    if (!closePending || closePending.id !== id) return;
    clearClosePending();
    if (allowed) forceClose();
    else installAfterClose = false;
  });

  ipcMain.handle(IPC.takeInviteLink, (event): string | null => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return null;
    const link = pendingInviteLink;
    pendingInviteLink = null;
    return link;
  });
  ipcMain.handle(IPC.publicAddress, () => fetchPublicAddress());

  ipcMain.handle(IPC.updateGetStatus, () => currentUpdateStatus());
  ipcMain.handle(IPC.updateCheck, () => checkForUpdates(true));
  ipcMain.on(IPC.updateInstall, () => {
    if (currentUpdateStatus().state !== 'ready') return;
    installAfterClose = true;
    if (mainWindow && !mainWindow.isDestroyed()) requestClose(mainWindow);
    else forceClose();
  });
}

// ------------------------------------------------------------------ fenêtre

function isAppUrl(url: string): boolean {
  if (DEV_URL) {
    try {
      return new URL(url).origin === new URL(DEV_URL).origin;
    } catch {
      return false;
    }
  }
  return url.startsWith('file:');
}

function openExternal(url: string): void {
  if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url);
}

function createWindow(): void {
  const iconPath = path.join(__dirname, 'icon.png');
  const win = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#1d1d1d',
    title: 'CoForge',
    show: false,
    autoHideMenuBar: true,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Le preload n'utilise que contextBridge/ipcRenderer (tout le reste est bundlé) : le bac à sable reste actif.
      sandbox: true,
      // Démarrage : pas de dictionnaire orthographique à charger ; cache de code V8 dès le
      // premier lancement (le bundle est gros : ~2 Mo).
      spellcheck: false,
      v8CacheOptions: 'bypassHeatCheck',
    },
  });
  mainWindow = win;
  closeRegistered = false;
  closeAllowed = false;
  win.setMenu(null);

  win.once('ready-to-show', () => win.show());
  // Si la page ne se charge pas (build absent), la fenêtre doit quand même apparaître.
  win.webContents.once('did-fail-load', () => {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  });

  // Le titre est piloté par `setTitle`, pas par la balise <title> de la page.
  win.on('page-title-updated', (event) => event.preventDefault());

  win.on('close', (event) => {
    if (closeAllowed) return;
    event.preventDefault();
    requestClose(win);
  });
  win.on('closed', () => {
    clearClosePending();
    if (mainWindow === win) mainWindow = null;
  });
  // Renderer bloqué ou planté pendant une demande de fermeture : on ferme.
  win.on('unresponsive', () => {
    if (closePending) forceClose();
  });
  win.webContents.on('render-process-gone', () => {
    closeRegistered = false;
    if (closePending) forceClose();
  });
  // Page rechargée : le callback de fermeture de l'ancienne page n'existe plus.
  win.webContents.on('did-navigate', () => {
    closeRegistered = false;
    clearClosePending();
  });

  // Liens externes : navigateur du système, jamais une nouvelle fenêtre Electron.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternal(url);
  });

  // F12 appartient à l'application (rendu) : aucun raccourci natif ne l'intercepte puisqu'il n'y a pas de menu.
  // Outils de développement : Ctrl+Maj+I, en développement uniquement.
  win.webContents.on('before-input-event', (event, input) => {
    if (DEV_URL && input.type === 'keyDown' && input.control && input.shift && !input.alt && input.key.toLowerCase() === 'i') {
      event.preventDefault();
      win.webContents.toggleDevTools();
    }
  });

  const loading = DEV_URL ? win.loadURL(DEV_URL) : win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  loading.catch((err) => console.error(`Chargement de l'interface impossible : ${err instanceof Error ? err.message : String(err)}`));
}

// ------------------------------------------------------------------ cycle de vie

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Portables à double carte graphique : le viewport 3D et le path tracing veulent la carte dédiée.
  app.commandLine.appendSwitch('force_high_performance_gpu');
  // Accélération matérielle même sur un pilote listé « à problème » par Chromium (sinon WebGL
  // retombe sur le rendu logiciel, inutilisable pour la 3D), et rastérisation de l'interface sur GPU.
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-gpu-rasterization');

  // Lien coforge:// passé au premier lancement.
  pendingInviteLink = findInviteLink(process.argv);

  // Une seconde instance (double-clic, lien d'invitation cliqué) : la fenêtre ouverte prend le relais.
  app.on('second-instance', (_event, argv) => {
    const link = findInviteLink(argv);
    if (link) {
      receiveInviteLink(link);
      return;
    }
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  // macOS : liens reçus par événement.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (parseInviteLink(url).ok) receiveInviteLink(url);
  });

  // Une erreur imprévue (socket, serveur embarqué) est journalisée sans faire tomber la session.
  process.on('uncaughtException', (err) => console.error(`Erreur non gérée : ${err.stack ?? err.message}`));
  process.on('unhandledRejection', (reason) => console.error(`Promesse rejetée non gérée : ${String(reason)}`));

  app.on('window-all-closed', () => app.quit());

  // Un Blender encore au travail (import en cours) ne survit pas à l'application.
  app.on('will-quit', () => shutdownBlenderBridge());

  // Arrêt du serveur embarqué avant de quitter.
  let serverStopped = false;
  app.on('will-quit', (event) => {
    if (!server || serverStopped) return;
    event.preventDefault();
    const instance = server;
    server = null;
    const done = (): void => {
      serverStopped = true;
      app.quit();
    };
    const guard = setTimeout(done, 5000);
    instance
      .stop()
      .catch((err) => console.error(`Arrêt du serveur incomplet : ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        clearTimeout(guard);
        done();
      });
  });

  void app.whenReady().then(() => {
    Menu.setApplicationMenu(null); // les menus sont dans l'interface web
    registerIpc();
    registerProtocol();
    createWindow();
    initUpdater(() => mainWindow, IPC.updateStatus);
  });
}
