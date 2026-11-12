/**
 * Pont avec le processus principal Electron.
 *
 * Le preload (electron/preload.ts) expose `window.coforge` conforme à
 * `NativeBridge`. Dans un simple navigateur (npm run dev:web), `window.coforge`
 * n'existe pas : `platform` fournit alors des replis (téléchargement, sélecteur
 * de fichier HTML) ; l'hébergement de session et le pont Blender sont indisponibles.
 */

import type { BlendEvalRequest, BlendEvalResult } from '../engine/io/types';

export interface HostOptions {
  port: number;
  password?: string;
}

export interface HostInfo {
  port: number;
  /** URLs WebSocket joignables par les invités, la plus probable (LAN) d'abord. Ex. ['ws://192.168.1.20:4455']. */
  addresses: string[];
}

export interface OpenedFile {
  /** Chemin complet (Electron) ou simple nom de fichier (navigateur). */
  path: string;
  name: string;
  data: Uint8Array;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

/**
 * Fichier .blend confié au Blender installé : par son chemin quand il est connu (textures et
 * bibliothèques liées par chemin relatif retrouvées), sinon par ses octets.
 */
export interface BlendSource {
  path?: string;
  data?: Uint8Array;
}

export interface BlenderInfo {
  /** Ex. « 5.1.0 ». */
  version: string;
}

/** Résultat d'évaluation du pont, avec ses remarques (en français) pour le rapport d'import. */
export interface BlenderEvalResult extends BlendEvalResult {
  notes?: string[];
}

/**
 * État des mises à jour automatiques (releases GitHub) :
 * - `disabled` : hors application installée (développement, navigateur) ;
 * - `downloading` : une version plus récente se télécharge en tâche de fond ;
 * - `ready` : elle est téléchargée, et s'installera à la fermeture (ou tout de suite sur demande).
 * `manual` : réponse à une vérification demandée par l'utilisateur (à signaler même si rien n'est trouvé).
 */
export interface UpdateStatus {
  state: 'disabled' | 'idle' | 'checking' | 'none' | 'downloading' | 'ready' | 'error';
  version?: string;
  percent?: number;
  error?: string;
  manual?: boolean;
}

/** API exposée par le preload Electron sur `window.coforge`. */
export interface NativeBridge {
  readonly version: string;
  /** Démarre le serveur de collaboration embarqué. Rejette (message en français) si le port est occupé. */
  hostStart(opts: HostOptions): Promise<HostInfo>;
  hostStop(): Promise<void>;
  /**
   * Boîte « Ouvrir » native ; null si annulé. Chaque filtre devient une entrée de la liste des
   * types de fichier (le premier est présélectionné). `title` : titre de la boîte.
   */
  openFile(filters: FileFilter[], title?: string): Promise<OpenedFile | null>;
  /**
   * Écrit un fichier. Si `path` est null, ouvre la boîte « Enregistrer sous »
   * avec `suggestedName`. Renvoie le chemin écrit, ou null si annulé.
   */
  saveFile(data: Uint8Array, path: string | null, suggestedName: string, filters: FileFilter[]): Promise<string | null>;
  /** Fichier .coforge passé au lancement (double-clic dans l'Explorateur), ou null. À appeler une fois au démarrage. */
  getStartupFile(): Promise<OpenedFile | null>;
  /** Chemin complet d'un fichier déposé sur la fenêtre (glisser-déposer), ou null s'il n'en a pas. */
  pathForFile(file: File): string | null;
  /** Blender installé sur la machine (2.93 ou plus récent), ou null. */
  blenderInfo(): Promise<BlenderInfo | null>;
  /**
   * Fait évaluer un .blend par Blender (jusqu'à 3 min) : maillage final des objets et couleur
   * moyenne des textures des matériaux demandés. null si aucun Blender n'est installé ; rejette
   * (message en français) si la source est invalide ou si Blender échoue.
   */
  blenderEvaluate(source: BlendSource, request: BlendEvalRequest): Promise<BlenderEvalResult | null>;
  /** Fait convertir un .blend entier en glTF binaire (.glb) par Blender. Mêmes conventions. */
  blenderConvert(source: BlendSource): Promise<Uint8Array | null>;
  /** Titre de la fenêtre. */
  setTitle(title: string): void;
  /**
   * Le processus principal demande confirmation avant de fermer la fenêtre :
   * il appelle ce callback, qui renvoie true si la fermeture est autorisée.
   */
  onCloseRequest(cb: () => boolean | Promise<boolean>): void;
  /** État courant des mises à jour. */
  updateStatus?(): Promise<UpdateStatus>;
  /** Vérifie tout de suite s'il existe une version plus récente. */
  checkForUpdates?(): Promise<UpdateStatus>;
  /** Ferme l'application (avec la confirmation habituelle) et installe la mise à jour téléchargée. */
  installUpdate?(): void;
  /** Appelé à chaque changement d'état des mises à jour. */
  onUpdateStatus?(cb: (status: UpdateStatus) => void): void;
}

declare global {
  interface Window {
    coforge?: NativeBridge;
  }
}

function pickFileInBrowser(filters: FileFilter[]): Promise<OpenedFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    // Le sélecteur HTML n'a qu'une liste d'extensions : la réunion de tous les filtres.
    input.accept = [...new Set(filters.flatMap((f) => f.extensions.map((e) => `.${e}`)))].join(',');
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      resolve({ path: file.name, name: file.name, data: new Uint8Array(await file.arrayBuffer()) });
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

function downloadInBrowser(data: Uint8Array, name: string): void {
  const blob = new Blob([data as BlobPart]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** `window.coforge` s'il existe (absent dans un navigateur, et hors de tout DOM). */
function native(): NativeBridge | undefined {
  return typeof window !== 'undefined' ? window.coforge : undefined;
}

export const platform = {
  get isElectron(): boolean {
    return !!native();
  },
  get version(): string {
    return native()?.version ?? 'web';
  },
  hostStart(opts: HostOptions): Promise<HostInfo> {
    const bridge = native();
    if (!bridge) return Promise.reject(new Error("L'hébergement n'est disponible que dans l'application Windows."));
    return bridge.hostStart(opts);
  },
  hostStop(): Promise<void> {
    return native()?.hostStop() ?? Promise.resolve();
  },
  /** Boîte de choix d'un fichier ; plusieurs filtres possibles (formats 3D, scène CoForge…). */
  openFile(filters: FileFilter[], title?: string): Promise<OpenedFile | null> {
    const bridge = native();
    return bridge ? bridge.openFile(filters, title) : pickFileInBrowser(filters);
  },
  async saveFile(data: Uint8Array, path: string | null, suggestedName: string, filters: FileFilter[]): Promise<string | null> {
    const bridge = native();
    if (bridge) return bridge.saveFile(data, path, suggestedName, filters);
    downloadInBrowser(data, suggestedName);
    return suggestedName;
  },
  getStartupFile(): Promise<OpenedFile | null> {
    return native()?.getStartupFile() ?? Promise.resolve(null);
  },
  /** Chemin complet d'un fichier déposé sur la fenêtre ; null dans un navigateur. */
  pathForFile(file: File): string | null {
    return native()?.pathForFile?.(file) ?? null;
  },
  /** Blender installé sur la machine ; null s'il n'y en a pas, et toujours null dans un navigateur. */
  blenderInfo(): Promise<BlenderInfo | null> {
    return native()?.blenderInfo?.() ?? Promise.resolve(null);
  },
  /** Évaluation d'un .blend par Blender ; null sans Electron ou sans Blender installé. */
  blenderEvaluate(source: BlendSource, request: BlendEvalRequest): Promise<BlenderEvalResult | null> {
    return native()?.blenderEvaluate?.(source, request) ?? Promise.resolve(null);
  },
  /** Conversion d'un .blend en .glb par Blender ; null sans Electron ou sans Blender installé. */
  blenderConvert(source: BlendSource): Promise<Uint8Array | null> {
    return native()?.blenderConvert?.(source) ?? Promise.resolve(null);
  },
  setTitle(title: string): void {
    const bridge = native();
    if (bridge) bridge.setTitle(title);
    else if (typeof document !== 'undefined') document.title = title;
  },
  onCloseRequest(cb: () => boolean | Promise<boolean>): void {
    native()?.onCloseRequest(cb);
  },
  updateStatus(): Promise<UpdateStatus> {
    return native()?.updateStatus?.() ?? Promise.resolve({ state: 'disabled' });
  },
  checkForUpdates(): Promise<UpdateStatus> {
    return native()?.checkForUpdates?.() ?? Promise.resolve({ state: 'disabled' });
  },
  installUpdate(): void {
    native()?.installUpdate?.();
  },
  onUpdateStatus(cb: (status: UpdateStatus) => void): void {
    native()?.onUpdateStatus?.(cb);
  },
};

/** Port par défaut du serveur de collaboration. */
export const DEFAULT_PORT = 4455;
