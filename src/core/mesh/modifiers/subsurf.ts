import type { MeshData, SubsurfParams, Vec3 } from '../../doc/schema';
import { clamp, finiteOr, hashId } from './common';

/** Niveau maximal et plafond de faces (au-delà, les niveaux restants sont ignorés). */
const MAX_LEVELS = 4;
const MAX_FACES = 2_000_000;

/**
 * Surface de subdivision de Catmull-Clark.
 * N-gones gérés (chaque face à n côtés donne n quads) ; les bords ouverts et les arêtes
 * non-manifold suivent la règle des plis (courbe cubique le long du bord). Les coins sont conservés :
 * sommet relié à 1 ou 3+ arêtes vives, ou sommet de bord n'appartenant qu'à une seule face
 * (comportement « Keep Corners » de Blender).
 */
export function subsurfModifier(mesh: MeshData, params: SubsurfParams, salt: string): MeshData {
  const levels = clamp(Math.round(finiteOr(params.levels, 1)), 0, MAX_LEVELS);
  let cur = mesh;
  for (let l = 0; l < levels; l++) {
    if (cur.faces.size === 0) break;
    let corners = 0;
    for (const loop of cur.faces.values()) corners += loop.length;
    if (corners > MAX_FACES) break;
    cur = subdivideOnce(cur, salt + ':' + l);
  }
  return cur;
}

interface EdgeAcc {
  a: string;
  b: string;
  /** Nombre de faces incidentes. */
  n: number;
  /** Somme des points de faces incidentes. */
  sum: Vec3;
  id: string;
}

interface VertAcc {
  /** Somme des points de faces incidentes et leur nombre. */
  f: Vec3;
  nf: number;
  /** Somme des milieux d'arêtes incidentes et leur nombre. */
  r: Vec3;
  ne: number;
  /** Somme des voisins reliés par une arête vive (bord ou non-manifold) et leur nombre. */
  s: Vec3;
  ns: number;
}

function subdivideOnce(mesh: MeshData, salt: string): MeshData {
  const facePoint = new Map<string, Vec3>();
  const facePointId = new Map<string, string>();
  const edges = new Map<string, EdgeAcc>();
  const acc = new Map<string, VertAcc>();
  const valid: [string, string[]][] = [];

  const accOf = (v: string): VertAcc => {
    let a = acc.get(v);
    if (!a) {
      a = { f: [0, 0, 0], nf: 0, r: [0, 0, 0], ne: 0, s: [0, 0, 0], ns: 0 };
      acc.set(v, a);
    }
    return a;
  };

  for (const [fid, loop] of mesh.faces) {
    const n = loop.length;
    if (n < 3) continue;
    let ok = true;
    let x = 0;
    let y = 0;
    let z = 0;
    for (let i = 0; i < n; i++) {
      const p = mesh.verts.get(loop[i]);
      if (!p || loop[i] === loop[(i + 1) % n]) {
        ok = false;
        break;
      }
      x += p[0];
      y += p[1];
      z += p[2];
    }
    if (!ok) continue;
    const fp: Vec3 = [x / n, y / n, z / n];
    valid.push([fid, loop]);
    facePoint.set(fid, fp);
    facePointId.set(fid, hashId(salt, 'f', fid));
    for (let i = 0; i < n; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % n];
      const va = accOf(a);
      va.f[0] += fp[0];
      va.f[1] += fp[1];
      va.f[2] += fp[2];
      va.nf++;
      const key = a < b ? a + '|' + b : b + '|' + a;
      let e = edges.get(key);
      if (!e) {
        e = { a, b, n: 0, sum: [0, 0, 0], id: hashId(salt, 'e', key) };
        edges.set(key, e);
      }
      e.n++;
      e.sum[0] += fp[0];
      e.sum[1] += fp[1];
      e.sum[2] += fp[2];
    }
  }
  if (valid.length === 0) return mesh;

  const verts = new Map<string, Vec3>();
  const faces = new Map<string, string[]>();
  const edgePoints: [string, Vec3][] = [];
  for (const e of edges.values()) {
    const pa = mesh.verts.get(e.a)!;
    const pb = mesh.verts.get(e.b)!;
    const mx = (pa[0] + pb[0]) / 2;
    const my = (pa[1] + pb[1]) / 2;
    const mz = (pa[2] + pb[2]) / 2;
    const va = accOf(e.a);
    const vb = accOf(e.b);
    va.r[0] += mx;
    va.r[1] += my;
    va.r[2] += mz;
    va.ne++;
    vb.r[0] += mx;
    vb.r[1] += my;
    vb.r[2] += mz;
    vb.ne++;
    if (e.n === 2) {
      edgePoints.push([e.id, [(pa[0] + pb[0] + e.sum[0]) / 4, (pa[1] + pb[1] + e.sum[1]) / 4, (pa[2] + pb[2] + e.sum[2]) / 4]]);
    } else {
      // arête vive (bord ou non-manifold) : simple milieu
      edgePoints.push([e.id, [mx, my, mz]]);
      va.s[0] += pb[0];
      va.s[1] += pb[1];
      va.s[2] += pb[2];
      va.ns++;
      vb.s[0] += pa[0];
      vb.s[1] += pa[1];
      vb.s[2] += pa[2];
      vb.ns++;
    }
  }

  // Sommets d'origine déplacés (mêmes identifiants).
  for (const [id, p] of mesh.verts) {
    const a = acc.get(id);
    if (!a || a.ne === 0) {
      verts.set(id, p);
    } else if (a.ns === 2 && a.nf > 1) {
      verts.set(id, [0.75 * p[0] + 0.125 * a.s[0], 0.75 * p[1] + 0.125 * a.s[1], 0.75 * p[2] + 0.125 * a.s[2]]);
    } else if (a.ns > 0) {
      verts.set(id, p);
    } else {
      const n = a.ne;
      const out: Vec3 = [0, 0, 0];
      for (let k = 0; k < 3; k++) out[k] = (a.f[k] / a.nf + (2 * a.r[k]) / a.ne + (n - 3) * p[k]) / n;
      verts.set(id, out);
    }
  }
  for (const [fid, fp] of facePoint) verts.set(facePointId.get(fid)!, fp);
  for (const [id, p] of edgePoints) verts.set(id, p);

  for (const [fid, loop] of valid) {
    const n = loop.length;
    const fpId = facePointId.get(fid)!;
    const ep = new Array<string>(n);
    for (let i = 0; i < n; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % n];
      ep[i] = edges.get(a < b ? a + '|' + b : b + '|' + a)!.id;
    }
    for (let i = 0; i < n; i++) {
      faces.set(hashId(salt, 'q', fid, i), [loop[i], ep[i], fpId, ep[(i + n - 1) % n]]);
    }
  }
  return { verts, faces };
}
