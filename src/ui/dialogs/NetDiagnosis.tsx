import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Copy, Globe, Link2, Network, ShieldAlert, ShieldCheck, XCircle } from 'lucide-react';
import { allowHostInFirewall, refreshHostDiagnostics, testConnection, useSessionUi, type ConnectionTest, type InviteAlternative } from '../../app/session';
import { toast } from '../../app/store';
import type { InviteLink } from '../../net/invite';
import { selfReachWarning, type AddressKind } from '../../net/netdiag';
import { maskIps } from '../lib/privacy';
import { Hint, IconButton } from '../widgets/basic';

/**
 * Diagnostic réseau des sessions : test de connexion explicite côté invité, portée des adresses
 * et pare-feu côté hôte, aide « travailler à distance ».
 */

function errorText(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

// ------------------------------------------------------------------ invité : tester la connexion

/** Résultat d'un test de connexion : constat, causes, solutions. */
export function DiagnosisView({ test }: { test: ConnectionTest }) {
  const d = test.diagnosis;
  const Icon = d.severity === 'ok' ? CheckCircle2 : d.severity === 'warn' ? AlertTriangle : XCircle;
  return (
    <div className={`cf-diag is-${d.severity}`} role="status">
      <div className="cf-diag-title">
        <Icon size={14} /> <span>{d.title}</span>
      </div>
      {d.details.map((t) => (
        <p key={t} className="cf-diag-detail">
          {t}
        </p>
      ))}
      {d.solutions.length > 0 && (
        <>
          <div className="cf-diag-sub">Solutions :</div>
          <ol className="cf-diag-solutions">
            {d.solutions.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

/**
 * Bouton « Tester la connexion » et son diagnostic. `runKey` : chaque nouvelle valeur non nulle
 * relance le test (ex. après un échec de connexion « serveur injoignable »).
 */
export function ConnectionTester({ target, runKey = 0, disabled }: { target: string | InviteLink | null; runKey?: number; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConnectionTest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const key = target === null ? '' : typeof target === 'string' ? target : `${target.host}:${target.port}`;

  const run = () => {
    if (!target) return;
    const id = ++seq.current;
    setBusy(true);
    setError(null);
    testConnection(target)
      .then((r) => id === seq.current && setResult(r))
      .catch((err) => id === seq.current && setError(errorText(err)))
      .finally(() => id === seq.current && setBusy(false));
  };

  // L'adresse change : l'ancien diagnostic ne vaut plus.
  useEffect(() => {
    seq.current++;
    setResult(null);
    setError(null);
    setBusy(false);
  }, [key]);

  useEffect(() => {
    if (runKey > 0) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey]);

  return (
    <div className="cf-diag-box">
      <div className="cf-invite-row">
        <button type="button" className="cf-btn" disabled={disabled || busy || !target} onClick={run} data-tip="Vérifie que l’adresse répond, et explique pourquoi sinon">
          <Network size={12} /> {busy ? 'Test en cours…' : 'Tester la connexion'}
        </button>
        {busy && <span className="cf-dim">jusqu’à 6 s</span>}
      </div>
      {error && <div className="cf-form-error">{error}</div>}
      {result && !busy && <DiagnosisView test={result} />}
    </div>
  );
}

// ------------------------------------------------------------------ aide « à distance »

/** Les trois façons de travailler à plusieurs hors d'un même réseau local. */
export function RemoteHelp({ open }: { open?: boolean }) {
  return (
    <details className="cf-diag-help" open={open}>
      <summary>Aide : se connecter depuis un autre réseau</summary>
      <p>
        Une adresse de réseau local (10.x, 172.16-31.x, 192.168.x) ne fonctionne que pour les PC branchés sur le <b>même réseau</b> (même box, même
        Wi-Fi). Depuis un autre réseau (chez soi, en 4G), la connexion ne peut pas aboutir. Sur un réseau d’école, d’entreprise ou d’hôtel,
        l’<b>isolation des clients Wi-Fi</b> empêche souvent les PC de se joindre, même sur le même Wi-Fi.
      </p>
      <ol>
        <li>
          <b>VPN maillé</b> (le plus simple) : installez <b>Tailscale</b> ou <b>ZeroTier</b> (gratuits) sur les deux PC, connectés au même compte
          ou au même réseau. L’hôte relance « Inviter » : le lien utilise alors son adresse VPN (100.x.x.x), joignable de partout.
        </li>
        <li>
          <b>Serveur CoForge autonome</b> sur une machine joignable par tous (serveur, VPS, PC dont la box redirige le port). Le fichier{' '}
          <code>resources/coforge-server.cjs</code> du dossier d’installation de CoForge se lance avec Node.js 20 :
          <pre>node coforge-server.cjs --port 4455 --password &lt;mot-de-passe&gt; --data ./sessions --invite atelier</pre>
          Il affiche des liens d’invitation (valables 24 h) pour la salle « atelier » : chacun rejoint avec ce lien, personne n’héberge. Ouvrez le port
          4455 (TCP) dans le pare-feu de cette machine.
        </li>
        <li>
          <b>Redirection de port</b> sur la box de l’hôte : associez le port 4455 (TCP) à l’adresse locale de son PC, puis envoyez le lien avec
          l’adresse Internet (bouton « Afficher l’adresse Internet »). Impossible sur un réseau d’école ou derrière un partage 4G.
        </li>
      </ol>
    </details>
  );
}

// ------------------------------------------------------------------ hôte : adresses et pare-feu

const KIND_CLASS: Record<AddressKind, string> = {
  tunnel: 'is-vpn',
  vpn: 'is-vpn',
  lan: 'is-lan',
  public: 'is-public',
  name: 'is-lan',
  cgnat: 'is-bad',
  'link-local': 'is-bad',
  loopback: 'is-bad',
};

/** Liste des liens par adresse, chacun avec sa portée (« fonctionne seulement sur le même réseau local »…). */
export function AddressList({ alternatives, onCopy, masked = false }: { alternatives: InviteAlternative[]; onCopy(link: string): void; masked?: boolean }) {
  return (
    <div className="cf-addr-list">
      {alternatives.map((a, i) => (
        <div key={a.address} className={`cf-addr ${KIND_CLASS[a.kind]}${i === 0 ? ' is-primary' : ''}`}>
          <span className="cf-addr-badge">{a.label}</span>
          <code data-tip={a.iface ? `Interface « ${a.iface} »` : undefined}>{masked ? maskIps(a.address) : a.address}</code>
          <IconButton icon={Link2} tip="Copier le lien pour cette adresse" onClick={() => onCopy(a.link)} />
          <div className="cf-addr-reach">{a.reach}</div>
        </div>
      ))}
    </div>
  );
}

/** Hôte : pare-feu Windows (profil Public !) et joignabilité du serveur depuis ses propres adresses. */
export function HostNetworkCheck() {
  const diag = useSessionUi((s) => s.hostDiag);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!diag) {
      setChecking(true);
      void refreshHostDiagnostics().finally(() => setChecking(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tunnel tout neuf : son nom met quelques secondes à être publié par Cloudflare ; on revérifie seul.
  const tunnelRetries = useRef(0);
  const tunnelUnreached = !!diag?.tunnel && selfReachWarning(diag.selfReach) !== null;
  useEffect(() => {
    if (!tunnelUnreached || tunnelRetries.current >= 6) return;
    tunnelRetries.current++;
    const timer = setTimeout(() => {
      setChecking(true);
      void refreshHostDiagnostics().finally(() => setChecking(false));
    }, 4000);
    return () => clearTimeout(timer);
  }, [tunnelUnreached, diag]);

  if (diag?.tunnel) {
    const reach = selfReachWarning(diag.selfReach);
    return (
      <div className="cf-invite-section">
        <h4>Sécurité de la connexion</h4>
        <div className={`cf-diag ${reach ? 'is-warn' : 'is-ok'}`}>
          <div className="cf-diag-title">
            {reach ? <AlertTriangle size={14} /> : <ShieldCheck size={14} />}
            <span>{reach ? 'Le tunnel ne répond pas encore depuis Internet : patientez quelques secondes puis revérifiez.' : 'Tunnel chiffré actif et joignable depuis Internet.'}</span>
          </div>
          <p className="cf-diag-detail">
            Le serveur n’écoute que sur cette machine (aucune connexion entrante, rien à ouvrir dans le pare-feu ni sur la box). Les invités passent par Cloudflare en
            wss:// (TLS) : votre adresse IP ne figure pas dans le lien et ils ne la voient pas. L’adresse du tunnel change à chaque session et disparaît à l’arrêt ; seuls
            les liens d’invitation (jetons révocables) donnent accès à la salle.
          </p>
        </div>
        <div className="cf-invite-row">
          <button
            type="button"
            className="cf-btn"
            disabled={checking}
            onClick={() => {
              setChecking(true);
              void refreshHostDiagnostics().finally(() => setChecking(false));
            }}
          >
            {checking ? 'Vérification…' : 'Revérifier'}
          </button>
        </div>
      </div>
    );
  }

  const fw = diag?.firewall ?? null;
  const reach = diag ? selfReachWarning(diag.selfReach) : null;
  const allow = () => {
    setBusy(true);
    setError(null);
    allowHostInFirewall()
      .then(() => toast('Règle de pare-feu créée pour les réseaux privés et publics'))
      .catch((err) => setError(errorText(err)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="cf-invite-section">
      <h4>Pare-feu et joignabilité</h4>
      {checking && !diag && <div className="cf-invite-meta">Vérification du pare-feu…</div>}
      {fw && fw.ok && (
        <div className="cf-diag is-ok">
          <div className="cf-diag-title">
            <ShieldCheck size={14} />
            <span>Pare-feu Windows : CoForge est autorisé ({fw.networks.map((n) => `${n.name}, profil ${n.category}`).join(' ; ') || 'aucun réseau'}).</span>
          </div>
        </div>
      )}
      {fw && !fw.ok && (
        <div className="cf-diag is-error">
          <div className="cf-diag-title">
            <ShieldAlert size={14} /> <span>{fw.message}</span>
          </div>
          <p className="cf-diag-detail">
            Windows ne coche par défaut que les réseaux « privés » ; un réseau d’école, d’entreprise ou public est classé « Public ». Le bouton ci-dessous
            crée une règle entrante pour CoForge sur les profils Privé, Public et Domaine (Windows demande l’autorisation d’administrateur).
          </p>
        </div>
      )}
      {diag && !fw && <Hint>État du pare-feu illisible : si personne n’arrive à se connecter, autorisez CoForge dans le pare-feu Windows pour les réseaux privés ET publics.</Hint>}
      {reach && (
        <div className="cf-diag is-warn">
          <div className="cf-diag-title">
            <AlertTriangle size={14} /> <span>{reach}</span>
          </div>
        </div>
      )}
      {error && <div className="cf-form-error">{error}</div>}
      <div className="cf-invite-row">
        {(!fw || !fw.ok) && (
          <button type="button" className="cf-btn is-accent" disabled={busy} onClick={allow}>
            <ShieldCheck size={12} /> {busy ? 'En attente de Windows…' : 'Autoriser dans le pare-feu (Privé et Public)'}
          </button>
        )}
        <button
          type="button"
          className="cf-btn"
          disabled={checking}
          onClick={() => {
            setChecking(true);
            void refreshHostDiagnostics().finally(() => setChecking(false));
          }}
        >
          {checking ? 'Vérification…' : 'Revérifier'}
        </button>
      </div>
    </div>
  );
}

/** Ligne « adresse Internet » (obtenue sur clic explicite) avec son lien et sa condition. */
export function PublicAddressRow({ alt, ip, masked = false }: { alt: InviteAlternative | null; ip: string; masked?: boolean }) {
  return (
    <div className="cf-addr is-public">
      <span className="cf-addr-badge">
        <Globe size={10} /> Internet
      </span>
      <code>{masked ? maskIps(alt ? alt.address : ip) : alt ? alt.address : ip}</code>
      <IconButton
        icon={alt ? Link2 : Copy}
        tip={alt ? 'Copier le lien avec l’adresse Internet' : 'Copier'}
        onClick={() => {
          void navigator.clipboard.writeText(alt ? alt.link : ip).then(() => toast(alt ? 'Lien (adresse Internet) copié' : 'Adresse copiée'));
        }}
      />
      <div className="cf-addr-reach">{alt?.reach ?? 'Nécessite une redirection de port sur la box vers cette machine'}</div>
    </div>
  );
}
