import { Image } from 'lucide-react';
import { getApp } from '../../app/context';
import { useApp } from '../../app/store';
import type { RenderSettings } from '../../core/doc/schema';
import {
  readAtrousParams,
  readTracerParams,
  readViewportSamples,
  resolveDenoiser,
  timeLimitMs,
  type DenoiserKind,
} from '../../engine/render/settings';
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
  'Trace le viewport à résolution réduite puis reconstruit l’image (même principe que DLSS, sans carte RTX requise ; ce n’est pas DLSS). ' +
  'Se combine avec le débruiteur. Le rendu final F12 reste en pleine résolution.';

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

type ActiveDenoiser = Exclude<DenoiserKind, 'none'>;

const DENOISER_OPTIONS: SelectOption<ActiveDenoiser>[] = [
  { value: 'fast', label: 'Rapide (bilatéral)' },
  { value: 'hq', label: 'Haute qualité (guidé albédo + normales, principe OptiX / OIDN)' },
];

const DENOISER_TIP =
  'Rapide : filtre bilatéral sur la couleur seule. Haute qualité : filtre à-trous en ondelettes guidé par des passes ' +
  'd’albédo et de normales, le même principe que les débruiteurs OptiX et OpenImageDenoise (qui ne sont pas ' +
  'accessibles depuis WebGL : ce n’est pas eux, mais un filtre analytique qui tourne sur tout GPU).';

function set(patch: Partial<RenderSettings>): void {
  getApp().doc.updateRender(patch);
}

/** Onglet « Rendu » : moteur, échantillonnage, chemins de lumière, film, couleurs, bloom, format. */
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

      {pathtrace ? <PathTracingPanels r={r} /> : <RealtimePanels r={r} />}

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

      <Panel id="render.film" title="Film">
        <Row>
          <Checkbox checked={r.transparentBg} onChange={(transparentBg) => set({ transparentBg })} label="Fond transparent" />
        </Row>
        <Hint>S’applique au rendu final (F12) : le fond est enregistré transparent dans le PNG.</Hint>
      </Panel>

      <Panel id="render.color" title="Gestion des couleurs">
        <Row label="Transformation">
          <Select value={r.toneMapping} options={TONEMAP_OPTIONS} onChange={(toneMapping) => set({ toneMapping })} />
        </Row>
        <Row label="Exposition">
          <NumberField value={r.exposure} min={-10} max={10} step={0.01} onChange={(exposure) => set({ exposure })} tip="Exposition en diaphragmes (EV)" />
        </Row>
        <Hint>S’applique aux deux moteurs, viewport et rendu final.</Hint>
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

/** Réglages propres au moteur temps réel. */
function RealtimePanels({ r }: { r: RenderSettings }) {
  return (
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
  );
}

/** Réglages du path tracing, rangés comme les panneaux de Cycles. */
function PathTracingPanels({ r }: { r: RenderSettings }) {
  const vs = readViewportSamples(r);
  const tracer = readTracerParams(r);
  const atrous = readAtrousParams(r);
  const vpDenoiser = resolveDenoiser(r, 'viewport');
  const finalDenoiser = resolveDenoiser(r, 'final');
  const bloomOn = r.ptBloom === true;
  const limit = timeLimitMs(r) / 1000;
  const anyHq = vpDenoiser === 'hq' || finalDenoiser === 'hq';

  return (
    <>
      <Panel id="render.sampling" title="Échantillonnage">
        <Panel id="render.sampling.viewport" title="Viewport">
          <Row label="Maximum">
            <NumberField
              value={vs.max}
              integer
              min={1}
              max={65536}
              step={1}
              onChange={(viewportSamples) => set({ viewportSamples })}
              tip="Nombre maximal d’échantillons accumulés dans le viewport"
            />
          </Row>
          <Row label="Minimum">
            <NumberField
              value={vs.min}
              integer
              min={1}
              max={65536}
              step={1}
              onChange={(viewportMinSamples) => set({ viewportMinSamples })}
              tip="Échantillons à accumuler avant d’afficher l’image tracée (l’aperçu temps réel est affiché en attendant)"
            />
          </Row>
          <Row label="Super-résolution" tip={UPSCALE_TIP}>
            <Select value={r.upscale ?? 'off'} options={UPSCALE_OPTIONS} onChange={(upscale) => set({ upscale })} tip={UPSCALE_TIP} />
          </Row>
        </Panel>

        <Panel id="render.sampling.render" title="Rendu">
          <Row label="Échantillons">
            <NumberField value={r.samples} integer min={1} max={65536} step={1} onChange={(samples) => set({ samples })} tip="Échantillons par pixel du rendu final" />
          </Row>
          <Row label="Limite de temps">
            <NumberField
              value={limit}
              min={0}
              max={86400}
              step={1}
              unit="s"
              onChange={(timeLimit) => set({ timeLimit })}
              tip="Arrête le rendu final après cette durée (compilation du shader exclue), même si tous les échantillons ne sont pas tracés. 0 = aucune limite."
            />
          </Row>
          <Row label="Graine">
            <NumberField
              value={tracer.seed}
              integer
              min={0}
              max={2147483647}
              step={1}
              onChange={(seed) => set({ seed })}
              tip="Graine du bruit d’échantillonnage : même graine, même bruit (rendus reproductibles)"
            />
          </Row>
        </Panel>

        <Panel id="render.sampling.denoise" title="Débruitage">
          <Row>
            <Checkbox checked={vpDenoiser !== 'none'} onChange={(denoise) => set(denoise ? { denoise, viewportDenoiser: r.viewportDenoiser === 'none' ? 'fast' : r.viewportDenoiser } : { denoise })} label="Débruiter le viewport" />
          </Row>
          {vpDenoiser !== 'none' && (
            <Row label="Débruiteur" tip={DENOISER_TIP}>
              <Select value={vpDenoiser} options={DENOISER_OPTIONS} onChange={(viewportDenoiser) => set({ viewportDenoiser })} tip={DENOISER_TIP} />
            </Row>
          )}
          <Row>
            <Checkbox checked={finalDenoiser !== 'none'} onChange={(denoiseFinal) => set(denoiseFinal ? { denoiseFinal, denoiser: r.denoiser === 'none' ? 'hq' : r.denoiser } : { denoiseFinal })} label="Débruiter le rendu final" />
          </Row>
          {finalDenoiser !== 'none' && (
            <Row label="Débruiteur" tip={DENOISER_TIP}>
              <Select value={finalDenoiser} options={DENOISER_OPTIONS} onChange={(denoiser) => set({ denoiser })} tip={DENOISER_TIP} />
            </Row>
          )}
          {anyHq && (
            <>
              <Row label="Itérations">
                <NumberField
                  value={atrous.iterations}
                  integer
                  min={1}
                  max={6}
                  step={1}
                  onChange={(denoiseIterations) => set({ denoiseIterations })}
                  tip="Passes de l’à-trous (écart 1, 2, 4… pixels) : plus il y en a, plus le lissage porte loin"
                />
              </Row>
              <Row label="Force">
                <NumberField value={atrous.strength} min={0} max={10} step={0.01} onChange={(denoiseStrength) => set({ denoiseStrength })} tip="Tolérance de couleur du filtre (adaptée automatiquement au nombre d’échantillons)" />
              </Row>
              <Row label="Poids normales">
                <NumberField value={atrous.normalWeight} min={0} max={10} step={0.01} onChange={(denoiseNormalWeight) => set({ denoiseNormalWeight })} tip="Respect des arêtes géométriques (0 = normales ignorées)" />
              </Row>
              <Row label="Poids albédo">
                <NumberField value={atrous.albedoWeight} min={0} max={10} step={0.01} onChange={(denoiseAlbedoWeight) => set({ denoiseAlbedoWeight })} tip="Respect des changements de couleur de matière (0 = albédo ignoré)" />
              </Row>
            </>
          )}
          <Hint>Le débruiteur Haute qualité ne voit que la couleur de base des matériaux, pas leurs textures.</Hint>
        </Panel>
      </Panel>

      <Panel id="render.lightpaths" title="Chemins de lumière">
        <Row label="Rebonds max">
          <NumberField value={tracer.bounces} integer min={1} max={64} step={1} onChange={(bounces) => set({ bounces })} tip="Nombre maximal de rebonds de lumière" />
        </Row>
        <Row label="Transmission">
          <NumberField
            value={tracer.transmissionBounces}
            integer
            min={0}
            max={64}
            step={1}
            onChange={(transmissionBounces) => set({ transmissionBounces })}
            tip="Rebonds supplémentaires réservés à la traversée des matières transparentes (verre, liquides)"
          />
        </Row>
        <Row label="Filtre glossy">
          <NumberField value={tracer.filterGlossy} min={0} max={1} step={0.01} slider onChange={(filterGlossy) => set({ filterGlossy })} tip="Adoucit les reflets vus après un rebond diffus : moins de lucioles, un peu moins de précision" />
        </Row>
        <Row label="Écrêtage">
          <NumberField
            value={tracer.sampleClamp}
            min={0}
            max={1000}
            step={0.1}
            onChange={(sampleClamp) => set({ sampleClamp })}
            tip="Valeur maximale d’un échantillon (supprime les lucioles, assombrit un peu les reflets intenses). 0 = désactivé."
          />
        </Row>
        <Hint>Profondeur de champ : réglée dans les données de la caméra active (vue caméra et rendu final).</Hint>
      </Panel>

      <Panel
        id="render.ptbloom"
        title="Bloom"
        extra={<Checkbox checked={bloomOn} onChange={(ptBloom) => set({ ptBloom })} tip="Activer le bloom du path tracing" />}
      >
        <Row label="Intensité">
          <NumberField value={r.ptBloomIntensity ?? 0.3} min={0} max={10} step={0.01} disabled={!bloomOn} onChange={(ptBloomIntensity) => set({ ptBloomIntensity })} />
        </Row>
        <Row label="Seuil">
          <NumberField
            value={r.ptBloomThreshold ?? 1}
            min={0}
            max={1000}
            step={0.01}
            disabled={!bloomOn}
            onChange={(ptBloomThreshold) => set({ ptBloomThreshold })}
            tip="Luminance linéaire au-delà de laquelle la lumière déborde (1 = blanc diffus)"
          />
        </Row>
        <Row label="Rayon">
          <NumberField value={r.ptBloomRadius ?? 0.5} min={0} max={1} step={0.01} slider disabled={!bloomOn} onChange={(ptBloomRadius) => set({ ptBloomRadius })} tip="Étalement du halo" />
        </Row>
        <Hint>Appliqué à l’image HDR après le débruitage, avant le tone mapping (viewport et rendu final).</Hint>
      </Panel>
    </>
  );
}
