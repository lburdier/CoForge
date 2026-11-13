import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { FolderOpen, ImageOff } from 'lucide-react';
import { getApp } from '../../app/context';
import { toast, useApp } from '../../app/store';
import { platform } from '../../app/platform';
import type { NodeData } from '../../core/doc/schema';
import { getImage, IMAGE_FILE_FILTER, imageMimeFromName, importImage, listImages, onImagesChanged } from '../../core/nodes/shader/images';
import type { NodePropDef } from '../../core/nodes/types';
import { Select } from '../widgets/basic';
import { curveAdd, curveMove, curvePoints, curveRemove, type CurvePt } from './editorLogic';

/** Rappel d'écriture d'une propriété de nœud (une étape d'annulation). */
export type WriteProp = (nodeId: string, prop: string, value: unknown) => void;

const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

// ------------------------------------------------------------------ courbes

interface Mapping {
  curves: { points: CurvePt[] }[];
  clip?: { minX: number; minY: number; maxX: number; maxY: number };
}

const CHANNELS: Record<number, string[]> = { 4: ['C', 'R', 'V', 'B'], 3: ['X', 'Y', 'Z'] };
const CHANNEL_COLORS: Record<string, string> = { C: '#dddddd', R: '#e05050', V: '#50c050', B: '#5080e0', X: '#e05050', Y: '#50c050', Z: '#5080e0' };

/** Points échantillonnés pour l'affichage (Catmull-Rom sur les points « AUTO », segments droits sur « VECTOR »). */
function sampleCurve(pts: CurvePt[]): CurvePt[] {
  const out: CurvePt[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const straight = p1.handle === 'VECTOR' && p2.handle === 'VECTOR';
    const steps = straight ? 1 : 12;
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      if (straight) {
        out.push(p1);
        continue;
      }
      const t2 = t * t;
      const t3 = t2 * t;
      const y = 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      out.push({ x: p1.x + (p2.x - p1.x) * t, y });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * Éditeur de courbes (Courbes RVB, Courbes vectorielles, Courbe flottante) : clic dans le vide =
 * ajouter un point, glisser = déplacer (écrit au relâchement), double-clic sur un point = le retirer.
 */
export function CurveWidget({ node, prop, write, height }: { node: NodeData; prop: NodePropDef; write: WriteProp; height: number }) {
  const raw = (node.props?.[prop.id] ?? prop.default) as Mapping | undefined;
  const def = prop.default as Mapping;
  const curves = Array.isArray(raw?.curves) && raw!.curves.length ? raw!.curves : def.curves;
  const defPts = def.curves[0]?.points ?? [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  const lo = raw?.clip ? raw.clip.minX : Math.min(...defPts.map((p) => p.x));
  const hi = raw?.clip ? raw.clip.maxX : Math.max(...defPts.map((p) => p.x));
  const labels = CHANNELS[curves.length] ?? [];
  const [channel, setChannel] = useState(0);
  const ch = Math.min(channel, curves.length - 1);
  const stored = curvePoints(curves[ch]?.points, lo, hi);
  const [draft, setDraft] = useState<{ pts: CurvePt[]; index: number } | null>(null);
  const pts = draft?.pts ?? stored;
  const svgRef = useRef<SVGSVGElement>(null);
  const W = 200;
  const H = Math.max(40, height - (labels.length ? 26 : 6));
  const sx = (x: number) => ((x - lo) / (hi - lo || 1)) * W;
  const sy = (y: number) => H - ((y - lo) / (hi - lo || 1)) * H;

  const save = (next: CurvePt[]) => {
    const all = curves.map((c, i) => (i === ch ? { ...c, points: next } : c));
    write(node.id, prop.id, { ...(raw ?? {}), curves: all });
  };
  const toCurve = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: lo + ((e.clientX - r.left) / Math.max(1, r.width)) * (hi - lo), y: lo + (1 - (e.clientY - r.top) / Math.max(1, r.height)) * (hi - lo) };
  };
  const onDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const p = toCurve(e);
    const r = svgRef.current!.getBoundingClientRect();
    const tol = (8 / Math.max(1, r.width)) * (hi - lo);
    let index = pts.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < tol);
    let next = pts;
    if (index < 0) ({ pts: next, index } = curveAdd(pts, p.x, p.y, lo, hi));
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setDraft({ pts: next, index });
  };
  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!draft) return;
    const p = toCurve(e);
    setDraft({ ...draft, pts: curveMove(draft.pts, draft.index, p.x, p.y, lo, hi) });
  };
  const onUp = () => {
    if (!draft) return;
    save(draft.pts);
    setDraft(null);
  };
  const onDouble = (e: ReactMouseEvent<SVGSVGElement>) => {
    e.stopPropagation();
    const p = toCurve(e);
    const r = svgRef.current!.getBoundingClientRect();
    const tol = (8 / Math.max(1, r.width)) * (hi - lo);
    const i = stored.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < tol);
    if (i >= 0 && stored.length > 2) save(curveRemove(stored, i));
  };

  const line = sampleCurve(pts)
    .map((p) => `${sx(p.x).toFixed(1)},${sy(Math.max(lo, Math.min(hi, p.y))).toFixed(1)}`)
    .join(' ');
  const color = CHANNEL_COLORS[labels[ch]] ?? '#dddddd';
  return (
    <div className="cf-nd-curve" onPointerDown={stop}>
      {labels.length > 0 && (
        <div className="cf-nd-curve-tabs">
          {labels.map((l, i) => (
            <button key={l} type="button" className={`cf-nd-curve-tab${i === ch ? ' is-active' : ''}`} style={{ color: CHANNEL_COLORS[l] }} onClick={() => setChannel(i)}>
              {l}
            </button>
          ))}
        </div>
      )}
      <svg
        ref={svgRef}
        className="cf-nd-curve-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ height: H }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => setDraft(null)}
        onDoubleClick={onDouble}
        data-tip="Clic : ajouter un point · glisser : déplacer · double-clic : retirer"
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <g key={f} className="cf-nd-curve-grid">
            <line x1={W * f} y1={0} x2={W * f} y2={H} />
            <line x1={0} y1={H * f} x2={W} y2={H * f} />
          </g>
        ))}
        <polyline points={line} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        {pts.map((p, i) => (
          <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={3} className={`cf-nd-curve-pt${draft?.index === i ? ' is-active' : ''}`} vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
    </div>
  );
}

// ------------------------------------------------------------------ texture image

/** Choix de l'image d'un nœud Texture image : « Ouvrir » (fichier → document), liste des images du document, vignette. */
export function ImageWidget({ node, prop, write }: { node: NodeData; prop: NodePropDef; write: WriteProp }) {
  const epoch = useApp((s) => s.docEpoch);
  const doc = getApp().doc;
  const [, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => onImagesChanged(doc, () => setVersion((v) => v + 1)), [doc, epoch]);
  const id = node.props?.[prop.id];
  const img = getImage(doc, id);
  const images = listImages(doc);
  const url = useMemo(() => (img ? URL.createObjectURL(new Blob([img.bytes as BlobPart], { type: img.mime })) : null), [img?.id, img?.bytes]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  const open = async () => {
    const f = await platform.openFile([IMAGE_FILE_FILTER], 'Ouvrir une image');
    if (!f) return;
    setBusy(true);
    try {
      const nid = await importImage(getApp().doc, f.name, f.data, imageMimeFromName(f.name) ?? undefined);
      write(node.id, prop.id, nid);
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cf-nd-image" onPointerDown={stop}>
      <div className="cf-nd-image-row">
        <button type="button" className="cf-btn cf-nd-image-open" onClick={() => void open()} disabled={busy} data-tip="Ouvrir une image (PNG, JPEG, WebP) : elle est enregistrée dans la scène partagée">
          <FolderOpen size={12} />
          <span>{busy ? 'Chargement…' : 'Ouvrir'}</span>
        </button>
        {images.length > 0 && (
          <Select
            value={img?.id ?? ''}
            placeholder="Image…"
            options={images.map((m) => ({ value: m.id, label: m.name }))}
            onChange={(v) => write(node.id, prop.id, v)}
            tip="Images de la scène"
          />
        )}
      </div>
      <div className="cf-nd-image-thumb">
        {url ? (
          <img src={url} alt={img!.name} draggable={false} data-tip={`${img!.name} : ${img!.width} × ${img!.height} px`} />
        ) : (
          <span className="cf-nd-image-none">
            <ImageOff size={14} />
            {typeof id === 'string' && id ? 'Image introuvable' : 'Aucune image'}
          </span>
        )}
      </div>
    </div>
  );
}
