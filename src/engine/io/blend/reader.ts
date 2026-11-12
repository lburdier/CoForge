import { CODE_DATA, type BlendFile, type Ptr } from './file';
import { NumKind, type SdnaField, type SdnaStruct } from './sdna';

/** Un nom de champ, ou ses noms successifs selon les versions de Blender (le premier présent gagne). */
export type FieldName = string | readonly string[];

/** Longueur maximale parcourue dans une liste chaînée (au-delà : fichier corrompu, on s'arrête). */
const MAX_LIST = 4_000_000;

const utf8 = new TextDecoder('utf-8');

/**
 * Vue sur UNE structure du fichier (un élément d'un bloc, ou une structure imbriquée). Tous les
 * accès passent par le SDNA du fichier : un champ inconnu de la version qui a écrit le fichier
 * renvoie la valeur par défaut, jamais une erreur.
 */
export class Rec {
  constructor(
    readonly file: BlendFile,
    /** Bloc qui contient la structure. */
    readonly block: number,
    /** Position absolue de la structure dans le fichier. */
    readonly pos: number,
    readonly st: SdnaStruct,
  ) {}

  field(name: FieldName): SdnaField | undefined {
    if (typeof name === 'string') return this.st.byName.get(name);
    for (const n of name) {
      const f = this.st.byName.get(n);
      if (f) return f;
    }
    return undefined;
  }

  has(name: FieldName): boolean {
    return this.field(name) !== undefined;
  }

  private read(f: SdnaField, index: number): number {
    const p = this.pos + f.offset + index * f.elemSize;
    const v = this.file.view;
    const le = this.file.littleEndian;
    switch (f.kind) {
      case NumKind.i8:
        return v.getInt8(p);
      case NumKind.u8:
        return v.getUint8(p);
      case NumKind.i16:
        return v.getInt16(p, le);
      case NumKind.u16:
        return v.getUint16(p, le);
      case NumKind.i32:
        return v.getInt32(p, le);
      case NumKind.u32:
        return v.getUint32(p, le);
      case NumKind.f32:
        return v.getFloat32(p, le);
      case NumKind.f64:
        return v.getFloat64(p, le);
      case NumKind.i64:
        return Number(v.getBigInt64(p, le));
      case NumKind.u64:
        return Number(v.getBigUint64(p, le));
      default:
        return NaN;
    }
  }

  /** Valeur numérique d'un champ (élément `index` d'un tableau), `def` si le champ est absent. */
  num(name: FieldName, def = 0, index = 0): number {
    const f = this.field(name);
    if (!f || f.kind === NumKind.none || index < 0 || index >= f.count) return def;
    const v = this.read(f, index);
    return Number.isNaN(v) ? def : v;
  }

  /** Tableau numérique (au plus `count` éléments), null si le champ est absent. */
  nums(name: FieldName, count?: number): number[] | null {
    const f = this.field(name);
    if (!f || f.kind === NumKind.none) return null;
    const n = Math.min(count ?? f.count, f.count);
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) out[i] = this.read(f, i);
    return out;
  }

  /** Chaîne C (UTF-8) d'un champ `char nom[N]` ; '' si absent. */
  str(name: FieldName): string {
    const f = this.field(name);
    if (!f || f.pointer) return '';
    const bytes = this.file.bytes;
    const start = this.pos + f.offset;
    let end = start;
    const limit = start + f.size;
    while (end < limit && bytes[end] !== 0) end++;
    return utf8.decode(bytes.subarray(start, end));
  }

  /** Pointeur brut (ancienne adresse), 0 si nul ou absent. */
  ptr(name: FieldName, index = 0): Ptr {
    const f = this.field(name);
    if (!f || !f.pointer || index < 0 || index >= f.count) return 0;
    return this.file.readPtr(this.pos + f.offset + index * f.elemSize);
  }

  /** Structure imbriquée (champ non pointeur de type structure), null si absente. */
  sub(name: FieldName, index = 0): Rec | null {
    const f = this.field(name);
    if (!f || f.pointer || f.struct < 0 || index < 0 || index >= f.count) return null;
    return new Rec(this.file, this.block, this.pos + f.offset + index * f.elemSize, this.file.sdna.structs[f.struct]);
  }

  /** Bloc de DONNÉES pointé par un champ, -1 si nul, absent ou introuvable. */
  target(name: FieldName, index = 0): number {
    return this.file.resolve(this.ptr(name, index), this.block);
  }

  /**
   * Structure pointée par un champ (données appartenant au même ID). `hint` nomme la structure
   * attendue quand le bloc a été écrit « brut », sans type (anciens fichiers).
   */
  get(name: FieldName, hint?: string): Rec | null {
    return recAt(this.file, this.target(name), 0, hint);
  }

  /** Bloc d'ID (objet, maillage, matériau…) pointé par un champ, null si nul ou absent du fichier. */
  id(name: FieldName, index = 0): Rec | null {
    return recAt(this.file, this.file.resolveId(this.ptr(name, index)), 0);
  }

  /** Éléments d'une liste chaînée `ListBase` (champ imbriqué), dans l'ordre. */
  list(name: FieldName): Rec[] {
    const lb = this.sub(name);
    return lb ? listFrom(lb) : [];
  }

  /** Nom de l'ID sans son préfixe de type (« OBCube » → « Cube ») ; '' si ce n'est pas un ID. */
  get idName(): string {
    const id = this.st.name === 'ID' ? this : this.sub('id');
    const full = id ? id.str('name') : '';
    return full.length > 2 ? full.slice(2) : '';
  }

  /** Vrai si l'ID vient d'une bibliothèque externe (fichier lié) : seul son nom est dans ce fichier. */
  get isLinked(): boolean {
    if (this.file.codeOf(this.block) === 'ID') return true;
    const id = this.st.name === 'ID' ? this : this.sub('id');
    return !!id && id.ptr('lib') !== 0;
  }
}

/** Structure n° `index` d'un bloc, null si le bloc n'existe pas ou est trop court. */
export function recAt(file: BlendFile, block: number, index = 0, hint?: string): Rec | null {
  if (block < 0 || block >= file.count) return null;
  let st = file.structOf(block);
  // Indice SDNA 0 sur un bloc DATA = données écrites sans type : on se fie à l'appelant.
  if (hint && (!st || (file.sdnaNr[block] === 0 && file.code[block] === CODE_DATA))) st = file.sdna.byName.get(hint) ?? st;
  if (!st || st.size <= 0) return null;
  const offset = index * st.size;
  if (index < 0 || offset + st.size > file.len[block]) return null;
  return new Rec(file, block, file.pos[block] + offset, st);
}

/** Parcourt une `ListBase` (structure { first, last }) en suivant les pointeurs `next`. */
export function listFrom(lb: Rec): Rec[] {
  const out: Rec[] = [];
  const file = lb.file;
  const seen = new Set<number>();
  let block = lb.target('first');
  while (block >= 0 && !seen.has(block) && out.length < MAX_LIST) {
    seen.add(block);
    const rec = recAt(file, block);
    if (!rec) {
      // Élément sans structure exploitable : `next` est toujours le premier champ d'un maillon.
      if (file.len[block] < file.pointerSize) break;
      block = file.resolve(file.readPtr(file.pos[block]), block);
      continue;
    }
    out.push(rec);
    block = rec.has('next') ? rec.target('next') : file.resolve(file.readPtr(rec.pos), block);
  }
  return out;
}

/** Tableau de pointeurs d'ID (ex. `Object.mat`, `Mesh.mat`) : les `count` premiers pointeurs du bloc visé. */
export function idPointerArray(rec: Rec, name: FieldName, count: number): Ptr[] {
  const file = rec.file;
  const block = rec.target(name);
  if (block < 0 || !(count > 0)) return [];
  const n = Math.min(count, Math.floor(file.len[block] / file.pointerSize));
  const out: Ptr[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = file.readPtr(file.pos[block] + i * file.pointerSize);
  return out;
}

/** Description d'un bloc vu comme un tableau de structures. */
export interface StructArray {
  st: SdnaStruct;
  /** Position du premier élément. */
  pos: number;
  /** Nombre d'éléments réellement présents dans le bloc. */
  count: number;
  stride: number;
}

export function structArray(file: BlendFile, block: number, hint?: string): StructArray | null {
  if (block < 0 || block >= file.count) return null;
  let st = file.structOf(block);
  if (hint && (!st || (file.sdnaNr[block] === 0 && file.code[block] === CODE_DATA))) st = file.sdna.byName.get(hint) ?? st;
  if (!st || st.size <= 0) return null;
  const count = Math.max(0, Math.min(file.nr[block], Math.floor(file.len[block] / st.size)));
  return { st, pos: file.pos[block], count, stride: st.size };
}
