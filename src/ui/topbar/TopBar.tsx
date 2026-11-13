import { useEffect, useRef, useState } from 'react';
import { Anvil, Clapperboard, LogIn, LogOut, MessageSquare, RefreshCw, Share2, UserPlus, Users } from 'lucide-react';
import { getApp } from '../../app/context';
import { useDoc } from '../../app/hooks';
import { leaveSession, openInviteDialog } from '../../app/session';
import { store, toast, useApp, type SessionStatus } from '../../app/store';
import { TOP_MENUS } from '../../tools/menus';
import { useChatLastRead } from '../lib/chatRead';
import { Avatar, IconButton, TextField } from '../widgets/basic';
import { MenuBar, Popover } from '../widgets/Menu';
import { WorkspaceTabs } from './WorkspaceTabs';
import { connectionText, pendingText, retryNow, transferPercent, useConnection, useNow } from '../dialogs/connection';
import '../dialogs/session.css';

// ------------------------------------------------------------------ nom de scène

function SceneName() {
  const name = useDoc((doc) => doc.getScene().name, ['scene']);
  const filePath = useApp((s) => s.filePath);
  const dirty = useApp((s) => s.dirty);
  const file = filePath ? filePath.split(/[\\/]/).pop() : null;
  return (
    <div className="cf-scene-name" data-tip="Nom de la scène">
      <Clapperboard size={13} />
      <TextField value={name} onCommit={(t) => getApp().doc.setSceneName(t.trim() || 'Scène')} maxLength={60} />
      {(file || dirty) && (
        <span className="cf-scene-file">
          {file ?? 'non enregistrée'}
          {dirty ? ' *' : ''}
        </span>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ session

export const STATUS_LABELS: Record<SessionStatus, string> = {
  offline: 'Hors ligne',
  connecting: 'Connexion…',
  connected: 'Connecté',
  reconnecting: 'Reconnexion…',
};

function quitSession(): void {
  leaveSession().catch((err: unknown) => toast((err as Error)?.message ?? 'Impossible de quitter la session', 'error'));
}

/** Détails de la connexion : état, tentatives, latence, modifications en attente, « Réessayer maintenant ». */
function ConnectionPopover({ anchorEl, onClose }: { anchorEl: Element | null; onClose(): void }) {
  const session = useApp((s) => s.session);
  const info = useConnection();
  const now = useNow(info.nextRetryAt !== null);
  const lost = info.phase === 'reconnecting' || info.phase === 'offline';
  return (
    <Popover anchorEl={anchorEl} onClose={onClose} align="right" className="cf-share cf-conn-popover">
      <div className="cf-popover-title">{session.hosting ? 'Vous hébergez la session' : 'Session en cours'}</div>
      <div className="cf-conn-grid">
        <span>État</span>
        <span>{connectionText(info, now)}</span>
        <span>Session</span>
        <span>{session.room ?? '-'}</span>
        <span>Serveur</span>
        <span>{session.url ?? '-'}</span>
        {info.latencyMs !== null && (
          <>
            <span>Latence</span>
            <span>{info.latencyMs} ms</span>
          </>
        )}
        {info.pendingChanges > 0 && (
          <>
            <span>En attente</span>
            <span>
              {pendingText(info.pendingChanges)}
              {lost ? ' : elles partiront au retour de la connexion' : ''}
            </span>
          </>
        )}
        {info.serverVersion && (
          <>
            <span>Serveur</span>
            <span>
              CoForge {info.serverVersion} (protocole {info.protocol})
            </span>
          </>
        )}
        {info.role && (
          <>
            <span>Accès</span>
            <span>{info.role === 'guest' ? 'invité (lien d’invitation)' : info.secured ? 'administrateur (mot de passe)' : 'session ouverte'}</span>
          </>
        )}
      </div>
      {session.error && <div className="cf-form-error">{session.error}</div>}
      <div className="cf-popover-actions">
        {lost && (
          <button type="button" className="cf-btn is-accent" onClick={() => retryNow()}>
            <RefreshCw size={13} /> Réessayer maintenant
          </button>
        )}
        <button
          type="button"
          className="cf-btn is-danger"
          onClick={() => {
            onClose();
            quitSession();
          }}
        >
          <LogOut size={13} /> {session.hosting ? 'Arrêter la session' : 'Quitter la session'}
        </button>
      </div>
    </Popover>
  );
}

function ChatButton() {
  const open = useApp((s) => s.dialog === 'chat');
  const userId = useApp((s) => s.user.id);
  const lastRead = useChatLastRead();
  const unread = useDoc((doc) => doc.getChat().filter((m) => m.userId !== userId && m.time > lastRead).length, ['chat'], [userId, lastRead]);
  return (
    <span className="cf-badge-host">
      <IconButton
        icon={MessageSquare}
        tip="Discussion"
        active={open}
        onClick={() => store.setState({ dialog: open ? null : 'chat' })}
      />
      {!open && unread > 0 && <span className="cf-badge">{unread > 99 ? '99+' : unread}</span>}
    </span>
  );
}

function SessionWidget() {
  const status = useApp((s) => s.session.status);
  const peers = useApp((s) => s.session.peers);
  const user = useApp((s) => s.user);
  const follow = useApp((s) => s.followClientId);
  const info = useConnection();
  const now = useNow(info.nextRetryAt !== null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const statusRef = useRef<HTMLButtonElement | null>(null);

  // Le pair suivi a quitté la session : on arrête de le suivre.
  useEffect(() => {
    if (follow !== null && !peers.some((p) => p.clientId === follow)) store.setState({ followClientId: null });
  }, [follow, peers]);

  useEffect(() => {
    if (status === 'offline') setDetailsOpen(false);
  }, [status]);

  const offline = status === 'offline';
  // « Hors ligne » quand le réseau manque depuis plusieurs tentatives, « Erreur » après un refus définitif.
  const shown = info.phase === 'offline' ? 'offline-pending' : info.phase === 'error' ? 'error' : status;
  const label =
    info.phase === 'offline'
      ? `Hors ligne${info.pendingChanges ? ` (${info.pendingChanges} en attente)` : ''}`
      : info.phase === 'error'
        ? 'Erreur'
        : info.phase === 'connecting' && info.transfer
          ? `Réception ${transferPercent(info)} %`
          : STATUS_LABELS[status];

  return (
    <div className="cf-session">
      <button
        ref={statusRef}
        type="button"
        tabIndex={-1}
        className={`cf-status is-${shown}`}
        data-tip={offline ? (info.error ?? 'Hors session') : `${connectionText(info, now)} - clic : détails`}
        onClick={() => {
          if (offline) store.setState({ dialog: 'join' });
          else setDetailsOpen((o) => !o);
        }}
      >
        <span className="cf-status-dot" />
        {label}
        {status === 'connected' && (
          <span className="cf-status-count" data-tip={`${peers.length} autre(s) utilisateur(s) connecté(s)`}>
            <Users size={11} /> {peers.length + 1}
          </span>
        )}
      </button>
      {detailsOpen && !offline && <ConnectionPopover anchorEl={statusRef.current} onClose={() => setDetailsOpen(false)} />}
      <div className="cf-peers">
        {peers.slice(0, 8).map((p) => (
          <Avatar
            key={p.clientId}
            name={p.name}
            color={p.color}
            active={follow === p.clientId}
            tip={follow === p.clientId ? `${p.name} - clic : arrêter de suivre` : `${p.name} - clic : suivre sa vue`}
            onClick={() => store.setState({ followClientId: follow === p.clientId ? null : p.clientId })}
          />
        ))}
        {peers.length > 8 && <span className="cf-dim">+{peers.length - 8}</span>}
        <Avatar name={user.name} color={user.color} tip={`${user.name} (vous) - préférences`} onClick={() => store.setState({ dialog: 'preferences' })} />
      </div>
      {offline && <IconButton icon={LogIn} tip="Rejoindre une session (adresse ou lien d’invitation)" onClick={() => store.setState({ dialog: 'join' })} />}
      {offline ? (
        <button
          type="button"
          tabIndex={-1}
          className="cf-btn is-accent"
          data-tip="Héberger une session et inviter des collaborateurs"
          onClick={() => store.setState({ dialog: 'host' })}
        >
          <Share2 size={13} /> Partager
        </button>
      ) : (
        <button type="button" tabIndex={-1} className="cf-btn is-accent" data-tip="Créer et copier un lien d’invitation" onClick={() => openInviteDialog()}>
          <UserPlus size={13} /> Inviter
        </button>
      )}
      <ChatButton />
    </div>
  );
}

// ------------------------------------------------------------------ barre supérieure

export function TopBar() {
  return (
    <div className="cf-topbar">
      <div className="cf-logo">
        <Anvil size={15} />
        <span>CoForge</span>
      </div>
      <MenuBar menus={TOP_MENUS} />
      {/* La barre d'onglets occupe l'espace libre : clic droit dans la zone vide = menu des espaces de travail. */}
      <WorkspaceTabs />
      <SceneName />
      <SessionWidget />
    </div>
  );
}
