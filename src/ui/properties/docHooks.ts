import { useEffect, useMemo, useRef, useState } from 'react';
import { getApp } from '../../app/context';
import { useApp } from '../../app/store';
import type { DocEvents, SceneDoc } from '../../core/doc/SceneDoc';
import type { ObjectData } from '../../core/doc/schema';

/**
 * Filtres d'événements du document : `true` = toute occurrence de l'événement
 * déclenche une relecture ; une fonction = relecture seulement si elle renvoie true.
 */
export type DocFilters = { [K in keyof DocEvents]?: true | ((e: DocEvents[K]) => boolean) };

/**
 * Comme `useDoc`, mais chaque événement peut être filtré : un panneau qui
 * affiche UN objet ne se relit pas quand un autre objet bouge. Les relectures
 * sont regroupées par image (requestAnimationFrame). Le remplacement du
 * document (Nouveau, Ouvrir, Rejoindre) provoque toujours une relecture.
 */
export function useDocWhen<T>(read: (doc: SceneDoc) => T, filters: DocFilters, deps: unknown[] = []): T {
  const [version, setVersion] = useState(0);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const keys = (Object.keys(filters) as (keyof DocEvents)[]).sort();
  const eventsKey = keys.join(',');

  useEffect(() => {
    let raf = 0;
    const bump = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setVersion((v) => v + 1);
      });
    };
    const off = getApp().onDocChange((doc) => {
      bump();
      const unsubs = keys.map((ev) =>
        doc.on(ev, (payload: any) => {
          const f = filtersRef.current[ev] as true | ((e: any) => boolean) | undefined;
          if (!f) return;
          if (f === true) bump();
          else {
            try {
              if (f(payload)) bump();
            } catch (err) {
              console.error('[ui-panels] filtre d’événement en erreur', err);
              bump();
            }
          }
        }),
      );
      return () => unsubs.forEach((u) => u());
    });
    return () => {
      off();
      if (raf) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventsKey]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => read(getApp().doc), [version, ...deps]);
}

/** L'événement `objects` concerne-t-il l'objet `id` ? */
export function objectEventTouches(e: DocEvents['objects'], id: string | null | undefined): boolean {
  if (!id) return false;
  return e.added.includes(id) || e.removed.includes(id) || e.changed.some((c) => c.id === id);
}

/**
 * Instantané d'un objet, relu uniquement quand CET objet change (ou quand une
 * collection / un matériau disparaît, ce qui modifie ses références normalisées).
 * Renvoie null si l'objet n'existe pas (ou plus).
 */
export function useObject(id: string | null): ObjectData | null {
  return useDocWhen(
    (doc) => (id ? doc.getObject(id) : null),
    {
      objects: (e) => objectEventTouches(e, id),
      data: (e) => (e.table === 'collections' || e.table === 'materials') && (e.removed.length > 0 || e.added.length > 0),
    },
    [id],
  );
}

/** Objet actif du store local, ou null s'il n'existe pas (supprimé à distance, par exemple). */
export function useActiveObject(): ObjectData | null {
  const activeId = useApp((s) => s.activeId);
  return useObject(activeId);
}
