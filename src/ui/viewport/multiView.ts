import { useSyncExternalStore } from 'react';
import { getApp } from '../../app/context';
import type { PresenceCamera } from '../../net/api';
import type { ViewMirror } from '../../engine/Viewport';

/**
 * Plusieurs zones « Viewport 3D » (comme dans Blender). Le moteur n'a qu'un canvas interactif :
 * il est monté dans la zone ACTIVE, celle que le pointeur survole ; les autres zones affichent une
 * vue miroir rendue par le même moteur, chacune avec sa caméra. Changer de zone échange les caméras :
 * chaque zone garde son point de vue.
 */

const areas: string[] = [];
let active: string | null = null;
const views = new Map<string, PresenceCamera>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

interface MirrorHost {
  addMirror?(id: string, m: ViewMirror): () => void;
  getViewState(): PresenceCamera;
  setViewState(v: PresenceCamera, animate?: boolean): void;
}
const engine = (): MirrorHost => getApp().viewport as unknown as MirrorHost;

/** Zone viewport active (qui détient le canvas interactif). */
export function useActiveViewArea(): string | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => active,
  );
}

export function activeViewArea(): string | null {
  return active;
}

/** Une zone viewport apparaît : la première devient active. */
export function registerViewArea(id: string): void {
  if (!areas.includes(id)) areas.push(id);
  if (!active) {
    active = id;
    emit();
  }
}

/** Une zone viewport disparaît : si c'était l'active, une autre prend le relais avec sa caméra. */
export function unregisterViewArea(id: string): void {
  const i = areas.indexOf(id);
  if (i >= 0) areas.splice(i, 1);
  if (active === id) {
    active = areas[0] ?? null;
    emit();
  }
  views.delete(id);
}

/**
 * Rend la zone `id` active : la caméra de la zone quittée est mémorisée. Le composant de la zone
 * montera le moteur puis appellera `restoreView`.
 */
export function activateViewArea(id: string): void {
  if (active === id || !areas.includes(id)) return;
  if (active) {
    try {
      views.set(active, engine().getViewState());
    } catch {
      /* moteur indisponible */
    }
  }
  active = id;
  emit();
}

/** Après montage du moteur dans la zone : reprend sa caméra mémorisée (sinon garde la vue courante). */
export function restoreView(id: string): void {
  const v = views.get(id);
  if (!v) return;
  try {
    engine().setViewState(v, false);
  } catch {
    /* ignore */
  }
}

/** Caméra mémorisée d'une zone non active (null : reprend la vue active). */
export function viewOf(id: string): PresenceCamera | null {
  return views.get(id) ?? null;
}

/** Nouvelle zone : part de la vue courante (comme une division dans Blender). */
export function seedView(id: string): void {
  if (views.has(id)) return;
  try {
    views.set(id, engine().getViewState());
  } catch {
    /* ignore */
  }
}

export function addMirror(id: string, canvas: HTMLCanvasElement): () => void {
  const e = engine();
  if (!e.addMirror) return () => {};
  return e.addMirror(id, { canvas, getView: () => viewOf(id) });
}
