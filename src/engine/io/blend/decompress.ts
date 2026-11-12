import { Gunzip } from 'fflate';
import { decompress as zstdDecompress, Decompress as ZstdStream } from 'fzstd';

/**
 * Taille décompressée maximale acceptée. Les gros fichiers réels dépassent 4 Gio une fois
 * décompressés ; la vraie limite est la mémoire disponible (échec d'allocation → erreur claire).
 */
const MAX_SIZE = 2 ** 44;
/** Taille maximale d'une trame zstd annoncée par la table (Blender écrit des trames de 1 Mio). */
const MAX_FRAME = 1 << 30;

const ZSTD_MAGIC = 0xfd2fb528;
/** Trame « ignorable » zstd qui porte la table de positionnement écrite par Blender. */
const SEEK_FRAME_MAGIC = 0x184d2a5e;
const SEEK_FOOTER_MAGIC = 0x8f92eab1;

export function isGzip(d: Uint8Array): boolean {
  return d.length >= 2 && d[0] === 0x1f && d[1] === 0x8b;
}

export function isZstd(d: Uint8Array): boolean {
  return d.length >= 4 && d[0] === 0x28 && d[1] === 0xb5 && d[2] === 0x2f && d[3] === 0xfd;
}

function u32(d: Uint8Array, p: number): number {
  return (d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)) >>> 0;
}

/**
 * Table de positionnement en fin de fichier (format « seekable » de zstd) : tailles compressée et
 * décompressée de chaque trame. Renvoie null si elle est absente ou incohérente.
 */
function seekTable(d: Uint8Array): { comp: number; size: number }[] | null {
  const n = d.length;
  if (n < 17 || u32(d, n - 4) !== SEEK_FOOTER_MAGIC) return null;
  const frames = u32(d, n - 9);
  const flags = d[n - 5];
  const entry = flags & 0x80 ? 12 : 8;
  const tableSize = frames * entry + 9;
  const start = n - tableSize - 8;
  if (frames === 0 || start < 0 || u32(d, start) !== SEEK_FRAME_MAGIC || u32(d, start + 4) !== tableSize) return null;
  const out: { comp: number; size: number }[] = [];
  let comp = 0;
  let total = 0;
  for (let i = 0; i < frames; i++) {
    const p = start + 8 + i * entry;
    const c = u32(d, p);
    const s = u32(d, p + 4);
    if (s > MAX_FRAME) return null;
    comp += c;
    total += s;
    out.push({ comp: c, size: s });
  }
  if (comp !== start || total > MAX_SIZE) return null;
  return out;
}

function inflateZstd(d: Uint8Array): Uint8Array {
  const table = seekTable(d);
  if (!table) return zstdDecompress(d); // trames enchaînées, trames ignorables sautées
  // Trames indépendantes (Blender en écrit une par mébioctet) : une seule allocation finale.
  let total = 0;
  for (const f of table) total += f.size;
  const out = new Uint8Array(total);
  let src = 0;
  let dst = 0;
  for (const f of table) {
    const part = zstdDecompress(d.subarray(src, src + f.comp));
    if (part.length !== f.size) throw new Error('trame de taille inattendue');
    out.set(part, dst);
    src += f.comp;
    dst += f.size;
  }
  return out;
}

/**
 * Décompression gzip par morceaux : la taille annoncée en fin de fichier n'est jamais crue sur
 * parole (un fichier tronqué ferait allouer jusqu'à 4 Gio).
 */
function inflateGzip(d: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const stream = new Gunzip((chunk) => {
    total += chunk.length;
    if (total > MAX_SIZE) throw new Error('trop volumineux');
    chunks.push(chunk);
  });
  const step = 1 << 20;
  for (let p = 0; p < d.length; p += step) {
    const end = Math.min(d.length, p + step);
    stream.push(d.subarray(p, end), end === d.length);
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

/**
 * Rend le contenu brut d'un .blend : tel quel s'il n'est pas compressé, sinon décompressé
 * (gzip jusqu'à Blender 2.93, zstd à partir de 3.0).
 */
export function decompressBlend(data: Uint8Array): Uint8Array {
  if (isGzip(data)) {
    if (data.length < 18) throw new Error('Fichier .blend compressé (gzip) tronqué.');
    try {
      return inflateGzip(data);
    } catch {
      throw new Error('Fichier .blend compressé (gzip) illisible : données corrompues ou tronquées.');
    }
  }
  if (isZstd(data)) {
    if (u32(data, 0) !== ZSTD_MAGIC || data.length < 9) throw new Error('Fichier .blend compressé (zstd) tronqué.');
    try {
      return inflateZstd(data);
    } catch {
      throw new Error('Fichier .blend compressé (zstd) illisible : données corrompues ou tronquées.');
    }
  }
  return data;
}

/**
 * Comme `decompressBlend`, mais rend la main à la boucle d'événements entre deux trames zstd
 * (Blender en écrit une par Mio) ou deux morceaux gzip : l'interface ne se fige pas sur un gros
 * fichier. `pause` décide elle-même s'il est temps de céder la main.
 */
export async function decompressBlendAsync(data: Uint8Array, pause: () => Promise<void>): Promise<Uint8Array> {
  if (isZstd(data) && data.length >= 9 && u32(data, 0) === ZSTD_MAGIC) {
    const table = seekTable(data);
    if (!table) return inflateZstdStream(data, pause);
    let total = 0;
    for (const f of table) total += f.size;
    let out: Uint8Array;
    try {
      out = new Uint8Array(total);
      let src = 0;
      let dst = 0;
      for (const f of table) {
        const part = zstdDecompress(data.subarray(src, src + f.comp));
        if (part.length !== f.size) throw new Error('trame de taille inattendue');
        out.set(part, dst);
        src += f.comp;
        dst += f.size;
        await pause();
      }
    } catch {
      throw new Error('Fichier .blend compressé (zstd) illisible : données corrompues ou tronquées.');
    }
    return out;
  }
  if (isGzip(data) && data.length >= 18) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      const stream = new Gunzip((chunk) => {
        total += chunk.length;
        if (total > MAX_SIZE) throw new Error('trop volumineux');
        chunks.push(chunk);
      });
      const step = 1 << 20;
      for (let p = 0; p < data.length; p += step) {
        const end = Math.min(data.length, p + step);
        stream.push(data.subarray(p, end), end === data.length);
        await pause();
      }
    } catch {
      throw new Error('Fichier .blend compressé (gzip) illisible : données corrompues ou tronquées.');
    }
    if (chunks.length === 1) return chunks[0];
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  }
  return decompressBlend(data);
}

/** zstd sans table de positionnement : décompression en flux, par morceaux, avec pauses. */
async function inflateZstdStream(data: Uint8Array, pause: () => Promise<void>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const stream = new ZstdStream((chunk) => {
      total += chunk.length;
      if (total > MAX_SIZE) throw new Error('trop volumineux');
      chunks.push(chunk);
    });
    const step = 1 << 20;
    for (let p = 0; p < data.length; p += step) {
      const end = Math.min(data.length, p + step);
      stream.push(data.subarray(p, end), end === data.length);
      await pause();
    }
  } catch {
    throw new Error('Fichier .blend compressé (zstd) illisible : données corrompues ou tronquées.');
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}
