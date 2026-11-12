import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Download, Info, Loader2, Users } from 'lucide-react';
import { useApp, type ImportReport } from '../../app/store';
import { formatCount } from '../lib/util';
import { Hint } from '../widgets/basic';
import { Dialog, closeDialog } from './Dialog';

// ------------------------------------------------------------------ rapport d'import

const COUNT_ROWS: { key: keyof ImportReport['counts']; one: string; many: string }[] = [
  { key: 'objects', one: 'objet', many: 'objets' },
  { key: 'meshes', one: 'maillage', many: 'maillages' },
  { key: 'lights', one: 'lumière', many: 'lumières' },
  { key: 'cameras', one: 'caméra', many: 'caméras' },
  { key: 'empties', one: 'vide', many: 'vides' },
  { key: 'materials', one: 'matériau', many: 'matériaux' },
  { key: 'collections', one: 'collection', many: 'collections' },
];

/** Phrase sur le Blender installé : celui qui a servi, ou pourquoi il n'a pas pu servir. */
export function blenderMention(blender: ImportReport['blender']): { text: string; warn: boolean } | null {
  if (!blender) return null;
  const version = blender.version ? ` ${blender.version}` : '';
  switch (blender.status) {
    case 'used':
      return { text: `Blender${version} installé sur cette machine a fourni la géométrie finale de ce que CoForge ne reconstruit pas lui-même.`, warn: false };
    case 'missing':
      return {
        text: 'Blender non trouvé : installez Blender pour reprendre courbes, textes et modificateurs avancés avec leur géométrie finale.',
        warn: true,
      };
    default:
      return { text: `Blender${version} n'a pas pu évaluer ce fichier${blender.error ? ` : ${blender.error}` : '.'}`, warn: true };
  }
}

/** Dialogue « Rapport d'import » : comptes par type, Blender utilisé, avertissements du dernier import. */
export function ImportReportDialog() {
  const report = useApp((s) => s.importReport);
  const footer = (
    <>
      <div className="cf-spacer" />
      <button type="button" className="cf-btn is-accent" onClick={closeDialog} data-autofocus="">
        Fermer
      </button>
    </>
  );
  if (!report) {
    return (
      <Dialog title="Rapport d'import" icon={Download} width={420} footer={footer}>
        <Hint>Aucun import récent.</Hint>
      </Dialog>
    );
  }
  const mention = blenderMention(report.blender);
  const rows = COUNT_ROWS.filter((r) => report.counts[r.key] > 0);
  return (
    <Dialog title="Rapport d'import" icon={Download} width={540} className="cf-import-report" footer={footer}>
      <p className="cf-dialog-text">
        « {report.fileName} » {report.mode === 'open' ? 'a été ouvert comme nouvelle scène (non enregistrée : Enregistrer créera un fichier .coforge).' : 'a été ajouté à la scène.'}
      </p>
      <div className="cf-import-counts">
        {rows.map((r) => (
          <span key={r.key} className="cf-import-count">
            <strong>{formatCount(report.counts[r.key])}</strong> {report.counts[r.key] > 1 ? r.many : r.one}
          </span>
        ))}
      </div>
      {mention && (
        <div className={`cf-import-note${mention.warn ? ' is-warn' : ''}`}>
          {mention.warn ? <AlertTriangle size={13} /> : <Info size={13} />}
          <span>{mention.text}</span>
        </div>
      )}
      {report.shared && (
        <div className="cf-import-note">
          <Users size={13} />
          <span>Session collaborative : cet import est écrit dans le document partagé, il est visible par tous les participants.</span>
        </div>
      )}
      {report.warnings.length > 0 && (
        <>
          <div className="cf-group-label">
            {report.warnings.length > 1 ? `${report.warnings.length} avertissements` : '1 avertissement'}
          </div>
          <ul className="cf-import-warnings">
            {report.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}

// ------------------------------------------------------------------ état occupé et zone de dépôt

/**
 * Voile affiché pendant un travail long (`store.busy` : import, évaluation par Blender…).
 * L'interface reste animée mais ses entrées sont suspendues : le voile reçoit les clics et
 * aucune frappe n'atteint les raccourcis ni les champs.
 */
function BusyOverlay() {
  const busy = useApp((s) => s.busy);
  const active = busy !== null;

  useEffect(() => {
    if (!active) return;
    const swallow = (e: KeyboardEvent) => {
      e.stopPropagation();
      e.preventDefault();
    };
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.addEventListener('keydown', swallow, true);
    window.addEventListener('keyup', swallow, true);
    return () => {
      window.removeEventListener('keydown', swallow, true);
      window.removeEventListener('keyup', swallow, true);
    };
  }, [active]);

  if (!busy) return null;
  return createPortal(
    <div className="cf-busy" role="alert" aria-busy="true" aria-live="assertive" onContextMenu={(e) => e.preventDefault()}>
      <div className="cf-busy-box">
        <Loader2 size={18} className="cf-spin" />
        <div className="cf-busy-text">
          <span>{busy.text}</span>
          <span className="cf-busy-hint">Une scène lourde peut demander plusieurs minutes.</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Indication visuelle pendant qu'on survole la fenêtre avec des fichiers (`store.dropActive`). */
function DropOverlay() {
  const active = useApp((s) => s.dropActive);
  if (!active) return null;
  return createPortal(
    <div className="cf-drop">
      <div className="cf-drop-box">
        <Download size={26} />
        <span className="cf-drop-title">Déposez pour ouvrir ou importer</span>
        <span className="cf-drop-hint">.coforge : ouvrir la scène — .blend, glTF, FBX, OBJ, STL, PLY, Collada : importer dans la scène</span>
      </div>
    </div>,
    document.body,
  );
}

/** Couches liées aux fichiers, au-dessus de toute l'interface : zone de dépôt et état occupé. */
export function ImportOverlays() {
  return (
    <>
      <DropOverlay />
      <BusyOverlay />
    </>
  );
}
