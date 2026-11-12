import path from 'node:path';
import { listShareAddresses } from './addresses';
import { CollabServer, SERVER_VERSION } from './CollabServer';

/**
 * Serveur de collaboration CoForge autonome (machine dédiée / VPS).
 *   node coforge-server.cjs --port 4455 --password secret --data ./rooms --host 0.0.0.0
 */

const HELP = `Serveur de collaboration CoForge ${SERVER_VERSION}

Utilisation : node coforge-server.cjs [options]

  --port <n>        Port d'écoute (défaut 4455, ou variable COFORGE_PORT)
  --password <mdp>  Mot de passe exigé des clients (ou variable COFORGE_PASSWORD)
  --data <dossier>  Dossier de persistance des sessions (sans lui : mémoire seule)
  --host <adresse>  Interface d'écoute (défaut 0.0.0.0 = toutes)
  --help            Affiche cette aide
`;

interface CliOptions {
  port: number;
  password?: string;
  data?: string;
  host: string;
}

function fail(message: string): never {
  console.error(`Erreur : ${message}\n\n${HELP}`);
  process.exit(2);
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    port: process.env.COFORGE_PORT ? Number(process.env.COFORGE_PORT) : 4455,
    password: process.env.COFORGE_PASSWORD || undefined,
    host: '0.0.0.0',
  };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let value: string | undefined;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const next = (): string => {
      if (value !== undefined) return value;
      const v = argv[++i];
      if (v === undefined) fail(`valeur manquante pour ${arg}`);
      return v;
    };
    switch (arg) {
      case '--port':
      case '-p':
        opts.port = Number(next());
        break;
      case '--password':
        opts.password = next() || undefined;
        break;
      case '--data':
        opts.data = next();
        break;
      case '--host':
        opts.host = next();
        break;
      case '--help':
      case '-h':
        console.log(HELP);
        process.exit(0);
        break;
      default:
        fail(`option inconnue « ${arg} »`);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) fail('le port doit être un entier entre 0 et 65535');
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const stamp = () => new Date().toLocaleTimeString('fr-FR');
  const server = new CollabServer();
  const dataDir = opts.data ? path.resolve(opts.data) : undefined;

  let port: number;
  try {
    ({ port } = await server.start({
      port: opts.port,
      password: opts.password,
      dataDir,
      host: opts.host,
      log: (message) => console.log(`[${stamp()}] ${message}`),
    }));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') console.error(`Le port ${opts.port} est déjà utilisé.`);
    else if (code === 'EACCES') console.error(`Accès refusé au port ${opts.port}.`);
    else console.error(`Démarrage impossible : ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log(`Serveur CoForge ${SERVER_VERSION} démarré.`);
  const everywhere = opts.host === '0.0.0.0' || opts.host === '::';
  const addresses = everywhere ? listShareAddresses(port) : [`ws://${opts.host.includes(':') ? `[${opts.host}]` : opts.host}:${port}`];
  console.log('Adresses à communiquer aux participants :');
  for (const address of addresses) console.log(`  ${address}`);
  console.log(`Mot de passe : ${opts.password ? 'exigé' : 'aucun'}`);
  console.log(`Persistance : ${dataDir ?? 'aucune (sessions en mémoire uniquement)'}`);
  console.log('Ctrl+C pour arrêter.');

  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    console.log('\nArrêt en cours, sauvegarde des sessions…');
    // Garde-fou : si l'arrêt propre se bloque, on sort quand même.
    setTimeout(() => process.exit(1), 10_000).unref();
    server.stop().then(
      () => {
        console.log('Serveur arrêté.');
        process.exit(0);
      },
      (err) => {
        console.error(`Arrêt incomplet : ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      },
    );
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(signal, shutdown);

  // Dernier rempart : une erreur imprévue ne doit pas faire tomber les sessions en cours.
  process.on('uncaughtException', (err) => console.error(`[${stamp()}] Erreur non gérée : ${err.stack ?? err.message}`));
  process.on('unhandledRejection', (reason) => console.error(`[${stamp()}] Promesse rejetée non gérée : ${String(reason)}`));
}

void main();
