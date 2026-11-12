import { useEffect } from 'react';
import { getApp } from '../../app/context';
import { store, toast, useApp } from '../../app/store';
import type { PresenceCamera } from '../../net/api';

/**
 * « Suivre un utilisateur » : tant que `followClientId` est défini, la caméra
 * du viewport reprend celle de ce pair à chaque mise à jour de sa présence.
 * Le suivi s'arrête si le pair quitte la session ou si l'on navigue soi-même
 * (voir `stopFollowing`, appelé par le viewport sur clic milieu / molette).
 */

function sameCamera(a: PresenceCamera | null, b: PresenceCamera | null): boolean {
  if (!a || !b) return a === b;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(a.pos[i] - b.pos[i]) > 1e-5 || Math.abs(a.target[i] - b.target[i]) > 1e-5) return false;
  }
  return a.fov === b.fov && a.ortho === b.ortho;
}

export function useFollowCamera(): void {
  const follow = useApp((s) => s.followClientId);

  useEffect(() => {
    if (follow === null) return;
    const app = getApp();
    let last: PresenceCamera | null = null;
    let first = true;

    const apply = () => {
      const peer = app.collab.getPeers().find((p) => p.clientId === follow);
      if (!peer) {
        store.setState({ followClientId: null });
        toast("L'utilisateur suivi a quitté la session");
        return;
      }
      const cam = peer.state.camera;
      if (!cam || sameCamera(cam, last)) return;
      last = cam;
      try {
        // Transition douce au premier cadrage, puis suivi direct.
        app.viewport.setViewState(cam, first);
      } catch (err) {
        console.error('[ui] suivi de caméra', err);
      }
      first = false;
    };

    apply();
    const off = app.collab.onPeers(apply);
    return off;
  }, [follow]);
}

/** Arrête de suivre un utilisateur (navigation manuelle). */
export function stopFollowing(): void {
  if (store.getState().followClientId === null) return;
  store.setState({ followClientId: null });
  toast('Suivi interrompu');
}
