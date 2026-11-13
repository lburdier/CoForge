import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Tunnel chiffré pour héberger une session SANS exposer l'adresse IP de l'hôte.
 *
 * Connexion directe : l'invité se connecte à l'IP de l'hôte (elle figure dans le lien et reste
 * visible dans les connexions réseau de l'invité), le trafic ws:// circule en clair, et le serveur
 * doit être joignable (même réseau, pare-feu, redirection de port).
 *
 * Avec le tunnel : le serveur embarqué n'écoute plus que sur 127.0.0.1 (aucune connexion entrante,
 * injoignable depuis le réseau local), et `cloudflared` (client officiel de Cloudflare, gratuit, sans
 * compte : « Quick Tunnel ») ouvre une connexion SORTANTE vers Cloudflare, qui publie une adresse
 * https://<mots-aléatoires>.trycloudflare.com. Les invités se connectent à cette adresse en wss://
 * (TLS) : ils ne voient que des adresses de Cloudflare, jamais celle de l'hôte ; l'hôte ne voit pas
 * non plus les leurs. L'adresse change à chaque session et disparaît à l'arrêt. Le contrôle d'accès
 * (invitation à jeton, mot de passe) reste celui du serveur CoForge.
 *
 * `cloudflared.exe` n'est pas livré avec CoForge : il est cherché sur la machine, ou téléchargé à la
 * demande explicite de l'utilisateur depuis la page officielle des versions de Cloudflare (GitHub),
 * et n'est conservé que si sa signature Authenticode est valide et émise au nom de Cloudflare.
 */

/** Page officielle du binaire Windows (redirige vers la dernière version publiée). */
export const CLOUDFLARED_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';

/** Délai maximal d'ouverture du tunnel. */
const START_TIMEOUT_MS = 45_000;

/** Adresse publique annoncée par cloudflared dans son journal (Quick Tunnel). */
const TUNNEL_URL_RE = /https:\/\/([a-z0-9][a-z0-9-]{0,62}(?:\.[a-z0-9][a-z0-9-]{0,62})*\.trycloudflare\.com)\b/i;

/** Extrait l'hôte public (« mots-aleatoires.trycloudflare.com ») d'un morceau du journal, ou null. */
export function parseTunnelHost(text: string): string | null {
  const m = TUNNEL_URL_RE.exec(text);
  // « api.trycloudflare.com » est l'API qui crée le tunnel, pas l'adresse du tunnel.
  if (!m || m[1].toLowerCase() === 'api.trycloudflare.com') return null;
  return m[1].toLowerCase();
}

/** Cause d'un échec en français, à partir du journal de cloudflared (connexion à Cloudflare impossible, etc.), ou null. */
export function parseTunnelError(text: string): string | null {
  let raw: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (/Cannot determine default (configuration|origin certificate) path/i.test(line)) continue;
    if (/\b(ERR|FTL)\b/.test(line) || /^\s*(failed to|error)\b/i.test(line)) {
      raw = line.replace(/^\S+\s+(ERR|FTL)\s+/, '').trim().slice(0, 300) || null;
      break;
    }
  }
  if (!raw) return null;
  if (/no such host|lookup .*(timeout|server misbehaving)/i.test(raw)) {
    return 'adresse de Cloudflare introuvable (pas d’accès Internet, ou le DNS de ce réseau bloque trycloudflare.com)';
  }
  if (/i\/o timeout|connection refused|connectex|dial tcp|network is unreachable/i.test(raw)) {
    return 'Cloudflare injoignable depuis ce réseau (accès Internet coupé ou filtré par un pare-feu d’école ou d’entreprise)';
  }
  if (/429|too many requests|rate.?limit/i.test(raw)) return 'Cloudflare refuse temporairement de nouveaux tunnels : réessayez dans quelques minutes';
  return raw;
}

/** Arguments du Quick Tunnel vers le serveur local (http2 : passe aussi là où l'UDP de QUIC est filtré). */
export function tunnelArgs(port: number): string[] {
  return ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${port}`];
}

export interface CloudflaredInfo {
  installed: boolean;
  path: string | null;
}

function exists(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function whereCloudflared(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('where.exe', ['cloudflared'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      const first = err ? '' : String(stdout).split(/\r?\n/)[0]?.trim() ?? '';
      resolve(first && exists(first) ? first : null);
    });
  });
}

/** Cherche cloudflared : copie téléchargée par CoForge, PATH, emplacements d'installation usuels. */
export async function findCloudflared(binDir: string): Promise<CloudflaredInfo> {
  if (process.platform !== 'win32') return { installed: false, path: null };
  const own = path.join(binDir, 'cloudflared.exe');
  if (exists(own)) return { installed: true, path: own };
  const inPath = await whereCloudflared();
  if (inPath) return { installed: true, path: inPath };
  const pf = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']].filter(Boolean) as string[];
  for (const dir of pf) {
    const p = path.join(dir, 'cloudflared', 'cloudflared.exe');
    if (exists(p)) return { installed: true, path: p };
  }
  return { installed: false, path: null };
}

/** Vérifie la signature Authenticode : valide et émise au nom de Cloudflare. */
export function verifySignature(file: string): Promise<{ ok: boolean; subject: string; status: string }> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$s = Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'`,
    "@{ status = [string]$s.Status; subject = [string]$s.SignerCertificate.Subject } | ConvertTo-Json -Compress",
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, timeout: 30_000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, subject: '', status: 'erreur' });
      try {
        const r = JSON.parse(String(stdout).trim()) as { status?: string; subject?: string };
        const status = String(r.status ?? '');
        const subject = String(r.subject ?? '');
        resolve({ ok: isTrustedSigner(status, subject), subject, status });
      } catch {
        resolve({ ok: false, subject: '', status: 'illisible' });
      }
    });
  });
}

/** Signature acceptée : statut « Valid » et sujet du certificat au nom de Cloudflare (CN ou O). */
export function isTrustedSigner(status: string, subject: string): boolean {
  return status === 'Valid' && /(^|,\s*)(CN|O)="?Cloudflare,? Inc\.?"?(,|$)/i.test(subject);
}

/**
 * Télécharge cloudflared dans `binDir` (demande explicite de l'utilisateur). `download` récupère les
 * octets (net.fetch d'Electron). Le fichier n'est gardé que si sa signature est celle de Cloudflare.
 */
export async function installCloudflared(binDir: string, download: (url: string) => Promise<Uint8Array>): Promise<CloudflaredInfo> {
  if (process.platform !== 'win32') throw new Error('Disponible uniquement sous Windows');
  fs.mkdirSync(binDir, { recursive: true });
  const target = path.join(binDir, 'cloudflared.exe');
  const temp = path.join(binDir, `cloudflared-${process.pid}-${Date.now()}.download.exe`);
  const bytes = await download(CLOUDFLARED_URL);
  if (bytes.byteLength < 1_000_000 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error('Téléchargement de cloudflared incomplet ou invalide');
  fs.writeFileSync(temp, bytes);
  try {
    const sig = await verifySignature(temp);
    if (!sig.ok) throw new Error(`Signature de cloudflared refusée (${sig.status || 'absente'}${sig.subject ? `, ${sig.subject}` : ''}) : fichier supprimé`);
    fs.rmSync(target, { force: true });
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return { installed: true, path: target };
}

export interface RunningTunnel {
  /** Hôte public, ex. « mots-aleatoires.trycloudflare.com » (port 443, TLS). */
  host: string;
  stop(): void;
  /** Appelé si cloudflared s'arrête de lui-même (réseau coupé, processus tué). */
  onExit(cb: (reason: string) => void): void;
}

/** Lance le Quick Tunnel vers 127.0.0.1:`port` et attend l'adresse publique. */
export function startTunnel(exe: string, port: number): Promise<RunningTunnel> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(exe, tunnelArgs(port), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new Error(`cloudflared n'a pas pu démarrer : ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    let log = '';
    let host: string | null = null;
    let settled = false;
    let stopped = false;
    const exitCbs: ((reason: string) => void)[] = [];
    const stop = () => {
      stopped = true;
      if (child.exitCode === null && !child.killed) child.kill();
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      reject(new Error(message));
    };
    const timer = setTimeout(() => {
      const why = parseTunnelError(log);
      fail(`Le tunnel ne s'est pas ouvert en ${START_TIMEOUT_MS / 1000} s${why ? ` : ${why}` : ' (connexion à Cloudflare impossible depuis ce réseau ?)'}`);
    }, START_TIMEOUT_MS);
    // On attend que la connexion à Cloudflare soit enregistrée : avant, l'adresse renverrait une erreur 1033.
    let registered = false;
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (log.length < 64_000) log += text;
      host ??= parseTunnelHost(text);
      if (/Registered tunnel connection/i.test(text)) registered = true;
      if (!settled && host && registered) {
        settled = true;
        clearTimeout(timer);
        const h = host;
        resolve({ host: h, stop, onExit: (cb) => exitCbs.push(cb) });
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => fail(`cloudflared n'a pas pu démarrer : ${err.message}`));
    child.on('exit', (code) => {
      if (!settled) {
        const why = parseTunnelError(log);
        fail(`cloudflared s'est arrêté (code ${code ?? '?'})${why ? ` : ${why}` : ''}`);
        return;
      }
      if (!stopped) for (const cb of exitCbs) cb(parseTunnelError(log) ?? `cloudflared s'est arrêté (code ${code ?? '?'})`);
    });
  });
}
