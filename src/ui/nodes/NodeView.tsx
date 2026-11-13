import { getApp } from '../../app/context';
import { memo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Minus, Plus } from 'lucide-react';
import type { NodeData } from '../../core/doc/schema';
import { categoryColor } from '../../core/nodes/shaderNodes';
import type { NodePropDef, NodeTypeDef, SocketDef } from '../../core/nodes/types';
import { Checkbox, ColorField, Select, TextField } from '../widgets/basic';
import { NumberField } from '../widgets/NumberField';
import { supportNote } from './editorLogic';
import { CurveWidget, ImageWidget } from './NodeWidgets';
import { HEADER_H, REROUTE_R, SOCKET_COLORS, type NodeLayout } from './layout';

/** Rappels d'édition d'un nœud (écrits dans le document par l'éditeur). */
export interface NodeEdit {
  input(nodeId: string, socket: string, value: unknown): void;
  prop(nodeId: string, prop: string, value: unknown): void;
  togglePanel(nodeId: string, panel: string): void;
  toggleCollapse(nodeId: string): void;
}

interface NodeViewProps {
  node: NodeData;
  def: NodeTypeDef | null;
  layout: NodeLayout;
  x: number;
  y: number;
  selected: boolean;
  active: boolean;
  linked: ReadonlySet<string>;
  edit: NodeEdit;
}

const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (s: number) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * k)));
  return `rgb(${c(16)}, ${c(8)}, ${c(0)})`;
}

/** Valeur numérique d'une entrée (stockée ou par défaut). */
function num(node: NodeData, s: SocketDef): number {
  const v = Number(node.inputs?.[s.id] ?? s.default);
  return Number.isFinite(v) ? v : 0;
}

function FloatInput({ node, s, edit, label }: { node: NodeData; s: SocketDef; edit: NodeEdit; label: string }) {
  const factor = s.subtype === 'factor';
  return (
    <div className="cf-nd-field" onPointerDown={stop}>
      <NumberField
        label={label}
        value={num(node, s)}
        min={s.min}
        max={s.max}
        slider={factor}
        step={s.step ?? (factor ? 0.005 : 0.01)}
        precision={3}
        onChange={(v) => edit.input(node.id, s.id, v)}
      />
    </div>
  );
}

function ColorSwatch({ value, onChange }: { value: string; onChange(v: string): void }) {
  const safe = /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000';
  return (
    <label className="cf-nd-swatch" style={{ background: safe }} onPointerDown={stop}>
      <input type="color" value={safe} onChange={(e) => onChange(e.target.value)} onKeyDown={stop} />
    </label>
  );
}

// ------------------------------------------------------------------ rampe de couleurs

interface RampStop {
  position: number;
  color: string;
  alpha: number;
}
interface Ramp {
  interpolation: string;
  elements: RampStop[];
}

function RampWidget({ node, prop, edit }: { node: NodeData; prop: NodePropDef; edit: NodeEdit }) {
  const ramp = (node.props?.[prop.id] ?? prop.default) as Ramp;
  const stored = Array.isArray(ramp?.elements) && ramp.elements.length ? ramp.elements : (prop.default as Ramp).elements;
  const [sel, setSel] = useState(0);
  // Glissé d'un repère : état local, écrit dans le document au relâchement (une étape d'annulation).
  const [draft, setDraft] = useState<RampStop[] | null>(null);
  const elements = draft ?? stored;
  const barRef = useRef<HTMLDivElement>(null);
  const cur = Math.min(sel, elements.length - 1);
  const sorted = [...elements].map((e, i) => ({ ...e, i })).sort((a, b) => a.position - b.position);
  const gradient = `linear-gradient(to right, ${sorted.map((e) => `${e.color} ${(e.position * 100).toFixed(2)}%`).join(', ')})`;
  const write = (els: RampStop[], interp = ramp.interpolation ?? 'LINEAR') => edit.prop(node.id, prop.id, { interpolation: interp, elements: els });
  const drag = (e: ReactPointerEvent, index: number) => {
    e.stopPropagation();
    setSel(index);
    const bar = barRef.current;
    if (!bar) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    let last: RampStop[] | null = null;
    const move = (ev: PointerEvent) => {
      const r = bar.getBoundingClientRect();
      const p = Math.max(0, Math.min(1, (ev.clientX - r.left) / Math.max(1, r.width)));
      last = stored.map((x, i) => (i === index ? { ...x, position: Math.round(p * 1000) / 1000 } : x));
      setDraft(last);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setDraft(null);
      if (last) write(last);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const add = () => {
    const a = sorted[0];
    const b = sorted[sorted.length - 1];
    const p = elements.length > 1 ? (a.position + b.position) / 2 : 0.5;
    write([...elements, { position: p, color: elements[cur]?.color ?? '#808080', alpha: 1 }]);
    setSel(elements.length);
  };
  const remove = () => {
    if (elements.length <= 1) return;
    write(elements.filter((_, i) => i !== cur));
    setSel(0);
  };
  return (
    <div className="cf-nd-ramp" onPointerDown={stop}>
      <div className="cf-nd-ramp-tools">
        <button type="button" className="cf-nd-mini" data-tip="Ajouter un repère" onClick={add}>
          <Plus size={11} />
        </button>
        <button type="button" className="cf-nd-mini" data-tip="Retirer le repère" onClick={remove} disabled={elements.length <= 1}>
          <Minus size={11} />
        </button>
        <Select
          value={String(ramp.interpolation ?? 'LINEAR')}
          options={[
            { value: 'LINEAR', label: 'Linéaire' },
            { value: 'EASE', label: 'Adoucie' },
            { value: 'CONSTANT', label: 'Constante' },
            { value: 'B_SPLINE', label: 'B-spline' },
            { value: 'CARDINAL', label: 'Cardinale' },
          ]}
          onChange={(v) => write(elements, v)}
        />
      </div>
      <div ref={barRef} className="cf-nd-ramp-bar" style={{ background: gradient }}>
        {elements.map((e, i) => (
          <span
            key={i}
            className={`cf-nd-ramp-stop${i === cur ? ' is-active' : ''}`}
            style={{ left: `${e.position * 100}%`, background: e.color }}
            onPointerDown={(ev) => drag(ev, i)}
          />
        ))}
      </div>
      <div className="cf-nd-ramp-edit">
        <NumberField
          label="Pos."
          value={elements[cur]?.position ?? 0}
          min={0}
          max={1}
          slider
          step={0.005}
          onChange={(v) => write(elements.map((x, i) => (i === cur ? { ...x, position: v } : x)))}
        />
        <ColorSwatch value={elements[cur]?.color ?? '#000000'} onChange={(c) => write(elements.map((x, i) => (i === cur ? { ...x, color: c } : x)))} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ propriétés

function PropField({ node, p, edit, height }: { node: NodeData; p: NodePropDef; edit: NodeEdit; height: number }) {
  const value = node.props?.[p.id] ?? p.default;
  switch (p.kind) {
    case 'enum':
      return (
        <div className="cf-nd-field" onPointerDown={stop}>
          <Select value={String(value)} options={(p.options ?? []).map((o) => ({ value: o.value, label: o.label }))} onChange={(v) => edit.prop(node.id, p.id, v)} />
        </div>
      );
    case 'bool':
      return (
        <div className="cf-nd-field" onPointerDown={stop}>
          <Checkbox checked={!!value} label={p.label} onChange={(v) => edit.prop(node.id, p.id, v)} />
        </div>
      );
    case 'color':
      return (
        <div className="cf-nd-field cf-nd-colorprop" onPointerDown={stop}>
          <ColorField value={String(value)} onChange={(v) => edit.prop(node.id, p.id, v)} />
        </div>
      );
    case 'float':
    case 'int':
      return (
        <div className="cf-nd-field" onPointerDown={stop}>
          <NumberField
            label={p.kind === 'int' ? p.label : undefined}
            value={Number(value) || 0}
            min={p.min}
            max={p.max}
            integer={p.kind === 'int'}
            step={p.kind === 'int' ? 1 : 0.01}
            onChange={(v) => edit.prop(node.id, p.id, v)}
          />
        </div>
      );
    case 'ramp':
      return <RampWidget node={node} prop={p} edit={edit} />;
    case 'curve':
      return <CurveWidget node={node} prop={p} write={edit.prop} height={height} />;
    case 'image':
      return <ImageWidget node={node} prop={p} write={edit.prop} />;
    case 'object': {
      const objs = getApp()
        .doc.listObjects()
        .filter((o) => o.type === 'mesh')
        .map((o) => ({ value: o.id, label: o.name }))
        .sort((a, b) => a.label.localeCompare(b.label, 'fr', { numeric: true }));
      return (
        <div className="cf-nd-field" onPointerDown={stop}>
          <Select value={typeof value === 'string' ? value : ''} placeholder="(objet)" options={objs} onChange={(v) => edit.prop(node.id, p.id, v || null)} />
        </div>
      );
    }
    case 'string':
      return (
        <div className="cf-nd-field" onPointerDown={stop}>
          <TextField value={String(value ?? '')} placeholder={p.label} onCommit={(v) => edit.prop(node.id, p.id, v)} />
        </div>
      );
    default:
      return null;
  }
}

// ------------------------------------------------------------------ nœud

export const NodeView = memo(function NodeView({ node, def, layout, x, y, selected, active, linked, edit }: NodeViewProps) {
  const cls = `cf-nd${selected ? ' is-selected' : ''}${active ? ' is-active' : ''}${node.muted ? ' is-muted' : ''}${node.collapsed ? ' is-collapsed' : ''}`;
  if (def?.layout === 'reroute') {
    return (
      <div className={`cf-nd-reroute${selected ? ' is-selected' : ''}`} style={{ left: x - REROUTE_R, top: y - REROUTE_R, width: REROUTE_R * 2, height: REROUTE_R * 2 }} data-node={node.id} />
    );
  }
  const head = node.color ?? categoryColor(def?.category ?? '');
  const title = node.label || def?.label || node.type;
  const support = supportNote(def);
  return (
    <div className={cls} style={{ left: x, top: y, width: layout.w, height: layout.h }} data-node={node.id}>
      <div className="cf-nd-header" style={{ height: HEADER_H, background: shade(head, 0.9) }}>
        <button
          type="button"
          className="cf-nd-collapse"
          onPointerDown={stop}
          onClick={() => edit.toggleCollapse(node.id)}
          data-tip={node.collapsed ? 'Déplier (H)' : 'Réduire (H)'}
        >
          {node.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
        <span className="cf-nd-title">{title}</span>
        {support && (
          <span className={`cf-nd-support is-${support.level}`} data-tip={support.text} onPointerDown={stop}>
            <AlertTriangle size={11} />
          </span>
        )}
      </div>
      {!def && <div className="cf-nd-unknown">Type inconnu : {node.type}</div>}
      {layout.rows.map((r, i) => {
        const style = { top: r.y, height: r.h };
        switch (r.kind) {
          case 'output':
            return (
              <div key={i} className="cf-nd-row cf-nd-out" style={style}>
                {r.socket!.label}
              </div>
            );
          case 'prop':
            return (
              <div key={i} className="cf-nd-row" style={style}>
                <PropField node={node} p={r.prop!} edit={edit} height={r.h} />
              </div>
            );
          case 'panel':
            return (
              <div
                key={i}
                className="cf-nd-row cf-nd-panel"
                style={style}
                onPointerDown={stop}
                onClick={() => edit.togglePanel(node.id, r.panel!)}
              >
                {r.open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                <span>{r.panel}</span>
              </div>
            );
          case 'input-vector':
            return (
              <div key={i} className="cf-nd-row cf-nd-in" style={style}>
                {r.socket!.label}
              </div>
            );
          case 'vector-component': {
            const s = r.socket!;
            const arr = (Array.isArray(node.inputs?.[s.id]) ? node.inputs[s.id] : s.default) as number[];
            const c = r.component!;
            const angle = s.subtype === 'angle';
            const val = Number(arr?.[c]) || 0;
            return (
              <div key={i} className="cf-nd-row cf-nd-in" style={style}>
                <div className="cf-nd-field" onPointerDown={stop}>
                  <NumberField
                    label={'XYZ'[c]}
                    axis={(['x', 'y', 'z'] as const)[c]}
                    value={angle ? (val * 180) / Math.PI : val}
                    unit={angle ? '°' : undefined}
                    step={angle ? 0.5 : 0.01}
                    onChange={(v) => {
                      const next = [0, 1, 2].map((k) => Number(arr?.[k]) || 0);
                      next[c] = angle ? (v * Math.PI) / 180 : v;
                      edit.input(node.id, s.id, next);
                    }}
                  />
                </div>
              </div>
            );
          }
          case 'input': {
            const s = r.socket!;
            if (r.linked || s.hideValue || s.type === 'shader' || s.type === 'any') {
              return (
                <div key={i} className="cf-nd-row cf-nd-in" style={style}>
                  {s.label}
                </div>
              );
            }
            if (s.type === 'color') {
              const v = String(node.inputs?.[s.id] ?? s.default ?? '#000000');
              return (
                <div key={i} className="cf-nd-row cf-nd-in cf-nd-color" style={style}>
                  <span>{s.label}</span>
                  <ColorSwatch value={v} onChange={(c) => edit.input(node.id, s.id, c)} />
                </div>
              );
            }
            if (s.type === 'bool') {
              return (
                <div key={i} className="cf-nd-row cf-nd-in" style={style} onPointerDown={stop}>
                  <Checkbox checked={!!(node.inputs?.[s.id] ?? s.default)} label={s.label} onChange={(v) => edit.input(node.id, s.id, v)} />
                </div>
              );
            }
            return (
              <div key={i} className="cf-nd-row cf-nd-in" style={style}>
                <FloatInput node={node} s={s} edit={edit} label={s.label} />
              </div>
            );
          }
          default:
            return null;
        }
      })}
      {[...layout.sockets.entries()].map(([key, s]) => {
        const isIn = key.startsWith('in:');
        const id = key.slice(isIn ? 3 : 4);
        const dim = s.folded && !(isIn && linked.has(id));
        return (
          <span
            key={key}
            data-socket={key}
            className={`cf-nd-socket${s.folded ? ' is-folded' : ''}${s.type === 'shader' ? ' is-shader' : ''}`}
            style={{ left: s.x, top: s.y, background: SOCKET_COLORS[s.type], opacity: dim ? 0.55 : 1 }}
          />
        );
      })}
    </div>
  );
});
