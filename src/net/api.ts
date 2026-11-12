import type { SceneDoc } from '../core/doc/SceneDoc';
import type { Vec3 } from '../core/doc/schema';
import type { InteractionMode, LocalUser } from '../app/store';

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
}

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
}
