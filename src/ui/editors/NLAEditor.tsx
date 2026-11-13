import { useMemo, useState } from 'react';
import { Clapperboard, Lock, LockOpen, Volume2, VolumeX } from 'lucide-react';
import { getApp } from '../../app/context';
import { setSelection, useApp } from '../../app/store';
import { useAnimVersion } from '../timeline/model';
import { withOp } from '../lib/util';
import { Checkbox, IconButton } from '../widgets/basic';
import { EditorHeader, EditorShell } from './common';
import { TrackArea } from './TrackArea';

interface NlaRow {
  objectId: string;
  name: string;
  curves: string[];
  start: number;
  end: number;
  keys: number[];
  muted: boolean;
  locked: boolean;
}

/**
 * Animation non linéaire : une piste par objet animé, avec la bande de son action (de la première à
 * la dernière clé, ses clés en repère). Couper le son d'une bande rend toutes ses courbes muettes ;
 * le cadenas les verrouille (pour tous les participants).
 */
export function NLAEditor() {
  const version = useAnimVersion();
  const selection = useApp((s) => s.selection);
  const [onlySelected, setOnlySelected] = useState(false);

  const rows = useMemo((): NlaRow[] => {
    const doc = getApp().doc;
    const out: NlaRow[] = [];
    for (const o of doc.listObjects()) {
      if (onlySelected && !selection.has(o.id)) continue;
      const curves: string[] = [];
      const frames = new Set<number>();
      let muted = true;
      let locked = true;
      for (const { owner } of doc.objectAnimOwners(o.id)) {
        for (const ck of doc.animCurveKeys(owner)) {
          const c = doc.getAnimCurve(ck);
          if (!c || c.keys.length === 0) continue;
          curves.push(ck);
          for (const k of c.keys) frames.add(Math.round(k.frame * 100) / 100);
          muted &&= c.flags.mute;
          locked &&= c.flags.lock;
        }
      }
      if (curves.length === 0) continue;
      const keys = [...frames].sort((a, b) => a - b);
      out.push({ objectId: o.id, name: o.name, curves, start: keys[0], end: keys[keys.length - 1], keys, muted, locked });
    }
    return out;
  }, [version, onlySelected, selection]); // eslint-disable-line react-hooks/exhaustive-deps

  const setFlag = (row: NlaRow, flag: 'mute' | 'lock', on: boolean) => {
    withOp((doc) => {
      for (const ck of row.curves) doc.setAnimCurveFlags(ck, { [flag]: on });
    });
    getApp().viewport.requestRender();
  };

  return (
    <EditorShell className="cf-nla">
      <EditorHeader title="Animation non linéaire" icon={Clapperboard}>
        <Checkbox checked={onlySelected} onChange={setOnlySelected} label="Sélection seule" />
        <div className="cf-spacer" />
        <span className="cf-ed-dim">{rows.length} piste(s)</span>
      </EditorHeader>
      {rows.length === 0 ? (
        <div className="cf-ed-empty">Aucun objet animé : posez des images clés (I dans le viewport) pour voir leurs actions ici.</div>
      ) : (
        <TrackArea
          rows={(sc) =>
            rows.map((r) => (
              <div key={r.objectId} className={`cf-track${selection.has(r.objectId) ? ' is-selected' : ''}`}>
                <div className="cf-track-label">
                  <IconButton icon={r.muted ? VolumeX : Volume2} tip={r.muted ? 'Réactiver la bande' : 'Rendre la bande muette'} active={!r.muted} onClick={() => setFlag(r, 'mute', !r.muted)} size={12} />
                  <IconButton icon={r.locked ? Lock : LockOpen} tip={r.locked ? 'Déverrouiller' : 'Verrouiller les clés'} active={r.locked} onClick={() => setFlag(r, 'lock', !r.locked)} size={12} />
                  <span className="cf-track-name" onClick={() => setSelection([r.objectId])}>
                    {r.name}
                  </span>
                </div>
                <div className="cf-track-lane">
                  <div
                    className={`cf-strip is-action${r.muted ? ' is-muted' : ''}`}
                    style={{ left: sc.x(r.start), width: Math.max(6, sc.x(r.end) - sc.x(r.start)) }}
                    onClick={() => setSelection([r.objectId])}
                    data-tip={`${r.name}Action · images ${r.start} → ${r.end} · ${r.curves.length} courbe(s)`}
                  >
                    <span>{r.name}Action</span>
                    {r.keys.map((k) => (
                      <i key={k} style={{ left: sc.x(k) - sc.x(r.start) }} />
                    ))}
                  </div>
                </div>
              </div>
            ))
          }
        />
      )}
    </EditorShell>
  );
}
