import os from 'node:os';

function isPrivate(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * Adresses IPv4 de cette machine joignables par d'autres : réseaux locaux
 * privés d'abord, puis les autres (publiques, VPN), les adresses
 * auto-attribuées (169.254.x.x) en dernier. Sans les interfaces internes.
 */
export function listIPv4(): string[] {
  const rank = (ip: string) => (isPrivate(ip) ? 0 : ip.startsWith('169.254.') ? 2 : 1);
  const found = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal) found.add(info.address);
    }
  }
  return [...found].sort((x, y) => rank(x) - rank(y));
}

/** URLs WebSocket à communiquer aux invités, la plus probable d'abord, `localhost` en dernier. */
export function listShareAddresses(port: number): string[] {
  return [...listIPv4().map((ip) => `ws://${ip}:${port}`), `ws://localhost:${port}`];
}
