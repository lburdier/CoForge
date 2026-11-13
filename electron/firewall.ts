import { execFile } from 'node:child_process';

/**
 * Pare-feu Windows pour le serveur de session embarqué.
 *
 * À la première écoute, Windows propose d'autoriser l'application pour les réseaux « privés »
 * (case cochée) et « publics » (case décochée) ; s'il ne coche que « privés », il crée en plus une
 * règle de BLOCAGE pour le profil public. Or un réseau d'école ou d'hôtel est presque toujours
 * classé « Public » : les invités ne peuvent alors pas se connecter, sans message.
 *
 * Ce module lit l'état (sans droits particuliers) et, sur demande explicite de l'utilisateur,
 * crée une règle entrante pour les profils Privé, Public et Domaine (élévation UAC).
 * Aucune dépendance à Electron : testable sous Node.
 */

/** Nom de la règle créée par CoForge. */
export const FIREWALL_RULE_NAME = 'CoForge - sessions collaboratives';

/** Bits des profils du pare-feu Windows (énumération NetSecurity.Profile ; 0 = tous). */
const PROFILE_BITS: Record<string, number> = { DomainAuthenticated: 1, Domain: 1, Private: 2, Public: 4 };

export interface FirewallRule {
  name: string;
  enabled: boolean;
  action: string;
  /** Masque de profils (0 = tous). */
  profile: number;
}

export interface FirewallRaw {
  /** Profils des réseaux connectés (Public, Private, DomainAuthenticated). */
  profiles: { name: string; alias: string; category: string }[];
  /** Règles entrantes qui visent ce programme. */
  rules: FirewallRule[];
  /** État du pare-feu par profil. */
  firewall: { name: string; enabled: boolean; inbound: string }[];
}

export interface FirewallStatus {
  /** Toutes les connexions actives sont autorisées. */
  ok: boolean;
  /** Réseaux connectés et verdict pour chacun. */
  networks: { name: string; category: 'Public' | 'Privé' | 'Domaine' | string; allowed: boolean; blocked: boolean }[];
  /** Texte d'explication (français), vide si tout va bien. */
  message: string;
}

/** Échappe une chaîne pour un littéral PowerShell entre apostrophes. */
export function psQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/** Script de lecture : profils réseau, règles entrantes du programme, état du pare-feu (JSON compact). */
export function buildCheckScript(exe: string): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$exe = ${psQuote(exe)}`,
    '$profiles = @(Get-NetConnectionProfile | ForEach-Object { @{ name = [string]$_.Name; alias = [string]$_.InterfaceAlias; category = [string]$_.NetworkCategory } })',
    "$rules = @(Get-NetFirewallApplicationFilter -Program $exe | Get-NetFirewallRule | Where-Object { [string]$_.Direction -eq 'Inbound' } | ForEach-Object { @{ name = [string]$_.DisplayName; enabled = ([string]$_.Enabled -eq 'True'); action = [string]$_.Action; profile = [int]$_.Profile } })",
    "$fw = @(Get-NetFirewallProfile | ForEach-Object { @{ name = [string]$_.Name; enabled = ([string]$_.Enabled -eq 'True'); inbound = [string]$_.DefaultInboundAction } })",
    '@{ profiles = $profiles; rules = $rules; firewall = $fw } | ConvertTo-Json -Depth 4 -Compress',
  ].join('\n');
}

/**
 * Script exécuté avec élévation : désactive les règles de BLOCAGE entrantes du programme (créées
 * quand on décoche « réseaux publics »), puis (re)crée la règle CoForge pour tous les profils.
 */
export function buildFixScript(exe: string): string {
  const name = psQuote(FIREWALL_RULE_NAME);
  return [
    "$ErrorActionPreference = 'Stop'",
    `$exe = ${psQuote(exe)}`,
    "Get-NetFirewallApplicationFilter -Program $exe -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object { [string]$_.Direction -eq 'Inbound' -and [string]$_.Action -eq 'Block' } | Disable-NetFirewallRule",
    `Get-NetFirewallRule -DisplayName ${name} -ErrorAction SilentlyContinue | Remove-NetFirewallRule`,
    `New-NetFirewallRule -DisplayName ${name} -Description ${psQuote('Connexions entrantes des participants aux sessions CoForge (réseaux privés et publics).')} -Direction Inbound -Action Allow -Program $exe -Protocol TCP -Profile Domain,Private,Public | Out-Null`,
  ].join('\n');
}

/** Commande PowerShell encodée (UTF-16LE base64) : aucun problème de guillemets. */
export function encodePs(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function categoryLabel(category: string): string {
  return category === 'Public' ? 'Public' : category === 'Private' ? 'Privé' : category === 'DomainAuthenticated' ? 'Domaine' : category;
}

/** Profil du pare-feu correspondant à une catégorie de réseau. */
function profileName(category: string): string {
  return category === 'DomainAuthenticated' ? 'Domain' : category;
}

/** Verdict à partir de l'état brut (fonction pure). */
export function evaluateFirewall(raw: FirewallRaw): FirewallStatus {
  const networks: FirewallStatus['networks'] = [];
  for (const p of raw.profiles ?? []) {
    const bit = PROFILE_BITS[p.category] ?? 4;
    const fw = (raw.firewall ?? []).find((f) => f.name === profileName(p.category));
    const matches = (r: FirewallRule) => r.enabled && (r.profile === 0 || (r.profile & bit) !== 0);
    const blocked = fw?.enabled !== false && (raw.rules ?? []).some((r) => matches(r) && r.action === 'Block');
    // Pare-feu désactivé pour ce profil, ou entrées autorisées par défaut : rien à faire.
    const open = fw?.enabled === false || fw?.inbound === 'Allow';
    const allowed = !blocked && (open || (raw.rules ?? []).some((r) => matches(r) && r.action === 'Allow'));
    networks.push({ name: p.name || p.alias, category: categoryLabel(p.category), allowed, blocked });
  }
  const bad = networks.filter((n) => !n.allowed);
  let message = '';
  if (bad.length > 0) {
    const what = bad.map((n) => `« ${n.name} » (profil ${n.category})`).join(', ');
    message = bad.some((n) => n.blocked)
      ? `Le pare-feu Windows BLOQUE CoForge sur ${what} : les invités ne peuvent pas se connecter.`
      : `Le pare-feu Windows n’autorise pas CoForge sur ${what} : les invités risquent d’être bloqués.`;
  }
  return { ok: bad.length === 0, networks, message };
}

/** Lit la sortie JSON du script de lecture (tolère un objet unique à la place d'un tableau). */
export function parseCheckOutput(stdout: string): FirewallRaw {
  const data = JSON.parse(stdout.trim() || '{}') as Record<string, unknown>;
  const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : v && typeof v === 'object' ? [v as T] : []);
  return {
    profiles: list<FirewallRaw['profiles'][number]>(data.profiles).map((p) => ({ name: String(p.name ?? ''), alias: String(p.alias ?? ''), category: String(p.category ?? '') })),
    rules: list<FirewallRule>(data.rules).map((r) => ({ name: String(r.name ?? ''), enabled: r.enabled === true, action: String(r.action ?? ''), profile: Number(r.profile) || 0 })),
    firewall: list<FirewallRaw['firewall'][number]>(data.firewall).map((f) => ({ name: String(f.name ?? ''), enabled: f.enabled !== false, inbound: String(f.inbound ?? '') })),
  };
}

function runPowerShell(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr ?? '') }));
      else resolve(String(stdout));
    });
  });
}

/** État du pare-feu pour `exe` ; null hors Windows ou si la lecture échoue. */
export async function checkFirewall(exe: string): Promise<FirewallStatus | null> {
  if (process.platform !== 'win32') return null;
  try {
    const out = await runPowerShell(['-EncodedCommand', encodePs(buildCheckScript(exe))], 20_000);
    return evaluateFirewall(parseCheckOutput(out));
  } catch (err) {
    console.warn(`[pare-feu] lecture impossible : ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Crée la règle entrante (Privé + Public + Domaine) : Windows demande l'autorisation
 * d'administrateur (UAC). Rejette avec un message en français si l'utilisateur refuse.
 */
export async function allowInFirewall(exe: string): Promise<FirewallStatus | null> {
  if (process.platform !== 'win32') throw new Error('Disponible uniquement sous Windows');
  const inner = encodePs(buildFixScript(exe));
  // Processus non élevé qui lance la version élevée et attend son code de sortie.
  const outer = [
    "$ErrorActionPreference = 'Stop'",
    `$p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${inner}'`,
    'exit $p.ExitCode',
  ].join('\n');
  try {
    await runPowerShell(['-EncodedCommand', encodePs(outer)], 120_000);
  } catch (err) {
    const text = `${(err as { stderr?: string }).stderr ?? ''} ${(err as Error).message ?? ''}`;
    if (/annul|cancel/i.test(text)) throw new Error('Autorisation d’administrateur refusée : la règle de pare-feu n’a pas été créée');
    throw new Error('La règle de pare-feu n’a pas pu être créée (droits d’administrateur nécessaires)');
  }
  return checkFirewall(exe);
}
