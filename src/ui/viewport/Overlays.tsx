import { memo, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Info, X } from 'lucide-react';
import { getApp } from '../../app/context';
import { useDoc } from '../../app/hooks';
import { useApp } from '../../app/store';
import { ROOT_COLLECTION, edgeKey, type MeshData } from '../../core/doc/schema';
import type { ParamDef } from '../../tools/api';
import { dismissToast, useActiveToast } from '../lib/toast';
import { formatCount, useDocThrottled, usePersistent, useSceneStats } from '../lib/util';
import { Checkbox, Row, Select } from '../widgets/basic';
import { NumberField } from '../widgets/NumberField';

// ------------------------------------------------------------------ texte en haut à gauche

function useViewName(): string {
  const cameraView = useApp((s) => s.cameraView);
  const ortho = useApp((s) => s.orthographic);
  const follow = useApp((s) => s.followClientId);
  const followName = useApp((s) => (follow === null ? null : (s.session.peers.find((p) => p.clientId === follow)?.name ?? null)));
  if (followName) return `Vue de ${followName}`;
  if (cameraView) return 'Vue caméra';
  return ortho ? 'Orthographique utilisateur' : 'Perspective utilisateur';
}

function countEdges(mesh: MeshData): number {
  const set = new Set<string>();
  for (const loop of mesh.faces.values()) {
    for (let i = 0; i < loop.length; i++) set.add(edgeKey(loop[i], loop[(i + 1) % loop.length]));
  }
  return set.size;
}

const ObjectStats = memo(function ObjectStats() {
  const stats = useSceneStats();
  const selected = useApp((s) => s.selection.size);
  return (
    <table className="cf-vp-stats">
      <tbody>
        <tr>
          <td>Objets</td>
          <td>
            {formatCount(selected)} / {formatCount(stats.objects)}
          </td>
        </tr>
        <tr>
          <td>Sommets</td>
          <td>{formatCount(stats.verts)}</td>
        </tr>
        <tr>
          <td>Faces</td>
          <td>{formatCount(stats.faces)}</td>
        </tr>
      </tbody>
    </table>
  );
});

const EditStats = memo(function EditStats({ objectId }: { objectId: string }) {
  const sel = useApp((s) => s.editSelection);
  const totals = useDocThrottled(
    (doc) => {
      const obj = doc.getObject(objectId);
      const mesh = obj?.data ? doc.getMesh(obj.data) : null;
      return mesh ? { verts: mesh.verts.size, edges: countEdges(mesh), faces: mesh.faces.size } : null;
    },
    400,
    ['mesh', 'objects'],
  );
  if (!totals) return null;
  return (
    <table className="cf-vp-stats">
      <tbody>
        <tr>
          <td>Sommets</td>
          <td>
            {formatCount(sel.verts.size)} / {formatCount(totals.verts)}
          </td>
        </tr>
        <tr>
          <td>Arêtes</td>
          <td>
            {formatCount(sel.edges.size)} / {formatCount(totals.edges)}
          </td>
        </tr>
        <tr>
          <td>Faces</td>
          <td>
            {formatCount(sel.faces.size)} / {formatCount(totals.faces)}
          </td>
        </tr>
      </tbody>
    </table>
  );
});

function RenderInfo() {
  const shading = useApp((s) => s.shading);
  const running = useApp((s) => s.render.running);
  const samples = useApp((s) => s.render.samples);
  const progress = useApp((s) => s.render.progress);
  const settings = useDoc((doc) => doc.getScene().render, ['scene']);
  if (running) {
    return (
      <div className="cf-vp-info-line is-accent">
        Rendu final : {Math.round(progress * 100)} %{settings.engine === 'pathtrace' ? `, ${samples}/${settings.samples} échantillons` : ''}
      </div>
    );
  }
  if (shading === 'rendered' && settings.engine === 'pathtrace') {
    return <PathTraceStatus max={settings.viewportSamples} />;
  }
  return null;
}

interface PtStatus {
  compiling: boolean;
  samples: number;
  unavailable: boolean;
}

/** État du path tracing du viewport (compilation du shader, échantillons accumulés), relu deux fois par seconde. */
function PathTraceStatus({ max }: { max: number }) {
  const [st, setSt] = useState<PtStatus | null>(null);
  useEffect(() => {
    const read = () => {
      const s = (getApp().viewport as unknown as { pathTracingStatus?: PtStatus }).pathTracingStatus;
      setSt(s ? { ...s } : null);
    };
    read();
    const t = setInterval(read, 500);
    return () => clearInterval(t);
  }, []);
  if (st?.compiling) {
    return (
      <div className="cf-vp-info-line is-accent">
        Path tracing : compilation des shaders… (la première fois, jusqu'à une minute ; aperçu temps réel en attendant)
      </div>
    );
  }
  if (st && st.unavailable && st.samples === 0) {
    return <div className="cf-vp-info-line">Path tracing indisponible sur ce GPU : aperçu temps réel</div>;
  }
  const n = Math.min(st?.samples ?? 0, max);
  return (
    <div className="cf-vp-info-line">
      Path tracing : {n} / {max} échantillons{n >= max ? ' (terminé)' : ''}
    </div>
  );
}

/** Superposition en haut à gauche : nom de la vue, objet actif, statistiques. */
export function ViewInfo() {
  const viewName = useViewName();
  const activeId = useApp((s) => s.activeId);
  const mode = useApp((s) => s.mode);
  const showStats = useApp((s) => s.overlays.stats);
  const showToolbar = useApp((s) => s.showToolbar);
  const label = useDoc(
    (doc) => {
      const obj = activeId ? doc.getObject(activeId) : null;
      if (!obj) return null;
      const col = obj.collection !== ROOT_COLLECTION ? doc.getCollection(obj.collection) : null;
      return `${col?.name ?? 'Collection de scène'} | ${obj.name}`;
    },
    ['objects', 'data'],
    [activeId],
  );
  return (
    <div className={`cf-vp-info${showToolbar ? ' has-toolbar' : ''}`}>
      <div className="cf-vp-info-title">{viewName}</div>
      {label && <div className="cf-vp-info-line">{label}</div>}
      {mode === 'edit' && <div className="cf-vp-info-line is-dim">Mode édition</div>}
      <RenderInfo />
      {showStats && (mode === 'edit' && activeId ? <EditStats key={activeId} objectId={activeId} /> : <ObjectStats />)}
    </div>
  );
}

// ------------------------------------------------------------------ ajuster la dernière opération

function ParamField({ def, value, onChange }: { def: ParamDef; value: any; onChange(v: any): void }) {
  switch (def.type) {
    case 'bool':
      return <Checkbox checked={!!value} onChange={onChange} label={def.label} />;
    case 'enum':
      return (
        <Row label={def.label}>
          <Select value={String(value ?? '')} options={def.options ?? []} onChange={onChange} />
        </Row>
      );
    case 'int':
      return (
        <Row label={def.label}>
          <NumberField
            value={Number(value) || 0}
            integer
            min={def.min}
            max={def.max}
            step={def.step ?? 1}
            undoGroup={false}
            onChange={onChange}
          />
        </Row>
      );
    default:
      return (
        <Row label={def.label}>
          <NumberField
            value={Number(value) || 0}
            min={def.min}
            max={def.max}
            step={def.step ?? 0.01}
            slider={def.min !== undefined && def.max !== undefined && def.max - def.min <= 1}
            undoGroup={false}
            onChange={onChange}
          />
        </Row>
      );
  }
}

/** Panneau repliable en bas à gauche : rejoue la dernière opération avec d'autres paramètres. */
export function AdjustLastOp() {
  const lastOp = useApp((s) => s.lastOp);
  const modal = useApp((s) => s.modal !== null);
  const [open, setOpen] = usePersistent('adjustLastOp.open', true);
  const params = useMemo(() => (lastOp ? (getApp().ops.get(lastOp.opId)?.params ?? []) : []), [lastOp?.opId]);
  if (!lastOp || modal || params.length === 0) return null;
  const set = (key: string, v: unknown) => {
    getApp().ops.redoLast({ [key]: v });
  };
  return (
    <div className={`cf-adjust${open ? ' is-open' : ''}`} onContextMenu={(e) => e.preventDefault()}>
      <header className="cf-adjust-header" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{lastOp.label}</span>
      </header>
      {open && (
        <div className="cf-adjust-body">
          {params.map((p) => (
            <ParamField key={p.key} def={p} value={lastOp.args[p.key]} onChange={(v) => set(p.key, v)} />
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ messages transitoires

/**
 * Zone des messages transitoires, en bas au centre du viewport. Les messages
 * d'information s'affichent dans la barre d'état ; les erreurs sont aussi
 * montrées ici, plus visibles.
 */
export function ToastArea() {
  const toast = useActiveToast();
  if (!toast || toast.kind !== 'error') return null;
  const Icon = toast.kind === 'error' ? AlertTriangle : Info;
  return (
    <div className="cf-toast-area">
      <div key={toast.time} className={`cf-toast is-${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
        <Icon size={14} />
        <span>{toast.text}</span>
        <button type="button" tabIndex={-1} className="cf-toast-close" aria-label="Fermer" onClick={dismissToast}>
          <X size={12} />
        </button>
      </div>
    </div>
  );
}
