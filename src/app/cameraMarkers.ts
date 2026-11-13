import type { MarkerData } from '../core/doc/schema';
import type { AppContext } from './context';

/**
 * Marqueurs liés aux caméras (montage vidéo, frise) : la caméra active suit l'image courante,
 * comme dans Blender. Avant le premier marqueur, c'est la caméra du premier qui sert.
 */
export function cameraForFrame(markers: readonly MarkerData[], frame: number): string | null {
  const bound = markers.filter((m) => m.camera).sort((a, b) => a.frame - b.frame);
  if (bound.length === 0) return null;
  let cam = bound[0].camera;
  for (const m of bound) {
    if (m.frame <= frame + 1e-6) cam = m.camera;
    else break;
  }
  return cam;
}

/** Plans du montage : intervalles [début, fin[ de chaque caméra sur la plage d'animation. */
export function cameraShots(markers: readonly MarkerData[], frameStart: number, frameEnd: number): { marker: MarkerData; start: number; end: number }[] {
  const bound = markers.filter((m) => m.camera).sort((a, b) => a.frame - b.frame);
  return bound.map((m, i) => ({ marker: m, start: m.frame, end: i + 1 < bound.length ? bound[i + 1].frame : Math.max(frameEnd + 1, m.frame + 1) })).filter((s) => s.end > s.start && s.end > frameStart - 1);
}

let installed = false;

export function installCameraMarkers(app: AppContext): void {
  if (installed) return;
  installed = true;
  app.store.subscribe((s, p) => {
    if (s.frame === p.frame) return;
    const doc = app.doc;
    const cam = cameraForFrame(doc.listMarkers(), s.frame);
    if (cam) doc.setActiveCameraByMarker(cam);
  });
}
