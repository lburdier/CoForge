import { describe, expect, it } from 'vitest';
import { classifyAddress, diagnose, onLocalNetwork, sameSubnet, shareAddressesFrom, splitWsUrl, type LocalNet } from '../src/net/netdiag';
import { evaluateFirewall, parseCheckOutput } from '../electron/firewall';

const home: LocalNet[] = [{ name: 'Wi-Fi', address: '192.168.1.15', netmask: '255.255.255.0', family: 'IPv4' }];

describe('classement des adresses', () => {
  it('distingue réseau local, VPN, boucle locale et Internet', () => {
    expect(classifyAddress('10.70.2.105').kind).toBe('lan');
    expect(classifyAddress('192.168.1.20').kind).toBe('lan');
    expect(classifyAddress('172.20.0.4').kind).toBe('lan');
    expect(classifyAddress('100.101.5.7').kind).toBe('vpn');
    expect(classifyAddress('100.101.5.7', 'Ethernet 2').kind).toBe('cgnat');
    expect(classifyAddress('10.147.17.3', 'ZeroTier One [abcd]').label).toBe('VPN (ZeroTier)');
    expect(classifyAddress('localhost').kind).toBe('loopback');
    expect(classifyAddress('127.0.0.1').kind).toBe('loopback');
    expect(classifyAddress('8.8.8.8').kind).toBe('public');
  });

  it('propose le VPN en premier et localhost en dernier', () => {
    const list = shareAddressesFrom(
      [
        { name: 'Wi-Fi', address: '10.70.2.105', netmask: '255.255.0.0', family: 'IPv4' },
        { name: 'Tailscale', address: '100.88.1.2', netmask: '255.255.255.255', family: 'IPv4' },
      ],
      4455,
    );
    expect(list.map((a) => a.host)).toEqual(['100.88.1.2', '10.70.2.105', 'localhost']);
  });

  it('lit les URL ws:// et les sous-réseaux', () => {
    expect(splitWsUrl('ws://10.70.2.105:4455')).toEqual({ host: '10.70.2.105', port: 4455, tls: false });
    expect(splitWsUrl('wss://exemple.org')).toEqual({ host: 'exemple.org', port: 443, tls: true });
    expect(sameSubnet('192.168.1.15', '192.168.1.200', '255.255.255.0')).toBe(true);
    expect(sameSubnet('10.70.2.105', '192.168.1.15', '255.255.255.0')).toBe(false);
    expect(onLocalNetwork('10.70.2.105', home)).toBe(false);
    expect(onLocalNetwork('10.70.2.105', null)).toBeNull();
  });
});

describe('diagnostic de connexion', () => {
  it('explique qu’une adresse privée d’un autre réseau ne peut pas aboutir', () => {
    const d = diagnose('10.70.2.105', 4455, { outcome: 'timeout', ms: 6000 }, home);
    expect(d.severity).toBe('error');
    expect(d.title).toContain('réseau local de l’hôte');
    expect(d.solutions.some((s) => s.includes('Tailscale'))).toBe(true);
  });

  it('signale le pare-feu quand l’hôte est sur le même réseau', () => {
    const d = diagnose('192.168.1.20', 4455, { outcome: 'timeout', ms: 6000 }, home);
    expect(d.title).toContain('Délai dépassé');
    expect(d.solutions.join(' ')).toContain('Pare-feu');
  });

  it('confirme un serveur CoForge joignable', () => {
    const d = diagnose('192.168.1.20', 4455, { outcome: 'ok', ms: 12, server: { version: '0.6.0', protocol: 2, secured: true } }, home);
    expect(d.severity).toBe('ok');
    expect(d.title).toContain('0.6.0');
  });

  it('refuse un lien localhost venu d’un autre PC', () => {
    expect(diagnose('localhost', 4455, { outcome: 'refused', ms: 5 }, home).title).toContain('votre propre ordinateur');
  });

  it('signale un VPN absent chez l’invité', () => {
    expect(diagnose('100.88.1.2', 4455, { outcome: 'timeout', ms: 6000 }, home).title).toContain('aucun VPN');
  });
});

describe('pare-feu Windows', () => {
  it('détecte le blocage du profil Public', () => {
    const raw = parseCheckOutput(
      JSON.stringify({
        profiles: { name: 'YNOV', alias: 'Wi-Fi', category: 'Public' },
        rules: [
          { name: 'coforge.exe', enabled: true, action: 'Allow', profile: 2 },
          { name: 'coforge.exe', enabled: true, action: 'Block', profile: 4 },
        ],
        firewall: [
          { name: 'Private', enabled: true, inbound: 'Block' },
          { name: 'Public', enabled: true, inbound: 'Block' },
        ],
      }),
    );
    const st = evaluateFirewall(raw);
    expect(st.ok).toBe(false);
    expect(st.networks[0]).toMatchObject({ category: 'Public', blocked: true, allowed: false });
    expect(st.message).toContain('BLOQUE');
  });

  it('accepte une règle autorisant tous les profils', () => {
    const st = evaluateFirewall({
      profiles: [{ name: 'Maison', alias: 'Wi-Fi', category: 'Private' }],
      rules: [{ name: 'CoForge', enabled: true, action: 'Allow', profile: 0 }],
      firewall: [{ name: 'Private', enabled: true, inbound: 'Block' }],
    });
    expect(st.ok).toBe(true);
  });
});
