import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

/**
 * Protocole réseau CoForge, partagé par le client (src/net) et le serveur (server/).
 * Module PUR : ni DOM, ni Node.
 *
 * Base : le protocole de y-websocket (messages binaires lib0 dont le premier varUint
 * est le type : 0 = sync, 1 = présence, 3 = demande de présence). Un client y-websocket
 * standard (sans paramètre `v`) reste accepté par le serveur.
 *
 * Extensions CoForge, activées quand le client annonce `?v=<version>` dans l'URL :
 *   100 HELLO      serveur → client, JSON : version, rôle, fonctions, ticket de reprise
 *   101 PING       client → serveur, varUint séquence + float64 horodatage → réponse 102 PONG
 *   103 CHUNK      les deux sens : un message de plus de CHUNK_THRESHOLD octets est découpé
 *   104 RPC        client → serveur, JSON { id, method, params } → réponse 105 RPC_REPLY
 */

/** Version du protocole parlée par ce code. */
export const PROTOCOL_VERSION = 2;
/** Plus ancienne version de client acceptée par le serveur (les clients y-websocket sans `v` restent acceptés). */
export const MIN_CLIENT_PROTOCOL = 2;
/** Plus ancienne version de serveur acceptée par le client (1 = serveur sans HELLO, y-websocket pur). */
export const MIN_SERVER_PROTOCOL = 1;

export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;
export const MSG_AUTH = 2;
export const MSG_QUERY_AWARENESS = 3;
export const MSG_HELLO = 100;
export const MSG_PING = 101;
export const MSG_PONG = 102;
export const MSG_CHUNK = 103;
export const MSG_RPC = 104;
export const MSG_RPC_REPLY = 105;

/**
 * Codes de fermeture décidés par le serveur. 4400-4499 : définitifs (le client ne se
 * reconnecte pas tout seul) ; les autres sont passagers.
 */
export const CLOSE_BAD_ROOM = 4400;
export const CLOSE_BAD_PASSWORD = 4401;
/** Jeton d'invitation inconnu, expiré, épuisé ou révoqué. */
export const CLOSE_BAD_TOKEN = 4403;
/** Ce serveur ne sert pas cette session (serveur embarqué d'un hôte : une seule session). */
export const CLOSE_ROOM_NOT_FOUND = 4404;
/** Invitation révoquée par l'hôte pendant la session. */
export const CLOSE_REVOKED = 4410;
/** Versions de protocole incompatibles. Raison : `version:<min>-<max>`. */
export const CLOSE_VERSION = 4426;
/** Trop de tentatives refusées depuis cette adresse : réessayer plus tard. */
export const CLOSE_TOO_MANY = 4429;
/** Un message dépasse la taille maximale acceptée (après réassemblage). */
export const CLOSE_TOO_BIG = 4413;

/** Au-delà de cette taille, un message est découpé en morceaux (protocole ≥ 2). */
export const CHUNK_THRESHOLD = 512 * 1024;
export const CHUNK_SIZE = 256 * 1024;
/** Taille maximale d'un message réassemblé (une scène importée très lourde). */
export const MAX_MESSAGE_BYTES = 1024 * 1024 * 1024;
/** Taille maximale d'une trame WebSocket acceptée par le serveur (un morceau, ou un message d'un client sans découpage). */
export const MAX_FRAME_BYTES = 256 * 1024 * 1024;

/** Nom de session : 1 à 64 caractères ASCII parmi lettres, chiffres, espace, « _ », « - », « . ». */
const ROOM_NAME = /^[\w\-. ]{1,64}$/;
/** Noms de périphériques réservés par Windows : inutilisables comme noms de fichier. */
const RESERVED_NAME = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

export function isValidRoomName(name: string): boolean {
  return typeof name === 'string' && ROOM_NAME.test(name) && !RESERVED_NAME.test(name.trim()) && /[^. ]/.test(name) && name === name.trim();
}

/** Jeton (invitation, ticket de reprise) : base64url de 16 à 64 caractères. */
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
export function isValidToken(token: string): boolean {
  return typeof token === 'string' && TOKEN.test(token);
}

/** Rôle d'une connexion : `admin` (mot de passe, ou serveur ouvert) peut créer des invitations ; `guest` est entré par invitation. */
export type ConnRole = 'admin' | 'guest';

export interface HelloMessage {
  protocol: number;
  /** Version de CoForge du serveur. */
  server: string;
  role: ConnRole;
  room: string;
  /** Fonctions disponibles : 'chunk', 'ping', 'invite'. */
  features: string[];
  /** Le serveur exige une authentification (mot de passe ou invitation). */
  secured: boolean;
  /** Ticket de reprise (invités) : à présenter à la reconnexion à la place du jeton d'invitation. */
  resume?: string;
}

export interface InviteInfo {
  id: string;
  room: string;
  createdAt: number;
  /** Date d'expiration (ms depuis l'époque). */
  expiresAt: number;
  /** Nombre maximal d'utilisations, 0 = illimité jusqu'à expiration. */
  maxUses: number;
  uses: number;
  revoked: boolean;
  label: string;
}

export interface InviteCreated extends InviteInfo {
  /** Jeton secret, montré une seule fois (le serveur n'en garde qu'un condensé). */
  token: string;
}

export interface RpcRequest {
  id: number;
  method: 'invite.create' | 'invite.list' | 'invite.revoke';
  params?: Record<string, unknown>;
}

export interface RpcReply {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

// ------------------------------------------------------------------ encodage

export function encodeJson(type: number, value: unknown): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, type);
  encoding.writeVarString(enc, JSON.stringify(value));
  return encoding.toUint8Array(enc);
}

/** Lit le JSON d'un message HELLO / RPC (décodeur placé après le type). Lève si illisible. */
export function readJson(decoder: decoding.Decoder): unknown {
  return JSON.parse(decoding.readVarString(decoder));
}

export function encodePing(type: typeof MSG_PING | typeof MSG_PONG, seq: number, time: number): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, type);
  encoding.writeVarUint(enc, seq);
  encoding.writeFloat64(enc, time);
  return encoding.toUint8Array(enc);
}

/** Découpe `message` en morceaux CHUNK (identifiant `id`, propre à l'émetteur). */
export function splitMessage(id: number, message: Uint8Array, size = CHUNK_SIZE): Uint8Array[] {
  const count = Math.max(1, Math.ceil(message.byteLength / size));
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_CHUNK);
    encoding.writeVarUint(enc, id);
    encoding.writeVarUint(enc, i);
    encoding.writeVarUint(enc, count);
    encoding.writeVarUint(enc, message.byteLength);
    encoding.writeVarUint8Array(enc, message.subarray(i * size, Math.min(message.byteLength, (i + 1) * size)));
    out.push(encoding.toUint8Array(enc));
  }
  return out;
}

/**
 * Réassemblage des morceaux reçus sur UNE connexion (ordonnée : TCP). Un seul message
 * en cours à la fois par identifiant ; tout écart (morceau manquant, taille incohérente)
 * lève une erreur : la connexion doit alors être fermée.
 */
export class ChunkAssembler {
  private current: { id: number; count: number; total: number; next: number; buf: Uint8Array; offset: number } | null = null;

  constructor(private readonly maxBytes = MAX_MESSAGE_BYTES) {}

  /** Octets reçus / attendus du message en cours, ou null. */
  get progress(): { received: number; total: number } | null {
    return this.current ? { received: this.current.offset, total: this.current.total } : null;
  }

  /** Décodeur placé après le type MSG_CHUNK. Renvoie le message complet quand le dernier morceau arrive. */
  push(decoder: decoding.Decoder): Uint8Array | null {
    const id = decoding.readVarUint(decoder);
    const index = decoding.readVarUint(decoder);
    const count = decoding.readVarUint(decoder);
    const total = decoding.readVarUint(decoder);
    const part = decoding.readVarUint8Array(decoder);
    if (total > this.maxBytes) throw new Error(`message trop gros (${total} octets)`);
    if (count < 1 || index >= count) throw new Error('morceau invalide');
    if (index === 0) {
      this.current = { id, count, total, next: 0, buf: new Uint8Array(total), offset: 0 };
    }
    const cur = this.current;
    if (!cur || cur.id !== id || cur.next !== index || cur.count !== count || cur.total !== total) {
      this.current = null;
      throw new Error('morceau hors séquence');
    }
    if (cur.offset + part.byteLength > total) {
      this.current = null;
      throw new Error('morceau trop long');
    }
    cur.buf.set(part, cur.offset);
    cur.offset += part.byteLength;
    cur.next++;
    if (cur.next < cur.count) return null;
    this.current = null;
    if (cur.offset !== total) throw new Error('message incomplet');
    return cur.buf;
  }

  reset(): void {
    this.current = null;
  }
}
