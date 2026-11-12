import { BufferAttribute, BufferGeometry } from 'three';
import { ADDITION, Brush, Evaluator, INTERSECTION, SUBTRACTION } from 'three-bvh-csg';
import type { BooleanParams, MeshData, Vec3 } from '../../doc/schema';
import type { ModifierContext } from '../types';
import { loopPositions, newellNormal, transformMesh } from '../topology';
import { triangulatePolygon } from '../triangulate';
import { hashId } from './common';

/** Tolérance de soudure des sommets produits par l'opération (mètres). */
const WELD_TOL = 1e-5;
/** Tolérance de coplanarité pour refusionner les triangles (cosinus entre normales et distance au plan). */
const COPLANAR_COS = 1 - 1e-7;
const COPLANAR_DIST = 1e-6;

/**
 * Opération booléenne (différence, union, intersection) avec le maillage évalué d'un autre objet.
 * Les deux maillages sont triangulés, combinés par three-bvh-csg, puis reconvertis en MeshData :
 * sommets soudés, triangles coplanaires adjacents refusionnés en polygones convexes.
 * Les sommets qui coïncident avec un sommet d'entrée gardent son identifiant ; les autres reçoivent
 * un identifiant dérivé du modificateur et de leur rang (déterministe). Opérande absent → maillage inchangé.
 */
export function booleanModifier(mesh: MeshData, params: BooleanParams, ctx: ModifierContext, salt: string): MeshData {
  if (!params.target || mesh.faces.size === 0) return mesh;
  const operand = ctx.getOperand(params.target);
  if (!operand) return mesh;
  const op = params.operation === 'union' ? ADDITION : params.operation === 'intersect' ? INTERSECTION : SUBTRACTION;
  const other = transformMesh(operand.mesh, operand.toLocal);

  const ga = toGeometry(mesh);
  const gb = toGeometry(other);
  if (ga.getAttribute('position').count === 0) return mesh;
  if (gb.getAttribute('position').count === 0) {
    // opérande vide : la différence et l'union laissent l'objet intact, l'intersection le vide
    return params.operation === 'intersect' ? { verts: new Map(), faces: new Map() } : mesh;
  }
  const a = new Brush(ga);
  const b = new Brush(gb);
  a.updateMatrixWorld(true);
  b.updateMatrixWorld(true);
  const evaluator = new Evaluator();
  evaluator.attributes = ['position'];
  evaluator.useGroups = false;
  const result = quietBvhWarnings(() => evaluator.evaluate(a, b, op));
  const pos = result.geometry.getAttribute('position');
  const index = result.geometry.getIndex();
  const tris: number[] = [];
  const coords: number[] = [];
  for (let i = 0; i < pos.count; i++) coords.push(pos.getX(i), pos.getY(i), pos.getZ(i));
  if (index) for (let i = 0; i < index.count; i++) tris.push(index.getX(i));
  else for (let i = 0; i < pos.count; i++) tris.push(i);
  ga.dispose();
  gb.dispose();
  result.geometry.dispose();
  return rebuildMesh(coords, tris, mesh, salt);
}

/**
 * three-bvh-csg construit ses BVH avec l'option obsolète « maxLeafSize » : three-mesh-bvh émet alors
 * un avertissement à CHAQUE évaluation. On filtre ce seul message pendant l'appel.
 */
function quietBvhWarnings<T>(fn: () => T): T {
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('"maxLeafSize" option has been deprecated')) return;
    warn.apply(console, args);
  };
  try {
    return fn();
  } finally {
    console.warn = warn;
  }
}

/** Géométrie three.js non indexée (positions seules) des faces valides d'un maillage. */
function toGeometry(mesh: MeshData): BufferGeometry {
  const out: number[] = [];
  for (const loop of mesh.faces.values()) {
    if (loop.length < 3) continue;
    const pts = loopPositions(mesh, loop);
    if (pts.length !== loop.length) continue;
    const t = triangulatePolygon(pts);
    for (let i = 0; i + 2 < t.length; i += 3) {
      const p0 = pts[t[i]];
      const p1 = pts[t[i + 1]];
      const p2 = pts[t[i + 2]];
      out.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(out), 3));
  return g;
}

/**
 * Reconstruit un MeshData à partir d'une soupe de triangles : soudure (grille de pas WELD_TOL,
 * cellules voisines comprises), suppression des triangles dégénérés, puis fusion gloutonne des
 * triangles coplanaires adjacents tant que le polygone reste convexe.
 */
function rebuildMesh(coords: number[], tris: number[], input: MeshData, salt: string): MeshData {
  // ---------------------------------------------------------------- soudure
  const grid = new Map<string, number[]>();
  const wp: Vec3[] = [];
  const cell = (x: number) => Math.floor(x / WELD_TOL);
  const find = (p: Vec3): number => {
    const cx = cell(p[0]);
    const cy = cell(p[1]);
    const cz = cell(p[2]);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const l = grid.get(cx + dx + ',' + (cy + dy) + ',' + (cz + dz));
          if (!l) continue;
          for (const i of l) {
            const q = wp[i];
            if (Math.abs(q[0] - p[0]) <= WELD_TOL && Math.abs(q[1] - p[1]) <= WELD_TOL && Math.abs(q[2] - p[2]) <= WELD_TOL) return i;
          }
        }
      }
    }
    return -1;
  };
  const insert = (p: Vec3): number => {
    const i = wp.length;
    wp.push(p);
    const k = cell(p[0]) + ',' + cell(p[1]) + ',' + cell(p[2]);
    const l = grid.get(k);
    if (l) l.push(i);
    else grid.set(k, [i]);
    return i;
  };
  // Les sommets d'entrée sont insérés d'abord : un sommet du résultat qui en coïncide reprend leur identifiant.
  const ids: string[] = [];
  for (const [id, p] of input.verts) {
    if (find(p) !== -1) continue;
    insert([p[0], p[1], p[2]]);
    ids.push(id);
  }
  const nInput = wp.length;
  const remap = new Int32Array(coords.length / 3);
  for (let i = 0; i < remap.length; i++) {
    const p: Vec3 = [coords[i * 3], coords[i * 3 + 1], coords[i * 3 + 2]];
    let w = find(p);
    if (w === -1) w = insert(p);
    remap[i] = w;
  }

  // ---------------------------------------------------------------- triangles valides
  const T: [number, number, number][] = [];
  const TN: Vec3[] = [];
  const triSeen = new Set<string>();
  for (let i = 0; i + 2 < tris.length; i += 3) {
    const a = remap[tris[i]];
    const b = remap[tris[i + 1]];
    const c = remap[tris[i + 2]];
    if (a === b || b === c || c === a) continue;
    const n = newellNormal([wp[a], wp[b], wp[c]]);
    const l = Math.hypot(n[0], n[1], n[2]);
    if (l < 1e-14) continue;
    // doublon exact (même triangle, même sens) : on n'en garde qu'un
    const m = Math.min(a, b, c);
    const key = m === a ? `${a},${b},${c}` : m === b ? `${b},${c},${a}` : `${c},${a},${b}`;
    if (triSeen.has(key)) continue;
    triSeen.add(key);
    T.push([a, b, c]);
    TN.push([n[0] / l, n[1] / l, n[2] / l]);
  }

  // Arête orientée a→b → triangle.
  const half = new Map<string, number>();
  const halfCount = new Map<string, number>();
  for (let t = 0; t < T.length; t++) {
    const tri = T[t];
    for (let k = 0; k < 3; k++) {
      const key = tri[k] + ',' + tri[(k + 1) % 3];
      half.set(key, t);
      halfCount.set(key, (halfCount.get(key) ?? 0) + 1);
    }
  }

  // ---------------------------------------------------------------- fusion des triangles coplanaires
  const used = new Uint8Array(T.length);
  const polys: number[][] = [];
  for (let t0 = 0; t0 < T.length; t0++) {
    if (used[t0]) continue;
    used[t0] = 1;
    const n = TN[t0];
    const d0 = n[0] * wp[T[t0][0]][0] + n[1] * wp[T[t0][0]][1] + n[2] * wp[T[t0][0]][2];
    const poly = T[t0].slice();
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        const twinKey = b + ',' + a;
        if (halfCount.get(twinKey) !== 1 || halfCount.get(a + ',' + b) !== 1) continue;
        const t = half.get(twinKey)!;
        if (used[t]) continue;
        const m = TN[t];
        if (n[0] * m[0] + n[1] * m[1] + n[2] * m[2] < COPLANAR_COS) continue;
        const tri = T[t];
        const k = tri.indexOf(b);
        const c = tri[(k + 2) % 3];
        if (poly.includes(c)) continue;
        const pc = wp[c];
        if (Math.abs(n[0] * pc[0] + n[1] * pc[1] + n[2] * pc[2] - d0) > COPLANAR_DIST) continue;
        // convexité aux trois coins modifiés : (prev(a), a, c), (a, c, b), (c, b, next(b))
        const pa = poly[(i + poly.length - 1) % poly.length];
        const nb = poly[(i + 2) % poly.length];
        if (!convexCorner(wp[pa], wp[a], pc, n) || !convexCorner(wp[a], pc, wp[b], n) || !convexCorner(pc, wp[b], wp[nb], n)) continue;
        used[t] = 1;
        poly.splice(i + 1, 0, c);
        grew = true;
        break;
      }
    }
    polys.push(poly);
  }

  repairTJunctions(polys, wp);

  // ---------------------------------------------------------------- MeshData
  const verts = new Map<string, Vec3>();
  const faces = new Map<string, string[]>();
  const vid = (i: number): string => {
    if (i < nInput) return ids[i];
    return hashId(salt, 'v', i - nInput);
  };
  const usedV = new Uint8Array(wp.length);
  for (let f = 0; f < polys.length; f++) {
    const loop = polys[f].map((i) => {
      usedV[i] = 1;
      return vid(i);
    });
    faces.set(hashId(salt, 'f', f), loop);
  }
  for (let i = 0; i < wp.length; i++) if (usedV[i]) verts.set(vid(i), wp[i]);
  return { verts, faces };
}

/**
 * Supprime les jonctions en T laissées par la découpe : un sommet posé au milieu d'une arête sans
 * jumelle est inséré dans les polygones qui longent cette arête, pour que le maillage soit fermé.
 */
function repairTJunctions(polys: number[][], wp: Vec3[]): void {
  for (let pass = 0; pass < 3; pass++) {
    const directed = new Set<string>();
    for (const poly of polys) for (let i = 0; i < poly.length; i++) directed.add(poly[i] + ',' + poly[(i + 1) % poly.length]);
    const open: [number, number, number][] = []; // polygone, indice de l'arête, -
    const cand = new Set<number>();
    for (let f = 0; f < polys.length; f++) {
      const poly = polys[f];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        if (directed.has(b + ',' + a)) continue;
        open.push([f, i, 0]);
        cand.add(a);
        cand.add(b);
      }
    }
    if (open.length === 0) return;
    const cl = [...cand];
    const inserts = new Map<number, Map<number, number[]>>(); // polygone → indice d'arête → sommets à insérer
    for (const [f, i] of open) {
      const poly = polys[f];
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const pa = wp[a];
      const pb = wp[b];
      const dx = pb[0] - pa[0];
      const dy = pb[1] - pa[1];
      const dz = pb[2] - pa[2];
      const len2 = dx * dx + dy * dy + dz * dz;
      if (len2 < 1e-20) continue;
      const found: [number, number][] = [];
      for (const c of cl) {
        if (c === a || c === b) continue;
        const pc = wp[c];
        const t = ((pc[0] - pa[0]) * dx + (pc[1] - pa[1]) * dy + (pc[2] - pa[2]) * dz) / len2;
        if (t <= 1e-9 || t >= 1 - 1e-9) continue;
        const ex = pa[0] + dx * t - pc[0];
        const ey = pa[1] + dy * t - pc[1];
        const ez = pa[2] + dz * t - pc[2];
        if (ex * ex + ey * ey + ez * ez > (WELD_TOL * 4) ** 2) continue;
        found.push([t, c]);
      }
      if (found.length === 0) continue;
      found.sort((x, y) => x[0] - y[0]);
      let m = inserts.get(f);
      if (!m) inserts.set(f, (m = new Map()));
      m.set(i, found.map((x) => x[1]));
    }
    if (inserts.size === 0) return;
    for (const [f, m] of inserts) {
      const poly = polys[f];
      const out: number[] = [];
      for (let i = 0; i < poly.length; i++) {
        out.push(poly[i]);
        const ins = m.get(i);
        if (ins) for (const c of ins) if (!out.includes(c) && !poly.includes(c)) out.push(c);
      }
      polys[f] = out;
    }
  }
}

/** Coin (p, q, r) convexe ou plat, vu depuis la normale `n`. */
function convexCorner(p: Vec3, q: Vec3, r: Vec3, n: Vec3): boolean {
  const ux = q[0] - p[0];
  const uy = q[1] - p[1];
  const uz = q[2] - p[2];
  const vx = r[0] - q[0];
  const vy = r[1] - q[1];
  const vz = r[2] - q[2];
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  const scaleRef = Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz);
  return cx * n[0] + cy * n[1] + cz * n[2] >= -1e-9 * scaleRef;
}
