import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight, type LucideIcon } from 'lucide-react';
import { getApp } from '../../app/context';
import { iconByName } from '../lib/icons';
import { useLatest } from '../lib/util';

/**
 * Élément de menu de l'interface. Structurellement compatible avec `MenuItem`
 * du catalogue (src/tools/menus.ts), avec en plus des actions locales.
 */
export interface UiMenuItem {
  label?: string;
  op?: string;
  args?: Record<string, any>;
  shortcut?: string;
  icon?: string | LucideIcon;
  children?: UiMenuItem[];
  separator?: boolean;
  /** Action locale (prioritaire sur `op`). */
  action?: () => void;
  disabled?: boolean;
  checked?: boolean;
}

// ------------------------------------------------------------------ clavier : pile des menus ouverts

type KeyHandler = (e: KeyboardEvent) => void;
const keyStack: KeyHandler[] = [];

function onWindowKey(e: KeyboardEvent): void {
  const top = keyStack[keyStack.length - 1];
  if (!top) return;
  // Tant qu'un menu est ouvert, aucune frappe ne doit atteindre les raccourcis du viewport.
  e.stopPropagation();
  top(e);
}

function pushKeyHandler(h: KeyHandler): () => void {
  if (keyStack.length === 0) window.addEventListener('keydown', onWindowKey, true);
  keyStack.push(h);
  return () => {
    const i = keyStack.indexOf(h);
    if (i >= 0) keyStack.splice(i, 1);
    if (keyStack.length === 0) window.removeEventListener('keydown', onWindowKey, true);
  };
}

// ------------------------------------------------------------------ placement dans la fenêtre

interface Pos {
  left: number;
  top: number;
}

const MARGIN = 4;

function placeAt(x: number, y: number, w: number, h: number): Pos {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    left: Math.max(MARGIN, Math.min(x, vw - w - MARGIN)),
    top: Math.max(MARGIN, Math.min(y, vh - h - MARGIN)),
  };
}

function placeBeside(anchor: DOMRect, w: number, h: number): Pos {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = anchor.right - 2;
  if (left + w > vw - MARGIN) left = anchor.left - w + 2;
  return {
    left: Math.max(MARGIN, left),
    top: Math.max(MARGIN, Math.min(anchor.top - 4, vh - h - MARGIN)),
  };
}

// ------------------------------------------------------------------ liste (récursive)

function resolveIcon(icon: UiMenuItem['icon']): LucideIcon | null {
  if (!icon) return null;
  return typeof icon === 'string' ? iconByName(icon) : icon;
}

interface MenuListProps {
  items: UiMenuItem[];
  title?: string;
  /** Position du coin haut-gauche (menu racine). */
  point?: { x: number; y: number };
  /** Rectangle de l'élément parent (sous-menu). */
  beside?: DOMRect;
  minWidth?: number;
  selectFirst?: boolean;
  onCloseAll(): void;
  /** Sous-menu : rend la main au parent (flèche gauche). */
  onCloseSelf?(): void;
  /** Menu racine : flèches gauche/droite (navigation entre menus d'une barre). */
  onNavigate?(dir: -1 | 1): void;
}

function MenuList({ items, title, point, beside, minWidth, selectFirst, onCloseAll, onCloseSelf, onNavigate }: MenuListProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pos | null>(null);
  const [active, setActive] = useState<number>(-1);
  const [sub, setSub] = useState<{ index: number; rect: DOMRect; keyboard: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Disponibilité évaluée une fois, à l'ouverture du menu.
  const view = useMemo(() => {
    const ops = getApp().ops;
    return items.map((item) => {
      if (item.separator) return { item, label: '', disabled: true, Icon: null as LucideIcon | null };
      const hasChildren = !!item.children;
      let disabled = !!item.disabled;
      if (!disabled) {
        if (hasChildren) disabled = item.children!.length === 0;
        else if (item.action) disabled = false;
        else if (item.op) disabled = !ops.canRun(item.op);
        else disabled = true;
      }
      const label = item.label ?? (item.op ? (ops.get(item.op)?.label ?? item.op) : '');
      return { item, label, disabled, Icon: resolveIcon(item.icon) };
    });
  }, [items]);

  const hasIcons = view.some((v) => v.Icon || v.item.checked !== undefined);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (beside) setPos(placeBeside(beside, r.width, r.height));
    else if (point) setPos(placeAt(point.x, point.y, r.width, r.height));
  }, [beside, point?.x, point?.y, view]);

  useEffect(() => {
    if (!selectFirst) return;
    const first = view.findIndex((v) => !v.item.separator && !v.disabled);
    setActive(first);
  }, [selectFirst, view]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const openSub = (index: number, keyboard: boolean) => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (!el) return;
    setSub({ index, rect: el.getBoundingClientRect(), keyboard });
  };

  const activate = (index: number, keyboard: boolean) => {
    const v = view[index];
    if (!v || v.disabled || v.item.separator) return;
    if (v.item.children) {
      openSub(index, keyboard);
      return;
    }
    onCloseAll();
    if (v.item.action) v.item.action();
    else if (v.item.op) getApp().ops.run(v.item.op, v.item.args ?? {});
  };

  const state = useLatest({ active, sub, view, activate, onCloseAll, onCloseSelf, onNavigate });

  useEffect(() => {
    return pushKeyHandler((e) => {
      const s = state.current;
      const move = (dir: 1 | -1) => {
        const n = s.view.length;
        let i = s.active;
        for (let k = 0; k < n; k++) {
          i = (i + dir + n) % n;
          if (!s.view[i].item.separator && !s.view[i].disabled) {
            setActive(i);
            setSub(null);
            ref.current?.querySelector<HTMLElement>(`[data-index="${i}"]`)?.scrollIntoView({ block: 'nearest' });
            return;
          }
        }
      };
      switch (e.key) {
        case 'Escape':
          s.onCloseAll();
          break;
        case 'ArrowDown':
          move(1);
          break;
        case 'ArrowUp':
          move(-1);
          break;
        case 'Enter':
        case ' ':
          if (s.active >= 0) s.activate(s.active, true);
          break;
        case 'ArrowRight':
          if (s.active >= 0 && s.view[s.active]?.item.children && !s.view[s.active].disabled) s.activate(s.active, true);
          else s.onNavigate?.(1);
          break;
        case 'ArrowLeft':
          if (s.onCloseSelf) s.onCloseSelf();
          else s.onNavigate?.(-1);
          break;
        default:
          return;
      }
      e.preventDefault();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hover = (index: number) => {
    setActive(index);
    if (timer.current) clearTimeout(timer.current);
    const v = view[index];
    timer.current = setTimeout(() => {
      if (v.item.children && !v.disabled) openSub(index, false);
      else setSub(null);
    }, 140);
  };

  return (
    <>
      <div
        ref={ref}
        className="cf-menu"
        role="menu"
        style={{
          left: pos?.left ?? 0,
          top: pos?.top ?? 0,
          minWidth,
          visibility: pos ? 'visible' : 'hidden',
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {title && <div className="cf-menu-title">{title}</div>}
        {view.map((v, i) =>
          v.item.separator ? (
            <div key={i} className="cf-menu-sep" />
          ) : (
            <div
              key={i}
              data-index={i}
              role="menuitem"
              aria-disabled={v.disabled}
              className={`cf-menu-item${v.disabled ? ' is-disabled' : ''}${active === i || sub?.index === i ? ' is-active' : ''}`}
              onMouseEnter={() => hover(i)}
              onClick={() => activate(i, false)}
            >
              {hasIcons && (
                <span className="cf-menu-icon">
                  {v.item.checked ? <Check size={13} /> : v.Icon ? <v.Icon size={13} /> : null}
                </span>
              )}
              <span className="cf-menu-label">{v.label}</span>
              {v.item.shortcut && <span className="cf-menu-shortcut">{v.item.shortcut}</span>}
              {v.item.children && (
                <span className="cf-menu-arrow">
                  <ChevronRight size={12} />
                </span>
              )}
            </div>
          ),
        )}
      </div>
      {sub && view[sub.index]?.item.children && (
        <MenuList
          key={sub.index}
          items={view[sub.index].item.children!}
          beside={sub.rect}
          selectFirst={sub.keyboard}
          onCloseAll={onCloseAll}
          onCloseSelf={() => setSub(null)}
        />
      )}
    </>
  );
}

// ------------------------------------------------------------------ menu racine

export interface MenuProps {
  items: UiMenuItem[];
  x: number;
  y: number;
  title?: string;
  minWidth?: number;
  /** Bouton qui a ouvert le menu : un clic dessus ne compte pas comme « clic extérieur ». */
  anchorEl?: Element | null;
  onClose(): void;
  onNavigate?(dir: -1 | 1): void;
}

/** Menu flottant (déroulant ou contextuel) rendu au niveau de la fenêtre, recadré, avec sous-menus. */
export function Menu({ items, x, y, title, minWidth, anchorEl, onClose, onNavigate }: MenuProps) {
  const latest = useLatest({ onClose, anchorEl });

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.('.cf-menu')) return;
      const anchor = latest.current.anchorEl;
      if (anchor && t && anchor.contains(t)) return;
      latest.current.onClose();
    };
    const onBlur = () => latest.current.onClose();
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('blur', onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const point = useMemo(() => ({ x, y }), [x, y]);

  return createPortal(
    <MenuList items={items} title={title} point={point} minWidth={minWidth} onCloseAll={onClose} onNavigate={onNavigate} />,
    document.body,
  );
}

// ------------------------------------------------------------------ barre de menus

export interface MenuBarEntry {
  label: string;
  items: UiMenuItem[];
}

/** Rangée de titres de menus : clic pour ouvrir, survol pour passer de l'un à l'autre. */
export function MenuBar({ menus, className }: { menus: MenuBarEntry[]; className?: string }) {
  const [open, setOpen] = useState<number | null>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const anchor = open !== null ? (refs.current[open] ?? null) : null;
  const rect = anchor?.getBoundingClientRect();

  return (
    <div className={`cf-menubar ${className ?? ''}`}>
      {menus.map((m, i) => (
        <button
          key={m.label}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          tabIndex={-1}
          className={`cf-menubar-item${open === i ? ' is-open' : ''}`}
          onClick={() => setOpen(open === i ? null : i)}
          onMouseEnter={() => {
            if (open !== null && open !== i) setOpen(i);
          }}
        >
          {m.label}
        </button>
      ))}
      {open !== null && rect && menus[open] && (
        <Menu
          key={open}
          items={menus[open].items}
          x={rect.left}
          y={rect.bottom + 1}
          anchorEl={anchor}
          onClose={() => setOpen(null)}
          onNavigate={(dir) => setOpen((cur) => (cur === null ? cur : (cur + dir + menus.length) % menus.length))}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ popover

export interface PopoverProps {
  anchorEl: Element | null;
  onClose(): void;
  align?: 'left' | 'right';
  className?: string;
  children: ReactNode;
}

/** Petit panneau flottant ancré sous un bouton (overlays, partage de session…). */
export function Popover({ anchorEl, onClose, align = 'left', className, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pos | null>(null);
  const latest = useLatest({ onClose, anchorEl });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchorEl) return;
    const a = anchorEl.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const x = align === 'right' ? a.right - r.width : a.left;
    setPos(placeAt(x, a.bottom + 3, r.width, r.height));
  }, [anchorEl, align]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t) return;
      if (ref.current?.contains(t) || t.closest?.('.cf-menu')) return;
      if (latest.current.anchorEl?.contains(t)) return;
      latest.current.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || keyStack.length > 0) return;
      e.stopPropagation();
      e.preventDefault();
      latest.current.onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div
      ref={ref}
      className={`cf-popover ${className ?? ''}`}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      onKeyDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>,
    document.body,
  );
}
