import { useEffect, useState } from 'react';
import { store, useApp, type AppState } from '../../app/store';

/** Durée d'affichage d'un message transitoire (ms). Les erreurs restent un peu plus longtemps. */
export const TOAST_MS = 4000;
export const TOAST_ERROR_MS = 7000;

export type ToastValue = NonNullable<AppState['toast']>;

/**
 * Message transitoire courant, ou null une fois son délai écoulé.
 * Le store garde le dernier message : c'est l'interface qui le fait disparaître.
 */
export function useActiveToast(): ToastValue | null {
  const toast = useApp((s) => s.toast);
  const [, setTick] = useState(0);
  const ttl = toast ? (toast.kind === 'error' ? TOAST_ERROR_MS : TOAST_MS) : 0;
  const remaining = toast ? toast.time + ttl - Date.now() : 0;

  useEffect(() => {
    if (!toast || remaining <= 0) return;
    const t = setTimeout(() => setTick((n) => n + 1), remaining + 20);
    return () => clearTimeout(t);
  }, [toast, remaining]);

  return toast && remaining > 0 ? toast : null;
}

/** Fait disparaître le message courant. */
export function dismissToast(): void {
  if (store.getState().toast) store.setState({ toast: null });
}
