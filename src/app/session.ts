import * as Y from 'yjs';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { SceneDoc } from '../core/doc/SceneDoc';
import { buildInviteLink, buildWebInviteLink, inviteServerUrl, parseInviteLink, type InviteLink } from '../net/invite';
import type { InviteOptions } from '../net/api';
import { getApp } from './context';
import { platform, type HostAccess } from './platform';
import { patchSession, store, toast } from './store';

/**
 * Cycle de vie d'une session collaborative.
 *
 * Héberger : l'application démarre le serveur embarqué puis s'y connecte avec
 * SA scène courante, c'est elle qui devient la scène de la session.
 *
 * Rejoindre : on part d'un document vide qui reçoit la scène du serveur, puis
 * il remplace la scène locale. Cas particulier : si la room est vide (serveur
 * dédié tout neuf), la scène locale y est publiée, le premier arrivé apporte
 * sa scène.
 *
 * Inviter : un lien coforge://join?… (et sa variante web http://hôte:port/join?…)
 * porte l'adresse, la session et un jeton d'invitation créé par le serveur.
 */

function normalizeUrl(url: string): string {
  let u = url.trim();
  if (!/^wss?:\/\//i.test(u)) u = `ws://${u}`;
  return u.replace(/\/+$/, '');
}

// ------------------------------------------------------------------ état d'interface propre aux sessions

export interface GeneratedInvite {
  /** Lien coforge:// principal (première adresse joignable). */
  link: string;
  /** Variante web, cliquable dans les messageries. */
  webLink: string;
  /** Un lien par adresse joignable (LAN d'abord), quand on héberge. */
  alternatives: { address: string; link: string; webLink: string }[];
  /** Identifiant de l'invitation côté serveur (null : session ouverte ou lien repartagé par un invité). */
  inviteId: string | null;
  expiresAt: number | null;
  maxUses: number;
  /** Le lien ne contient pas de jeton : session ouverte. */
  open: boolean;
}

export interface SessionUiState {
  /** Dialogue « Inviter » ouvert. */
  inviteOpen: boolean;
  /** Lien d'invitation reçu (système ou collage) en attente de confirmation. */
  pendingLink: InviteLink | null;
  /** Dernière invitation générée pendant cette session. */
  lastInvite: GeneratedInvite | null;
}

export const sessionUi = createStore<SessionUiState>(() => ({ inviteOpen: false, pendingLink: null, lastInvite: null }));

export function useSessionUi<T>(selector: (s: SessionUiState) => T): T {
  return useStore(sessionUi, selector);
}

export function openInviteDialog(): void {
  sessionUi.setState({ inviteOpen: true });
}

export function closeInviteDialog(): void {
  sessionUi.setState({ inviteOpen: false });
}

// ------------------------------------------------------------------ héberger, rejoindre, quitter

export async function hostSession(opts: { port: number; room: string; password?: string; access?: HostAccess }): Promise<void> {
  const app = getApp();
  if (store.getState().session.status !== 'offline') await leaveSession();
  const room = opts.room.trim();
  const password = opts.password?.trim() || undefined;
  const access: HostAccess = opts.access ?? (password ? 'password' : 'open');
  const info = await platform.hostStart({ port: opts.port, password, room, access });
  try {
    // 127.0.0.1 plutôt que « localhost » : sous Windows, localhost peut d'abord résoudre en ::1 (IPv6).
    await app.collab.connect(app.doc, { url: `ws://127.0.0.1:${info.port}`, room, password: access === 'invite' ? info.secret : password });
  } catch (err) {
    await platform.hostStop().catch(() => {});
    throw err;
  }
  patchSession({ hosting: true, shareAddresses: info.addresses });
  sessionUi.setState({ lastInvite: null });
  toast(`Session « ${room} » hébergée sur le port ${info.port}`);
}

export async function joinSession(opts: { url: string; room: string; password?: string; token?: string }): Promise<void> {
  const app = getApp();
  if (store.getState().session.status !== 'offline') await leaveSession();
  const doc = SceneDoc.createEmpty();
  try {
    await app.collab.connect(doc, {
      url: normalizeUrl(opts.url),
      room: opts.room.trim(),
      password: opts.password?.trim() || undefined,
      token: opts.token?.trim() || undefined,
    });
  } catch (err) {
    doc.destroy();
    throw err;
  }
  let published = false;
  if (doc.objectIds().length === 0 && doc.meshIds().length === 0) {
    // Room vide : on y publie la scène locale (fusion CRDT dans le document partagé).
    Y.applyUpdate(doc.ydoc, app.doc.encode(), doc.localOrigin);
    published = true;
  }
  doc.clearHistory();
  app.setDoc(doc, { filePath: null });
  sessionUi.setState({ lastInvite: null });
  toast(published ? `Session « ${opts.room} » créée avec votre scène` : `Session « ${opts.room} » rejointe`);
}

/** Rejoint la session désignée par un lien d'invitation (déjà validé). */
export function joinFromLink(link: InviteLink): Promise<void> {
  return joinSession({ url: inviteServerUrl(link), room: link.room, token: link.token ?? undefined });
}

/** Quitte la session (et arrête le serveur si on l'hébergeait). La scène reste ouverte en local. */
export async function leaveSession(): Promise<void> {
  const app = getApp();
  const { hosting } = store.getState().session;
  app.collab.disconnect();
  if (hosting) await platform.hostStop().catch(() => {});
  patchSession({ status: 'offline', hosting: false, shareAddresses: [], url: null, room: null, peers: [], error: null });
  store.setState({ followClientId: null, followPlaybackClientId: null });
  sessionUi.setState({ inviteOpen: false, lastInvite: null });
}

// ------------------------------------------------------------------ invitations

/** Hôte et port d'une URL ws(s)://, ou null. */
function splitServerUrl(url: string): { host: string; port: number; tls: boolean } | null {
  const m = /^(wss?):\/\/(\[[^\]]+\]|[^/:?#]+)(?::(\d{1,5}))?/i.exec(url.trim());
  if (!m) return null;
  const tls = m[1].toLowerCase() === 'wss';
  return { host: m[2].toLowerCase(), port: m[3] ? Number(m[3]) : tls ? 443 : 80, tls };
}

/**
 * Adresses à mettre dans le lien : quand on héberge, celles de cette machine (LAN d'abord,
 * `localhost` en dernier) ; sinon, l'adresse du serveur auquel on est connecté.
 */
function inviteTargets(): { host: string; port: number; tls: boolean }[] {
  const s = store.getState().session;
  const list = s.hosting && s.shareAddresses.length ? s.shareAddresses : s.url ? [s.url] : [];
  const out: { host: string; port: number; tls: boolean }[] = [];
  for (const a of list) {
    const t = splitServerUrl(a);
    if (t && !out.some((o) => o.host === t.host && o.port === t.port)) out.push(t);
  }
  // Un hôte qui s'est connecté par 127.0.0.1 : cette adresse n'a pas de sens pour un invité, sauf en dernier recours.
  out.sort((a, b) => Number(a.host === 'localhost' || a.host === '127.0.0.1') - Number(b.host === 'localhost' || b.host === '127.0.0.1'));
  return out;
}

/**
 * Génère un lien d'invitation pour la session courante :
 * - session protégée et participant administrateur : nouvelle invitation créée par le serveur ;
 * - invité : il repartage le lien (le même jeton) par lequel il est entré ;
 * - session ouverte : lien sans jeton.
 */
export async function generateInvite(opts: InviteOptions = {}): Promise<GeneratedInvite> {
  const app = getApp();
  const session = store.getState().session;
  if (session.status === 'offline' || !session.room) throw new Error('Aucune session en cours');
  const conn = app.collab.getConnection();
  const targets = inviteTargets();
  if (targets.length === 0) throw new Error('Adresse du serveur inconnue');

  let token: string | null = null;
  let inviteId: string | null = null;
  let expiresAt: number | null = null;
  let maxUses = 0;
  if (conn.role === 'guest') {
    if (!conn.inviteToken) throw new Error('Vous êtes entré sans lien d’invitation : demandez-en un à l’hôte');
    token = conn.inviteToken;
  } else if (conn.secured) {
    const created = await app.collab.createInvite(opts);
    token = created.token;
    inviteId = created.id;
    expiresAt = created.expiresAt;
    maxUses = created.maxUses;
  }
  const room = session.room;
  const alternatives = targets.map((t) => {
    const link: InviteLink = { host: t.host, port: t.port, room, token, tls: t.tls };
    return { address: `${t.host}:${t.port}`, link: buildInviteLink(link), webLink: buildWebInviteLink(link) };
  });
  const invite: GeneratedInvite = { link: alternatives[0].link, webLink: alternatives[0].webLink, alternatives, inviteId, expiresAt, maxUses, open: token === null };
  sessionUi.setState({ lastInvite: invite });
  return invite;
}

/** Révoque l'invitation générée en dernier (les invités entrés avec elle sont déconnectés). */
export async function revokeLastInvite(): Promise<void> {
  const last = sessionUi.getState().lastInvite;
  if (!last?.inviteId) return;
  await getApp().collab.revokeInvite(last.inviteId);
  sessionUi.setState({ lastInvite: null });
}

/** Un lien d'invitation arrive (système, collage) : validation stricte, puis demande de confirmation. */
export function receiveInviteLink(raw: string): boolean {
  const parsed = parseInviteLink(raw);
  if (!parsed.ok) {
    toast(`Lien d’invitation refusé : ${parsed.error}`, 'error');
    return false;
  }
  sessionUi.setState({ pendingLink: parsed.link });
  return true;
}

let linksBound = false;

/** Branche la réception des liens coforge:// transmis par Electron (une seule fois, au montage de l'interface). */
export function bindInviteLinks(): void {
  if (linksBound) return;
  linksBound = true;
  const take = () => {
    platform
      .takeInviteLink()
      .then((link) => {
        if (link) receiveInviteLink(link);
      })
      .catch((err: unknown) => console.error('[session] lien d’invitation illisible', err));
  };
  platform.onInviteLink(take);
  take();
}
