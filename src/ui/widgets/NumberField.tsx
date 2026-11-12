import { memo, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { getApp } from '../../app/context';
import type { SceneDoc } from '../../core/doc/SceneDoc';
import type { Vec3 } from '../../core/doc/schema';
import { clamp, evalExpression, formatNumber, tidy, useLatest } from '../lib/util';

export interface NumberFieldProps {
  value: number;
  onChange(value: number): void;
  /** Libellé affiché à gauche, DANS le champ. */
  label?: string;
  min?: number;
  max?: number;
  /** Variation par pixel de glissement (flottants) ou par cran (entiers). */
  step?: number;
  /** Décimales affichées (3 par défaut, 0 pour les entiers). */
  precision?: number;
  integer?: boolean;
  /** Unité affichée après la valeur (« m », « ° »…). */
  unit?: string;
  /** Champ à remplissage : la position dans [min, max] est dessinée, le glissement est proportionnel. */
  slider?: boolean;
  disabled?: boolean;
  /**
   * Regroupe les écritures d'un glissement en une seule étape d'annulation
   * (doc.beginOp / endOp). À désactiver pour les valeurs hors document.
   */
  undoGroup?: boolean;
  /** Liseré coloré d'axe. */
  axis?: 'x' | 'y' | 'z';
  tip?: string;
  className?: string;
}

interface DragState {
  pointerId: number;
  startX: number;
  lastX: number;
  moved: boolean;
  raw: number;
  emitted: number;
  doc: SceneDoc | null;
  arrow: -1 | 0 | 1;
}

/**
 * Champ numérique à la Blender : glisser horizontalement pour modifier
 * (Maj = fin, Ctrl = par pas), double-clic ou Entrée pour saisir une valeur ou
 * une expression (« 2*3 », « 1,5+pi »), flèches aux extrémités.
 */
export const NumberField = memo(function NumberField(props: NumberFieldProps) {
  const { label, min, max, integer, unit, slider, disabled, axis, tip, className } = props;
  const value = Number.isFinite(props.value) ? props.value : 0;
  const precision = props.precision ?? (integer ? 0 : 3);
  const [editing, setEditing] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const drag = useRef<DragState | null>(null);
  const cancelEdit = useRef(false);
  const latest = useLatest({ ...props, value });

  const baseStep = props.step ?? (integer ? 1 : 0.01);
  /** Pas « grossier » : flèches et glissement avec Ctrl. */
  const coarse = integer ? Math.max(1, Math.round(baseStep)) : baseStep * 10;

  const normalize = (v: number): number => {
    const p = latest.current;
    let out = p.integer ? Math.round(v) : tidy(v);
    out = clamp(out, p.min, p.max);
    return out;
  };

  const emit = (v: number) => {
    const out = normalize(v);
    // Pendant un glissement, la prop `value` peut avoir une image de retard : on compare à la dernière valeur émise.
    const d = drag.current;
    const reference = d && d.moved ? d.emitted : latest.current.value;
    if (out !== reference) latest.current.onChange(out);
    if (d) d.emitted = out;
    return out;
  };

  const endDrag = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(false);
    if (d.doc) d.doc.endOp();
  };

  // Sécurité : si le champ disparaît pendant un glissement, l'opération est refermée.
  useEffect(() => endDrag, []);

  useEffect(() => {
    if (editing !== null) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing !== null]);

  const startEdit = () => {
    if (disabled) return;
    cancelEdit.current = false;
    setEditing(String(integer ? Math.round(value) : parseFloat(value.toFixed(6))));
  };

  const commitEdit = () => {
    if (editing === null) return;
    const text = editing;
    setEditing(null);
    // `cancelEdit` sert aussi de garde : Entrée puis la perte de focus ne valident qu'une fois.
    if (cancelEdit.current) return;
    cancelEdit.current = true;
    const v = evalExpression(text);
    if (v !== null) emit(v);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || editing !== null || e.button !== 0) return;
    const arrowAttr = (e.target as HTMLElement).closest<HTMLElement>('[data-arrow]')?.dataset.arrow;
    drag.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      lastX: e.clientX,
      moved: false,
      raw: value,
      emitted: value,
      doc: null,
      arrow: arrowAttr === '-1' ? -1 : arrowAttr === '1' ? 1 : 0,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.moved) {
      if (Math.abs(e.clientX - d.startX) < 3) return;
      d.moved = true;
      d.lastX = e.clientX;
      d.raw = latest.current.value;
      setDragging(true);
      if (latest.current.undoGroup !== false) {
        d.doc = getApp().doc;
        d.doc.beginOp();
      }
      return;
    }
    const dx = e.clientX - d.lastX;
    d.lastX = e.clientX;
    if (dx === 0) return;
    const p = latest.current;
    const fine = e.shiftKey ? 0.1 : 1;
    if (p.slider && p.min !== undefined && p.max !== undefined) {
      const width = rootRef.current?.clientWidth || 120;
      d.raw += (dx / width) * (p.max - p.min) * fine;
    } else if (p.integer) {
      d.raw += dx * 0.1 * Math.max(1, baseStep) * fine;
    } else {
      d.raw += dx * baseStep * fine;
    }
    // On garde la valeur brute bornée pour ne pas « accumuler » au-delà des limites.
    d.raw = clamp(d.raw, p.min, p.max);
    let v = d.raw;
    if (e.ctrlKey) v = Math.round(v / coarse) * coarse;
    d.emitted = emit(v);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const wasClick = !d.moved;
    const arrow = d.arrow;
    endDrag();
    if (wasClick && arrow !== 0) emit(latest.current.value + arrow * coarse);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // Les frappes dans un champ ne doivent jamais atteindre les raccourcis du viewport.
    e.stopPropagation();
    if (editing !== null || disabled) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      startEdit();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      emit(value + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? coarse / 10 : coarse));
    }
  };

  const fill =
    slider && min !== undefined && max !== undefined && max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : null;

  const cls = [
    'cf-num',
    slider ? 'is-slider' : '',
    dragging ? 'is-dragging' : '',
    editing !== null ? 'is-editing' : '',
    disabled ? 'is-disabled' : '',
    axis ? `axis-${axis}` : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={rootRef}
      className={cls}
      tabIndex={disabled ? -1 : 0}
      data-tip={tip}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={startEdit}
      onKeyDown={onKeyDown}
    >
      {fill !== null && <div className="cf-num-fill" style={{ width: `${fill * 100}%` }} />}
      {editing !== null ? (
        <input
          ref={inputRef}
          className="cf-num-input"
          value={editing}
          spellCheck={false}
          onChange={(e) => setEditing(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              commitEdit();
              rootRef.current?.focus();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancelEdit.current = true;
              setEditing(null);
              rootRef.current?.focus();
            }
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      ) : (
        <>
          {!slider && (
            <span className="cf-num-arrow" data-arrow="-1">
              <ChevronLeft size={11} />
            </span>
          )}
          {label !== undefined && <span className="cf-num-label">{label}</span>}
          <span className="cf-num-value">
            {formatNumber(value, precision)}
            {unit ? (unit === '°' || unit === '%' ? unit : ` ${unit}`) : ''}
          </span>
          {!slider && (
            <span className="cf-num-arrow" data-arrow="1">
              <ChevronRight size={11} />
            </span>
          )}
        </>
      )}
    </div>
  );
});

/** Champ numérique à remplissage (0..1 par défaut). */
export function Slider(props: Omit<NumberFieldProps, 'slider'>) {
  return <NumberField min={0} max={1} step={0.005} {...props} slider />;
}

// ------------------------------------------------------------------ vecteur

export interface VectorFieldProps {
  value: Vec3;
  onChange(value: Vec3): void;
  labels?: [string, string, string];
  step?: number;
  precision?: number;
  unit?: string;
  min?: number;
  max?: number;
  undoGroup?: boolean;
  disabled?: boolean;
}

const AXES = ['x', 'y', 'z'] as const;

/** Trois champs X/Y/Z empilés, colorés par axe. */
export function VectorField({ value, onChange, labels = ['X', 'Y', 'Z'], ...rest }: VectorFieldProps) {
  const latest = useLatest({ value, onChange });
  const handlers = useRef(
    AXES.map((_a, i) => (v: number) => {
      const next: Vec3 = [latest.current.value[0], latest.current.value[1], latest.current.value[2]];
      next[i] = v;
      latest.current.onChange(next);
    }),
  );
  return (
    <div className="cf-vec">
      {AXES.map((a, i) => (
        <NumberField key={a} axis={a} label={labels[i]} value={value?.[i] ?? 0} onChange={handlers.current[i]} {...rest} />
      ))}
    </div>
  );
}
