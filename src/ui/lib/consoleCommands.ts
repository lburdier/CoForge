import { getApp } from '../../app/context';
import { setFrame, setSelection, store } from '../../app/store';
import type { ObjectData, Vec3 } from '../../core/doc/schema';
import { withOp } from './util';

/**
 * Langage de la console et des scripts de l'éditeur de texte.
 *
 * Pas d'exécution de code arbitraire (pas d'`eval` : la politique de sécurité de l'application
 * l'interdit, et un texte partagé par un collaborateur ne doit pas pouvoir agir hors de la scène).
 * Les commandes passent par le registre d'opérateurs et l'API du document : tout est annulable.
 *
 * Une ligne = une commande ; `#` commence un commentaire.
 */

export interface CommandResult {
  ok: boolean;
  /** Lignes de sortie. */
  out: string[];
  /** Effacer l'historique de la console. */
  clear?: boolean;
}

const PROPS: Record<string, { key: keyof ObjectData; kind: 'vec' | 'string' | 'bool' }> = {
  location: { key: 'pos', kind: 'vec' },
  position: { key: 'pos', kind: 'vec' },
  rotation: { key: 'rot', kind: 'vec' },
  scale: { key: 'scl', kind: 'vec' },
  name: { key: 'name', kind: 'string' },
  visible: { key: 'visible', kind: 'bool' },
  renderable: { key: 'renderable', kind: 'bool' },
};

export const COMMAND_HELP: [string, string][] = [
  ['help', 'cette aide'],
  ['ops [filtre]', 'liste les opérateurs'],
  ['run <opérateur> [{json}]', 'lance un opérateur (ex. run object.add {"type":"cube"})'],
  ['objects', 'liste les objets de la scène'],
  ['select <nom>[, <nom>…]', 'sélectionne des objets par leur nom (* = tous)'],
  ['get <objet> <propriété>', 'lit location, rotation (degrés), scale, name, visible, renderable'],
  ['set <objet> <propriété> <valeur>', 'modifie une propriété (ex. set Cube location 0 0 2)'],
  ['frame [n]', 'image courante (lecture ou changement)'],
  ['undo / redo', 'annuler / rétablir'],
  ['print <texte>', 'affiche un texte'],
  ['stats', 'statistiques de la scène'],
  ['clear', 'efface la console'],
];

function findObject(name: string): ObjectData | null {
  const doc = getApp().doc;
  const all = doc.listObjects();
  return all.find((o) => o.name === name) ?? all.find((o) => o.name.toLowerCase() === name.toLowerCase()) ?? null;
}

/** Découpe « nom avec espaces » prop valeur : le nom peut être entre guillemets. */
function splitArgs(rest: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const fmt = (n: number) => String(Math.round(n * 10000) / 10000);

function vecOut(key: string, v: Vec3): string {
  const r = key === 'rot' ? v.map((x) => (x * 180) / Math.PI) : v;
  return `(${r.map(fmt).join(', ')})`;
}

export function executeCommand(line: string): CommandResult {
  const src = line.replace(/\s+#.*$/, '').trim();
  if (!src || src.startsWith('#')) return { ok: true, out: [] };
  const sp = src.search(/\s/);
  const cmd = (sp < 0 ? src : src.slice(0, sp)).toLowerCase();
  const rest = sp < 0 ? '' : src.slice(sp + 1).trim();
  const app = getApp();
  const doc = app.doc;
  try {
    switch (cmd) {
      case 'help':
      case '?':
        return { ok: true, out: COMMAND_HELP.map(([a, b]) => `${a.padEnd(34)} ${b}`) };
      case 'clear':
        return { ok: true, out: [], clear: true };
      case 'print':
      case 'echo':
        return { ok: true, out: [rest] };
      case 'ops': {
        const f = rest.toLowerCase();
        const list = app.ops
          .list()
          .filter((o) => !f || o.id.toLowerCase().includes(f) || o.label.toLowerCase().includes(f))
          .sort((a, b) => a.id.localeCompare(b.id));
        return { ok: true, out: list.length ? list.slice(0, 300).map((o) => `${o.id.padEnd(34)} ${o.label}`) : ['Aucun opérateur ne correspond.'] };
      }
      case 'run': {
        const m = /^(\S+)\s*(.*)$/.exec(rest);
        if (!m) return { ok: false, out: ['Usage : run <opérateur> [{json}]'] };
        const id = m[1];
        if (!app.ops.get(id)) return { ok: false, out: [`Opérateur inconnu : ${id} (voir « ops »)`] };
        let args: Record<string, unknown> = {};
        if (m[2]) {
          const parsed = JSON.parse(m[2]);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, out: ['Les arguments doivent être un objet JSON : {"clé": valeur}'] };
          args = parsed;
        }
        if (!app.ops.canRun(id)) return { ok: false, out: [`${id} : indisponible dans le contexte actuel`] };
        const ok = app.ops.run(id, args);
        if (app.ops.modalActive) app.ops.endModal(true);
        return { ok, out: ok ? [] : [`${id} : rien n’a été fait`] };
      }
      case 'objects':
      case 'ls': {
        const list = doc.listObjects();
        return { ok: true, out: list.length ? list.map((o) => `${o.name.padEnd(28)} ${o.type}`) : ['(scène vide)'] };
      }
      case 'select': {
        if (!rest) return { ok: false, out: ['Usage : select <nom>[, <nom>…]'] };
        if (rest === '*') {
          setSelection(doc.listObjects().map((o) => o.id));
          return { ok: true, out: [] };
        }
        const names = rest.split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
        const ids: string[] = [];
        const missing: string[] = [];
        for (const n of names) {
          const o = findObject(n);
          if (o) ids.push(o.id);
          else missing.push(n);
        }
        setSelection(ids);
        return { ok: missing.length === 0, out: missing.length ? [`Introuvable : ${missing.join(', ')}`] : [] };
      }
      case 'get':
      case 'set': {
        const a = splitArgs(rest);
        if (a.length < 2) return { ok: false, out: [`Usage : ${cmd} <objet> <propriété>${cmd === 'set' ? ' <valeur>' : ''}`] };
        const o = findObject(a[0]);
        if (!o) return { ok: false, out: [`Objet introuvable : ${a[0]}`] };
        const prop = PROPS[a[1].toLowerCase()];
        if (!prop) return { ok: false, out: [`Propriété inconnue : ${a[1]} (${Object.keys(PROPS).join(', ')})`] };
        if (cmd === 'get') {
          const v = o[prop.key];
          return { ok: true, out: [prop.kind === 'vec' ? vecOut(prop.key, v as Vec3) : String(v)] };
        }
        const vals = a.slice(2);
        let value: unknown;
        if (prop.kind === 'vec') {
          const nums = vals.join(' ').replace(/[(),]/g, ' ').split(/\s+/).filter(Boolean).map(Number);
          if (nums.length === 1) nums.push(nums[0], nums[0]);
          if (nums.length !== 3 || nums.some((n) => !Number.isFinite(n))) return { ok: false, out: ['Valeur attendue : trois nombres (x y z)'] };
          value = prop.key === 'rot' ? nums.map((x) => (x * Math.PI) / 180) : nums;
        } else if (prop.kind === 'bool') {
          const t = (vals[0] ?? '').toLowerCase();
          if (!['true', 'false', 'oui', 'non', '1', '0'].includes(t)) return { ok: false, out: ['Valeur attendue : true ou false'] };
          value = ['true', 'oui', '1'].includes(t);
        } else {
          value = vals.join(' ').slice(0, 63);
          if (!value) return { ok: false, out: ['Nom vide'] };
        }
        withOp((d) => d.updateObject(o.id, { [prop.key]: value } as Partial<ObjectData>));
        app.viewport.requestRender();
        return { ok: true, out: [] };
      }
      case 'frame': {
        if (!rest) return { ok: true, out: [String(store.getState().frame)] };
        const n = Number(rest);
        if (!Number.isFinite(n)) return { ok: false, out: ['Usage : frame <nombre>'] };
        setFrame(Math.round(n));
        return { ok: true, out: [] };
      }
      case 'undo':
        doc.undo();
        return { ok: true, out: [] };
      case 'redo':
        doc.redo();
        return { ok: true, out: [] };
      case 'stats': {
        const objs = doc.listObjects();
        let verts = 0;
        let faces = 0;
        for (const o of objs) {
          if (o.type !== 'mesh' || !o.data) continue;
          const m = doc.getMesh(o.data);
          if (m) {
            verts += m.verts.size;
            faces += m.faces.size;
          }
        }
        return { ok: true, out: [`Objets : ${objs.length} · Sommets : ${verts} · Faces : ${faces} · Matériaux : ${doc.listMaterials().length}`] };
      }
      default:
        return { ok: false, out: [`Commande inconnue : ${cmd} (tapez « help »)`] };
    }
  } catch (err) {
    return { ok: false, out: [`Erreur : ${(err as Error)?.message ?? String(err)}`] };
  }
}

/** Exécute un script ligne à ligne ; s'arrête à la première erreur. */
export function runScript(text: string): { ok: boolean; out: string[]; line: number | null } {
  const out: string[] = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const r = executeCommand(lines[i]);
    out.push(...r.out);
    if (!r.ok) return { ok: false, out: [...out, `Ligne ${i + 1} : arrêt du script.`], line: i + 1 };
  }
  return { ok: true, out, line: null };
}
