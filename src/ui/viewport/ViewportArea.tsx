import { useEffect, useRef } from 'react';
import { getApp } from '../../app/context';
import { stopFollowing } from '../lib/follow';
import { activateViewArea, addMirror, registerViewArea, restoreView, seedView, unregisterViewArea, useActiveViewArea } from './multiView';
import { ErrorBoundary } from '../widgets/basic';
import { AdjustLastOp, ToastArea, ViewInfo } from './Overlays';
import { Sidebar } from './Sidebar';
import { Toolbar } from './Toolbar';
import { TeamOverlay } from './TeamOverlay';
import { ViewportHeader } from './ViewportHeader';

/** Conteneur dans lequel le moteur insère son canvas (il en suit la taille). */
function ViewportCanvas({ areaId }: { areaId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const viewport = getApp().viewport;
    try {
      viewport.mount(el);
      restoreView(areaId);
    } catch (err) {
      console.error('[ui] montage du viewport impossible', err);
      return;
    }
    return () => {
      try {
        // Seulement si le canvas est encore ici (une autre zone a pu le reprendre entre-temps).
        if (viewport.dom.parentElement === el) viewport.unmount();
      } catch (err) {
        console.error('[ui] démontage du viewport', err);
      }
    };
  }, [areaId]);
  // Naviguer soi-même (clic milieu, molette) interrompt le suivi d'un autre utilisateur.
  return (
    <div
      ref={ref}
      className="cf-viewport-canvas"
      onPointerDownCapture={(e) => {
        if (e.button === 1) stopFollowing();
      }}
      onWheelCapture={stopFollowing}
    />
  );
}

/**
 * Zone viewport non active : vue miroir (rendue par le moteur avec la caméra de la zone). Le
 * survol la rend active, sauf pendant un geste (bouton enfoncé) ou une opération modale.
 */
function MirrorCanvas({ areaId }: { areaId: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    seedView(areaId);
    const off = addMirror(areaId, c);
    const ro = new ResizeObserver(() => (getApp().viewport as unknown as { markMirrors?(): void }).markMirrors?.());
    ro.observe(c);
    return () => {
      ro.disconnect();
      off();
    };
  }, [areaId]);
  const take = (e: { buttons: number }) => {
    if (e.buttons !== 0 || getApp().ops.modalActive) return;
    activateViewArea(areaId);
  };
  return (
    <div className="cf-viewport-canvas" onPointerEnter={take} onPointerMove={take} onPointerDown={() => activateViewArea(areaId)}>
      <canvas ref={ref} className="cf-viewport-mirror" />
    </div>
  );
}

function ViewportSurface({ areaId }: { areaId: string }) {
  const active = useActiveViewArea();
  useEffect(() => {
    registerViewArea(areaId);
    return () => unregisterViewArea(areaId);
  }, [areaId]);
  return active === areaId ? <ViewportCanvas areaId={areaId} /> : <MirrorCanvas areaId={areaId} />;
}

/** Éditeur « Viewport 3D » : en-tête, canvas, barre d'outils, panneau latéral et superpositions. */
export function ViewportArea({ areaId = 'main' }: { areaId?: string }) {
  const active = useActiveViewArea();
  const isActive = active === areaId;
  return (
    <div className={`cf-area cf-viewport-area${isActive ? ' is-active-view' : ' is-mirror-view'}`}>
      <ErrorBoundary name="En-tête du viewport">
        <ViewportHeader />
      </ErrorBoundary>
      <div className="cf-viewport-body">
        <ViewportSurface areaId={areaId} />
        <div className="cf-vp-overlays">
          <ErrorBoundary name="Superpositions">
            <ViewInfo />
            <Toolbar />
            {isActive && <AdjustLastOp />}
            {isActive && <ToastArea />}
            {isActive && <TeamOverlay />}
          </ErrorBoundary>
          <ErrorBoundary name="Panneau latéral">
            <Sidebar />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
