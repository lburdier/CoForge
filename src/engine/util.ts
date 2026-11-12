import { BufferAttribute, BufferGeometry, Color, Material, Matrix4, Object3D, Vector3 } from 'three';
import type { Vec3 } from '../core/doc/schema';

/** Couleurs de sélection (identiques à Blender). */
export const COLOR_ACTIVE = '#ffa028';
export const COLOR_SELECTED = '#d0661a';
export const COLOR_WIRE = '#0d0d0d';
export const COLOR_VIEWPORT_BG = '#3b3b3b';

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function toVec3(v: Vector3): Vec3 {
  return [v.x, v.y, v.z];
}

export function fromVec3(v: Vec3 | Vector3, out = new Vector3()): Vector3 {
  if (Array.isArray(v)) return out.set(v[0], v[1], v[2]);
  return out.copy(v as Vector3);
}

/** Interprète une couleur '#rrggbb' en tolérant les valeurs invalides. */
export function parseColor(hex: unknown, out = new Color(), fallback = '#cccccc'): Color {
  try {
    if (typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex)) return out.set(hex);
  } catch {
    /* ignore */
  }
  return out.set(fallback);
}

export function finite(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Géométrie de segments à partir d'un tableau plat xyz. */
export function lineGeometry(positions: ArrayLike<number>): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(positions instanceof Float32Array ? positions : new Float32Array(positions), 3));
  return g;
}

/** Libère récursivement géométries et matériaux d'un sous-arbre (sauf ceux listés dans `keep`). */
export function disposeTree(root: Object3D, keep?: Set<unknown>): void {
  root.traverse((o) => {
    const any = o as any;
    const g = any.geometry as BufferGeometry | undefined;
    if (g && !keep?.has(g)) g.dispose();
    const m = any.material as Material | Material[] | undefined;
    if (Array.isArray(m)) m.forEach((mm) => !keep?.has(mm) && mm.dispose());
    else if (m && !keep?.has(m)) m.dispose();
  });
}

/** Conversion Z-up (CoForge) → Y-up (glTF/OBJ) : (x, y, z) → (x, z, −y). */
export const Z_TO_Y = new Matrix4().makeRotationX(-Math.PI / 2);
/** Conversion Y-up → Z-up : (x, y, z) → (x, −z, y). */
export const Y_TO_Z = new Matrix4().makeRotationX(Math.PI / 2);

/** Cercle (segments) dans le plan local défini par deux axes. */
export function pushCircle(out: number[], radius: number, ax: Vec3, ay: Vec3, center: Vec3 = [0, 0, 0], segments = 32): void {
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    for (const a of [a0, a1]) {
      const c = Math.cos(a) * radius;
      const s = Math.sin(a) * radius;
      out.push(center[0] + ax[0] * c + ay[0] * s, center[1] + ax[1] * c + ay[1] * s, center[2] + ax[2] * c + ay[2] * s);
    }
  }
}
