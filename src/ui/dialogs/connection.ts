import { useEffect, useState, useSyncExternalStore } from 'react';
import { getApp } from '../../app/context';
import type { ConnectionInfo } from '../../net/api';

/** Hors application (tests, contexte absent) : état « hors session ». */
const IDLE: ConnectionInfo = {
  phase: 'idle',
  url: null,
  room: null,
  attempt: 0,
  nextRetryAt: null,
  latencyMs: null,
  pendingChanges: 0,
  error: null,
  errorKind: null,
  serverVersion: null,
  protocol: null,
  role: null,
  secured: null,
  inviteToken: null,
  transfer: null,
};

function subscribe(cb: () => void): () => void {
  try {
    return getApp().collab.onConnection(cb);
  } catch {
    return () => {};
  }
}

function read(): ConnectionInfo {
  try {
    return getApp().collab.getConnection?.() ?? IDLE;
  } catch {
    return IDLE;
  }
}

/** État détaillé de la connexion (latence, tentatives, modifications en attente…). */
export function useConnection(): ConnectionInfo {
  return useSyncExternalStore(subscribe, read, read);
}

/** Horloge rafraîchie chaque seconde tant que `active` (compte à rebours de reconnexion). */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function retryNow(): void {
  try {
    getApp().collab.retryNow();
  } catch {
    /* hors application */
  }
}

/** Texte court de l'état, ex. « Reconnexion (tentative 3, dans 4 s) ». */
export function connectionText(info: ConnectionInfo, now: number): string {
  const wait = info.nextRetryAt !== null ? Math.max(0, Math.ceil((info.nextRetryAt - now) / 1000)) : null;
  const retry = wait !== null ? `, nouvel essai dans ${wait} s` : ', tentative en cours';
  switch (info.phase) {
    case 'connecting':
      return info.transfer ? `Réception de la scène… ${transferPercent(info)} %` : 'Connexion…';
    case 'connected':
      return 'Connecté';
    case 'reconnecting':
      return `Reconnexion (tentative ${Math.max(1, info.attempt)}${retry})`;
    case 'offline':
      return `Hors ligne (tentative ${info.attempt}${retry})`;
    case 'error':
      return info.error ?? 'Erreur de connexion';
    default:
      return 'Hors ligne';
  }
}

export function transferPercent(info: ConnectionInfo): number {
  const t = info.transfer;
  return t && t.total > 0 ? Math.min(100, Math.round((t.done / t.total) * 100)) : 0;
}

export function pendingText(n: number): string {
  return n === 1 ? '1 modification en attente' : `${n} modifications en attente`;
}
