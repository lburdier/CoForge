import type { BlendFile } from './file';
import type { Rec } from './reader';

/**
 * Avertissements regroupés par cause : chaque cause donne UNE phrase, quel que soit le nombre
 * d'objets concernés (« Animation non reprise (12 objets). »).
 */
export class Notes {
  private readonly entries = new Map<string, { count: number; names: string[]; text: (count: number, names: string) => string }>();

  /** `text` reçoit le nombre d'occurrences et les premiers noms concernés (déjà mis en forme). */
  add(key: string, text: (count: number, names: string) => string, name?: string): void {
    let e = this.entries.get(key);
    if (!e) this.entries.set(key, (e = { count: 0, names: [], text }));
    e.count++;
    if (name && e.names.length < 4 && !e.names.includes(name)) e.names.push(name);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Ajoute les remarques de `other` à celles-ci (comptes additionnés, noms fusionnés). */
  absorb(other: Notes): void {
    for (const [key, e] of other.entries) {
      let mine = this.entries.get(key);
      if (!mine) this.entries.set(key, (mine = { count: 0, names: [], text: e.text }));
      mine.count += e.count;
      for (const n of e.names) if (mine.names.length < 4 && !mine.names.includes(n)) mine.names.push(n);
    }
  }

  list(): string[] {
    const out: string[] = [];
    for (const e of this.entries.values()) {
      const more = e.count > e.names.length && e.names.length > 0 ? '…' : '';
      out.push(e.text(e.count, e.names.map((n) => `« ${n} »`).join(', ') + more));
    }
    return out;
  }
}

/** État partagé par les lecteurs d'une même importation. */
export interface Ctx {
  file: BlendFile;
  /** Version de Blender qui a écrit le fichier (279, 403, 500…). */
  version: number;
  notes: Notes;
  /** Rend la main à la boucle d'événements si la lecture dure depuis trop longtemps. */
  pause(): Promise<void>;
}

/** Fabrique `pause()` : un vrai `await` toutes les `budgetMs` millisecondes au plus. */
export function makePause(budgetMs = 30): () => Promise<void> {
  let last = Date.now();
  return async () => {
    const now = Date.now();
    if (now - last < budgetMs) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    last = Date.now();
  };
}

export const RAD2DEG = 180 / Math.PI;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function finite(v: number, def: number): number {
  return Number.isFinite(v) ? v : def;
}

export type RGB = [number, number, number];

function channel(linear: number): number {
  const c = clamp(finite(linear, 0), 0, 1);
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(clamp(s, 0, 1) * 255);
}

/** Couleur linéaire de Blender (Rec.709 linéaire) → '#rrggbb' sRGB du document. */
export function linearToHex(rgb: readonly number[]): string {
  let out = '#';
  for (let i = 0; i < 3; i++) out += channel(rgb[i] ?? 0).toString(16).padStart(2, '0');
  return out;
}

const HOST_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Copie `count` flottants 32 bits du fichier (toujours une copie : le tampon du fichier peut être libéré). */
export function readFloats(file: BlendFile, pos: number, count: number): Float32Array {
  const out = new Float32Array(count);
  if (file.littleEndian === HOST_LITTLE_ENDIAN) {
    new Uint8Array(out.buffer).set(file.bytes.subarray(pos, pos + count * 4));
  } else {
    for (let i = 0; i < count; i++) out[i] = file.view.getFloat32(pos + i * 4, file.littleEndian);
  }
  return out;
}

/** Copie `count` entiers 32 bits du fichier. */
export function readInts(file: BlendFile, pos: number, count: number): Int32Array {
  const out = new Int32Array(count);
  if (file.littleEndian === HOST_LITTLE_ENDIAN) {
    new Uint8Array(out.buffer).set(file.bytes.subarray(pos, pos + count * 4));
  } else {
    for (let i = 0; i < count; i++) out[i] = file.view.getInt32(pos + i * 4, file.littleEndian);
  }
  return out;
}

// ------------------------------------------------------------------ propriétés d'ID (IDProperty)

const IDP_INT = 1;
const IDP_FLOAT = 2;
const IDP_GROUP = 6;
const IDP_DOUBLE = 8;
const IDP_BOOLEAN = 10;

/** Enfant `name` d'un groupe de propriétés, null s'il n'existe pas. */
export function idPropChild(group: Rec | null, name: string): Rec | null {
  if (!group || group.num('type') !== IDP_GROUP) return null;
  const data = group.sub('data');
  if (!data) return null;
  for (const child of data.list('group')) if (child.str('name') === name) return child;
  return null;
}

/** Valeur numérique d'une propriété (entier, booléen, flottant, double), null sinon. */
export function idPropNumber(prop: Rec | null): number | null {
  if (!prop) return null;
  const data = prop.sub('data');
  const f = data?.field('val');
  if (!data || !f) return null;
  const pos = data.pos + f.offset;
  const view = prop.file.view;
  const le = prop.file.littleEndian;
  switch (prop.num('type')) {
    case IDP_INT:
      return view.getInt32(pos, le);
    case IDP_BOOLEAN:
      return view.getInt8(pos) !== 0 ? 1 : 0;
    case IDP_FLOAT:
      return view.getFloat32(pos, le);
    case IDP_DOUBLE:
      return f.offset + 8 <= data.st.size ? view.getFloat64(pos, le) : null;
    default:
      return null;
  }
}

/**
 * Propriété d'un ID par chemin (`['cycles', 'samples']`). Les réglages des moteurs et des
 * extensions sont dans `properties` jusqu'à Blender 4.x et dans `system_properties` à partir de 5.0.
 */
export function idPropPath(owner: Rec | null, path: readonly string[], fields: readonly string[] = ['system_properties', 'properties']): Rec | null {
  if (!owner) return null;
  const id = owner.st.name === 'ID' || !owner.has('id') ? owner : owner.sub('id');
  if (!id) return null;
  for (const field of fields) {
    let cur: Rec | null = id.get(field);
    for (const name of path) cur = idPropChild(cur, name);
    if (cur) return cur;
  }
  return null;
}
