import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import pkg from '../package.json';
import { buildInviteLink, isValidHost } from '../src/net/invite';
import {
  CHUNK_THRESHOLD,
  ChunkAssembler,
  CLOSE_BAD_PASSWORD,
  CLOSE_BAD_ROOM,
  CLOSE_BAD_TOKEN,
  CLOSE_REVOKED,
  CLOSE_ROOM_NOT_FOUND,
  CLOSE_TOO_MANY,
  CLOSE_VERSION,
  type ConnRole,
  encodeJson,
  encodePing,
  type HelloMessage,
  type InviteCreated,
  type InviteInfo,
  isValidRoomName as isValidRoom,
  isValidToken,
  MAX_FRAME_BYTES,
  MAX_MESSAGE_BYTES,
  MIN_CLIENT_PROTOCOL,
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
} from '../src/net/protocol';
import { InviteRegistry } from './invites';

/**
 * Serveur de collaboration CoForge : Node pur (ni Electron, ni DOM).
 *
 * Parle le protocole du client `y-websocket` (messages binaires lib0 dont le premier varUint
 * est le type : 0 = sync, 1 = présence, 3 = demande de présence) et ses extensions CoForge
 * (src/net/protocol.ts : HELLO, PING/PONG, découpage des gros messages, invitations).
 *
 * Une « room » = un Y.Doc + un Awareness. URL : ws://hôte:port/<room>?v=2&password=… (ou
 * &token=… pour une invitation, &ticket=… pour la reprise d'un invité).
 * Le serveur ne fait que relayer et persister : toute la logique de fusion est dans le CRDT.
 *
 * Robustesse :
 *  - battement de cœur : ping toutes les `heartbeatMs` ; une connexion sans aucun signe de vie
 *    (pong, message, ou vidage de son tampon d'envoi) pendant 3 périodes est coupée, et sa
 *    présence retirée ;
 *  - gros messages : découpés en morceaux de 256 Ko et envoyés au rythme du réseau (tampon
 *    d'envoi borné), compression permessage-deflate négociée ;
 *  - persistance : écriture dans un fichier temporaire, fsync, copie de secours `.bak`,
 *    puis renommage ; au chargement, repli sur `.bak` si le fichier principal est illisible ;
 *  - aucune erreur de socket ou de message ne remonte jusqu'au processus.
 */

export {
  CLOSE_BAD_PASSWORD,
  CLOSE_BAD_ROOM,
  CLOSE_BAD_TOKEN,
  CLOSE_REVOKED,
  CLOSE_ROOM_NOT_FOUND,
  CLOSE_TOO_MANY,
  CLOSE_VERSION,
} from '../src/net/protocol';

export const SERVER_VERSION: string = pkg.version;

const FILE_EXT = '.coforge';
const INVITES_FILE = 'invitations.json';
/** Envoi vers un client : on n'empile pas plus que ceci dans le tampon du socket (le reste attend en file). */
const SEND_HIGH_WATER = 2 * 1024 * 1024;
/** Un client qui accumule plus de ceci en file d'attente est trop lent : coupé (il se resynchronisera). */
const MAX_QUEUED_BYTES = 512 * 1024 * 1024;
/** Taille à partir de laquelle un message est compressé (permessage-deflate, ratio ~3,4 sur un maillage). */
const COMPRESS_MIN_BYTES = 64 * 1024;
/** Échecs d'authentification tolérés par adresse et par minute. */
const MAX_AUTH_FAILURES = 10;
const AUTH_WINDOW_MS = 60_000;

export function isValidRoomName(name: string): boolean {
  return isValidRoom(name);
}

export interface CollabServerOptions {
  /** 0 = port libre choisi par le système. */
  port: number;
  password?: string;
  /** Dossier de persistance des rooms (`<room>.coforge`) et des invitations. Sans lui, tout reste en mémoire. */
  dataDir?: string;
  /** Interface d'écoute (défaut : toutes, `0.0.0.0`). */
  host?: string;
  /** Sessions servies. Sans cette option, toute room valide est créée à la demande ; sinon, les autres sont refusées (code 4404). */
  rooms?: string[];
  /** Journal (défaut : silencieux). */
  log?: (message: string) => void;
  /** Anti-rebond de sauvegarde après la dernière modification (défaut 2000 ms). */
  saveDelayMs?: number;
  /** Délai maximal entre une modification et sa sauvegarde lors d'une édition continue (défaut 15000 ms). */
  maxSaveWaitMs?: number;
  /** Délai de déchargement d'une room vide (défaut 60000 ms). */
  unloadDelayMs?: number;
  /** Période du battement de cœur (défaut 5000 ms) ; une connexion muette pendant 3 périodes est coupée. */
  heartbeatMs?: number;
}

export interface RoomInfo {
  name: string;
  clients: number;
}

interface Conn {
  ws: WebSocket;
  /** Dernier signe de vie (pong, message reçu, ou progression de l'envoi). */
  lastLife: number;
  lastBuffered: number;
  /** clientID d'awareness annoncés par cette connexion (à retirer à sa fermeture). */
  clients: Set<number>;
  /** 0 = client y-websocket standard ; ≥ 2 = client CoForge. */
  protocol: number;
  role: ConnRole;
  /** Invitation utilisée pour entrer (invités). */
  inviteId: string | null;
  assembler: ChunkAssembler;
  queue: Uint8Array[];
  queuedBytes: number;
  pumping: boolean;
}

interface Room {
  /** Clé insensible à la casse (deux rooms ne différant que par la casse partageraient le même fichier sous Windows). */
  key: string;
  name: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  conns: Map<WebSocket, Conn>;
  file: string | null;
  dirty: boolean;
  dirtySince: number;
  saveTimer: ReturnType<typeof setTimeout> | null;
  unloadTimer: ReturnType<typeof setTimeout> | null;
  /** Chaîne des sauvegardes en cours (une seule écriture à la fois par room). */
  saving: Promise<void>;
  closed: boolean;
}

function toUint8(data: RawData): Uint8Array {
  if (Array.isArray(data)) {
    const buf = Buffer.concat(data);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function digest(text: string): Buffer {
  return crypto.createHash('sha256').update(text, 'utf8').digest();
}

function samePassword(expected: string, given: string): boolean {
  // Comparaison à temps constant sur des condensés de longueur fixe.
  return crypto.timingSafeEqual(digest(expected), digest(given));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export class CollabServer {
  private http: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private rooms = new Map<string, Room>();
  private password = '';
  private dataDir: string | null = null;
  private allowedRooms: Set<string> | null = null;
  private log: (message: string) => void = () => {};
  private saveDelay = 2000;
  private maxSaveWait = 15_000;
  private unloadDelay = 60_000;
  private heartbeatMs = 5000;
  private invites = new InviteRegistry();
  private authFailures = new Map<string, { count: number; since: number }>();
  private chunkIds = 0;

  /** Démarre l'écoute. Rejette (erreur Node, ex. code `EADDRINUSE`) si le port est indisponible. */
  async start(opts: CollabServerOptions): Promise<{ port: number }> {
    if (this.http) throw new Error('Le serveur est déjà démarré');
    this.password = opts.password ?? '';
    this.dataDir = opts.dataDir ? path.resolve(opts.dataDir) : null;
    this.allowedRooms = opts.rooms ? new Set(opts.rooms.map((r) => r.toLowerCase())) : null;
    this.log = opts.log ?? (() => {});
    this.saveDelay = opts.saveDelayMs ?? 2000;
    this.maxSaveWait = opts.maxSaveWaitMs ?? 15_000;
    this.unloadDelay = opts.unloadDelayMs ?? 60_000;
    this.heartbeatMs = Math.max(50, opts.heartbeatMs ?? 5000);
    if (this.dataDir) fs.mkdirSync(this.dataDir, { recursive: true });
    this.invites = new InviteRegistry(this.dataDir ? path.join(this.dataDir, INVITES_FILE) : null, this.log);

    const server = http.createServer((req, res) => {
      try {
        this.handleHttp(req, res);
      } catch (err) {
        this.log(`Requête HTTP en échec : ${errorText(err)}`);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.port, opts.host ?? '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', (err) => this.log(`Erreur HTTP : ${errorText(err)}`));
    server.on('clientError', (_err, socket) => socket.destroy());
    // Connexions inactives au niveau TCP : le système détecte aussi un pair disparu (en plus du battement de cœur).
    server.on('connection', (socket) => socket.setKeepAlive(true, 10_000));

    const wss = new WebSocketServer({
      server,
      maxPayload: MAX_FRAME_BYTES,
      // Compression : les mises à jour Yjs (coordonnées, identifiants) se compressent bien.
      // Seuls les gros messages sont compressés (voir rawSend) : compresser chaque petit message
      // sérialise les envois derrière zlib et fait grimper la latence (mesuré : 60 ms → 2,3 s en rafale).
      perMessageDeflate: { threshold: COMPRESS_MIN_BYTES, zlibDeflateOptions: { level: 1 }, concurrencyLimit: 4 },
    });
    wss.on('error', (err) => this.log(`Erreur WebSocket : ${errorText(err)}`));
    wss.on('connection', (ws, req) => {
      try {
        this.handleConnection(ws, req);
      } catch (err) {
        this.log(`Connexion refusée : ${errorText(err)}`);
        ws.terminate();
      }
    });

    this.http = server;
    this.wss = wss;
    this.heartbeat = setInterval(() => this.checkConnections(), this.heartbeatMs);
    return { port: (server.address() as AddressInfo).port };
  }

  /** Coupe les clients, sauvegarde toutes les rooms puis libère le port. Sans effet si le serveur est arrêté. */
  async stop(): Promise<void> {
    const server = this.http;
    const wss = this.wss;
    if (!server || !wss) return;
    this.http = null;
    this.wss = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;

    const rooms = [...this.rooms.values()];
    this.rooms.clear();
    for (const room of rooms) {
      room.closed = true;
      if (room.unloadTimer) clearTimeout(room.unloadTimer);
      room.unloadTimer = null;
      for (const conn of room.conns.values()) {
        try {
          conn.ws.close(1001, 'arret');
        } catch {
          conn.ws.terminate();
        }
      }
      room.conns.clear();
    }
    await Promise.all(rooms.map((room) => this.saveRoom(room)));
    for (const room of rooms) this.destroyRoom(room);
    this.invites.flush();

    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  getRooms(): RoomInfo[] {
    return [...this.rooms.values()].map((room) => ({ name: room.name, clients: room.conns.size }));
  }

  /** Le serveur exige un mot de passe ou une invitation. */
  get secured(): boolean {
    return this.password !== '';
  }

  // ------------------------------------------------------------------ invitations

  /** Crée une invitation pour `room` (jeton montré une seule fois). */
  createInvite(room: string, opts: { ttlMs?: number; maxUses?: number; label?: string } = {}): InviteCreated {
    if (!isValidRoomName(room)) throw new Error('Nom de session invalide');
    if (this.allowedRooms && !this.allowedRooms.has(room.toLowerCase())) throw new Error('Ce serveur ne sert pas cette session');
    return this.invites.create(room, opts);
  }

  listInvites(room?: string): InviteInfo[] {
    return this.invites.list(room);
  }

  /** Révoque une invitation et déconnecte les invités entrés avec elle. Renvoie le nombre de connexions coupées. */
  revokeInvite(id: string): number {
    if (!this.invites.revoke(id)) return 0;
    let kicked = 0;
    for (const room of this.rooms.values()) {
      for (const conn of room.conns.values()) {
        if (conn.inviteId === id) {
          kicked++;
          try {
            conn.ws.close(CLOSE_REVOKED, 'revoked');
          } catch {
            conn.ws.terminate();
          }
        }
      }
    }
    return kicked;
  }

  // ------------------------------------------------------------------ HTTP

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    let url: URL | null = null;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      /* URL illisible : 404 ci-dessous */
    }
    const pathname = url?.pathname ?? '';
    const json = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
    const get = req.method === 'GET' || req.method === 'HEAD';
    if (get && pathname === '/') {
      res.writeHead(200, json);
      res.end(
        req.method === 'HEAD'
          ? undefined
          : JSON.stringify({ name: 'coforge-server', version: SERVER_VERSION, protocol: PROTOCOL_VERSION, secured: this.secured, rooms: this.getRooms() }),
      );
      return;
    }
    if (get && (pathname === '/join' || pathname === '/join/') && url) {
      this.serveJoinPage(req, res, url);
      return;
    }
    res.writeHead(404, json);
    res.end(JSON.stringify({ error: 'introuvable' }));
  }

  /**
   * Page d'accueil d'un lien d'invitation web (http://hôte:port/join?room=…&token=…) : propose
   * d'ouvrir le lien coforge:// équivalent. Aucun script, aucune ressource externe.
   */
  private serveJoinPage(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const room = url.searchParams.get('room') ?? '';
    const token = url.searchParams.get('token');
    const hostHeader = (req.headers.host ?? '').toLowerCase();
    const hp = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(hostHeader);
    const tls = (req.headers['x-forwarded-proto'] ?? '') === 'https';
    const port = hp?.[2] ? Number(hp[2]) : tls ? 443 : 80;
    let link: string | null = null;
    if (hp && isValidHost(hp[1]) && isValidRoomName(room) && (token === null || isValidToken(token))) {
      try {
        link = buildInviteLink({ host: hp[1], port, room, token: token || null, tls });
      } catch {
        link = null;
      }
    }
    const body = link
      ? `<h1>Invitation CoForge</h1>
<p>Vous êtes invité(e) à rejoindre la session <b>${escapeHtml(room)}</b>.</p>
<p><a class="btn" href="${escapeHtml(link)}">Ouvrir dans CoForge</a></p>
<p class="dim">Rien ne se passe ? Installez CoForge, puis ouvrez <i>Session › Rejoindre</i> et collez ce lien :</p>
<pre>${escapeHtml(link)}</pre>`
      : `<h1>Lien d'invitation invalide</h1><p>Demandez un nouveau lien à l'hôte de la session.</p>`;
    res.writeHead(link ? 200 : 400, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Invitation CoForge</title>
<style>body{font:15px 'Segoe UI',system-ui,sans-serif;background:#1d1d1d;color:#e6e6e6;max-width:560px;margin:60px auto;padding:0 20px}
.btn{display:inline-block;background:#4772b3;color:#fff;padding:9px 18px;border-radius:4px;text-decoration:none}
pre{background:#303030;padding:10px;border-radius:4px;white-space:pre-wrap;word-break:break-all}.dim{color:#9a9a9a}</style></head>
<body>${body}</body></html>`);
  }

  // ------------------------------------------------------------------ connexions

  /** Trop d'échecs d'authentification récents depuis cette adresse ? */
  private throttled(ip: string): boolean {
    const f = this.authFailures.get(ip);
    if (!f) return false;
    if (Date.now() - f.since > AUTH_WINDOW_MS) {
      this.authFailures.delete(ip);
      return false;
    }
    return f.count >= MAX_AUTH_FAILURES;
  }

  private authFailed(ip: string): void {
    const f = this.authFailures.get(ip);
    if (!f || Date.now() - f.since > AUTH_WINDOW_MS) this.authFailures.set(ip, { count: 1, since: Date.now() });
    else f.count++;
  }

  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    // Toujours un écouteur d'erreur : une erreur de socket sans écouteur ferait tomber le processus.
    ws.on('error', (err) => {
      this.log(`Erreur de socket : ${errorText(err)}`);
      ws.terminate();
    });
    const ip = req.socket.remoteAddress ?? '?';

    let roomName = '';
    let params = new URLSearchParams();
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      roomName = decodeURIComponent(url.pathname.slice(1));
      params = url.searchParams;
    } catch {
      roomName = '';
    }

    // Négociation de version : un client sans `v` est un client y-websocket standard (accepté).
    const vText = params.get('v');
    const protocol = vText === null ? 0 : /^\d{1,4}$/.test(vText) ? Number(vText) : -1;
    if (protocol !== 0 && protocol < MIN_CLIENT_PROTOCOL) {
      ws.close(CLOSE_VERSION, `version:${MIN_CLIENT_PROTOCOL}-${PROTOCOL_VERSION}`);
      return;
    }

    if (this.throttled(ip)) {
      ws.close(CLOSE_TOO_MANY, 'too-many');
      return;
    }

    // Authentification : mot de passe (administrateur), invitation ou ticket de reprise (invité).
    let role: ConnRole = 'admin';
    let inviteId: string | null = null;
    let resume: string | undefined;
    const given = params.get('password') ?? '';
    const token = params.get('token');
    const ticket = params.get('ticket');
    if (!isValidRoomName(roomName)) {
      ws.close(CLOSE_BAD_ROOM, 'room');
      return;
    }
    if (this.password !== '') {
      if (given !== '' && samePassword(this.password, given)) {
        role = 'admin';
      } else if (ticket && isValidToken(ticket) && (inviteId = this.invites.resume(ticket, roomName))) {
        role = 'guest';
        resume = ticket;
      } else if (token && isValidToken(token)) {
        const check = this.invites.use(token, roomName);
        if (!check.ok) {
          this.authFailed(ip);
          ws.close(CLOSE_BAD_TOKEN, check.reason);
          return;
        }
        role = 'guest';
        inviteId = check.inviteId;
        resume = this.invites.issueTicket(check.inviteId, roomName);
      } else {
        this.authFailed(ip);
        if (token !== null || ticket !== null) ws.close(CLOSE_BAD_TOKEN, ticket !== null ? 'ticket' : 'unknown');
        else ws.close(CLOSE_BAD_PASSWORD, 'password');
        return;
      }
    }
    if (this.allowedRooms && !this.allowedRooms.has(roomName.toLowerCase())) {
      ws.close(CLOSE_ROOM_NOT_FOUND, 'room-not-found');
      return;
    }

    const room = this.openRoom(roomName);
    const conn: Conn = {
      ws,
      lastLife: Date.now(),
      lastBuffered: 0,
      clients: new Set(),
      protocol,
      role,
      inviteId,
      assembler: new ChunkAssembler(MAX_MESSAGE_BYTES),
      queue: [],
      queuedBytes: 0,
      pumping: false,
    };
    room.conns.set(ws, conn);
    if (room.unloadTimer) clearTimeout(room.unloadTimer);
    room.unloadTimer = null;

    ws.on('pong', () => {
      conn.lastLife = Date.now();
    });
    ws.on('close', () => this.handleClose(room, conn));
    ws.on('message', (data, isBinary) => {
      conn.lastLife = Date.now();
      if (!isBinary || room.closed) return;
      try {
        this.handleMessage(room, conn, toUint8(data));
      } catch (err) {
        // Message invalide : on l'ignore, la connexion et le serveur continuent.
        this.log(`Message invalide ignoré (room « ${room.name} ») : ${errorText(err)}`);
      }
    });

    if (protocol >= 2) {
      const hello: HelloMessage = {
        protocol: Math.min(protocol, PROTOCOL_VERSION),
        server: SERVER_VERSION,
        role,
        room: room.name,
        features: ['chunk', 'ping', 'invite'],
        secured: this.secured,
        resume,
      };
      this.send(conn, encodeJson(MSG_HELLO, hello));
    }
    // Ouverture : étape 1 de synchronisation, puis la présence déjà connue.
    const sync = encoding.createEncoder();
    encoding.writeVarUint(sync, MSG_SYNC);
    syncProtocol.writeSyncStep1(sync, room.doc);
    this.send(conn, encoding.toUint8Array(sync));
    const states = room.awareness.getStates();
    if (states.size > 0) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()]));
      this.send(conn, encoding.toUint8Array(enc));
    }
  }

  private handleMessage(room: Room, conn: Conn, message: Uint8Array): void {
    const decoder = decoding.createDecoder(message);
    const type = decoding.readVarUint(decoder);
    switch (type) {
      case MSG_SYNC: {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MSG_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, room.doc, conn);
        // Une réponse existe seulement si l'encodeur contient plus que l'octet de type.
        if (encoding.length(encoder) > 1) this.send(conn, encoding.toUint8Array(encoder));
        break;
      }
      case MSG_AWARENESS:
        awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), conn);
        break;
      case MSG_QUERY_AWARENESS: {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MSG_AWARENESS);
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...room.awareness.getStates().keys()]));
        this.send(conn, encoding.toUint8Array(encoder));
        break;
      }
      case MSG_CHUNK: {
        if (conn.protocol < 2) break;
        let full: Uint8Array | null;
        try {
          full = conn.assembler.push(decoder);
        } catch (err) {
          // Flux de morceaux incohérent : la connexion n'est plus fiable, le client se resynchronisera.
          this.log(`Morceaux invalides (room « ${room.name} ») : ${errorText(err)}`);
          conn.ws.close(1002, 'chunk');
          break;
        }
        if (full) {
          const inner = decoding.createDecoder(full);
          if (decoding.readVarUint(inner) === MSG_CHUNK) break; // pas de morceaux imbriqués
          this.handleMessage(room, conn, full);
        }
        break;
      }
      case MSG_PING: {
        if (conn.protocol < 2) break;
        const seq = decoding.readVarUint(decoder);
        const time = decoding.readFloat64(decoder);
        // Répondu après le traitement de tout ce qui précède : un PONG vaut accusé de réception.
        this.send(conn, encodePing(MSG_PONG, seq, time));
        break;
      }
      case MSG_RPC: {
        if (conn.protocol < 2) break;
        this.handleRpc(room, conn, readJson(decoder) as RpcRequest);
        break;
      }
      default:
        break; // type inconnu (ex. 2 = auth) : ignoré
    }
  }

  private handleRpc(room: Room, conn: Conn, req: RpcRequest): void {
    const id = typeof req?.id === 'number' ? req.id : -1;
    const reply = (r: Omit<RpcReply, 'id'>) => this.send(conn, encodeJson(MSG_RPC_REPLY, { id, ...r }));
    try {
      const params = (req.params && typeof req.params === 'object' ? req.params : {}) as Record<string, unknown>;
      // Les invitations ne servent qu'à un serveur protégé ; seuls les administrateurs les gèrent.
      if (req.method === 'invite.create' || req.method === 'invite.revoke' || req.method === 'invite.list') {
        if (conn.role !== 'admin') throw new Error('Seul un participant entré avec le mot de passe peut gérer les invitations');
        if (!this.secured) throw new Error('Session ouverte (sans mot de passe) : aucune invitation n’est nécessaire');
      }
      switch (req.method) {
        case 'invite.create':
          reply({
            ok: true,
            result: this.createInvite(room.name, {
              ttlMs: typeof params.ttlMs === 'number' ? params.ttlMs : undefined,
              maxUses: typeof params.maxUses === 'number' ? params.maxUses : undefined,
              label: typeof params.label === 'string' ? params.label : undefined,
            }),
          });
          return;
        case 'invite.list':
          reply({ ok: true, result: this.listInvites(room.name) });
          return;
        case 'invite.revoke': {
          const target = typeof params.id === 'string' ? params.id : '';
          if (!this.listInvites(room.name).some((i) => i.id === target)) throw new Error('Invitation introuvable');
          reply({ ok: true, result: { kicked: this.revokeInvite(target) } });
          return;
        }
        default:
          throw new Error('Méthode inconnue');
      }
    } catch (err) {
      reply({ ok: false, error: errorText(err) });
    }
  }

  private handleClose(room: Room, conn: Conn): void {
    conn.queue = [];
    conn.queuedBytes = 0;
    if (room.closed || !room.conns.delete(conn.ws)) return;
    // Retire la présence de ce client pour tous les autres (sauf les identifiants repris entre-temps par une nouvelle connexion).
    const owned = [...conn.clients].filter((id) => ![...room.conns.values()].some((c) => c.clients.has(id)));
    if (owned.length) {
      awarenessProtocol.removeAwarenessStates(room.awareness, owned, null);
      // Horloges oubliées : le même client, revenu par une nouvelle connexion, sera de nouveau accepté.
      for (const id of owned) room.awareness.meta.delete(id);
    }
    if (room.conns.size > 0) return;
    void this.saveRoom(room);
    if (!room.file) return; // sans persistance, la room vit tant que le serveur tourne
    if (room.unloadTimer) clearTimeout(room.unloadTimer);
    room.unloadTimer = setTimeout(() => {
      room.unloadTimer = null;
      void this.saveRoom(room).then(() => {
        if (room.closed || room.conns.size > 0 || room.dirty || this.rooms.get(room.key) !== room) return;
        this.rooms.delete(room.key);
        this.destroyRoom(room);
      });
    }, this.unloadDelay);
  }

  /** Envoie un message ; découpé et cadencé pour les clients CoForge, direct pour les autres. */
  private send(conn: Conn, message: Uint8Array, chunks?: Uint8Array[]): void {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    if (conn.protocol >= 2 && message.byteLength > CHUNK_THRESHOLD) {
      for (const c of chunks ?? splitMessage(++this.chunkIds, message)) this.enqueue(conn, c);
      return;
    }
    if (conn.queue.length > 0 || conn.ws.bufferedAmount > SEND_HIGH_WATER) {
      this.enqueue(conn, message);
      return;
    }
    this.rawSend(conn, message);
  }

  private rawSend(conn: Conn, message: Uint8Array): void {
    try {
      conn.ws.send(message, { binary: true, compress: message.byteLength >= COMPRESS_MIN_BYTES }, (err) => {
        if (err) conn.ws.terminate();
      });
    } catch {
      conn.ws.terminate();
    }
  }

  private enqueue(conn: Conn, message: Uint8Array): void {
    conn.queue.push(message);
    conn.queuedBytes += message.byteLength;
    if (conn.queuedBytes > MAX_QUEUED_BYTES) {
      this.log('Client trop lent (file d’envoi saturée) : déconnecté, il se resynchronisera');
      conn.ws.terminate();
      return;
    }
    this.pump(conn);
  }

  /** Vide la file d'attente au rythme du socket. */
  private pump(conn: Conn): void {
    if (conn.pumping) return;
    while (conn.queue.length && conn.ws.readyState === WebSocket.OPEN && conn.ws.bufferedAmount <= SEND_HIGH_WATER) {
      const m = conn.queue.shift()!;
      conn.queuedBytes -= m.byteLength;
      this.rawSend(conn, m);
    }
    if (conn.queue.length && conn.ws.readyState === WebSocket.OPEN) {
      conn.pumping = true;
      setTimeout(() => {
        conn.pumping = false;
        this.pump(conn);
      }, 15);
    }
  }

  private checkConnections(): void {
    const now = Date.now();
    const deadAfter = this.heartbeatMs * 3;
    for (const room of this.rooms.values()) {
      for (const conn of room.conns.values()) {
        // Le tampon d'envoi se vide : le pair accuse réception au niveau TCP, il est vivant.
        const buffered = conn.ws.bufferedAmount + conn.queuedBytes;
        if (buffered < conn.lastBuffered) conn.lastLife = now;
        conn.lastBuffered = buffered;
        if (now - conn.lastLife > deadAfter) {
          this.log(`Connexion muette depuis ${Math.round((now - conn.lastLife) / 1000)} s : coupée (room « ${room.name} »)`);
          conn.ws.terminate(); // 'close' suit : présence retirée
          continue;
        }
        try {
          conn.ws.ping();
        } catch {
          conn.ws.terminate();
        }
      }
    }
    for (const [ip, f] of this.authFailures) if (now - f.since > AUTH_WINDOW_MS) this.authFailures.delete(ip);
  }

  // ------------------------------------------------------------------ rooms

  private openRoom(name: string): Room {
    const key = name.toLowerCase();
    const existing = this.rooms.get(key);
    if (existing) return existing;

    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(null); // le serveur n'est pas un participant
    const room: Room = {
      key,
      name,
      doc,
      awareness,
      conns: new Map(),
      file: this.dataDir ? this.resolveFile(name) : null,
      dirty: false,
      dirtySince: 0,
      saveTimer: null,
      unloadTimer: null,
      saving: Promise.resolve(),
      closed: false,
    };
    if (room.file) this.loadRoom(room);

    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (room.closed) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);
      // Gros message : découpé une seule fois pour tous les destinataires.
      const chunks = message.byteLength > CHUNK_THRESHOLD ? splitMessage(++this.chunkIds, message) : undefined;
      // L'émetteur possède déjà cette mise à jour : on ne la lui renvoie pas.
      for (const conn of room.conns.values()) if (conn !== origin) this.send(conn, message, chunks);
      room.dirty = true;
      this.scheduleSave(room);
    });

    awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (room.closed) return;
      const conn = origin && room.conns.get((origin as Conn).ws) === origin ? (origin as Conn) : null;
      if (conn) {
        for (const id of [...added, ...updated]) {
          if (conn.clients.has(id)) continue;
          conn.clients.add(id);
          // Le même client (même clientID) revient par une nouvelle connexion : l'ancienne est
          // une connexion à moitié morte (coupure, veille). On la ferme sans retirer la présence.
          for (const other of room.conns.values()) {
            if (other !== conn && other.clients.delete(id) && other.clients.size === 0) other.ws.terminate();
          }
        }
        for (const id of removed) conn.clients.delete(id);
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_AWARENESS);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, added.concat(updated, removed)));
      const message = encoding.toUint8Array(encoder);
      // Diffusé à TOUS, émetteur compris : le client y-websocket se reconnecte s'il ne
      // reçoit rien pendant 30 s, et compte sur l'écho de son propre renouvellement de présence.
      for (const c of room.conns.values()) this.send(c, message);
    });

    this.rooms.set(key, room);
    return room;
  }

  /** Fichier de la room : celui qui existe déjà (casse ignorée, pour un comportement identique sous Windows et Linux), sinon `<room>.coforge`. */
  private resolveFile(name: string): string {
    const dir = this.dataDir!;
    const wanted = name + FILE_EXT;
    const exact = path.join(dir, wanted);
    if (fs.existsSync(exact)) return exact;
    try {
      const lower = wanted.toLowerCase();
      const found = fs.readdirSync(dir).find((f) => f.toLowerCase() === lower);
      if (found) return path.join(dir, found);
    } catch {
      /* dossier illisible : on tentera de le créer à la sauvegarde */
    }
    return exact;
  }

  /** Lit et valide un fichier de room ; null s'il est absent, vide ou illisible. */
  private readRoomFile(file: string): Uint8Array | null {
    let data: Buffer;
    try {
      data = fs.readFileSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log(`Lecture impossible de ${file} : ${errorText(err)}`);
      return null;
    }
    if (data.byteLength === 0) return null;
    try {
      // Validé d'abord sur un document jetable : un fichier corrompu ne doit pas laisser la room à moitié chargée.
      const probe = new Y.Doc();
      Y.applyUpdate(probe, data);
      probe.destroy();
      return new Uint8Array(data);
    } catch (err) {
      this.log(`Fichier de room illisible : ${file} (${errorText(err)})`);
      return null;
    }
  }

  private loadRoom(room: Room): void {
    const file = room.file!;
    const main = this.readRoomFile(file);
    if (main) {
      Y.applyUpdate(room.doc, main);
      return;
    }
    const exists = fs.existsSync(file) && fs.statSync(file).size > 0;
    if (exists) {
      // Fichier illisible : on le met de côté pour ne pas l'écraser à la prochaine sauvegarde.
      const aside = `${file}.invalide-${Date.now()}`;
      try {
        fs.renameSync(file, aside);
        this.log(`Fichier de room illisible conservé sous ${aside}`);
      } catch {
        /* rien de plus à faire */
      }
    }
    // Repli sur la copie de secours de la sauvegarde précédente.
    const backup = this.readRoomFile(`${file}.bak`);
    if (backup) {
      Y.applyUpdate(room.doc, backup);
      room.dirty = true; // réécrit un fichier principal sain dès que possible
      this.scheduleSave(room);
      this.log(`Room « ${room.name} » restaurée depuis sa copie de secours`);
    }
  }

  private scheduleSave(room: Room): void {
    if (!room.file) return;
    const now = Date.now();
    if (!room.dirtySince) room.dirtySince = now;
    if (room.saveTimer) clearTimeout(room.saveTimer);
    const delay = Math.max(0, Math.min(this.saveDelay, room.dirtySince + this.maxSaveWait - now));
    room.saveTimer = setTimeout(() => {
      room.saveTimer = null;
      void this.saveRoom(room);
    }, delay);
  }

  /** Sauvegarde la room si elle a changé (écriture atomique et durable). Ne rejette jamais. */
  private saveRoom(room: Room): Promise<void> {
    if (room.saveTimer) clearTimeout(room.saveTimer);
    room.saveTimer = null;
    room.saving = room.saving.then(async () => {
      const file = room.file;
      if (!file || !room.dirty) return;
      room.dirty = false;
      room.dirtySince = 0;
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        const data = Y.encodeStateAsUpdate(room.doc);
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        // 1. fichier temporaire complet et écrit sur disque (fsync) ;
        const handle = await fs.promises.open(tmp, 'w');
        try {
          await handle.writeFile(data);
          await handle.sync();
        } finally {
          await handle.close();
        }
        // 2. la version précédente devient la copie de secours ;
        await fs.promises.copyFile(file, `${file}.bak`).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'ENOENT') throw err;
        });
        // 3. remplacement atomique.
        try {
          await fs.promises.rename(tmp, file);
        } catch {
          // Sous Windows le fichier peut être brièvement verrouillé (antivirus, indexation) : second essai.
          await new Promise((r) => setTimeout(r, 150));
          await fs.promises.rename(tmp, file);
        }
      } catch (err) {
        room.dirty = true;
        this.log(`Sauvegarde impossible de la room « ${room.name} » : ${errorText(err)}`);
        await fs.promises.unlink(tmp).catch(() => {});
        if (!room.closed) this.scheduleSave(room);
      }
    });
    return room.saving;
  }

  private destroyRoom(room: Room): void {
    room.closed = true;
    if (room.saveTimer) clearTimeout(room.saveTimer);
    if (room.unloadTimer) clearTimeout(room.unloadTimer);
    room.saveTimer = null;
    room.unloadTimer = null;
    room.awareness.destroy();
    room.doc.destroy();
  }
}
