import { newId } from '../ids';
import type { MeshData, Vec3 } from '../doc/schema';

/** Types de primitives (identiques à MESH_PRIMITIVE_KINDS de src/tools/menus.ts). */
export type PrimitiveKind = 'plane' | 'cube' | 'circle' | 'uvsphere' | 'icosphere' | 'cylinder' | 'cone' | 'torus';

/** Description d'un paramètre de primitive, pour le panneau « Ajuster la dernière opération ». */
export interface PrimitiveParamDef {
  key: string;
  label: string;
  type: 'float' | 'int';
  min: number;
  max: number;
  step: number;
  default: number;
}

export type PrimitiveParams = Record<string, number>;

const f = (key: string, label: string, def: number, min = 0, max = 1000, step = 0.1): PrimitiveParamDef => ({ key, label, type: 'float', min, max, step, default: def });
const i = (key: string, label: string, def: number, min: number, max: number): PrimitiveParamDef => ({ key, label, type: 'int', min, max, step: 1, default: def });

/** Paramètres de chaque primitive, avec les valeurs par défaut de Blender. */
export const PRIMITIVE_PARAMS: Record<PrimitiveKind, PrimitiveParamDef[]> = {
  plane: [f('size', 'Taille', 2, 0.001)],
  cube: [f('size', 'Taille', 2, 0.001)],
  circle: [i('vertices', 'Sommets', 32, 3, 512), f('radius', 'Rayon', 1, 0.001)],
  uvsphere: [i('segments', 'Segments', 32, 3, 256), i('rings', 'Anneaux', 16, 2, 128), f('radius', 'Rayon', 1, 0.001)],
  icosphere: [i('subdivisions', 'Subdivisions', 2, 1, 6), f('radius', 'Rayon', 1, 0.001)],
  cylinder: [i('vertices', 'Sommets', 32, 3, 512), f('radius', 'Rayon', 1, 0.001), f('depth', 'Hauteur', 2, 0.001)],
  cone: [i('vertices', 'Sommets', 32, 3, 512), f('radius1', 'Rayon de la base', 1, 0), f('radius2', 'Rayon du sommet', 0, 0), f('depth', 'Hauteur', 2, 0.001)],
  torus: [
    i('majorSegments', 'Segments majeurs', 48, 3, 256),
    i('minorSegments', 'Segments mineurs', 12, 3, 128),
    f('majorRadius', 'Rayon majeur', 1, 0.001),
    f('minorRadius', 'Rayon mineur', 0.25, 0.001),
  ],
};

/** Complète et borne les paramètres d'une primitive. */
export function resolvePrimitiveParams(kind: PrimitiveKind, params?: PrimitiveParams): PrimitiveParams {
  const out: PrimitiveParams = {};
  for (const def of PRIMITIVE_PARAMS[kind] ?? []) {
    let v = params?.[def.key];
    if (typeof v !== 'number' || !Number.isFinite(v)) v = def.default;
    if (def.type === 'int') v = Math.round(v);
    out[def.key] = Math.max(def.min, Math.min(def.max, v));
  }
  return out;
}

/** Petit constructeur de maillage à identifiants neufs. */
class Builder {
  verts = new Map<string, Vec3>();
  faces = new Map<string, string[]>();
  v(x: number, y: number, z: number): string {
    const id = newId(8);
    this.verts.set(id, [x, y, z]);
    return id;
  }
  f(loop: string[]): void {
    if (loop.length >= 3 && new Set(loop).size === loop.length) this.faces.set(newId(8), loop);
  }
  done(): MeshData {
    return { verts: this.verts, faces: this.faces };
  }
}

/**
 * Crée une primitive centrée à l'origine, axe vertical Z, normales vers l'extérieur.
 * Les paramètres absents prennent les valeurs par défaut de PRIMITIVE_PARAMS.
 */
export function createPrimitive(kind: PrimitiveKind, params?: PrimitiveParams): MeshData {
  const p = resolvePrimitiveParams(kind, params);
  const b = new Builder();
  switch (kind) {
    case 'plane': {
      const h = p.size / 2;
      b.f([b.v(-h, -h, 0), b.v(h, -h, 0), b.v(h, h, 0), b.v(-h, h, 0)]);
      break;
    }
    case 'cube': {
      const h = p.size / 2;
      const c = [b.v(-h, -h, -h), b.v(h, -h, -h), b.v(h, h, -h), b.v(-h, h, -h), b.v(-h, -h, h), b.v(h, -h, h), b.v(h, h, h), b.v(-h, h, h)];
      const quads = [
        [0, 3, 2, 1],
        [4, 5, 6, 7],
        [0, 1, 5, 4],
        [1, 2, 6, 5],
        [2, 3, 7, 6],
        [3, 0, 4, 7],
      ];
      for (const q of quads) b.f(q.map((k) => c[k]));
      break;
    }
    case 'circle': {
      const n = p.vertices;
      const ring: string[] = [];
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        ring.push(b.v(Math.cos(a) * p.radius, Math.sin(a) * p.radius, 0));
      }
      b.f(ring);
      break;
    }
    case 'uvsphere': {
      const seg = p.segments;
      const rings = p.rings;
      const r = p.radius;
      const top = b.v(0, 0, r);
      const bottom = b.v(0, 0, -r);
      // rows[j] : anneau j (1..rings-1), du haut vers le bas
      const rows: string[][] = [];
      for (let j = 1; j < rings; j++) {
        const phi = (j / rings) * Math.PI;
        const z = Math.cos(phi) * r;
        const rr = Math.sin(phi) * r;
        const row: string[] = [];
        for (let k = 0; k < seg; k++) {
          const a = (k / seg) * Math.PI * 2;
          row.push(b.v(Math.cos(a) * rr, Math.sin(a) * rr, z));
        }
        rows.push(row);
      }
      for (let k = 0; k < seg; k++) {
        const k2 = (k + 1) % seg;
        b.f([top, rows[0][k], rows[0][k2]]);
        for (let j = 0; j + 1 < rows.length; j++) b.f([rows[j][k], rows[j + 1][k], rows[j + 1][k2], rows[j][k2]]);
        b.f([bottom, rows[rows.length - 1][k2], rows[rows.length - 1][k]]);
      }
      break;
    }
    case 'icosphere': {
      const t = (1 + Math.sqrt(5)) / 2;
      let pts: Vec3[] = [
        [-1, t, 0],
        [1, t, 0],
        [-1, -t, 0],
        [1, -t, 0],
        [0, -1, t],
        [0, 1, t],
        [0, -1, -t],
        [0, 1, -t],
        [t, 0, -1],
        [t, 0, 1],
        [-t, 0, -1],
        [-t, 0, 1],
      ];
      let tris: number[][] = [
        [0, 11, 5],
        [0, 5, 1],
        [0, 1, 7],
        [0, 7, 10],
        [0, 10, 11],
        [1, 5, 9],
        [5, 11, 4],
        [11, 10, 2],
        [10, 7, 6],
        [7, 1, 8],
        [3, 9, 4],
        [3, 4, 2],
        [3, 2, 6],
        [3, 6, 8],
        [3, 8, 9],
        [4, 9, 5],
        [2, 4, 11],
        [6, 2, 10],
        [8, 6, 7],
        [9, 8, 1],
      ];
      const norm = (q: Vec3): Vec3 => {
        const l = Math.hypot(q[0], q[1], q[2]) || 1;
        return [q[0] / l, q[1] / l, q[2] / l];
      };
      pts = pts.map(norm);
      // Comme Blender : subdivisions = 1 donne l'icosaèdre de base.
      for (let s = 1; s < p.subdivisions; s++) {
        const mid = new Map<number, number>();
        const midpoint = (a: number, c: number): number => {
          const key = a < c ? a * 1e7 + c : c * 1e7 + a;
          let m = mid.get(key);
          if (m === undefined) {
            m = pts.length;
            pts.push(norm([(pts[a][0] + pts[c][0]) / 2, (pts[a][1] + pts[c][1]) / 2, (pts[a][2] + pts[c][2]) / 2]));
            mid.set(key, m);
          }
          return m;
        };
        const nextTris: number[][] = [];
        for (const [a, c, d] of tris) {
          const ac = midpoint(a, c);
          const cd = midpoint(c, d);
          const da = midpoint(d, a);
          nextTris.push([a, ac, da], [c, cd, ac], [d, da, cd], [ac, cd, da]);
        }
        tris = nextTris;
      }
      const ids = pts.map((q) => b.v(q[0] * p.radius, q[1] * p.radius, q[2] * p.radius));
      for (const tri of tris) b.f(tri.map((k) => ids[k]));
      break;
    }
    case 'cylinder': {
      const n = p.vertices;
      const h = p.depth / 2;
      const lo: string[] = [];
      const hi: string[] = [];
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const x = Math.cos(a) * p.radius;
        const y = Math.sin(a) * p.radius;
        lo.push(b.v(x, y, -h));
        hi.push(b.v(x, y, h));
      }
      for (let k = 0; k < n; k++) {
        const k2 = (k + 1) % n;
        b.f([lo[k], lo[k2], hi[k2], hi[k]]);
      }
      b.f(hi.slice());
      b.f(lo.slice().reverse());
      break;
    }
    case 'cone': {
      const n = p.vertices;
      const h = p.depth / 2;
      const ringAt = (radius: number, z: number): string[] => {
        const out: string[] = [];
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2;
          out.push(b.v(Math.cos(a) * radius, Math.sin(a) * radius, z));
        }
        return out;
      };
      const r1 = p.radius1;
      const r2 = p.radius2;
      if (r1 <= 1e-9 && r2 <= 1e-9) break;
      const lo = r1 > 1e-9 ? ringAt(r1, -h) : null;
      const hi = r2 > 1e-9 ? ringAt(r2, h) : null;
      if (lo && hi) {
        for (let k = 0; k < n; k++) {
          const k2 = (k + 1) % n;
          b.f([lo[k], lo[k2], hi[k2], hi[k]]);
        }
        b.f(hi.slice());
        b.f(lo.slice().reverse());
      } else if (lo) {
        const apex = b.v(0, 0, h);
        for (let k = 0; k < n; k++) b.f([lo[k], lo[(k + 1) % n], apex]);
        b.f(lo.slice().reverse());
      } else if (hi) {
        const apex = b.v(0, 0, -h);
        for (let k = 0; k < n; k++) b.f([hi[(k + 1) % n], hi[k], apex]);
        b.f(hi.slice());
      }
      break;
    }
    case 'torus': {
      const M = p.majorSegments;
      const m = p.minorSegments;
      const grid: string[][] = [];
      for (let a = 0; a < M; a++) {
        const u = (a / M) * Math.PI * 2;
        const row: string[] = [];
        for (let c = 0; c < m; c++) {
          const v = (c / m) * Math.PI * 2;
          const rr = p.majorRadius + Math.cos(v) * p.minorRadius;
          row.push(b.v(Math.cos(u) * rr, Math.sin(u) * rr, Math.sin(v) * p.minorRadius));
        }
        grid.push(row);
      }
      for (let a = 0; a < M; a++) {
        const a2 = (a + 1) % M;
        for (let c = 0; c < m; c++) {
          const c2 = (c + 1) % m;
          b.f([grid[a][c], grid[a2][c], grid[a2][c2], grid[a][c2]]);
        }
      }
      break;
    }
    default:
      break;
  }
  return b.done();
}
