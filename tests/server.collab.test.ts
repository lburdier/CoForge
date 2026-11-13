import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import { initialState, store } from '../src/app/store';
import { SceneDoc } from '../src/core/doc/SceneDoc';
import type { ICollab, Peer } from '../src/net/api';
import { createCollab, normalizeServerUrl } from '../src/net/index';
import { CollabServer } from '../server/CollabServer';

/**
 * Client de collaboration (src/net) contre un vrai serveur. Node fournit un
 * WebSocket global, comme le renderer.
 */

const servers: CollabServer[] = [];
const collabs: ICollab[] = [];
const docs: SceneDoc[] = [];

async function startServer(password?: string): Promise<number> {
  const server = new CollabServer();
  const { port } = await server.start({ port: 0, host: '127.0.0.1', password });
  servers.push(server);
  return port;
}

function makeCollab(): ICollab {
  // Seul `store` est utilisé par le client réseau.
  const collab = createCollab({ store } as unknown as AppContext);
  collabs.push(collab);
  return collab;
}

function makeDoc(): SceneDoc {
  const doc = SceneDoc.createEmpty();
  docs.push(doc);
  return doc;
}

async function waitFor(cond: () => boolean, what: string, timeout = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error(`Délai dépassé : ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

afterEach(async () => {
  for (const c of collabs.splice(0)) c.disconnect();
  for (const d of docs.splice(0)) d.destroy();
  await Promise.all(servers.splice(0).map((s) => s.stop()));
  store.setState(initialState());
});

describe('client de collaboration', () => {
  it('normalise les adresses', () => {
    expect(normalizeServerUrl('192.168.1.20:4455')).toBe('ws://192.168.1.20:4455');
    expect(normalizeServerUrl(' ws://localhost:4455/ ')).toBe('ws://localhost:4455');
    expect(normalizeServerUrl('https://exemple.fr')).toBe('wss://exemple.fr');
    expect(normalizeServerUrl('')).toBeNull();
    expect(normalizeServerUrl('ftp://exemple.fr')).toBeNull();
  });

  it('se connecte, synchronise, suit la présence et se déconnecte', async () => {
    const port = await startServer('secret');
    store.setState({ session: { ...store.getState().session, hosting: true, shareAddresses: ['ws://exemple:1'] } });
    const a = makeCollab();
    const b = makeCollab();
    const docA = makeDoc();
    const docB = makeDoc();

    expect(a.connected).toBe(false);
    expect(a.clientId).toBeNull();
    const pending = a.connect(docA, { url: `ws://127.0.0.1:${port}`, room: 'atelier', password: 'secret' });
    expect(store.getState().session.status).toBe('connecting');
    await pending;
    expect(store.getState().session).toMatchObject({ status: 'connected', url: `ws://127.0.0.1:${port}`, room: 'atelier', error: null, peers: [] });
    expect(a.connected).toBe(true);
    expect(a.clientId).toBe(docA.ydoc.clientID);

    await b.connect(docB, { url: `127.0.0.1:${port}`, room: 'atelier', password: 'secret' });
    const id = docA.addObject({ type: 'empty', name: 'Repère' });
    await waitFor(() => docB.hasObject(id), 'document synchronisé');

    // Présence : chacun voit l'autre, jamais soi-même, avec l'état complet par défaut.
    await waitFor(() => a.getPeers().length === 1 && b.getPeers().length === 1, 'pairs visibles');
    const user = store.getState().user;
    expect(a.getPeers()[0].clientId).toBe(docB.ydoc.clientID);
    expect(a.getPeers()[0].state).toEqual({ user, camera: null, pointer: null, selection: [], activeId: null, mode: 'object', editVerts: [], playback: { frame: 1, playing: 0 } });
    // (les deux clients du test partagent le même store : la liste est celle du dernier à l'avoir écrite)
    const listed = store.getState().session.peers;
    expect(listed.length).toBe(1);
    expect(listed[0]).toMatchObject({ userId: user.id, name: user.name, color: user.color });
    expect([docA.ydoc.clientID, docB.ydoc.clientID]).toContain(listed[0].clientId);

    // Rafale de patchs : fusionnés, envoi limité, et le store n'est pas touché par un mouvement de caméra.
    const seen: Peer[][] = [];
    const off = a.onPeers((peers) => seen.push(peers));
    const peersRef = store.getState().session.peers;
    for (let i = 0; i < 50; i++) {
      b.setPresence({ camera: { pos: [i, 0, 0], target: [0, 0, 0], fov: 50, ortho: false, aspect: 1.5 } });
    }
    b.setPresence({ selection: ['obj1'], activeId: 'obj1', mode: 'edit', editVerts: Array.from({ length: 500 }, (_v, i) => `v${i}`) });
    await waitFor(() => a.getPeers()[0]?.state.camera?.pos[0] === 49, 'dernière caméra reçue');
    const state = a.getPeers()[0].state;
    expect(state.selection).toEqual(['obj1']);
    expect(state.mode).toBe('edit');
    expect(state.editVerts.length).toBe(400);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThanOrEqual(3); // 51 patchs regroupés en très peu d'envois
    expect(store.getState().session.peers).toBe(peersRef);
    off();

    // Déconnexion : pairs vidés, session hors ligne, hébergement intact.
    b.disconnect();
    await waitFor(() => a.getPeers().length === 0, 'départ de B vu par A');
    a.disconnect();
    expect(a.connected).toBe(false);
    expect(a.clientId).toBeNull();
    expect(store.getState().session).toEqual({ status: 'offline', hosting: true, url: null, room: null, shareAddresses: ['ws://exemple:1'], error: null, peers: [] });
    expect(docA.hasObject(id)).toBe(true); // le document local reste intact
  });

  it('rejette un mot de passe refusé', async () => {
    const port = await startServer('secret');
    const a = makeCollab();
    const doc = makeDoc();
    await expect(a.connect(doc, { url: `ws://127.0.0.1:${port}`, room: 'atelier', password: 'faux' })).rejects.toThrow('Mot de passe refusé');
    expect(store.getState().session).toMatchObject({ status: 'offline', error: 'Mot de passe refusé', peers: [] });
    expect(a.connected).toBe(false);
    expect(a.clientId).toBeNull();
    // Une nouvelle tentative correcte réussit.
    await a.connect(doc, { url: `ws://127.0.0.1:${port}`, room: 'atelier', password: 'secret' });
    expect(store.getState().session.status).toBe('connected');
  });

  it("rejette quand le serveur est injoignable", async () => {
    const port = await startServer();
    await servers.pop()!.stop(); // port désormais fermé
    const a = makeCollab();
    const url = `ws://127.0.0.1:${port}`;
    await expect(a.connect(makeDoc(), { url, room: 'atelier' })).rejects.toThrow(`Serveur injoignable à l'adresse ${url}`);
    expect(store.getState().session).toMatchObject({ status: 'offline', error: `Serveur injoignable à l'adresse ${url}` });
  }, 15000);

  it('passe en reconnexion puis se rétablit quand le serveur revient', async () => {
    const server = new CollabServer();
    const { port } = await server.start({ port: 0, host: '127.0.0.1' });
    servers.push(server);
    const a = makeCollab();
    const doc = makeDoc();
    await a.connect(doc, { url: `ws://127.0.0.1:${port}`, room: 'atelier' });

    await server.stop();
    await waitFor(() => store.getState().session.status === 'reconnecting', 'état reconnexion');
    expect(a.connected).toBe(false);
    const id = doc.addObject({ type: 'empty', name: 'Hors ligne' }); // édition hors ligne

    const again = new CollabServer();
    await again.start({ port, host: '127.0.0.1' });
    servers.push(again);
    await waitFor(() => store.getState().session.status === 'connected', 'reconnexion', 8000);

    // L'édition faite hors ligne est remontée au serveur.
    const b = makeCollab();
    const docB = makeDoc();
    await b.connect(docB, { url: `ws://127.0.0.1:${port}`, room: 'atelier' });
    await waitFor(() => docB.hasObject(id), 'édition hors ligne synchronisée');
  });

  it('remplace la session existante lors d’un nouveau connect', async () => {
    const port = await startServer();
    const a = makeCollab();
    const witness = makeCollab();
    const doc1 = makeDoc();
    const doc2 = makeDoc();
    const docW = makeDoc();
    await a.connect(doc1, { url: `ws://127.0.0.1:${port}`, room: 'un' });
    await witness.connect(docW, { url: `ws://127.0.0.1:${port}`, room: 'un' });
    await waitFor(() => witness.getPeers().length === 1, 'pair visible');
    await a.connect(doc2, { url: `ws://127.0.0.1:${port}`, room: 'deux' });
    expect(store.getState().session.room).toBe('deux');
    expect(a.clientId).toBe(doc2.ydoc.clientID);
    await waitFor(() => witness.getPeers().length === 0, 'ancienne connexion fermée');
    // L'ancien document n'est plus relié.
    doc1.addObject({ type: 'empty', name: 'Orphelin' });
    await new Promise((r) => setTimeout(r, 200));
    expect(docW.objectIds()).toEqual([]);
  });
});
