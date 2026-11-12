import { memo } from 'react';
import { AlertTriangle, Image as ImageIcon, Info, Redo2, Undo2, Wifi, WifiOff } from 'lucide-react';
import { useDoc } from '../../app/hooks';
import { platform } from '../../app/platform';
import { patchRender, store, useApp } from '../../app/store';
import { runOp } from '../lib/ops';
import { useActiveToast } from '../lib/toast';
import { IconButton } from '../widgets/basic';
import { STATUS_LABELS } from '../topbar/TopBar';

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
  const offline = status === 'offline';
  const Icon = offline ? WifiOff : Wifi;
  const text = offline
    ? 'Hors ligne'
    : `${STATUS_LABELS[status]} - « ${room ?? '?'} »${status === 'connected' ? ` · ${peers + 1} participant${peers > 0 ? 's' : ''}` : ''}${hosting ? ' (hôte)' : ''}`;
  return (
    <button
      type="button"
      tabIndex={-1}
      className={`cf-status-session is-${status}`}
      data-tip={error ?? (offline ? 'Héberger ou rejoindre une session' : 'Détails de la session')}
      onClick={() => {
        if (offline || hosting) store.setState({ dialog: 'host' });
        else store.setState({ showSidebar: true });
      }}
    >
      <Icon size={12} />
      {text}
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

/** Barre d'état en bas de la fenêtre. */
export function StatusBar() {
  return (
    <div className="cf-statusbar" onContextMenu={(e) => e.preventDefault()}>
      <Hints />
      <div className="cf-spacer" />
      <ToastText />
      <RenderProgress />
      <SessionState />
      <FileState />
      <UndoRedo />
      <span className="cf-status-version">CoForge {platform.version}</span>
    </div>
  );
}
