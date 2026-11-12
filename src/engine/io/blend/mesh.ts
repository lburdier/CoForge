import type { ImportedMesh } from '../scene';
import type { BlendFile } from './file';
import { recAt, structArray, type Rec } from './reader';
import { readFloats, readInts, RAD2DEG, type Ctx } from './util';

/** Taille des tranches (2^17 faces) entre deux occasions de rendre la main à l'interface. */
const SLICE = (1 << 17) - 1;

/**
 * Lecture des maillages, toutes générations de stockage confondues :
 *  1. Blender 5.0+ : `AttributeStorage` (attributs nommés `position`, `.corner_vert`, `material_index`,
 *     `sharp_face`) + `poly_offset_indices` ;
 *  2. Blender 3.5 → 4.x : mêmes attributs dans les couches `CustomData` nommées ;
 *  3. Blender 2.63 → 3.6 : structures `MVert` / `MPoly` / `MLoop` (3.6 les écrit encore pour compatibilité) ;
 *  4. avant 2.63 : `MFace` (triangles et quadrilatères, « tessfaces »).
 * Tout est copié dans des tableaux typés (aucun objet JS par sommet) ; les polygones sont des vues
 * (`subarray`) sur un seul tableau d'indices.
 */

export interface BlendMeshRead {
  mesh: ImportedMesh;
  /** Nombre de faces lisses (ME_SMOOTH / absence de `sharp_face`). */
  smoothFaces: number;
  faces: number;
  /** Auto-lissage d'avant Blender 4.1 (drapeau ME_AUTOSMOOTH + `smoothresh`), en degrés ; null s'il est inactif. */
  autoSmooth: number | null;
  /** Sommets qui n'appartiennent à aucune face (sommets et arêtes isolés, non repris). */
  looseVerts: number;
  /** Clés de forme actives (valeur non nulle) : le maillage de base ne suffit pas. */
  activeShapeKeys: boolean;
}

// Types de couches CustomData (eCustomDataType), stables depuis 2.63.
const CD_MVERT = 0;
const CD_MFACE = 4;
const CD_PROP_INT32 = 11;
const CD_MPOLY = 25;
const CD_MLOOP = 26;
const CD_PROP_FLOAT3 = 48;
const CD_PROP_BOOL = 50;

// Types d'attributs de Blender 5 (bke::AttrType).
const AT_BOOL = 0;
const AT_INT32 = 3;
const AT_FLOAT3 = 7;

const ME_SMOOTH = 1;
const ME_AUTOSMOOTH = 32;
const KEYBLOCK_MUTE = 1;
const KEY_RELATIVE = 1;

/** Garde-fou : au-delà, le compteur lu est jugé corrompu. */
const MAX_ELEMS = 0x7fffffff;

const EMPTY = new Int32Array(0);

/** Tableau brut d'un attribut : position dans le fichier et nombre d'éléments présents. */
interface Raw {
  pos: number;
  count: number;
  /** Un seul élément, valable pour tous (stockage « single » de Blender 5). */
  single: boolean;
}

function cString(file: BlendFile, block: number): string {
  if (block < 0) return '';
  const bytes = file.bytes;
  const start = file.pos[block];
  const end = start + file.len[block];
  let s = '';
  for (let p = start; p < end && bytes[p] !== 0 && s.length < 256; p++) s += String.fromCharCode(bytes[p]);
  return s;
}

function rawOf(file: BlendFile, block: number, elemSize: number, single = false): Raw | null {
  if (block < 0) return null;
  const count = Math.floor(file.len[block] / elemSize);
  if (count <= 0) return null;
  return { pos: file.pos[block], count, single };
}

/** Attributs de Blender 5.0+ (`Mesh.attribute_storage`), indexés par nom ; seuls les types attendus sont gardés. */
function storageAttributes(me: Rec): Map<string, { type: number; domain: number; raw: Raw }> {
  const out = new Map<string, { type: number; domain: number; raw: Raw }>();
  const storage = me.sub('attribute_storage');
  if (!storage) return out;
  const file = me.file;
  const block = storage.target('dna_attributes');
  const arr = structArray(file, block, 'Attribute');
  if (!arr) return out;
  const n = Math.min(arr.count, Math.max(0, storage.num('dna_attributes_num')));
  for (let i = 0; i < n; i++) {
    const a = recAt(file, block, i, 'Attribute');
    if (!a) continue;
    const name = cString(file, a.target('name'));
    const type = a.num('data_type', -1);
    const elem = type === AT_FLOAT3 ? 12 : type === AT_INT32 ? 4 : type === AT_BOOL ? 1 : 0;
    if (!name || elem === 0 || out.has(name)) continue;
    const single = a.num('storage_type') === 1;
    const holder = a.get('data', single ? 'AttributeSingle' : 'AttributeArray');
    if (!holder) continue;
    const raw = rawOf(file, holder.target('data'), elem, single);
    if (!raw) continue;
    if (!single) {
      const size = holder.num('size', -1);
      if (size >= 0) raw.count = Math.min(raw.count, size);
    }
    out.set(name, { type, domain: a.num('domain', -1), raw });
  }
  return out;
}

interface Layer {
  type: number;
  name: string;
  block: number;
}

/** Couches d'une `CustomData` (vdata, pdata, ldata, fdata). */
function layers(me: Rec, field: string): Layer[] {
  const cd = me.sub(field);
  if (!cd) return [];
  const block = cd.target('layers');
  const arr = structArray(cd.file, block, 'CustomDataLayer');
  if (!arr) return [];
  const n = Math.min(arr.count, Math.max(0, cd.num('totlayer')));
  const out: Layer[] = [];
  for (let i = 0; i < n; i++) {
    const l = recAt(cd.file, block, i, 'CustomDataLayer');
    if (l) out.push({ type: l.num('type', -1), name: l.str('name'), block: l.target('data') });
  }
  return out;
}

function layerBy(list: Layer[], type: number, name?: string): number {
  for (const l of list) if (l.type === type && (name === undefined || l.name === name) && l.block >= 0) return l.block;
  return -1;
}

function bounded(v: number): number {
  return v >= 0 && v <= MAX_ELEMS ? Math.floor(v) : 0;
}

/** Copie d'un tableau de structures (MVert, MPoly…) champ par champ, via le SDNA. */
function structField(file: BlendFile, block: number, hint: string, field: string): { pos: number; stride: number; count: number; offset: number; kind: number; elem: number } | null {
  const arr = structArray(file, block, hint);
  if (!arr) return null;
  const f = arr.st.byName.get(field);
  if (!f) return null;
  return { pos: arr.pos, stride: arr.stride, count: arr.count, offset: f.offset, kind: f.kind, elem: f.elemSize };
}

function readIntField(file: BlendFile, s: NonNullable<ReturnType<typeof structField>>, count: number): Int32Array {
  const n = Math.min(count, s.count);
  const out = new Int32Array(count);
  const v = file.view;
  const le = file.littleEndian;
  for (let i = 0, p = s.pos + s.offset; i < n; i++, p += s.stride) {
    out[i] = s.elem === 4 ? v.getInt32(p, le) : s.elem === 2 ? v.getInt16(p, le) : v.getInt8(p);
  }
  return out;
}

/** Lit un maillage (bloc `ME`). Ne lève pas d'exception sur un maillage incohérent : les faces invalides sont ignorées. */
export async function readMesh(ctx: Ctx, me: Rec): Promise<BlendMeshRead> {
  const file = ctx.file;
  const name = me.idName || 'Maillage';
  const totvert = bounded(me.num(['totvert', 'verts_num']));
  const totpoly = bounded(me.num(['totpoly', 'faces_num']));
  const totloop = bounded(me.num(['totloop', 'corners_num']));
  const totface = bounded(me.num('totface'));

  const attrs = storageAttributes(me);
  const vdata = layers(me, 'vdata');
  const pdata = layers(me, 'pdata');
  const ldata = layers(me, 'ldata');

  // ---------------------------------------------------------------- positions
  let positions: Float32Array = new Float32Array(0);
  const posAttr = attrs.get('position');
  let posBlock = -1;
  if (posAttr && posAttr.type === AT_FLOAT3 && !posAttr.raw.single) {
    const n = Math.min(totvert, posAttr.raw.count);
    positions = readFloats(file, posAttr.raw.pos, n * 3);
  } else if ((posBlock = layerBy(vdata, CD_PROP_FLOAT3, 'position')) >= 0) {
    const raw = rawOf(file, posBlock, 12)!;
    positions = readFloats(file, raw.pos, Math.min(totvert, raw.count) * 3);
  } else {
    let block = layerBy(vdata, CD_MVERT);
    if (block < 0) block = me.target('mvert');
    const co = structField(file, block, 'MVert', 'co');
    if (co) {
      const n = Math.min(totvert, co.count);
      positions = new Float32Array(n * 3);
      const v = file.view;
      const le = file.littleEndian;
      for (let i = 0, p = co.pos + co.offset; i < n; i++, p += co.stride) {
        positions[i * 3] = v.getFloat32(p, le);
        positions[i * 3 + 1] = v.getFloat32(p + 4, le);
        positions[i * 3 + 2] = v.getFloat32(p + 8, le);
      }
    }
  }
  const nverts = positions.length / 3;
  await ctx.pause();

  // ---------------------------------------------------------------- faces
  let polygons: Int32Array[] = [];
  let matIndex: Int32Array | null = null;
  let smooth: Uint8Array | null = null;
  /** Sémantique Blender 4+ : sans `sharp_face`, toutes les faces sont lisses. */
  let smoothByDefault = false;

  const offsetsBlock = me.target('poly_offset_indices');
  let corners: Int32Array | null = null;
  const cvAttr = attrs.get('.corner_vert');
  if (cvAttr && cvAttr.type === AT_INT32 && !cvAttr.raw.single) {
    corners = readInts(file, cvAttr.raw.pos, Math.min(totloop, cvAttr.raw.count));
  } else {
    const b = layerBy(ldata, CD_PROP_INT32, '.corner_vert');
    if (b >= 0) {
      const raw = rawOf(file, b, 4)!;
      corners = readInts(file, raw.pos, Math.min(totloop, raw.count));
    }
  }

  if (offsetsBlock >= 0 && corners && totpoly > 0) {
    // Générations 1 et 2 : tableau de décalages (faces_num + 1 entrées).
    const raw = rawOf(file, offsetsBlock, 4)!;
    const nf = Math.min(totpoly, raw.count - 1);
    const off = readInts(file, raw.pos, nf + 1);
    polygons = new Array(nf);
    for (let i = 0; i < nf; i++) {
      if ((i & SLICE) === SLICE) await ctx.pause();
      const s = off[i];
      const e = off[i + 1];
      polygons[i] = s >= 0 && e - s >= 3 && e <= corners.length ? corners.subarray(s, e) : EMPTY;
    }
    smoothByDefault = true;
  } else {
    // Génération 3 : MPoly + MLoop.
    let polyBlock = layerBy(pdata, CD_MPOLY);
    if (polyBlock < 0) polyBlock = me.target('mpoly');
    let loopBlock = layerBy(ldata, CD_MLOOP);
    if (loopBlock < 0) loopBlock = me.target('mloop');
    const loopV = structField(file, loopBlock, 'MLoop', 'v');
    const start = structField(file, polyBlock, 'MPoly', 'loopstart');
    const total = structField(file, polyBlock, 'MPoly', 'totloop');
    if (totpoly > 0 && start && total && (loopV || corners)) {
      const nf = Math.min(totpoly, start.count);
      if (!corners) corners = readIntField(file, loopV!, Math.min(totloop, loopV!.count));
      const ls = readIntField(file, start, nf);
      const lt = readIntField(file, total, nf);
      polygons = new Array(nf);
      for (let i = 0; i < nf; i++) {
        if ((i & SLICE) === SLICE) await ctx.pause();
        const s = ls[i];
        const e = s + lt[i];
        polygons[i] = s >= 0 && lt[i] >= 3 && e <= corners.length ? corners.subarray(s, e) : EMPTY;
      }
      const mat = structField(file, polyBlock, 'MPoly', 'mat_nr');
      if (mat) matIndex = readIntField(file, mat, nf);
      const flag = structField(file, polyBlock, 'MPoly', 'flag');
      if (flag) {
        const f = readIntField(file, flag, nf);
        smooth = new Uint8Array(nf);
        for (let i = 0; i < nf; i++) smooth[i] = f[i] & ME_SMOOTH;
      }
    } else if (totface > 0) {
      // Génération 4 : MFace (v4 = 0 → triangle).
      let faceBlock = layerBy(layers(me, 'fdata'), CD_MFACE);
      if (faceBlock < 0) faceBlock = me.target('mface');
      const arr = structArray(file, faceBlock, 'MFace');
      if (arr) {
        const nf = Math.min(totface, arr.count);
        const st = arr.st;
        const fv = ['v1', 'v2', 'v3', 'v4'].map((n) => st.byName.get(n)?.offset ?? -1);
        const fm = st.byName.get('mat_nr');
        const ff = st.byName.get('flag');
        const idx = new Int32Array(nf * 4);
        polygons = new Array(nf);
        matIndex = new Int32Array(nf);
        smooth = new Uint8Array(nf);
        const v = file.view;
        const le = file.littleEndian;
        if (fv.every((o) => o >= 0)) {
          for (let i = 0; i < nf; i++) {
            if ((i & SLICE) === SLICE) await ctx.pause();
            const p = arr.pos + i * arr.stride;
            for (let k = 0; k < 4; k++) idx[i * 4 + k] = v.getInt32(p + fv[k], le);
            polygons[i] = idx.subarray(i * 4, i * 4 + (idx[i * 4 + 3] === 0 ? 3 : 4));
            if (fm) matIndex[i] = fm.elemSize === 2 ? v.getInt16(p + fm.offset, le) : v.getInt8(p + fm.offset);
            if (ff) smooth[i] = v.getInt8(p + ff.offset) & ME_SMOOTH;
          }
        } else {
          polygons.fill(EMPTY);
        }
      }
    }
  }
  const nf = polygons.length;
  await ctx.pause();

  // ---------------------------------------------------------------- attributs de face
  const matAttr = attrs.get('material_index');
  if (matAttr && matAttr.type === AT_INT32) {
    matIndex = new Int32Array(nf);
    if (matAttr.raw.single) matIndex.fill(file.view.getInt32(matAttr.raw.pos, file.littleEndian));
    else matIndex.set(readInts(file, matAttr.raw.pos, Math.min(nf, matAttr.raw.count)));
  } else {
    const b = layerBy(pdata, CD_PROP_INT32, 'material_index');
    if (b >= 0) {
      const raw = rawOf(file, b, 4)!;
      matIndex = new Int32Array(nf);
      matIndex.set(readInts(file, raw.pos, Math.min(nf, raw.count)));
    }
  }

  const sharpAttr = attrs.get('sharp_face');
  let sharpPos = -1;
  let sharpCount = 0;
  let sharpSingle = false;
  if (sharpAttr && sharpAttr.type === AT_BOOL) {
    sharpPos = sharpAttr.raw.pos;
    sharpCount = sharpAttr.raw.count;
    sharpSingle = sharpAttr.raw.single;
  } else {
    const b = layerBy(pdata, CD_PROP_BOOL, 'sharp_face');
    if (b >= 0) {
      sharpPos = file.pos[b];
      sharpCount = file.len[b];
    }
  }
  if (sharpPos >= 0) {
    smooth = new Uint8Array(nf);
    const bytes = file.bytes;
    for (let i = 0; i < nf; i++) {
      const sharp = sharpSingle ? bytes[sharpPos] : i < sharpCount ? bytes[sharpPos + i] : 0;
      smooth[i] = sharp ? 0 : 1;
    }
  }

  let smoothFaces = 0;
  if (smooth) for (let i = 0; i < nf; i++) smoothFaces += smooth[i] ? 1 : 0;
  else if (smoothByDefault) smoothFaces = nf;

  let slots: Int32Array | undefined;
  if (matIndex) {
    for (let i = 0; i < nf; i++) {
      if (matIndex[i] !== 0) {
        slots = matIndex;
        break;
      }
    }
  }

  // ---------------------------------------------------------------- sommets isolés
  let looseVerts = 0;
  if (nverts > 0) {
    const used = new Uint8Array(nverts);
    for (let i = 0; i < nf; i++) {
      if ((i & SLICE) === SLICE) await ctx.pause();
      const poly = polygons[i];
      for (let k = 0; k < poly.length; k++) if (poly[k] >= 0 && poly[k] < nverts) used[poly[k]] = 1;
    }
    for (let i = 0; i < nverts; i++) if (!used[i]) looseVerts++;
  }

  // ---------------------------------------------------------------- auto-lissage (avant 4.1)
  let autoSmooth: number | null = null;
  if (me.num('flag') & ME_AUTOSMOOTH && me.has('smoothresh')) {
    const f = me.field('smoothresh')!;
    const v = me.num('smoothresh');
    // Avant 2.63 environ : entier en degrés ; ensuite : flottant en radians.
    autoSmooth = f.type === 'float' ? v * RAD2DEG : v;
    if (!Number.isFinite(autoSmooth)) autoSmooth = null;
  }

  return {
    mesh: { name, positions, polygons, polygonSlots: slots, weld: false },
    smoothFaces,
    faces: nf,
    autoSmooth,
    looseVerts,
    activeShapeKeys: shapeKeysActive(me),
  };
}

/** Vrai si le maillage a des clés de forme qui modifient sa forme (valeur non nulle, non muettes). */
export function shapeKeysActive(me: Rec): boolean {
  const key = me.id('key');
  if (!key) return false;
  const blocks = key.list('block');
  if (blocks.length < 2) return false;
  if (key.num('type', KEY_RELATIVE) !== KEY_RELATIVE) return true; // clés absolues : forme pilotée par le temps
  for (let i = 1; i < blocks.length; i++) {
    const kb = blocks[i];
    if (kb.num('flag') & KEYBLOCK_MUTE) continue;
    if (Math.abs(kb.num('curval')) > 1e-6) return true;
  }
  return false;
}
