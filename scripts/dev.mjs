// Développement : Vite (renderer, rechargement à chaud) + bundles Node + Electron.
// Tout s'arrête à la fermeture d'Electron (ou sur Ctrl+C).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { buildNode } from './build-node.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV_URL = 'http://localhost:5173';

let vite = null;
let electron = null;
let exiting = false;

async function shutdown(code) {
  if (exiting) return;
  exiting = true;
  if (electron && electron.exitCode === null && !electron.killed) electron.kill();
  if (vite) await vite.close().catch(() => {});
  process.exit(code);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

try {
  vite = await createServer({ root, server: { port: 5173, strictPort: true } });
  await vite.listen();
  console.log(`Vite : ${DEV_URL}`);

  await buildNode();

  // Dans Node, le paquet `electron` exporte le chemin de son exécutable.
  const electronPath = createRequire(import.meta.url)('electron');
  electron = spawn(electronPath, ['.', ...process.argv.slice(2)], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: DEV_URL },
  });
  electron.on('error', (err) => {
    console.error(`Lancement d'Electron impossible : ${err.message}`);
    void shutdown(1);
  });
  electron.on('exit', (code) => void shutdown(code ?? 0));
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  await shutdown(1);
}
