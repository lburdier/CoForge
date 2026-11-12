import { useSyncExternalStore } from 'react';
import { loadStored, saveStored } from './util';

/** Horodatage du dernier message de discussion lu (partagé entre le badge et le panneau). */
let lastRead = loadStored<number>('chat.lastRead', 0);
const listeners = new Set<() => void>();

export function markChatRead(time: number = Date.now()): void {
  if (time <= lastRead) return;
  lastRead = time;
  saveStored('chat.lastRead', lastRead);
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useChatLastRead(): number {
  return useSyncExternalStore(subscribe, () => lastRead);
}
