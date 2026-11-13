import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import * as decoding from 'lib0/decoding';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { CollabServer } from '../server/CollabServer';
import type { AppContext } from '../src/app/context';
import { initialState } from '../src/app/store';
import { SceneDoc } from '../src/core/doc/SceneDoc';
import type { ICollab } from '../src/net/api';
import { createCollab } from '../src/net/index';
import { ChunkAssembler, CHUNK_SIZE, MSG_CHUNK, splitMessage } from '../src/net/protocol';
import { CoforgeProvider } from '../src/net/provider';

/**
 * Robustesse du réseau : battement de cœur, coupure silencieuse, gros messages, invitations,
 * négociation de version, limitation des tentatives, persistance de secours.
 */

const servers: CollabServer[] = [];
const cleanups: (() => void | Promise<void>)[] = [];

async function startServer(opts: Partial<Parameters<CollabServer['start']>[0]> = {}): Promise<{ server: CollabServer; port: number }> {
  const server = new CollabServer();
  const { port } = await server.start({ port: 0, host: '127.0.0.1', ...opts });
  servers.push(server);
  return { server, port };
}

function makeClient(): { collab: ICollab; store: StoreApi<any>; doc: SceneDoc } {
  const store = createStore<any>(() => initialState());
  const collab = createCollab({ store } as unknown as AppContext);
  const doc = SceneDoc.createEmpty();
  cleanups.push(() => {
    collab.disconnect();
    doc.destroy();
  });
  return { collab, store, doc };
}

async function waitFor(cond: () => boolean, what: string, timeout = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error(`Délai dépassé : ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** Proxy TCP qui peut geler le trafic sans fermer les sockets (coupure silencieuse, veille). */
async function frozenProxy(target: number): Promise<{ port: number; freeze(): void; thaw(): void; close(): void }> {
  let frozen = false;
  const held: (() => void)[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const up = net.connect(target, '127.0.0.1');
    sockets.add(client).add(up);
    for (const s of [client, up]) s.on('error', () => {});
    const relay = (from: net.Socket, to: net.Socket) =>
      from.on('data', (d) => {
        if (frozen) held.push(() => !to.destroyed && to.write(d));
        else if (!to.destroyed) to.write(d);
      });
    relay(client, up);
    relay(up, client);
    client.on('close', () => !frozen && up.destroy());
    up.on('close', () => !frozen && client.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  const close = () => {
    for (const s of sockets) s.destroy();
    server.close();
  };
  cleanups.push(close);
  return {
    port,
    freeze: () => (frozen = true),
    thaw: () => {
      frozen = false;
      // Un bout fermé pendant le gel : l'autre reçoit un RST, comme un vrai TCP.
      for (const s of sockets) if (s.destroyed) for (const o of sockets) o.destroy();
      for (const h of held.splice(0)) h();
    },
    close,
  };
}

function rawClose(port: number, pathAndQuery: string): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${pathAndQuery}`);
    ws.on('error', () => {});
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

function grid(n: number, doc: SceneDoc): string {
  const verts = new Map<string, [number, number, number]>();
  const faces = new Map<string, string[]>();
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) verts.set(`v${x}_${y}`, [x, y, (x * y) % 7]);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) faces.set(`f${x}_${y}`, [`v${x}_${y}`, `v${x + 1}_${y}`, `v${x + 1}_${y + 1}`, `v${x}_${y + 1}`]);
  return doc.createMesh({ verts, faces }, 'Grille');
}

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

describe('protocole : découpage des gros messages', () => {
  it('découpe puis réassemble, et refuse un flux incohérent', () => {
    const message = new Uint8Array(CHUNK_SIZE * 2 + 123).map((_v, i) => i % 251);
    const parts = splitMessage(7, message);
    expect(parts.length).toBe(3);
    const asm = new ChunkAssembler();
    let out: Uint8Array | null = null;
    for (const p of parts) {
      const d = decoding.createDecoder(p);
      expect(decoding.readVarUint(d)).toBe(MSG_CHUNK);
      out = asm.push(d);
    }
    expect(out).toEqual(message);
    const bad = new ChunkAssembler();
    const d0 = decoding.createDecoder(parts[0]);
    decoding.readVarUint(d0);
    bad.push(d0);
    const d2 = decoding.createDecoder(parts[2]);
    decoding.readVarUint(d2);
    expect(() => bad.push(d2)).toThrow('hors séquence');
    const small = new ChunkAssembler(10);
    const ds = decoding.createDecoder(parts[0]);
    decoding.readVarUint(ds);
    expect(() => small.push(ds)).toThrow('trop gros');
  });

  it('synchronise une grosse scène (> 512 Ko, envoyée en morceaux) dans les deux sens', async () => {
    const { port } = await startServer();
    const a = makeClient();
    const meshId = grid(120, a.doc); // ~14 400 faces, ~1,5 Mo
    expect(Y.encodeStateAsUpdate(a.doc.ydoc).byteLength).toBeGreaterThan(1024 * 1024);
    await a.collab.connect(a.doc, { url: `ws://127.0.0.1:${port}`, room: 'gros' });
    const b = makeClient();
    await b.collab.connect(b.doc, { url: `ws://127.0.0.1:${port}`, room: 'gros' });
    expect(b.doc.getMesh(meshId)?.faces.size).toBe(14400);
    const second = grid(110, b.doc);
    await waitFor(() => a.doc.getMesh(second)?.faces.size === 12100, 'gros maillage de B reçu par A');
    await waitFor(() => a.collab.getConnection().pendingChanges === 0 && b.collab.getConnection().pendingChanges === 0, 'accusés de réception');
    expect(a.collab.getConnection()).toMatchObject({ phase: 'connected', protocol: 2, role: 'admin', secured: false });
    expect(a.collab.getConnection().latencyMs).not.toBeNull();
  });
});

describe('battement de cœur et coupures', () => {
  it('détecte une coupure silencieuse, retire la présence fantôme, garde les modifications en attente et se rétablit', async () => {
    const { port } = await startServer({ heartbeatMs: 200 });
    const proxy = await frozenProxy(port);
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const awA = new Awareness(docA);
    const awB = new Awareness(docB);
    const opts = { pingIntervalMs: 200, deadAfterMs: 1200, backoffBaseMs: 100, backoffMaxMs: 400 };
    const a = new CoforgeProvider({ url: `ws://127.0.0.1:${port}`, room: 'coupure', doc: docA, awareness: awA, ...opts });
    const b = new CoforgeProvider({ url: `ws://127.0.0.1:${proxy.port}`, room: 'coupure', doc: docB, awareness: awB, ...opts });
    cleanups.push(() => {
      a.destroy();
      b.destroy();
      awA.destroy();
      awB.destroy();
    });
    awA.setLocalState({ user: 'A' });
    awB.setLocalState({ user: 'B' });
    a.connect();
    b.connect();
    await waitFor(() => a.isSynced && b.isSynced && awA.getStates().has(docB.clientID), 'connexion et présence');

    proxy.freeze();
    const t0 = Date.now();
    docB.getMap('m').set('hors-ligne', 1);
    docA.getMap('m').set('pendant', 2);
    await waitFor(() => !awA.getStates().has(docB.clientID), 'présence fantôme retirée par le serveur', 5000);
    await waitFor(() => b.snapshot().phase !== 'connected', 'coupure détectée par B', 5000);
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(b.snapshot().pending).toBeGreaterThan(0);

    proxy.thaw();
    b.retryNow();
    await waitFor(() => b.isSynced, 'reconnexion', 8000);
    await waitFor(() => docA.getMap('m').get('hors-ligne') === 1 && docB.getMap('m').get('pendant') === 2, 'modifications hors ligne fusionnées');
    await waitFor(() => b.snapshot().pending === 0, 'modifications confirmées');
    await waitFor(() => awA.getStates().has(docB.clientID) && awB.getStates().has(docA.clientID), 'présences rétablies');
  });

  it('expose tentative, prochain essai et « réessayer maintenant » quand le serveur tombe', async () => {
    const first = await startServer();
    const c = makeClient();
    await c.collab.connect(c.doc, { url: `ws://127.0.0.1:${first.port}`, room: 'redemarrage' });
    await first.server.stop();
    servers.splice(servers.indexOf(first.server), 1);
    await waitFor(() => c.collab.getConnection().nextRetryAt !== null, 'reconnexion programmée');
    const info = c.collab.getConnection();
    expect(['reconnecting', 'offline']).toContain(info.phase);
    expect(info.attempt).toBeGreaterThanOrEqual(1);
    expect(c.store.getState().session.status).toBe('reconnecting');
    c.doc.addObject({ type: 'empty', name: 'pendant la panne' });
    await waitFor(() => c.collab.getConnection().pendingChanges > 0, 'modification en attente affichée');
    await startServer({ port: first.port });
    c.collab.retryNow();
    await waitFor(() => c.collab.getConnection().phase === 'connected', 'reconnexion immédiate', 3000);
    await waitFor(() => c.collab.getConnection().pendingChanges === 0, 'envoi confirmé');
  });

  it('ferme l’ancienne connexion à moitié morte quand le même client revient', async () => {
    const { server, port } = await startServer({ heartbeatMs: 60_000 });
    const doc = new Y.Doc();
    const aw = new Awareness(doc);
    aw.setLocalState({ user: 'X' });
    const p1 = new CoforgeProvider({ url: `ws://127.0.0.1:${port}`, room: 'double', doc, awareness: aw });
    p1.connect();
    await waitFor(() => p1.isSynced, 'première connexion');
    await waitFor(() => server.getRooms()[0]?.clients === 1, 'une connexion');
    // Deuxième fournisseur sur le même document (même clientID), sans fermer le premier.
    const p2 = new CoforgeProvider({ url: `ws://127.0.0.1:${port}`, room: 'double', doc, awareness: aw });
    p2.connect();
    await waitFor(() => p2.isSynced, 'seconde connexion');
    aw.setLocalState({ user: 'X', t: 1 });
    await waitFor(() => server.getRooms()[0]?.clients === 1, 'ancienne connexion fermée', 3000);
    p1.destroy();
    p2.destroy();
    aw.destroy();
  });
});

describe('invitations', () => {
  it('un invité entre par jeton sans mot de passe, ne peut pas inviter, et est déconnecté à la révocation', async () => {
    const { port } = await startServer({ password: 'secret-hote' });
    const host = makeClient();
    await host.collab.connect(host.doc, { url: `ws://127.0.0.1:${port}`, room: 'atelier', password: 'secret-hote' });
    const id = host.doc.addObject({ type: 'empty', name: 'Partagé' });
    const invite = await host.collab.createInvite({ ttlMs: 3600_000 });
    expect(invite.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await host.collab.listInvites()).toHaveLength(1);

    const guest = makeClient();
    await guest.collab.connect(guest.doc, { url: `ws://127.0.0.1:${port}`, room: 'atelier', token: invite.token });
    expect(guest.doc.hasObject(id)).toBe(true);
    expect(guest.collab.getConnection()).toMatchObject({ role: 'guest', inviteToken: invite.token, secured: true });
    await expect(guest.collab.createInvite()).rejects.toThrow('mot de passe');

    // Mauvais jeton, autre session : refus explicites.
    const intruder = makeClient();
    await expect(intruder.collab.connect(intruder.doc, { url: `ws://127.0.0.1:${port}`, room: 'atelier', token: 'X'.repeat(22) })).rejects.toThrow('Invitation invalide');
    await expect(intruder.collab.connect(intruder.doc, { url: `ws://127.0.0.1:${port}`, room: 'autre', token: invite.token })).rejects.toThrow('autre session');

    await host.collab.revokeInvite(invite.id);
    await waitFor(() => guest.store.getState().session.status === 'offline', 'invité déconnecté');
    expect(guest.store.getState().session.error).toContain('révoqué');
    expect(guest.collab.getConnection()).toMatchObject({ phase: 'error', errorKind: 'revoked' });
    const late = makeClient();
    await expect(late.collab.connect(late.doc, { url: `ws://127.0.0.1:${port}`, room: 'atelier', token: invite.token })).rejects.toThrow('révoquée');
  });

  it('l’invité se reconnecte avec son ticket de reprise après une coupure', async () => {
    const { server, port } = await startServer({ password: 'p' });
    const invite = server.createInvite('atelier', { maxUses: 1 });
    const guest = makeClient();
    await guest.collab.connect(guest.doc, { url: `ws://127.0.0.1:${port}`, room: 'atelier', token: invite.token });
    // Coupe toutes les connexions côté serveur : l'invitation (1 usage) est épuisée, le ticket doit suffire.
    for (const room of (server as any).rooms.values()) for (const c of room.conns.values()) c.ws.terminate();
    await waitFor(() => guest.store.getState().session.status === 'reconnecting', 'perte de connexion');
    await waitFor(() => guest.store.getState().session.status === 'connected', 'reprise par ticket');
    expect(server.listInvites()[0].uses).toBe(1);
  });

  it('serveur embarqué : refuse une autre session (4404) et sert la page web d’invitation', async () => {
    const { server, port } = await startServer({ password: 'p', rooms: ['atelier'] });
    const c = makeClient();
    await expect(c.collab.connect(c.doc, { url: `ws://127.0.0.1:${port}`, room: 'ailleurs', password: 'p' })).rejects.toThrow('Session introuvable');
    const invite = server.createInvite('atelier');
    const page = await fetch(`http://127.0.0.1:${port}/join?room=atelier&token=${invite.token}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain(`coforge://join?host=127.0.0.1&amp;port=${port}&amp;room=atelier&amp;token=${invite.token}`);
    expect(html).not.toContain('<script');
    const bad = await fetch(`http://127.0.0.1:${port}/join?room=%3Cscript%3E`);
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain('<script>');
  });
});

describe('négociation et protections', () => {
  it('refuse un protocole client trop ancien (4426) et accepte un client y-websocket sans version', async () => {
    const { port } = await startServer();
    expect(await rawClose(port, '/atelier?v=1')).toEqual({ code: 4426, reason: 'version:2-2' });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/atelier`);
    await new Promise<void>((r) => ws.once('message', () => r()));
    ws.close();
  });

  it('limite les tentatives de mot de passe (4429)', async () => {
    const { port } = await startServer({ password: 'bon' });
    for (let i = 0; i < 10; i++) expect((await rawClose(port, `/atelier?v=2&password=faux${i}`)).code).toBe(4401);
    expect((await rawClose(port, '/atelier?v=2&password=bon')).code).toBe(4429);
    const c = makeClient();
    await expect(c.collab.connect(c.doc, { url: `ws://127.0.0.1:${port}`, room: 'atelier', password: 'bon' })).rejects.toThrow('Trop de tentatives');
  });

  it('restaure une room depuis sa copie de secours si le fichier principal est corrompu', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coforge-bak-'));
    cleanups.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const first = await startServer({ dataDir, saveDelayMs: 20 });
    const c = makeClient();
    await c.collab.connect(c.doc, { url: `ws://127.0.0.1:${first.port}`, room: 'projet' });
    const id1 = c.doc.addObject({ type: 'empty', name: 'Un' });
    const file = path.join(dataDir, 'projet.coforge');
    await waitFor(() => fs.existsSync(file), 'première sauvegarde');
    c.doc.addObject({ type: 'empty', name: 'Deux' });
    await waitFor(() => fs.existsSync(`${file}.bak`), 'copie de secours');
    c.collab.disconnect();
    await first.server.stop();
    servers.splice(servers.indexOf(first.server), 1);
    fs.writeFileSync(file, Buffer.from([0, 255, 255, 255, 1, 2, 3])); // écriture partielle simulée
    await startServer({ dataDir, port: first.port });
    const d = makeClient();
    await d.collab.connect(d.doc, { url: `ws://127.0.0.1:${first.port}`, room: 'projet' });
    expect(d.doc.hasObject(id1)).toBe(true);
    expect(fs.readdirSync(dataDir).some((f) => f.includes('.invalide-'))).toBe(true);
  });
});
