import { useEffect, useState, type FormEvent } from 'react';
import { Copy, Globe, History, LogIn, LogOut, RefreshCw, Server, Trash2, UserPlus, X } from 'lucide-react';
import { getApp } from '../../app/context';
import { DEFAULT_PORT, platform, type HostAccess } from '../../app/platform';
import {
  addPublicAlternative,
  bindInviteLinks,
  closeInviteDialog,
  generateInvite,
  hostSession,
  joinFromLink,
  joinSession,
  leaveSession,
  revokeLastInvite,
  sessionUi,
  useSessionUi,
} from '../../app/session';
import { setUser, store, toast, useApp } from '../../app/store';
import { looksLikeInviteLink, parseInviteLink, type InviteLink } from '../../net/invite';
import { isValidRoomName } from '../../net/protocol';
import { copyText, isHexColor, loadStored, normalizeText, saveStored } from '../lib/util';
import { ColorField, Hint, IconButton, Select } from '../widgets/basic';
import { useConnection } from './connection';
import { AddressList, ConnectionTester, HostNetworkCheck, PublicAddressRow, RemoteHelp } from './NetDiagnosis';
import { Dialog, Field, FormRow, closeDialog } from './Dialog';
import './session.css';

const WS_URL = /^wss?:\/\/[^/\s]+/i;
const ROOM_RULE = 'Nom de salle invalide : 64 caractères au plus, lettres sans accent, chiffres, espaces, « - », « _ », « . ».';

function errorText(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

function defaultRoom(): string {
  const base = normalizeText(getApp().doc.getScene().name)
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return isValidRoomName(base) ? base : 'atelier';
}

/** Vérifie et applique pseudo + couleur ; renvoie un message d'erreur ou null. */
function applyIdentity(name: string, color: string): string | null {
  const n = name.trim();
  if (!n) return 'Indiquez un nom d’utilisateur.';
  if (!isHexColor(color)) return 'Couleur invalide.';
  const u = store.getState().user;
  if (n !== u.name || color !== u.color) setUser({ name: n.slice(0, 40), color });
  return null;
}

function IdentityFields({ name, color, onName, onColor, disabled }: { name: string; color: string; onName(v: string): void; onColor(v: string): void; disabled?: boolean }) {
  return (
    <>
      <Field label="Votre nom" value={name} onChange={onName} maxLength={40} disabled={disabled} />
      <FormRow label="Votre couleur">
        <ColorField value={color} onChange={onColor} disabled={disabled} />
      </FormRow>
    </>
  );
}

/** Copie un lien et confirme par un message explicite. */
async function copyLink(text: string, what = 'Lien d’invitation copié dans le presse-papiers'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
  } catch {
    await copyText(text);
  }
}

// ------------------------------------------------------------------ héberger

interface HostPrefs {
  port: number;
  room: string;
  access?: HostAccess;
}

const ACCESS_OPTIONS: { value: HostAccess; label: string }[] = [
  { value: 'invite', label: 'Sur invitation (lien)' },
  { value: 'password', label: 'Mot de passe ou invitation' },
  { value: 'open', label: 'Ouvert à tout le réseau' },
];

function HostForm() {
  const user = useApp((s) => s.user);
  const prefs = loadStored<HostPrefs>('session.host', { port: DEFAULT_PORT, room: '' });
  const [name, setName] = useState(user.name);
  const [color, setColor] = useState(user.color);
  const [port, setPort] = useState(String(Number.isInteger(prefs.port) ? prefs.port : DEFAULT_PORT));
  const [room, setRoom] = useState(typeof prefs.room === 'string' && isValidRoomName(prefs.room) ? prefs.room : defaultRoom());
  const [access, setAccess] = useState<HostAccess>(prefs.access === 'password' || prefs.access === 'open' ? prefs.access : 'invite');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const native = platform.isElectron;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    const idErr = applyIdentity(name, color);
    if (idErr) return setError(idErr);
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1024 || p > 65535) return setError('Le port doit être un entier entre 1024 et 65535.');
    const r = room.trim();
    if (!isValidRoomName(r)) return setError(ROOM_RULE);
    if (access === 'password' && !password.trim()) return setError('Indiquez un mot de passe, ou choisissez l’accès sur invitation.');
    setError(null);
    setBusy(true);
    try {
      await hostSession({ port: p, room: r, password: access === 'password' ? password : undefined, access });
      saveStored('session.host', { port: p, room: r, access });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Héberger une session"
      icon={Server}
      width={440}
      busy={busy}
      footer={
        <>
          <div className="cf-spacer" />
          <button type="button" className="cf-btn" disabled={busy} onClick={closeDialog}>
            Annuler
          </button>
          <button type="button" className="cf-btn is-accent" disabled={busy || !native} onClick={() => void submit()}>
            {busy ? 'Démarrage…' : 'Héberger'}
          </button>
        </>
      }
    >
      <form className="cf-form" onSubmit={(e) => void submit(e)}>
        <p className="cf-dialog-text">Démarre un serveur de collaboration sur cette machine et y publie votre scène courante.</p>
        <IdentityFields name={name} color={color} onName={setName} onColor={setColor} disabled={busy} />
        <div className="cf-form-sep" />
        <Field label="Nom de la salle" value={room} onChange={setRoom} maxLength={64} disabled={busy} autoFocus />
        <Field label="Port" type="number" value={port} onChange={setPort} min={1024} max={65535} disabled={busy} />
        <FormRow label="Accès">
          <Select<HostAccess> value={access} options={ACCESS_OPTIONS} onChange={(v) => setAccess(v)} disabled={busy} />
        </FormRow>
        {access === 'password' && <Field label="Mot de passe" type="password" value={password} onChange={setPassword} disabled={busy} />}
        <Hint>
          {access === 'invite'
            ? 'Seules les personnes à qui vous envoyez un lien d’invitation peuvent entrer (aucun mot de passe à communiquer).'
            : access === 'password'
              ? 'Entrée avec le mot de passe, ou par lien d’invitation (l’invité ne voit jamais le mot de passe).'
              : 'Toute personne qui connaît l’adresse de cette machine peut entrer, sans contrôle.'}
        </Hint>
        {!native && <div className="cf-form-error">L’hébergement n’est disponible que dans l’application Windows. Rejoignez plutôt un serveur dédié.</div>}
        {error && <div className="cf-form-error">{error}</div>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

export function HostDialog() {
  const hosting = useApp((s) => s.session.hosting && s.session.status !== 'offline');
  return hosting ? <InviteDialog onClose={closeDialog} /> : <HostForm />;
}

// ------------------------------------------------------------------ inviter

const TTL_OPTIONS: { value: string; label: string }[] = [
  { value: '3600000', label: '1 heure' },
  { value: '86400000', label: '24 heures' },
  { value: '604800000', label: '7 jours' },
  { value: '2592000000', label: '30 jours' },
];

function formatExpiry(t: number | null): string {
  if (!t) return '';
  try {
    return new Date(t).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/** Dialogue « Inviter » : lien coforge://, variante web, adresses joignables, adresse Internet sur demande. */
export function InviteDialog({ onClose = closeInviteDialog }: { onClose?(): void }) {
  const session = useApp((s) => s.session);
  const conn = useConnection();
  const invite = useSessionUi((s) => s.lastInvite);
  const [ttl, setTtl] = useState('86400000');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [publicIp, setPublicIp] = useState<string | null>(null);
  const [ipBusy, setIpBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const inSession = session.status !== 'offline';
  const canCreate = conn.role === 'admin' && conn.secured === true;

  const create = async (copy: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const inv = await generateInvite({ ttlMs: Number(ttl) });
      if (copy) await copyLink(inv.link);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  // À l'ouverture : un lien est prêt tout de suite (et copié).
  useEffect(() => {
    if (inSession && !sessionUi.getState().lastInvite && conn.phase === 'connected') void create(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inSession, conn.phase === 'connected']);

  const port = session.shareAddresses[0]?.match(/:(\d+)$/)?.[1] ?? session.url?.match(/:(\d+)$/)?.[1] ?? String(DEFAULT_PORT);

  return (
    <Dialog
      title={session.hosting ? 'Session hébergée : inviter' : 'Inviter dans la session'}
      icon={UserPlus}
      width={520}
      busy={busy || stopping}
      onClose={onClose}
      footer={
        <>
          {inSession && (
            <button
              type="button"
              className="cf-btn is-danger"
              disabled={stopping}
              onClick={() => {
                setStopping(true);
                leaveSession()
                  .then(() => toast(session.hosting ? 'Session arrêtée, la scène reste ouverte en local' : 'Session quittée'))
                  .catch((err) => toast(errorText(err), 'error'))
                  .finally(() => {
                    setStopping(false);
                    onClose();
                  });
              }}
            >
              <LogOut size={13} /> {session.hosting ? 'Arrêter la session' : 'Quitter la session'}
            </button>
          )}
          <div className="cf-spacer" />
          <button type="button" className="cf-btn is-accent" onClick={onClose}>
            Fermer
          </button>
        </>
      }
    >
      {!inSession && <p className="cf-dialog-text">Aucune session en cours.</p>}
      {inSession && (
        <>
          <p className="cf-dialog-text">
            Envoyez ce lien à vos invités : un clic ouvre CoForge et propose de rejoindre la session <b>{session.room}</b>.
          </p>
          {invite ? (
            <>
              <div className="cf-invite-link">
                <input readOnly value={invite.link} onFocus={(e) => e.currentTarget.select()} aria-label="Lien d’invitation" />
                <IconButton icon={Copy} tip="Copier le lien" onClick={() => void copyLink(invite.link)} />
              </div>
              <div className="cf-invite-meta">
                {invite.open
                  ? 'Session ouverte : le lien ne contient pas de jeton.'
                  : invite.inviteId
                    ? `Lien valable jusqu’au ${formatExpiry(invite.expiresAt)}, utilisable plusieurs fois, révocable.`
                    : 'Le lien par lequel vous êtes entré (l’hôte peut le révoquer).'}
              </div>
              <div className="cf-invite-link">
                <input readOnly value={invite.webLink} onFocus={(e) => e.currentTarget.select()} aria-label="Lien web" />
                <IconButton icon={Globe} tip="Copier la variante web (cliquable dans les messageries)" onClick={() => void copyLink(invite.webLink, 'Lien web copié dans le presse-papiers')} />
              </div>
              <div className="cf-invite-meta">
                Variante web : cliquable partout (Discord, Teams, courriel). Elle ouvre une page servie par le serveur de la session, qui propose d’ouvrir CoForge.
              </div>
            </>
          ) : (
            <div className="cf-invite-meta">{busy ? 'Création du lien…' : conn.phase !== 'connected' ? 'En attente de la connexion au serveur…' : ''}</div>
          )}
          {canCreate && (
            <div className="cf-invite-row">
              <span className="cf-dim">Validité</span>
              <Select value={ttl} options={TTL_OPTIONS} onChange={setTtl} disabled={busy} />
              <div className="cf-spacer" />
              <button type="button" className="cf-btn" disabled={busy || conn.phase !== 'connected'} onClick={() => void create(true)}>
                <RefreshCw size={12} /> Nouveau lien
              </button>
              {invite?.inviteId && (
                <button
                  type="button"
                  className="cf-btn is-danger"
                  disabled={busy}
                  data-tip="Le lien ne fonctionne plus ; les invités entrés avec lui sont déconnectés"
                  onClick={() => {
                    setBusy(true);
                    revokeLastInvite()
                      .then(() => toast('Invitation révoquée'))
                      .catch((err) => setError(errorText(err)))
                      .finally(() => setBusy(false));
                  }}
                >
                  <Trash2 size={12} /> Révoquer
                </button>
              )}
            </div>
          )}
          {error && <div className="cf-form-error">{error}</div>}

          {invite && invite.alternatives.length > 0 && (
            <div className="cf-invite-section">
              <h4>{session.hosting ? 'Adresses de cette machine' : 'Adresse du serveur'}</h4>
              <AddressList alternatives={invite.alternatives} onCopy={(l) => void copyLink(l)} />
              {session.hosting && (
                <Hint>
                  Le lien principal utilise la première adresse. Une adresse de réseau local (10.x, 172.16-31.x, 192.168.x) ne fonctionne que pour les
                  invités branchés sur le même réseau ; depuis un autre réseau, utilisez un VPN maillé (adresse 100.x).
                </Hint>
              )}
            </div>
          )}

          {session.hosting && <HostNetworkCheck />}

          {session.hosting && (
            <div className="cf-invite-section">
              <h4>Invités sur un autre réseau</h4>
              {publicIp ? (
                <PublicAddressRow alt={invite ? addPublicAlternative(publicIp) : null} ip={publicIp} />
              ) : (
                <button
                  type="button"
                  className="cf-btn"
                  disabled={ipBusy}
                  data-tip="Une requête sera envoyée au service externe api.ipify.org"
                  onClick={() => {
                    setIpBusy(true);
                    platform
                      .publicAddress()
                      .then(setPublicIp)
                      .catch((err) => setError(errorText(err)))
                      .finally(() => setIpBusy(false));
                  }}
                >
                  <Globe size={12} /> {ipBusy ? 'Interrogation…' : 'Afficher l’adresse Internet'}
                </button>
              )}
              {!publicIp && <div className="cf-invite-meta">Une requête sera faite au service externe api.ipify.org, uniquement si vous cliquez. Le lien avec l’adresse Internet ne fonctionne que si la box redirige le port {port} (TCP) vers cette machine.</div>}
              <RemoteHelp />
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}

// ------------------------------------------------------------------ rejoindre par lien

function linkHost(link: InviteLink): string {
  return `${link.host}:${link.port}`;
}

/** Confirmation d'un lien d'invitation reçu (clic sur un lien coforge://). */
export function JoinLinkDialog({ link }: { link: InviteLink }) {
  const user = useApp((s) => s.user);
  const dirty = useApp((s) => s.dirty);
  const inSession = useApp((s) => s.session.status !== 'offline');
  const [name, setName] = useState(user.name);
  const [color, setColor] = useState(user.color);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testRun, setTestRun] = useState(0);
  const close = () => sessionUi.setState({ pendingLink: null });

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    const idErr = applyIdentity(name, color);
    if (idErr) return setError(idErr);
    setError(null);
    setBusy(true);
    try {
      await joinFromLink(link);
      rememberSession(`${link.tls ? 'wss' : 'ws'}://${linkHost(link)}`, link.room);
      close();
    } catch (err) {
      setError(errorText(err));
      setTestRun((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Invitation reçue"
      icon={UserPlus}
      width={440}
      busy={busy}
      onClose={close}
      footer={
        <>
          <div className="cf-spacer" />
          <button type="button" className="cf-btn" disabled={busy} onClick={close}>
            Ignorer
          </button>
          <button type="button" className={`cf-btn ${dirty ? 'is-danger' : 'is-accent'}`} disabled={busy} onClick={() => void submit()}>
            {busy ? 'Connexion…' : dirty ? 'Abandonner les modifications et rejoindre' : 'Rejoindre'}
          </button>
        </>
      }
    >
      <form className="cf-form" onSubmit={(e) => void submit(e)}>
        <p className="cf-dialog-text">
          Rejoindre la session <b>« {link.room} »</b> sur l’hôte <b>{linkHost(link)}</b> ?
        </p>
        <IdentityFields name={name} color={color} onName={setName} onColor={setColor} disabled={busy} />
        {dirty && <div className="cf-invite-warn">La scène ouverte a des modifications non enregistrées : elle sera remplacée par celle de la session. Enregistrez-la d’abord si besoin.</div>}
        {inSession && <div className="cf-invite-warn">Vous quitterez la session en cours.</div>}
        {!link.token && <Hint>Ce lien ne contient pas de jeton : la session doit être ouverte (sans mot de passe).</Hint>}
        {error && <div className="cf-form-error">{error}</div>}
        <button type="submit" hidden />
      </form>
      <ConnectionTester target={link} runKey={testRun} disabled={busy} />
      <RemoteHelp />
    </Dialog>
  );
}

// ------------------------------------------------------------------ rejoindre

interface RecentSession {
  url: string;
  room: string;
  time: number;
}

const RECENT_KEY = 'session.recent';
const MAX_RECENT = 6;

function loadRecent(): RecentSession[] {
  const list = loadStored<RecentSession[]>(RECENT_KEY, []);
  return list.filter((r) => r && typeof r.url === 'string' && typeof r.room === 'string').slice(0, MAX_RECENT);
}

function rememberSession(url: string, room: string): void {
  const list = loadRecent().filter((r) => !(r.url === url && r.room === room));
  list.unshift({ url, room, time: Date.now() });
  saveStored(RECENT_KEY, list.slice(0, MAX_RECENT));
}

function formatDate(t: number): string {
  try {
    return new Date(t).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function JoinDialog() {
  const user = useApp((s) => s.user);
  const [recent, setRecent] = useState(loadRecent);
  const [url, setUrl] = useState(recent[0]?.url ?? `ws://localhost:${DEFAULT_PORT}`);
  const [room, setRoom] = useState(recent[0]?.room ?? '');
  const [name, setName] = useState(user.name);
  const [color, setColor] = useState(user.color);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testRun, setTestRun] = useState(0);

  // Un lien d'invitation collé dans le champ d'adresse remplace adresse, salle et mot de passe.
  const linkInput = looksLikeInviteLink(url);
  const parsed = linkInput ? parseInviteLink(url) : null;
  const link = parsed?.ok ? parsed.link : null;
  const testTarget = link ?? (!linkInput && WS_URL.test(url.trim()) ? url.trim() : null);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    const idErr = applyIdentity(name, color);
    if (idErr) return setError(idErr);
    if (parsed && !parsed.ok) return setError(`Lien d’invitation invalide : ${parsed.error}`);
    const r = link ? link.room : room.trim();
    const u = link ? `${link.tls ? 'wss' : 'ws'}://${linkHost(link)}` : url.trim();
    if (!link) {
      if (!u || /^wss?:\/\/?$/i.test(u)) return setError('Indiquez l’adresse du serveur (ex. ws://192.168.1.20:4455) ou collez un lien d’invitation.');
      if (!isValidRoomName(r)) return setError(ROOM_RULE);
    }
    const s = store.getState();
    if (s.dirty && !window.confirm('Rejoindre une session remplace la scène ouverte, qui a des modifications non enregistrées. Continuer ?')) return;
    setError(null);
    setBusy(true);
    try {
      if (link) await joinFromLink(link);
      else await joinSession({ url: u, room: r, password: password || undefined });
      rememberSession(u, r);
      closeDialog();
    } catch (err) {
      setError(errorText(err));
      setTestRun((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Rejoindre une session"
      icon={LogIn}
      width={460}
      busy={busy}
      footer={
        <>
          <div className="cf-spacer" />
          <button type="button" className="cf-btn" disabled={busy} onClick={closeDialog}>
            Annuler
          </button>
          <button type="button" className="cf-btn is-accent" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Connexion…' : 'Rejoindre'}
          </button>
        </>
      }
    >
      <form className="cf-form" onSubmit={(e) => void submit(e)}>
        <Field label="Adresse ou lien" value={url} onChange={setUrl} placeholder="ws://192.168.1.20:4455 ou coforge://join?…" maxLength={1024} disabled={busy} autoFocus />
        {link && (
          <div className="cf-invite-ok">
            Invitation reconnue : session <b>« {link.room} »</b> sur <b>{linkHost(link)}</b>
            {link.token ? ' (aucun mot de passe nécessaire).' : '.'}
          </div>
        )}
        {parsed && !parsed.ok && <div className="cf-form-error">Lien d’invitation invalide : {parsed.error}</div>}
        {!linkInput && (
          <>
            <Field label="Salle" value={room} onChange={setRoom} maxLength={64} disabled={busy} />
            <Field label="Mot de passe" type="password" value={password} onChange={setPassword} placeholder="si la salle en a un" disabled={busy} />
          </>
        )}
        <div className="cf-form-sep" />
        <IdentityFields name={name} color={color} onName={setName} onColor={setColor} disabled={busy} />
        {error && <div className="cf-form-error">{error}</div>}
        <button type="submit" hidden />
      </form>
      <ConnectionTester target={testTarget} runKey={testRun} disabled={busy} />
      {recent.length > 0 && (
        <div className="cf-recent">
          <div className="cf-group-label">
            <History size={12} /> Sessions récentes
          </div>
          {recent.map((r) => (
            <div
              key={`${r.url}|${r.room}`}
              className={`cf-recent-item${r.url === url && r.room === room ? ' is-active' : ''}`}
              onClick={() => {
                if (busy) return;
                setUrl(r.url);
                setRoom(r.room);
              }}
            >
              <span className="cf-recent-room">{r.room}</span>
              <span className="cf-recent-url">{r.url}</span>
              <span className="cf-recent-date">{formatDate(r.time)}</span>
              <button
                type="button"
                tabIndex={-1}
                className="cf-recent-remove"
                data-tip="Oublier cette session"
                onClick={(e) => {
                  e.stopPropagation();
                  const next = recent.filter((x) => x !== r);
                  saveStored(RECENT_KEY, next);
                  setRecent(next);
                }}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
      <Hint>La scène de la session remplace la scène ouverte. Si la salle est vide, votre scène y est publiée.</Hint>
      <RemoteHelp />
    </Dialog>
  );
}

// ------------------------------------------------------------------ fenêtres hors `store.dialog`

/** Dialogue « Inviter » et confirmation d'un lien reçu ; branche aussi la réception des liens coforge://. */
export function SessionOverlays() {
  const inviteOpen = useSessionUi((s) => s.inviteOpen);
  const pendingLink = useSessionUi((s) => s.pendingLink);
  const offline = useApp((s) => s.session.status === 'offline');
  useEffect(() => bindInviteLinks(), []);
  useEffect(() => {
    if (offline && inviteOpen) closeInviteDialog();
  }, [offline, inviteOpen]);
  if (pendingLink) return <JoinLinkDialog key={`${pendingLink.host}|${pendingLink.port}|${pendingLink.room}|${pendingLink.token}`} link={pendingLink} />;
  if (inviteOpen && !offline) return <InviteDialog />;
  return null;
}
