import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search } from 'lucide-react';
import { getApp } from '../../app/context';
import { store, useApp, type PopupState } from '../../app/store';
import { ADD_MENU, CONTEXT_MENU_EDIT, CONTEXT_MENU_OBJECT, DELETE_MENU_EDIT } from '../../tools/menus';
import { buildSearchEntries, editAddMenu, filterSearchEntries, type SearchEntry } from '../lib/menus';
import { useLatest } from '../lib/util';
import { Menu, type UiMenuItem } from '../widgets/Menu';

/**
 * Menus flottants ouverts depuis `store.popup` : menu contextuel (clic droit),
 * « Ajouter » (Maj+A), « Supprimer » (X en mode édition) et recherche
 * d'opérateurs (F3).
 */

const close = () => store.setState({ popup: null });

function popupMenu(kind: PopupState['kind'], mode: 'object' | 'edit'): { title: string; items: UiMenuItem[] } | null {
  switch (kind) {
    case 'context':
      return mode === 'edit' ? { title: 'Maillage', items: CONTEXT_MENU_EDIT } : { title: 'Objet', items: CONTEXT_MENU_OBJECT };
    case 'add':
      return mode === 'edit' ? { title: 'Ajouter un maillage', items: editAddMenu() } : { title: 'Ajouter', items: ADD_MENU };
    case 'delete':
      return { title: 'Supprimer', items: DELETE_MENU_EDIT };
    default:
      return null;
  }
}

// ------------------------------------------------------------------ recherche d'opérateurs (F3)

const MAX_RESULTS = 60;

function SearchPalette({ x, y }: { x: number; y: number }) {
  const entries = useMemo(() => buildSearchEntries(), []);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const results = useMemo(() => filterSearchEntries(entries, query).slice(0, MAX_RESULTS), [entries, query]);
  const current = Math.min(active, Math.max(0, results.length - 1));

  useLayoutEffect(() => {
    inputRef.current?.focus();
    const el = rootRef.current;
    if (!el) return;
    const w = el.offsetWidth;
    const left = Math.max(4, Math.min(x - w / 2, window.innerWidth - w - 4));
    const top = Math.max(4, Math.min(y - 14, window.innerHeight - 380));
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${current}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const run = (e: SearchEntry | undefined) => {
    if (!e) return;
    close();
    // Laisse le menu se fermer avant de lancer (un opérateur peut ouvrir un dialogue ou un autre menu).
    requestAnimationFrame(() => getApp().ops.run(e.op, e.args));
  };

  const latest = useLatest({ close });
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && e.target instanceof Node && rootRef.current.contains(e.target)) return;
      latest.current.close();
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('blur', close);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div
      ref={rootRef}
      className="cf-search"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="cf-search-field">
        <Search size={13} />
        <input
          ref={inputRef}
          value={query}
          placeholder="Rechercher un opérateur…"
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') {
              e.preventDefault();
              close();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive(results.length ? (current + 1) % results.length : 0);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive(results.length ? (current - 1 + results.length) % results.length : 0);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              run(results[current]);
            }
          }}
        />
      </div>
      <div ref={listRef} className="cf-search-list" role="listbox">
        {results.length === 0 && <div className="cf-search-empty">Aucun opérateur ne correspond.</div>}
        {results.map((r, i) => (
          <div
            key={r.key}
            data-index={i}
            role="option"
            aria-selected={i === current}
            className={`cf-menu-item${i === current ? ' is-active' : ''}`}
            onMouseEnter={() => setActive(i)}
            onClick={() => run(r)}
          >
            <span className="cf-search-path">{r.path}</span>
            {r.path && <span className="cf-search-sep">›</span>}
            <span className="cf-menu-label">{r.label}</span>
            {r.shortcut && <span className="cf-menu-shortcut">{r.shortcut}</span>}
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------ point d'entrée

export function Popups() {
  const popup = useApp((s) => s.popup);
  const mode = useApp((s) => s.mode);
  if (!popup) return null;
  if (popup.kind === 'search') return <SearchPalette key={`${popup.x},${popup.y}`} x={popup.x} y={popup.y} />;
  const menu = popupMenu(popup.kind, mode);
  if (!menu) return null;
  return <Menu key={`${popup.kind},${popup.x},${popup.y}`} items={menu.items} title={menu.title} x={popup.x} y={popup.y} minWidth={180} onClose={close} />;
}
