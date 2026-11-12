import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { WebsocketProvider } from 'y-websocket';
import { CollabServer } from '../server/CollabServer';
import { SceneDoc } from '../src/core/doc/SceneDoc';
import type { MeshData, Vec3 } from '../src/core/doc/schema';

interface Client {
  doc: SceneDoc;
  provider: WebsocketProvider;
  /** Codes des fermetures décidées par le serveur. */
  closeCodes: number[];
}

const servers: CollabServer[] = [];
const clients: Client[] = [];
const tmpDirs: string[] = [];

async function startServer(opts: { password?: string; dataDir?: string; saveDelayMs?: number; unloadDelayMs?: number } = {}): Promise<{ server: CollabServer; port: number }> {
  const server = new CollabServer();
  const { port } = await server.start({ port: 0, host: '127.0.0.1', ...opts });
  servers.push(server);
  return { server, port };
}

function connect(port: number, room: string, password?: string): Client {
  const doc = SceneDoc.createEmpty();
  const provider = new WebsocketProvider(`ws://127.0.0.1:${port}`, room, doc.ydoc, {
    WebSocketPolyfill: WebSocket as any,
    params: password ? { password } : {},
    disableBc: true,
  });
  const client: Client = { doc, provider, closeCodes: [] };
  provider.on('connection-close', (event: any) => {
    if (event && typeof event.code === 'number') client.closeCodes.push(event.code);
  });
  clients.push(client);
  return client;
}

function close(client: Client): void {
  const i = clients.indexOf(client);
  if (i >= 0) clients.splice(i, 1);
  client.provider.destroy();
  client.provider.awareness.destroy();
  client.doc.destroy();
}

async function waitFor(cond: () => boolean, what: string, timeout = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error(`Délai dépassé : ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

const synced = (c: Client) => waitFor(() => c.provider.synced, 'première synchronisation');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coforge-test-'));
  tmpDirs.push(dir);
  return dir;
}

function triangle(): MeshData {
  return {
    verts: new Map<string, Vec3>([
      ['a', [0, 0, 0]],
      ['b', [1, 0, 0]],
      ['c', [0, 1, 0]],
    ]),
    faces: new Map([['f', ['a', 'b', 'c']]]),
  };
}

afterEach(async () => {
  for (const client of [...clients]) close(client);
  await Promise.all(servers.splice(0).map((s) => s.stop()));
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('CollabServer', () => {
  it('synchronise deux clients dans les deux sens', async () => {
    const { port, server } = await startServer();
    const a = connect(port, 'atelier');
    const b = connect(port, 'atelier');
    await Promise.all([synced(a), synced(b)]);
    expect(server.getRooms()).toEqual([{ name: 'atelier', clients: 2 }]);

    // A ajoute un objet maillage : B le voit.
    const meshId = a.doc.createMesh(triangle(), 'Triangle');
    const objId = a.doc.addObject({ type: 'mesh', name: 'Triangle', data: meshId });
    await waitFor(() => b.doc.hasObject(objId) && b.doc.getMesh(meshId) !== null, 'objet de A visible chez B');
    expect(b.doc.getObject(objId)?.name).toBe('Triangle');
    expect(b.doc.getMesh(meshId)?.verts.size).toBe(3);

    // B déplace un sommet : A le voit.
    b.doc.setMeshVerts(meshId, { b: [5, 6, 7] });
    await waitFor(() => a.doc.getMesh(meshId)?.verts.get('b')?.[0] === 5, 'sommet déplacé par B visible chez A');
    expect(a.doc.getMesh(meshId)?.verts.get('b')).toEqual([5, 6, 7]);
  });

  it('transmet le contenu existant à un client arrivé plus tard', async () => {
    const { port } = await startServer();
    const a = connect(port, 'atelier');
    await synced(a);
    const id = a.doc.addObject({ type: 'empty', name: 'Repère' });
    const b = connect(port, 'atelier');
    await synced(b);
    await waitFor(() => b.doc.hasObject(id), 'contenu initial reçu');
  });

  it('diffuse la présence et la retire à la déconnexion', async () => {
    const { port } = await startServer();
    const a = connect(port, 'atelier');
    const b = connect(port, 'atelier');
    await Promise.all([synced(a), synced(b)]);
    const idA = a.doc.ydoc.clientID;

    a.provider.awareness.setLocalState({ user: { id: 'u-a', name: 'Alice', color: '#ff0000' }, mode: 'object' });
    await waitFor(() => (b.provider.awareness.getStates().get(idA) as any)?.user?.name === 'Alice', 'présence de A vue par B');

    // Un client arrivé après voit aussi la présence déjà connue du serveur.
    const c = connect(port, 'atelier');
    await waitFor(() => (c.provider.awareness.getStates().get(idA) as any)?.user?.name === 'Alice', 'présence de A vue par C');

    close(a);
    await waitFor(() => !b.provider.awareness.getStates().has(idA), 'présence de A retirée chez B');
    await waitFor(() => !c.provider.awareness.getStates().has(idA), 'présence de A retirée chez C');
  });

  it('refuse un mauvais mot de passe avec le code 4401, sans rien transmettre', async () => {
    const { port, server } = await startServer({ password: 'sésame' });
    const good = connect(port, 'atelier', 'sésame');
    await synced(good);
    const id = good.doc.addObject({ type: 'empty', name: 'Secret' });

    const bad = connect(port, 'atelier', 'faux');
    const none = connect(port, 'atelier');
    await waitFor(() => bad.closeCodes.length > 0 && none.closeCodes.length > 0, 'fermeture des connexions refusées');
    expect(bad.closeCodes[0]).toBe(4401);
    expect(none.closeCodes[0]).toBe(4401);
    await sleep(300);
    expect(bad.provider.synced).toBe(false);
    expect(bad.doc.objectIds()).toEqual([]);
    expect(none.doc.objectIds()).toEqual([]);
    // Refus définitif : le client ne tente pas de se reconnecter.
    expect(bad.provider.shouldConnect).toBe(false);
    expect(bad.closeCodes.length).toBe(1);
    expect(server.getRooms()).toEqual([{ name: 'atelier', clients: 1 }]);

    // Le bon mot de passe fonctionne toujours.
    const other = connect(port, 'atelier', 'sésame');
    await synced(other);
    await waitFor(() => other.doc.hasObject(id), 'contenu reçu avec le bon mot de passe');
  });

  it('persiste les rooms et les recharge après redémarrage', async () => {
    const dataDir = tmpDir();
    const first = await startServer({ dataDir });
    const a = connect(first.port, 'projet');
    await synced(a);
    const meshId = a.doc.createMesh(triangle(), 'Triangle');
    const objId = a.doc.addObject({ type: 'mesh', name: 'Durable', data: meshId });
    // Laisse le temps au serveur de recevoir la mise à jour avant l'arrêt.
    const witness = connect(first.port, 'projet');
    await waitFor(() => witness.doc.hasObject(objId), 'mise à jour reçue par le serveur');
    close(a);
    close(witness);
    await first.server.stop();

    // Le fichier a le format d'un fichier de scène .coforge.
    const file = path.join(dataDir, 'projet.coforge');
    expect(fs.existsSync(file)).toBe(true);
    const fromFile = SceneDoc.fromUpdate(new Uint8Array(fs.readFileSync(file)));
    expect(fromFile.getObject(objId)?.name).toBe('Durable');
    fromFile.destroy();
    expect(fs.readdirSync(dataDir)).toEqual(['projet.coforge']); // pas de fichier temporaire oublié

    const second = await startServer({ dataDir });
    const b = connect(second.port, 'projet');
    await synced(b);
    expect(b.doc.getObject(objId)?.name).toBe('Durable');
    expect(b.doc.getMesh(meshId)?.faces.size).toBe(1);
  });

  it('sauvegarde avec anti-rebond puis décharge la room vide', async () => {
    const dataDir = tmpDir();
    const { port, server } = await startServer({ dataDir, saveDelayMs: 80, unloadDelayMs: 150 });
    const a = connect(port, 'brouillon');
    await synced(a);
    const file = path.join(dataDir, 'brouillon.coforge');
    expect(fs.existsSync(file)).toBe(false); // une room jamais modifiée n'écrit rien

    const id = a.doc.addObject({ type: 'empty', name: 'Un' });
    await waitFor(() => fs.existsSync(file), 'sauvegarde après anti-rebond', 3000);
    const saved = SceneDoc.fromUpdate(new Uint8Array(fs.readFileSync(file)));
    expect(saved.hasObject(id)).toBe(true);
    saved.destroy();

    close(a);
    await waitFor(() => server.getRooms().length === 0, 'room déchargée', 3000);

    // Rechargée depuis le disque à la connexion suivante.
    const b = connect(port, 'brouillon');
    await synced(b);
    expect(b.doc.hasObject(id)).toBe(true);
  });

  it('isole deux rooms', async () => {
    const { port, server } = await startServer();
    const a = connect(port, 'room-a');
    const b = connect(port, 'room-b');
    const a2 = connect(port, 'room-a');
    await Promise.all([synced(a), synced(b), synced(a2)]);

    const id = a.doc.addObject({ type: 'empty', name: 'Dans A' });
    a.provider.awareness.setLocalState({ user: { id: 'u-a', name: 'Alice', color: '#ff0000' } });
    await waitFor(() => a2.doc.hasObject(id), 'objet visible dans la même room');
    await waitFor(() => a2.provider.awareness.getStates().has(a.doc.ydoc.clientID), 'présence visible dans la même room');
    await sleep(200);
    expect(b.doc.objectIds()).toEqual([]);
    expect(b.provider.awareness.getStates().has(a.doc.ydoc.clientID)).toBe(false);
    expect(server.getRooms().sort((x, y) => x.name.localeCompare(y.name))).toEqual([
      { name: 'room-a', clients: 2 },
      { name: 'room-b', clients: 1 },
    ]);
  });

  it('répond en JSON sur GET / et refuse les noms de room invalides', async () => {
    const { port } = await startServer();
    const a = connect(port, 'atelier');
    await synced(a);
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('coforge-server');
    expect(typeof body.version).toBe('string');
    expect(body.rooms).toEqual([{ name: 'atelier', clients: 1 }]);
    expect((await fetch(`http://127.0.0.1:${port}/autre`)).status).toBe(404);

    const bad = connect(port, 'nom*interdit');
    await waitFor(() => bad.closeCodes.length > 0, 'fermeture pour nom invalide');
    expect(bad.closeCodes[0]).toBe(4400);
  });

  it('survit aux messages invalides', async () => {
    const { port } = await startServer();
    const a = connect(port, 'atelier');
    await synced(a);

    const raw = new WebSocket(`ws://127.0.0.1:${port}/atelier`);
    await new Promise<void>((resolve, reject) => {
      raw.once('open', () => resolve());
      raw.once('error', reject);
    });
    raw.send(Buffer.from([0, 2, 250, 250, 250, 250, 250])); // mise à jour tronquée
    raw.send(Buffer.from([1, 200, 1, 2, 3])); // awareness tronquée
    raw.send(Buffer.from([0, 9, 9, 9])); // sous-type de sync inconnu
    raw.send(Buffer.from([42, 1, 2, 3])); // type inconnu
    raw.send(Buffer.alloc(0));
    raw.send('du texte');
    await sleep(200);
    raw.close();

    // Le serveur fonctionne toujours.
    const id = a.doc.addObject({ type: 'empty', name: 'Toujours là' });
    const b = connect(port, 'atelier');
    await synced(b);
    await waitFor(() => b.doc.hasObject(id), 'synchronisation après messages invalides');
  });

  it('rejette le démarrage sur un port occupé', async () => {
    const { port } = await startServer();
    const other = new CollabServer();
    await expect(other.start({ port, host: '127.0.0.1' })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await other.stop(); // sans effet, ne doit pas lever
  });
});
