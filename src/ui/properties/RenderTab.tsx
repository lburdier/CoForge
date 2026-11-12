import { Image } from 'lucide-react';
import { getApp } from '../../app/context';
import { useApp } from '../../app/store';
import type { RenderSettings } from '../../core/doc/schema';
import { Checkbox, Hint, Panel, Row, Select, type SelectOption } from '../widgets/basic';
import { NumberField } from '../widgets/NumberField';
import { useDocWhen } from './docHooks';

const ENGINE_OPTIONS: SelectOption<RenderSettings['engine']>[] = [
  { value: 'realtime', label: 'Temps réel' },
  { value: 'pathtrace', label: 'Path tracing' },
];

const UPSCALE_OPTIONS: SelectOption<RenderSettings['upscale']>[] = [
  { value: 'off', label: 'Désactivée (100 %)' },
  { value: 'quality', label: 'Qualité (67 %)' },
  { value: 'balanced', label: 'Équilibré (58 %)' },
  { value: 'performance', label: 'Performance (50 %)' },
  { value: 'ultra', label: 'Ultra performance (33 %)' },
];

const UPSCALE_TIP =
  'Trace le viewport à résolution réduite puis reconstruit l’image (même principe que DLSS, sans carte RTX requise). ' +
  'Le rendu final F12 reste en pleine résolution.';

const ENGINE_TIP =
  'Temps réel : rastérisation rapide avec ombres, occlusion ambiante et bloom (dans l’esprit d’EEVEE). ' +
  'Path tracing : lancer de rayons progressif physiquement réaliste, plus lent (dans l’esprit de Cycles).';

const SHADOW_OPTIONS: SelectOption<RenderSettings['shadows']>[] = [
  { value: 'off', label: 'Désactivées' },
  { value: 'low', label: 'Basse qualité' },
  { value: 'high', label: 'Haute qualité' },
];

const TONEMAP_OPTIONS: SelectOption<RenderSettings['toneMapping']>[] = [
  { value: 'agx', label: 'AgX' },
  { value: 'filmic', label: 'Filmique' },
  { value: 'standard', label: 'Standard' },
];

function set(patch: Partial<RenderSettings>): void {
  getApp().doc.updateRender(patch);
}

/** Onglet « Rendu » : moteur, échantillonnage, effets, format, couleurs. */
export function RenderTab() {
  const r = useDocWhen((doc) => doc.getScene().render, { scene: (e) => e.keys.some((k) => k.startsWith('r:')) });
  const running = useApp((s) => s.render.running);
  const hasCamera = useDocWhen((doc) => !!doc.getScene().activeCamera, { scene: true, objects: (e) => e.removed.length > 0 });
  const pathtrace = r.engine === 'pathtrace';

  return (
    <>
      <Panel id="render.engine" title="Moteur de rendu">
        <Row label="Moteur" tip={ENGINE_TIP}>
          <Select value={r.engine} options={ENGINE_OPTIONS} onChange={(engine) => set({ engine })} tip={ENGINE_TIP} />
        </Row>
        <Hint>
          {pathtrace
            ? 'Path tracing : rendu physique progressif (équivalent d’esprit de Cycles).'
            : 'Temps réel : rastérisation interactive (équivalent d’esprit d’EEVEE).'}
        </Hint>
      </Panel>

      {pathtrace ? (
        <Panel id="render.sampling" title="Échantillonnage">
          <Row label="Rendu">
            <NumberField value={r.samples} integer min={1} max={65536} step={1} onChange={(samples) => set({ samples })} tip="Échantillons par pixel du rendu final" />
          </Row>
          <Row label="Viewport">
            <NumberField
              value={r.viewportSamples}
              integer
              min={1}
              max={65536}
              step={1}
              onChange={(viewportSamples) => set({ viewportSamples })}
              tip="Nombre maximal d’échantillons accumulés dans le viewport"
            />
          </Row>
          <Row label="Rebonds">
            <NumberField value={r.bounces} integer min={0} max={64} step={1} onChange={(bounces) => set({ bounces })} tip="Nombre de rebonds de lumière" />
          </Row>
          <Row label="Super-résolution" tip={UPSCALE_TIP}>
            <Select value={r.upscale ?? 'off'} options={UPSCALE_OPTIONS} onChange={(upscale) => set({ upscale })} tip={UPSCALE_TIP} />
          </Row>
          <Row>
            <Checkbox checked={r.denoise !== false} onChange={(denoise) => set({ denoise })} label="Débruitage du viewport" />
          </Row>
          <Hint>Affichage instantané : image nette dès la première passe, qui s’affine ensuite.</Hint>
        </Panel>
      ) : (
        <Panel id="render.effects" title="Effets">
          <Row>
            <Checkbox checked={r.ao} onChange={(ao) => set({ ao })} label="Occlusion ambiante" />
          </Row>
          <Row>
            <Checkbox checked={r.bloom} onChange={(bloom) => set({ bloom })} label="Bloom" />
          </Row>
          <Row label="Ombres">
            <Select value={r.shadows} options={SHADOW_OPTIONS} onChange={(shadows) => set({ shadows })} />
          </Row>
        </Panel>
      )}

      <Panel id="render.format" title="Format">
        <Row label="Résolution X">
          <NumberField value={r.resX} integer min={16} max={16384} step={1} unit="px" onChange={(resX) => set({ resX })} />
        </Row>
        <Row label="Y">
          <NumberField value={r.resY} integer min={16} max={16384} step={1} unit="px" onChange={(resY) => set({ resY })} />
        </Row>
        <Hint>
          Rapport {(r.resX / Math.max(1, r.resY)).toFixed(3)} · {Math.round((r.resX * r.resY) / 1000) / 1000} Mpx
        </Hint>
      </Panel>

      <Panel id="render.color" title="Gestion des couleurs">
        <Row label="Exposition">
          <NumberField value={r.exposure} min={-10} max={10} step={0.01} onChange={(exposure) => set({ exposure })} tip="Exposition en diaphragmes (EV)" />
        </Row>
        <Row label="Tone mapping">
          <Select value={r.toneMapping} options={TONEMAP_OPTIONS} onChange={(toneMapping) => set({ toneMapping })} />
        </Row>
      </Panel>

      <Panel id="render.film" title="Film">
        <Row>
          <Checkbox checked={r.transparentBg} onChange={(transparentBg) => set({ transparentBg })} label="Fond transparent" />
        </Row>
      </Panel>

      <div className="cf-props-actions">
        <button
          type="button"
          className="cf-btn cf-props-render-btn"
          disabled={running}
          data-tip={hasCamera ? "Rendre l'image depuis la caméra active" : 'Aucune caméra active : ajoutez une caméra et définissez-la comme active'}
          data-tip-key="F12"
          onClick={() => getApp().ops.run('render.render')}
        >
          <Image size={14} />
          <span>{running ? 'Rendu en cours…' : "Rendre l'image (F12)"}</span>
        </button>
      </div>
    </>
  );
}
