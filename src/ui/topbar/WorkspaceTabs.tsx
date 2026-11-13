import { useEffect, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { getApp } from '../../app/context';
import {
  MAX_TAB_NAME,
  WORKSPACES,
  activateTab,
  addTabFromPreset,
  commitTabs,
  duplicateTab,
  installWorkspaceTabs,
  moveTab,
  moveTabBy,
  removeTab,
  renameTab,
  resetWorkspaceTab,
  useWorkspaceTabs,
  workspacePreset,
  workspaceTabs,
  type WorkspaceTab,
} from '../lib/workspaces';
import { Menu, type UiMenuItem } from '../widgets/Menu';

/**
 * Onglets d'espaces de travail de la barre supérieure, modifiables comme dans
 * Blender : clic droit (sur un onglet ou dans la zone vide qui suit) pour
 * ajouter, dupliquer, renommer, supprimer, déplacer ou réinitialiser ; bouton
 * « + » au bout ; double-clic pour renommer ; glisser-déposer pour réordonner ;
 * molette pour faire défiler les onglets qui débordent.
 */

const DRAG_TYPE = 'application/x-coforge-workspace';

interface MenuState {
  x: number;
  y: number;
  items: UiMenuItem[];
  title?: string;
  anchor?: Element | null;
}

/** Sous-menu des modèles : crée un onglet après `after`. */
function presetItems(after: string): UiMenuItem[] {
  return WORKSPACES.map((p) => ({
    label: p.label,
    action: () => commitTabs(addTabFromPreset(workspaceTabs.getState(), p.id, after)),
  }));
}

/** Menu contextuel visant l'onglet `tab`. */
function tabMenuItems(tab: WorkspaceTab, startRename: (id: string) => void): UiMenuItem[] {
  const st = workspaceTabs.getState();
  const i = st.tabs.findIndex((t) => t.id === tab.id);
  const last = st.tabs.length - 1;
  return [
    { label: 'Nouvel espace de travail', icon: Plus, children: presetItems(tab.id) },
    { label: 'Dupliquer', icon: Copy, action: () => commitTabs(duplicateTab(workspaceTabs.getState(), tab.id)) },
    { label: 'Renommer', shortcut: 'Double-clic', action: () => startRename(tab.id) },
    {
      label: 'Supprimer',
      icon: Trash2,
      disabled: st.tabs.length <= 1,
      action: () => commitTabs(removeTab(workspaceTabs.getState(), tab.id)),
    },
    { separator: true },
    { label: 'Déplacer à gauche', disabled: i <= 0, action: () => commitTabs(moveTabBy(workspaceTabs.getState(), tab.id, -1)) },
    { label: 'Déplacer à droite', disabled: i < 0 || i >= last, action: () => commitTabs(moveTabBy(workspaceTabs.getState(), tab.id, 1)) },
    { separator: true },
    { label: `Réinitialiser (modèle « ${workspacePreset(tab.preset).label} »)`, action: () => resetWorkspaceTab(tab.id) },
  ];
}

function RenameField({ tab, onDone }: { tab: WorkspaceTab; onDone(): void }) {
  const [text, setText] = useState(tab.name);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) commitTabs(renameTab(workspaceTabs.getState(), tab.id, text));
    onDone();
  };
  return (
    <input
      ref={ref}
      className="cf-workspace-rename"
      value={text}
      maxLength={MAX_TAB_NAME}
      spellCheck={false}
      aria-label="Nom de l’espace de travail"
      size={Math.max(4, text.length)}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}

export function WorkspaceTabs() {
  const tabs = useWorkspaceTabs((s) => s.tabs);
  const active = useWorkspaceTabs((s) => s.active);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; over: string | null; after: boolean } | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);

  // Branchement unique : onglet enregistré appliqué, suivi des réglages, raccourcis.
  useEffect(() => installWorkspaceTabs(getApp()), []);

  // L'onglet actif reste visible quand les onglets débordent (Ctrl+PgSuiv, ajout…).
  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>(`[data-ws="${CSS.escape(active)}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, tabs.length]);

  const openTabMenu = (e: ReactMouseEvent, tab: WorkspaceTab) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items: tabMenuItems(tab, setRenaming), title: tab.name });
  };

  const openEmptyMenu = (e: ReactMouseEvent) => {
    if ((e.target as Element).closest('.cf-workspace')) return;
    e.preventDefault();
    const st = workspaceTabs.getState();
    const tab = st.tabs.find((t) => t.id === st.active) ?? st.tabs[0];
    setMenu({ x: e.clientX, y: e.clientY, items: tabMenuItems(tab, setRenaming), title: tab.name });
  };

  const openAddMenu = () => {
    const r = addRef.current?.getBoundingClientRect();
    if (!r) return;
    if (menu?.anchor) {
      setMenu(null);
      return;
    }
    setMenu({ x: r.left, y: r.bottom + 1, items: presetItems(workspaceTabs.getState().active), title: 'Nouvel espace de travail', anchor: addRef.current });
  };

  // ---------------------------------------------------------------- glisser-déposer
  const onDragStart = (e: DragEvent, id: string) => {
    if (renaming) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData(DRAG_TYPE, id);
    e.dataTransfer.effectAllowed = 'move';
    setDrag({ id, over: null, after: false });
  };
  const onDragOver = (e: DragEvent, id: string) => {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    if (drag.over !== id || drag.after !== after) setDrag({ ...drag, over: id, after });
  };
  const onDrop = (e: DragEvent, id: string) => {
    e.preventDefault();
    const src = e.dataTransfer.getData(DRAG_TYPE) || drag?.id;
    const after = drag?.after ?? false;
    setDrag(null);
    if (!src || src === id) return;
    const st = workspaceTabs.getState();
    const from = st.tabs.findIndex((t) => t.id === src);
    let to = st.tabs.findIndex((t) => t.id === id) + (after ? 1 : 0);
    if (from < 0 || to < 0) return;
    if (from < to) to -= 1;
    commitTabs(moveTab(st, src, to));
  };

  return (
    <div className="cf-workspace-bar" onContextMenu={openEmptyMenu}>
      <div
        ref={stripRef}
        className="cf-workspaces"
        role="tablist"
        onWheel={(e) => {
          const el = stripRef.current;
          if (!el || el.scrollWidth <= el.clientWidth) return;
          el.scrollLeft += Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
        }}
      >
        {tabs.map((t) => {
          const isActive = t.id === active;
          const dropCls = drag && drag.over === t.id && drag.id !== t.id ? (drag.after ? ' is-drop-after' : ' is-drop-before') : '';
          if (renaming === t.id) {
            return (
              <span key={t.id} data-ws={t.id} className={`cf-workspace is-renaming${isActive ? ' is-active' : ''}`}>
                <RenameField tab={t} onDone={() => setRenaming(null)} />
              </span>
            );
          }
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              tabIndex={-1}
              data-ws={t.id}
              aria-selected={isActive}
              data-tip={`${workspacePreset(t.preset).tip} · double-clic : renommer · clic droit : options · glisser : déplacer`}
              className={`cf-workspace${isActive ? ' is-active' : ''}${drag?.id === t.id ? ' is-dragging' : ''}${dropCls}`}
              draggable
              onClick={() => activateTab(t.id)}
              onDoubleClick={() => setRenaming(t.id)}
              onContextMenu={(e) => openTabMenu(e, t)}
              onDragStart={(e) => onDragStart(e, t.id)}
              onDragOver={(e) => onDragOver(e, t.id)}
              onDrop={(e) => onDrop(e, t.id)}
              onDragEnd={() => setDrag(null)}
            >
              {t.name}
            </button>
          );
        })}
      </div>
      <button
        ref={addRef}
        type="button"
        tabIndex={-1}
        className={`cf-workspace-add${menu?.anchor ? ' is-open' : ''}`}
        data-tip="Ajouter un espace de travail"
        aria-label="Ajouter un espace de travail"
        onClick={openAddMenu}
      >
        <Plus size={13} />
      </button>
      {menu && <Menu items={menu.items} x={menu.x} y={menu.y} title={menu.title} minWidth={190} anchorEl={menu.anchor ?? null} onClose={() => setMenu(null)} />}
    </div>
  );
}
