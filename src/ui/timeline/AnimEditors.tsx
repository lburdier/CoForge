import { useMemo, useState } from 'react';
import { Circle, Pause, Play, SkipBack, SkipForward, StepBack, StepForward } from 'lucide-react';
import { getApp } from '../../app/context';
import { setFrame, store, useApp, type AnimEditorId } from '../../app/store';
import { buildChannels, visibleCurves } from '../../tools/anim/keyedit';
import { PLAYBACK_MENU } from '../../tools/menus';
import { IconButton, Select } from '../widgets/basic';
import type { UiMenuItem } from '../widgets/Menu';
import { MenuBar } from '../widgets/Menu';
import { NumberField } from '../widgets/NumberField';
import { ChannelList } from './ChannelList';
import { frameAllView, KeyCanvas } from './KeyCanvas';
import { easingMenu, handleTypeMenu, interpolationMenu } from './menus';
import { buildRows, useAnimVersion } from './model';
import './anim.css';
import { EditorTypeButton, useArea } from '../layout/editorTypes';

/**
 * Éditeurs d'animation : frise (timeline), feuille d'exposition (dope sheet), éditeur de
 * courbes (graph editor). Tous lisent les courbes partagées de `SceneDoc` (les clés des autres
 * participants apparaissent en direct) et la tête de lecture LOCALE du store.
 */

export const EDITOR_OPTIONS: { value: AnimEditorId; label: string }[] = [
  { value: 'timeline', label: 'Frise' },
  { value: 'dopesheet', label: "Feuille d'exposition" },
  { value: 'graph', label: 'Éditeur de courbes' },
];

const FPS_OPTIONS = ['24', '25', '30', '60'].map((v) => ({ value: v, label: `${v} i/s` }));

// ------------------------------------------------------------------ zone d'édition (canaux + canevas)

export function KeyEditor({ mode, viewKey }: { mode: AnimEditorId; viewKey: string }) {
  const version = useAnimVersion();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [scrollY, setScrollY] = useState(0);
  const { rows, curves } = useMemo(() => {
    const doc = getApp().doc;
    const channels = buildChannels(doc);
    const all = buildRows(channels, collapsed, true);
    return {
      rows: mode === 'timeline' ? all.slice(0, 1) : mode === 'graph' ? all.slice(1) : all,
      curves: mode === 'graph' ? visibleCurves(doc, { graph: true }) : [],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, collapsed, mode]);
  const onlySel = store.getState().animOnlySelected;
  const empty = onlySel ? 'Aucune image clé sur les objets sélectionnés' : 'Aucune image clé dans la scène';

  const toggle = (id: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="cf-anim-body">
      {mode !== 'timeline' && <ChannelList rows={rows} collapsed={collapsed} onToggle={toggle} graph={mode === 'graph'} scrollY={scrollY} onScrollY={setScrollY} />}
      <KeyCanvas mode={mode} rows={rows} curves={curves} scrollY={scrollY} onScrollY={setScrollY} viewKey={viewKey} emptyText={mode === 'timeline' ? undefined : empty} />
    </div>
  );
}

// ------------------------------------------------------------------ menus d'en-tête

export function viewMenu(mode: AnimEditorId, viewKey: string): UiMenuItem[] {
  const s = store.getState();
  const items: UiMenuItem[] = [
    { label: 'Cadrer tout', shortcut: 'Origine', action: () => frameAllView(viewKey) },
    { op: 'anim.keys_jump', label: 'Aller aux clés sélectionnées' },
    { separator: true },
    { label: 'Seulement les objets sélectionnés', checked: s.animOnlySelected, action: () => store.setState({ animOnlySelected: !store.getState().animOnlySelected }) },
  ];
  if (mode === 'graph') items.push({ label: 'Normaliser les courbes', checked: s.graphNormalize, action: () => store.setState({ graphNormalize: !store.getState().graphNormalize }) });
  return items;
}

export function selectMenu(mode: AnimEditorId): UiMenuItem[] {
  const graph = mode === 'graph';
  return [
    { op: 'anim.keys_select_all', args: { action: 'select', graph }, label: 'Tout', shortcut: 'A' },
    { op: 'anim.keys_select_all', args: { action: 'deselect', graph }, label: 'Aucun', shortcut: 'Alt+A' },
    { op: 'anim.keys_select_all', args: { action: 'invert', graph }, label: 'Inverser', shortcut: 'Ctrl+I' },
    { separator: true },
    { op: 'anim.keys_select_column', label: "Clés de l'image courante", shortcut: 'K' },
  ];
}

export function keyMenu(mode: AnimEditorId): UiMenuItem[] {
  return [
    { op: 'anim.keyframe_insert', args: { type: 'available' }, label: 'Insérer sur les canaux existants', shortcut: 'I' },
    { op: 'anim.keyframe_insert_menu', label: 'Insérer une image clé…' },
    { separator: true },
    { label: "Mode d'interpolation", shortcut: 'T', children: interpolationMenu() },
    { label: 'Atténuation', shortcut: 'Ctrl+E', children: easingMenu() },
    ...(mode === 'graph' ? [{ label: 'Type de poignée', shortcut: 'V', children: handleTypeMenu() }] : []),
    { separator: true },
    { op: 'anim.keys_duplicate', label: 'Dupliquer (+1 image)', shortcut: 'Maj+D' },
    { op: 'anim.keys_delete', label: 'Supprimer', shortcut: 'X' },
    { op: 'anim.channels_clear', label: 'Effacer les canaux' },
  ];
}

/** Barre de menus : recalculée à l'ouverture pour refléter les cases cochées. */
function EditorMenus({ mode, viewKey, playback }: { mode: AnimEditorId; viewKey: string; playback?: boolean }) {
  useApp((s) => s.animOnlySelected);
  useApp((s) => s.graphNormalize);
  const menus = [
    ...(playback ? [{ label: 'Lecture', items: PLAYBACK_MENU as UiMenuItem[] }] : []),
    { label: 'Vue', items: viewMenu(mode, viewKey) },
    ...(mode !== 'timeline' ? [{ label: 'Sélection', items: selectMenu(mode) }] : []),
    { label: 'Clé', items: keyMenu(mode) },
  ];
  return <MenuBar menus={menus} className="cf-header-menus" />;
}

// ------------------------------------------------------------------ transport (lecture, plage, image)

export function Transport() {
  const frame = useApp((s) => s.frame);
  const playing = useApp((s) => s.playing);
  const autoKey = useApp((s) => s.autoKey);
  useAnimVersion();
  const settings = getApp().doc.getAnimSettings();
  const run = (op: string, args: Record<string, unknown> = {}) => getApp().ops.run(op, args);
  return (
    <>
      <div className="cf-anim-transport">
        <IconButton
          icon={Circle}
          filled={autoKey}
          tip={autoKey ? 'Auto-key actif : modifier une propriété insère une image clé' : 'Auto-key'}
          className={`cf-anim-autokey${autoKey ? ' is-active' : ''}`}
          onClick={() => run('anim.autokey_toggle')}
        />
        <IconButton icon={SkipBack} tip="Aller au début" shortcut="Maj+←" onClick={() => run('anim.frame_jump', { end: false })} />
        <IconButton icon={StepBack} tip="Image clé précédente" shortcut="↓" onClick={() => run('anim.keyframe_jump', { next: false })} />
        <IconButton
          icon={playing === -1 ? Pause : Play}
          className="cf-anim-reverse"
          tip="Lire à rebours"
          shortcut="Maj+Ctrl+Espace"
          active={playing === -1}
          onClick={() => run('anim.play', { reverse: true })}
        />
        <IconButton icon={playing === 1 ? Pause : Play} tip="Lire" shortcut="Espace" active={playing === 1} onClick={() => run('anim.play')} />
        <IconButton icon={StepForward} tip="Image clé suivante" shortcut="↑" onClick={() => run('anim.keyframe_jump', { next: true })} />
        <IconButton icon={SkipForward} tip="Aller à la fin" shortcut="Maj+→" onClick={() => run('anim.frame_jump', { end: true })} />
      </div>
      <NumberField className="cf-anim-frame" value={frame} integer step={1} undoGroup={false} onChange={(f) => setFrame(Math.round(f))} tip="Image courante (locale)" />
      <span className="cf-anim-label">Début</span>
      <NumberField value={settings.frameStart} integer step={1} min={0} onChange={(v) => run('anim.set_range', { frameStart: v })} tip="Première image (partagée)" />
      <span className="cf-anim-label">Fin</span>
      <NumberField value={settings.frameEnd} integer step={1} min={0} onChange={(v) => run('anim.set_range', { frameEnd: v })} tip="Dernière image (partagée)" />
      <Select
        value={String(settings.fps)}
        options={FPS_OPTIONS.some((o) => o.value === String(settings.fps)) ? FPS_OPTIONS : [...FPS_OPTIONS, { value: String(settings.fps), label: `${settings.fps} i/s` }]}
        onChange={(v) => run('anim.set_range', { fps: Number(v) })}
        tip="Images par seconde (partagé)"
      />
      <FollowPlayback />
    </>
  );
}

/** « Suivre la lecture de… » : la tête de lecture locale recopie celle d'un autre utilisateur. */
function FollowPlayback() {
  const peers = useApp((s) => s.session.peers);
  const follow = useApp((s) => s.followPlaybackClientId);
  if (!peers.length) return null;
  const options = [{ value: '', label: 'Lecture locale' }, ...peers.map((p) => ({ value: String(p.clientId), label: `Suivre ${p.name}` }))];
  return (
    <Select
      className={`cf-anim-follow${follow !== null ? ' is-active' : ''}`}
      value={follow === null ? '' : String(follow)}
      options={options}
      onChange={(v) => store.setState({ followPlaybackClientId: v ? Number(v) : null })}
      tip="Suivre la tête de lecture d'un autre utilisateur (lire ou déplacer la tête de lecture arrête le suivi)"
    />
  );
}

// ------------------------------------------------------------------ zone complète

/** Zone d'animation : en-tête (type d'éditeur, menus, transport) + éditeur. */
export function AnimEditorArea({ mode, onMode, viewKey, transport }: { mode: AnimEditorId; onMode(m: AnimEditorId): void; viewKey: string; transport: boolean }) {
  const area = useArea();
  return (
    <div className="cf-area cf-anim-area">
      <div className="cf-area-header cf-anim-header">
        {area ? <EditorTypeButton /> : <Select value={mode} options={EDITOR_OPTIONS} onChange={onMode} tip="Type d'éditeur" />}
        <EditorMenus mode={mode} viewKey={`${viewKey}:${mode}`} playback={transport} />
        <div className="cf-header-center">{transport && <Transport />}</div>
      </div>
      <KeyEditor key={mode} mode={mode} viewKey={`${viewKey}:${mode}`} />
    </div>
  );
}
