import { contextBridge, ipcRenderer, webUtils } from 'electron';
import pkg from '../package.json';
import type { BlendSource, BlenderEvalResult, BlenderInfo, FileFilter, HostInfo, HostOptions, NativeBridge, OpenedFile, UpdateStatus } from '../src/app/platform';
import type { BlendEvalRequest } from '../src/engine/io/types';
import { IPC } from './ipc';

/**
 * Preload : expose `window.coforge` (contrat NativeBridge de src/app/platform.ts).
 * Les Uint8Array traversent l'IPC par clonage structuré et arrivent intacts.
 */

let closeCallback: (() => boolean | Promise<boolean>) | null = null;

ipcRenderer.on(IPC.closeRequest, (_event, requestId: number) => {
  const cb = closeCallback;
  if (!cb) {
    ipcRenderer.send(IPC.closeResponse, requestId, true);
    return;
  }
  ipcRenderer.send(IPC.closeAck, requestId);
  Promise.resolve()
    .then(() => cb())
    .then(
      (allowed) => ipcRenderer.send(IPC.closeResponse, requestId, allowed !== false),
      // Le callback a échoué : on ne retient pas l'utilisateur prisonnier de la fenêtre.
      () => ipcRenderer.send(IPC.closeResponse, requestId, true),
    );
});

/**
 * `ipcRenderer.invoke` préfixe les erreurs (« Error invoking remote method '…': Error: … ») :
 * on ne garde que le message d'origine, en français, affichable tel quel.
 */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(raw.replace(/^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/, ''));
  }
}

/** Copie dans un Uint8Array « nu » (un Buffer ou une vue partielle ne doit pas embarquer plus que ses octets). */
function plainBytes(data: Uint8Array): Uint8Array {
  return new Uint8Array(data);
}

/** Un .blend est désigné par son chemin quand il est connu, sinon par ses octets (jamais les deux). */
function blendSource(source: BlendSource): BlendSource {
  if (typeof source?.path === 'string' && source.path !== '') return { path: source.path };
  return { data: source?.data instanceof Uint8Array ? plainBytes(source.data) : undefined };
}

const bridge: NativeBridge = {
  version: pkg.version,
  hostStart: (opts: HostOptions): Promise<HostInfo> => invoke(IPC.hostStart, { port: opts.port, password: opts.password, room: opts.room, access: opts.access }),
  hostStop: (): Promise<void> => invoke(IPC.hostStop),
  openFile: async (filters: FileFilter[], title?: string): Promise<OpenedFile | null> => {
    const file = await invoke<OpenedFile | null>(IPC.openFile, filters, title);
    return file ? { path: file.path, name: file.name, data: plainBytes(file.data) } : null;
  },
  saveFile: (data: Uint8Array, path: string | null, suggestedName: string, filters: FileFilter[]): Promise<string | null> =>
    invoke(IPC.saveFile, plainBytes(data), path, suggestedName, filters),
  getStartupFile: async (): Promise<OpenedFile | null> => {
    const file = await invoke<OpenedFile | null>(IPC.getStartupFile);
    return file ? { path: file.path, name: file.name, data: plainBytes(file.data) } : null;
  },
  pathForFile: (file: File): string | null => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
  blenderInfo: (): Promise<BlenderInfo | null> => invoke(IPC.blenderInfo),
  blenderEvaluate: (source: BlendSource, request: BlendEvalRequest): Promise<BlenderEvalResult | null> =>
    invoke(IPC.blenderEvaluate, blendSource(source), { objects: request.objects, materials: request.materials }),
  blenderConvert: async (source: BlendSource): Promise<Uint8Array | null> => {
    const glb = await invoke<Uint8Array | null>(IPC.blenderConvert, blendSource(source));
    return glb ? plainBytes(glb) : null;
  },
  setTitle: (title: string): void => ipcRenderer.send(IPC.setTitle, String(title)),
  onCloseRequest: (cb: () => boolean | Promise<boolean>): void => {
    closeCallback = cb;
    ipcRenderer.send(IPC.closeRegistered);
  },
  updateStatus: (): Promise<UpdateStatus> => invoke(IPC.updateGetStatus),
  checkForUpdates: (): Promise<UpdateStatus> => invoke(IPC.updateCheck),
  installUpdate: (): void => ipcRenderer.send(IPC.updateInstall),
  onUpdateStatus: (cb: (status: UpdateStatus) => void): void => {
    ipcRenderer.removeAllListeners(IPC.updateStatus);
    ipcRenderer.on(IPC.updateStatus, (_event, status: UpdateStatus) => cb(status));
  },
  takeInviteLink: async (): Promise<string | null> => {
    const link = await invoke<unknown>(IPC.takeInviteLink);
    return typeof link === 'string' ? link : null;
  },
  onInviteLink: (cb: () => void): void => {
    ipcRenderer.removeAllListeners(IPC.inviteLink);
    ipcRenderer.on(IPC.inviteLink, () => cb());
  },
  publicAddress: (): Promise<string> => invoke(IPC.publicAddress),
};

contextBridge.exposeInMainWorld('coforge', bridge);
