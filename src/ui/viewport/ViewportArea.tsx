import { useEffect, useRef } from 'react';
import { getApp } from '../../app/context';
import { stopFollowing } from '../lib/follow';
import { ErrorBoundary } from '../widgets/basic';
import { AdjustLastOp, ToastArea, ViewInfo } from './Overlays';
import { Sidebar } from './Sidebar';
import { Toolbar } from './Toolbar';
import { ViewportHeader } from './ViewportHeader';

/** Conteneur dans lequel le moteur insère son canvas (il en suit la taille). */
function ViewportCanvas() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const viewport = getApp().viewport;
    try {
      viewport.mount(el);
    } catch (err) {
      console.error('[ui] montage du viewport impossible', err);
      return;
    }
    return () => {
      try {
        viewport.unmount();
      } catch (err) {
        console.error('[ui] démontage du viewport', err);
      }
    };
  }, []);
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

/** Éditeur « Viewport 3D » : en-tête, canvas, barre d'outils, panneau latéral et superpositions. */
export function ViewportArea() {
  return (
    <div className="cf-area cf-viewport-area">
      <ErrorBoundary name="En-tête du viewport">
        <ViewportHeader />
      </ErrorBoundary>
      <div className="cf-viewport-body">
        <ViewportCanvas />
        <div className="cf-vp-overlays">
          <ErrorBoundary name="Superpositions">
            <ViewInfo />
            <Toolbar />
            <AdjustLastOp />
            <ToastArea />
          </ErrorBoundary>
          <ErrorBoundary name="Panneau latéral">
            <Sidebar />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
