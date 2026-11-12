/**
 * SDNA : description, embarquée dans chaque .blend (bloc `DNA1`), de toutes les structures C
 * telles que la version de Blender qui a écrit le fichier les connaissait. C'est la seule source
 * des décalages de champs : rien n'est codé en dur, un champ absent est simplement « absent ».
 */

export interface SdnaField {
  /** Nom nu, sans étoiles ni crochets (`*next` → `next`, `mat[4][4]` → `mat`). */
  name: string;
  /** Nom du type (`float`, `ID`, `ListBase`…). */
  type: string;
  typeIndex: number;
  /** Décalage dans la structure, en octets. */
  offset: number;
  /** Taille totale du champ (tous éléments). */
  size: number;
  /** Taille d'un élément. */
  elemSize: number;
  /** Nombre d'éléments (produit des dimensions ; 1 pour un scalaire). */
  count: number;
  pointer: boolean;
  /** Indice de la structure du type, -1 pour un type simple ou un pointeur. */
  struct: number;
  /** Nature numérique de l'élément (voir NumKind), 0 si ce n'est pas un nombre. */
  kind: number;
}

/** Codes du champ `kind` : nature numérique d'un élément. */
export const NumKind = { none: 0, i8: 1, u8: 2, i16: 3, u16: 4, i32: 5, u32: 6, f32: 7, f64: 8, i64: 9, u64: 10 } as const;

function numKind(type: string, size: number): number {
  switch (type) {
    case 'char':
    case 'int8_t':
      return NumKind.i8;
    case 'uchar':
    case 'uint8_t':
    case 'bool':
      return NumKind.u8;
    case 'short':
    case 'int16_t':
      return NumKind.i16;
    case 'ushort':
    case 'uint16_t':
      return NumKind.u16;
    case 'int':
    case 'int32_t':
      return NumKind.i32;
    case 'uint':
    case 'uint32_t':
      return NumKind.u32;
    case 'long':
      return size === 8 ? NumKind.i64 : NumKind.i32;
    case 'ulong':
      return size === 8 ? NumKind.u64 : NumKind.u32;
    case 'float':
      return NumKind.f32;
    case 'double':
      return NumKind.f64;
    case 'int64_t':
      return NumKind.i64;
    case 'uint64_t':
      return NumKind.u64;
    default:
      return NumKind.none;
  }
}

export interface SdnaStruct {
  index: number;
  name: string;
  size: number;
  fields: SdnaField[];
  byName: Map<string, SdnaField>;
}

export interface Sdna {
  structs: SdnaStruct[];
  byName: Map<string, SdnaStruct>;
  pointerSize: number;
}

const MAX_NAMES = 1 << 20;
const MAX_STRUCTS = 1 << 17;

/** Lit le bloc DNA1. Lève une erreur (en français) si le bloc est incohérent. */
export function parseSdna(bytes: Uint8Array, start: number, length: number, littleEndian: boolean, pointerSize: number): Sdna {
  const end = start + length;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bad = (what: string): never => {
    throw new Error(`Fichier .blend corrompu : catalogue des structures (SDNA) invalide (${what}).`);
  };
  let p = start;
  const tag = (t: string): void => {
    if (p + 4 > end) bad(`« ${t} » hors du bloc`);
    for (let i = 0; i < 4; i++) if (bytes[p + i] !== t.charCodeAt(i)) bad(`« ${t} » attendu`);
    p += 4;
  };
  const int = (): number => {
    if (p + 4 > end) bad('fin inattendue');
    const v = view.getInt32(p, littleEndian);
    p += 4;
    return v;
  };
  const short = (): number => {
    if (p + 2 > end) bad('fin inattendue');
    const v = view.getUint16(p, littleEndian);
    p += 2;
    return v;
  };
  const align = (): void => {
    p = start + (((p - start + 3) >> 2) << 2);
  };
  const strings = (count: number): string[] => {
    const out: string[] = new Array(count);
    for (let i = 0; i < count; i++) {
      let e = p;
      while (e < end && bytes[e] !== 0) e++;
      if (e >= end) bad('chaîne non terminée');
      let s = '';
      for (let k = p; k < e; k++) s += String.fromCharCode(bytes[k]);
      out[i] = s;
      p = e + 1;
    }
    return out;
  };

  tag('SDNA');
  tag('NAME');
  const nameCount = int();
  if (nameCount <= 0 || nameCount > MAX_NAMES || nameCount > length) bad('nombre de noms');
  const names = strings(nameCount);
  align();
  tag('TYPE');
  const typeCount = int();
  if (typeCount <= 0 || typeCount > MAX_NAMES || typeCount > length) bad('nombre de types');
  const types = strings(typeCount);
  align();
  tag('TLEN');
  const sizes = new Array<number>(typeCount);
  for (let i = 0; i < typeCount; i++) sizes[i] = short();
  align();
  tag('STRC');
  const structCount = int();
  if (structCount <= 0 || structCount > MAX_STRUCTS || structCount * 4 > length) bad('nombre de structures');

  // Première passe : types et champs bruts ; les structures peuvent se référencer dans n'importe quel ordre.
  const raw: { type: number; fields: [number, number][] }[] = [];
  const structOfType = new Map<number, number>();
  for (let s = 0; s < structCount; s++) {
    const type = short();
    const fieldCount = short();
    if (type >= typeCount) bad('type de structure');
    if (p + fieldCount * 4 > end) bad('champs hors du bloc');
    const fields: [number, number][] = new Array(fieldCount);
    for (let f = 0; f < fieldCount; f++) {
      const ft = short();
      const fn = short();
      if (ft >= typeCount || fn >= nameCount) bad('champ');
      fields[f] = [ft, fn];
    }
    raw.push({ type, fields });
    if (!structOfType.has(type)) structOfType.set(type, s);
  }

  const structs: SdnaStruct[] = [];
  const byName = new Map<string, SdnaStruct>();
  for (let s = 0; s < structCount; s++) {
    const r = raw[s];
    const fields: SdnaField[] = [];
    const fieldsByName = new Map<string, SdnaField>();
    let offset = 0;
    for (const [ft, fn] of r.fields) {
      const full = names[fn];
      const pointer = full.charCodeAt(0) === 42 /* * */ || full.charCodeAt(0) === 40; /* ( : pointeur de fonction */
      let count = 1;
      let base = full;
      const bracket = full.indexOf('[');
      if (bracket >= 0) {
        base = full.slice(0, bracket);
        const re = /\[(\d+)\]/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(full))) count *= parseInt(m[1], 10);
      }
      base = base.replace(/^[*(]+/, '').replace(/\).*$/, '');
      const elemSize = pointer ? pointerSize : sizes[ft];
      const size = elemSize * count;
      const field: SdnaField = {
        name: base,
        type: types[ft],
        typeIndex: ft,
        offset,
        size,
        elemSize,
        count,
        pointer,
        struct: pointer ? -1 : (structOfType.get(ft) ?? -1),
        kind: pointer ? NumKind.none : numKind(types[ft], sizes[ft]),
      };
      fields.push(field);
      if (!fieldsByName.has(base)) fieldsByName.set(base, field);
      offset += size;
    }
    const st: SdnaStruct = { index: s, name: types[r.type], size: sizes[r.type], fields, byName: fieldsByName };
    structs.push(st);
    if (!byName.has(st.name)) byName.set(st.name, st);
  }
  return { structs, byName, pointerSize };
}
