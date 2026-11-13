import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Box,
  ChevronDown,
  Clapperboard,
  Clock,
  Diamond,
  FileText,
  Film,
  FolderOpen,
  Grid3x3,
  Image,
  Info,
  Layers,
  ListTree,
  Network,
  Settings,
  Shapes,
  SlidersHorizontal,
  Spline,
  Table,
  Terminal,
  type LucideIcon,
} from 'lucide-react';
import { leaves, MAX_VIEW3D, type AreaNode, type EditorType } from '../lib/areaTree';

/**
 * Catalogue des éditeurs d'une zone et bouton « Type d'éditeur » (en tête de chaque en-tête,
 * comme dans Blender) : un menu à quatre colonnes Général / Animation / Script / Données.
 */

type Group = 'general' | 'animation' | 'scripting' | 'data';

export const GROUP_LABELS: Record<Group, string> = {
  general: 'Général',
  animation: 'Animation',
  scripting: 'Script',
  data: 'Données',
};

interface EditorEntry {
  /** Éditeur disponible ; absent : éditeur de Blender pas encore proposé par CoForge (grisé). */
  id?: EditorType;
  label: string;
  icon: LucideIcon;
  group: Group;
  /** Raccourci (survol de la zone), comme dans Blender. */
  shortcut?: string;
}

export const EDITOR_ENTRIES: EditorEntry[] = [
  { id: 'view3d', label: 'Viewport 3D', icon: Box, group: 'general', shortcut: 'Maj+F5' },
  { id: 'image', label: 'Éditeur d’images', icon: Image, group: 'general', shortcut: 'Maj+F10' },
  { id: 'uv', label: 'Éditeur UV', icon: Grid3x3, group: 'general' },
  { id: 'geometry_nodes', label: 'Nœuds de géométrie', icon: Shapes, group: 'general' },
  { id: 'compositor', label: 'Compositeur', icon: Layers, group: 'general' },
  { id: 'shader_nodes', label: 'Éditeur de shaders', icon: Network, group: 'general', shortcut: 'Maj+F3' },
  { id: 'sequencer', label: 'Montage vidéo', icon: Film, group: 'general', shortcut: 'Maj+F8' },
  { id: 'dopesheet', label: 'Feuille d’exposition', icon: Diamond, group: 'animation', shortcut: 'Maj+F12' },
  { id: 'timeline', label: 'Frise', icon: Clock, group: 'animation', shortcut: 'Maj+F12' },
  { id: 'graph', label: 'Éditeur de courbes', icon: Spline, group: 'animation', shortcut: 'Maj+F6' },
  { id: 'nla', label: 'Animation non linéaire', icon: Clapperboard, group: 'animation' },
  { id: 'text', label: 'Éditeur de texte', icon: FileText, group: 'scripting', shortcut: 'Maj+F11' },
  { id: 'console', label: 'Console', icon: Terminal, group: 'scripting', shortcut: 'Maj+F4' },
  { id: 'info', label: 'Info', icon: Info, group: 'scripting' },
  { id: 'outliner', label: 'Outliner', icon: ListTree, group: 'data', shortcut: 'Maj+F9' },
  { id: 'properties', label: 'Propriétés', icon: SlidersHorizontal, group: 'data', shortcut: 'Maj+F7' },
  { id: 'files', label: 'Explorateur de fichiers', icon: FolderOpen, group: 'data', shortcut: 'Maj+F1' },
  { id: 'spreadsheet', label: 'Tableur', icon: Table, group: 'data' },
  { id: 'preferences', label: 'Préférences', icon: Settings, group: 'data' },
];

export function editorEntry(id: EditorType): EditorEntry {
  return EDITOR_ENTRIES.find((e) => e.id === id)!;
}

/**
 * Raccourcis Maj+F… (survol d'une zone) → éditeur. Maj+F12 alterne entre la feuille
 * d'exposition et la frise, comme dans Blender.
 */
export function editorForShortcut(key: string, current: EditorType): EditorType | null {
  switch (key) {
    case 'F5':
      return 'view3d';
    case 'F3':
      return 'shader_nodes';
    case 'F6':
      return 'graph';
    case 'F7':
      return 'properties';
    case 'F9':
      return 'outliner';
    case 'F12':
      return current === 'dopesheet' ? 'timeline' : 'dopesheet';
    case 'F10':
      return 'image';
    case 'F11':
      return 'text';
    case 'F4':
      return 'console';
    case 'F8':
      return 'sequencer';
    case 'F1':
      return 'files';
    default:
      return null;
  }
}

// ------------------------------------------------------------------ contexte de zone

export interface AreaContextValue {
  areaId: string;
  editor: EditorType;
  tree: AreaNode;
  setEditor(editor: EditorType): void;
}

const AreaContext = createContext<AreaContextValue | null>(null);
export const AreaProvider = AreaContext.Provider;

export function useArea(): AreaContextValue | null {
  return useContext(AreaContext);
}

// ------------------------------------------------------------------ bouton « Type d'éditeur »

/**
 * Bouton de choix de l'éditeur de la zone (icône + flèche). À placer en tête de l'en-tête d'un
 * éditeur ; ne rend rien hors d'une zone (éditeur affiché ailleurs, tests).
 */
export function EditorTypeButton() {
  const ctx = useArea();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!ctx) return null;
  const cur = editorEntry(ctx.editor);
  const Icon = cur.icon;
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`cf-editor-type${open ? ' is-open' : ''}`}
        data-tip={`Type d’éditeur : ${cur.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon size={14} />
        <ChevronDown size={10} />
      </button>
      {open && ref.current && <EditorTypeMenu anchor={ref.current} ctx={ctx} onClose={() => setOpen(false)} />}
    </>
  );
}

function EditorTypeMenu({ anchor, ctx, onClose }: { anchor: HTMLElement; ctx: AreaContextValue; onClose(): void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const r = anchor.getBoundingClientRect();
  const [pos, setPos] = useState({ left: r.left, top: r.bottom + 2 });
  const view3dCount = leaves(ctx.tree).filter((l) => l.editor === 'view3d').length;

  // Reste dans la fenêtre (ouvert vers le haut si la zone est en bas de l'écran).
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const m = el.getBoundingClientRect();
    let { left, top } = pos;
    if (left + m.width > window.innerWidth - 4) left = Math.max(4, window.innerWidth - m.width - 4);
    if (top + m.height > window.innerHeight - 4) top = Math.max(4, r.top - m.height - 2);
    if (left !== pos.left || top !== pos.top) setPos({ left, top });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (menuRef.current?.contains(t) || anchor.contains(t))) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [anchor, onClose]);

  const groups = Object.keys(GROUP_LABELS) as Group[];
  return createPortal(
    <div ref={menuRef} className="cf-editor-menu" role="menu" style={{ left: pos.left, top: pos.top }}>
      {groups.map((g) => (
        <div key={g} className="cf-editor-menu-col">
          <div className="cf-editor-menu-title">{GROUP_LABELS[g]}</div>
          {EDITOR_ENTRIES.filter((e) => e.group === g).map((e) => {
            const Icon = e.icon;
            const active = e.id === ctx.editor;
            const tip = !e.id
              ? 'Pas encore disponible dans CoForge'
              : e.id === 'view3d' && view3dCount >= MAX_VIEW3D && ctx.editor !== 'view3d'
                ? `Au plus ${MAX_VIEW3D} viewports 3D`
                : undefined;
            return (
              <button
                key={e.label}
                type="button"
                role="menuitem"
                className={`cf-editor-menu-item${active ? ' is-active' : ''}`}
                disabled={!e.id || (e.id === 'view3d' && view3dCount >= MAX_VIEW3D && ctx.editor !== 'view3d')}
                data-tip={tip}
                onClick={() => {
                  if (e.id) ctx.setEditor(e.id);
                  onClose();
                }}
              >
                <Icon size={14} />
                <span className="cf-editor-menu-label">{e.label}</span>
                {e.shortcut && <span className="cf-editor-menu-key">{e.shortcut}</span>}
              </button>
            );
          })}
        </div>
      ))}
    </div>,
    document.body,
  );
}
