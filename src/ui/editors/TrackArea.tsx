import { useEffect, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent, type WheelEvent } from 'react';
import { setFrame, useApp } from '../../app/store';
import { useDocWhen } from '../properties/docHooks';

/**
 * Zone de pistes horizontales (éditeur NLA, montage vidéo) : règle des images en haut (clic ou
 * glisser = changer d'image), colonne des noms à gauche, curseur d'image. Molette : zoom ;
 * Maj + molette ou clic milieu : défilement.
 */
export interface FrameScale {
  /** Image → abscisse (px, relatif à la zone des pistes). */
  x(frame: number): number;
  /** Abscisse → image. */
  f(x: number): number;
  pxPerFrame: number;
}

export const TRACK_RULER_H = 22;

export function TrackArea({ labelW = 170, rows, footer }: { labelW?: number; rows(scale: FrameScale): ReactNode; footer?: ReactNode }) {
  const anim = useDocWhen((doc) => doc.getAnimSettings(), { scene: (e) => e.keys.some((k) => k.startsWith('a:')) });
  const frame = useApp((s) => s.frame);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [range, setRange] = useState<[number, number] | null>(null);
  const drag = useRef<{ kind: 'scrub' } | { kind: 'pan'; sx: number; r: [number, number] } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(50, el.clientWidth - labelW)));
    ro.observe(el);
    setWidth(Math.max(50, el.clientWidth - labelW));
    return () => ro.disconnect();
  }, [labelW]);

  const pad = Math.max(5, (anim.frameEnd - anim.frameStart) * 0.05);
  const [r0, r1] = range ?? [anim.frameStart - pad, anim.frameEnd + pad];
  const pxPerFrame = width / Math.max(1, r1 - r0);
  const scale: FrameScale = { x: (fr) => (fr - r0) * pxPerFrame, f: (x) => r0 + x / pxPerFrame, pxPerFrame };

  const step = niceStep(pxPerFrame);
  const ticks: number[] = [];
  for (let t = Math.ceil(r0 / step) * step; t <= r1; t += step) ticks.push(t);

  const localX = (e: { clientX: number }) => e.clientX - (ref.current?.getBoundingClientRect().left ?? 0) - labelW;

  const onRulerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { kind: 'scrub' };
    setFrame(Math.round(scale.f(localX(e))));
  };
  const onDown = (e: ReactPointerEvent) => {
    if (e.button !== 1) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { kind: 'pan', sx: e.clientX, r: [r0, r1] };
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'scrub') setFrame(Math.round(scale.f(localX(e))));
    else {
      const df = (e.clientX - d.sx) / pxPerFrame;
      setRange([d.r[0] - df, d.r[1] - df]);
    }
  };
  const onUp = () => {
    drag.current = null;
  };
  const onWheel = (e: WheelEvent) => {
    if (e.shiftKey) {
      const df = (e.deltaY / pxPerFrame) * 0.5;
      setRange([r0 + df, r1 + df]);
      return;
    }
    const at = scale.f(localX(e));
    const k = Math.exp(e.deltaY * 0.0015);
    const n0 = at - (at - r0) * k;
    const n1 = at + (r1 - at) * k;
    if (n1 - n0 > 2 && n1 - n0 < 100000) setRange([n0, n1]);
  };

  return (
    <div ref={ref} className="cf-tracks" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onWheel={onWheel} onDoubleClick={(e) => e.target === e.currentTarget && setRange(null)}>
      <div className="cf-tracks-ruler" style={{ height: TRACK_RULER_H, paddingLeft: labelW }}>
        <div className="cf-tracks-ruler-in" onPointerDown={onRulerDown} onPointerMove={onMove} onPointerUp={onUp}>
          {ticks.map((t) => (
            <span key={t} style={{ left: scale.x(t) }}>
              {Math.round(t)}
            </span>
          ))}
          <div className="cf-tracks-cur-label" style={{ left: scale.x(frame) }}>
            {Math.round(frame)}
          </div>
        </div>
      </div>
      <div className="cf-tracks-body">
        <div className="cf-tracks-range" style={{ left: labelW + scale.x(anim.frameStart), width: Math.max(0, scale.x(anim.frameEnd) - scale.x(anim.frameStart)) }} />
        {rows(scale)}
        {footer}
        <div className="cf-tracks-cursor" style={{ left: labelW + scale.x(frame) }} />
      </div>
    </div>
  );
}

/** Pas de graduation « rond » (1, 2, 5, 10…) laissant au moins 50 px entre deux étiquettes. */
function niceStep(pxPerFrame: number): number {
  const raw = 50 / Math.max(1e-6, pxPerFrame);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return Math.max(1, m * p);
  return Math.max(1, 10 * p);
}
