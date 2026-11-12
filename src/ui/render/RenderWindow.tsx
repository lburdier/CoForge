import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Image as ImageIcon, Loader2, RefreshCw, Save, Square, X } from 'lucide-react';
import { getApp } from '../../app/context';
import { useDoc } from '../../app/hooks';
import { platform } from '../../app/platform';
import { patchRender, toast, useApp } from '../../app/store';
import { useLatest } from '../lib/util';

/** Convertit une data URL (base64) en octets. */
function dataUrlToBytes(url: string): Uint8Array {
  const comma = url.indexOf(',');
  if (comma < 0 || !/;base64$/i.test(url.slice(0, comma))) throw new Error('Image de rendu illisible');
  const bin = atob(url.slice(comma + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'rendu';
}

async function saveImage(url: string): Promise<void> {
  const data = dataUrlToBytes(url);
  const scene = getApp().doc.getScene().name;
  const path = await platform.saveFile(data, null, `${safeFileName(scene)}.png`, [{ name: 'Image PNG', extensions: ['png'] }]);
  if (path) toast(`Image enregistrée : ${path.split(/[\\/]/).pop()}`);
}

/** Fenêtre du rendu final : image, progression, annulation, enregistrement. */
export function RenderWindow() {
  const open = useApp((s) => s.render.open);
  if (!open) return null;
  return <RenderWindowInner />;
}

function RenderWindowInner() {
  const running = useApp((s) => s.render.running);
  const progress = useApp((s) => s.render.progress);
  const samples = useApp((s) => s.render.samples);
  const imageUrl = useApp((s) => s.render.imageUrl);
  const settings = useDoc((doc) => doc.getScene().render, ['scene']);
  const [saving, setSaving] = useState(false);
  const [zoomFit, setZoomFit] = useState(true);
  /** Fermer ne stoppe pas le rendu : il continue en arrière-plan (progression dans la barre d'état, F11 pour revoir). */
  const close = () => patchRender({ open: false });
  /** Échap : annule le rendu en cours, sinon ferme la fenêtre (comme Blender). */
  const escape = () => {
    if (running) getApp().viewport.cancelRender();
    else close();
  };
  const latest = useLatest({ escape });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.cf-menu, .cf-dialog')) return;
      e.preventDefault();
      e.stopPropagation();
      latest.current.escape();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  const pathtrace = settings.engine === 'pathtrace';
  const status = running
    ? `Rendu en cours… ${pct} %${pathtrace ? `, ${samples}/${settings.samples} échantillons` : ''}`
    : imageUrl
      ? `Terminé : ${settings.resX} × ${settings.resY} px${pathtrace ? `, ${samples || settings.samples} échantillons` : ''}`
      : 'Rendu interrompu';

  return createPortal(
    <div className="cf-render-backdrop" onContextMenu={(e) => e.preventDefault()}>
      <div className="cf-render-window" role="dialog" aria-label="Rendu" onKeyDown={(e) => e.stopPropagation()}>
        <header className="cf-dialog-header">
          <ImageIcon size={14} />
          <span className="cf-dialog-title">Rendu - {pathtrace ? 'Path tracing' : 'Temps réel'}</span>
          <button type="button" tabIndex={-1} className="cf-dialog-close" aria-label="Fermer" onClick={close}>
            <X size={14} />
          </button>
        </header>
        <div
          className={`cf-render-view${zoomFit ? ' is-fit' : ''}`}
          onDoubleClick={() => setZoomFit((z) => !z)}
          data-tip={imageUrl ? (zoomFit ? 'Double-clic : taille réelle' : 'Double-clic : ajuster à la fenêtre') : undefined}
        >
          {imageUrl ? (
            <img src={imageUrl} alt="Image rendue" draggable={false} style={{ aspectRatio: `${settings.resX} / ${settings.resY}` }} />
          ) : (
            <div className="cf-render-placeholder" style={{ aspectRatio: `${settings.resX} / ${settings.resY}` }}>
              {running ? <Loader2 size={28} className="cf-spin" /> : <ImageIcon size={28} />}
              <span>{running ? 'Calcul de l’image…' : 'Aucune image'}</span>
            </div>
          )}
        </div>
        <div className="cf-render-progress" aria-hidden={!running}>
          <div className="cf-render-progress-bar" style={{ width: `${running ? pct : imageUrl ? 100 : 0}%` }} />
        </div>
        <footer className="cf-dialog-footer">
          <span className="cf-render-status">{status}</span>
          <div className="cf-spacer" />
          {running ? (
            <button type="button" className="cf-btn is-danger" onClick={() => getApp().viewport.cancelRender()}>
              <Square size={12} /> Annuler
            </button>
          ) : (
            <button type="button" className="cf-btn" onClick={() => getApp().ops.run('render.render')} data-tip="Relancer le rendu (F12)">
              <RefreshCw size={13} /> Relancer
            </button>
          )}
          <button
            type="button"
            className="cf-btn is-accent"
            disabled={!imageUrl || running || saving}
            onClick={() => {
              if (!imageUrl) return;
              setSaving(true);
              saveImage(imageUrl)
                .catch((err) => toast(`Enregistrement impossible : ${(err as Error)?.message ?? err}`, 'error'))
                .finally(() => setSaving(false));
            }}
          >
            <Save size={13} /> Enregistrer l’image…
          </button>
          <button type="button" className="cf-btn" onClick={close}>
            Fermer
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
