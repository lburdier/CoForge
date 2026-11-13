import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Camera, Film, Plus, Trash2 } from 'lucide-react';
import { cameraShots } from '../../app/cameraMarkers';
import { getApp } from '../../app/context';
import { store, toast, useApp } from '../../app/store';
import { withOp } from '../lib/util';
import { useDocWhen } from '../properties/docHooks';
import { IconButton, Select, TextField } from '../widgets/basic';
import { EditorHeader, EditorShell } from './common';
import { TrackArea } from './TrackArea';

const NO_CAMERA = '__none__';
const SHOT_COLORS = ['#5a7bb5', '#b5785a', '#6aa86a', '#a86aa0', '#a8a050', '#5aa8a8'];

/**
 * Montage vidéo : la scène et ses plans. Un plan = un marqueur lié à une caméra ; pendant la
 * lecture (ou en déplaçant l'image courante), la caméra active change à chaque plan, comme les
 * marqueurs de caméra de Blender. Les marqueurs se déplacent à la souris.
 */
export function SequencerEditor() {
  const markers = useDocWhen((doc) => doc.listMarkers(), { scene: (e) => e.keys.some((k) => k.startsWith('m:')), objects: true });
  const scene = useDocWhen((doc) => ({ ...doc.getAnimSettings(), name: doc.getScene().name, activeCamera: doc.getScene().activeCamera }), { scene: true });
  const cameras = useDocWhen((doc) => doc.listObjects().filter((o) => o.type === 'camera'), { objects: (e) => e.added.length > 0 || e.removed.length > 0 || e.changed.some((c) => c.keys.includes('name')) });
  const activeId = useApp((s) => s.activeId);
  const [sel, setSel] = useState<string | null>(null);
  const [dragFrame, setDragFrame] = useState<{ id: string; frame: number } | null>(null);
  const drag = useRef<{ id: string; sx: number; f0: number; ppf: number } | null>(null);
  const marker = markers.find((m) => m.id === sel) ?? null;
  const camName = (id: string | null) => cameras.find((c) => c.id === id)?.name ?? '—';

  const addShot = () => {
    const doc = getApp().doc;
    const active = activeId ? doc.getObject(activeId) : null;
    const cam = active?.type === 'camera' ? active.id : (scene.activeCamera ?? cameras[0]?.id ?? null);
    if (!cam) {
      toast('Ajoutez d’abord une caméra à la scène (Maj+A › Caméra).', 'error');
      return;
    }
    const frame = Math.round(store.getState().frame);
    let id = '';
    withOp((d) => {
      id = d.addMarker({ frame, camera: cam, name: `${camName(cam)} @ ${frame}` });
    });
    setSel(id);
  };
  const remove = () => {
    if (!marker) return;
    withOp((d) => d.removeMarker(marker.id));
    setSel(null);
  };

  const onMarkerDown = (e: ReactPointerEvent, id: string, frame: number, ppf: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setSel(id);
    drag.current = { id, sx: e.clientX, f0: frame, ppf };
  };
  const onMarkerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setDragFrame({ id: d.id, frame: Math.round(d.f0 + (e.clientX - d.sx) / d.ppf) });
  };
  const onMarkerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && dragFrame && dragFrame.frame !== d.f0) withOp((doc) => doc.updateMarker(d.id, { frame: dragFrame.frame }));
    setDragFrame(null);
  };

  const shown = markers.map((m) => (dragFrame && m.id === dragFrame.id ? { ...m, frame: dragFrame.frame } : m));
  const shots = cameraShots(shown, scene.frameStart, scene.frameEnd);

  return (
    <EditorShell className="cf-seq">
      <EditorHeader title="Montage vidéo" icon={Film}>
        <button type="button" className="cf-btn" onClick={addShot} data-tip="Nouveau plan à l’image courante, avec la caméra active (ou la caméra sélectionnée)">
          <Plus size={12} /> Ajouter un plan
        </button>
        {marker && (
          <>
            <div className="cf-seq-name">
              <TextField value={marker.name} maxLength={63} onCommit={(v) => v.trim() && withOp((d) => d.updateMarker(marker.id, { name: v.trim() }))} />
            </div>
            <Select
              value={marker.camera ?? NO_CAMERA}
              options={[{ value: NO_CAMERA, label: '(sans caméra)' }, ...cameras.map((c) => ({ value: c.id, label: c.name }))]}
              onChange={(v) => withOp((d) => d.updateMarker(marker.id, { camera: v === NO_CAMERA ? null : v }))}
              tip="Caméra du plan"
            />
            <IconButton icon={Trash2} tip="Supprimer le marqueur" onClick={remove} />
          </>
        )}
        <div className="cf-spacer" />
        <span className="cf-ed-dim">
          <Camera size={12} /> {camName(scene.activeCamera)}
        </span>
      </EditorHeader>
      <TrackArea
        labelW={120}
        rows={(sc) => (
          <>
            <div className="cf-track">
              <div className="cf-track-label">
                <span className="cf-track-name">Scène</span>
              </div>
              <div className="cf-track-lane">
                <div className="cf-strip is-scene" style={{ left: sc.x(scene.frameStart), width: Math.max(6, sc.x(scene.frameEnd + 1) - sc.x(scene.frameStart)) }}>
                  <span>
                    {scene.name} · {scene.frameStart} → {scene.frameEnd} · {scene.fps} i/s
                  </span>
                </div>
              </div>
            </div>
            <div className="cf-track">
              <div className="cf-track-label">
                <span className="cf-track-name">Caméras</span>
              </div>
              <div className="cf-track-lane">
                {shots.length === 0 && <span className="cf-track-hint">Aucun plan : « Ajouter un plan » lie la caméra active à l’image courante.</span>}
                {shots.map((s, i) => (
                  <div
                    key={s.marker.id}
                    className={`cf-strip is-shot${s.marker.id === sel ? ' is-selected' : ''}`}
                    style={{ left: sc.x(s.start), width: Math.max(6, sc.x(s.end) - sc.x(s.start)), background: SHOT_COLORS[i % SHOT_COLORS.length] }}
                    onClick={() => setSel(s.marker.id)}
                  >
                    <span>{camName(s.marker.camera)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="cf-track">
              <div className="cf-track-label">
                <span className="cf-track-name">Marqueurs</span>
              </div>
              <div className="cf-track-lane" onPointerMove={onMarkerMove} onPointerUp={onMarkerUp}>
                {shown.map((m) => (
                  <div
                    key={m.id}
                    className={`cf-marker${m.id === sel ? ' is-selected' : ''}`}
                    style={{ left: sc.x(m.frame) }}
                    onPointerDown={(e) => onMarkerDown(e, m.id, m.frame, sc.pxPerFrame)}
                    data-tip={`${m.name} · image ${m.frame}${m.camera ? ` · ${camName(m.camera)}` : ''}`}
                  >
                    <i />
                    <span>{m.name}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      />
    </EditorShell>
  );
}
