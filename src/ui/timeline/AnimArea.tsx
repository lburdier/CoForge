import { useState } from 'react';
import { store, useApp } from '../../app/store';
import { INSERT_KEYFRAME_MENU } from '../../tools/menus';
import { clamp } from '../lib/util';
import { ErrorBoundary, Splitter } from '../widgets/basic';
import { Menu, type UiMenuItem } from '../widgets/Menu';
import { AnimEditorArea } from './AnimEditors';

/**
 * Bandeau d'animation sous le viewport (comme la frise de Blender) : frise par défaut, ou
 * feuille d'exposition / éditeur de courbes. Hauteur propre, mémorisée localement.
 */

const HEIGHT_KEY = 'coforge.anim.stripH';
const DEFAULT_H = 132;
const MIN_H = 74;
const MAX_H = 700;

function storedHeight(): number {
  try {
    const v = Number(localStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(v) && v > 0 ? clamp(v, MIN_H, MAX_H) : DEFAULT_H;
  } catch {
    return DEFAULT_H;
  }
}

export function AnimArea() {
  const mode = useApp((s) => s.animEditor);
  const [h, setH] = useState(storedHeight);
  const save = (v: number) => {
    setH(v);
    try {
      localStorage.setItem(HEIGHT_KEY, String(Math.round(v)));
    } catch {
      /* stockage indisponible */
    }
  };
  return (
    <>
      <Splitter axis="y" onDrag={(d) => save(clamp(h - d, MIN_H, MAX_H))} onReset={() => save(DEFAULT_H)} />
      <div className="cf-area-slot cf-slot-anim" style={{ height: h, flex: 'none' }}>
        <ErrorBoundary name="Animation">
          <AnimEditorArea mode={mode} onMode={(m) => store.setState({ animEditor: m })} viewKey="strip" transport />
        </ErrorBoundary>
      </div>
      <KeyframeMenu />
    </>
  );
}

/** Menu « Insérer une image clé » ouvert par I dans le viewport. */
export function KeyframeMenu() {
  const at = useApp((s) => s.keyframeMenu);
  if (!at) return null;
  return <Menu items={INSERT_KEYFRAME_MENU as UiMenuItem[]} x={at.x} y={at.y} title="Insérer une image clé" onClose={() => store.setState({ keyframeMenu: null })} />;
}
