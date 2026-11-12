import { decompressBlend } from './decompress';
import { parseSdna, type Sdna, type SdnaStruct } from './sdna';

/**
 * Adresse mémoire « ancienne » telle qu'écrite dans le fichier ; 0 = pointeur nul. Les adresses
 * qui dépassent 2^53 (identifiants stables de Blender 5) sont gardées exactes sous forme de chaîne.
 */
export type Ptr = number | string;

function fourcc(s: string): number {
  return ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;
}

export const CODE_DATA = fourcc('DATA');
const CODE_ENDB = fourcc('ENDB');
const CODE_DNA1 = fourcc('DNA1');
const CODE_GLOB = fourcc('GLOB');

/** Jeton de `BlendFile.open` : indexation différée. */
const DEFERRED = Symbol('différé');

/** Garde-fou : aucun fichier réel n'approche ce nombre de blocs. */
const MAX_BLOCKS = 200_000_000;

export function ptrKey(lo: number, hi: number): Ptr {
  if (hi === 0) return lo;
  return hi < 0x200000 ? hi * 4294967296 + lo : `${hi}:${lo}`;
}

/**
 * Fichier .blend décodé au niveau « conteneur » : en-tête, table des blocs, catalogue SDNA et
 * résolution des pointeurs (ancienne adresse → bloc). Aucune connaissance de Blender au-delà.
 */
export class BlendFile {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly littleEndian: boolean;
  readonly pointerSize: number;
  /** Version de Blender qui a écrit le fichier : 279 pour 2.79, 403 pour 4.3, 500 pour 5.0. */
  readonly version: number;
  // Champs remplis par l'indexation des blocs (`index()`), terminée avant toute utilisation.
  sdna!: Sdna;

  /** Nombre de blocs (hors bloc de fin). */
  count!: number;
  /** Code de chaque bloc (4 caractères condensés, voir `codeOf`). */
  code!: Uint32Array;
  /** Position des données de chaque bloc dans `bytes`. */
  pos!: Float64Array;
  /** Longueur des données de chaque bloc, en octets. */
  len!: Float64Array;
  /** Nombre d'éléments de chaque bloc. */
  nr!: Float64Array;
  /** Indice SDNA de la structure de chaque bloc. */
  sdnaNr!: Int32Array;
  /** Bloc « propriétaire » : dernier bloc non-DATA rencontré (le bloc d'ID qui précède ses données). */
  owner!: Int32Array;

  private readonly first = new Map<Ptr, number>();
  /** Chaînage des blocs qui partagent une même ancienne adresse (cas rare, voir `resolve`). */
  private nextSame!: Int32Array;
  private readonly byIdCode = new Map<string, number[]>();
  private readonly headerSize: number;
  /** En-tête de bloc « large » (Blender 5.0+). */
  private readonly large: boolean;
  /** Indexation restant à faire (ouverture asynchrone uniquement). */
  private steps: Generator<void, void, void> | null = null;

  /**
   * Ouverture asynchrone : l'indexation des blocs (des millions sur un gros fichier) rend la main
   * à la boucle d'événements par tranches, l'interface ne se fige pas.
   */
  static async open(data: Uint8Array, pause: () => Promise<void>): Promise<BlendFile> {
    const file = new BlendFile(data, DEFERRED);
    const steps = file.steps!;
    file.steps = null;
    for (let r = steps.next(); !r.done; r = steps.next()) await pause();
    return file;
  }

  constructor(data: ArrayBuffer | Uint8Array, mode?: typeof DEFERRED) {
    const input = data instanceof Uint8Array ? data : new Uint8Array(data);
    const bytes = decompressBlend(input);
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = bytes.length;
    if (n < 12 || String.fromCharCode(...bytes.subarray(0, 7)) !== 'BLENDER') {
      throw new Error("Ce fichier n'est pas un fichier Blender (.blend).");
    }
    const digits = (from: number, count: number): number => {
      let v = 0;
      for (let i = 0; i < count; i++) {
        const c = bytes[from + i] - 48;
        if (!(c >= 0 && c <= 9)) throw new Error('Fichier .blend corrompu : en-tête illisible.');
        v = v * 10 + c;
      }
      return v;
    };
    let headerSize = 12;
    let large = false;
    let endian: number;
    if (bytes[7] === 95 /* _ */ || bytes[7] === 45 /* - */) {
      // En-tête historique : BLENDER + taille de pointeur + boutisme + version sur 3 chiffres.
      this.pointerSize = bytes[7] === 95 ? 4 : 8;
      endian = bytes[8];
      this.version = digits(9, 3);
    } else {
      // Blender 5.0+ : BLENDER17-01v0500 (taille d'en-tête, version de format, version sur 4 chiffres).
      if (n < 17) throw new Error('Fichier .blend tronqué : en-tête incomplet.');
      headerSize = digits(7, 2);
      if (headerSize < 17 || bytes[9] !== 45) throw new Error('Fichier .blend corrompu : en-tête illisible.');
      const format = digits(10, 2);
      if (format !== 1) {
        throw new Error(`Format de fichier .blend n° ${format} trop récent pour ce lecteur.`);
      }
      this.pointerSize = 8;
      endian = bytes[12];
      this.version = digits(13, 4);
      large = true;
    }
    if (endian !== 118 /* v */ && endian !== 86 /* V */) throw new Error('Fichier .blend corrompu : en-tête illisible.');
    this.littleEndian = endian === 118;
    this.headerSize = headerSize;
    this.large = large;
    const steps = this.index();
    if (mode === DEFERRED) this.steps = steps;
    else for (let r = steps.next(); !r.done; r = steps.next());
  }

  /** Indexe les blocs ; s'interrompt (`yield`) toutes les 2^16 itérations. */
  private *index(): Generator<void, void, void> {
    const bytes = this.bytes;
    const n = bytes.length;
    const le = this.littleEndian;
    const large = this.large;
    const headerSize = this.headerSize;
    const view = this.view;
    const ps = this.pointerSize;
    const headSize = large ? 32 : ps === 8 ? 24 : 20;

    // Première passe : compte les blocs et vérifie qu'ils tiennent tous dans le fichier.
    const truncated = (): never => {
      throw new Error('Fichier .blend tronqué ou corrompu : un bloc de données dépasse la fin du fichier.');
    };
    const blockLen = (p: number): number => {
      if (!large) return view.getInt32(p + 4, le);
      const lo = view.getUint32(p + (le ? 16 : 20), le);
      const hi = view.getInt32(p + (le ? 20 : 16), le);
      return hi * 4294967296 + lo;
    };
    let count = 0;
    let p = headerSize;
    let ended = false;
    while (p + headSize <= n) {
      if (view.getUint32(p, false) === CODE_ENDB) {
        ended = true;
        break;
      }
      const len = blockLen(p);
      if (!(len >= 0) || p + headSize + len > n) truncated();
      p += headSize + len;
      if (++count > MAX_BLOCKS) throw new Error('Fichier .blend corrompu : nombre de blocs invraisemblable.');
      if ((count & 0xffff) === 0) yield;
    }
    if (!ended) truncated();

    this.count = count;
    this.code = new Uint32Array(count);
    this.pos = new Float64Array(count);
    this.len = new Float64Array(count);
    this.nr = new Float64Array(count);
    this.sdnaNr = new Int32Array(count);
    this.owner = new Int32Array(count);
    this.nextSame = new Int32Array(count).fill(-1);
    const oldLo = new Uint32Array(count);
    const oldHi = new Uint32Array(count);

    p = headerSize;
    let owner = -1;
    let dna = -1;
    for (let i = 0; i < count; i++) {
      if ((i & 0xffff) === 0xffff) yield;
      let code = view.getUint32(p, false);
      // Fichier gros-boutiste : les codes d'ID sur deux lettres sont cadrés à droite (« \0\0OB »).
      if (code >>> 16 === 0 && code !== 0) code = (code << 16) >>> 0;
      this.code[i] = code;
      const len = blockLen(p);
      if (large) {
        this.sdnaNr[i] = view.getInt32(p + 4, le);
        oldLo[i] = view.getUint32(p + (le ? 8 : 12), le);
        oldHi[i] = view.getUint32(p + (le ? 12 : 8), le);
        const lo = view.getUint32(p + (le ? 24 : 28), le);
        const hi = view.getInt32(p + (le ? 28 : 24), le);
        this.nr[i] = hi * 4294967296 + lo;
      } else if (ps === 8) {
        oldLo[i] = view.getUint32(p + (le ? 8 : 12), le);
        oldHi[i] = view.getUint32(p + (le ? 12 : 8), le);
        this.sdnaNr[i] = view.getInt32(p + 16, le);
        this.nr[i] = view.getInt32(p + 20, le);
      } else {
        oldLo[i] = view.getUint32(p + 8, le);
        this.sdnaNr[i] = view.getInt32(p + 12, le);
        this.nr[i] = view.getInt32(p + 16, le);
      }
      this.pos[i] = p + headSize;
      this.len[i] = len;
      if (code !== CODE_DATA) owner = i;
      this.owner[i] = owner;
      if (code === CODE_DNA1 && dna < 0) dna = i;
      p += headSize + len;
    }
    if (dna < 0) throw new Error('Fichier .blend incomplet : catalogue des structures (bloc DNA1) absent.');
    this.sdna = parseSdna(bytes, this.pos[dna], this.len[dna], le, ps);

    // Table ancienne adresse → bloc. Les doublons sont chaînés dans l'ordre du fichier.
    const tails = new Map<Ptr, number>();
    for (let i = 0; i < count; i++) {
      if ((i & 0xffff) === 0xffff) yield;
      const code = this.code[i];
      if (code === CODE_DNA1) continue;
      if (code !== CODE_DATA) {
        const id = this.idCode(i);
        let list = this.byIdCode.get(id);
        if (!list) this.byIdCode.set(id, (list = []));
        list.push(i);
      }
      if (oldLo[i] === 0 && oldHi[i] === 0) continue;
      const key = ptrKey(oldLo[i], oldHi[i]);
      if (!this.first.has(key)) {
        this.first.set(key, i);
      } else {
        const tail = tails.get(key) ?? this.first.get(key)!;
        this.nextSame[tail] = i;
        tails.set(key, i);
      }
    }
  }

  /** Code du bloc en clair : « DATA », « GLOB », ou les deux lettres d'un bloc d'ID (« OB », « ME »…). */
  codeOf(block: number): string {
    const c = this.code[block];
    let s = '';
    for (let shift = 24; shift >= 0; shift -= 8) {
      const ch = (c >>> shift) & 0xff;
      if (ch === 0) break;
      s += String.fromCharCode(ch);
    }
    return s;
  }

  private idCode(block: number): string {
    return this.codeOf(block);
  }

  /** Blocs portant ce code (« OB », « SC », « GLOB »…), dans l'ordre du fichier. */
  blocksOf(code: string): readonly number[] {
    return this.byIdCode.get(code) ?? [];
  }

  /** Structure SDNA des éléments d'un bloc. */
  structOf(block: number): SdnaStruct | undefined {
    return this.sdna.structs[this.sdnaNr[block]];
  }

  readPtr(pos: number): Ptr {
    const le = this.littleEndian;
    if (this.pointerSize === 4) return this.view.getUint32(pos, le);
    const lo = this.view.getUint32(pos + (le ? 0 : 4), le);
    const hi = this.view.getUint32(pos + (le ? 4 : 0), le);
    return ptrKey(lo, hi);
  }

  /**
   * Bloc désigné par un pointeur, -1 si aucun. Comme Blender, les blocs DATA sont d'abord cherchés
   * parmi ceux du même propriétaire que `from` (deux blocs de données d'ID différents peuvent avoir
   * eu la même adresse), puis dans tout le fichier (données partagées entre ID).
   */
  resolve(ptr: Ptr, from: number): number {
    if (ptr === 0) return -1;
    const first = this.first.get(ptr);
    if (first === undefined) return -1;
    if (this.nextSame[first] < 0) return first;
    const owner = from >= 0 ? this.owner[from] : -2;
    for (let i = first, guard = 0; i >= 0 && guard < 1 << 20; i = this.nextSame[i], guard++) {
      if (this.owner[i] === owner) return i;
    }
    return first;
  }

  /** Bloc d'ID (objet, maillage, matériau…) désigné par un pointeur, -1 si aucun. */
  resolveId(ptr: Ptr): number {
    if (ptr === 0) return -1;
    const first = this.first.get(ptr);
    if (first === undefined) return -1;
    for (let i = first, guard = 0; i >= 0 && guard < 1 << 20; i = this.nextSame[i], guard++) {
      if (this.code[i] !== CODE_DATA) return i;
    }
    return -1;
  }

  /** Premier bloc GLOB (état global à l'enregistrement), -1 si absent. */
  get globalBlock(): number {
    for (let i = 0; i < this.count; i++) if (this.code[i] === CODE_GLOB) return i;
    return -1;
  }
}
