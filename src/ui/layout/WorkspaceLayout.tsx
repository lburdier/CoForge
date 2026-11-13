import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowLeftRight, ArrowLeftToLine, ArrowRightToLine, ArrowUpDown, ArrowUpToLine, Columns2, Rows2 } from 'lucide-react';
import { isEditableElement } from '../../tools/util';
import {
  areaAt,
  canJoin,
  defaultAreaTree,
  findNode,
  joinAreas,
  layoutAreas,
  setAreaEditor,
  setRatio,
  splitArea,
  swapAreas,
  type AreaNode,
  type AreaRect,
  type EdgeRect,
  type EditorType,
} from '../lib/areaTree';
import { activeTab, updateTabLayout, useWorkspaceTabs, workspacePreset, type AreaLayout } from '../lib/workspaces';
import { KeyframeMenu } from '../timeline/AnimArea';
import { Menu, type UiMenuItem } from '../widgets/Menu';
import { ErrorBoundary } from '../widgets/basic';
import { EditorContent } from './editors';
import { AreaProvider, editorEntry, editorForShortcut } from './editorTypes';

/** Épaisseur des bords entre zones (px) et taille minimale d'une zone. */
const GAP = 4;
const MIN_AREA = 28;

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

/** Division interactive en cours (après « Division verticale / horizontale » du menu d'un bord). */
interface SplitPreview {
  dir: 'row' | 'col';
  x: number;
  y: number;
}

/**
 * Zones de l'espace de travail, personnalisables comme dans Blender : chaque zone choisit son
 * éditeur (bouton en tête de son en-tête, ou Maj+F3/F5/F6/F7/F9/F12 au survol), chaque bord se
 * glisse, et un clic droit sur un bord ouvre les options : diviser, fusionner, échanger. L'arbre
 * des zones est mémorisé par onglet d'espace de travail (préférence locale).
 *
 * Les zones sont placées en position absolue à partir de l'arbre (et non imbriquées) : une
 * division ou une fusion ne remonte pas les éditeurs restés en place (viewport 3D compris).
 */
export function WorkspaceLayout() {
  const tab = useWorkspaceTabs((s) => activeTab(s));
  const preset = workspacePreset(tab.preset);
  const layout = validLayout(tab.layout) ? tab.layout : preset.layout;
  const tree = useMemo(() => layout.areas ?? defaultAreaTree(tab.preset, layout), [layout, tab.preset]);

  const rootRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(rootRef);
  const { areas, edges } = useMemo(() => layoutAreas(tree, { x: 0, y: 0, w: size.width, h: size.height }, GAP, MIN_AREA), [tree, size.width, size.height]);

  const [edgeMenu, setEdgeMenu] = useState<{ edge: EdgeRect; x: number; y: number } | null>(null);
  const [splitting, setSplitting] = useState<SplitPreview | null>(null);
  const hovered = useRef<string | null>(null);

  /** Modifie l'arbre de l'onglet actif (lu à jour dans le stockage : pas de mise à jour perdue). */
  const updateTree = useCallback(
    (fn: (cur: AreaNode) => AreaNode) =>
      updateTabLayout(tab.id, (stored) => {
        const base = validLayout(stored) ? stored : preset.layout;
        const cur = base.areas ?? defaultAreaTree(tab.preset, base);
        const next = fn(cur);
        return next === cur ? base : { ...base, areas: next };
      }),
    [tab.id, tab.preset, preset.layout],
  );

  // Raccourcis de type d'éditeur, sur la zone survolée (Maj+F5 viewport, Maj+F3 shaders…).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || !/^F\d+$/.test(e.key)) return;
      if (isEditableElement(e.target) || isEditableElement(document.activeElement)) return;
      const id = hovered.current;
      const leaf = id ? findNode(tree, id) : null;
      if (!leaf || leaf.kind !== 'area') return;
      const next = editorForShortcut(e.key, leaf.editor);
      if (!next) return;
      e.preventDefault();
      e.stopPropagation();
      updateTree((t) => setAreaEditor(t, leaf.id, next));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [tree, updateTree]);

  const edgeItems = (edge: EdgeRect): UiMenuItem[] => {
    const row = edge.dir === 'row';
    return [
      { label: 'Division verticale', icon: Columns2, action: () => setSplitting({ dir: 'row', x: -1, y: -1 }) },
      { label: 'Division horizontale', icon: Rows2, action: () => setSplitting({ dir: 'col', x: -1, y: -1 }) },
      { separator: true },
      {
        label: row ? 'Fusionner vers la droite' : 'Fusionner vers le bas',
        icon: row ? ArrowRightToLine : ArrowDownToLine,
        disabled: !canJoin(tree, edge.splitId, 'b'),
        action: () => updateTree((t) => joinAreas(t, edge.splitId, 'b')),
      },
      {
        label: row ? 'Fusionner vers la gauche' : 'Fusionner vers le haut',
        icon: row ? ArrowLeftToLine : ArrowUpToLine,
        disabled: !canJoin(tree, edge.splitId, 'a'),
        action: () => updateTree((t) => joinAreas(t, edge.splitId, 'a')),
      },
      { separator: true },
      { label: 'Échanger les zones', icon: row ? ArrowLeftRight : ArrowUpDown, action: () => updateTree((t) => swapAreas(t, edge.splitId)) },
    ];
  };

  return (
    <div className="cf-workspace-layout">
      <div ref={rootRef} className="cf-areas">
      {size.width > 0 &&
        areas.map((a) => (
          <AreaView
            key={a.id}
            rect={a}
            tree={tree}
            onHover={(id) => (hovered.current = id)}
            setEditor={(editor) => updateTree((t) => setAreaEditor(t, a.id, editor))}
          />
        ))}
      {size.width > 0 &&
        edges.map((e) => (
          <EdgeHandle
            key={e.splitId}
            edge={e}
            onRatio={(r) => updateTree((t) => setRatio(t, e.splitId, r))}
            onReset={() => updateTree((t) => setRatio(t, e.splitId, 0.5))}
            onMenu={(x, y) => setEdgeMenu({ edge: e, x, y })}
          />
        ))}
      {edgeMenu && <Menu items={edgeItems(edgeMenu.edge)} x={edgeMenu.x} y={edgeMenu.y} title="Options du bord" onClose={() => setEdgeMenu(null)} />}
      {splitting && (
        <SplitOverlay
          dir={splitting.dir}
          areas={areas}
          rootRef={rootRef}
          onCancel={() => setSplitting(null)}
          onConfirm={(areaId, ratio) => {
            setSplitting(null);
            updateTree((t) => splitArea(t, areaId, splitting.dir, ratio).tree);
          }}
        />
      )}
      </div>
      <KeyframeMenu />
    </div>
  );
}

// ------------------------------------------------------------------ zone

function AreaView({ rect, tree, onHover, setEditor }: { rect: AreaRect; tree: AreaNode; onHover(id: string | null): void; setEditor(e: EditorType): void }) {
  const ctx = useMemo(() => ({ areaId: rect.id, editor: rect.editor, tree, setEditor }), [rect.id, rect.editor, tree, setEditor]);
  return (
    <div
      className={`cf-area-slot cf-slot-${rect.editor}`}
      data-area-id={rect.id}
      data-editor={rect.editor}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      onPointerEnter={() => onHover(rect.id)}
      onPointerLeave={() => onHover(null)}
    >
      <AreaProvider value={ctx}>
        <ErrorBoundary name={editorEntry(rect.editor).label}>
          <EditorContent editor={rect.editor} areaId={rect.id} onEditor={setEditor} />
        </ErrorBoundary>
      </AreaProvider>
    </div>
  );
}

// ------------------------------------------------------------------ bord (glisser, clic droit)

function EdgeHandle({ edge, onRatio, onReset, onMenu }: { edge: EdgeRect; onRatio(r: number): void; onReset(): void; onMenu(x: number, y: number): void }) {
  const drag = useRef<{ startPos: number; startEdge: number } | null>(null);
  const [active, setActive] = useState(false);
  const row = edge.dir === 'row';
  return (
    <div
      className={`cf-splitter cf-area-edge axis-${row ? 'x' : 'y'}${active ? ' is-active' : ''}`}
      data-split-id={edge.splitId}
      style={{ left: edge.x, top: edge.y, width: edge.w, height: edge.h }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        drag.current = { startPos: row ? e.clientX : e.clientY, startEdge: (row ? edge.x : edge.y) - edge.start };
        setActive(true);
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const avail = Math.max(1, edge.span - GAP);
        const pos = d.startEdge + (row ? e.clientX : e.clientY) - d.startPos;
        onRatio(pos / avail);
      }}
      onPointerUp={() => {
        drag.current = null;
        setActive(false);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        setActive(false);
      }}
      onDoubleClick={onReset}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu(e.clientX, e.clientY);
      }}
      data-tip="Glisser : redimensionner · Clic droit : diviser, fusionner, échanger"
    />
  );
}

// ------------------------------------------------------------------ division interactive

/**
 * Après « Division verticale / horizontale » : une ligne suit la souris dans la zone survolée ;
 * clic gauche pour diviser à cet endroit, clic droit ou Échap pour annuler (comme dans Blender).
 */
function SplitOverlay({
  dir,
  areas,
  rootRef,
  onConfirm,
  onCancel,
}: {
  dir: 'row' | 'col';
  areas: AreaRect[];
  rootRef: { current: HTMLDivElement | null };
  onConfirm(areaId: string, ratio: number): void;
  onCancel(): void;
}) {
  const [p, setP] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = rootRef.current?.getBoundingClientRect();
    return r ? { x: e.clientX - r.left, y: e.clientY - r.top } : null;
  };
  const target = p ? areaAt(areas, p.x, p.y) : null;
  const ratioOf = (a: AreaRect, q: { x: number; y: number }) => (dir === 'row' ? (q.x - a.x) / Math.max(1, a.w) : (q.y - a.y) / Math.max(1, a.h));

  return (
    <div
      className={`cf-split-overlay dir-${dir}`}
      onPointerMove={(e) => setP(local(e))}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.button !== 0) {
          onCancel();
          return;
        }
        const q = local(e);
        const a = q ? areaAt(areas, q.x, q.y) : null;
        if (a && q) onConfirm(a.id, ratioOf(a, q));
        else onCancel();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {target && p && (
        <>
          <div className="cf-split-target" style={{ left: target.x, top: target.y, width: target.w, height: target.h }} />
          <div
            className="cf-split-line"
            style={dir === 'row' ? { left: p.x - 1, top: target.y, width: 2, height: target.h } : { left: target.x, top: p.y - 1, width: target.w, height: 2 }}
          />
        </>
      )}
      <div className="cf-split-hint">{dir === 'row' ? 'Division verticale' : 'Division horizontale'} : clic gauche dans une zone pour diviser · clic droit / Échap pour annuler</div>
    </div>
  );
}
