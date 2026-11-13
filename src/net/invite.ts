import { isValidRoomName, isValidToken } from './protocol';

/**
 * Liens d'invitation CoForge (module PUR, partagé par l'interface, Electron et le serveur).
 *
 *   coforge://join?host=192.168.1.20&port=4455&room=atelier&token=Q2F…
 *
 * - host : adresse IPv4, nom d'hôte DNS, ou IPv6 entre crochets ([fe80::1]) ;
 * - port : 1 à 65535 ;
 * - room : nom de session (mêmes règles que le serveur) ;
 * - token : jeton d'invitation (facultatif : absent si la session est ouverte, sans mot de passe) ;
 * - tls=1 : serveur derrière un proxy TLS (wss://) ; v=1 : version du format.
 *
 * Variante web, servie par le serveur CoForge lui-même (aucun service externe) :
 *   http://192.168.1.20:4455/join?room=atelier&token=Q2F…
 * Elle est cliquable dans toutes les messageries ; la page propose d'ouvrir CoForge. Derrière
 * un proxy TLS (serveur dédié), la même page répond en https://nom-de-domaine/join?….
 *
 * Validation STRICTE : longueur bornée, aucun caractère de contrôle ni espace hors des
 * valeurs encodées, paramètres connus non dupliqués, chaque valeur vérifiée.
 */

export interface InviteLink {
  host: string;
  port: number;
  room: string;
  token: string | null;
  tls: boolean;
}

export const INVITE_SCHEME = 'coforge';
export const MAX_LINK_LENGTH = 1024;

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const IPV6 = /^\[[0-9A-Fa-f:.]{2,45}\]$/;

/** Hôte acceptable dans un lien : IPv4, IPv6 entre crochets, ou nom DNS (sans point final). */
export function isValidHost(host: string): boolean {
  if (typeof host !== 'string' || host.length === 0 || host.length > 253) return false;
  if (IPV4.test(host)) return host !== '0.0.0.0';
  if (host.startsWith('[')) {
    if (!IPV6.test(host)) return false;
    const inner = host.slice(1, -1);
    if (!inner.includes(':') || inner === '::' || /:::/.test(inner) || (inner.match(/::/g)?.length ?? 0) > 1) return false;
    return true;
  }
  // Un nom entièrement numérique à points serait une IPv4 invalide (ex. 999.1.1.1).
  if (/^[\d.]+$/.test(host)) return false;
  return host.split('.').every((label) => LABEL.test(label));
}

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** URL WebSocket du serveur désigné par un lien. */
export function inviteServerUrl(link: Pick<InviteLink, 'host' | 'port' | 'tls'>): string {
  return `${link.tls ? 'wss' : 'ws'}://${link.host}:${link.port}`;
}

function checkParts(link: InviteLink): void {
  if (!isValidHost(link.host)) throw new Error('Hôte invalide');
  if (!isValidPort(link.port)) throw new Error('Port invalide');
  if (!isValidRoomName(link.room)) throw new Error('Nom de session invalide');
  if (link.token !== null && !isValidToken(link.token)) throw new Error('Jeton invalide');
}

export function buildInviteLink(link: InviteLink): string {
  checkParts(link);
  const q = [`host=${encodeURIComponent(link.host)}`, `port=${link.port}`, `room=${encodeURIComponent(link.room)}`];
  if (link.token) q.push(`token=${link.token}`);
  if (link.tls) q.push('tls=1');
  return `${INVITE_SCHEME}://join?${q.join('&')}`;
}

/** Variante web (page d'accueil servie par le serveur CoForge sur son propre port). */
export function buildWebInviteLink(link: InviteLink): string {
  checkParts(link);
  const q = [`room=${encodeURIComponent(link.room)}`];
  if (link.token) q.push(`token=${link.token}`);
  return `${link.tls ? 'https' : 'http'}://${link.host}:${link.port}/join?${q.join('&')}`;
}

export type ParseResult = { ok: true; link: InviteLink } | { ok: false; error: string };

const KNOWN = new Set(['host', 'port', 'room', 'token', 'tls', 'v']);

/** Lit les paramètres d'une chaîne de requête en refusant les doublons et les valeurs mal encodées. */
function readQuery(query: string): Map<string, string> {
  const out = new Map<string, string>();
  if (query === '') return out;
  for (const part of query.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const rawKey = eq < 0 ? part : part.slice(0, eq);
    const rawValue = eq < 0 ? '' : part.slice(eq + 1);
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(rawKey);
      value = decodeURIComponent(rawValue.replace(/\+/g, ' '));
    } catch {
      throw new Error('Encodage invalide');
    }
    if (!KNOWN.has(key)) continue; // paramètre inconnu (version future du format) : ignoré
    if (out.has(key)) throw new Error(`Paramètre « ${key} » en double`);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('Caractère de contrôle');
    out.set(key, value);
  }
  return out;
}

function strictPort(text: string | undefined): number {
  if (text === undefined || !/^\d{1,5}$/.test(text)) return NaN;
  return Number(text);
}

/**
 * Lit un lien d'invitation (collé ou reçu du système). Accepte `coforge://join?…` et la
 * variante web `http(s)://hôte:port/join?…`. Les espaces, guillemets et chevrons qui
 * entourent souvent un lien copié depuis une messagerie sont retirés.
 */
export function parseInviteLink(input: string): ParseResult {
  if (typeof input !== 'string') return { ok: false, error: 'Lien invalide' };
  let text = input.trim();
  while (text.length >= 2 && /^[<"'«(]/.test(text) && /[>"'»)]$/.test(text)) text = text.slice(1, -1).trim();
  if (text.length === 0) return { ok: false, error: 'Lien vide' };
  if (text.length > MAX_LINK_LENGTH) return { ok: false, error: 'Lien trop long' };
  // Rien d'autre que de l'ASCII imprimable sans espace : tout le reste doit être encodé.
  if (!/^[\x21-\x7e]+$/.test(text)) return { ok: false, error: 'Le lien contient des caractères interdits' };

  try {
    const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(\/[^?#]*)?(?:\?([^#]*))?(?:#.*)?$/i.exec(text);
    if (!m) throw new Error('Ce n’est pas un lien d’invitation CoForge');
    const scheme = m[1].toLowerCase();
    const authority = m[2];
    const pathPart = m[3] ?? '';
    const params = readQuery(m[4] ?? '');
    if (params.has('v') && params.get('v') !== '1') throw new Error('Format de lien plus récent que cette version de CoForge : mettez CoForge à jour');
    const tlsParam = params.get('tls');
    if (tlsParam !== undefined && tlsParam !== '0' && tlsParam !== '1') throw new Error('Paramètre tls invalide');

    let host: string;
    let port: number;
    let tls: boolean;
    if (scheme === INVITE_SCHEME) {
      if (authority.toLowerCase() !== 'join' || (pathPart !== '' && pathPart !== '/')) throw new Error('Ce n’est pas un lien d’invitation CoForge');
      host = params.get('host') ?? '';
      port = strictPort(params.get('port'));
      tls = tlsParam === '1';
    } else if (scheme === 'http' || scheme === 'https') {
      if (pathPart !== '/join' && pathPart !== '/join/') throw new Error('Ce n’est pas un lien d’invitation CoForge');
      if (authority.includes('@')) throw new Error('Lien invalide');
      const hp = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(authority);
      if (!hp) throw new Error('Hôte invalide');
      host = hp[1];
      port = hp[2] !== undefined ? strictPort(hp[2]) : scheme === 'https' ? 443 : 80;
      tls = scheme === 'https';
      if (params.has('host') || params.has('port')) throw new Error('Lien invalide');
    } else {
      throw new Error('Ce n’est pas un lien d’invitation CoForge');
    }
    host = host.toLowerCase();
    const token = params.get('token');
    const link: InviteLink = { host, port, room: params.get('room') ?? '', token: token === undefined || token === '' ? null : token, tls };
    if (!isValidHost(link.host)) throw new Error('Adresse d’hôte invalide dans le lien');
    if (!isValidPort(link.port)) throw new Error('Port invalide dans le lien');
    if (!isValidRoomName(link.room)) throw new Error('Nom de session invalide dans le lien');
    if (link.token !== null && !isValidToken(link.token)) throw new Error('Jeton d’invitation invalide dans le lien');
    return { ok: true, link };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Le texte ressemble-t-il à un lien d'invitation (pour basculer le dialogue « Rejoindre ») ? */
export function looksLikeInviteLink(text: string): boolean {
  const t = text.trim().replace(/^[<"'«(]+/, '');
  return /^coforge:/i.test(t) || /^https?:\/\/[^/?#]+\/join\/?(\?|$)/i.test(t);
}
