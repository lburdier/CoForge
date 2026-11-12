import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X, type LucideIcon } from 'lucide-react';
import { store } from '../../app/store';
import { useLatest } from '../lib/util';

export function closeDialog(): void {
  store.setState({ dialog: null });
}

export interface DialogProps {
  title: string;
  icon?: LucideIcon;
  /** Largeur en px. */
  width?: number;
  /** Pendant une opération (connexion…), Échap et le clic extérieur ne ferment pas. */
  busy?: boolean;
  onClose?(): void;
  /** Boutons du pied de fenêtre. */
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
}

/**
 * Fenêtre modale centrée sur un voile sombre. Échap ou clic sur le voile :
 * fermeture. Les frappes ne quittent jamais la fenêtre (pas de raccourcis du
 * viewport pendant la saisie). Le premier champ reçoit le focus.
 */
export function Dialog({ title, icon: Icon, width = 380, busy, onClose = closeDialog, footer, className, children }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useLatest({ busy, onClose });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const first =
      el.querySelector<HTMLElement>('[data-autofocus]') ??
      el.querySelector<HTMLElement>('input:not([type=checkbox]):not([type=color]):not([disabled]), textarea');
    (first ?? el).focus();
    if (first instanceof HTMLInputElement) first.select();
  }, []);

  useEffect(() => {
    // Échap quand le focus est hors de la fenêtre (le gestionnaire local couvre le reste).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.cf-menu')) return;
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      e.preventDefault();
      if (!latest.current.busy) latest.current.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div
      className="cf-dialog-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        ref={ref}
        className={`cf-dialog ${className ?? ''}`}
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape' && !document.querySelector('.cf-menu')) {
            e.preventDefault();
            if (!busy) onClose();
          }
        }}
      >
        <header className="cf-dialog-header">
          {Icon && <Icon size={14} />}
          <span className="cf-dialog-title">{title}</span>
          <button type="button" tabIndex={-1} className="cf-dialog-close" aria-label="Fermer" disabled={busy} onClick={onClose}>
            <X size={14} />
          </button>
        </header>
        <div className="cf-dialog-body">{children}</div>
        {footer && <footer className="cf-dialog-footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------ champs de formulaire

export interface FieldProps {
  label: string;
  value: string;
  onChange(v: string): void;
  type?: 'text' | 'password' | 'number';
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
  hint?: ReactNode;
}

/** Champ de formulaire contrôlé (libellé à gauche, comme les rangées de propriétés). */
export function Field({ label, value, onChange, type = 'text', placeholder, disabled, autoFocus, maxLength = 200, min, max, hint }: FieldProps) {
  return (
    <label className="cf-form-row">
      <span className="cf-form-label">{label}</span>
      <span className="cf-form-field">
        <input
          className="cf-text"
          type={type}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          maxLength={type === 'number' ? undefined : maxLength}
          min={min}
          max={max}
          spellCheck={false}
          autoComplete="off"
          data-autofocus={autoFocus ? '' : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
        {hint && <span className="cf-form-hint">{hint}</span>}
      </span>
    </label>
  );
}

/** Rangée de formulaire au contenu libre. */
export function FormRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="cf-form-row">
      <span className="cf-form-label">{label}</span>
      <span className="cf-form-field">{children}</span>
    </div>
  );
}
