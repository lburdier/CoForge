import { app, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import electronUpdater from 'electron-updater';
import type { UpdateStatus } from '../src/app/platform';

/**
 * Mises à jour automatiques depuis les releases GitHub (configuration `publish` de
 * electron-builder.yml, copiée par electron-builder dans resources/app-update.yml).
 *
 * - Vérification 10 s après le démarrage, puis toutes les 4 h.
 * - Téléchargement en tâche de fond dès qu'une version plus récente est publiée.
 * - Installation silencieuse à la fermeture de l'application, ou tout de suite sur demande
 *   (« Redémarrer et mettre à jour »), après la confirmation habituelle de fermeture.
 *
 * Inactif en développement (application non empaquetée).
 */

const { autoUpdater } = electronUpdater;

const FIRST_CHECK_MS = 10_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

let status: UpdateStatus = { state: 'idle' };
let getWindow: () => BrowserWindow | null = () => null;
let channel = '';
/** Vérification lancée à la main : on signale aussi « aucune mise à jour » et les erreurs. */
let manual = false;

function publish(next: UpdateStatus): void {
  status = next;
  const win = getWindow();
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, status);
}

function message(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|net::ERR_/i.test(raw)) return 'Pas de connexion à GitHub';
  if (/404/.test(raw)) return 'Aucune release publiée trouvée';
  return raw.split('\n')[0].slice(0, 200);
}

/** Journal dans %APPDATA%/CoForge/logs/updater.log (remis à zéro au-delà de 256 Ko). */
function fileLogger() {
  const file = path.join(app.getPath('userData'), 'logs', 'updater.log');
  const write = (level: string, args: unknown[]): void => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size > 256 * 1024) fs.writeFileSync(file, '');
      const text = args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      fs.appendFileSync(file, `${new Date().toISOString()} [${level}] ${text}\n`);
    } catch {
      /* journal indisponible : sans conséquence */
    }
  };
  return {
    info: (...a: unknown[]) => write('info', a),
    warn: (...a: unknown[]) => write('warn', a),
    error: (...a: unknown[]) => write('error', a),
    debug: (...a: unknown[]) => write('debug', a),
  };
}

export function updatesEnabled(): boolean {
  return app.isPackaged;
}

export function currentUpdateStatus(): UpdateStatus {
  return status;
}

export function initUpdater(window: () => BrowserWindow | null, statusChannel: string): void {
  getWindow = window;
  channel = statusChannel;
  if (!updatesEnabled()) {
    status = { state: 'disabled' };
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = fileLogger();

  autoUpdater.on('checking-for-update', () => {
    if (status.state !== 'ready' && status.state !== 'downloading') publish({ state: 'checking' });
  });
  autoUpdater.on('update-available', (info) => publish({ state: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => {
    const version = status.version;
    publish({ state: 'downloading', version, percent: Math.round(p.percent) });
  });
  autoUpdater.on('update-downloaded', (info) => publish({ state: 'ready', version: info.version }));
  autoUpdater.on('update-not-available', () => {
    publish({ state: 'none', manual });
    manual = false;
  });
  autoUpdater.on('error', (err) => {
    // Une erreur pendant une vérification automatique reste discrète (hors ligne, GitHub indisponible…).
    if (status.state === 'ready') return;
    publish({ state: 'error', error: message(err), manual });
    manual = false;
  });

  setTimeout(() => void checkForUpdates(false), FIRST_CHECK_MS);
  setInterval(() => void checkForUpdates(false), CHECK_INTERVAL_MS);
}

export async function checkForUpdates(byUser: boolean): Promise<UpdateStatus> {
  if (!updatesEnabled()) return { state: 'disabled' };
  if (status.state === 'ready' || status.state === 'downloading') {
    if (byUser) publish(status);
    return status;
  }
  manual = byUser;
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    publish({ state: 'error', error: message(err), manual: byUser });
    manual = false;
  }
  return status;
}

/** Ferme l'application et lance l'installation silencieuse ; CoForge redémarre ensuite. */
export function installUpdateNow(): void {
  if (status.state !== 'ready') return;
  autoUpdater.quitAndInstall(true, true);
}
