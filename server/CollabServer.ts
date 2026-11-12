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

/**
 * Serveur de collaboration CoForge : Node pur (ni Electron, ni DOM).
 *
 * Parle le protocole du client `y-websocket` (WebsocketProvider) : messages
 * binaires lib0 dont le premier varUint est le type.
 *   0 = sync (y-protocols/sync)   1 = awareness   3 = queryAwareness
 *
 * Une « room » = un Y.Doc + un Awareness. URL : ws://hôte:port/<room>?password=…
 * Le serveur ne fait que relayer et persister : toute la logique de fusion est
 * dans le CRDT.
 */

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;

/** Code de fermeture : nom de room invalide (définitif, le client ne se reconnecte pas). */
export const CLOSE_BAD_ROOM = 4400;
/** Code de fermeture : mot de passe refusé (définitif, le client ne se reconnecte pas). */
export const CLOSE_BAD_PASSWORD = 4401;

export const SERVER_VERSION: string = pkg.version;

const ROOM_NAME = /^[\w\-. ]{1,64}$/;
/** Noms de périphériques réservés par Windows : inutilisables comme noms de fichier. */
const RESERVED_NAME = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const FILE_EXT = '.coforge';
const MAX_PAYLOAD = 64 * 1024 * 1024;
const HEARTBEAT_MS = 30_000;

export function isValidRoomName(name: string): boolean {
  return ROOM_NAME.test(name) && !RESERVED_NAME.test(name) && /[^. ]/.test(name);
}

export interface CollabServerOptions {
  /** 0 = port libre choisi par le système. */
  port: number;
  password?: string;
  /** Dossier de persistance des rooms (`<room>.coforge`). Sans lui, tout reste en mémoire. */
  dataDir?: string;
  /** Interface d'écoute (défaut : toutes, `0.0.0.0`). */
  host?: string;
  /** Journal (défaut : silencieux). */
  log?: (message: string) => void;
  /** Anti-rebond de sauvegarde après la dernière modification (défaut 2000 ms). */
  saveDelayMs?: number;
  /** Délai maximal entre une modification et sa sauvegarde lors d'une édition continue (défaut 15000 ms). */
  maxSaveWaitMs?: number;
  /** Délai de déchargement d'une room vide (défaut 60000 ms). */
  unloadDelayMs?: number;
}

export interface RoomInfo {
  name: string;
  clients: number;
}

interface Conn {
  ws: WebSocket;
  alive: boolean;
  /** clientID d'awareness annoncés par cette connexion (à retirer à sa fermeture). */
  clients: Set<number>;
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

function samePassword(expected: string, given: string): boolean {
  // Comparaison à temps constant sur des condensés de longueur fixe.
  const a = crypto.createHash('sha256').update(expected, 'utf8').digest();
  const b = crypto.createHash('sha256').update(given, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class CollabServer {
  private http: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private rooms = new Map<string, Room>();
  private password = '';
  private dataDir: string | null = null;
  private log: (message: string) => void = () => {};
  private saveDelay = 2000;
  private maxSaveWait = 15_000;
  private unloadDelay = 60_000;

  /** Démarre l'écoute. Rejette (erreur Node, ex. code `EADDRINUSE`) si le port est indisponible. */
  async start(opts: CollabServerOptions): Promise<{ port: number }> {
    if (this.http) throw new Error('Le serveur est déjà démarré');
    this.password = opts.password ?? '';
    this.dataDir = opts.dataDir ? path.resolve(opts.dataDir) : null;
    this.log = opts.log ?? (() => {});
    this.saveDelay = opts.saveDelayMs ?? 2000;
    this.maxSaveWait = opts.maxSaveWaitMs ?? 15_000;
    this.unloadDelay = opts.unloadDelayMs ?? 60_000;
    if (this.dataDir) fs.mkdirSync(this.dataDir, { recursive: true });

    const server = http.createServer((req, res) => this.handleHttp(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.port, opts.host ?? '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', (err) => this.log(`Erreur HTTP : ${errorText(err)}`));
    server.on('clientError', (_err, socket) => socket.destroy());

    const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD });
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
    this.heartbeat = setInterval(() => this.checkConnections(), HEARTBEAT_MS);
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

  // ------------------------------------------------------------------ HTTP

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    let pathname = '';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      /* URL illisible : 404 ci-dessous */
    }
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
    if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/') {
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ name: 'coforge-server', version: SERVER_VERSION, rooms: this.getRooms() }));
      return;
    }
    res.writeHead(404, headers);
    res.end(JSON.stringify({ error: 'introuvable' }));
  }

  // ------------------------------------------------------------------ connexions

  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    // Toujours un écouteur d'erreur : une erreur de socket sans écouteur ferait tomber le processus.
    ws.on('error', (err) => {
      this.log(`Erreur de socket : ${errorText(err)}`);
      ws.terminate();
    });

    let roomName = '';
    let given = '';
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      roomName = decodeURIComponent(url.pathname.slice(1));
      given = url.searchParams.get('password') ?? '';
    } catch {
      roomName = '';
    }

    if (this.password !== '' && !samePassword(this.password, given)) {
      ws.close(CLOSE_BAD_PASSWORD, 'password');
      return;
    }
    if (!isValidRoomName(roomName)) {
      ws.close(CLOSE_BAD_ROOM, 'room');
      return;
    }

    const room = this.openRoom(roomName);
    const conn: Conn = { ws, alive: true, clients: new Set() };
    room.conns.set(ws, conn);
    if (room.unloadTimer) clearTimeout(room.unloadTimer);
    room.unloadTimer = null;

    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('close', () => this.handleClose(room, conn));
    ws.on('message', (data, isBinary) => {
      if (!isBinary || room.closed) return;
      try {
        this.handleMessage(room, conn, toUint8(data));
      } catch (err) {
        // Message invalide : on l'ignore, la connexion et le serveur continuent.
        this.log(`Message invalide ignoré (room « ${room.name} ») : ${errorText(err)}`);
      }
    });

    // Ouverture : étape 1 de synchronisation, puis la présence déjà connue.
    const sync = encoding.createEncoder();
    encoding.writeVarUint(sync, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(sync, room.doc);
    this.send(conn, encoding.toUint8Array(sync));
    const states = room.awareness.getStates();
    if (states.size > 0) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()]));
      this.send(conn, encoding.toUint8Array(enc));
    }
  }

  private handleMessage(room: Room, conn: Conn, message: Uint8Array): void {
    const decoder = decoding.createDecoder(message);
    const type = decoding.readVarUint(decoder);
    switch (type) {
      case MESSAGE_SYNC: {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, room.doc, conn);
        // Une réponse existe seulement si l'encodeur contient plus que l'octet de type.
        if (encoding.length(encoder) > 1) this.send(conn, encoding.toUint8Array(encoder));
        break;
      }
      case MESSAGE_AWARENESS:
        awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), conn);
        break;
      case MESSAGE_QUERY_AWARENESS: {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...room.awareness.getStates().keys()]));
        this.send(conn, encoding.toUint8Array(encoder));
        break;
      }
      default:
        break; // type inconnu (ex. 2 = auth) : ignoré
    }
  }

  private handleClose(room: Room, conn: Conn): void {
    if (room.closed || !room.conns.delete(conn.ws)) return;
    // Retire la présence de ce client pour tous les autres.
    awarenessProtocol.removeAwarenessStates(room.awareness, [...conn.clients], null);
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

  private send(conn: Conn, message: Uint8Array): void {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    try {
      conn.ws.send(message, { binary: true }, (err) => {
        if (err) conn.ws.terminate();
      });
    } catch {
      conn.ws.terminate();
    }
  }

  private checkConnections(): void {
    for (const room of this.rooms.values()) {
      for (const conn of room.conns.values()) {
        if (!conn.alive) {
          conn.ws.terminate(); // aucun pong depuis le dernier ping : connexion morte
          continue;
        }
        conn.alive = false;
        try {
          conn.ws.ping();
        } catch {
          conn.ws.terminate();
        }
      }
    }
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
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);
      // L'émetteur possède déjà cette mise à jour : on ne la lui renvoie pas.
      for (const conn of room.conns.values()) if (conn !== origin) this.send(conn, message);
      room.dirty = true;
      this.scheduleSave(room);
    });

    awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (room.closed) return;
      const conn = [...room.conns.values()].find((c) => c === origin);
      if (conn) {
        for (const id of added) conn.clients.add(id);
        for (const id of updated) conn.clients.add(id);
        for (const id of removed) conn.clients.delete(id);
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
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

  private loadRoom(room: Room): void {
    const file = room.file!;
    let data: Buffer;
    try {
      data = fs.readFileSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log(`Lecture impossible de ${file} : ${errorText(err)}`);
      return;
    }
    if (data.byteLength === 0) return;
    try {
      // Validé d'abord sur un document jetable : un fichier corrompu ne doit pas laisser la room à moitié chargée.
      const probe = new Y.Doc();
      Y.applyUpdate(probe, data);
      probe.destroy();
      Y.applyUpdate(room.doc, data);
    } catch (err) {
      // Fichier illisible : on le met de côté pour ne pas l'écraser à la prochaine sauvegarde.
      const aside = `${file}.invalide-${Date.now()}`;
      this.log(`Fichier de room illisible (${errorText(err)}), conservé sous ${aside}`);
      try {
        fs.renameSync(file, aside);
      } catch {
        /* rien de plus à faire */
      }
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

  /** Sauvegarde la room si elle a changé (écriture atomique). Ne rejette jamais. */
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
        await fs.promises.writeFile(tmp, data);
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
