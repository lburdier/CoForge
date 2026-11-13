import { useSyncExternalStore } from 'react';
import type { AppContext } from '../../app/context';
import { toast } from '../../app/store';
import type { Vec3 } from '../../core/doc/schema';
import type { Peer, PresenceCamera } from '../../net/api';
import { logInfo } from './infoLog';

/**
 * Outils de travail à plusieurs, par la présence (rien n'est écrit dans le document) :
 *  - activité : la dernière opération de chacun apparaît dans l'éditeur Info des autres ;
 *  - signal 3D (Q) : un repère « regardez ici » visible quelques secondes chez tous ;
 *  - « Amener l'équipe à ma vue » (Maj+Q) : les autres reçoivent une invitation à rejoindre la vue ;
 *  - arrivées / départs notés dans Info, avertissement si quelqu'un édite déjà le même maillage.
 * Les notes d'équipe, elles, sont dans le document (SceneDoc.listNotes) : voir le panneau Équipe.
 */

export const PING_MS = 6000;

export interface TeamPing {
  key: string;
  name: string;
  color: string;
  point: Vec3;
  time: number;
}

export interface TeamSummon {
  clientId: number;
  name: string;
  color: string;
  camera: PresenceCamera;
  time: number;
}

interface TeamState {
  pings: TeamPing[];
  summon: TeamSummon | null;
}

let state: TeamState = { pings: [], summon: null };
const listeners = new Set<() => void>();
function set(patch: Partial<TeamState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useTeam(): TeamState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}

export function dismissSummon(): void {
  set({ summon: null });
}

function addPing(p: TeamPing): void {
  const now = Date.now();
  set({ pings: [...state.pings.filter((x) => now - x.time < PING_MS && x.key !== p.key), p] });
  setTimeout(() => set({ pings: state.pings.filter((x) => Date.now() - x.time < PING_MS) }), PING_MS + 50);
}

const name = (p: Peer) => p.state?.user?.name || 'Quelqu’un';
const color = (p: Peer) => p.state?.user?.color || '#888888';
const finiteVec = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(x));

let installed = false;

export function installTeamwork(app: AppContext): void {
  if (installed) return;
  installed = true;

  // Activité locale → présence (les opérations qui modifient la scène seulement).
  app.ops.onReport((def) => {
    if (def.undoable === false || def.id.startsWith('team.')) return;
    app.collab.setPresence({ activity: { label: def.label, time: Date.now() } });
  });

  // Présence des autres → journal, signaux, invitations.
  const seenActivity = new Map<number, number>();
  const seenPing = new Map<number, number>();
  const seenSummon = new Map<number, number>();
  const names = new Map<number, string>();
  app.collab.onPeers((peers) => {
    const ids = new Set<number>();
    for (const p of peers) {
      ids.add(p.clientId);
      const st = p.state;
      if (!st) continue;
      if (!names.has(p.clientId)) logInfo('team', `${name(p)} a rejoint la session`);
      names.set(p.clientId, name(p));
      const a = st.activity;
      if (a && typeof a.label === 'string' && Number.isFinite(a.time) && seenActivity.get(p.clientId) !== a.time) {
        if (seenActivity.has(p.clientId) || Date.now() - a.time < 5000) logInfo('team', `${name(p)} : ${a.label.slice(0, 120)}`);
        seenActivity.set(p.clientId, a.time);
      }
      const g = st.ping;
      if (g && finiteVec(g.point) && Number.isFinite(g.time) && seenPing.get(p.clientId) !== g.time) {
        seenPing.set(p.clientId, g.time);
        if (Date.now() - g.time < PING_MS) {
          addPing({ key: `p${p.clientId}`, name: name(p), color: color(p), point: g.point, time: Date.now() });
          logInfo('team', `${name(p)} signale un point de la scène`);
        }
      }
      const s = st.summon;
      if (s && s.camera && finiteVec(s.camera.pos) && finiteVec(s.camera.target) && seenSummon.get(p.clientId) !== s.time) {
        seenSummon.set(p.clientId, s.time);
        if (Date.now() - s.time < 60_000) set({ summon: { clientId: p.clientId, name: name(p), color: color(p), camera: s.camera, time: s.time } });
      }
    }
    for (const [id, n] of [...names]) {
      if (ids.has(id)) continue;
      names.delete(id);
      seenActivity.delete(id);
      logInfo('team', `${n} a quitté la session`);
      if (state.summon?.clientId === id) set({ summon: null });
    }
  });

  // Édition simultanée du même maillage : prévenir (la fusion reste automatique).
  app.store.subscribe((s, prev) => {
    if (s.mode !== 'edit' || prev.mode === 'edit' || !s.activeId) return;
    const others = app.collab.getPeers().filter((p) => p.state?.mode === 'edit' && p.state.activeId === s.activeId);
    if (others.length) {
      toast(`${others.map(name).join(', ')} édite déjà ce maillage : vos modifications seront fusionnées, coordonnez-vous pour éviter de toucher aux mêmes faces.`);
    }
  });

  app.ops.register(
    {
      id: 'team.ping',
      label: 'Signaler ce point à l’équipe',
      description: 'Affiche un repère « regardez ici » chez tous les participants (point sous la souris, sinon centre de la vue)',
      undoable: false,
      exec(a) {
        const vp = a.viewport;
        const m = a.ops.mouse;
        const hit = m ? vp.raycastSurface(m.x, m.y) : null;
        const point: Vec3 = hit ? hit.point : vp.getOrbitTarget();
        const user = a.store.getState().user;
        const time = Date.now();
        addPing({ key: 'self', name: user.name, color: user.color, point, time });
        a.collab.setPresence({ ping: { point, time } });
        if (!a.collab.connected) toast('Hors session : le repère n’est visible que par vous.');
      },
    },
    {
      id: 'team.summon',
      label: 'Amener l’équipe à ma vue',
      description: 'Propose aux autres participants de rejoindre votre point de vue',
      undoable: false,
      exec(a) {
        if (!a.collab.connected) {
          toast('Hors session : personne à inviter.', 'error');
          return false;
        }
        a.collab.setPresence({ summon: { camera: a.viewport.getViewState(), time: Date.now() } });
        toast('Invitation envoyée : les autres peuvent rejoindre votre vue.');
      },
    },
  );
}

/** Accepte l'invitation en cours : la vue rejoint celle de l'invitant (animée). */
export function acceptSummon(app: AppContext): void {
  const s = state.summon;
  if (!s) return;
  app.viewport.setViewState(s.camera, true);
  set({ summon: null });
}
