import { edgeKey, edgeVerts, type MeshData, type Vec3 } from '../../doc/schema';
import type { MeshOpResult } from '../types';
import { buildTopology, loopPositions, newellNormal, selectionOfFaces, vertexNormals } from '../topology';
import { anyPerpendicular, cross, distance, dot, normalize, sub } from '../vec';
import { emptyResult, isValidLoop, randomId, type IdGen } from './common';
import { loopHasEdge, loopSetKey } from './work';

/** Arêtes orientées existantes (a|b → face qui parcourt a → b). */
function directedEdges(mesh: MeshData): Map<string, string> {
  const out = new Map<string, string>();
  for (const [fid, loop] of mesh.faces) {
    for (let i = 0; i < loop.length; i++) out.set(loop[i] + '|' + loop[(i + 1) % loop.length], fid);
  }
  return out;
}

/** Ordre le long des arêtes de bord : renvoie la boucle (sens de la nouvelle face) si les arêtes de bord relient tous les sommets en une seule chaîne. */
function orderAlongBoundary(mesh: MeshData, verts: ReadonlySet<string>): string[] | null {
  const topo = buildTopology(mesh);
  // Pour chaque arête de bord entre deux sommets choisis : la nouvelle face doit la parcourir à l'envers.
  const next = new Map<string, string>();
  const hasPrev = new Set<string>();
  for (const [k, faces] of topo.edgeFaces) {
    if (faces.length !== 1) continue;
    const [a, b] = topo.edges.get(k)!;
    if (!verts.has(a) || !verts.has(b)) continue;
    const loop = mesh.faces.get(faces[0])!;
    const dir = loopHasEdge(loop, a, b);
    const [p, q] = dir === 1 ? [b, a] : [a, b];
    if (next.has(p) || hasPrev.has(q)) return null;
    next.set(p, q);
    hasPrev.add(q);
  }
  if (next.size === 0) return null;
  let start: string | undefined;
  for (const v of next.keys()) {
    if (!hasPrev.has(v)) {
      if (start !== undefined) return null; // plusieurs chaînes
      start = v;
    }
  }
  const closed = start === undefined;
  if (closed) start = next.keys().next().value as string;
  const out: string[] = [];
  let cur: string | undefined = start;
  const seen = new Set<string>();
  while (cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    cur = next.get(cur);
  }
  if (out.length !== verts.size) return null;
  if (closed && cur !== start) return null;
  return out;
}

/** Ordre angulaire autour du centre, dans le plan moyen des sommets. */
function orderAngular(mesh: MeshData, ids: readonly string[]): string[] {
  const pts = ids.map((v) => mesh.verts.get(v)!);
  const c: Vec3 = [0, 0, 0];
  for (const p of pts) {
    c[0] += p[0] / pts.length;
    c[1] += p[1] / pts.length;
    c[2] += p[2] / pts.length;
  }
  // Normale du plan : plus grand produit vectoriel entre le point le plus éloigné et les autres.
  let far = 0;
  let farD = -1;
  pts.forEach((p, i) => {
    const d = distance(p, c);
    if (d > farD) {
      farD = d;
      far = i;
    }
  });
  const r0 = sub(pts[far], c);
  let n: Vec3 = [0, 0, 0];
  let best = -1;
  for (const p of pts) {
    const cr = cross(r0, sub(p, c));
    const l = Math.hypot(cr[0], cr[1], cr[2]);
    if (l > best) {
      best = l;
      n = cr;
    }
  }
  n = normalize(n, [0, 0, 1]);
  const u = normalize(r0, anyPerpendicular(n));
  const w = cross(n, u);
  const ang = ids.map((v, i) => {
    const d = sub(pts[i], c);
    return { v, a: Math.atan2(dot(d, w), dot(d, u)) };
  });
  ang.sort((x, y) => x.a - y.a);
  return ang.map((x) => x.v);
}

/**
 * Créer une face (F) à partir de 3 sommets ou plus : ordonnés le long des arêtes de bord qui les
 * relient si elles forment une seule chaîne, sinon par ordre angulaire dans leur plan moyen.
 * L'orientation suit les faces voisines (arêtes partagées parcourues en sens inverse), à défaut
 * leurs normales. Refusé si une face avec exactement ces sommets existe déjà. `select` = la nouvelle face.
 */
export function fillFromVerts(mesh: MeshData, vertIds: Iterable<string>, idGen: IdGen = randomId): MeshOpResult {
  const set = new Set<string>();
  for (const v of vertIds) {
    const p = mesh.verts.get(v);
    if (p && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2])) set.add(v);
  }
  if (set.size < 3) return emptyResult();
  let loop = orderAlongBoundary(mesh, set);
  if (!loop) {
    loop = orderAngular(mesh, [...set]);
    // Orientation : votes des arêtes déjà portées par une face.
    const directed = directedEdges(mesh);
    let vote = 0;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      if (directed.has(a + '|' + b)) vote--;
      if (directed.has(b + '|' + a)) vote++;
    }
    if (vote === 0) {
      const normals = vertexNormals(mesh);
      const avg: Vec3 = [0, 0, 0];
      for (const v of loop) {
        const n = normals.get(v);
        if (!n) continue;
        avg[0] += n[0];
        avg[1] += n[1];
        avg[2] += n[2];
      }
      vote = Math.sign(dot(newellNormal(loopPositions(mesh, loop)), avg));
    }
    if (vote < 0) loop.reverse();
  }
  if (!isValidLoop(loop)) return emptyResult();
  const key = loopSetKey(loop);
  for (const l of mesh.faces.values()) if (l.length === loop.length && loopSetKey(l) === key) return emptyResult();
  const fid = idGen();
  return { delta: { setFaces: { [fid]: loop } }, select: selectionOfFaces([[fid, loop]]) };
}

/** Chaîne (ouverte) ou boucle (fermée) de sommets formée par un ensemble d'arêtes connexes. */
interface EdgeChain {
  verts: string[];
  closed: boolean;
}

/** Découpe un ensemble d'arêtes en composantes connexes ordonnées ; null si une composante n'est ni une chaîne ni une boucle. */
function chainsOf(edges: readonly [string, string][]): EdgeChain[] | null {
  const adj = new Map<string, string[]>();
  const push = (a: string, b: string) => {
    const l = adj.get(a);
    if (l) l.push(b);
    else adj.set(a, [b]);
  };
  for (const [a, b] of edges) {
    push(a, b);
    push(b, a);
  }
  for (const l of adj.values()) if (l.length > 2) return null;
  const seen = new Set<string>();
  const out: EdgeChain[] = [];
  const walk = (start: string): string[] => {
    const list = [start];
    seen.add(start);
    let prev = '';
    let cur = start;
    for (;;) {
      const nx = (adj.get(cur) ?? []).find((x) => x !== prev && !seen.has(x));
      if (nx === undefined) break;
      seen.add(nx);
      list.push(nx);
      prev = cur;
      cur = nx;
    }
    return list;
  };
  // Chaînes ouvertes d'abord (à partir d'une extrémité), puis boucles.
  for (const [v, l] of adj) if (l.length === 1 && !seen.has(v)) out.push({ verts: walk(v), closed: false });
  for (const v of adj.keys()) if (!seen.has(v)) out.push({ verts: walk(v), closed: true });
  return out;
}

/** Vote d'orientation : > 0 si les faces existantes parcourent la chaîne à l'envers (v[i+1] → v[i]). */
function reverseVote(directed: ReadonlyMap<string, string>, verts: readonly string[], closed: boolean): number {
  let vote = 0;
  const n = verts.length;
  const m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % n];
    if (directed.has(b + '|' + a)) vote++;
    if (directed.has(a + '|' + b)) vote--;
  }
  return vote;
}

/**
 * Pont (Relier deux boucles d'arêtes) : les arêtes doivent former exactement deux composantes de même
 * nombre d'arêtes, toutes deux fermées ou toutes deux ouvertes, sans sommet commun. Une bande de quads les
 * relie ; l'alignement minimise la distance entre sommets appariés et l'orientation suit les faces existantes.
 * `select` = les nouvelles faces.
 */
export function bridgeEdgeLoops(mesh: MeshData, edgeKeys: Iterable<string>, idGen: IdGen = randomId): MeshOpResult {
  const topo = buildTopology(mesh);
  const edges: [string, string][] = [];
  const seenKeys = new Set<string>();
  for (const k of edgeKeys) {
    if (seenKeys.has(k)) continue;
    seenKeys.add(k);
    const e = topo.edges.get(k);
    if (!e) {
      // Clé non canonique : on la normalise.
      const [a, b] = edgeVerts(k);
      const e2 = topo.edges.get(edgeKey(a, b));
      if (e2) edges.push(e2);
      continue;
    }
    edges.push(e);
  }
  if (edges.length < 2) return emptyResult();
  const chains = chainsOf(edges);
  if (!chains || chains.length !== 2) return emptyResult();
  const [c1, c2] = chains;
  if (c1.closed !== c2.closed) return emptyResult();
  const n1 = c1.closed ? c1.verts.length : c1.verts.length - 1;
  const n2 = c2.closed ? c2.verts.length : c2.verts.length - 1;
  if (n1 !== n2 || n1 < 1 || (c1.closed && c1.verts.length < 3)) return emptyResult();
  for (const v of c1.verts) if (c2.verts.includes(v)) return emptyResult();
  for (const v of [...c1.verts, ...c2.verts]) if (!mesh.verts.has(v)) return emptyResult();
  const closed = c1.closed;
  const directed = new Map<string, string>();
  for (const [fid, loop] of mesh.faces) for (let i = 0; i < loop.length; i++) directed.set(loop[i] + '|' + loop[(i + 1) % loop.length], fid);

  // A : orienté pour que les faces existantes le parcourent à l'envers (le pont le parcourt alors à l'endroit).
  let A = c1.verts.slice();
  const vA = reverseVote(directed, A, closed);
  if (vA < 0) A.reverse();
  // B : le pont parcourt B à l'envers ; les faces existantes doivent donc le parcourir à l'endroit.
  const P = (v: string): Vec3 => mesh.verts.get(v)!;
  const costOf = (B: readonly string[]): number => {
    let s = 0;
    for (let i = 0; i < A.length; i++) s += distance(P(A[i]), P(B[i]));
    return s;
  };
  const vB0 = reverseVote(directed, c2.verts, closed);
  const directions: string[][] = [];
  if (vA !== 0 && vB0 !== 0) directions.push(vB0 < 0 ? c2.verts.slice() : c2.verts.slice().reverse());
  else directions.push(c2.verts.slice(), c2.verts.slice().reverse());
  let best: string[] | null = null;
  let bestCost = Infinity;
  for (const base of directions) {
    const rotations = closed ? base.length : 1;
    for (let r = 0; r < rotations; r++) {
      const B = base.map((_, i) => base[(i + r) % base.length]);
      const cost = costOf(B);
      if (cost < bestCost - 1e-12) {
        bestCost = cost;
        best = B;
      }
    }
  }
  if (!best) return emptyResult();
  const B = best;
  // Sans indication d'orientation sur A, on se cale sur B (ou sur l'orientation géométrique par défaut).
  if (vA === 0) {
    const vB = reverseVote(directed, B, closed);
    if (vB > 0) {
      A = A.slice().reverse();
      B.reverse();
    }
  }
  const setFaces: Record<string, string[]> = {};
  const created: [string, string[]][] = [];
  const m = closed ? A.length : A.length - 1;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % A.length;
    const quad = [A[i], A[j], B[j], B[i]];
    const loop = quad.filter((v, k) => quad.indexOf(v) === k);
    if (!isValidLoop(loop)) continue;
    const fid = idGen();
    setFaces[fid] = loop;
    created.push([fid, loop]);
  }
  if (created.length === 0) return emptyResult();
  return { delta: { setFaces }, select: selectionOfFaces(created) };
}
