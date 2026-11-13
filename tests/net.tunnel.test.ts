import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { CollabServer } from '../server/CollabServer';
import { isTrustedSigner, parseTunnelError, parseTunnelHost, tunnelArgs } from '../electron/tunnel';
import { classifyAddress, describeShareUrls, isTunnelHost } from '../src/net/netdiag';
import { containsIp, maskIps } from '../src/ui/lib/privacy';

const servers: CollabServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

async function start(password?: string): Promise<{ server: CollabServer; port: number }> {
  const server = new CollabServer();
  const { port } = await server.start({ port: 0, host: '127.0.0.1', password });
  servers.push(server);
  return { server, port };
}

/** Ouvre une connexion WebSocket et renvoie son code de fermeture. */
function closeCode(port: number, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    ws.on('close', (code) => resolve(code));
    ws.on('error', () => {});
  });
}

describe('tunnel chiffré : journal de cloudflared', () => {
  it('lit l’adresse publique et ignore l’API de création', () => {
    const banner = '2026-11-13T18:40:01Z INF |  https://calm-river-tiny-moon.trycloudflare.com                                     |';
    expect(parseTunnelHost(banner)).toBe('calm-river-tiny-moon.trycloudflare.com');
    expect(parseTunnelHost('INF Requesting new quick Tunnel on https://api.trycloudflare.com...')).toBeNull();
    expect(parseTunnelHost('rien ici')).toBeNull();
  });

  it('extrait la cause d’un échec, sans les avertissements de configuration', () => {
    const log = [
      '2026-11-13T18:40:00Z ERR Cannot determine default configuration path. No file [config.yml config.yaml]',
      '2026-11-13T18:40:05Z ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: i/o timeout',
    ].join('\n');
    expect(parseTunnelError(log)).toContain('Cloudflare injoignable');
    expect(parseTunnelError('INF tout va bien')).toBeNull();
    // Journal réel (DNS de la box indisponible) : ligne sans préfixe ERR.
    const dns = 'INF Requesting new quick Tunnel on trycloudflare.com...\nfailed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: lookup api.trycloudflare.com: no such host';
    expect(parseTunnelError(dns)).toContain('introuvable');
    expect(parseTunnelError('2026-11-13T18:40:05Z ERR quelque chose d’inattendu')).toBe('quelque chose d’inattendu');
  });

  it('vise uniquement le serveur local, en http2', () => {
    expect(tunnelArgs(4455)).toEqual(['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', 'http://127.0.0.1:4455']);
  });

  it('n’accepte qu’une signature valide au nom de Cloudflare', () => {
    expect(isTrustedSigner('Valid', 'CN="Cloudflare, Inc.", O="Cloudflare, Inc.", L=San Francisco, S=California, C=US')).toBe(true);
    expect(isTrustedSigner('Valid', 'CN=Cloudflare Inc, O=Cloudflare Inc, C=US')).toBe(true);
    expect(isTrustedSigner('HashMismatch', 'CN="Cloudflare, Inc."')).toBe(false);
    expect(isTrustedSigner('Valid', 'CN=Evil Cloudflare Clone Ltd')).toBe(false);
    expect(isTrustedSigner('NotSigned', '')).toBe(false);
  });
});

describe('tunnel chiffré : adresses', () => {
  it('classe l’adresse du tunnel en premier, sans IP', () => {
    expect(isTunnelHost('calm-river.trycloudflare.com')).toBe(true);
    expect(isTunnelHost('api.trycloudflare.com')).toBe(false);
    expect(isTunnelHost('trycloudflare.com.evil.fr')).toBe(false);
    expect(classifyAddress('calm-river.trycloudflare.com').kind).toBe('tunnel');
    const list = describeShareUrls(['ws://192.168.1.15:4455', 'wss://calm-river.trycloudflare.com']);
    expect(list[0]).toMatchObject({ kind: 'tunnel', host: 'calm-river.trycloudflare.com', port: 443 });
  });

  it('masque les IP à l’écran, pas les noms', () => {
    const link = 'coforge://join?host=192.168.1.15&port=4455&room=a&token=abc';
    expect(maskIps(link)).toBe('coforge://join?host=•••&port=4455&room=a&token=abc');
    expect(maskIps('http://10.70.2.105:4455/join?room=a')).toBe('http://•••:4455/join?room=a');
    expect(maskIps('ws://[fe80::1]:4455')).toBe('ws://[•••]:4455');
    expect(maskIps('coforge://join?host=fe80::1&port=1')).toBe('coforge://join?host=•••&port=1');
    expect(maskIps('wss://calm-river.trycloudflare.com')).toBe('wss://calm-river.trycloudflare.com');
    expect(containsIp(link)).toBe(true);
    expect(containsIp('coforge://join?host=calm-river.trycloudflare.com&port=443&tls=1')).toBe(false);
  });
});

describe('serveur derrière le tunnel', () => {
  it('ne publie pas la liste des salles d’un serveur protégé', async () => {
    const { port } = await start('secret');
    const body = await (await fetch(`http://127.0.0.1:${port}/`)).json();
    expect(body.secured).toBe(true);
    expect(body.rooms).toBeUndefined();
  });

  it('construit les liens de la page /join avec l’adresse du tunnel', async () => {
    const { server, port } = await start('secret');
    server.setPublicOrigin({ host: 'calm-river.trycloudflare.com', port: 443, tls: true });
    const html = await (await fetch(`http://127.0.0.1:${port}/join?room=atelier`)).text();
    expect(html).toContain('coforge://join?host=calm-river.trycloudflare.com&amp;port=443&amp;room=atelier&amp;tls=1');
    expect(html).not.toContain('127.0.0.1');
  });

  it('limite les échecs par invité réel (CF-Connecting-IP), pas pour tout le tunnel', async () => {
    const { server, port } = await start('secret');
    server.setPublicOrigin({ host: 'calm-river.trycloudflare.com', port: 443, tls: true });
    // Un attaquant épuise ses essais…
    for (let i = 0; i < 10; i++) expect(await closeCode(port, '/atelier?password=faux', { 'CF-Connecting-IP': '203.0.113.7' })).toBe(4401);
    expect(await closeCode(port, '/atelier?password=faux', { 'CF-Connecting-IP': '203.0.113.7' })).toBe(4429);
    // … sans bloquer un autre invité passant par le même tunnel.
    expect(await closeCode(port, '/atelier?password=faux', { 'CF-Connecting-IP': '198.51.100.9' })).toBe(4401);
  });
});
