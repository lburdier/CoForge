// Bundle le code Node du projet avec esbuild :
//   dist-electron/main.cjs     processus principal Electron
//   dist-electron/preload.cjs  preload (pont window.coforge)
//   dist-server/coforge-server.cjs  serveur de collaboration autonome (aucune dépendance externe)
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...parts) => path.join(root, ...parts);

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  absWorkingDir: root,
  legalComments: 'none',
  logLevel: 'warning',
  // Une seule copie de Yjs dans chaque bundle : toujours les entrées ESM des paquets.
  mainFields: ['module', 'main'],
  conditions: ['import', 'module'],
};

export async function buildNode() {
  await Promise.all([
    build({ ...common, entryPoints: [at('electron/main.ts')], outfile: at('dist-electron/main.cjs'), external: ['electron'] }),
    build({ ...common, entryPoints: [at('electron/preload.ts')], outfile: at('dist-electron/preload.cjs'), external: ['electron'] }),
    build({
      ...common,
      entryPoints: [at('server/cli.ts')],
      outfile: at('dist-server/coforge-server.cjs'),
      banner: { js: '#!/usr/bin/env node' },
    }),
  ]);
  // Icône de la fenêtre, livrée à côté du bundle principal.
  const icon = at('build/icon.png');
  if (fs.existsSync(icon)) fs.copyFileSync(icon, at('dist-electron/icon.png'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const started = Date.now();
  buildNode().then(
    () => {
      for (const file of ['dist-electron/main.cjs', 'dist-electron/preload.cjs', 'dist-server/coforge-server.cjs']) {
        console.log(`  ${file}  ${(fs.statSync(at(file)).size / 1024).toFixed(0)} Ko`);
      }
      console.log(`Bundles Node générés en ${Date.now() - started} ms.`);
    },
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
