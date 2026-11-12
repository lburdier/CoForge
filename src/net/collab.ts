import { WebsocketProvider } from 'y-websocket';
import type { Awareness } from 'y-protocols/awareness';
import type { AppContext } from '../app/context';
import type { PeerInfo, SessionState } from '../app/store';
import type { SceneDoc } from '../core/doc/SceneDoc';
import type { Vec3 } from '../core/doc/schema';
import type { ConnectOptions, ICollab, Peer, PresenceCamera, PresenceState } from './api';

/**
 * Client de collaboration : relie un SceneDoc à une room du serveur CoForge
 * (WebsocketProvider de y-websocket) et gère la présence (awareness Yjs).
 */

/** Délai maximal de la première synchronisation. */
const CONNECT_TIMEOUT_MS = 10_000;
/** Intervalle minimal entre deux envois de présence (~20/s). */
const PRESENCE_INTERVAL_MS = 50;
const MAX_EDIT_VERTS = 400;
/** Codes de fermeture définitifs du serveur (voir server/CollabServer.ts). */
const CLOSE_BAD_ROOM = 4400;
const CLOSE_BAD_PASSWORD = 4401;
const ROOM_NAME = /^[\w\-. ]{1,64}$/;

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

class Collab implements ICollab {
  private provider: WebsocketProvider | null = null;
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
  private abortConnect: ((message: string) => void) | null = null;

  constructor(private readonly app: AppContext) {
    // Le nom ou la couleur de l'utilisateur local change : les autres doivent le voir.
    app.store.subscribe((state, prev) => {
      if (state.user !== prev.user && this.provider) this.setPresence({ user: state.user });
    });
  }

  get connected(): boolean {
    return this.established && !!this.provider && this.provider.wsconnected;
  }

  get clientId(): number | null {
    return this.provider && this.doc ? this.doc.ydoc.clientID : null;
  }

  connect(doc: SceneDoc, opts: ConnectOptions): Promise<void> {
    // Un seul provider à la fois.
    if (this.provider || this.abortConnect) this.disconnect();

    const url = normalizeServerUrl(opts.url);
    const room = opts.room.trim();
    if (!url) return this.refuse(`Adresse de serveur invalide : « ${opts.url} »`);
    if (!ROOM_NAME.test(room)) return this.refuse('Nom de session invalide (64 caractères au plus : lettres, chiffres, espaces, tirets, points)');

    this.patch({ status: 'connecting', url, room, error: null, peers: [] });

    let provider: WebsocketProvider;
    try {
      provider = new WebsocketProvider(url, room, doc.ydoc, {
        connect: false,
        params: opts.password ? { password: opts.password } : {},
        // Pas de canal inter-onglets : tout passe par le serveur (et son mot de passe).
        disableBc: true,
      });
    } catch (err) {
      return this.refuse(`Connexion impossible : ${err instanceof Error ? err.message : String(err)}`);
    }
    const awareness = provider.awareness;
    this.provider = provider;
    this.awareness = awareness;
    this.doc = doc;
    this.established = false;
    awareness.setLocalState(this.defaultPresence());
    awareness.on('change', this.onAwarenessChange);

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (message: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.abortConnect = null;
        if (this.provider === provider) {
          this.teardown();
          this.patch({ status: 'offline', url: null, room: null, peers: [], error: message });
        }
        reject(new Error(message));
      };
      const timeout = setTimeout(() => fail(`Serveur injoignable à l'adresse ${url}`), CONNECT_TIMEOUT_MS);
      this.abortConnect = fail;

      provider.on('sync', (synced: boolean) => {
        if (this.provider !== provider || !synced) return;
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          this.abortConnect = null;
          this.established = true;
          this.patch({ status: 'connected', error: null });
          this.refreshPeers();
          resolve();
        } else {
          this.patch({ status: 'connected', error: null });
        }
      });

      provider.on('status', (event: { status: string }) => {
        if (this.provider !== provider || !this.established) return;
        if (event.status !== 'connected') this.patch({ status: 'reconnecting' });
      });

      // Fermeture définitive décidée par le serveur (codes 44xx) : le provider a déjà cessé de se reconnecter.
      provider.on('closed', (event: { code: number; reason: string }) => {
        if (this.provider !== provider) return;
        const message =
          event.code === CLOSE_BAD_PASSWORD
            ? 'Mot de passe refusé'
            : event.code === CLOSE_BAD_ROOM
              ? 'Nom de session refusé par le serveur'
              : `Connexion fermée par le serveur (code ${event.code})`;
        if (!settled) {
          fail(message);
        } else {
          // Refus survenu lors d'une reconnexion (ex. mot de passe changé par l'hôte).
          this.teardown();
          this.patch({ status: 'offline', url: null, room: null, peers: [], error: message });
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
      return;
    }
    if (!this.provider) return;
    this.teardown();
    this.patch({ status: 'offline', url: null, room: null, peers: [], error: null });
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
    // Ne touche jamais à `hosting` / `shareAddresses`, gérés par l'application.
    this.app.store.setState({ session: { ...this.app.store.getState().session, ...patch } });
  }

  private refuse(message: string): Promise<void> {
    this.patch({ status: 'offline', url: null, room: null, peers: [], error: message });
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

  /** Détruit le provider et la présence, sans toucher au store. */
  private teardown(): void {
    const provider = this.provider;
    const awareness = this.awareness;
    this.provider = null;
    this.awareness = null;
    this.doc = null;
    this.established = false;
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
