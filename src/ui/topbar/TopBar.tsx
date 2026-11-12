import { useEffect, useRef, useState } from 'react';
import { Anvil, Clapperboard, Copy, LogIn, LogOut, MessageSquare, Share2, Users } from 'lucide-react';
import { getApp } from '../../app/context';
import { useDoc } from '../../app/hooks';
import { leaveSession } from '../../app/session';
import { store, toast, useApp, type SessionStatus } from '../../app/store';
import { TOP_MENUS } from '../../tools/menus';
import { useChatLastRead } from '../lib/chatRead';
import { copyText } from '../lib/util';
import { WORKSPACES, applyWorkspace } from '../lib/workspaces';
import { Avatar, IconButton, TextField } from '../widgets/basic';
import { MenuBar, Popover } from '../widgets/Menu';

// ------------------------------------------------------------------ espaces de travail

function WorkspaceTabs() {
  const workspace = useApp((s) => s.workspace);
  return (
    <div className="cf-workspaces" role="tablist">
      {WORKSPACES.map((w) => (
        <button
          key={w.id}
          type="button"
          role="tab"
          tabIndex={-1}
          aria-selected={workspace === w.id}
          data-tip={w.tip}
          className={`cf-workspace${workspace === w.id ? ' is-active' : ''}`}
          onClick={() => applyWorkspace(w.id)}
        >
          {w.label}
        </button>
      ))}
    </div>
  );
}

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

function SharePopover({ anchorEl, onClose }: { anchorEl: Element | null; onClose(): void }) {
  const session = useApp((s) => s.session);
  const addresses = session.hosting && session.shareAddresses.length ? session.shareAddresses : session.url ? [session.url] : [];
  return (
    <Popover anchorEl={anchorEl} onClose={onClose} align="right" className="cf-share">
      <div className="cf-popover-title">{session.hosting ? 'Vous hébergez la session' : 'Session en cours'}</div>
      <div className="cf-share-line">
        <span className="cf-dim">Nom de session</span>
        <code>{session.room ?? '-'}</code>
        <IconButton icon={Copy} tip="Copier le nom" onClick={() => void copyText(session.room ?? '')} />
      </div>
      {addresses.map((a) => (
        <div key={a} className="cf-share-line">
          <span className="cf-dim">Adresse</span>
          <code>{a}</code>
          <IconButton icon={Copy} tip="Copier l'adresse" onClick={() => void copyText(a)} />
        </div>
      ))}
      {session.hosting && (
        <div className="cf-hint">Les invités doivent être sur le même réseau local. Depuis Internet : redirection de port ou serveur dédié.</div>
      )}
      {session.error && <div className="cf-form-error">{session.error}</div>}
      <div className="cf-popover-actions">
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
  const [shareOpen, setShareOpen] = useState(false);
  const shareRef = useRef<HTMLButtonElement | null>(null);

  // Le pair suivi a quitté la session : on arrête de le suivre.
  useEffect(() => {
    if (follow !== null && !peers.some((p) => p.clientId === follow)) store.setState({ followClientId: null });
  }, [follow, peers]);

  useEffect(() => {
    if (status === 'offline') setShareOpen(false);
  }, [status]);

  const offline = status === 'offline';

  return (
    <div className="cf-session">
      <span className={`cf-status is-${status}`} data-tip={`État de la session : ${STATUS_LABELS[status]}`}>
        <span className="cf-status-dot" />
        {STATUS_LABELS[status]}
        {status === 'connected' && (
          <span className="cf-status-count" data-tip={`${peers.length} autre(s) utilisateur(s) connecté(s)`}>
            <Users size={11} /> {peers.length + 1}
          </span>
        )}
      </span>
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
      {offline && <IconButton icon={LogIn} tip="Rejoindre une session" onClick={() => store.setState({ dialog: 'join' })} />}
      <button
        ref={shareRef}
        type="button"
        tabIndex={-1}
        className={`cf-btn is-accent${shareOpen ? ' is-open' : ''}`}
        data-tip={offline ? 'Héberger une session et inviter des collaborateurs' : 'Adresses de la session'}
        onClick={() => {
          if (offline) store.setState({ dialog: 'host' });
          else setShareOpen((o) => !o);
        }}
      >
        <Share2 size={13} /> Partager
      </button>
      {shareOpen && !offline && <SharePopover anchorEl={shareRef.current} onClose={() => setShareOpen(false)} />}
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
      <WorkspaceTabs />
      <div className="cf-spacer" />
      <SceneName />
      <SessionWidget />
    </div>
  );
}
