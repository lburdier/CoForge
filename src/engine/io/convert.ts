import { Color, Matrix4, type Material } from 'three';
import { MATERIAL_DEFAULTS, type MaterialData, type MeshData, type Vec3 } from '../../core/doc/schema';
import { newId } from '../../core/ids';

/**
 * Conversions entre le repère de CoForge (Z vers le haut, comme Blender) et celui des
 * formats d'échange glTF / OBJ (Y vers le haut) :
 *   Z-up → Y-up : (x, y, z) → (x, z, −y)      Y-up → Z-up : (x, y, z) → (x, −z, y)
 */
export const Z_UP_TO_Y_UP = new Matrix4().makeRotationX(-Math.PI / 2);
export const Y_UP_TO_Z_UP = new Matrix4().makeRotationX(Math.PI / 2);

export function zUpToYUp(p: Vec3): Vec3 {
  return [p[0], p[2], -p[1]];
}

export function yUpToZUp(p: Vec3): Vec3 {
  return [p[0], -p[2], p[1]];
}

/**
 * Change le repère d'une transformation d'objet : `C · M · C⁻¹`. Appliquée avec la même
 * conversion aux sommets locaux, elle conserve l'orientation « naturelle » des objets
 * (un objet debout reste debout avec une rotation nulle) et rend l'aller-retour exact.
 */
export function convertTransform(m: Matrix4, toYUp: boolean, out = new Matrix4()): Matrix4 {
  const c = toYUp ? Z_UP_TO_Y_UP : Y_UP_TO_Z_UP;
  const ci = toYUp ? Y_UP_TO_Z_UP : Z_UP_TO_Y_UP;
  return out.copy(c).multiply(m).multiply(ci);
}

// ------------------------------------------------------------------ soudure des sommets

/**
 * Construit un MeshData à partir de positions (plates, xyz, déjà en Z-up) et de polygones
 * (indices dans ces positions). Les sommets confondus (à `tolerance` près) sont soudés ;
 * les sommets consécutifs identiques d'une boucle sont fusionnés, les faces dégénérées
 * (moins de 3 sommets distincts) et les faces en double (même ensemble de sommets) ignorées.
 * Seuls les sommets utilisés par une face sont conservés.
 */
export function buildMeshData(positions: ArrayLike<number>, polygons: Iterable<readonly number[]>, tolerance = 1e-5): MeshData {
  const count = Math.floor(positions.length / 3);
  const inv = 1 / Math.max(1e-12, tolerance);
  const byKey = new Map<string, string>();
  const remap = new Array<string | undefined>(count);
  const verts = new Map<string, Vec3>();
  const faces = new Map<string, string[]>();
  const seenFaces = new Set<string>();

  const vertexId = (i: number): string | null => {
    if (i < 0 || i >= count) return null;
    const cached = remap[i];
    if (cached !== undefined) return cached;
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    const key = `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
    let id = byKey.get(key);
    if (id === undefined) {
      id = newId(8);
      byKey.set(key, id);
      verts.set(id, [x, y, z]);
    }
    remap[i] = id;
    return id;
  };

  for (const poly of polygons) {
    const loop: string[] = [];
    let ok = true;
    for (const idx of poly) {
      const id = vertexId(idx);
      if (id === null) {
        ok = false;
        break;
      }
      if (loop.length === 0 || loop[loop.length - 1] !== id) loop.push(id);
    }
    if (!ok) continue;
    while (loop.length > 1 && loop[0] === loop[loop.length - 1]) loop.pop();
    if (loop.length < 3 || new Set(loop).size < 3) continue;
    const key = [...loop].sort().join(' ');
    if (seenFaces.has(key)) continue;
    seenFaces.add(key);
    faces.set(newId(8), loop);
  }

  // Sommets réellement utilisés.
  const used = new Set<string>();
  for (const loop of faces.values()) for (const v of loop) used.add(v);
  for (const id of [...verts.keys()]) if (!used.has(id)) verts.delete(id);
  return { verts, faces };
}

// ------------------------------------------------------------------ matériaux

function hex(c: Color | undefined, fallback: string): string {
  if (!c || typeof (c as any).getHexString !== 'function') return fallback;
  return `#${c.getHexString()}`;
}

function num(v: unknown, fallback: number, lo = -Infinity, hi = Infinity): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** Convertit un matériau three.js importé en MaterialData (couleur, métal, rugosité, émission, alpha, verre). */
export function materialDataFromThree(m: Material): Omit<MaterialData, 'id'> {
  const any = m as any;
  const emissive: Color | undefined = any.emissive;
  const emissiveOn = !!emissive && (emissive.r > 0 || emissive.g > 0 || emissive.b > 0);
  return {
    name: typeof m.name === 'string' && m.name.trim() ? m.name.trim() : 'Matériau importé',
    baseColor: hex(any.color, MATERIAL_DEFAULTS.baseColor),
    metallic: num(any.metalness, any.isMeshStandardMaterial ? 1 : 0, 0, 1),
    roughness: num(any.roughness, any.isMeshStandardMaterial ? 1 : 0.5, 0, 1),
    emission: emissiveOn ? hex(emissive, '#000000') : '#000000',
    emissionStrength: emissiveOn ? num(any.emissiveIntensity, 1, 0) : 0,
    alpha: m.transparent ? num(m.opacity, 1, 0, 1) : 1,
    transmission: num(any.transmission, 0, 0, 1),
    ior: num(any.ior, MATERIAL_DEFAULTS.ior, 1, 2.333),
  };
}

/** Valeurs d'un MaterialData pour un MeshPhysicalMaterial d'export. */
export function physicalParamsFromData(d: Omit<MaterialData, 'id' | 'name'>): {
  color: Color;
  metalness: number;
  roughness: number;
  emissive: Color;
  emissiveIntensity: number;
  opacity: number;
  transparent: boolean;
  transmission: number;
  ior: number;
} {
  const color = new Color(MATERIAL_DEFAULTS.baseColor);
  if (typeof d.baseColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(d.baseColor)) color.set(d.baseColor);
  const emissive = new Color(0, 0, 0);
  if (typeof d.emission === 'string' && /^#[0-9a-fA-F]{6}$/.test(d.emission)) emissive.set(d.emission);
  const opacity = num(d.alpha, 1, 0, 1);
  return {
    color,
    metalness: num(d.metallic, 0, 0, 1),
    roughness: num(d.roughness, 0.5, 0, 1),
    emissive,
    emissiveIntensity: num(d.emissionStrength, 0, 0),
    opacity,
    transparent: opacity < 1,
    transmission: num(d.transmission, 0, 0, 1),
    ior: num(d.ior, 1.45, 1, 2.333),
  };
}

/** Nom sans espaces ni caractères de contrôle (identifiants OBJ). */
export function safeToken(name: string, fallback: string): string {
  const s = String(name ?? '')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .replace(/\s+/g, '_');
  return s || fallback;
}

// ------------------------------------------------------------------ aides communes aux lecteurs

/** Composante linéaire 0..1 → octet sRGB. */
function srgbByte(c: number): number {
  const v = Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0;
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, s)) * 255);
}

/** Couleur RVB linéaire (0..1, bornée) → '#rrggbb' sRGB, la convention du document. */
export function linearToHex(r: number, g: number, b: number): string {
  const h = (c: number) => srgbByte(c).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Composante sRGB 0..1 → linéaire. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Nombre fini borné, sinon valeur de repli. */
export function finiteOr(v: unknown, fallback: number, lo = -Infinity, hi = Infinity): number {
  return num(v, fallback, lo, hi);
}

/** Remplace par l'identité une matrice contenant une valeur non finie. Renvoie true si elle était saine. */
export function sanitizeMatrix(m: Matrix4): boolean {
  const e = m.elements;
  for (let i = 0; i < 16; i++) {
    if (!Number.isFinite(e[i])) {
      m.identity();
      return false;
    }
  }
  return true;
}

/**
 * Triangle dégénéré : indices répétés, sommet non fini ou aire nulle (sommets confondus ou
 * alignés). Le test d'aire est relatif (sinus de l'angle), donc indépendant de l'échelle.
 */
export function isDegenerateTriangle(p: ArrayLike<number>, a: number, b: number, c: number): boolean {
  if (a === b || b === c || a === c) return true;
  const ax = p[a * 3];
  const ay = p[a * 3 + 1];
  const az = p[a * 3 + 2];
  const ux = p[b * 3] - ax;
  const uy = p[b * 3 + 1] - ay;
  const uz = p[b * 3 + 2] - az;
  const vx = p[c * 3] - ax;
  const vy = p[c * 3 + 1] - ay;
  const vz = p[c * 3 + 2] - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const area2 = nx * nx + ny * ny + nz * nz;
  const lu = ux * ux + uy * uy + uz * uz;
  const lv = vx * vx + vy * vy + vz * vz;
  if (!Number.isFinite(area2) || !Number.isFinite(lu) || !Number.isFinite(lv)) return true;
  return !(area2 > 1e-14 * lu * lv);
}

/**
 * Les normales de sommets du fichier s'écartent-elles des normales de faces (ombrage lisse) ?
 * `positions` et `normals` sont à plat, dans le même repère, indexées par les mêmes sommets ;
 * la normale de face est prise sur les trois premiers sommets du polygone. Échantillonnage
 * borné : inutile de parcourir des millions de faces pour décider.
 */
export function hasSmoothNormals(
  positions: ArrayLike<number>,
  normals: ArrayLike<number>,
  polygons: ArrayLike<ArrayLike<number>>,
  limitDegrees = 8,
): boolean {
  const cosLimit = Math.cos((limitDegrees * Math.PI) / 180);
  const count = Math.min(Math.floor(positions.length / 3), Math.floor(normals.length / 3));
  const step = Math.max(1, Math.floor(polygons.length / 20000));
  for (let f = 0; f < polygons.length; f += step) {
    const poly = polygons[f];
    if (poly.length < 3) continue;
    const a = poly[0];
    const b = poly[1];
    const c = poly[2];
    if (!(a >= 0 && a < count && b >= 0 && b < count && c >= 0 && c < count)) continue;
    const ux = positions[b * 3] - positions[a * 3];
    const uy = positions[b * 3 + 1] - positions[a * 3 + 1];
    const uz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const vx = positions[c * 3] - positions[a * 3];
    const vy = positions[c * 3 + 1] - positions[a * 3 + 1];
    const vz = positions[c * 3 + 2] - positions[a * 3 + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 1e-20)) continue;
    nx /= len;
    ny /= len;
    nz /= len;
    for (let k = 0; k < poly.length; k++) {
      const i = poly[k];
      if (!(i >= 0 && i < count)) continue;
      const x = normals[i * 3];
      const y = normals[i * 3 + 1];
      const z = normals[i * 3 + 2];
      const l = Math.hypot(x, y, z);
      if (!(l > 1e-6)) continue;
      if ((x * nx + y * ny + z * nz) / l < cosLimit) return true;
    }
  }
  return false;
}

/** Nom de fichier sans dossier ni extension (nom d'objet ou de scène par défaut). */
export function baseName(file: string, fallback: string): string {
  const s = String(file ?? '')
    .replace(/^.*[\/]/, '')
    .replace(/\.[^.]*$/, '')
    .trim();
  return s || fallback;
}
