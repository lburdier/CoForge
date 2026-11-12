import {
  Component,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ErrorInfo,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { Check, ChevronDown, ChevronRight, type LucideIcon } from 'lucide-react';
import { contrastColor, initialOf, isHexColor, usePersistent } from '../lib/util';
import { Menu, type UiMenuItem } from './Menu';

// ------------------------------------------------------------------ bouton à icône

export interface IconButtonProps {
  icon: LucideIcon;
  /** Infobulle : nom de l'action. */
  tip?: string;
  /** Raccourci affiché dans l'infobulle. */
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  onClick?(e: ReactMouseEvent<HTMLButtonElement>): void;
  size?: number;
  className?: string;
  /** Remplit l'icône (pastilles pleines). */
  filled?: boolean;
  children?: ReactNode;
  buttonRef?: (el: HTMLButtonElement | null) => void;
}

export function IconButton({ icon: Icon, tip, shortcut, active, disabled, onClick, size = 14, className, filled, children, buttonRef }: IconButtonProps) {
  return (
    <button
      ref={buttonRef}
      type="button"
      tabIndex={-1}
      className={`cf-iconbtn${active ? ' is-active' : ''}${children ? ' has-label' : ''} ${className ?? ''}`}
      disabled={disabled}
      data-tip={tip}
      data-tip-key={shortcut}
      aria-label={tip}
      aria-pressed={active}
      onClick={onClick}
    >
      <Icon size={size} fill={filled ? 'currentColor' : 'none'} />
      {children}
    </button>
  );
}

// ------------------------------------------------------------------ case à cocher

export interface CheckboxProps {
  checked: boolean;
  onChange(checked: boolean): void;
  label?: ReactNode;
  disabled?: boolean;
  tip?: string;
}

export function Checkbox({ checked, onChange, label, disabled, tip }: CheckboxProps) {
  return (
    <label className={`cf-check${disabled ? ' is-disabled' : ''}`} data-tip={tip}>
      <input
        type="checkbox"
        checked={!!checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <span className={`cf-check-box${checked ? ' is-on' : ''}`}>{checked && <Check size={11} strokeWidth={3} />}</span>
      {label !== undefined && <span className="cf-check-label">{label}</span>}
    </label>
  );
}

// ------------------------------------------------------------------ liste déroulante

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
}

export interface SelectProps<T extends string> {
  value: T;
  options: SelectOption<T>[];
  onChange(value: T): void;
  disabled?: boolean;
  tip?: string;
  /** Texte affiché si la valeur ne correspond à aucune option. */
  placeholder?: string;
  className?: string;
  /** Affiche seulement l'icône de l'option courante (en-têtes compacts). */
  iconOnly?: boolean;
}

export function Select<T extends string>({ value, options, onChange, disabled, tip, placeholder, className, iconOnly }: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const current = options.find((o) => o.value === value);
  const rect = open ? ref.current?.getBoundingClientRect() : undefined;
  const items: UiMenuItem[] = open
    ? options.map((o) => ({ label: o.label, icon: o.icon, checked: o.icon ? undefined : o.value === value, action: () => onChange(o.value) }))
    : [];
  const CurIcon = current?.icon;
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`cf-select${open ? ' is-open' : ''} ${className ?? ''}`}
        disabled={disabled}
        data-tip={tip}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {CurIcon && <CurIcon size={13} />}
        {!iconOnly && <span className="cf-select-label">{current?.label ?? placeholder ?? '-'}</span>}
        <ChevronDown size={11} className="cf-select-chevron" />
      </button>
      {open && rect && (
        <Menu items={items} x={rect.left} y={rect.bottom + 1} minWidth={Math.max(rect.width, 120)} anchorEl={ref.current} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

// ------------------------------------------------------------------ champ de texte

export interface TextFieldProps {
  value: string;
  /** Appelé à la validation (Entrée ou perte de focus) si le texte a changé. */
  onCommit(value: string): void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  /** Appelé quand l'édition se termine, validée ou non. */
  onDone?(): void;
  maxLength?: number;
}

/** Champ de texte validé par Entrée ou perte de focus ; Échap rétablit la valeur. */
export function TextField({ value, onCommit, placeholder, className, autoFocus, disabled, onDone, maxLength = 120 }: TextFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const skip = useRef(false);

  useLayoutEffect(() => {
    if (autoFocus) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [autoFocus]);

  const finish = (commit: boolean) => {
    if (skip.current) return;
    skip.current = true;
    const text = draft;
    setDraft(null);
    if (commit && text !== null && text !== value) onCommit(text);
    onDone?.();
  };

  return (
    <input
      ref={ref}
      className={`cf-text ${className ?? ''}`}
      value={draft ?? value}
      placeholder={placeholder}
      disabled={disabled}
      spellCheck={false}
      maxLength={maxLength}
      onFocus={() => {
        skip.current = false;
      }}
      onChange={(e) => {
        skip.current = false;
        setDraft(e.target.value);
      }}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
          ref.current?.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
          ref.current?.blur();
        }
      }}
    />
  );
}

// ------------------------------------------------------------------ couleur

export interface ColorFieldProps {
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
}

/** Pastille de couleur (ouvre le sélecteur natif) + saisie hexadécimale. */
export function ColorField({ value, onChange, disabled }: ColorFieldProps) {
  const safe = isHexColor(value) ? value.toLowerCase() : '#000000';
  return (
    <div className={`cf-color${disabled ? ' is-disabled' : ''}`}>
      <label className="cf-color-swatch" style={{ background: safe }}>
        <input type="color" value={safe} disabled={disabled} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </label>
      <TextField
        className="cf-color-hex"
        value={safe}
        disabled={disabled}
        maxLength={7}
        onCommit={(t) => {
          let s = t.trim();
          if (!s.startsWith('#')) s = `#${s}`;
          if (/^#[0-9a-fA-F]{3}$/.test(s)) s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
          if (isHexColor(s)) onChange(s.toLowerCase());
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------------ panneau repliable et rangées

export interface PanelProps {
  /** Identifiant stable : l'état replié est mémorisé sous cette clé. */
  id: string;
  title: ReactNode;
  defaultOpen?: boolean;
  /** Contenu à droite de l'en-tête (boutons). */
  extra?: ReactNode;
  children: ReactNode;
}

export function Panel({ id, title, defaultOpen = true, extra, children }: PanelProps) {
  const [open, setOpen] = usePersistent(`panel.${id}`, defaultOpen);
  return (
    <section className={`cf-panel${open ? ' is-open' : ''}`}>
      <header className="cf-panel-header" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="cf-panel-title">{title}</span>
        {extra && (
          <span className="cf-panel-extra" onClick={(e) => e.stopPropagation()}>
            {extra}
          </span>
        )}
      </header>
      {open && <div className="cf-panel-body">{children}</div>}
    </section>
  );
}

/** Rangée de propriété : libellé à gauche (aligné à droite), champ à droite. */
export function Row({ label, children, tip }: { label?: ReactNode; children: ReactNode; tip?: string }) {
  return (
    <div className="cf-row" data-tip={tip}>
      <div className="cf-row-label">{label}</div>
      <div className="cf-row-field">{children}</div>
    </div>
  );
}

/** Petit texte discret (notes, états vides). */
export function Hint({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`cf-hint ${className ?? ''}`}>{children}</div>;
}

// ------------------------------------------------------------------ séparateur glissable

export interface SplitterProps {
  /** 'x' : barre verticale qu'on déplace horizontalement ; 'y' : barre horizontale. */
  axis: 'x' | 'y';
  /** Déplacement incrémental en pixels depuis le dernier appel. */
  onDrag(delta: number): void;
  onReset?(): void;
}

export function Splitter({ axis, onDrag, onReset }: SplitterProps) {
  const last = useRef<number | null>(null);
  const [active, setActive] = useState(false);
  return (
    <div
      className={`cf-splitter axis-${axis}${active ? ' is-active' : ''}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        last.current = axis === 'x' ? e.clientX : e.clientY;
        setActive(true);
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        if (last.current === null) return;
        const cur = axis === 'x' ? e.clientX : e.clientY;
        const delta = cur - last.current;
        if (delta !== 0) {
          last.current = cur;
          onDrag(delta);
        }
      }}
      onPointerUp={() => {
        last.current = null;
        setActive(false);
      }}
      onLostPointerCapture={() => {
        last.current = null;
        setActive(false);
      }}
      onDoubleClick={onReset}
    />
  );
}

// ------------------------------------------------------------------ pastille d'utilisateur

export interface AvatarProps {
  name: string;
  color: string;
  tip?: string;
  active?: boolean;
  onClick?(): void;
  size?: number;
}

export function Avatar({ name, color, tip, active, onClick, size = 20 }: AvatarProps) {
  const style: CSSProperties = { background: color, color: contrastColor(color), width: size, height: size, fontSize: Math.round(size * 0.55) };
  return (
    <button type="button" tabIndex={-1} className={`cf-avatar${active ? ' is-active' : ''}`} style={style} data-tip={tip ?? name} onClick={onClick}>
      {initialOf(name)}
    </button>
  );
}

// ------------------------------------------------------------------ garde-fou d'erreurs

interface BoundaryProps {
  name: string;
  children: ReactNode;
}

/** Un éditeur qui plante n'emporte pas le reste de l'interface. */
export class ErrorBoundary extends Component<BoundaryProps, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ui] erreur dans « ${this.props.name} »`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="cf-error">
        <strong>{this.props.name} : une erreur est survenue.</strong>
        <span>{this.state.error.message}</span>
        <button type="button" className="cf-btn" onClick={() => this.setState({ error: null })}>
          Réessayer
        </button>
      </div>
    );
  }
}

// ------------------------------------------------------------------ infobulles

interface TipState {
  text: string;
  key?: string;
  x: number;
  y: number;
}

/**
 * Couche d'infobulles unique : tout élément portant `data-tip` (et
 * éventuellement `data-tip-key` pour le raccourci) affiche une bulle après un
 * court survol.
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<TipState | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let current: Element | null = null;
    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      current = null;
      setTip(null);
    };
    const onOver = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.('[data-tip]') ?? null;
      if (el === current) return;
      clear();
      if (!el) return;
      const text = el.getAttribute('data-tip');
      if (!text) return;
      current = el;
      timer = setTimeout(() => {
        if (!el.isConnected) return;
        const r = el.getBoundingClientRect();
        setTip({ text, key: el.getAttribute('data-tip-key') ?? undefined, x: r.left + r.width / 2, y: r.bottom + 6 });
      }, 450);
    };
    document.addEventListener('mouseover', onOver);
    document.addEventListener('pointerdown', clear, true);
    document.addEventListener('wheel', clear, true);
    window.addEventListener('blur', clear);
    return () => {
      clear();
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('pointerdown', clear, true);
      document.removeEventListener('wheel', clear, true);
      window.removeEventListener('blur', clear);
    };
  }, []);

  useLayoutEffect(() => {
    if (!tip || !ref.current) {
      setPos(null);
      return;
    }
    const r = ref.current.getBoundingClientRect();
    let left = tip.x - r.width / 2;
    left = Math.max(4, Math.min(left, window.innerWidth - r.width - 4));
    let top = tip.y;
    if (top + r.height > window.innerHeight - 4) top = tip.y - r.height - 34;
    setPos({ left, top: Math.max(4, top) });
  }, [tip]);

  if (!tip) return null;
  return (
    <div ref={ref} className="cf-tooltip" style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}>
      <span>{tip.text}</span>
      {tip.key && <kbd>{tip.key}</kbd>}
    </div>
  );
}
