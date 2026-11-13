import { useEffect, useState, type ReactNode } from 'react';
import { Camera, Layers, Save } from 'lucide-react';
import { compositeImageUrl } from '../../app/composite';
import { saveRenderImage } from '../../app/files';
import { getApp } from '../../app/context';
import { useApp } from '../../app/store';
import type { CompositorSettings } from '../../core/doc/schema';
import { useDocWhen } from '../properties/docHooks';
import { Checkbox, ColorField } from '../widgets/basic';
import { NumberField } from '../widgets/NumberField';
import { EditorHeader, EditorShell } from './common';

/**
 * Compositeur : chaîne de traitements appliquée au rendu final (Calques de rendu → Exposition →
 * Couleur → Vignettage → Composite), présentée comme des nœuds. Les réglages sont dans la scène
 * (partagés, annulables) ; l'aperçu montre le dernier rendu composité, et « Enregistrer l'image »
 * enregistre la version compositée quand « Utiliser les nœuds » est actif.
 */
export function CompositorEditor() {
  const s = useDocWhen((doc) => doc.getCompositor(), { scene: (e) => e.keys.some((k) => k.startsWith('c:')) });
  const renderUrl = useApp((st) => st.render.imageUrl);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof CompositorSettings>(k: K) => (v: CompositorSettings[K]) => getApp().doc.updateCompositor({ [k]: v } as Partial<CompositorSettings>);

  useEffect(() => {
    if (!renderUrl) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    let made: string | null = null;
    const t = setTimeout(() => {
      compositeImageUrl(renderUrl, s.use ? s : { ...s, useExposure: false, useColor: false, useVignette: false })
        .then((u) => {
          if (cancelled) URL.revokeObjectURL(u);
          else {
            made = u;
            setPreview(u);
            setError(null);
          }
        })
        .catch((err) => !cancelled && setError(String((err as Error)?.message ?? err)));
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
      if (made) URL.revokeObjectURL(made);
    };
  }, [renderUrl, s]);

  return (
    <EditorShell className="cf-comp">
      <EditorHeader title="Compositeur" icon={Layers}>
        <Checkbox checked={s.use} onChange={set('use')} label="Utiliser les nœuds" tip="Applique la chaîne au rendu enregistré" />
        <div className="cf-spacer" />
        <button type="button" className="cf-btn" disabled={!renderUrl} onClick={() => void saveRenderImage()} data-tip="Enregistrer l’image rendue (compositée si les nœuds sont utilisés)">
          <Save size={12} /> Enregistrer l’image
        </button>
      </EditorHeader>
      <div className={`cf-ed-body cf-comp-body${s.use ? '' : ' is-off'}`}>
        <div className="cf-comp-chain">
          <CompNode title="Calques de rendu" color="#83314a">
            <span className="cf-ed-dim">{renderUrl ? 'Dernier rendu (F12)' : 'Aucun rendu : F12 pour rendre'}</span>
          </CompNode>
          <CompNode title="Exposition / Gamma" color="#6c696f" on={s.useExposure} onToggle={set('useExposure')}>
            <NumberField label="Exposition" value={s.exposure} min={-10} max={10} step={0.05} precision={2} onChange={set('exposure')} />
            <NumberField label="Gamma" value={s.gamma} min={0.1} max={5} step={0.01} precision={2} onChange={set('gamma')} />
          </CompNode>
          <CompNode title="Correction colorimétrique" color="#6c696f" on={s.useColor} onToggle={set('useColor')}>
            <NumberField label="Contraste" value={s.contrast} min={0} max={3} step={0.01} precision={2} onChange={set('contrast')} />
            <NumberField label="Saturation" value={s.saturation} min={0} max={3} step={0.01} precision={2} onChange={set('saturation')} />
            <div className="cf-comp-row">
              <span>Teinte</span>
              <ColorField value={s.tint} onChange={set('tint')} />
            </div>
          </CompNode>
          <CompNode title="Vignettage" color="#3c3c83" on={s.useVignette} onToggle={set('useVignette')}>
            <NumberField label="Intensité" value={s.vignette} min={0} max={1} step={0.01} precision={2} slider onChange={set('vignette')} />
          </CompNode>
          <CompNode title="Composite" color="#4d0017">
            <span className="cf-ed-dim">Sortie : image enregistrée</span>
          </CompNode>
        </div>
        <div className="cf-comp-viewer">
          <div className="cf-comp-viewer-title">
            <Camera size={12} /> Visualiseur {s.use ? '' : '(nœuds désactivés : image brute)'}
          </div>
          {error && <div className="cf-ed-empty">{error}</div>}
          {preview ? <img src={preview} alt="Aperçu composité" className="cf-comp-img" /> : <div className="cf-ed-empty">Lancez un rendu (F12) pour voir le résultat composité.</div>}
        </div>
      </div>
    </EditorShell>
  );
}

function CompNode({ title, color, on, onToggle, children }: { title: string; color: string; on?: boolean; onToggle?(v: boolean): void; children: ReactNode }) {
  return (
    <div className={`cf-comp-node${on === false ? ' is-muted' : ''}`}>
      <div className="cf-comp-node-head" style={{ background: color }}>
        {onToggle && <input type="checkbox" checked={!!on} onChange={(e) => onToggle(e.target.checked)} aria-label={`Activer ${title}`} />}
        <span>{title}</span>
      </div>
      <div className="cf-comp-node-body">{children}</div>
      <i className="cf-comp-socket is-in" />
      <i className="cf-comp-socket is-out" />
    </div>
  );
}
