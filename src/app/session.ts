import * as Y from 'yjs';
import { SceneDoc } from '../core/doc/SceneDoc';
import { getApp } from './context';
import { platform } from './platform';
import { patchSession, store, toast } from './store';

/**
 * Cycle de vie d'une session collaborative.
 *
 * Héberger : l'application démarre le serveur embarqué puis s'y connecte avec
 * SA scène courante, c'est elle qui devient la scène de la session.
 *
 * Rejoindre : on part d'un document vide qui reçoit la scène du serveur, puis
 * il remplace la scène locale. Cas particulier : si la room est vide (serveur
 * dédié tout neuf), la scène locale y est publiée, le premier arrivé apporte
 * sa scène.
 */

function normalizeUrl(url: string): string {
  let u = url.trim();
  if (!/^wss?:\/\//i.test(u)) u = `ws://${u}`;
  return u.replace(/\/+$/, '');
}

export async function hostSession(opts: { port: number; room: string; password?: string }): Promise<void> {
  const app = getApp();
  if (store.getState().session.status !== 'offline') await leaveSession();
  const password = opts.password?.trim() || undefined;
  const info = await platform.hostStart({ port: opts.port, password });
  try {
    await app.collab.connect(app.doc, { url: `ws://localhost:${info.port}`, room: opts.room.trim(), password });
  } catch (err) {
    await platform.hostStop().catch(() => {});
    throw err;
  }
  patchSession({ hosting: true, shareAddresses: info.addresses });
  toast(`Session « ${opts.room.trim()} » hébergée sur le port ${info.port}`);
}

export async function joinSession(opts: { url: string; room: string; password?: string }): Promise<void> {
  const app = getApp();
  if (store.getState().session.status !== 'offline') await leaveSession();
  const doc = SceneDoc.createEmpty();
  try {
    await app.collab.connect(doc, { url: normalizeUrl(opts.url), room: opts.room.trim(), password: opts.password?.trim() || undefined });
  } catch (err) {
    doc.destroy();
    throw err;
  }
  let published = false;
  if (doc.objectIds().length === 0 && doc.meshIds().length === 0) {
    // Room vide : on y publie la scène locale (fusion CRDT dans le document partagé).
    Y.applyUpdate(doc.ydoc, app.doc.encode(), doc.localOrigin);
    published = true;
  }
  doc.clearHistory();
  app.setDoc(doc, { filePath: null });
  toast(published ? `Session « ${opts.room} » créée avec votre scène` : `Session « ${opts.room} » rejointe`);
}

/** Quitte la session (et arrête le serveur si on l'hébergeait). La scène reste ouverte en local. */
export async function leaveSession(): Promise<void> {
  const app = getApp();
  const { hosting } = store.getState().session;
  app.collab.disconnect();
  if (hosting) await platform.hostStop().catch(() => {});
  patchSession({ status: 'offline', hosting: false, shareAddresses: [], url: null, room: null, peers: [], error: null });
  store.setState({ followClientId: null });
}
