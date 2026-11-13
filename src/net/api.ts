import type { SceneDoc } from '../core/doc/SceneDoc';
import type { Vec3 } from '../core/doc/schema';
import type { InteractionMode, LocalUser } from '../app/store';
import type { InviteCreated, InviteInfo } from './protocol';

/**
 * Contrat du client de collaboration (implémenté dans src/net/collab.ts).
 *
 * Deux canaux :
 *  1. le DOCUMENT (Y.Doc) : durable, fusionné sans conflit par CRDT, persistant côté serveur ;
 *  2. la PRÉSENCE (awareness Yjs), éphémère : qui est là, où il regarde, ce qu'il sélectionne.
 */

/** Caméra du viewport d'un utilisateur (repère monde Z-up). */
export interface PresenceCamera {
  pos: Vec3;
  /** Point visé (centre d'orbite). */
  target: Vec3;
  /** Champ de vision vertical en degrés. */
  fov: number;
  ortho: boolean;
  /** Largeur / hauteur du viewport. */
  aspect: number;
}

export interface PresenceState {
  user: LocalUser;
  camera: PresenceCamera | null;
  /** Rayon sous le pointeur de l'utilisateur dans son viewport, ou null si la souris est ailleurs. */
  pointer: { origin: Vec3; dir: Vec3 } | null;
  /** Objets sélectionnés. */
  selection: string[];
  activeId: string | null;
  mode: InteractionMode;
  /** Sommets sélectionnés en mode édition (tronqué à 400 identifiants). */
  editVerts: string[];
  /** Tête de lecture de l'utilisateur (image courante, sens de lecture) : permet de « suivre sa lecture ». */
  playback: { frame: number; playing: 0 | 1 | -1 };
}

export interface Peer {
  /** clientID Yjs de la connexion. */
  clientId: number;
  state: PresenceState;
}

export interface ConnectOptions {
  /** ex. ws://192.168.1.20:4455 */
  url: string;
  room: string;
  password?: string;
  /** Jeton d'invitation (lien coforge://join?…), à la place du mot de passe. */
  token?: string;
}

/**
 * État détaillé de la connexion (pour l'interface) :
 * - `connecting` : première connexion en cours ;
 * - `connected` : synchronisé ;
 * - `reconnecting` : connexion perdue, nouvelle tentative programmée ou en cours ;
 * - `offline` : réseau absent ou serveur injoignable depuis plusieurs tentatives ; on continue
 *   d'essayer, les modifications locales partiront au retour ;
 * - `error` : refus définitif (mot de passe, invitation, session, version) : plus de tentative ;
 * - `idle` : hors session.
 */
export type ConnectionPhase = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'error';

export type ConnectionErrorKind = 'password' | 'token' | 'revoked' | 'room' | 'room-not-found' | 'version' | 'too-many' | 'unreachable' | 'other';

export interface ConnectionInfo {
  phase: ConnectionPhase;
  url: string | null;
  room: string | null;
  /** Échecs consécutifs depuis la dernière synchronisation. */
  attempt: number;
  /** Prochaine tentative automatique (horodatage ms), ou null. */
  nextRetryAt: number | null;
  /** Aller-retour mesuré par le battement de cœur (ms), ou null. */
  latencyMs: number | null;
  /** Modifications locales pas encore confirmées par le serveur (partiront au retour de la connexion). */
  pendingChanges: number;
  error: string | null;
  errorKind: ConnectionErrorKind | null;
  /** Version de CoForge du serveur, et de son protocole (1 = ancien serveur sans négociation). */
  serverVersion: string | null;
  protocol: number | null;
  /** `admin` : entré avec le mot de passe (ou session ouverte), peut inviter ; `guest` : entré par invitation. */
  role: 'admin' | 'guest' | null;
  /** Le serveur exige un mot de passe ou une invitation. */
  secured: boolean | null;
  /** Jeton d'invitation utilisé pour entrer (invités), pour pouvoir repartager le même lien. */
  inviteToken: string | null;
  /** Transfert d'un gros message (scène, import) en cours. */
  transfer: { direction: 'down' | 'up'; done: number; total: number } | null;
}

export interface InviteOptions {
  /** Durée de validité (ms) ; défaut 24 h, maximum 30 jours. */
  ttlMs?: number;
  /** Nombre maximal d'utilisations ; 0 ou absent = illimité jusqu'à expiration. */
  maxUses?: number;
  label?: string;
}

export type { InviteCreated, InviteInfo } from './protocol';

export interface ICollab {
  /**
   * Relie `doc` à une room du serveur. La promesse se résout quand la première
   * synchronisation est terminée, et est rejetée (message en français) si la
   * connexion échoue ou si le mot de passe est refusé. Met à jour
   * `store.session` (status, url, room, peers, error) tout au long de la vie de
   * la connexion, y compris lors des reconnexions automatiques.
   */
  connect(doc: SceneDoc, opts: ConnectOptions): Promise<void>;
  /** Coupe la connexion (le document local reste intact). */
  disconnect(): void;
  readonly connected: boolean;
  /** clientID local, ou null hors session. */
  readonly clientId: number | null;

  /** Fusionne `patch` dans l'état de présence local et le diffuse (limité à ~20 envois/s). Sans effet hors session. */
  setPresence(patch: Partial<PresenceState>): void;
  /** Les AUTRES utilisateurs (jamais soi-même). */
  getPeers(): Peer[];
  /** Appelé à chaque changement de présence d'un pair (haute fréquence). Renvoie la fonction de désabonnement. */
  onPeers(cb: (peers: Peer[]) => void): () => void;

  /** État détaillé de la connexion. */
  getConnection(): ConnectionInfo;
  /** Appelé à chaque changement d'état (au plus ~5 fois par seconde). Renvoie la fonction de désabonnement. */
  onConnection(cb: (info: ConnectionInfo) => void): () => void;
  /** Abandonne l'attente de reconnexion et retente tout de suite. */
  retryNow(): void;
  /** Crée une invitation pour la session courante (rôle `admin`, serveur protégé). */
  createInvite(opts?: InviteOptions): Promise<InviteCreated>;
  listInvites(): Promise<InviteInfo[]>;
  /** Révoque une invitation : les invités entrés avec elle sont déconnectés. */
  revokeInvite(id: string): Promise<void>;
}
