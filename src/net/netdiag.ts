/**
 * Classement des adresses réseau et diagnostic des échecs de connexion.
 * Module PUR (ni DOM, ni Node) : partagé par le serveur (adresses à proposer), le processus
 * principal Electron et l'interface (dialogues d'invitation et de connexion).
 *
 * Constat qui l'a motivé : une invitation `ws://10.70.2.105:4455` (réseau d'école) ouverte depuis
 * une box à la maison (192.168.1.x) ne peut jamais aboutir — une adresse privée n'est pas routable
 * par Internet — et le message « serveur injoignable » ne permettait pas de le comprendre.
 */

/** Portée d'une adresse, du point de vue d'un invité. */
export type AddressKind =
  /** Tunnel chiffré (*.trycloudflare.com) : joignable de partout en wss://, IP de l'hôte masquée. */
  | 'tunnel'
  /** 127.x, ::1, localhost : cette machine seulement. */
  | 'loopback'
  /** 10/8, 172.16/12, 192.168/16, fc00::/7 : réseau local privé (même box, même Wi-Fi). */
  | 'lan'
  /** VPN maillé (Tailscale 100.64/10, ZeroTier, Radmin, Hamachi, WireGuard…) : joignable à distance par les membres du VPN. */
  | 'vpn'
  /** 100.64/10 sur une interface qui n'est pas un VPN : réseau de l'opérateur (partage de connexion mobile). */
  | 'cgnat'
  /** 169.254/16, fe80::/10 : adresse automatique, sans box. */
  | 'link-local'
  /** Adresse publique : joignable depuis Internet si la box redirige le port. */
  | 'public'
  /** Nom d'hôte : la portée dépend de sa résolution. */
  | 'name';

export interface AddressClass {
  kind: AddressKind;
  /** Étiquette courte, ex. « Réseau local », « VPN (Tailscale) ». */
  label: string;
  /** Portée en une phrase, ex. « Fonctionne seulement sur le même réseau local ». */
  reach: string;
}

/** Interface réseau locale (os.networkInterfaces, sans les internes). */
export interface LocalNet {
  /** Nom de l'interface, ex. « Wi-Fi », « Tailscale ». */
  name: string;
  address: string;
  /** Masque (IPv4 « 255.255.255.0 », IPv6 « ffff:ffff:: »). */
  netmask: string;
  family: 'IPv4' | 'IPv6';
}

/** Adresse proposée aux invités par l'hôte, avec sa portée. */
export interface ShareAddress extends AddressClass {
  /** ws://hôte:port */
  url: string;
  host: string;
  port: number;
  /** Interface de cette machine qui porte l'adresse (absent pour localhost ou l'adresse publique). */
  iface?: string;
}

// ------------------------------------------------------------------ IPv4

/** Adresse IPv4 en entier non signé, ou null. */
export function parseIPv4(text: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text.trim());
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const b = Number(m[i]);
    if (b > 255) return null;
    n = n * 256 + b;
  }
  return n;
}

function inRange(ip: number, base: string, bits: number): boolean {
  const b = parseIPv4(base)!;
  const size = 2 ** (32 - bits);
  return Math.floor(ip / size) === Math.floor(b / size);
}

/** Réseau privé RFC 1918 : 10/8, 172.16/12, 192.168/16. */
export function isPrivateIPv4(text: string): boolean {
  const ip = parseIPv4(text);
  return ip !== null && (inRange(ip, '10.0.0.0', 8) || inRange(ip, '172.16.0.0', 12) || inRange(ip, '192.168.0.0', 16));
}

/** `a` et `b` sont-elles dans le même sous-réseau IPv4 de masque `netmask` ? */
export function sameSubnet(a: string, b: string, netmask: string): boolean {
  const x = parseIPv4(a);
  const y = parseIPv4(b);
  const m = parseIPv4(netmask);
  if (x === null || y === null || m === null) return false;
  // Opérations bit à bit sur 32 bits signés : on compare les deux résultats de la même façon.
  return (x & m) === (y & m);
}

/** Nombre de bits d'un masque IPv4 (« 255.255.255.0 » → 24), ou null. */
export function maskBits(netmask: string): number | null {
  const m = parseIPv4(netmask);
  if (m === null) return null;
  let bits = 0;
  for (let i = 31; i >= 0; i--) {
    if (Math.floor(m / 2 ** i) % 2 === 1) bits++;
    else break;
  }
  return bits;
}

// ------------------------------------------------------------------ classement

/** Noms d'interfaces de VPN maillés ou de réseaux virtuels connus. */
const VPN_IFACE = /tailscale|zerotier|wireguard|wg\d|radmin|hamachi|netbird|nordlynx|headscale|nebula|tun\d|utun|tap-windows|openvpn|wintun/i;

/** L'interface porte-t-elle un VPN (d'après son nom) ? */
export function isVpnInterface(name: string | undefined): boolean {
  return !!name && VPN_IFACE.test(name);
}

function vpnName(iface: string | undefined, host: string): string {
  const n = iface ?? '';
  if (/tailscale/i.test(n) || host.toLowerCase().endsWith('.ts.net')) return 'Tailscale';
  if (/zerotier/i.test(n)) return 'ZeroTier';
  if (/radmin/i.test(n)) return 'Radmin VPN';
  if (/hamachi/i.test(n)) return 'Hamachi';
  if (/wireguard|wg\d/i.test(n)) return 'WireGuard';
  if (/netbird/i.test(n)) return 'NetBird';
  return '';
}

const REACH: Record<AddressKind, string> = {
  tunnel: 'Joignable de partout, chiffré (TLS) ; votre adresse IP n’apparaît ni dans le lien ni chez les invités',
  loopback: 'Cette machine uniquement (test local)',
  lan: 'Fonctionne seulement sur le même réseau local (même box, même Wi-Fi)',
  vpn: 'Fonctionne à distance via VPN : l’invité doit être connecté au même VPN',
  cgnat: 'Adresse du réseau de l’opérateur (partage de connexion) : non joignable par les autres',
  'link-local': 'Adresse automatique sans box (câble direct) : à éviter',
  public: 'Nécessite une redirection de port sur la box (TCP) vers cette machine',
  name: 'Nom de machine : la portée dépend du réseau qui le résout',
};

const LABEL: Record<AddressKind, string> = {
  tunnel: 'Tunnel chiffré',
  loopback: 'Cette machine',
  lan: 'Réseau local',
  vpn: 'VPN',
  cgnat: 'Opérateur',
  'link-local': 'Lien local',
  public: 'Internet',
  name: 'Nom d’hôte',
};

/** Adresse publique d'un tunnel CoForge (Cloudflare Quick Tunnel). */
export function isTunnelHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.trycloudflare\.com$/.test(h) && h !== 'api.trycloudflare.com';
}

/** Hôte sans crochets IPv6 ni casse. */
function bareHost(host: string): string {
  const h = host.trim().toLowerCase();
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

function classifyIPv6(h: string): AddressKind {
  if (h === '::1') return 'loopback';
  if (h.startsWith('fd7a:115c:a1e0:')) return 'vpn'; // Tailscale
  if (/^fe[89ab][0-9a-f]:/.test(h)) return 'link-local';
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return 'lan';
  return 'public';
}

/**
 * Portée d'une adresse (IPv4, IPv6 ou nom). `iface` : nom de l'interface locale qui la porte,
 * quand on le connaît (côté hôte) — il distingue un VPN (ZeroTier en 10.x, Radmin en 26.x)
 * d'un simple réseau local ou d'une adresse publique.
 */
export function classifyAddress(host: string, iface?: string): AddressClass {
  const h = bareHost(host);
  const vpnIface = isVpnInterface(iface);
  let kind: AddressKind;
  const ip = parseIPv4(h);
  if (h === 'localhost' || h.endsWith('.localhost')) kind = 'loopback';
  else if (ip !== null) {
    if (inRange(ip, '127.0.0.0', 8)) kind = 'loopback';
    else if (inRange(ip, '169.254.0.0', 16)) kind = 'link-local';
    else if (vpnIface) kind = 'vpn';
    else if (inRange(ip, '100.64.0.0', 10)) kind = iface === undefined ? 'vpn' : 'cgnat';
    else if (isPrivateIPv4(h)) kind = 'lan';
    else kind = 'public';
  } else if (h.includes(':')) kind = vpnIface ? 'vpn' : classifyIPv6(h);
  else if (h.endsWith('.ts.net')) kind = 'vpn';
  else if (isTunnelHost(h)) kind = 'tunnel';
  else kind = 'name';
  const vpn = kind === 'vpn' ? vpnName(iface, h) || (ip !== null && inRange(ip, '100.64.0.0', 10) ? 'Tailscale ?' : '') : '';
  return { kind, label: vpn ? `${LABEL.vpn} (${vpn})` : LABEL[kind], reach: REACH[kind] };
}

/** Ordre de présentation aux invités : VPN d'abord (joignable à distance), puis réseau local… `localhost` en dernier. */
const RANK: Record<AddressKind, number> = { tunnel: -1, vpn: 0, lan: 1, public: 2, name: 3, cgnat: 4, 'link-local': 5, loopback: 6 };

export function addressRank(kind: AddressKind): number {
  return RANK[kind];
}

/** Trie des adresses proposées (stable : à rang égal, l'ordre d'origine est gardé). */
export function sortShareAddresses<T extends { kind: AddressKind }>(list: T[]): T[] {
  return list
    .map((item, i) => ({ item, i }))
    .sort((a, b) => RANK[a.item.kind] - RANK[b.item.kind] || a.i - b.i)
    .map((x) => x.item);
}

/** Adresses à proposer à partir des interfaces de la machine (sans les doublons). */
export function shareAddressesFrom(nets: LocalNet[], port: number, withLocalhost = true): ShareAddress[] {
  const out: ShareAddress[] = [];
  const seen = new Set<string>();
  for (const n of nets) {
    if (n.family !== 'IPv4' || seen.has(n.address)) continue;
    seen.add(n.address);
    out.push({ ...classifyAddress(n.address, n.name), url: `ws://${n.address}:${port}`, host: n.address, port, iface: n.name });
  }
  const sorted = sortShareAddresses(out);
  if (withLocalhost) sorted.push({ ...classifyAddress('localhost'), url: `ws://localhost:${port}`, host: 'localhost', port });
  return sorted;
}

/** Hôte et port d'une URL ws(s):// (ou « hôte:port »), ou null. */
export function splitWsUrl(url: string): { host: string; port: number; tls: boolean } | null {
  const m = /^(?:(wss?|https?):\/\/)?(\[[^\]]+\]|[^/:?#\s]+)(?::(\d{1,5}))?/i.exec(url.trim());
  if (!m || !m[2]) return null;
  const scheme = (m[1] ?? 'ws').toLowerCase();
  const tls = scheme === 'wss' || scheme === 'https';
  const port = m[3] ? Number(m[3]) : tls ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: m[2].toLowerCase(), port, tls };
}

/** Classe une liste d'URL ws:// (sans nom d'interface : repli quand l'hôte ne les fournit pas). */
export function describeShareUrls(urls: string[]): ShareAddress[] {
  const out: ShareAddress[] = [];
  for (const url of urls) {
    const t = splitWsUrl(url);
    if (!t || out.some((o) => o.host === t.host && o.port === t.port)) continue;
    out.push({ ...classifyAddress(t.host), url, host: t.host, port: t.port });
  }
  return sortShareAddresses(out);
}

// ------------------------------------------------------------------ test de connexion et diagnostic

/**
 * Résultat d'un test de connexion à hôte:port :
 * - `ok` : le port répond (et `server` décrit le serveur CoForge s'il en est un) ;
 * - `refused` : la machine répond mais refuse (rien n'écoute, ou pare-feu qui rejette) ;
 * - `timeout` : aucune réponse (adresse non routable, pare-feu qui ignore, isolation Wi-Fi, machine éteinte) ;
 * - `unreachable` : aucune route vers l'hôte (réseau absent) ;
 * - `dns` : nom d'hôte introuvable ;
 * - `not-coforge` : le port répond, mais pas un serveur CoForge ;
 * - `error` : autre échec.
 */
export type ProbeOutcome = 'ok' | 'refused' | 'timeout' | 'unreachable' | 'dns' | 'not-coforge' | 'error';

export interface ProbeResult {
  outcome: ProbeOutcome;
  /** Durée du test (ms). */
  ms: number;
  /** Code système (ECONNREFUSED, ETIMEDOUT…), si connu. */
  code?: string;
  /** Serveur CoForge identifié (réponse JSON de GET /). */
  server?: { version: string; protocol: number; secured: boolean } | null;
  /** Le résultat est déduit (navigateur : refus et délai ne sont distingués que par la durée). */
  guessed?: boolean;
}

/** Codes d'erreur système (Node) → issue du test. */
export function outcomeFromCode(code: string | undefined): ProbeOutcome {
  switch (code) {
    case 'ECONNREFUSED':
    case 'ECONNRESET':
      return 'refused';
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
      return 'timeout';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EADDRNOTAVAIL':
    case 'ENETDOWN':
    case 'EHOSTDOWN':
      return 'unreachable';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EAI_FAIL':
      return 'dns';
    default:
      return 'error';
  }
}

/**
 * Sans accès au système (navigateur), un échec rapide est un refus (la machine a répondu « rien
 * n'écoute ici ») et un échec à l'échéance un délai dépassé. Windows met ~2 s à conclure un refus.
 */
export function guessOutcome(ms: number, timeoutMs: number): ProbeOutcome {
  return ms >= timeoutMs * 0.9 ? 'timeout' : ms <= 3500 ? 'refused' : 'error';
}

export interface Diagnosis {
  severity: 'ok' | 'warn' | 'error';
  /** Constat principal, en une phrase. */
  title: string;
  /** Précisions (causes probables). */
  details: string[];
  /** Solutions, dans l'ordre où les essayer. */
  solutions: string[];
}

const SOLUTION_SAME_NET = 'Se connecter au même réseau que l’hôte (même Wi-Fi ou même box).';
const SOLUTION_VPN =
  'Installer un VPN maillé gratuit (Tailscale ou ZeroTier) sur les deux PC, connectés au même compte ou au même réseau, puis demander à l’hôte un lien avec son adresse VPN (100.x.x.x pour Tailscale).';
const SOLUTION_SERVER =
  'Lancer le serveur CoForge autonome sur une machine joignable par les deux (serveur, VPS, PC avec redirection de port) : node coforge-server.cjs --port 4455 --password <mdp> --invite <salle> (fichier resources/coforge-server.cjs du dossier d’installation), puis rejoindre avec le lien qu’il affiche.';
const NOTE_ISOLATION =
  'Sur un réseau d’école, d’entreprise ou d’hôtel, l’« isolation des clients » Wi-Fi empêche souvent les PC de se joindre entre eux, même connectés au même Wi-Fi : dans ce cas seul un VPN maillé ou un serveur autonome fonctionne.';
const NOTE_FIREWALL =
  'Pare-feu Windows de l’hôte : CoForge doit être autorisé pour le profil réseau actif — souvent « Public » sur un réseau d’école (bouton « Autoriser dans le pare-feu » du dialogue d’invitation de l’hôte).';

/** Le réseau local de l'invité contient-il cette adresse ? null si on ne connaît pas ses interfaces. */
export function onLocalNetwork(host: string, nets: LocalNet[] | null): boolean | null {
  if (!nets) return null;
  const h = bareHost(host);
  if (parseIPv4(h) === null) return null;
  return nets.some((n) => n.family === 'IPv4' && sameSubnet(h, n.address, n.netmask));
}

/**
 * Diagnostic lisible d'un test de connexion vers `host:port`, compte tenu des interfaces réseau de
 * l'invité (`nets`, null si inconnues : navigateur, ancienne version).
 */
export function diagnose(host: string, port: number, probe: ProbeResult, nets: LocalNet[] | null): Diagnosis {
  const h = bareHost(host);
  const cls = classifyAddress(h);
  const local = onLocalNetwork(h, nets);
  const secs = Math.max(1, Math.round(probe.ms / 1000));

  if (probe.outcome === 'ok') {
    if (probe.server) {
      return {
        severity: 'ok',
        title: `Serveur CoForge ${probe.server.version} joignable à ${h}:${port} (${Math.max(1, Math.round(probe.ms))} ms).`,
        details: [probe.server.secured ? 'Le serveur demande un mot de passe ou un lien d’invitation.' : 'Session ouverte (sans mot de passe).'],
        solutions: [],
      };
    }
    return {
      severity: 'ok',
      title: `${h}:${port} répond (${Math.max(1, Math.round(probe.ms))} ms).`,
      details: ['Le port est ouvert ; la version du serveur n’a pas pu être lue.'],
      solutions: [],
    };
  }

  if (probe.outcome === 'not-coforge') {
    return {
      severity: 'error',
      title: `${h}:${port} répond, mais ce n’est pas un serveur CoForge.`,
      details: ['Un autre programme utilise ce port sur la machine de l’hôte, ou l’adresse est erronée.'],
      solutions: ['Vérifier le port indiqué dans le lien (4455 par défaut).', 'Demander un nouveau lien d’invitation à l’hôte.'],
    };
  }

  if (probe.outcome === 'dns') {
    return {
      severity: 'error',
      title: `Le nom « ${h} » est introuvable.`,
      details: ['Ce nom de machine n’est pas connu de votre réseau (faute de frappe, nom réservé au réseau de l’hôte, ou pas de connexion Internet).'],
      solutions: ['Demander à l’hôte un lien avec son adresse IP.', SOLUTION_VPN],
    };
  }

  if (cls.kind === 'loopback') {
    return {
      severity: 'error',
      title: `« ${h} » désigne votre propre ordinateur, pas celui de l’hôte.`,
      details: ['Ce lien ne fonctionne que sur la machine qui héberge la session.'],
      solutions: ['Demander à l’hôte un lien avec l’adresse de sa machine (dialogue « Inviter »).'],
    };
  }

  // Adresse privée hors de tous les réseaux de l'invité : non routable, la connexion ne peut pas aboutir.
  if ((cls.kind === 'lan' || cls.kind === 'link-local') && local === false) {
    return {
      severity: 'error',
      title: `${h} est une adresse du réseau local de l’hôte ; vous n’êtes pas sur ce réseau.`,
      details: [
        'Une adresse privée (10.x, 172.16-31.x, 192.168.x) n’est pas routable par Internet : depuis un autre réseau, la connexion ne peut jamais aboutir.',
        NOTE_ISOLATION,
      ],
      solutions: [SOLUTION_SAME_NET, SOLUTION_VPN, SOLUTION_SERVER],
    };
  }

  if (cls.kind === 'vpn' && nets && !nets.some((n) => classifyAddress(n.address, n.name).kind === 'vpn')) {
    return {
      severity: 'error',
      title: `${h} est une adresse VPN de l’hôte, et ce PC n’est connecté à aucun VPN.`,
      details: ['Une adresse VPN (100.x.x.x pour Tailscale) n’est joignable que par les machines connectées au même VPN.'],
      solutions: ['Installer et connecter le même VPN (Tailscale : même compte, ou machine partagée par l’hôte), puis réessayer.', SOLUTION_SERVER],
    };
  }

  const details: string[] = [];
  const solutions: string[] = [];
  let title: string;
  switch (probe.outcome) {
    case 'refused':
      title = `Connexion refusée par ${h} sur le port ${port}.`;
      details.push('La machine répond, mais rien n’accepte la connexion : session arrêtée par l’hôte, mauvais port, ou pare-feu qui rejette.');
      solutions.push('Vérifier que l’hôte héberge toujours la session et que le port du lien est le bon.', NOTE_FIREWALL);
      break;
    case 'timeout':
      title = `Délai dépassé : aucune réponse de ${h}:${port} en ${secs} s.`;
      if (local === true || cls.kind === 'lan') {
        details.push(
          'Causes probables : pare-feu de l’hôte (profil Public), isolation des clients Wi-Fi du réseau, ou machine de l’hôte éteinte ou en veille.',
          NOTE_ISOLATION,
        );
        solutions.push(NOTE_FIREWALL, SOLUTION_VPN, SOLUTION_SERVER);
      } else if (cls.kind === 'public') {
        details.push('Adresse Internet : la box de l’hôte doit rediriger le port TCP vers sa machine, et son pare-feu l’autoriser.');
        solutions.push(`Sur la box de l’hôte : rediriger le port ${port} (TCP) vers l’adresse locale de son PC.`, NOTE_FIREWALL, SOLUTION_VPN);
      } else {
        details.push('L’adresse n’est pas joignable depuis votre réseau, ou un pare-feu ignore la connexion.');
        solutions.push(NOTE_FIREWALL, SOLUTION_VPN, SOLUTION_SERVER);
      }
      break;
    case 'unreachable':
      title = `Aucune route vers ${h} depuis ce PC.`;
      details.push('Votre réseau ne sait pas joindre cette adresse (réseau coupé, adresse d’un autre réseau local ou d’un VPN auquel vous n’êtes pas connecté).');
      solutions.push(SOLUTION_SAME_NET, SOLUTION_VPN, SOLUTION_SERVER);
      break;
    default:
      title = `Connexion impossible à ${h}:${port}.`;
      details.push('Le serveur n’a pas pu être joint.');
      solutions.push(NOTE_FIREWALL, SOLUTION_VPN, SOLUTION_SERVER);
  }
  if (probe.guessed) details.push('(Diagnostic approximatif : refus et délai sont déduits de la durée du test.)');
  if (local === null && cls.kind === 'lan' && probe.outcome !== 'refused') {
    details.unshift(`${h} est une adresse de réseau local : elle ne fonctionne que si vous êtes sur le même réseau que l’hôte.`);
  }
  return { severity: 'error', title, details, solutions };
}

/** Le serveur répond-il depuis ses propres adresses ? Avertissement pour l'hôte, ou null si tout va bien. */
export function selfReachWarning(results: { url: string; outcome: ProbeOutcome }[]): string | null {
  const failed = results.filter((r) => r.outcome !== 'ok' && r.outcome !== 'not-coforge');
  if (failed.length === 0) return null;
  const list = failed.map((r) => r.url.replace(/^wss?:\/\//, '')).join(', ');
  return `Le serveur ne répond pas depuis cette machine sur ${list} : les invités ne pourront pas l’atteindre par ${failed.length > 1 ? 'ces adresses' : 'cette adresse'} (pare-feu, logiciel de sécurité ou interface désactivée).`;
}
