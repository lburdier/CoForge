import { useSyncExternalStore } from 'react';
import type { AppContext } from '../../app/context';

/**
 * Journal de l'éditeur Info : opérateurs exécutés (sous la forme d'une commande rejouable dans la
 * console : `run object.add {"type":"cube"}`), messages et erreurs. Local, jamais partagé.
 */

export type InfoKind = 'op' | 'info' | 'error' | 'console' | 'team';

export interface InfoEntry {
  id: number;
  time: number;
  kind: InfoKind;
  text: string;
}

const MAX_ENTRIES = 500;

let entries: InfoEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function logInfo(kind: InfoKind, text: string): void {
  const t = String(text ?? '').slice(0, 2000);
  if (!t) return;
  entries = [...entries, { id: nextId++, time: Date.now(), kind, text: t }];
  if (entries.length > MAX_ENTRIES) entries = entries.slice(entries.length - MAX_ENTRIES);
  emit();
}

export function clearInfo(): void {
  entries = [];
  emit();
}

export function infoEntries(): InfoEntry[] {
  return entries;
}

export function useInfoLog(): InfoEntry[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => entries,
  );
}

/** Commande console équivalente à un appel d'opérateur. */
export function opCommand(id: string, args: Record<string, unknown>): string {
  let json = '';
  try {
    const clean = Object.fromEntries(Object.entries(args ?? {}).filter(([, v]) => v !== undefined && typeof v !== 'function' && !(v instanceof Event)));
    json = Object.keys(clean).length ? ` ${JSON.stringify(clean)}` : '';
  } catch {
    json = '';
  }
  return `run ${id}${json.length > 400 ? '' : json}`;
}

let installed = false;

/** Branche le journal sur le registre d'opérateurs et les messages de l'application (une fois). */
export function installInfoLog(app: AppContext): void {
  if (installed) return;
  installed = true;
  app.ops.onReport((def, args) => logInfo('op', opCommand(def.id, args)));
  let last = app.store.getState().toast;
  app.store.subscribe((s) => {
    if (s.toast && s.toast !== last) logInfo(s.toast.kind === 'error' ? 'error' : 'info', s.toast.text);
    last = s.toast;
  });
}
