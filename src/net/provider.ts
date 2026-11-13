import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import type * as Y from 'yjs';
import {
  CHUNK_THRESHOLD,
  ChunkAssembler,
  CLOSE_BAD_TOKEN,
  encodeJson,
  encodePing,
  type HelloMessage,
  MIN_SERVER_PROTOCOL,
  MSG_AWARENESS,
  MSG_CHUNK,
  MSG_HELLO,
  MSG_PING,
  MSG_PONG,
  MSG_QUERY_AWARENESS,
  MSG_RPC,
  MSG_RPC_REPLY,
  MSG_SYNC,
  PROTOCOL_VERSION,
  readJson,
  type RpcReply,
  type RpcRequest,
  splitMessage,
} from './protocol';

/**
 * Fournisseur réseau CoForge : relie un Y.Doc et sa présence (Awareness) à une room du
 * serveur. Remplace le WebsocketProvider de y-websocket, dont il parle le protocole, avec :
 *
 *  - battement de cœur applicatif (PING/PONG toutes les 4 s) : détection d'une connexion
 *    morte en ~15 s (au lieu de 30 s), latence mesurée, accusé de réception des modifications ;
 *  - détection de la veille / du gel du processus (saut d'horloge) : sonde rapide au réveil ;
 *  - reconnexion avec attente exponentielle ET aléatoire (0,25 s → 15 s), état exposé
 *    (tentative n, prochaine dans x s) et « Réessayer maintenant » ;
 *  - gros messages découpés en morceaux de 256 Ko, envoyés au rythme du réseau ;
 *  - resynchronisation complète à chaque reconnexion (étapes 1 et 2 dans les deux sens) :
 *    les modifications faites hors ligne partent au retour ;
 *  - présence : on ne diffuse que la SIENNE (jamais l'expiration locale d'un pair).
 */

export type ProviderPhase = 'connecting' | 'syncing' | 'connected' | 'waiting' | 'stopped';

export interface ProviderCredentials {
  password?: string;
  /** Jeton d'invitation. */
  token?: string;
}

export interface ProviderOptions {
  /** ws(s)://hôte:port, sans barre finale. */
  url: string;
  room: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  credentials?: ProviderCredentials;
  /** Implémentation WebSocket (défaut : globale). */
  WebSocketImpl?: typeof WebSocket;
  pingIntervalMs?: number;
  /** Sans aucun signe de vie pendant ce délai, la connexion est déclarée morte. */
  deadAfterMs?: number;
  /** Délai d'ouverture d'un socket. */
  openTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export interface ProviderSnapshot {
  phase: ProviderPhase;
  /** Échecs consécutifs depuis la dernière synchronisation réussie. */
  attempt: number;
  /** Prochaine tentative (horodatage ms), en phase `waiting`. */
  nextRetryAt: number | null;
  latencyMs: number | null;
  /** Modifications locales pas encore confirmées par le serveur. */
  pending: number;
  hello: HelloMessage | null;
  /** Transfert d'un gros message en cours. */
  transfer: { direction: 'down' | 'up'; done: number; total: number } | null;
}

export interface PermanentClose {
  code: number;
  reason: string;
}

type Listener<T> = (value: T) => void;

const HIGH_WATER = 1024 * 1024;

export class CoforgeProvider {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  readonly url: string;
  readonly room: string;
  private credentials: ProviderCredentials;
  private ticket: string | null = null;
  private readonly WS: typeof WebSocket;
  private readonly pingInterval: number;
  private readonly deadAfter: number;
  private readonly openTimeout: number;
  private readonly backoffBase: number;
  private readonly backoffMax: number;

  private ws: WebSocket | null = null;
  private shouldConnect = false;
  private phase: ProviderPhase = 'stopped';
  private attempt = 0;
  private nextRetryAt: number | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private openedAt = 0;
  private lastLife = 0;
  private lastBuffered = 0;
  private hello: HelloMessage | null = null;
  private synced = false;
  /** PING envoyé après notre étape 2 : son PONG termine la synchronisation. */
  private syncPing: number | null = null;
  /** Au moins une connexion a été ouverte depuis connect(). */
  everOpened = false;
  private latency: number | null = null;
  private pingSeq = 0;
  private pingMarks = new Map<number, number>();
  private localSeq = 0;
  private ackedSeq = 0;
  private assembler = new ChunkAssembler();
  private outQueue: Uint8Array[] = [];
  private outBytes = 0;
  private outTotal = 0;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private chunkIds = 0;
  private rpcSeq = 0;
  private rpcPending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private lastEmit = 0;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  private statusListeners = new Set<Listener<ProviderSnapshot>>();
  private syncedListeners = new Set<Listener<void>>();
  private closedListeners = new Set<Listener<PermanentClose>>();
  private destroyed = false;

  constructor(opts: ProviderOptions) {
    this.doc = opts.doc;
    this.awareness = opts.awareness;
    this.url = opts.url.replace(/\/+$/, '');
    this.room = opts.room;
    this.credentials = { ...opts.credentials };
    this.WS = opts.WebSocketImpl ?? (globalThis.WebSocket as typeof WebSocket);
    this.pingInterval = opts.pingIntervalMs ?? 4000;
    this.deadAfter = opts.deadAfterMs ?? 15_000;
    this.openTimeout = opts.openTimeoutMs ?? 8000;
    this.backoffBase = opts.backoffBaseMs ?? 500;
    this.backoffMax = opts.backoffMaxMs ?? 15_000;
    this.doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('online', this.onOnline);
      window.addEventListener('offline', this.onOffline);
    }
  }

  // ------------------------------------------------------------------ API

  onStatus(cb: Listener<ProviderSnapshot>): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  onSynced(cb: Listener<void>): () => void {
    this.syncedListeners.add(cb);
    return () => this.syncedListeners.delete(cb);
  }

  /** Fermeture définitive décidée par le serveur (codes 4400-4499) : plus de reconnexion. */
  onClosed(cb: Listener<PermanentClose>): () => void {
    this.closedListeners.add(cb);
    return () => this.closedListeners.delete(cb);
  }

  get isSynced(): boolean {
    return this.synced && this.phase === 'connected';
  }

  get serverHello(): HelloMessage | null {
    return this.hello;
  }

  snapshot(): ProviderSnapshot {
    const progress = this.assembler.progress;
    let transfer: ProviderSnapshot['transfer'] = null;
    if (progress) transfer = { direction: 'down', done: progress.received, total: progress.total };
    else if (this.outBytes > CHUNK_THRESHOLD) transfer = { direction: 'up', done: this.outTotal - this.outBytes, total: this.outTotal };
    return {
      phase: this.phase,
      attempt: this.attempt,
      nextRetryAt: this.nextRetryAt,
      latencyMs: this.latency,
      pending: Math.max(0, this.localSeq - this.ackedSeq),
      hello: this.hello,
      transfer,
    };
  }

  connect(): void {
    if (this.destroyed) return;
    this.shouldConnect = true;
    if (!this.ws && this.retryTimer === null) this.open();
    if (this.tickTimer === null) {
      this.lastTick = Date.now();
      this.tickTimer = setInterval(this.tick, Math.min(this.pingInterval, 1000));
    }
  }

  /** Abandonne l'attente en cours et retente tout de suite. */
  retryNow(): void {
    if (!this.shouldConnect || this.destroyed) return;
    if (this.ws) return; // une tentative est déjà en cours
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.open();
  }

  /** Appel au serveur (invitations). Rejette hors connexion ou si le serveur ne le gère pas. */
  request<T>(method: RpcRequest['method'], params?: Record<string, unknown>): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== this.WS.OPEN || !this.synced) return Promise.reject(new Error('Pas de connexion au serveur'));
    if (!this.hello || this.hello.protocol < 2) return Promise.reject(new Error('Ce serveur est trop ancien pour gérer les invitations'));
    const id = ++this.rpcSeq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rpcPending.delete(id);
        reject(new Error('Le serveur ne répond pas'));
      }, 10_000);
      this.rpcPending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send(encodeJson(MSG_RPC, { id, method, params } satisfies RpcRequest));
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    // Prévenir les autres tout de suite que l'on part (sinon ils attendraient l'expiration).
    const ws = this.ws;
    if (ws && ws.readyState === this.WS.OPEN) {
      try {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_AWARENESS);
        encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID], new Map()));
        ws.send(encoding.toUint8Array(enc));
      } catch {
        /* socket déjà en fermeture */
      }
    }
    this.destroyed = true;
    this.shouldConnect = false;
    this.closeSocket(1000, 'fin');
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    if (this.pumpTimer !== null) clearTimeout(this.pumpTimer);
    if (this.emitTimer !== null) clearTimeout(this.emitTimer);
    this.retryTimer = this.tickTimer = this.pumpTimer = this.emitTimer = null;
    this.doc.off('update', this.onDocUpdate);
    this.awareness.off('update', this.onAwarenessUpdate);
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('online', this.onOnline);
      window.removeEventListener('offline', this.onOffline);
    }
    this.rejectRpcs('Connexion fermée');
    this.phase = 'stopped';
    this.statusListeners.clear();
    this.syncedListeners.clear();
    this.closedListeners.clear();
  }

  // ------------------------------------------------------------------ socket

  private buildUrl(): string {
    const q: string[] = [`v=${PROTOCOL_VERSION}`];
    const c = this.credentials;
    if (this.ticket) q.push(`ticket=${encodeURIComponent(this.ticket)}`);
    else if (c.token) q.push(`token=${encodeURIComponent(c.token)}`);
    if (c.password) q.push(`password=${encodeURIComponent(c.password)}`);
    return `${this.url}/${encodeURIComponent(this.room)}?${q.join('&')}`;
  }

  private open(): void {
    if (!this.shouldConnect || this.ws || this.destroyed) return;
    this.retryTimer = null;
    this.nextRetryAt = null;
    let ws: WebSocket;
    try {
      ws = new this.WS(this.buildUrl());
    } catch {
      this.scheduleRetry();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.openedAt = Date.now();
    this.synced = false;
    this.syncPing = null;
    this.hello = null;
    this.assembler.reset();
    this.setPhase('connecting');
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.everOpened = true;
      this.lastLife = Date.now();
      this.lastBuffered = 0;
      this.setPhase('syncing');
      // Toujours l'étape 1 à l'ouverture : le serveur répond avec ce qui nous manque.
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeSyncStep1(enc, this.doc);
      this.rawSend(ws, encoding.toUint8Array(enc));
      // Présence : réémise avec une horloge NEUVE. Sinon le serveur, qui a retiré notre état à la
      // coupure mais garde son horloge, ignorerait cet état « déjà vu » jusqu'au renouvellement (15 s).
      const local = this.awareness.getLocalState();
      if (local !== null) this.awareness.setLocalState(local);
    };
    ws.onmessage = (event: MessageEvent) => {
      if (this.ws !== ws) return;
      this.lastLife = Date.now();
      const data = event.data;
      if (!(data instanceof ArrayBuffer)) return; // le serveur n'envoie jamais de texte
      try {
        this.handleMessage(ws, new Uint8Array(data));
      } catch (err) {
        console.error('[collab] message du serveur illisible', err);
      }
    };
    ws.onerror = () => {
      /* la fermeture suit toujours */
    };
    ws.onclose = (event: CloseEvent) => {
      if (this.ws !== ws) return;
      this.handleClose(event.code, event.reason ?? '');
    };
  }

  /** Ferme le socket courant sans attendre la poignée de main (une connexion à moitié morte ne répondrait pas). */
  private closeSocket(code: number, reason: string): void {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = () => {};
    try {
      if (ws.readyState === this.WS.CONNECTING || ws.readyState === this.WS.OPEN) ws.close(code, reason);
    } catch {
      /* déjà fermé */
    }
    this.afterSocketGone();
  }

  private afterSocketGone(): void {
    this.synced = false;
    this.syncPing = null;
    this.assembler.reset();
    this.outQueue = [];
    this.outBytes = 0;
    this.outTotal = 0;
    this.pingMarks.clear();
    this.rejectRpcs('Connexion perdue');
    // Les autres ne sont plus visibles tant que l'on n'est pas reconnecté (pas de présence fantôme).
    const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
    if (others.length) awarenessProtocol.removeAwarenessStates(this.awareness, others, this);
    // Oublie aussi leurs horloges : à la reconnexion, leurs états (même inchangés) seront acceptés.
    for (const id of others) this.awareness.meta.delete(id);
  }

  private handleClose(code: number, reason: string): void {
    this.ws = null;
    this.afterSocketGone();
    if (code >= 4400 && code < 4500) {
      // Ticket de reprise refusé (serveur redémarré sans persistance…) : on retente une fois avec l'invitation.
      if (code === CLOSE_BAD_TOKEN && this.ticket) {
        this.ticket = null;
        this.open();
        return;
      }
      this.shouldConnect = false;
      this.setPhase('stopped');
      for (const cb of [...this.closedListeners]) cb({ code, reason });
      return;
    }
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (!this.shouldConnect || this.destroyed) {
      this.setPhase('stopped');
      return;
    }
    this.attempt++;
    // Attente exponentielle avec gigue (50 à 100 % du palier) : les clients d'un serveur redémarré ne reviennent pas tous en même temps.
    const step = Math.min(this.backoffMax, this.backoffBase * 2 ** Math.min(16, this.attempt - 1));
    const delay = Math.round(step * (0.5 + Math.random() * 0.5));
    this.nextRetryAt = Date.now() + delay;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.open(), delay);
    this.setPhase('waiting');
  }

  // ------------------------------------------------------------------ messages

  private handleMessage(ws: WebSocket, message: Uint8Array): void {
    const decoder = decoding.createDecoder(message);
    const type = decoding.readVarUint(decoder);
    switch (type) {
      case MSG_SYNC: {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MSG_SYNC);
        const kind = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
        if (encoding.length(encoder) > 1) this.send(encoding.toUint8Array(encoder));
        if (kind === syncProtocol.messageYjsSyncStep2 && !this.synced && this.syncPing === null) {
          // Nous avons tout ce que le serveur a. Synchronisé « dans les deux sens » seulement quand le
          // serveur a aussi reçu tout ce qui lui manquait (notre étape 2, peut-être lourde) : le PONG
          // d'un PING envoyé après elle le confirme. Serveur ancien (sans PONG) : tout de suite.
          if (this.hello) this.syncPing = this.sendPing(true);
          else this.finishSync();
        }
        break;
      }
      case MSG_AWARENESS:
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
        break;
      case MSG_QUERY_AWARENESS: {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_AWARENESS);
        encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
        this.send(encoding.toUint8Array(enc));
        break;
      }
      case MSG_HELLO: {
        const hello = readJson(decoder) as HelloMessage;
        if (!hello || typeof hello.protocol !== 'number' || hello.protocol < MIN_SERVER_PROTOCOL) {
          this.closeSocket(1002, 'version');
          this.shouldConnect = false;
          this.setPhase('stopped');
          for (const cb of [...this.closedListeners]) cb({ code: 4426, reason: `server:${String(hello?.protocol)}` });
          return;
        }
        this.hello = hello;
        if (typeof hello.resume === 'string') this.ticket = hello.resume;
        this.emitSoon(true);
        break;
      }
      case MSG_PONG: {
        const seq = decoding.readVarUint(decoder);
        const time = decoding.readFloat64(decoder);
        const rtt = Date.now() - time;
        if (Number.isFinite(rtt) && rtt >= 0 && rtt < 120_000) this.latency = this.latency === null ? rtt : Math.round(this.latency * 0.6 + rtt * 0.4);
        if (this.syncPing !== null && seq >= this.syncPing && !this.synced) this.finishSync();
        const mark = this.pingMarks.get(seq);
        if (mark !== undefined) {
          for (const s of [...this.pingMarks.keys()]) if (s <= seq) this.pingMarks.delete(s);
          if (mark > this.ackedSeq) this.ackedSeq = mark;
        }
        this.emitSoon(false);
        break;
      }
      case MSG_CHUNK: {
        const full = this.assembler.push(decoder);
        if (full) {
          const inner = decoding.createDecoder(full);
          if (decoding.readVarUint(inner) !== MSG_CHUNK) this.handleMessage(ws, full);
        }
        this.emitSoon(false);
        break;
      }
      case MSG_RPC_REPLY: {
        const reply = readJson(decoder) as RpcReply;
        const pending = this.rpcPending.get(reply?.id);
        if (!pending) break;
        this.rpcPending.delete(reply.id);
        clearTimeout(pending.timer);
        if (reply.ok) pending.resolve(reply.result);
        else pending.reject(new Error(typeof reply.error === 'string' ? reply.error : 'Refusé par le serveur'));
        break;
      }
      default:
        break;
    }
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this) return;
    this.localSeq++;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    // Hors connexion, rien n'est mis en file : la resynchronisation par vecteurs d'état enverra tout au retour.
    this.send(encoding.toUint8Array(enc));
    this.emitSoon(false);
  };

  private onAwarenessUpdate = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown): void => {
    if (origin === this) return;
    // Seule notre propre présence est diffusée : l'expiration locale d'un pair ne doit pas l'effacer chez les autres.
    const self = this.doc.clientID;
    if (!added.includes(self) && !updated.includes(self) && !removed.includes(self)) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [self]));
    this.send(encoding.toUint8Array(enc));
  };

  /** Envoi ordonné : découpé et cadencé au-delà de CHUNK_THRESHOLD (serveur CoForge), direct sinon. */
  private send(message: Uint8Array): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== this.WS.OPEN) return;
    const canChunk = !!this.hello?.features.includes('chunk');
    if (canChunk && message.byteLength > CHUNK_THRESHOLD) {
      const parts = splitMessage(++this.chunkIds, message);
      if (this.outBytes === 0) this.outTotal = 0;
      for (const p of parts) {
        this.outQueue.push(p);
        this.outBytes += p.byteLength;
        this.outTotal += p.byteLength;
      }
      this.pump();
      return;
    }
    if (this.outQueue.length) {
      this.outQueue.push(message);
      this.outBytes += message.byteLength;
      this.outTotal += message.byteLength;
      return;
    }
    this.rawSend(ws, message);
  }

  private rawSend(ws: WebSocket, message: Uint8Array): void {
    try {
      ws.send(message as Uint8Array<ArrayBuffer>);
    } catch {
      // Socket en fermeture : la reconnexion resynchronisera.
    }
  }

  private pump = (): void => {
    this.pumpTimer = null;
    const ws = this.ws;
    if (!ws || ws.readyState !== this.WS.OPEN) return;
    while (this.outQueue.length && ws.bufferedAmount < HIGH_WATER) {
      const m = this.outQueue.shift()!;
      this.outBytes -= m.byteLength;
      this.rawSend(ws, m);
    }
    if (this.outQueue.length) this.pumpTimer = setTimeout(this.pump, 15);
    this.emitSoon(false);
  };

  private finishSync(): void {
    this.synced = true;
    this.syncPing = null;
    this.attempt = 0;
    this.nextRetryAt = null;
    // Serveur sans accusé de réception (ancien) : on considère que tout est parti.
    if (!this.hello) this.ackedSeq = this.localSeq;
    this.setPhase('connected');
    for (const cb of [...this.syncedListeners]) cb();
  }

  private sendPing(afterSync: boolean): number | null {
    const ws = this.ws;
    if (!ws || ws.readyState !== this.WS.OPEN || !this.hello) return null;
    const seq = ++this.pingSeq;
    // Avant la synchronisation, notre étape 2 n'est peut-être pas encore partie : pas d'accusé possible.
    this.pingMarks.set(seq, afterSync || this.synced ? this.localSeq : this.ackedSeq);
    // Après la file des gros messages : le PONG confirme aussi leur arrivée.
    this.send(encodePing(MSG_PING, seq, Date.now()));
    return seq;
  }

  // ------------------------------------------------------------------ battement de cœur

  private tick = (): void => {
    const now = Date.now();
    const gap = now - this.lastTick;
    this.lastTick = now;
    const ws = this.ws;
    if (!ws) return;
    if (ws.readyState === this.WS.CONNECTING) {
      if (now - this.openedAt > this.openTimeout) {
        this.closeSocket(4000, 'delai');
        this.scheduleRetry();
      }
      return;
    }
    if (ws.readyState !== this.WS.OPEN) return;
    // Saut d'horloge (veille, processus gelé) : on ne conclut rien, mais on exige une réponse rapide.
    if (gap > 3000) {
      this.lastLife = Math.max(this.lastLife, now - this.deadAfter + Math.min(5000, this.deadAfter / 2));
      this.sendPing(false);
      return;
    }
    // Le tampon d'envoi se vide : le serveur reçoit (accusés TCP), la connexion est vivante.
    const buffered = ws.bufferedAmount + this.outBytes;
    if (buffered < this.lastBuffered) this.lastLife = now;
    this.lastBuffered = buffered;
    const deadAfter = this.hello ? this.deadAfter : Math.max(this.deadAfter, 35_000); // serveur ancien : pas de PONG
    if (now - this.lastLife > deadAfter) {
      this.closeSocket(4000, 'muet');
      this.scheduleRetry();
      return;
    }
    if (this.hello && now - this.lastPingAt >= this.pingInterval) {
      this.lastPingAt = now;
      this.sendPing(false);
    }
  };
  private lastPingAt = 0;

  private onOnline = (): void => {
    this.retryNow();
  };

  /** Le système signale la perte du réseau : on vérifie aussitôt la connexion au lieu d'attendre. */
  private onOffline = (): void => {
    if (!this.ws) return;
    this.lastLife = Math.min(this.lastLife, Date.now() - this.deadAfter + 3000);
    this.sendPing(false);
  };

  // ------------------------------------------------------------------ état

  private setPhase(phase: ProviderPhase): void {
    const changed = this.phase !== phase;
    this.phase = phase;
    this.emitSoon(changed);
  }

  /** Notifie l'état : tout de suite pour un changement de phase, au plus 5 fois par seconde sinon. */
  private emitSoon(now: boolean): void {
    if (this.statusListeners.size === 0) return;
    const t = Date.now();
    if (now || t - this.lastEmit > 200) {
      if (this.emitTimer !== null) clearTimeout(this.emitTimer);
      this.emitTimer = null;
      this.lastEmit = t;
      const snap = this.snapshot();
      for (const cb of [...this.statusListeners]) cb(snap);
      return;
    }
    if (this.emitTimer === null) this.emitTimer = setTimeout(() => this.emitSoon(true), 200);
  }

  private rejectRpcs(message: string): void {
    for (const [id, p] of this.rpcPending) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
      this.rpcPending.delete(id);
    }
  }
}
