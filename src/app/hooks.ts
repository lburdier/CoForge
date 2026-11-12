import { useEffect, useMemo, useState } from 'react';
import type { DocEvents, SceneDoc } from '../core/doc/SceneDoc';
import { getApp } from './context';

/**
 * Hook React : lit une valeur dérivée du document et se met à jour quand le
 * document change (ou est remplacé). Les notifications sont regroupées par
 * image (requestAnimationFrame) pour rester fluide pendant les opérations
 * modales qui écrivent à chaque mouvement de souris.
 *
 *   const obj = useDoc((doc) => doc.getObject(id), ['objects'], [id]);
 *
 * @param read    fonction de lecture (doit être rapide ; les getters de SceneDoc sont en cache)
 * @param events  événements du document qui déclenchent une relecture (par défaut : tout changement)
 * @param deps    dépendances supplémentaires de `read`
 */
export function useDoc<T>(read: (doc: SceneDoc) => T, events: (keyof DocEvents)[] = ['change'], deps: unknown[] = []): T {
  const [version, setVersion] = useState(0);
  const eventsKey = events.join(',');

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
      const unsubs = events.map((ev) => doc.on(ev, bump));
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
