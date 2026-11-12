import { Matrix4, Vector3 } from 'three';
import type { ObjectType } from '../../../core/doc/schema';
import type { Rec } from './reader';

/**
 * Objets : matrice monde recalculée (la matrice n'est plus écrite dans les fichiers récents),
 * parentage, classement par type.
 */

// Object.type (eObjectType)
export const OB_EMPTY = 0;
export const OB_MESH = 1;
export const OB_LAMP = 10;
export const OB_CAMERA = 11;
export const OB_ARMATURE = 25;

/** Types que seul Blender sait convertir en maillage : raison « pending » en français. */
const PENDING_TYPES: Record<number, string> = {
  2: 'courbe',
  3: 'surface',
  4: 'texte',
  5: 'métaballe',
  26: 'grease pencil',
  27: 'courbes',
  28: 'nuage de points',
  29: 'volume',
  30: 'grease pencil',
};

/** Types repris comme simples vides (aucune géométrie à évaluer), avec un avertissement. */
const EMPTY_TYPES: Record<number, string> = {
  12: 'haut-parleur',
  13: 'sonde de lumière',
  22: 'lattice',
  25: 'armature',
};

export interface ObjectKind {
  type: ObjectType;
  /** Raison de la mise en attente (objet que Blender doit évaluer), sinon null. */
  pending: string | null;
  /** Objet Blender repris comme vide faute d'équivalent (« armature »…), sinon null. */
  emptyOf: string | null;
}

export function objectKind(ob: Rec): ObjectKind {
  const t = ob.num('type', OB_EMPTY);
  if (t === OB_MESH) return { type: 'mesh', pending: null, emptyOf: null };
  if (t === OB_LAMP) return { type: 'light', pending: null, emptyOf: null };
  if (t === OB_CAMERA) return { type: 'camera', pending: null, emptyOf: null };
  if (t in PENDING_TYPES) return { type: 'empty', pending: PENDING_TYPES[t], emptyOf: null };
  if (t in EMPTY_TYPES) return { type: 'empty', pending: null, emptyOf: EMPTY_TYPES[t] };
  if (t === OB_EMPTY) return { type: 'empty', pending: null, emptyOf: null };
  return { type: 'empty', pending: null, emptyOf: `type n° ${t}` };
}

// ------------------------------------------------------------------ rotations

const ROT_MODE_QUAT = 0;
const ROT_MODE_AXISANGLE = -1;
/** Ordres d'Euler de Blender (rotmode 1 à 6) : axes dans l'ordre d'application. */
const EULER_ORDERS = ['XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX'];

function axisRotation(axis: string, a: number): Matrix4 {
  const m = new Matrix4();
  if (axis === 'X') m.makeRotationX(a);
  else if (axis === 'Y') m.makeRotationY(a);
  else m.makeRotationZ(a);
  return m;
}

/** Euler de Blender dans l'ordre `order` (« ZXY » : Z appliquée d'abord) : R = R3 · R2 · R1. */
export function eulerMatrix(e: readonly number[], order: string): Matrix4 {
  const idx: Record<string, number> = { X: 0, Y: 1, Z: 2 };
  const out = new Matrix4();
  for (const axis of order) out.premultiply(axisRotation(axis, e[idx[axis]] ?? 0));
  return out;
}

/** Quaternion (w, x, y, z) normalisé, comme Blender ; nul → identité. */
export function quatMatrix(q: readonly number[]): Matrix4 {
  let [w, x, y, z] = [q[0] ?? 1, q[1] ?? 0, q[2] ?? 0, q[3] ?? 0];
  const len = Math.hypot(w, x, y, z);
  if (!(len > 1e-12) || !Number.isFinite(len)) return new Matrix4();
  w /= len;
  x /= len;
  y /= len;
  z /= len;
  const m = new Matrix4();
  // Formule de quat_to_mat3 (colonnes).
  m.set(
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), 0,
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x), 0,
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y), 0,
    0, 0, 0, 1,
  );
  return m;
}

/** Axe-angle ; axe nul → identité. */
export function axisAngleMatrix(axis: readonly number[], angle: number): Matrix4 {
  const [x, y, z] = [axis[0] ?? 0, axis[1] ?? 0, axis[2] ?? 0];
  const len = Math.hypot(x, y, z);
  if (!(len > 1e-12) || !Number.isFinite(angle)) return new Matrix4();
  const s = Math.sin(angle / 2);
  return quatMatrix([Math.cos(angle / 2), (x / len) * s, (y / len) * s, (z / len) * s]);
}

function vec(r: Rec, name: string | readonly string[], def: number[]): number[] {
  const v = r.nums(name, def.length);
  if (!v || v.length < def.length) return def;
  return v.map((x, i) => (Number.isFinite(x) ? x : def[i]));
}

/** Rotation de l'objet (BKE_object_rot_to_mat3, deltas compris). */
export function rotationMatrix(ob: Rec): Matrix4 {
  const mode = ob.has('rotmode') ? ob.num('rotmode') : 1;
  let rot: Matrix4;
  let drot: Matrix4;
  if (mode > 0 && mode <= 6) {
    const order = EULER_ORDERS[mode - 1];
    rot = eulerMatrix(vec(ob, 'rot', [0, 0, 0]), order);
    drot = eulerMatrix(vec(ob, 'drot', [0, 0, 0]), order);
  } else if (mode === ROT_MODE_AXISANGLE) {
    rot = axisAngleMatrix(vec(ob, 'rotAxis', [0, 1, 0]), ob.num('rotAngle'));
    drot = axisAngleMatrix(vec(ob, 'drotAxis', [0, 1, 0]), ob.num('drotAngle'));
  } else if (mode === ROT_MODE_QUAT) {
    rot = quatMatrix(vec(ob, 'quat', [1, 0, 0, 0]));
    drot = quatMatrix(vec(ob, 'dquat', [1, 0, 0, 0]));
  } else {
    rot = eulerMatrix(vec(ob, 'rot', [0, 0, 0]), 'XYZ');
    drot = eulerMatrix(vec(ob, 'drot', [0, 0, 0]), 'XYZ');
  }
  return drot.multiply(rot);
}

/** Matrice locale (BKE_object_to_mat4) : translation · rotation · échelle, deltas compris. */
export function localMatrix(ob: Rec): Matrix4 {
  const size = vec(ob, ['scale', 'size'], [1, 1, 1]);
  let scale: number[];
  if (ob.has('dscale')) {
    const d = vec(ob, 'dscale', [1, 1, 1]);
    scale = [size[0] * d[0], size[1] * d[1], size[2] * d[2]];
  } else {
    // Blender 2.5x : delta d'échelle additif.
    const d = vec(ob, 'dsize', [0, 0, 0]);
    scale = [size[0] + d[0], size[1] + d[1], size[2] + d[2]];
  }
  const m = rotationMatrix(ob);
  m.scale(new Vector3(scale[0], scale[1], scale[2]));
  const loc = vec(ob, 'loc', [0, 0, 0]);
  const dloc = vec(ob, 'dloc', [0, 0, 0]);
  m.setPosition(loc[0] + dloc[0], loc[1] + dloc[1], loc[2] + dloc[2]);
  return m;
}

/** Matrice 4×4 d'un champ `float m[4][4]` (stockée colonne par colonne, comme three.js) ; null si absente ou dégénérée. */
export function storedMatrix(r: Rec, name: string | readonly string[]): Matrix4 | null {
  const v = r.nums(name, 16);
  if (!v || v.length < 16 || !v.every(Number.isFinite)) return null;
  const m = new Matrix4().fromArray(v);
  const det = m.determinant();
  return det !== 0 && Number.isFinite(det) ? m : null;
}

// Object.partype
const PARTYPE = 15;
const PAROBJECT = 0;
const PARSKEL = 4;
const PARVERT1 = 5;
const PARVERT3 = 6;
const PARBONE = 7;

/** Nature du parentage, quand il n'est pas recalculable (« sommet », « os »), sinon null. */
export function specialParent(ob: Rec): string | null {
  if (ob.ptr('parent') === 0) return null;
  const t = ob.num('partype') & PARTYPE;
  if (t === PAROBJECT || t === PARSKEL) return null;
  if (t === PARVERT1 || t === PARVERT3) return 'sommet';
  if (t === PARBONE) return 'os';
  return 'spécial';
}

/** Vrai si l'objet a des contraintes actives (non recalculées). */
export function hasConstraints(ob: Rec): boolean {
  return ob.list('constraints').length > 0;
}

/**
 * Calcul des matrices monde, mémorisé par bloc d'objet. `world = parent · parentinv · local`.
 * Contraintes et parentage à un sommet ou à un os ne sont pas recalculables : on prend alors la
 * matrice monde enregistrée par Blender si le fichier en contient une (jusqu'à 4.0), sinon le calcul
 * simple (l'appelant avertit).
 */
export class WorldMatrices {
  private readonly cache = new Map<number, Matrix4>();
  private readonly busy = new Set<number>();

  /** Matrice monde de l'objet (copie à ne pas modifier). */
  get(ob: Rec): Matrix4 {
    const known = this.cache.get(ob.block);
    if (known) return known;
    if (this.busy.has(ob.block) || this.busy.size > 4096) return localMatrix(ob); // cycle de parenté : on coupe
    this.busy.add(ob.block);
    let world: Matrix4;
    const stored = storedMatrix(ob, ['obmat', 'object_to_world']);
    if (stored && (specialParent(ob) !== null || hasConstraints(ob))) {
      world = stored;
    } else {
      world = localMatrix(ob);
      const parent = ob.ptr('parent') !== 0 ? ob.id('parent') : null;
      if (parent && parent.st.name === 'Object') {
        const inv = storedMatrix(ob, 'parentinv') ?? new Matrix4();
        world = this.get(parent).clone().multiply(inv).multiply(world);
      }
    }
    this.busy.delete(ob.block);
    this.cache.set(ob.block, world);
    return world;
  }
}
