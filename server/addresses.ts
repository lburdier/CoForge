import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import { type LocalNet, outcomeFromCode, type ProbeResult, type ShareAddress, shareAddressesFrom } from '../src/net/netdiag';

/** Interfaces réseau de cette machine (sans les internes), avec leur nom et leur masque. */
export function listInterfaces(): LocalNet[] {
  const out: LocalNet[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.internal) continue;
      if (info.family !== 'IPv4' && info.family !== 'IPv6') continue;
      out.push({ name, address: info.address, netmask: info.netmask, family: info.family });
    }
  }
  return out;
}

/** Adresses IPv4 de cette machine joignables par d'autres : VPN maillé d'abord, puis réseau local, publiques… auto-attribuées en dernier. */
export function listIPv4(): string[] {
  return shareAddressesFrom(listInterfaces(), 0, false).map((a) => a.host);
}

/** Adresses à communiquer aux invités, classées (VPN, réseau local, …), avec leur portée ; `localhost` en dernier. */
export function describeShareAddresses(port: number): ShareAddress[] {
  return shareAddressesFrom(listInterfaces(), port);
}

/** URLs WebSocket à communiquer aux invités, la plus probable d'abord, `localhost` en dernier. */
export function listShareAddresses(port: number): string[] {
  return describeShareAddresses(port).map((a) => a.url);
}

/** Lit GET / d'un serveur CoForge (JSON { name: 'coforge-server', version, protocol, secured }). */
function readServerInfo(host: string, port: number, timeoutMs: number, tls: boolean): Promise<ProbeResult['server'] | 'other'> {
  return new Promise((resolve) => {
    const req = (tls ? https : http).get({ host, port, path: '/', timeout: timeoutMs, headers: { accept: 'application/json' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 64 * 1024) req.destroy();
      });
      res.on('end', () => {
        try {
          const info = JSON.parse(body) as { name?: unknown; version?: unknown; protocol?: unknown; secured?: unknown };
          if (info.name !== 'coforge-server') return resolve('other');
          resolve({ version: String(info.version ?? '?'), protocol: Number(info.protocol) || 1, secured: info.secured === true });
        } catch {
          resolve('other');
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

/**
 * Teste la connexion TCP à `host:port` (puis identifie le serveur CoForge) : distingue refus,
 * délai dépassé, absence de route et nom introuvable, pour un diagnostic explicite.
 */
export function probeTcp(host: string, port: number, timeoutMs = 6000, tls = false): Promise<ProbeResult> {
  const h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const started = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: Omit<ProbeResult, 'ms'>): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ ...r, ms: Date.now() - started });
    };
    const socket = net.connect({ host: h, port });
    const timer = setTimeout(() => finish({ outcome: 'timeout', code: 'ETIMEDOUT' }), timeoutMs);
    socket.once('connect', () => {
      const tcpMs = Date.now() - started;
      clearTimeout(timer);
      done = true;
      socket.destroy();
      void readServerInfo(h, port, Math.max(1500, timeoutMs - tcpMs), tls).then((server) => {
        if (server === 'other') resolve({ outcome: 'not-coforge', ms: tcpMs, server: null });
        else resolve({ outcome: 'ok', ms: tcpMs, server });
      });
    });
    socket.once('error', (err: NodeJS.ErrnoException) => finish({ outcome: outcomeFromCode(err.code), code: err.code }));
  });
}
