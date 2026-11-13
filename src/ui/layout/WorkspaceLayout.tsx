import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useApp } from '../../app/store';
import { Outliner } from '../outliner/Outliner';
import { PropertiesEditor } from '../properties/PropertiesEditor';
import { clamp } from '../lib/util';
import { bottomEditor, onBottomEditorsChange } from '../lib/areas';
import { DEFAULT_BOTTOM_H, activeTab, updateTabLayout, useWorkspaceTabs, workspacePreset, type AreaLayout } from '../lib/workspaces';
import { ViewportArea } from '../viewport/ViewportArea';
import { AnimArea } from '../timeline';
import { ErrorBoundary, Splitter } from '../widgets/basic';

/** Tailles minimales des zones (px). */
const MIN_RIGHT = 220;
const MIN_VIEWPORT = 320;
const MIN_OUTLINER = 60;
const MIN_PROPERTIES = 120;
const MIN_BOTTOM = 120;
const MIN_VIEWPORT_H = 160;

function validLayout(v: unknown): v is AreaLayout {
  const l = v as AreaLayout | null;
  return !!l && Number.isFinite(l.rightW) && Number.isFinite(l.outlinerH);
}

/** Suit la taille d'un élément (ResizeObserver). */
function useElementSize(ref: { current: HTMLElement | null }): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/**
 * Disposition des zones de l'espace de travail : viewport 3D à gauche, colonne
 * de droite avec l'outliner en haut et les propriétés en bas. Les séparateurs
 * se glissent à la souris (double-clic : taille par défaut) ; les tailles sont
 * mémorisées par onglet d'espace de travail (préférence locale, voir lib/workspaces.ts).
 */
export function WorkspaceLayout() {
  const tab = useWorkspaceTabs((s) => activeTab(s));
  const preset = workspacePreset(tab.preset);
  const layout = validLayout(tab.layout) ? tab.layout : preset.layout;

  // Éditeur du bas (nœuds, texte Python…) : enregistré par sa zone, choisi par le store.
  const bottomId = useApp((s) => s.bottomEditor);
  const bottomVersion = useSyncExternalStore(onBottomEditorsChange, () => bottomEditor(bottomId));
  const Bottom = bottomVersion?.component ?? null;
  const mainRef = useRef<HTMLDivElement>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const colRef = useRef<HTMLDivElement>(null);
  const root = useElementSize(rootRef);
  const col = useElementSize(colRef);
  const main = useElementSize(mainRef);
  const maxBottom = Math.max(MIN_BOTTOM, main.height - MIN_VIEWPORT_H - 4);
  const bottomH = clamp(layout.bottomH ?? DEFAULT_BOTTOM_H, MIN_BOTTOM, main.height ? maxBottom : 4000);

  // Tailles effectivement appliquées : bornées par la place disponible.
  const maxRight = Math.max(MIN_RIGHT, root.width - MIN_VIEWPORT);
  const rightW = root.width ? clamp(layout.rightW, MIN_RIGHT, maxRight) : layout.rightW;
  const maxOutliner = Math.max(MIN_OUTLINER, col.height - MIN_PROPERTIES - 4);
  const outlinerH = col.height ? clamp(layout.outlinerH, MIN_OUTLINER, maxOutliner) : layout.outlinerH;

  /** Mise à jour fonctionnelle : plusieurs glissements entre deux rendus ne se perdent pas. */
  const update = (fn: (cur: AreaLayout) => Partial<AreaLayout>) =>
    updateTabLayout(tab.id, (stored) => {
      const cur = validLayout(stored) ? stored : preset.layout;
      const base: AreaLayout = {
        rightW: clamp(cur.rightW, MIN_RIGHT, maxRight),
        outlinerH: clamp(cur.outlinerH, MIN_OUTLINER, maxOutliner),
        bottomH: clamp(cur.bottomH ?? DEFAULT_BOTTOM_H, MIN_BOTTOM, maxBottom),
      };
      return { ...base, ...fn(base) };
    });

  return (
    <div ref={rootRef} className="cf-workspace-layout">
      <div ref={mainRef} className="cf-main-column">
        <div className="cf-area-slot cf-slot-viewport">
          <ErrorBoundary name="Viewport 3D">
            <ViewportArea />
          </ErrorBoundary>
        </div>
        {Bottom && (
          <>
            <Splitter
              axis="y"
              onDrag={(d) => update((c) => ({ bottomH: clamp((c.bottomH ?? DEFAULT_BOTTOM_H) - d, MIN_BOTTOM, maxBottom) }))}
              onReset={() => update(() => ({ bottomH: DEFAULT_BOTTOM_H }))}
            />
            <div className="cf-area-slot cf-slot-bottom" style={{ height: bottomH }}>
              <ErrorBoundary name={bottomVersion?.label ?? 'Éditeur'}>
                <Bottom />
              </ErrorBoundary>
            </div>
          </>
        )}
        {/* Bandeau d'animation (frise / feuille d'exposition / courbes), hauteur propre. */}
        <AnimArea />
      </div>
      <Splitter
        axis="x"
        onDrag={(d) => update((c) => ({ rightW: clamp(c.rightW - d, MIN_RIGHT, maxRight) }))}
        onReset={() => update(() => ({ rightW: preset.layout.rightW }))}
      />
      <div ref={colRef} className="cf-right-column" style={{ width: rightW }}>
        <div className="cf-area-slot cf-slot-outliner" style={{ height: outlinerH }}>
          <ErrorBoundary name="Outliner">
            <Outliner />
          </ErrorBoundary>
        </div>
        <Splitter
          axis="y"
          onDrag={(d) => update((c) => ({ outlinerH: clamp(c.outlinerH + d, MIN_OUTLINER, maxOutliner) }))}
          onReset={() => update(() => ({ outlinerH: preset.layout.outlinerH }))}
        />
        <div className="cf-area-slot cf-slot-properties">
          <ErrorBoundary name="Propriétés">
            <PropertiesEditor />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
