import { useEffect, useRef, useState } from 'react';
import { MapPin, MessageSquare, X } from 'lucide-react';
import { getApp } from '../../app/context';
import { useApp } from '../../app/store';
import type { NoteData, Vec3 } from '../../core/doc/schema';
import { worldMatrix } from '../../core/doc/transforms';
import { useDocWhen } from '../properties/docHooks';
import { acceptSummon, dismissSummon, PING_MS, useTeam } from '../lib/teamwork';
import { Vector3 } from 'three';

/** Position monde d'une note : origine de l'objet + décalage, ou point fixe. */
export function notePosition(n: NoteData): Vec3 {
  if (!n.objectId) return n.pos;
  try {
    const m = worldMatrix(getApp().doc, n.objectId);
    const o = new Vector3().setFromMatrixPosition(m);
    return [o.x + n.pos[0], o.y + n.pos[1], o.z + n.pos[2]];
  } catch {
    return n.pos;
  }
}

interface Projected {
  key: string;
  x: number;
  y: number;
}

/**
 * Superposition « équipe » du viewport actif : repères signalés (Q), épingles des notes ouvertes,
 * bandeau d'invitation à rejoindre la vue d'un collaborateur. Les positions écran sont recalculées
 * à chaque image tant qu'il y a quelque chose à montrer (la caméra peut bouger).
 */
export function TeamOverlay() {
  const team = useTeam();
  const showNotes = useApp((s) => s.overlays.presence);
  const notes = useDocWhen((doc) => doc.listNotes().filter((n) => !n.done), { scene: (e) => e.keys.some((k) => k.startsWith('n:')), objects: true });
  const [proj, setProj] = useState<Map<string, Projected>>(new Map());
  const sig = useRef('');

  const items: { key: string; pos: Vec3 }[] = [
    ...team.pings.map((p) => ({ key: `ping:${p.key}:${p.time}`, pos: p.point })),
    ...(showNotes ? notes.map((n) => ({ key: `note:${n.id}`, pos: notePosition(n) })) : []),
  ];
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const active = items.length > 0;

  useEffect(() => {
    if (!active) {
      setProj(new Map());
      sig.current = '';
      return;
    }
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const vp = getApp().viewport;
      const next = new Map<string, Projected>();
      let s = '';
      for (const it of itemsRef.current) {
        const p = vp.worldToScreen(it.pos);
        if (!p) continue;
        next.set(it.key, { key: it.key, x: Math.round(p.x), y: Math.round(p.y) });
        s += `${it.key}:${Math.round(p.x)},${Math.round(p.y)};`;
      }
      if (s !== sig.current) {
        sig.current = s;
        setProj(next);
      }
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [active]);

  const now = Date.now();
  return (
    <>
      {team.pings.map((p) => {
        const at = proj.get(`ping:${p.key}:${p.time}`);
        if (!at) return null;
        return (
          <div key={`${p.key}:${p.time}`} className="cf-team-ping" style={{ left: at.x, top: at.y, color: p.color, animationDuration: `${PING_MS}ms` }}>
            <span className="cf-team-ping-ring" style={{ borderColor: p.color }} />
            <MapPin size={18} />
            <span className="cf-team-ping-name" style={{ background: p.color }}>
              {p.name}
            </span>
          </div>
        );
      })}
      {showNotes &&
        notes.map((n) => {
          const at = proj.get(`note:${n.id}`);
          if (!at) return null;
          return (
            <div key={n.id} className="cf-team-note" style={{ left: at.x, top: at.y }} data-tip={`${n.author} : ${n.text}`}>
              <MessageSquare size={14} style={{ color: n.color }} />
            </div>
          );
        })}
      {team.summon && now - team.summon.time < 60_000 && (
        <div className="cf-team-summon" style={{ borderColor: team.summon.color }}>
          <span>
            <b style={{ color: team.summon.color }}>{team.summon.name}</b> vous invite à rejoindre sa vue.
          </span>
          <button type="button" className="cf-btn is-accent is-small" onClick={() => acceptSummon(getApp())}>
            Y aller
          </button>
          <button type="button" className="cf-btn is-small" onClick={dismissSummon} aria-label="Ignorer">
            <X size={12} />
          </button>
        </div>
      )}
    </>
  );
}
