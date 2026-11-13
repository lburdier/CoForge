import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InviteRegistry } from '../server/invites';
import { buildInviteLink, buildWebInviteLink, inviteServerUrl, isValidHost, looksLikeInviteLink, parseInviteLink } from '../src/net/invite';
import { isValidRoomName } from '../src/net/protocol';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('liens d’invitation', () => {
  it('construit puis relit un lien coforge:// et sa variante web', () => {
    const link = { host: '192.168.1.20', port: 4455, room: 'atelier bois', token: TOKEN, tls: false };
    const text = buildInviteLink(link);
    expect(text).toBe(`coforge://join?host=192.168.1.20&port=4455&room=atelier%20bois&token=${TOKEN}`);
    expect(parseInviteLink(text)).toEqual({ ok: true, link });
    const web = buildWebInviteLink(link);
    expect(web).toBe(`http://192.168.1.20:4455/join?room=atelier%20bois&token=${TOKEN}`);
    expect(parseInviteLink(web)).toEqual({ ok: true, link });
    expect(inviteServerUrl(link)).toBe('ws://192.168.1.20:4455');
    expect(inviteServerUrl({ ...link, tls: true })).toBe('wss://192.168.1.20:4455');
  });

  it('accepte IPv6, noms DNS, lien entouré de chevrons, sans jeton, tls', () => {
    expect(parseInviteLink(` <coforge://join?host=%5Bfe80%3A%3A1%5D&port=1&room=a> `)).toMatchObject({ ok: true, link: { host: '[fe80::1]', port: 1, token: null } });
    expect(parseInviteLink('coforge://join/?host=Studio.Exemple.fr&port=443&room=x&tls=1')).toMatchObject({ ok: true, link: { host: 'studio.exemple.fr', tls: true } });
    expect(parseInviteLink(`https://serveur.exemple.fr/join?room=projet&token=${TOKEN}`)).toMatchObject({ ok: true, link: { port: 443, tls: true } });
    expect(parseInviteLink('coforge://join?host=h&port=1&room=a&futur=1').ok).toBe(true); // paramètre inconnu ignoré
  });

  it('refuse strictement les liens douteux', () => {
    const bad = [
      '',
      'coforge://autre?host=a&port=1&room=b',
      'coforge://join?host=a&port=1&room=b&room=c', // doublon
      'coforge://join?host=a&port=0&room=b',
      'coforge://join?host=a&port=70000&room=b',
      'coforge://join?host=a&port=+12&room=b',
      'coforge://join?host=a b&port=1&room=b', // espace non encodé
      'coforge://join?host=a%20b&port=1&room=b',
      'coforge://join?host=evil.com%2Fx&port=1&room=b',
      'coforge://join?host=a&port=1&room=..',
      'coforge://join?host=a&port=1&room=con',
      'coforge://join?host=a&port=1&room=%C3%A9t%C3%A9', // accents : refusés par le serveur
      'coforge://join?host=a&port=1&room=b%0Ac',
      'coforge://join?host=a&port=1&room=b&token=court',
      'coforge://join?host=a&port=1&room=b&token=%3Cscript%3E%3C%2Fscript%3Eaaaaaaaaaa',
      'coforge://join?host=0.0.0.0&port=1&room=b',
      'coforge://join?host=999.1.1.1&port=1&room=b',
      'coforge://join?host=a&port=1&room=b&v=2',
      'coforge://join?host=a&port=1&room=b&tls=oui',
      'coforge://join?host=%ZZ&port=1&room=b',
      'http://user@h:1/join?room=b',
      'http://h:1/autre?room=b',
      'javascript:alert(1)',
      `coforge://join?host=a&port=1&room=b&token=${'A'.repeat(2000)}`,
      'coforge://join?host=a&port=1&room=b‮',
    ];
    for (const text of bad) expect(parseInviteLink(text).ok, text).toBe(false);
    expect(() => buildInviteLink({ host: 'a/b', port: 1, room: 'r', token: null, tls: false })).toThrow();
  });

  it('valide hôtes et noms de session', () => {
    expect(isValidHost('localhost')).toBe(true);
    expect(isValidHost('10.0.0.1')).toBe(true);
    expect(isValidHost('-a.com')).toBe(false);
    expect(isValidHost('[::]')).toBe(false);
    expect(isValidRoomName('atelier-1.v2')).toBe(true);
    expect(isValidRoomName(' atelier')).toBe(false);
    expect(isValidRoomName('a'.repeat(65))).toBe(false);
    expect(looksLikeInviteLink('  coforge://join?x')).toBe(true);
    expect(looksLikeInviteLink('http://192.168.1.2:4455/join?room=a')).toBe(true);
    expect(looksLikeInviteLink('ws://192.168.1.2:4455')).toBe(false);
  });
});

describe('registre des invitations', () => {
  it('jeton aléatoire, durée de validité, usages, révocation, tickets de reprise', () => {
    let now = 1_000_000;
    const reg = new InviteRegistry(null, () => {}, () => now);
    const inv = reg.create('Atelier', { ttlMs: 3600_000, maxUses: 2 });
    expect(inv.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(reg.create('Atelier').token).not.toBe(inv.token);
    expect(reg.use('mauvais-jeton-0000000', 'atelier')).toEqual({ ok: false, reason: 'unknown' });
    expect(reg.use(inv.token, 'autre')).toEqual({ ok: false, reason: 'room' });
    expect(reg.use(inv.token, 'atelier')).toEqual({ ok: true, inviteId: inv.id }); // casse ignorée
    expect(reg.use(inv.token, 'Atelier').ok).toBe(true);
    expect(reg.use(inv.token, 'Atelier')).toEqual({ ok: false, reason: 'exhausted' });

    const ticket = reg.issueTicket(inv.id, 'Atelier');
    now += 2 * 3600_000; // l'invitation expire, le ticket de reprise reste valable
    expect(reg.resume(ticket, 'atelier')).toBe(inv.id);
    const other = reg.create('Atelier', { ttlMs: 60_000 });
    now += 61_000;
    expect(reg.use(other.token, 'Atelier')).toEqual({ ok: false, reason: 'expired' });

    expect(reg.revoke(inv.id)).toBe(true);
    expect(reg.resume(ticket, 'Atelier')).toBeNull();
    expect(reg.list('atelier').find((i) => i.id === inv.id)?.revoked).toBe(true);
    // Le serveur ne garde jamais le jeton en clair.
    expect(JSON.stringify(reg.list())).not.toContain(inv.token);
  });

  it('persiste les invitations (condensés seulement) de façon atomique', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coforge-inv-'));
    dirs.push(dir);
    const file = path.join(dir, 'invitations.json');
    const a = new InviteRegistry(file);
    const inv = a.create('projet');
    a.flush();
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain(inv.token);
    expect(fs.readdirSync(dir)).toEqual(['invitations.json']);
    const b = new InviteRegistry(file);
    expect(b.use(inv.token, 'projet').ok).toBe(true);
    fs.writeFileSync(file, '{ illisible');
    expect(() => new InviteRegistry(file)).not.toThrow();
  });
});
