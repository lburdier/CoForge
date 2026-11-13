import { useEffect, useRef, useState } from 'react';
import { getApp } from '../../app/context';
import { setFrame, setKeySelection, store } from '../../app/store';
import { evaluatePoints } from '../../core/anim/fcurve';
import type { HandleType } from '../../core/doc/schema';
import type { ChannelCurve, KeyEditView } from '../../tools/anim/keyedit';
import { isEditableElement } from '../../tools/util';
import { Menu, type UiMenuItem } from '../widgets/Menu';
import { keyGroups, niceStep, ROW_H, RULER_H, type AnimRow } from './model';
import { easingMenu, handleTypeMenu, interpolationMenu, keyContextMenu } from './menus';

/**
 * Zone de dessin commune aux trois éditeurs d'animation (canvas 2D) :
 *  - frise : une ligne de losanges (résumé des objets sélectionnés) ;
 *  - feuille d'exposition : une ligne de losanges par canal, alignée sur la liste des canaux ;
 *  - éditeur de courbes : courbes, clés et poignées, grille des valeurs.
 * Règle d'images en haut (clic / glisser : déplace la tête de lecture LOCALE, en bleu), plage
 * début–fin éclaircie. Molette : zoom ; Ctrl+molette : défilement horizontal ; Maj+molette :
 * vertical ; bouton du milieu : déplacer la vue. Survolée, la zone reçoit les raccourcis
 * G / S / R, X, A, T, V, Maj+D, Origine.
 */

export type KeyCanvasMode = 'timeline' | 'dopesheet' | 'graph';

interface View {
  /** Image au bord gauche, images par pixel. */
  f0: number;
  fpp: number;
  /** Valeur au bord haut (sous la règle), valeurs par pixel (courbes). */
  vTop: number;
  vpp: number;
  init: boolean;
}

const views = new Map<string, View>();
/** « Cadrer tout » des zones montées, par clé de vue (menus Vue des en-têtes). */
const framers = new Map<string, () => void>();

export function frameAllView(viewKey: string): void {
  framers.get(viewKey)?.();
}

function viewFor(key: string): View {
  let v = views.get(key);
  if (!v) views.set(key, (v = { f0: -5, fpp: 0.5, vTop: 2, vpp: 0.02, init: false }));
  return v;
}

const C = {
  bg: '#282828',
  bgOut: 'rgba(0, 0, 0, 0.22)',
  grid: '#333333',
  gridStrong: '#3b3b3b',
  ruler: '#232323',
  text: '#9a9a9a',
  playhead: '#4772b3',
  key: '#d6d6d6',
  keySel: '#ffbb44',
  keyOutline: '#101010',
  rowAlt: 'rgba(255, 255, 255, 0.025)',
  summary: 'rgba(71, 114, 179, 0.18)',
};

const HANDLE_COLORS: Record<HandleType, [string, string]> = {
  FREE: ['#202020', '#e0e0e0'],
  AUTO: ['#909000', '#f0ff40'],
  AUTO_CLAMPED: ['#994030', '#f0af90'],
  VECTOR: ['#409030', '#40c040'],
  ALIGNED: ['#803060', '#f090a0'],
};

export interface KeyCanvasProps {
  mode: KeyCanvasMode;
  rows: AnimRow[];
  /** Courbes dessinées (éditeur de courbes). */
  curves: ChannelCurve[];
  /** Défilement vertical des lignes (feuille d'exposition), px. */
  scrollY?: number;
  onScrollY?(y: number): void;
  viewKey: string;
  emptyText?: string;
}

interface Hit {
  kind: 'key' | 'handle' | 'group';
  ids: string[];
  handle?: string;
}

type Drag =
  | { kind: 'scrub'; pointerId: number }
  | { kind: 'box'; pointerId: number; x0: number; y0: number; x1: number; y1: number; extend: boolean }
  | { kind: 'pan'; pointerId: number; x: number; y: number }
  | { kind: 'press'; pointerId: number; x: number; y: number; cx: number; cy: number };

export function KeyCanvas({ mode, rows, curves, scrollY = 0, onScrollY, viewKey, emptyText }: KeyCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = viewFor(viewKey);
  const props = useRef({ mode, rows, curves, scrollY, onScrollY });
  props.current = { mode, rows, curves, scrollY, onScrollY };
  const size = useRef({ w: 0, h: 0 });
  const drag = useRef<Drag | null>(null);
  const hovered = useRef(false);
  const pointer = useRef({ x: 0, y: 0 });
  const raf = useRef(0);
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: UiMenuItem[]; title?: string } | null>(null);
  const autoKey = useAutoKey();

  // ---------------------------------------------------------------- conversions

  const fx = (f: number) => (f - view.f0) / view.fpp;
  const xf = (x: number) => view.f0 + x * view.fpp;
  const vy = (v: number) => RULER_H + (view.vTop - v) / view.vpp;
  const yv = (y: number) => view.vTop - (y - RULER_H) * view.vpp;
  const rowY = (i: number) => RULER_H + i * ROW_H - props.current.scrollY;

  /** Normalisation (éditeur de courbes) : valeur affichée = (valeur - offset) × scale. */
  const normOf = (c: ChannelCurve): { scale: number; offset: number } => {
    if (!store.getState().graphNormalize) return { scale: 1, offset: 0 };
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of c.points) {
      lo = Math.min(lo, p.v);
      hi = Math.max(hi, p.v);
    }
    if (!Number.isFinite(lo)) return { scale: 1, offset: 0 };
    if (hi - lo < 1e-9) return { scale: 1, offset: lo };
    return { scale: 2 / (hi - lo), offset: (hi + lo) / 2 };
  };

  const editView = (): KeyEditView => ({
    kind: props.current.mode,
    toGraph: (x, y) => {
      const r = canvasRef.current!.getBoundingClientRect();
      return [xf(x - r.left), yv(y - r.top)];
    },
    toClient: (f, v) => {
      const r = canvasRef.current!.getBoundingClientRect();
      return [fx(f) + r.left, vy(v) + r.top];
    },
    norm: (ck) => {
      const c = props.current.curves.find((q) => q.key === ck);
      return c ? normOf(c) : { scale: 1, offset: 0 };
    },
    redraw: () => requestDraw(),
  });

  // ---------------------------------------------------------------- cadrage

  const frameAll = () => {
    const { w, h } = size.current;
    if (!w) return;
    const doc = getApp().doc;
    const { mode: m, curves: cs } = props.current;
    let f0 = Infinity;
    let f1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    if (m === 'graph') {
      for (const c of cs) {
        const n = normOf(c);
        for (const p of c.points) {
          f0 = Math.min(f0, p.f);
          f1 = Math.max(f1, p.f);
          for (const v of [p.v, p.hl[1], p.hr[1]]) {
            v0 = Math.min(v0, (v - n.offset) * n.scale);
            v1 = Math.max(v1, (v - n.offset) * n.scale);
          }
        }
      }
    } else {
      for (const r of props.current.rows) for (const g of keyGroups(r.curves)) {
        f0 = Math.min(f0, g.frame);
        f1 = Math.max(f1, g.frame);
      }
    }
    const range = doc.getAnimSettings();
    if (m === 'timeline' || !Number.isFinite(f0)) {
      f0 = range.frameStart;
      f1 = range.frameEnd;
    }
    if (f1 - f0 < 10) {
      const c = (f0 + f1) / 2;
      f0 = c - 5;
      f1 = c + 5;
    }
    const pad = (f1 - f0) * 0.05;
    view.f0 = f0 - pad;
    view.fpp = (f1 - f0 + 2 * pad) / Math.max(1, w);
    if (m === 'graph') {
      if (!Number.isFinite(v0)) {
        v0 = -1;
        v1 = 1;
      }
      if (v1 - v0 < 1e-3) {
        v0 -= 1;
        v1 += 1;
      }
      const vpad = (v1 - v0) * 0.1;
      const avail = Math.max(10, h - RULER_H - 16);
      view.vpp = (v1 - v0 + 2 * vpad) / avail;
      view.vTop = v1 + vpad;
    }
    view.init = true;
    requestDraw();
  };

  // ---------------------------------------------------------------- dessin

  const requestDraw = () => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      draw();
    });
  };

  const draw = () => {
    const cv = canvasRef.current;
    if (!cv) return;
    const { w, h } = size.current;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const ctx = cv.getContext('2d');
    if (!ctx || !w || !h) return;
    if (!view.init) frameAll();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const s = store.getState();
    const doc = getApp().doc;
    const range = doc.getAnimSettings();
    const { mode: m, rows, curves: cs } = props.current;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);

    // lignes de la feuille d'exposition
    if (m !== 'graph') {
      rows.forEach((r, i) => {
        const y = m === 'timeline' ? RULER_H : rowY(i);
        const rh = m === 'timeline' ? h - RULER_H : ROW_H;
        if (r.kind === 'summary' && m !== 'timeline') {
          ctx.fillStyle = C.summary;
          ctx.fillRect(0, y, w, rh);
        } else if (i % 2) {
          ctx.fillStyle = C.rowAlt;
          ctx.fillRect(0, y, w, rh);
        }
      });
    }

    // grille verticale (images)
    const fStep = niceStep(view.fpp, 60, true);
    const fFirst = Math.floor(xf(0) / fStep) * fStep;
    ctx.lineWidth = 1;
    ctx.strokeStyle = C.grid;
    ctx.beginPath();
    for (let f = fFirst; fx(f) < w; f += fStep) {
      const x = Math.round(fx(f)) + 0.5;
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, h);
    }
    ctx.stroke();

    // grille horizontale (valeurs)
    if (m === 'graph') {
      const vStep = niceStep(view.vpp, 40, false);
      const vFirst = Math.floor(yv(h) / vStep) * vStep;
      ctx.strokeStyle = C.grid;
      ctx.beginPath();
      for (let v = vFirst; vy(v) > RULER_H; v += vStep) {
        const y = Math.round(vy(v)) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();
      const y0 = Math.round(vy(0)) + 0.5;
      if (y0 > RULER_H && y0 < h) {
        ctx.strokeStyle = C.gridStrong;
        ctx.beginPath();
        ctx.moveTo(0, y0);
        ctx.lineTo(w, y0);
        ctx.stroke();
      }
      ctx.fillStyle = C.text;
      ctx.font = '10px "Segoe UI", system-ui, sans-serif';
      ctx.textBaseline = 'bottom';
      for (let v = vFirst; vy(v) > RULER_H + 8; v += vStep) ctx.fillText(formatValue(v, vStep), 4, vy(v) - 1);
    }

    // hors plage
    ctx.fillStyle = C.bgOut;
    const xs = fx(range.frameStart);
    const xe = fx(range.frameEnd);
    if (xs > 0) ctx.fillRect(0, RULER_H, Math.min(w, xs), h - RULER_H);
    if (xe < w) ctx.fillRect(Math.max(0, xe), RULER_H, w - Math.max(0, xe), h - RULER_H);

    if (m === 'graph') drawCurves(ctx, cs, s.keySelection, s.handleSelection, w, h);
    else {
      rows.forEach((r, i) => {
        const y = m === 'timeline' ? RULER_H + (h - RULER_H) / 2 : rowY(i) + ROW_H / 2;
        if (y < RULER_H - 6 || y > h + 6) return;
        const groups = keyGroups(r.curves);
        // traits entre clés identiques (« tenue »)
        for (const g of groups) {
          const x = fx(g.frame);
          if (x < -10 || x > w + 10) continue;
          const sel = g.ids.every((id) => s.keySelection.has(id));
          const big = r.kind === 'summary' || r.kind === 'object' || m === 'timeline';
          diamond(ctx, x, y, big ? 6 : 5, sel ? C.keySel : C.key, r.kind === 'summary' || r.kind === 'object' ? 0.95 : 1);
        }
      });
    }

    // tête de lecture
    const px = Math.round(fx(s.frame)) + 0.5;
    ctx.strokeStyle = C.playhead;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, RULER_H);
    ctx.lineTo(px, h);
    ctx.stroke();
    ctx.lineWidth = 1;

    // règle
    ctx.fillStyle = C.ruler;
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.fillStyle = C.text;
    ctx.font = '11px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (let f = fFirst; fx(f) < w + 20; f += fStep) ctx.fillText(String(f), fx(f), RULER_H / 2);
    const label = String(Math.round(s.frame * 100) / 100);
    const tw = Math.max(26, ctx.measureText(label).width + 10);
    ctx.fillStyle = C.playhead;
    roundRect(ctx, px - tw / 2, 2, tw, RULER_H - 4, 4);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, px, RULER_H / 2);
    ctx.textAlign = 'left';
    ctx.strokeStyle = '#1a1a1a';
    ctx.beginPath();
    ctx.moveTo(0, RULER_H + 0.5);
    ctx.lineTo(w, RULER_H + 0.5);
    ctx.stroke();
  };

  function drawCurves(ctx: CanvasRenderingContext2D, cs: ChannelCurve[], keySel: ReadonlySet<string>, handleSel: ReadonlySet<string>, w: number, h: number) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER_H, w, h - RULER_H);
    ctx.clip();
    for (const c of cs) {
      const n = normOf(c);
      const disp = (v: number) => (v - n.offset) * n.scale;
      const active = c.keys.some((k) => keySel.has(k.id) || handleSel.has(`${k.id}:l`) || handleSel.has(`${k.id}:r`));
      ctx.strokeStyle = c.color;
      ctx.globalAlpha = c.mute ? 0.35 : active ? 1 : 0.7;
      ctx.lineWidth = active ? 2 : 1.5;
      ctx.setLineDash(c.mute ? [4, 4] : []);
      ctx.beginPath();
      for (let x = 0; x <= w; x += 2) {
        const v = evaluatePoints(c.points, xf(x));
        if (v === null) break;
        const y = vy(disp(v));
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
      // poignées des clés sélectionnées (segments bezier)
      c.points.forEach((p, i) => {
        const show = keySel.has(p.id) || handleSel.has(`${p.id}:l`) || handleSel.has(`${p.id}:r`);
        if (!show) return;
        const prev = c.points[i - 1];
        const kx = fx(p.f);
        const ky = vy(disp(p.v));
        const k = c.keys[i];
        for (const side of ['l', 'r'] as const) {
          const bez = side === 'l' ? prev?.ipo === 'BEZIER' : p.ipo === 'BEZIER' && i < c.points.length - 1;
          if (!bez) continue;
          const hp = side === 'l' ? p.hl : p.hr;
          const hx = fx(hp[0]);
          const hy = vy(disp(hp[1]));
          const type = (side === 'l' ? k?.hlType : k?.hrType) ?? 'AUTO_CLAMPED';
          const sel = handleSel.has(`${p.id}:${side}`) || keySel.has(p.id);
          const [col, colSel] = HANDLE_COLORS[type];
          ctx.strokeStyle = sel ? colSel : col;
          ctx.beginPath();
          ctx.moveTo(kx, ky);
          ctx.lineTo(hx, hy);
          ctx.stroke();
          ctx.fillStyle = handleSel.has(`${p.id}:${side}`) ? C.keySel : sel ? colSel : col;
          ctx.beginPath();
          ctx.arc(hx, hy, 3.5, 0, Math.PI * 2);
          ctx.fill();
        }
      });
      for (const p of c.points) {
        const x = fx(p.f);
        if (x < -6 || x > w + 6) continue;
        const y = vy(disp(p.v));
        ctx.fillStyle = keySel.has(p.id) ? C.keySel : c.lock ? '#777777' : '#e8e8e8';
        ctx.strokeStyle = C.keyOutline;
        ctx.beginPath();
        ctx.rect(x - 3.5, y - 3.5, 7, 7);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- détection

  const hitTest = (x: number, y: number): Hit | null => {
    const { mode: m, rows, curves: cs } = props.current;
    const s = store.getState();
    if (m === 'graph') {
      let best: Hit | null = null;
      let bd = 7;
      for (const c of cs) {
        if (c.lock) continue;
        const n = normOf(c);
        const disp = (v: number) => (v - n.offset) * n.scale;
        c.points.forEach((p, i) => {
          const d = Math.hypot(fx(p.f) - x, vy(disp(p.v)) - y);
          if (d < bd) {
            bd = d;
            best = { kind: 'key', ids: [p.id] };
          }
          const show = s.keySelection.has(p.id) || s.handleSelection.has(`${p.id}:l`) || s.handleSelection.has(`${p.id}:r`);
          if (!show) return;
          for (const side of ['l', 'r'] as const) {
            const bez = side === 'l' ? c.points[i - 1]?.ipo === 'BEZIER' : p.ipo === 'BEZIER' && i < c.points.length - 1;
            if (!bez) continue;
            const hp = side === 'l' ? p.hl : p.hr;
            const dh = Math.hypot(fx(hp[0]) - x, vy(disp(hp[1])) - y);
            if (dh < bd) {
              bd = dh;
              best = { kind: 'handle', ids: [p.id], handle: `${p.id}:${side}` };
            }
          }
        });
      }
      return best;
    }
    const { h } = size.current;
    let best: Hit | null = null;
    let bd = 8;
    rows.forEach((r, i) => {
      const cy = m === 'timeline' ? RULER_H + (h - RULER_H) / 2 : rowY(i) + ROW_H / 2;
      if (Math.abs(cy - y) > (m === 'timeline' ? 10 : ROW_H / 2)) return;
      for (const g of keyGroups(r.curves.filter((c) => !c.lock))) {
        const d = Math.abs(fx(g.frame) - x);
        if (d < bd) {
          bd = d;
          best = { kind: 'group', ids: g.ids };
        }
      }
    });
    return best;
  };

  const keysInRect = (x0: number, y0: number, x1: number, y1: number): { keys: string[]; handles: string[] } => {
    const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)];
    const [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
    const { mode: m, rows, curves: cs } = props.current;
    const keys: string[] = [];
    if (m === 'graph') {
      for (const c of cs) {
        if (c.lock) continue;
        const n = normOf(c);
        for (const p of c.points) {
          const x = fx(p.f);
          const y = vy((p.v - n.offset) * n.scale);
          if (x >= ax && x <= bx && y >= ay && y <= by) keys.push(p.id);
        }
      }
      return { keys, handles: [] };
    }
    const { h } = size.current;
    rows.forEach((r, i) => {
      const cy = m === 'timeline' ? RULER_H + (h - RULER_H) / 2 : rowY(i) + ROW_H / 2;
      if (m !== 'timeline' && (cy < ay || cy > by)) return;
      for (const g of keyGroups(r.curves.filter((c) => !c.lock))) {
        const x = fx(g.frame);
        if (x >= ax && x <= bx) keys.push(...g.ids);
      }
    });
    return { keys: [...new Set(keys)], handles: [] };
  };

  // ---------------------------------------------------------------- actions

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const startTransform = (modeT: 'translate' | 'scale' | 'rotate', cx: number, cy: number, release = false) => {
    const app = getApp();
    app.ops.run('anim.keys_transform', { mode: modeT, view: editView(), x: cx, y: cy, release });
  };

  const openMenu = (items: UiMenuItem[], title?: string) => setMenu({ x: pointer.current.x, y: pointer.current.y, items, title });

  const onKey = (e: KeyboardEvent) => {
    const app = getApp();
    if (!hovered.current || app.ops.modalActive) return;
    if (isEditableElement(e.target) || isEditableElement(document.activeElement)) return;
    const s = store.getState();
    if (s.dialog || s.popup || menu) return;
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    const m = props.current.mode;
    let handled = true;
    const p = pointer.current;
    if (k === 'g' && !ctrl && !e.altKey && !e.shiftKey) startTransform('translate', p.x, p.y);
    else if (k === 's' && !ctrl && !e.altKey && !e.shiftKey) startTransform('scale', p.x, p.y);
    else if (k === 'r' && !ctrl && !e.altKey && m === 'graph') startTransform('rotate', p.x, p.y);
    else if ((k === 'x' || k === 'delete') && !ctrl) app.ops.run('anim.keys_delete');
    else if (k === 'a' && !ctrl) app.ops.run('anim.keys_select_all', { action: e.altKey ? 'deselect' : 'select', graph: m === 'graph' });
    else if (k === 'i' && ctrl) app.ops.run('anim.keys_select_all', { action: 'invert', graph: m === 'graph' });
    else if (k === 'd' && e.shiftKey && !ctrl) {
      // Copies décalées d'une image (deux clés à la même image fusionneraient), puis déplacement.
      if (app.ops.run('anim.keys_duplicate', { offset: 1 })) startTransform('translate', p.x, p.y);
    } else if (k === 't' && !ctrl) openMenu(interpolationMenu(), "Mode d'interpolation");
    else if (k === 'e' && ctrl) openMenu(easingMenu(), 'Atténuation');
    else if (k === 'v' && !ctrl && m === 'graph') openMenu(handleTypeMenu(), 'Type de poignée');
    else if (k === 'home') frameAll();
    else if (k === 'i' && !ctrl && !e.altKey) app.ops.run('anim.keyframe_insert', { type: 'available' });
    else if (k === 'k' && !ctrl) app.ops.run('anim.keys_select_column');
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const app = getApp();
    if (app.ops.modalActive) return;
    const p = local(e);
    canvasRef.current?.focus({ preventScroll: true });
    if (e.button === 1) {
      drag.current = { kind: 'pan', pointerId: e.pointerId, x: e.clientX, y: e.clientY };
      canvasRef.current?.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    if (p.y < RULER_H) {
      drag.current = { kind: 'scrub', pointerId: e.pointerId };
      canvasRef.current?.setPointerCapture(e.pointerId);
      setFrame(Math.round(xf(p.x)));
      return;
    }
    const hit = hitTest(p.x, p.y);
    const s = store.getState();
    if (hit) {
      if (hit.kind === 'handle') {
        const hsel = new Set(e.shiftKey ? s.handleSelection : []);
        if (e.shiftKey && hsel.has(hit.handle!)) hsel.delete(hit.handle!);
        else hsel.add(hit.handle!);
        setKeySelection(e.shiftKey ? s.keySelection : [], hsel);
      } else {
        const all = hit.ids.every((id) => s.keySelection.has(id));
        if (e.shiftKey) {
          const next = new Set(s.keySelection);
          for (const id of hit.ids) all ? next.delete(id) : next.add(id);
          setKeySelection(next, s.handleSelection);
        } else if (!all) setKeySelection(hit.ids);
      }
      drag.current = { kind: 'press', pointerId: e.pointerId, x: p.x, y: p.y, cx: e.clientX, cy: e.clientY };
      return;
    }
    drag.current = { kind: 'box', pointerId: e.pointerId, x0: p.x, y0: p.y, x1: p.x, y1: p.y, extend: e.shiftKey };
    canvasRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    pointer.current = { x: e.clientX, y: e.clientY };
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId || getApp().ops.modalActive) return;
    const p = local(e);
    if (d.kind === 'scrub') setFrame(Math.round(xf(p.x)));
    else if (d.kind === 'pan') {
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      d.x = e.clientX;
      d.y = e.clientY;
      view.f0 -= dx * view.fpp;
      if (props.current.mode === 'graph') view.vTop += dy * view.vpp;
      else if (props.current.mode === 'dopesheet') props.current.onScrollY?.(Math.max(0, props.current.scrollY - dy));
      requestDraw();
    } else if (d.kind === 'box') {
      d.x1 = p.x;
      d.y1 = p.y;
      setBox({ x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) });
    } else if (d.kind === 'press' && Math.hypot(p.x - d.x, p.y - d.y) > 3) {
      drag.current = null;
      startTransform('translate', d.cx, d.cy, true);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    try {
      canvasRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* déjà relâché */
    }
    if (d.kind === 'box') {
      setBox(null);
      const s = store.getState();
      if (Math.hypot(d.x1 - d.x0, d.y1 - d.y0) < 3) {
        if (!d.extend) setKeySelection([]);
        return;
      }
      const r = keysInRect(d.x0, d.y0, d.x1, d.y1);
      setKeySelection(d.extend ? [...s.keySelection, ...r.keys] : r.keys, d.extend ? s.handleSelection : []);
    }
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (getApp().ops.modalActive) return;
    const p = local(e);
    const hit = p.y >= RULER_H ? hitTest(p.x, p.y) : null;
    const s = store.getState();
    if (hit && hit.kind !== 'handle' && !hit.ids.every((id) => s.keySelection.has(id))) setKeySelection(hit.ids);
    setMenu({ x: e.clientX, y: e.clientY, items: keyContextMenu(props.current.mode === 'graph'), title: 'Images clés' });
  };

  // ---------------------------------------------------------------- branchements

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => {
      const first = !size.current.w;
      size.current = { w: wrap.clientWidth, h: wrap.clientHeight };
      if (first && !view.init) frameAll();
      requestDraw();
    });
    ro.observe(wrap);
    size.current = { w: wrap.clientWidth, h: wrap.clientHeight };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvasRef.current!.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const delta = e.deltaY || e.deltaX;
      if (e.ctrlKey || e.metaKey) view.f0 += Math.sign(delta) * 40 * view.fpp;
      else if (e.shiftKey) {
        if (props.current.mode === 'graph') view.vTop -= Math.sign(delta) * 30 * view.vpp;
        else if (props.current.mode === 'dopesheet') props.current.onScrollY?.(Math.max(0, props.current.scrollY + Math.sign(delta) * ROW_H * 2));
      } else {
        const k = Math.pow(1.0015, delta);
        const f = xf(x);
        view.fpp = Math.min(50, Math.max(0.005, view.fpp * k));
        view.f0 = f - x * view.fpp;
        if (props.current.mode === 'graph') {
          const v = yv(y);
          view.vpp = Math.min(1e6, Math.max(1e-6, view.vpp * k));
          view.vTop = v + (y - RULER_H) * view.vpp;
        }
      }
      requestDraw();
    };
    wrap.addEventListener('wheel', onWheel, { passive: false });
    framers.set(viewKey, frameAll);
    const unsub = store.subscribe((s, p) => {
      if (s.frame !== p.frame || s.graphNormalize !== p.graphNormalize) requestDraw();
    });
    const offDoc = getApp().onDocChange((doc) => {
      requestDraw();
      const offs = [doc.on('anim', requestDraw), doc.on('scene', requestDraw)];
      return () => offs.forEach((o) => o());
    });
    return () => {
      ro.disconnect();
      wrap.removeEventListener('wheel', onWheel);
      if (framers.get(viewKey) === frameAll) framers.delete(viewKey);
      unsub();
      offDoc();
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  useEffect(() => {
    requestDraw();
  });

  const empty = mode === 'graph' ? curves.length === 0 : rows.every((r) => r.curves.length === 0);

  return (
    <div
      ref={wrapRef}
      className={`cf-anim-canvas-wrap${autoKey ? ' is-autokey' : ''}`}
      onPointerEnter={() => (hovered.current = true)}
      onPointerLeave={() => (hovered.current = false)}
    >
      <canvas
        ref={canvasRef}
        tabIndex={-1}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={onContextMenu}
        onAuxClick={(e) => e.preventDefault()}
      />
      {box && <div className="cf-anim-box" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} />}
      {empty && emptyText && <div className="cf-anim-empty">{emptyText}</div>}
      {menu && <Menu items={menu.items} x={menu.x} y={menu.y} title={menu.title} onClose={() => setMenu(null)} />}
    </div>
  );
}

function useAutoKey(): boolean {
  const [on, setOn] = useState(store.getState().autoKey);
  useEffect(() => store.subscribe((s) => setOn(s.autoKey)), []);
  return on;
}

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string, alpha: number): void {
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = C.keyOutline;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function formatValue(v: number, step: number): string {
  const d = Math.max(0, Math.min(6, -Math.floor(Math.log10(step)) + 1));
  const r = Number(v.toFixed(d));
  return String(Object.is(r, -0) ? 0 : r);
}

