import { useEffect, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent, type WheelEvent } from 'react';

/**
 * Vue 2D zoomable (molette) et déplaçable (clic milieu, ou clic gauche avec Alt / sur le fond) :
 * le contenu est placé dans un carré `size` × `size` unités, centré au départ. Partagée par
 * l'éditeur d'images et l'éditeur UV.
 */
export interface View2D {
  x: number;
  y: number;
  z: number;
}

export function useFitView(width: number, height: number, contentW: number, contentH: number): View2D {
  const z = Math.min((width - 40) / Math.max(1, contentW), (height - 40) / Math.max(1, contentH));
  const zz = Number.isFinite(z) && z > 0 ? z : 1;
  return { x: (width - contentW * zz) / 2, y: (height - contentH * zz) / 2, z: zz };
}

export function PanZoom({
  contentW,
  contentH,
  fitKey,
  children,
  overlay,
  className = '',
}: {
  contentW: number;
  contentH: number;
  /** Changer cette clé recadre la vue. */
  fitKey: string;
  children: ReactNode;
  overlay?: (view: View2D) => ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 400, h: 300 });
  const [view, setView] = useState<View2D | null>(null);
  const drag = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);
  const fit = useFitView(size.w, size.h, contentW, contentH);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  useEffect(() => setView(null), [fitKey]);

  const v = view ?? fit;

  const onWheel = (e: WheelEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const k = Math.exp(-e.deltaY * 0.0015);
    const z = Math.max(0.02, Math.min(64, v.z * k));
    const f = z / v.z;
    setView({ x: mx - (mx - v.x) * f, y: my - (my - v.y) * f, z });
  };
  const onDown = (e: ReactPointerEvent) => {
    if (e.button !== 1 && !(e.button === 0 && (e.altKey || e.target === e.currentTarget))) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y };
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setView({ ...v, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy });
  };
  const onUp = () => {
    drag.current = null;
  };

  return (
    <div
      ref={ref}
      className={`cf-pz ${className}`}
      tabIndex={0}
      onWheel={onWheel}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onKeyDown={(e) => {
        if (e.key === 'Home' || e.key === '.') {
          e.stopPropagation();
          setView(null);
        }
      }}
      onDoubleClick={(e) => e.target === e.currentTarget && setView(null)}
    >
      <div className="cf-pz-content" style={{ transform: `translate(${v.x}px, ${v.y}px) scale(${v.z})`, width: contentW, height: contentH }}>
        {children}
      </div>
      {overlay?.(v)}
      <span className="cf-pz-zoom">{Math.round(v.z * 100)} %</span>
    </div>
  );
}
