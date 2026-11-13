import { memo } from 'react';
import { AlertTriangle, Download, Image as ImageIcon, Info, Redo2, Undo2, Wifi, WifiOff } from 'lucide-react';
import { useDoc } from '../../app/hooks';
import { platform } from '../../app/platform';
import { patchRender, store, useApp } from '../../app/store';
import { runOp } from '../lib/ops';
import { useActiveToast } from '../lib/toast';
import { IconButton } from '../widgets/basic';
import { STATUS_LABELS } from '../topbar/TopBar';
import { openInviteDialog } from '../../app/session';
import { connectionText, pendingText, retryNow, transferPercent, useConnection, useNow } from '../dialogs/connection';
import '../dialogs/session.css';

/** Une aide « touche / souris → action » de la barre d'état. */
interface HintItem {
  keys: string;
  text: string;
}

const OBJECT_HINTS: HintItem[] = [
  { keys: 'Clic', text: 'Sélectionner' },
  { keys: 'Maj+Clic', text: 'Ajouter à la sélection' },
  { keys: 'Clic milieu', text: 'Tourner la vue' },
  { keys: 'Maj+A', text: 'Ajouter' },
  { keys: 'G / R / S', text: 'Transformer' },
  { keys: 'Tab', text: 'Mode édition' },
  { keys: 'Clic droit', text: 'Menu contextuel' },
  { keys: 'F3', text: 'Rechercher' },
];

const EDIT_HINTS: HintItem[] = [
  { keys: 'Clic', text: 'Sélectionner' },
  { keys: '1 / 2 / 3', text: 'Sommets / arêtes / faces' },
  { keys: 'E', text: 'Extruder' },
  { keys: 'I', text: 'Incruster' },
  { keys: 'Ctrl+B', text: 'Biseauter' },
  { keys: 'Ctrl+R', text: 'Coupe en boucle' },
  { keys: 'X', text: 'Supprimer' },
  { keys: 'Tab', text: 'Mode objet' },
];

const SELECT_LABELS = { vert: 'sommets', edge: 'arêtes', face: 'faces' } as const;

const Hints = memo(function Hints() {
  const modal = useApp((s) => s.modal?.status ?? null);
  const mode = useApp((s) => s.mode);
  const selectMode = useApp((s) => s.selectMode);
  if (modal !== null) {
    return (
      <div className="cf-status-hints is-modal">
        <span className="cf-status-modal">{modal}</span>
      </div>
    );
  }
  const hints = mode === 'edit' ? EDIT_HINTS : OBJECT_HINTS;
  return (
    <div className="cf-status-hints">
      {mode === 'edit' && <span className="cf-status-mode">Édition ({SELECT_LABELS[selectMode]})</span>}
      {hints.map((h) => (
        <span key={h.keys} className="cf-status-hint">
          <kbd>{h.keys}</kbd>
          {h.text}
        </span>
      ))}
    </div>
  );
});

function ToastText() {
  const toast = useActiveToast();
  if (!toast) return null;
  const Icon = toast.kind === 'error' ? AlertTriangle : Info;
  return (
    <span key={toast.time} className={`cf-status-toast is-${toast.kind}`} data-tip={toast.text}>
      <Icon size={12} />
      {toast.text}
    </span>
  );
}

function RenderProgress() {
  const running = useApp((s) => s.render.running);
  const progress = useApp((s) => s.render.progress);
  const open = useApp((s) => s.render.open);
  if (!running || open) return null;
  const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  return (
    <button type="button" tabIndex={-1} className="cf-status-render" data-tip="Afficher la fenêtre de rendu" onClick={() => patchRender({ open: true })}>
      <ImageIcon size={12} />
      <span className="cf-status-render-bar">
        <span style={{ width: `${pct}%` }} />
      </span>
      {pct} %
    </button>
  );
}

function SessionState() {
  const status = useApp((s) => s.session.status);
  const room = useApp((s) => s.session.room);
  const peers = useApp((s) => s.session.peers.length);
  const hosting = useApp((s) => s.session.hosting);
  const error = useApp((s) => s.session.error);
  const info = useConnection();
  const now = useNow(info.nextRetryAt !== null);
  const offline = status === 'offline';
  const lost = info.phase === 'reconnecting' || info.phase === 'offline';
  const Icon = offline || lost ? WifiOff : Wifi;
  let text: string;
  if (offline) text = info.phase === 'error' ? `Hors ligne - ${info.error ?? 'erreur'}` : 'Hors ligne';
  else if (lost) text = `${connectionText(info, now)} - « ${room ?? '?'} »${info.pendingChanges ? ` · ${pendingText(info.pendingChanges)}` : ''}`;
  else if (info.phase === 'connecting' && info.transfer) text = `Réception de la scène ${transferPercent(info)} %`;
  else text = `${STATUS_LABELS[status]} - « ${room ?? '?'} »${status === 'connected' ? ` · ${peers + 1} participant${peers > 0 ? 's' : ''}` : ''}${hosting ? ' (hôte)' : ''}`;
  const tip = lost
    ? 'Clic : réessayer maintenant. Vos modifications sont gardées et partiront au retour de la connexion.'
    : (error ?? (offline ? 'Héberger ou rejoindre une session' : 'Détails de la session'));
  return (
    <button
      type="button"
      tabIndex={-1}
      className={`cf-status-session is-${info.phase === 'error' ? 'error' : lost ? 'reconnecting' : status}`}
      data-tip={tip}
      onClick={() => {
        if (lost) retryNow();
        else if (offline) store.setState({ dialog: 'host' });
        else if (hosting) openInviteDialog();
        else store.setState({ showSidebar: true });
      }}
    >
      <Icon size={12} />
      {text}
      {status === 'connected' && info.latencyMs !== null && (
        <span className="cf-status-latency" data-tip="Aller-retour vers le serveur">
          · {info.latencyMs} ms
        </span>
      )}
      {status === 'connected' && info.pendingChanges > 0 && <span className="cf-status-latency">· envoi…</span>}
    </button>
  );
}

function FileState() {
  const filePath = useApp((s) => s.filePath);
  const dirty = useApp((s) => s.dirty);
  const sceneName = useDoc((doc) => doc.getScene().name, ['scene']);
  const file = filePath ? filePath.split(/[\\/]/).pop() : null;
  return (
    <span className="cf-status-file" data-tip={filePath ?? 'Scène non enregistrée'}>
      {file ?? sceneName}
      {dirty && <span className="cf-status-dirty" data-tip="Modifications non enregistrées">●</span>}
    </span>
  );
}

function UndoRedo() {
  const canUndo = useApp((s) => s.canUndo);
  const canRedo = useApp((s) => s.canRedo);
  return (
    <span className="cf-btn-group">
      <IconButton icon={Undo2} size={12} tip="Annuler" shortcut="Ctrl+Z" disabled={!canUndo} onClick={() => runOp('edit.undo')} />
      <IconButton icon={Redo2} size={12} tip="Rétablir" shortcut="Ctrl+Maj+Z" disabled={!canRedo} onClick={() => runOp('edit.redo')} />
    </span>
  );
}

/** Mise à jour en cours de téléchargement, ou prête : un clic redémarre et l'installe. */
function UpdateState() {
  const update = useApp((s) => s.update);
  if (update.state === 'downloading') {
    return (
      <span className="cf-status-update" data-tip={`Téléchargement de CoForge ${update.version ?? ''} en tâche de fond`}>
        <Download size={12} />
        Mise à jour {update.percent ?? 0} %
      </span>
    );
  }
  if (update.state !== 'ready') return null;
  return (
    <button
      type="button"
      tabIndex={-1}
      className="cf-status-update is-ready"
      data-tip="Installée automatiquement à la fermeture. Clic : redémarrer et mettre à jour maintenant"
      onClick={() => runOp('app.install_update')}
    >
      <Download size={12} />
      CoForge {update.version} prêt : redémarrer
    </button>
  );
}

/** Barre d'état en bas de la fenêtre. */
export function StatusBar() {
  return (
    <div className="cf-statusbar" onContextMenu={(e) => e.preventDefault()}>
      <Hints />
      <div className="cf-spacer" />
      <ToastText />
      <RenderProgress />
      <UpdateState />
      <SessionState />
      <FileState />
      <UndoRedo />
      <span className="cf-status-version">CoForge {platform.version}</span>
    </div>
  );
}
