import { useMemo, useRef, useState } from 'react';
import {
  Aperture,
  Box,
  ChevronDown,
  Circle,
  CircleDot,
  Crosshair,
  Globe,
  Grip,
  Layers,
  Magnet,
  Palette,
  ScanEye,
  Slash,
  Square,
  Target,
  Triangle,
  type LucideIcon,
} from 'lucide-react';
import { getApp } from '../../app/context';
import { useDoc } from '../../app/hooks';
import {
  setOverlay,
  store,
  toast,
  useApp,
  type InteractionMode,
  type Orientation,
  type Overlays,
  type PivotMode,
  type SelectMode,
  type ShadingMode,
  type SnapTarget,
} from '../../app/store';
import type { RenderEngine } from '../../core/doc/schema';
import { ADD_MENU, MESH_MENU, OBJECT_MENU, SELECT_MENU_EDIT, SELECT_MENU_OBJECT, VIEW_MENU } from '../../tools/menus';
import { editAddMenu } from '../lib/menus';
import { runOp } from '../lib/ops';
import { Checkbox, IconButton, Row, Select, type SelectOption } from '../widgets/basic';
import { MenuBar, Popover, type MenuBarEntry } from '../widgets/Menu';
import { NumberField } from '../widgets/NumberField';

// ------------------------------------------------------------------ mode d'interaction

const MODE_OPTIONS: SelectOption<InteractionMode>[] = [
  { value: 'object', label: 'Mode objet', icon: Box },
  { value: 'edit', label: 'Mode édition', icon: Triangle },
];

function ModeSelector() {
  const mode = useApp((s) => s.mode);
  return (
    <Select
      value={mode}
      options={MODE_OPTIONS}
      tip="Mode d'interaction (Tab)"
      className="cf-mode-select"
      onChange={(v) => {
        if (v === store.getState().mode) return;
        if (!runOp('object.mode_toggle')) toast("Le mode édition nécessite un objet maillage actif", 'error');
      }}
    />
  );
}

const SELECT_MODES: { mode: SelectMode; icon: LucideIcon; tip: string; key: string }[] = [
  { mode: 'vert', icon: CircleDot, tip: 'Sélection de sommets', key: '1' },
  { mode: 'edge', icon: Slash, tip: "Sélection d'arêtes", key: '2' },
  { mode: 'face', icon: Square, tip: 'Sélection de faces', key: '3' },
];

function SelectModeButtons() {
  const selectMode = useApp((s) => s.selectMode);
  return (
    <div className="cf-btn-group">
      {SELECT_MODES.map((m) => (
        <IconButton
          key={m.mode}
          icon={m.icon}
          tip={m.tip}
          shortcut={m.key}
          active={selectMode === m.mode}
          filled={m.mode === 'face' && selectMode === 'face'}
          onClick={() => runOp('mesh.select_mode', { mode: m.mode }, () => store.setState({ selectMode: m.mode }))}
        />
      ))}
    </div>
  );
}

function HeaderMenus() {
  const mode = useApp((s) => s.mode);
  const menus = useMemo<MenuBarEntry[]>(
    () =>
      mode === 'edit'
        ? [
            { label: 'Vue', items: VIEW_MENU },
            { label: 'Sélection', items: SELECT_MENU_EDIT },
            { label: 'Ajouter', items: editAddMenu() },
            { label: 'Maillage', items: MESH_MENU },
          ]
        : [
            { label: 'Vue', items: VIEW_MENU },
            { label: 'Sélection', items: SELECT_MENU_OBJECT },
            { label: 'Ajouter', items: ADD_MENU },
            { label: 'Objet', items: OBJECT_MENU },
          ],
    [mode],
  );
  return <MenuBar menus={menus} className="cf-header-menus" />;
}

// ------------------------------------------------------------------ transformation : orientation, pivot, aimantation

const ORIENTATION_OPTIONS: SelectOption<Orientation>[] = [
  { value: 'global', label: 'Globale', icon: Globe },
  { value: 'local', label: 'Locale', icon: Box },
];

const PIVOT_OPTIONS: SelectOption<PivotMode>[] = [
  { value: 'median', label: 'Point médian', icon: CircleDot },
  { value: 'active', label: 'Élément actif', icon: Target },
  { value: 'cursor', label: 'Curseur 3D', icon: Crosshair },
  { value: 'individual', label: 'Origines individuelles', icon: Grip },
];

const SNAP_TARGET_OPTIONS: SelectOption<SnapTarget>[] = [
  { value: 'grid', label: 'Grille' },
  { value: 'vertex', label: 'Sommets' },
];

function TransformSettings() {
  const orientation = useApp((s) => s.orientation);
  const pivot = useApp((s) => s.pivot);
  const snap = useApp((s) => s.snap);
  const snapIncrement = useApp((s) => s.snapIncrement);
  const snapTarget = useApp((s) => s.snapTarget);
  return (
    <div className="cf-header-group">
      <Select
        value={orientation}
        options={ORIENTATION_OPTIONS}
        tip="Orientation de la transformation"
        onChange={(v) => store.setState({ orientation: v })}
      />
      <Select value={pivot} options={PIVOT_OPTIONS} iconOnly tip="Point de pivot" onChange={(v) => store.setState({ pivot: v })} />
      <div className="cf-btn-group">
        <IconButton
          icon={Magnet}
          tip={snapTarget === 'vertex' ? 'Aimantation aux sommets' : 'Aimantation à la grille'}
          shortcut="Maj+Tab"
          active={snap}
          onClick={() => store.setState({ snap: !snap })}
        />
        <Select
          value={snapTarget}
          options={SNAP_TARGET_OPTIONS}
          tip="Cible de l'aimantation (Ctrl pendant un déplacement : inverser)"
          onChange={(v) => store.setState({ snapTarget: v })}
        />
        <NumberField
          className={`cf-snap-step${snap && snapTarget === 'grid' ? '' : ' is-off'}`}
          value={snapIncrement}
          min={0.001}
          max={100}
          step={0.005}
          precision={3}
          unit="m"
          undoGroup={false}
          tip="Pas d'aimantation"
          onChange={(v) => store.setState({ snapIncrement: v })}
        />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ affichage : rayons X, overlays, ombrage

const OVERLAY_LABELS: { key: keyof Overlays; label: string }[] = [
  { key: 'grid', label: 'Grille' },
  { key: 'axes', label: 'Axes' },
  { key: 'wireframe', label: 'Fil de fer' },
  { key: 'stats', label: 'Statistiques' },
  { key: 'presence', label: 'Présence des collaborateurs' },
  { key: 'lightsAndCameras', label: 'Lumières et caméras' },
];

function OverlaysButton() {
  const overlays = useApp((s) => s.overlays);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement | null>(null);
  const anyOn = OVERLAY_LABELS.some((o) => overlays[o.key]);
  return (
    <>
      <IconButton
        icon={Layers}
        tip="Superpositions du viewport"
        active={open || anyOn}
        className="has-chevron"
        buttonRef={(el) => {
          ref.current = el;
        }}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronDown size={10} />
      </IconButton>
      {open && (
        <Popover anchorEl={ref.current} onClose={() => setOpen(false)} align="right" className="cf-overlays-popover">
          <div className="cf-popover-title">Superpositions du viewport</div>
          {OVERLAY_LABELS.map((o) => (
            <Checkbox key={o.key} label={o.label} checked={overlays[o.key]} onChange={(v) => setOverlay(o.key, v)} />
          ))}
        </Popover>
      )}
    </>
  );
}

const SHADING_MODES: { mode: ShadingMode; icon: LucideIcon; tip: string; filled?: boolean }[] = [
  { mode: 'wireframe', icon: Globe, tip: 'Fil de fer' },
  { mode: 'solid', icon: Circle, tip: 'Solide', filled: true },
  { mode: 'material', icon: Palette, tip: 'Aperçu des matériaux' },
  { mode: 'rendered', icon: Aperture, tip: 'Rendu' },
];

const ENGINE_OPTIONS: SelectOption<RenderEngine>[] = [
  { value: 'realtime', label: 'Temps réel' },
  { value: 'pathtrace', label: 'Path tracing' },
];

function ShadingPopover({ anchorEl, onClose }: { anchorEl: Element | null; onClose(): void }) {
  const render = useDoc((doc) => doc.getScene().render, ['scene']);
  const xray = useApp((s) => s.xray);
  return (
    <Popover anchorEl={anchorEl} onClose={onClose} align="right" className="cf-shading-popover">
      <div className="cf-popover-title">Ombrage du viewport</div>
      <Row label="Moteur de rendu">
        <Select value={render.engine} options={ENGINE_OPTIONS} onChange={(engine) => getApp().doc.updateRender({ engine })} />
      </Row>
      {render.engine === 'pathtrace' && (
        <Row label="Échantillons viewport">
          <NumberField
            value={render.viewportSamples}
            integer
            min={1}
            max={4096}
            step={1}
            onChange={(viewportSamples) => getApp().doc.updateRender({ viewportSamples })}
          />
        </Row>
      )}
      <Row label="Rayons X">
        <Checkbox checked={xray} onChange={(v) => runOp('view.toggle_xray', {}, () => store.setState({ xray: v }))} label="Voir à travers" />
      </Row>
      <div className="cf-hint">Le moteur est un réglage de la scène, partagé avec les collaborateurs.</div>
    </Popover>
  );
}

function ShadingButtons() {
  const shading = useApp((s) => s.shading);
  const xray = useApp((s) => s.xray);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement | null>(null);
  return (
    <div className="cf-header-group">
      <IconButton
        icon={ScanEye}
        tip="Rayons X"
        shortcut="Alt+Z"
        active={xray}
        onClick={() => runOp('view.toggle_xray', {}, () => store.setState({ xray: !store.getState().xray }))}
      />
      <OverlaysButton />
      <div className="cf-btn-group">
        {SHADING_MODES.map((m) => (
          <IconButton
            key={m.mode}
            icon={m.icon}
            tip={`Ombrage : ${m.tip}`}
            shortcut="Z"
            filled={m.filled}
            active={shading === m.mode}
            onClick={() => runOp('view.shading', { mode: m.mode }, () => store.setState({ shading: m.mode }))}
          />
        ))}
        <IconButton
          icon={ChevronDown}
          size={11}
          tip="Options d'ombrage"
          className="cf-chevron-btn"
          active={open}
          buttonRef={(el) => {
            ref.current = el;
          }}
          onClick={() => setOpen((o) => !o)}
        />
      </div>
      {open && <ShadingPopover anchorEl={ref.current} onClose={() => setOpen(false)} />}
    </div>
  );
}

// ------------------------------------------------------------------ en-tête

/** En-tête du viewport 3D (remplacé par l'aide de l'opération pendant une opération modale). */
export function ViewportHeader() {
  const modalStatus = useApp((s) => s.modal?.status ?? null);
  const mode = useApp((s) => s.mode);
  if (modalStatus !== null) {
    return (
      <div className="cf-area-header cf-viewport-header is-modal">
        <span className="cf-modal-status">{modalStatus}</span>
      </div>
    );
  }
  return (
    <div className="cf-area-header cf-viewport-header">
      <div className="cf-header-group">
        <ModeSelector />
        {mode === 'edit' && <SelectModeButtons />}
        <HeaderMenus />
      </div>
      <div className="cf-header-center">
        <TransformSettings />
      </div>
      <ShadingButtons />
    </div>
  );
}
