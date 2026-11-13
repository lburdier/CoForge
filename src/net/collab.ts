import { Awareness } from 'y-protocols/awareness';
import type { AppContext } from '../app/context';
import type { PeerInfo, SessionState } from '../app/store';
import type { SceneDoc } from '../core/doc/SceneDoc';
import type { Vec3 } from '../core/doc/schema';
import type { ConnectionErrorKind, ConnectionInfo, ConnectionPhase, ConnectOptions, ICollab, InviteOptions, Peer, PresenceCamera, PresenceState } from './api';
import {
  CLOSE_BAD_PASSWORD,
  CLOSE_BAD_ROOM,
  CLOSE_BAD_TOKEN,
  CLOSE_REVOKED,
  CLOSE_ROOM_NOT_FOUND,
  CLOSE_TOO_MANY,
  CLOSE_VERSION,
  type InviteCreated,
  type InviteInfo,
  isValidRoomName,
  isValidToken,
  PROTOCOL_VERSION,
} from './protocol';
import { CoforgeProvider, type ProviderSnapshot } from './provider';

/**
 * Client de collaboration : relie un SceneDoc à une room du serveur CoForge
 * (CoforgeProvider, voir provider.ts) et gère la présence (awareness Yjs).
 */

/** Délai maximal de la première connexion tant qu'aucune donnée n'arrive. */
const CONNECT_TIMEOUT_MS = 10_000;
/** Intervalle minimal entre deux envois de présence (~20/s). */
const PRESENCE_INTERVAL_MS = 50;
const MAX_EDIT_VERTS = 400;
/** Après ce nombre d'échecs consécutifs, l'état affiché passe de « reconnexion » à « hors ligne ». */
const OFFLINE_AFTER_ATTEMPTS = 4;

/** Accepte « 192.168.1.20:4455 », « http://… » : renvoie une URL ws(s):// sans barre finale, ou null si invalide. */
export function normalizeServerUrl(input: string): string | null {
  let url = input.trim();
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) url = url.replace(/^http/i, 'ws');
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `ws://${url}`;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null;
    if (!parsed.hostname) return null;
    if (parsed.username || parsed.password) return null;
  } catch {
    return null;
  }
  return url.replace(/\/+$/, '');
}

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

function readCamera(v: any): PresenceCamera | null {
  if (!v || typeof v !== 'object' || !isVec3(v.pos) || !isVec3(v.target)) return null;
  return {
    pos: v.pos,
    target: v.target,
    fov: typeof v.fov === 'number' && Number.isFinite(v.fov) ? v.fov : 50,
    ortho: v.ortho === true,
    aspect: typeof v.aspect === 'number' && Number.isFinite(v.aspect) && v.aspect > 0 ? v.aspect : 1,
  };
}

/** Les états de présence viennent du réseau : on ne fait confiance à aucun champ. */
function readPresence(raw: any): PresenceState | null {
  if (!raw || typeof raw !== 'object') return null;
  const user = raw.user;
  if (!user || typeof user.id !== 'string' || typeof user.name !== 'string' || typeof user.color !== 'string') return null;
  const pointer = raw.pointer && isVec3(raw.pointer.origin) && isVec3(raw.pointer.dir) ? { origin: raw.pointer.origin as Vec3, dir: raw.pointer.dir as Vec3 } : null;
  return {
    user: { id: user.id, name: user.name, color: user.color },
    camera: readCamera(raw.camera),
    pointer,
    selection: stringList(raw.selection),
    activeId: typeof raw.activeId === 'string' ? raw.activeId : null,
    mode: raw.mode === 'edit' ? 'edit' : 'object',
    editVerts: stringList(raw.editVerts),
  };
}

/** Message (français) et nature d'un refus définitif du serveur. */
export function describeClose(code: number, reason: string): { message: string; kind: ConnectionErrorKind } {
  switch (code) {
    case CLOSE_BAD_PASSWORD:
      return { message: 'Mot de passe refusé', kind: 'password' };
    case CLOSE_BAD_TOKEN:
      if (reason === 'expired') return { message: 'Invitation expirée : demandez un nouveau lien à l’hôte', kind: 'token' };
      if (reason === 'revoked') return { message: 'Invitation révoquée par l’hôte', kind: 'revoked' };
      if (reason === 'exhausted') return { message: 'Invitation déjà utilisée le nombre de fois autorisé', kind: 'token' };
      if (reason === 'room') return { message: 'Cette invitation concerne une autre session', kind: 'token' };
      return { message: 'Invitation invalide ou inconnue de ce serveur', kind: 'token' };
    case CLOSE_REVOKED:
      return { message: 'L’hôte a révoqué votre invitation : vous avez été déconnecté', kind: 'revoked' };
    case CLOSE_BAD_ROOM:
      return { message: 'Nom de session refusé par le serveur', kind: 'room' };
    case CLOSE_ROOM_NOT_FOUND:
      return { message: 'Session introuvable sur ce serveur (l’hôte l’a peut-être arrêtée)', kind: 'room-not-found' };
    case CLOSE_VERSION: {
      if (reason.startsWith('server:')) return { message: 'Serveur CoForge trop ancien pour cette version : mettez le serveur à jour', kind: 'version' };
      const m = /^version:(\d+)-(\d+)$/.exec(reason);
      const newer = m && Number(m[1]) > PROTOCOL_VERSION;
      return {
        message: newer
          ? 'Version incompatible : le serveur est plus récent, mettez CoForge à jour'
          : 'Version incompatible : le serveur est plus ancien que cette version de CoForge',
        kind: 'version',
      };
    }
    case CLOSE_TOO_MANY:
      return { message: 'Trop de tentatives refusées depuis cette adresse : réessayez dans une minute', kind: 'too-many' };
    default:
      return { message: `Connexion fermée par le serveur (code ${code})`, kind: 'other' };
  }
}

const IDLE: ConnectionInfo = {
  phase: 'idle',
  url: null,
  room: null,
  attempt: 0,
  nextRetryAt: null,
  latencyMs: null,
  pendingChanges: 0,
  error: null,
  errorKind: null,
  serverVersion: null,
  protocol: null,
  role: null,
  secured: null,
  inviteToken: null,
  transfer: null,
};

function sameInfo(a: ConnectionInfo, b: ConnectionInfo): boolean {
  for (const k of Object.keys(a) as (keyof ConnectionInfo)[]) {
    if (k === 'transfer') {
      const x = a.transfer;
      const y = b.transfer;
      if (x === y) continue;
      if (!x || !y || x.direction !== y.direction || x.done !== y.done || x.total !== y.total) return false;
      continue;
    }
    if (a[k] !== b[k]) return false;
  }
  return true;
}

class Collab implements ICollab {
  private provider: CoforgeProvider | null = null;
  private awareness: Awareness | null = null;
  private doc: SceneDoc | null = null;
  /** La première synchronisation a réussi. */
  private established = false;
  private peers: Peer[] = [];
  private peersKey = '';
  private listeners = new Set<(peers: Peer[]) => void>();
  private pendingPresence: Partial<PresenceState> | null = null;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPresenceSent = 0;
  /** Interrompt une connexion en cours d'établissement (rejette sa promesse). */
  private abortConnect: ((message: string, kind?: ConnectionErrorKind) => void) | null = null;
  private info: ConnectionInfo = IDLE;
  private infoListeners = new Set<(info: ConnectionInfo) => void>();
  private token: string | null = null;

  constructor(private readonly app: AppContext) {
    // Le nom ou la couleur de l'utilisateur local change : les autres doivent le voir.
    app.store.subscribe((state, prev) => {
      if (state.user !== prev.user && this.provider) this.setPresence({ user: state.user });
    });
  }

  get connected(): boolean {
    return this.established && !!this.provider && this.provider.isSynced;
  }

  get clientId(): number | null {
    return this.provider && this.doc ? this.doc.ydoc.clientID : null;
  }

  connect(doc: SceneDoc, opts: ConnectOptions): Promise<void> {
    // Un seul fournisseur à la fois.
    if (this.provider || this.abortConnect) this.disconnect();

    const url = normalizeServerUrl(opts.url);
    const room = opts.room.trim();
    if (!url) return this.refuse(`Adresse de serveur invalide : « ${opts.url} »`, 'other');
    if (!isValidRoomName(room)) return this.refuse('Nom de session invalide (64 caractères au plus : lettres sans accent, chiffres, espaces, « - », « _ », « . »)', 'room');
    const token = opts.token?.trim() || null;
    if (token !== null && !isValidToken(token)) return this.refuse('Jeton d’invitation invalide', 'token');

    this.patch({ status: 'connecting', url, room, error: null, peers: [] });
    this.token = token;
    this.setInfo({ ...IDLE, phase: 'connecting', url, room, inviteToken: token });

    const awareness = new Awareness(doc.ydoc);
    let provider: CoforgeProvider;
    try {
      provider = new CoforgeProvider({ url, room, doc: doc.ydoc, awareness, credentials: { password: opts.password || undefined, token: token ?? undefined } });
    } catch (err) {
      awareness.destroy();
      return this.refuse(`Connexion impossible : ${err instanceof Error ? err.message : String(err)}`, 'other');
    }
    this.provider = provider;
    this.awareness = awareness;
    this.doc = doc;
    this.established = false;
    awareness.setLocalState(this.defaultPresence());
    awareness.on('change', this.onAwarenessChange);
    provider.onStatus((snap) => {
      if (this.provider === provider) this.onProviderStatus(snap);
    });

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const started = Date.now();
      const fail = (message: string, kind: ConnectionErrorKind = 'other'): void => {
        if (settled) return;
        settled = true;
        clearInterval(watchdog);
        this.abortConnect = null;
        if (this.provider === provider) {
          this.teardown();
          this.patch({ status: 'offline', url: null, room: null, peers: [], error: message });
          this.setInfo({ ...IDLE, phase: 'error', url, room, error: message, errorKind: kind });
        }
        reject(new Error(message));
      };
      // Première connexion : on abandonne si rien n'a pu s'ouvrir, ou si la synchronisation est
      // interrompue ; tant que des données arrivent (grosse scène, lien lent), on attend.
      const watchdog = setInterval(() => {
        if (settled || Date.now() - started < CONNECT_TIMEOUT_MS) return;
        if (!provider.everOpened) fail(`Serveur injoignable à l'adresse ${url}`, 'unreachable');
        else if (provider.snapshot().phase !== 'syncing' && provider.snapshot().phase !== 'connecting') fail(`Connexion au serveur ${url} interrompue pendant la synchronisation`, 'unreachable');
      }, 250);
      this.abortConnect = fail;

      provider.onSynced(() => {
        if (this.provider !== provider) return;
        if (!settled) {
          settled = true;
          clearInterval(watchdog);
          this.abortConnect = null;
          this.established = true;
          this.patch({ status: 'connected', error: null });
          this.onProviderStatus(provider.snapshot());
          this.refreshPeers();
          resolve();
        } else {
          this.patch({ status: 'connected', error: null });
        }
      });

      // Fermeture définitive décidée par le serveur (codes 44xx) : le fournisseur a cessé de se reconnecter.
      provider.onClosed((event) => {
        if (this.provider !== provider) return;
        const { message, kind } = describeClose(event.code, event.reason);
        if (!settled) {
          fail(message, kind);
        } else {
          // Refus survenu lors d'une reconnexion (mot de passe changé, invitation révoquée…).
          this.teardown();
          this.patch({ status: 'offline', url: null, room: null, peers: [], error: message });
          this.setInfo({ ...IDLE, phase: 'error', url, room, error: message, errorKind: kind });
        }
      });

      try {
        provider.connect();
      } catch (err) {
        fail(`Connexion impossible à ${url} : ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  disconnect(): void {
    if (this.abortConnect) {
      // Connexion encore en cours : sa promesse est rejetée, la session repasse hors ligne.
      this.abortConnect('Connexion annulée');
      this.patch({ error: null });
      this.setInfo(IDLE);
      return;
    }
    if (!this.provider) {
      if (this.info.phase !== 'idle') this.setInfo(IDLE);
      return;
    }
    this.teardown();
    this.patch({ status: 'offline', url: null, room: null, peers: [], error: null });
    this.setInfo(IDLE);
  }

  retryNow(): void {
    this.provider?.retryNow();
  }

  getConnection(): ConnectionInfo {
    return this.info;
  }

  onConnection(cb: (info: ConnectionInfo) => void): () => void {
    this.infoListeners.add(cb);
    return () => {
      this.infoListeners.delete(cb);
    };
  }

  createInvite(opts: InviteOptions = {}): Promise<InviteCreated> {
    if (!this.provider) return Promise.reject(new Error('Hors session'));
    return this.provider.request<InviteCreated>('invite.create', { ttlMs: opts.ttlMs, maxUses: opts.maxUses, label: opts.label });
  }

  listInvites(): Promise<InviteInfo[]> {
    if (!this.provider) return Promise.reject(new Error('Hors session'));
    return this.provider.request<InviteInfo[]>('invite.list');
  }

  async revokeInvite(id: string): Promise<void> {
    if (!this.provider) throw new Error('Hors session');
    await this.provider.request('invite.revoke', { id });
  }

  setPresence(patch: Partial<PresenceState>): void {
    if (!this.provider) return;
    this.pendingPresence = { ...this.pendingPresence, ...patch };
    if (this.presenceTimer !== null) return;
    const wait = PRESENCE_INTERVAL_MS - (Date.now() - this.lastPresenceSent);
    if (wait <= 0) this.flushPresence();
    else this.presenceTimer = setTimeout(() => this.flushPresence(), wait);
  }

  getPeers(): Peer[] {
    return this.peers;
  }

  onPeers(cb: (peers: Peer[]) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  // ------------------------------------------------------------------ interne

  private patch(patch: Partial<SessionState>): void {
    // Ne touche jamais à `hosting` / `shareAddresses`, gérés par l'application ; n'écrit que ce qui change.
    const session = this.app.store.getState().session;
    if ((Object.keys(patch) as (keyof SessionState)[]).every((k) => session[k] === patch[k])) return;
    this.app.store.setState({ session: { ...session, ...patch } });
  }

  private setInfo(info: ConnectionInfo): void {
    if (sameInfo(info, this.info)) return;
    this.info = info;
    for (const cb of [...this.infoListeners]) {
      try {
        cb(info);
      } catch (err) {
        console.error('[collab] erreur dans un écouteur de connexion', err);
      }
    }
  }

  private onProviderStatus(snap: ProviderSnapshot): void {
    if (snap.phase === 'stopped') return; // refus définitif ou fin : traité par onClosed / teardown
    let phase: ConnectionPhase;
    if (!this.established) phase = 'connecting';
    else if (snap.phase === 'connected') phase = 'connected';
    else {
      const navOffline = typeof navigator !== 'undefined' && (navigator as Navigator).onLine === false;
      phase = navOffline || snap.attempt >= OFFLINE_AFTER_ATTEMPTS ? 'offline' : 'reconnecting';
    }
    if (this.established) this.patch({ status: snap.phase === 'connected' ? 'connected' : 'reconnecting' });
    const hello = snap.hello;
    this.setInfo({
      ...this.info,
      phase,
      error: null,
      errorKind: null,
      attempt: snap.attempt,
      nextRetryAt: snap.phase === 'waiting' ? snap.nextRetryAt : null,
      latencyMs: snap.phase === 'connected' ? snap.latencyMs : null,
      pendingChanges: snap.pending,
      serverVersion: hello?.server ?? this.info.serverVersion,
      protocol: hello ? hello.protocol : snap.phase === 'connected' ? 1 : this.info.protocol,
      // Ancien serveur (sans HELLO) : tout participant est administrateur de fait.
      role: hello ? hello.role : snap.phase === 'connected' ? 'admin' : this.info.role,
      secured: hello ? hello.secured : this.info.secured,
      inviteToken: hello?.role === 'guest' ? this.token : this.info.inviteToken,
      transfer: snap.transfer,
    });
  }

  private refuse(message: string, kind: ConnectionErrorKind): Promise<void> {
    this.patch({ status: 'offline', url: null, room: null, peers: [], error: message });
    this.setInfo({ ...IDLE, phase: 'error', error: message, errorKind: kind });
    return Promise.reject(new Error(message));
  }

  private defaultPresence(): PresenceState {
    return { user: this.app.store.getState().user, camera: null, pointer: null, selection: [], activeId: null, mode: 'object', editVerts: [] };
  }

  private flushPresence(): void {
    if (this.presenceTimer !== null) clearTimeout(this.presenceTimer);
    this.presenceTimer = null;
    const pending = this.pendingPresence;
    this.pendingPresence = null;
    if (!pending || !this.awareness) return;
    const current = (this.awareness.getLocalState() as PresenceState | null) ?? this.defaultPresence();
    const next: PresenceState = { ...current, ...pending };
    if (next.editVerts.length > MAX_EDIT_VERTS) next.editVerts = next.editVerts.slice(0, MAX_EDIT_VERTS);
    this.lastPresenceSent = Date.now();
    this.awareness.setLocalState(next);
  }

  private onAwarenessChange = (): void => {
    this.refreshPeers();
  };

  private refreshPeers(): void {
    const awareness = this.awareness;
    const peers: Peer[] = [];
    if (awareness) {
      const self = awareness.clientID;
      awareness.getStates().forEach((raw, clientId) => {
        if (clientId === self) return;
        const state = readPresence(raw);
        if (state) peers.push({ clientId, state });
      });
      peers.sort((a, b) => a.clientId - b.clientId);
    }
    this.peers = peers;

    // Le store n'est mis à jour que si la liste ou les identités changent (pas à chaque mouvement de caméra).
    const key = peers.map((p) => `${p.clientId}\u0000${p.state.user.id}\u0000${p.state.user.name}\u0000${p.state.user.color}`).join('\u0001');
    if (key !== this.peersKey) {
      this.peersKey = key;
      const infos: PeerInfo[] = peers.map((p) => ({ clientId: p.clientId, userId: p.state.user.id, name: p.state.user.name, color: p.state.user.color }));
      this.patch({ peers: infos });
    }
    for (const cb of [...this.listeners]) {
      try {
        cb(peers);
      } catch (err) {
        console.error('[collab] erreur dans un écouteur de présence', err);
      }
    }
  }

  /** Détruit le fournisseur et la présence, sans toucher au store. */
  private teardown(): void {
    const provider = this.provider;
    const awareness = this.awareness;
    this.provider = null;
    this.awareness = null;
    this.doc = null;
    this.established = false;
    this.token = null;
    if (this.presenceTimer !== null) clearTimeout(this.presenceTimer);
    this.presenceTimer = null;
    this.pendingPresence = null;
    if (awareness) awareness.off('change', this.onAwarenessChange);
    try {
      provider?.destroy();
    } catch (err) {
      console.error('[collab] erreur à la fermeture de la connexion', err);
    }
    try {
      awareness?.destroy();
    } catch {
      /* le document a pu être détruit avant la déconnexion */
    }
    const hadPeers = this.peers.length > 0;
    this.peers = [];
    this.peersKey = '';
    if (hadPeers) {
      for (const cb of [...this.listeners]) {
        try {
          cb(this.peers);
        } catch (err) {
          console.error('[collab] erreur dans un écouteur de présence', err);
        }
      }
    }
  }
}

export function createCollab(app: AppContext): ICollab {
  return new Collab(app);
}
