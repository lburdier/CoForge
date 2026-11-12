import { useState, type FormEvent } from 'react';
import { Copy, History, LogIn, LogOut, Server, X } from 'lucide-react';
import { getApp } from '../../app/context';
import { DEFAULT_PORT, platform } from '../../app/platform';
import { hostSession, joinSession, leaveSession } from '../../app/session';
import { setUser, store, toast, useApp } from '../../app/store';
import { copyText, isHexColor, loadStored, normalizeText, saveStored } from '../lib/util';
import { ColorField, Hint, IconButton } from '../widgets/basic';
import { Dialog, Field, FormRow, closeDialog } from './Dialog';

/** Nom de salle : lettres, chiffres, tirets, points et soulignés. */
const ROOM_RE = /^[\p{L}\p{N}._-]{1,64}$/u;

function errorText(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

function defaultRoom(): string {
  const base = normalizeText(getApp().doc.getScene().name)
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'atelier';
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

// ------------------------------------------------------------------ héberger

interface HostPrefs {
  port: number;
  room: string;
}

function HostActive() {
  const session = useApp((s) => s.session);
  const [stopping, setStopping] = useState(false);
  return (
    <Dialog
      title="Session hébergée"
      icon={Server}
      width={420}
      busy={stopping}
      footer={
        <>
          <button
            type="button"
            className="cf-btn is-danger"
            disabled={stopping}
            onClick={() => {
              setStopping(true);
              leaveSession()
                .then(() => toast('Session arrêtée — la scène reste ouverte en local'))
                .catch((err) => toast(errorText(err), 'error'))
                .finally(() => setStopping(false));
            }}
          >
            <LogOut size={13} /> Arrêter la session
          </button>
          <div className="cf-spacer" />
          <button type="button" className="cf-btn is-accent" onClick={closeDialog}>
            Fermer
          </button>
        </>
      }
    >
      <p className="cf-dialog-text">
        Votre scène est partagée. Communiquez aux invités l’une de ces adresses et le nom de la salle (menu Session › Rejoindre).
      </p>
      <div className="cf-share-list">
        <div className="cf-share-line">
          <span className="cf-dim">Salle</span>
          <code>{session.room ?? '—'}</code>
          <IconButton icon={Copy} tip="Copier le nom de la salle" onClick={() => void copyText(session.room ?? '')} />
        </div>
        {session.shareAddresses.map((a, i) => (
          <div key={a} className="cf-share-line">
            <span className="cf-dim">{i === 0 ? 'Adresse' : ''}</span>
            <code>{a}</code>
            <IconButton icon={Copy} tip="Copier l'adresse" onClick={() => void copyText(a)} />
          </div>
        ))}
        {session.shareAddresses.length === 0 && <Hint>Aucune adresse réseau détectée : les invités doivent être sur cette machine (ws://localhost).</Hint>}
      </div>
      <Hint>
        Les invités doivent être sur le même réseau local. Pour une connexion depuis Internet, ouvrez le port sur votre box ou utilisez un
        serveur dédié.
      </Hint>
    </Dialog>
  );
}

function HostForm() {
  const user = useApp((s) => s.user);
  const prefs = loadStored<HostPrefs>('session.host', { port: DEFAULT_PORT, room: '' });
  const [name, setName] = useState(user.name);
  const [color, setColor] = useState(user.color);
  const [port, setPort] = useState(String(Number.isInteger(prefs.port) ? prefs.port : DEFAULT_PORT));
  const [room, setRoom] = useState(typeof prefs.room === 'string' && prefs.room ? prefs.room : defaultRoom());
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
    if (!ROOM_RE.test(r)) return setError('Nom de salle invalide (lettres, chiffres, « - », « _ », « . »).');
    setError(null);
    setBusy(true);
    try {
      await hostSession({ port: p, room: r, password: password || undefined });
      saveStored('session.host', { port: p, room: r });
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
      width={420}
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
        <Field label="Mot de passe" type="password" value={password} onChange={setPassword} placeholder="facultatif" disabled={busy} />
        {!native && <div className="cf-form-error">L’hébergement n’est disponible que dans l’application Windows. Rejoignez plutôt un serveur dédié.</div>}
        {error && <div className="cf-form-error">{error}</div>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

export function HostDialog() {
  const hosting = useApp((s) => s.session.hosting && s.session.status !== 'offline');
  return hosting ? <HostActive /> : <HostForm />;
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

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    const idErr = applyIdentity(name, color);
    if (idErr) return setError(idErr);
    const u = url.trim();
    if (!u || /^wss?:\/\/?$/i.test(u)) return setError('Indiquez l’adresse du serveur (ex. ws://192.168.1.20:4455).');
    const r = room.trim();
    if (!ROOM_RE.test(r)) return setError('Nom de salle invalide (lettres, chiffres, « - », « _ », « . »).');
    const s = store.getState();
    if (s.dirty && !window.confirm('Rejoindre une session remplace la scène ouverte, qui a des modifications non enregistrées. Continuer ?')) return;
    setError(null);
    setBusy(true);
    try {
      await joinSession({ url: u, room: r, password: password || undefined });
      rememberSession(u, r);
      closeDialog();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Rejoindre une session"
      icon={LogIn}
      width={440}
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
        <Field label="Adresse du serveur" value={url} onChange={setUrl} placeholder="ws://192.168.1.20:4455" disabled={busy} autoFocus />
        <Field label="Salle" value={room} onChange={setRoom} maxLength={64} disabled={busy} />
        <Field label="Mot de passe" type="password" value={password} onChange={setPassword} placeholder="si la salle en a un" disabled={busy} />
        <div className="cf-form-sep" />
        <IdentityFields name={name} color={color} onName={setName} onColor={setColor} disabled={busy} />
        {error && <div className="cf-form-error">{error}</div>}
        <button type="submit" hidden />
      </form>
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
    </Dialog>
  );
}
