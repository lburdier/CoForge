import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { InviteCreated, InviteInfo } from '../src/net/protocol';

/**
 * Invitations d'une instance de serveur.
 *
 * Un jeton d'invitation est un secret aléatoire de 128 bits (base64url, 22 caractères) ; le
 * serveur n'en garde que le condensé SHA-256 : une fuite du fichier des invitations ne
 * permet pas d'entrer. Chaque invitation est liée à UNE session (room), expire, peut être
 * limitée en nombre d'utilisations et révoquée à tout moment.
 *
 * Un invité entré par invitation reçoit un ticket de reprise (même format, même stockage) :
 * il s'en sert pour se reconnecter après une coupure, même si l'invitation a expiré entre
 * temps. Révoquer l'invitation révoque aussi ses tickets.
 */

/** Durée de validité par défaut d'une invitation : 24 h. */
export const DEFAULT_INVITE_TTL_MS = 24 * 3600_000;
/** Durée maximale d'une invitation : 30 jours. */
export const MAX_INVITE_TTL_MS = 30 * 24 * 3600_000;
/** Durée de vie d'un ticket de reprise sans utilisation (prolongée à chaque reconnexion). */
export const RESUME_TTL_MS = 12 * 3600_000;
const MAX_INVITES = 500;
const MAX_TICKETS = 5000;

interface StoredInvite extends InviteInfo {
  hash: string;
}

interface Ticket {
  hash: string;
  inviteId: string;
  roomKey: string;
  expiresAt: number;
}

export type InviteCheck = { ok: true; inviteId: string } | { ok: false; reason: 'unknown' | 'expired' | 'revoked' | 'exhausted' | 'room' };

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function newToken(): string {
  return crypto.randomBytes(16).toString('base64url');
}

export class InviteRegistry {
  private invites = new Map<string, StoredInvite>();
  private byHash = new Map<string, StoredInvite>();
  private tickets = new Map<string, Ticket>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  /** `file` : persistance des invitations (serveur dédié), sinon mémoire seule. */
  constructor(
    private readonly file: string | null = null,
    private readonly log: (message: string) => void = () => {},
    private readonly clock: () => number = Date.now,
  ) {
    if (file) this.load();
  }

  create(room: string, opts: { ttlMs?: number; maxUses?: number; label?: string } = {}): InviteCreated {
    this.prune();
    if (this.invites.size >= MAX_INVITES) throw new Error("Trop d'invitations actives : révoquez-en avant d'en créer d'autres");
    const ttl = Math.min(MAX_INVITE_TTL_MS, Math.max(60_000, Number.isFinite(opts.ttlMs) ? Number(opts.ttlMs) : DEFAULT_INVITE_TTL_MS));
    const maxUses = Number.isInteger(opts.maxUses) && Number(opts.maxUses) > 0 ? Math.min(10_000, Number(opts.maxUses)) : 0;
    const token = newToken();
    const now = this.clock();
    const invite: StoredInvite = {
      id: crypto.randomBytes(6).toString('hex'),
      room,
      createdAt: now,
      expiresAt: now + ttl,
      maxUses,
      uses: 0,
      revoked: false,
      label: typeof opts.label === 'string' ? opts.label.slice(0, 60) : '',
      hash: hashToken(token),
    };
    this.invites.set(invite.id, invite);
    this.byHash.set(invite.hash, invite);
    this.scheduleSave();
    return { ...this.info(invite), token };
  }

  /** Vérifie un jeton d'invitation pour `room` et, s'il est valable, compte une utilisation. */
  use(token: string, room: string): InviteCheck {
    const invite = this.byHash.get(hashToken(token));
    if (!invite) return { ok: false, reason: 'unknown' };
    if (invite.room.toLowerCase() !== room.toLowerCase()) return { ok: false, reason: 'room' };
    if (invite.revoked) return { ok: false, reason: 'revoked' };
    if (this.clock() >= invite.expiresAt) return { ok: false, reason: 'expired' };
    if (invite.maxUses > 0 && invite.uses >= invite.maxUses) return { ok: false, reason: 'exhausted' };
    invite.uses++;
    this.scheduleSave();
    return { ok: true, inviteId: invite.id };
  }

  /** Délivre un ticket de reprise pour un invité entré par l'invitation `inviteId`. */
  issueTicket(inviteId: string, room: string): string {
    if (this.tickets.size >= MAX_TICKETS) this.pruneTickets(true);
    const token = newToken();
    const hash = hashToken(token);
    this.tickets.set(hash, { hash, inviteId, roomKey: room.toLowerCase(), expiresAt: this.clock() + RESUME_TTL_MS });
    return token;
  }

  /** Vérifie un ticket de reprise (et prolonge sa validité). Renvoie l'invitation d'origine, ou null. */
  resume(ticket: string, room: string): string | null {
    const t = this.tickets.get(hashToken(ticket));
    if (!t || t.roomKey !== room.toLowerCase() || this.clock() >= t.expiresAt) return null;
    const invite = this.invites.get(t.inviteId);
    if (!invite || invite.revoked) return null;
    t.expiresAt = this.clock() + RESUME_TTL_MS;
    return t.inviteId;
  }

  revoke(id: string): boolean {
    const invite = this.invites.get(id);
    if (!invite || invite.revoked) return false;
    invite.revoked = true;
    for (const [hash, t] of this.tickets) if (t.inviteId === id) this.tickets.delete(hash);
    this.scheduleSave();
    return true;
  }

  isRevoked(id: string): boolean {
    const invite = this.invites.get(id);
    return !invite || invite.revoked;
  }

  list(room?: string): InviteInfo[] {
    this.prune();
    const key = room?.toLowerCase();
    return [...this.invites.values()].filter((i) => key === undefined || i.room.toLowerCase() === key).map((i) => this.info(i));
  }

  /** Écrit tout de suite les invitations modifiées (arrêt du serveur) ; rien si rien n'a changé. */
  flush(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.save();
  }

  private info(i: StoredInvite): InviteInfo {
    return { id: i.id, room: i.room, createdAt: i.createdAt, expiresAt: i.expiresAt, maxUses: i.maxUses, uses: i.uses, revoked: i.revoked, label: i.label };
  }

  /** Oublie les invitations expirées ou révoquées depuis plus d'un jour. */
  private prune(): void {
    const limit = this.clock() - 24 * 3600_000;
    for (const [id, i] of this.invites) {
      if (i.expiresAt < limit || (i.revoked && i.createdAt < limit)) {
        this.invites.delete(id);
        this.byHash.delete(i.hash);
        for (const [hash, t] of this.tickets) if (t.inviteId === id) this.tickets.delete(hash);
      }
    }
    this.pruneTickets(false);
  }

  private pruneTickets(force: boolean): void {
    const now = this.clock();
    for (const [hash, t] of this.tickets) if (t.expiresAt <= now) this.tickets.delete(hash);
    if (force && this.tickets.size >= MAX_TICKETS) {
      // Les plus proches de l'expiration partent en premier.
      const sorted = [...this.tickets.values()].sort((a, b) => a.expiresAt - b.expiresAt);
      for (const t of sorted.slice(0, Math.ceil(MAX_TICKETS / 10))) this.tickets.delete(t.hash);
    }
  }

  private scheduleSave(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 200);
    this.saveTimer.unref?.();
  }

  private save(): void {
    const file = this.file;
    if (!file) return;
    const data = JSON.stringify({ version: 1, invites: [...this.invites.values()], tickets: [...this.tickets.values()] });
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeFileSync(fd, data);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
    } catch (err) {
      this.log(`Enregistrement des invitations impossible : ${err instanceof Error ? err.message : String(err)}`);
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* rien à nettoyer */
      }
    }
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file!, 'utf8');
    } catch {
      return; // pas encore de fichier
    }
    try {
      const data = JSON.parse(raw) as { invites?: unknown[]; tickets?: unknown[] };
      for (const v of data.invites ?? []) {
        const i = v as StoredInvite;
        if (!i || typeof i.id !== 'string' || typeof i.hash !== 'string' || typeof i.room !== 'string' || !Number.isFinite(i.expiresAt)) continue;
        const invite: StoredInvite = {
          id: i.id,
          room: i.room,
          createdAt: Number(i.createdAt) || 0,
          expiresAt: Number(i.expiresAt),
          maxUses: Number(i.maxUses) || 0,
          uses: Number(i.uses) || 0,
          revoked: i.revoked === true,
          label: typeof i.label === 'string' ? i.label : '',
          hash: i.hash,
        };
        this.invites.set(invite.id, invite);
        this.byHash.set(invite.hash, invite);
      }
      for (const v of data.tickets ?? []) {
        const t = v as Ticket;
        if (t && typeof t.hash === 'string' && typeof t.inviteId === 'string' && typeof t.roomKey === 'string' && Number.isFinite(t.expiresAt)) this.tickets.set(t.hash, t);
      }
      this.prune();
    } catch (err) {
      this.log(`Fichier des invitations illisible, ignoré : ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
