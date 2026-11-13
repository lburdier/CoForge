import { useEffect, useMemo, useRef, useState } from 'react';
import { Table } from 'lucide-react';
import { getApp } from '../../app/context';
import { useApp } from '../../app/store';
import type { MeshData, Vec3 } from '../../core/doc/schema';
import { faceArea } from '../../core/mesh/topology';
import { useDocWhen, useObject } from '../properties/docHooks';
import { Checkbox, Select } from '../widgets/basic';
import { EditorHeader, EditorShell } from './common';

type Domain = 'verts' | 'faces' | 'objects';

const ROW_H = 20;
const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : '—');

interface Column {
  label: string;
  width: number;
  align?: 'right';
}

/** Tableur : données du maillage de l'objet actif (sommets, faces) ou liste des objets de la scène. */
export function SpreadsheetEditor() {
  const activeId = useApp((s) => s.activeId);
  const mode = useApp((s) => s.mode);
  const editSel = useApp((s) => s.editSelection);
  const obj = useObject(activeId);
  const [domain, setDomain] = useState<Domain>('verts');
  const [evaluated, setEvaluated] = useState(false);
  const [onlySelected, setOnlySelected] = useState(false);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(300);
  const bodyRef = useRef<HTMLDivElement>(null);

  const dataId = obj?.type === 'mesh' ? obj.data : null;
  const mesh = useDocWhen<MeshData | null>(
    (doc) => {
      if (!dataId || !obj) return null;
      if (evaluated) return getApp().viewport.getEvaluatedMesh(obj.id) ?? doc.getMesh(dataId);
      return doc.getMesh(dataId);
    },
    { mesh: (e) => e.id === dataId, objects: (e) => !!obj && e.changed.some((c) => c.id === obj.id), data: (e) => e.table === 'nodeTrees' },
    [dataId, evaluated, obj?.id],
  );
  const objects = useDocWhen((doc) => (domain === 'objects' ? doc.listObjects() : []), { objects: true, change: (e) => !!e.anim }, [domain]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  });

  const filterSel = onlySelected && mode === 'edit' && !evaluated;
  const rows = useMemo((): { cols: Column[]; cells: string[][] } => {
    if (domain === 'objects') {
      return {
        cols: [
          { label: 'Nom', width: 160 },
          { label: 'Type', width: 70 },
          { label: 'Position X', width: 80, align: 'right' },
          { label: 'Y', width: 70, align: 'right' },
          { label: 'Z', width: 70, align: 'right' },
          { label: 'Visible', width: 60 },
        ],
        cells: objects.map((o) => [o.name, o.type, fmt(o.pos[0]), fmt(o.pos[1]), fmt(o.pos[2]), o.visible ? 'oui' : 'non']),
      };
    }
    if (!mesh) return { cols: [], cells: [] };
    if (domain === 'verts') {
      const list: [string, Vec3][] = [];
      for (const e of mesh.verts) if (!filterSel || editSel.verts.has(e[0])) list.push(e);
      return {
        cols: [
          { label: 'Identifiant', width: 120 },
          { label: 'Position X', width: 90, align: 'right' },
          { label: 'Y', width: 90, align: 'right' },
          { label: 'Z', width: 90, align: 'right' },
        ],
        cells: list.map(([id, p]) => [id, fmt(p[0]), fmt(p[1]), fmt(p[2])]),
      };
    }
    const list: [string, string[]][] = [];
    for (const e of mesh.faces) if (!filterSel || editSel.faces.has(e[0])) list.push(e);
    return {
      cols: [
        { label: 'Identifiant', width: 120 },
        { label: 'Côtés', width: 60, align: 'right' },
        { label: 'Aire', width: 90, align: 'right' },
        { label: 'Sommets', width: 320 },
      ],
      cells: list.map(([id, loop]) => [id, String(loop.length), fmt(faceArea(mesh, loop)), loop.join(', ')]),
    };
  }, [domain, mesh, objects, filterSel, editSel]);

  const total = rows.cells.length;
  const first = Math.max(0, Math.floor(scroll / ROW_H) - 5);
  const last = Math.min(total, Math.ceil((scroll + height) / ROW_H) + 5);
  const template = rows.cols.map((c) => `${c.width}px`).join(' ');

  return (
    <EditorShell className="cf-sheet">
      <EditorHeader title="Tableur" icon={Table}>
        <Select<Domain>
          value={domain}
          options={[
            { value: 'verts', label: 'Sommets' },
            { value: 'faces', label: 'Faces' },
            { value: 'objects', label: 'Objets de la scène' },
          ]}
          onChange={setDomain}
          tip="Domaine affiché"
        />
        {domain !== 'objects' && (
          <>
            <Checkbox checked={evaluated} onChange={setEvaluated} label="Évalué" tip="Données après les modificateurs (nœuds de géométrie compris)" />
            <Checkbox checked={onlySelected} onChange={setOnlySelected} label="Sélection seule" tip="Mode édition : seulement les éléments sélectionnés" disabled={evaluated} />
          </>
        )}
        <div className="cf-spacer" />
        <span className="cf-ed-dim">
          {domain === 'objects' ? `${total} objet(s)` : obj ? `${obj.name} · ${total} ligne(s)` : ''}
        </span>
      </EditorHeader>
      {domain !== 'objects' && !mesh ? (
        <div className="cf-ed-empty">{obj ? 'L’objet actif n’est pas un maillage.' : 'Sélectionnez un maillage pour voir ses données.'}</div>
      ) : (
        <div
          ref={bodyRef}
          className="cf-ed-body cf-sheet-body"
          onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
        >
          <div className="cf-sheet-head" style={{ gridTemplateColumns: `48px ${template}` }}>
            <span className="is-right">#</span>
            {rows.cols.map((c) => (
              <span key={c.label} className={c.align === 'right' ? 'is-right' : ''}>
                {c.label}
              </span>
            ))}
          </div>
          <div style={{ height: total * ROW_H, position: 'relative' }}>
            {rows.cells.slice(first, last).map((r, k) => {
              const i = first + k;
              return (
                <div key={i} className={`cf-sheet-row${i % 2 ? ' is-alt' : ''}`} style={{ top: i * ROW_H, gridTemplateColumns: `48px ${template}` }}>
                  <span className="is-right cf-ed-dim">{i}</span>
                  {r.map((c, j) => (
                    <span key={j} className={rows.cols[j]?.align === 'right' ? 'is-right' : ''} title={c.length > 24 ? c : undefined}>
                      {c}
                    </span>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </EditorShell>
  );
}
