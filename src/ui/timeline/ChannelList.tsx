import { useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight, Eye, EyeOff, Lock, LockOpen, Volume2, VolumeX } from 'lucide-react';
import { getApp } from '../../app/context';
import { setKeySelection, store, useApp } from '../../app/store';
import { IconButton } from '../widgets/basic';
import { ROW_H, type AnimRow } from './model';

/**
 * Liste des canaux à gauche de la feuille d'exposition et de l'éditeur de courbes : objet →
 * propriétaire (objet, lumière, caméra, matériau) → courbe (X/Y/Z colorées). Clic : sélectionne
 * les clés de la ligne (Maj : ajoute) ; œil : masque la courbe dans l'éditeur de courbes (local) ;
 * haut-parleur / cadenas : courbe muette / verrouillée (partagé).
 */

export interface ChannelListProps {
  rows: AnimRow[];
  collapsed: ReadonlySet<string>;
  onToggle(id: string): void;
  /** Éditeur de courbes : bouton de visibilité. */
  graph: boolean;
  scrollY: number;
  onScrollY(y: number): void;
}

export function ChannelList({ rows, collapsed, onToggle, graph, scrollY, onScrollY }: ChannelListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const keySel = useApp((s) => s.keySelection);
  const hidden = useApp((s) => s.hiddenCurves);

  useEffect(() => {
    const el = listRef.current;
    if (el && Math.abs(el.scrollTop - scrollY) > 0.5) el.scrollTop = scrollY;
  }, [scrollY]);

  const selectRow = (r: AnimRow, extend: boolean) => {
    const ids = r.curves.flatMap((c) => (c.lock ? [] : c.keys.map((k) => k.id)));
    const s = store.getState();
    if (!extend) return setKeySelection(ids);
    const next = new Set(s.keySelection);
    const all = ids.length > 0 && ids.every((id) => next.has(id));
    for (const id of ids) all ? next.delete(id) : next.add(id);
    setKeySelection(next, s.handleSelection);
  };

  const toggleHidden = (r: AnimRow) => {
    const keys = r.curves.map((c) => c.key);
    const next = new Set(store.getState().hiddenCurves);
    const allHidden = keys.every((k) => next.has(k));
    for (const k of keys) allHidden ? next.delete(k) : next.add(k);
    store.setState({ hiddenCurves: next });
  };

  const setFlag = (r: AnimRow, flag: 'lock' | 'mute') => {
    const on = !r.curves.every((c) => c[flag]);
    getApp().ops.run('anim.curve_flags', { curves: r.curves.map((c) => c.key), [flag]: on });
  };

  return (
    <div className="cf-anim-channels">
      <div className="cf-anim-channels-head">Canaux</div>
      <div ref={listRef} className="cf-anim-channels-list" onScroll={(e) => onScrollY(e.currentTarget.scrollTop)}>
        {rows.map((r) => {
          const ids = r.curves.flatMap((c) => c.keys.map((k) => k.id));
          const selected = ids.length > 0 && ids.some((id) => keySel.has(id));
          const allHidden = r.curves.length > 0 && r.curves.every((c) => hidden.has(c.key));
          const locked = r.curves.length > 0 && r.curves.every((c) => c.lock);
          const muted = r.curves.length > 0 && r.curves.every((c) => c.mute);
          return (
            <div
              key={r.id}
              className={`cf-anim-channel is-${r.kind}${selected ? ' is-selected' : ''}${locked ? ' is-locked' : ''}`}
              style={{ height: ROW_H, paddingLeft: 4 + r.depth * 12 }}
              onClick={(e) => selectRow(r, e.shiftKey)}
              onDoubleClick={() => r.expandable && onToggle(r.id)}
            >
              {r.expandable ? (
                <button
                  type="button"
                  tabIndex={-1}
                  className="cf-anim-channel-toggle"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggle(r.id);
                  }}
                >
                  {collapsed.has(r.id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                </button>
              ) : (
                <span className="cf-anim-channel-toggle" />
              )}
              {r.color && <span className="cf-anim-channel-swatch" style={{ background: r.color }} />}
              <span className="cf-anim-channel-label">{r.label}</span>
              {r.kind !== 'summary' && (
                <>
                  {graph && (
                    <IconButton
                      icon={allHidden ? EyeOff : Eye}
                      size={12}
                      tip={allHidden ? 'Afficher la courbe' : 'Masquer la courbe'}
                      className={allHidden ? '' : 'is-on'}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleHidden(r);
                      }}
                    />
                  )}
                  <IconButton
                    icon={muted ? VolumeX : Volume2}
                    size={12}
                    tip={muted ? 'Réactiver (partagé)' : 'Rendre muet : la courbe n’agit plus (partagé)'}
                    className={muted ? '' : 'is-on'}
                    onClick={(e) => {
                      e.stopPropagation();
                      setFlag(r, 'mute');
                    }}
                  />
                  <IconButton
                    icon={locked ? Lock : LockOpen}
                    size={12}
                    tip={locked ? 'Déverrouiller (partagé)' : 'Verrouiller : clés non modifiables (partagé)'}
                    className={locked ? 'is-on' : ''}
                    onClick={(e) => {
                      e.stopPropagation();
                      setFlag(r, 'lock');
                    }}
                  />
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
