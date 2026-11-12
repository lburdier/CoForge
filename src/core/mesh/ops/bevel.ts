import { edgeKey, edgeVerts, type MeshData, type Vec3 } from '../../doc/schema';
import type { MeshOpResult } from '../types';
import { selectionOfFaces } from '../topology';
import { add, cross, distance, dot, length, normalize, scale, sub } from '../vec';
import { emptyResult, isValidLoop, randomId, type IdGen } from './common';
import { loopHasEdge, splitLoop, WorkMesh } from './work';

/**
 * Éventail ordonné des faces autour d'un sommet v.
 * faces[j] a pour boucle locale [xs[j], v, xs[j + 1]] : elle arrive par l'arête e_j = (xs[j], v) et
 * repart par e_{j+1}. Pour un éventail fermé, xs a autant d'éléments que faces (indices modulo) ;
 * pour un éventail ouvert (sommet de bord), xs a un élément de plus.
 */
interface Fan {
  faces: string[];
  xs: string[];
  closed: boolean;
}

/** Éventail autour de v, ou null si le voisinage n'est pas une variété (sommet pincé, arête à 3 faces…). */
function buildFan(work: WorkMesh, v: string): Fan | null {
  const faces = work.facesOf(v);
  if (faces.length === 0) return null;
  const prevOf = new Map<string, string>();
  const nextOf = new Map<string, string>();
  const byPrev = new Map<string, string>();
  const byNext = new Set<string>();
  for (const f of faces) {
    const loop = work.faces.get(f)!;
    const n = loop.length;
    let idx = -1;
    for (let i = 0; i < n; i++) {
      if (loop[i] === v) {
        if (idx !== -1) return null;
        idx = i;
      }
    }
    if (idx === -1) return null;
    const p = loop[(idx + n - 1) % n];
    const q = loop[(idx + 1) % n];
    if (byPrev.has(p) || byNext.has(q)) return null;
    prevOf.set(f, p);
    nextOf.set(f, q);
    byPrev.set(p, f);
    byNext.add(q);
  }
  // Début : une face dont l'arête entrante n'a pas de face de l'autre côté (éventail ouvert).
  let start: string | undefined;
  for (const f of faces) {
    if (!byNext.has(prevOf.get(f)!)) {
      if (start !== undefined) return null;
      start = f;
    }
  }
  const closed = start === undefined;
  if (start === undefined) start = faces[0];
  const out: Fan = { faces: [], xs: [], closed };
  let f: string | undefined = start;
  for (let guard = 0; guard <= faces.length; guard++) {
    if (f === undefined) break;
    out.faces.push(f);
    out.xs.push(prevOf.get(f)!);
    const q: string = nextOf.get(f)!;
    const g = byPrev.get(q);
    if (g === undefined) {
      out.xs.push(q);
      break;
    }
    if (g === start) break;
    f = g;
  }
  if (out.faces.length !== faces.length) return null;
  return out;
}

/** Sinus de l'angle entre deux directions unitaires, borné pour éviter les divisions explosives. */
function sinBetween(a: Vec3, b: Vec3): number {
  return Math.max(0.2, length(cross(a, b)));
}

/** Données calculées pour un sommet biseauté. */
interface VertBevel {
  fan: Fan;
  /** Coin de chaque face de l'éventail (sommets qui remplacent v dans la boucle, dans le sens de la face). */
  corners: Map<string, string[]>;
  /** Faces de remplissage du coin. */
  patches: string[][];
}

/**
 * Biseau d'arêtes (Ctrl+B) : chaque arête choisie (partagée par exactement deux faces de sens opposés)
 * est remplacée par une bande de `segments` faces, décalée de `width` sur chacune des deux faces
 * voisines. `segments` = 1 donne un chanfrein, davantage un arrondi (profil circulaire pour un angle
 * droit, elliptique sinon). Aux sommets :
 *  - une seule arête biseautée : les rails glissent le long des arêtes voisines, la face d'extrémité absorbe le profil ;
 *  - deux arêtes qui se continuent : les deux bandes partagent le même profil (pas de couture) ;
 *  - trois arêtes ou plus : un coin est rempli (triangle pour un chanfrein, éventail arrondi sinon).
 * La largeur est bornée pour éviter les recouvrements. `select` = les faces créées.
 */
export function bevelEdges(mesh: MeshData, edgeKeys: Iterable<string>, width: number, segments: number, idGen: IdGen = randomId): MeshOpResult {
  const seg = Math.max(1, Math.min(64, Math.round(Number.isFinite(segments) ? segments : 1)));
  let w = Number.isFinite(width) ? Math.abs(width) : 0;
  if (w <= 0) return emptyResult();
  const work = new WorkMesh(mesh);
  const P = (v: string): Vec3 => work.verts.get(v)!;

  // Arêtes valides : deux faces de sens opposés, sommets présents.
  const bevel = new Map<string, { a: string; b: string; fA: string; fB: string }>();
  for (const raw of edgeKeys) {
    if (typeof raw !== 'string' || raw.indexOf('|') < 0) continue;
    const [x, y] = edgeVerts(raw);
    if (x === y || !work.verts.has(x) || !work.verts.has(y)) continue;
    const k = edgeKey(x, y);
    if (bevel.has(k)) continue;
    const faces = work.edgeFaces(x, y);
    if (faces.length !== 2) continue;
    const d0 = loopHasEdge(work.faces.get(faces[0])!, x, y);
    const d1 = loopHasEdge(work.faces.get(faces[1])!, x, y);
    if (d0 === 0 || d1 === 0 || d0 === d1) continue;
    // fA parcourt a → b, fB parcourt b → a.
    const [fA, fB] = d0 === 1 ? [faces[0], faces[1]] : [faces[1], faces[0]];
    bevel.set(k, { a: x, b: y, fA, fB });
  }
  // Éventails des extrémités ; une arête dont une extrémité n'est pas une variété est écartée.
  const fans = new Map<string, Fan>();
  for (const [k, e] of [...bevel]) {
    for (const v of [e.a, e.b]) {
      if (!fans.has(v)) {
        const fan = buildFan(work, v);
        // Sommet voisin disparu (édition concurrente) : sommet non biseautable.
        if (fan && fan.xs.every((x) => work.verts.has(x))) fans.set(v, fan);
      }
    }
    if (!fans.has(e.a) || !fans.has(e.b)) bevel.delete(k);
  }
  if (bevel.size === 0) return emptyResult();
  const bevelVerts = new Set<string>();
  for (const e of bevel.values()) {
    bevelVerts.add(e.a);
    bevelVerts.add(e.b);
  }
  // Borne de largeur : la moitié de la plus courte arête touchant un sommet biseauté.
  let minLen = Infinity;
  for (const v of bevelVerts) {
    const fan = fans.get(v)!;
    for (const x of fan.xs) minLen = Math.min(minLen, distance(P(v), P(x)));
  }
  if (Number.isFinite(minLen) && minLen > 0) w = Math.min(w, minLen * 0.5);
  if (w <= 1e-12) return emptyResult();

  const newVert = (p: Vec3): string => {
    const id = idGen();
    work.setVert(id, p);
    return id;
  };
  /** Profil complet [rail(face v → autre), …, rail(face autre → v)] de l'arête k vu depuis v. */
  const profiles = new Map<string, string[]>();
  const perVert = new Map<string, VertBevel>();
  const created = new Map<string, string[]>();

  /** Points intermédiaires d'un profil de X à Y autour du coin E (arc tangent aux deux faces). */
  const profilePoints = (X: Vec3, Y: Vec3, E: Vec3): Vec3[] => {
    const out: Vec3[] = [];
    for (let k = 1; k < seg; k++) {
      const phi = (k / seg) * (Math.PI / 2);
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      out.push([
        X[0] + Y[0] - E[0] - (Y[0] - E[0]) * c - (X[0] - E[0]) * s,
        X[1] + Y[1] - E[1] - (Y[1] - E[1]) * c - (X[1] - E[1]) * s,
        X[2] + Y[2] - E[2] - (Y[2] - E[2]) * c - (X[2] - E[2]) * s,
      ]);
    }
    return out;
  };

  for (const v of bevelVerts) {
    const fan = fans.get(v)!;
    const m = fan.faces.length;
    const E = fan.closed ? m : m + 1;
    const pv = P(v);
    const isB: boolean[] = [];
    const dir: Vec3[] = [];
    for (let j = 0; j < E; j++) {
      isB.push(bevel.has(edgeKey(v, fan.xs[j])));
      dir.push(normalize(sub(P(fan.xs[j]), pv), [1, 0, 0]));
    }
    const after = (j: number) => (fan.closed ? (j + 1) % m : j + 1); // arête sortante de la face j
    const faceBefore = (j: number): number | null => (fan.closed ? (j + m - 1) % m : j > 0 ? j - 1 : null); // face qui sort par e_j
    const faceAfter = (j: number): number | null => (fan.closed ? j % m : j < m ? j : null); // face qui entre par e_j
    const otherEnd = (j: number) => bevelVerts.has(fan.xs[j]);

    // Ancres des arêtes non biseautées : glissement si une face voisine a son autre arête biseautée.
    const anchor: (string | null)[] = [];
    for (let j = 0; j < E; j++) {
      if (isB[j]) {
        anchor.push(null);
        continue;
      }
      const dists: number[] = [];
      const fb = faceBefore(j);
      if (fb !== null) {
        const other = fan.closed ? (j + m - 1) % m : j - 1; // e_{j-1}
        if (isB[other]) dists.push(w / sinBetween(dir[other], dir[j]));
      }
      const fa = faceAfter(j);
      if (fa !== null) {
        const other = after(fa);
        if (isB[other]) dists.push(w / sinBetween(dir[j], dir[other]));
      }
      if (dists.length === 0) {
        anchor.push(v);
        continue;
      }
      let d = dists.reduce((s, x) => s + x, 0) / dists.length;
      const len = distance(pv, P(fan.xs[j]));
      d = Math.min(d, len * (otherEnd(j) ? 0.49 : 0.98));
      anchor.push(newVert(add(pv, scale(dir[j], d))));
    }
    // Rail et coin de chaque face.
    const rail: (string | null)[] = [];
    const corner: string[][] = [];
    for (let j = 0; j < m; j++) {
      const n = after(j);
      const bj = isB[j];
      const bn = isB[n];
      if (bj && bn) {
        const s = sinBetween(dir[j], dir[n]);
        const id = newVert(add(pv, scale(add(dir[j], dir[n]), w / s)));
        rail.push(id);
        corner.push([id]);
      } else if (bj) {
        rail.push(anchor[n]!);
        corner.push([anchor[n]!]);
      } else if (bn) {
        rail.push(anchor[j]!);
        corner.push([anchor[j]!]);
      } else {
        rail.push(null);
        const a1 = anchor[j]!;
        const a2 = anchor[n]!;
        corner.push(a1 === a2 ? [a1] : [a1, a2]);
      }
    }
    // Profils des arêtes biseautées vues depuis v : de rail(face sortante) à rail(face entrante).
    const interior = new Map<number, string[]>();
    const ends = new Map<number, [string, string]>();
    for (let j = 0; j < E; j++) {
      if (!isB[j]) continue;
      const fb = faceBefore(j);
      const fa = faceAfter(j);
      if (fb === null || fa === null) continue;
      const X = rail[fb]!;
      const Y = rail[fa]!;
      ends.set(j, [X, Y]);
      const px = P(X);
      const py = P(Y);
      const mid = scale(add(px, py), 0.5);
      const Ec = add(pv, scale(dir[j], dot(sub(mid, pv), dir[j])));
      interior.set(j, profilePoints(px, py, Ec).map((p) => newVert(p)));
    }
    const bIdx = [...interior.keys()];
    const k = bIdx.length;

    // Anneau des nouveaux sommets autour de v (ordre de l'éventail).
    const ringOf = (): string[] => {
      const r: string[] = [];
      for (let j = 0; j < m; j++) {
        if (isB[j] && interior.has(j)) r.push(...interior.get(j)!);
        r.push(...corner[j]);
      }
      const d: string[] = [];
      for (const x of r) if (d.length === 0 || d[d.length - 1] !== x) d.push(x);
      while (d.length > 1 && d[0] === d[d.length - 1]) d.pop();
      return d;
    };

    const patches: string[][] = [];
    if (fan.closed) {
      let shared = false;
      if (k === 2) {
        const [i1, i2] = bIdx;
        const [X1, Y1] = ends.get(i1)!;
        const [X2, Y2] = ends.get(i2)!;
        const nonProfile = new Set<string>();
        for (const c of corner) for (const x of c) nonProfile.add(x);
        if (X1 === Y2 && Y1 === X2 && X1 !== Y1 && nonProfile.size === 2) {
          // Les deux bandes se continuent : profil commun (moyenne des deux arcs).
          const p1 = interior.get(i1)!;
          const p2 = interior.get(i2)!;
          const L = p1.length;
          for (let q = 0; q < L; q++) {
            const a = P(p1[q]);
            const b = P(p2[L - 1 - q]);
            work.setVert(p1[q], scale(add(a, b), 0.5));
            work.verts.delete(p2[L - 1 - q]);
          }
          interior.set(i2, p1.slice().reverse());
          shared = true;
        }
      }
      if (!shared) {
        const ring = ringOf();
        if (ring.length >= 3) {
          const patch = ring.slice().reverse();
          const uu: number[] = [];
          for (let j = 0; j < m; j++) if (corner[j].length === 2) uu.push(j);
          if (k === 1 && uu.length === 1 && new Set(patch).size === patch.length) {
            // La face d'extrémité absorbe le coin : son coin devient le chemin de l'anneau.
            const j = uu[0];
            const start = patch.indexOf(corner[j][0]);
            const path: string[] = [];
            for (let q = 0; q < patch.length; q++) path.push(patch[(start + q) % patch.length]);
            corner[j] = path;
          } else if (new Set(patch).size !== patch.length) {
            for (const piece of splitLoop(patch)) patches.push(piece);
          } else if (seg > 1 && k >= 3 && patch.length >= 5) {
            // Coin arrondi : éventail autour d'un sommet central légèrement bombé vers v.
            const c: Vec3 = [0, 0, 0];
            for (const x of patch) {
              const p = P(x);
              c[0] += p[0] / patch.length;
              c[1] += p[1] / patch.length;
              c[2] += p[2] / patch.length;
            }
            const ctr = newVert(add(c, scale(sub(pv, c), 0.29)));
            for (let q = 0; q < patch.length; q++) patches.push([ctr, patch[q], patch[(q + 1) % patch.length]]);
          } else patches.push(patch);
        }
      }
    }
    for (const j of bIdx) {
      const [X, Y] = ends.get(j)!;
      profiles.set(edgeKey(v, fan.xs[j]) + '@' + v, [X, ...interior.get(j)!, Y]);
    }
    const corners = new Map<string, string[]>();
    for (let j = 0; j < m; j++) corners.set(fan.faces[j], corner[j]);
    perVert.set(v, { fan, corners, patches });
  }

  // Réécriture des faces touchées : chaque sommet biseauté est remplacé par le coin de la face.
  const touched = new Set<string>();
  for (const v of bevelVerts) for (const f of perVert.get(v)!.fan.faces) touched.add(f);
  for (const f of touched) {
    const loop = work.faces.get(f);
    if (!loop) continue;
    const out: string[] = [];
    for (const x of loop) {
      const pb = perVert.get(x);
      const c = pb?.corners.get(f);
      if (c) out.push(...c);
      else out.push(x);
    }
    const d: string[] = [];
    for (const x of out) if (d.length === 0 || d[d.length - 1] !== x) d.push(x);
    while (d.length > 1 && d[0] === d[d.length - 1]) d.pop();
    if (isValidLoop(d)) work.setFace(f, d);
    else work.delFace(f);
  }
  // Bandes.
  for (const [k, e] of bevel) {
    const pa = profiles.get(k + '@' + e.a);
    const pbRaw = profiles.get(k + '@' + e.b);
    if (!pa || !pbRaw || pa.length !== pbRaw.length) continue;
    const pb = pbRaw.slice().reverse();
    for (let q = 0; q + 1 < pa.length; q++) {
      const quad = [pb[q], pa[q], pa[q + 1], pb[q + 1]];
      const loop = quad.filter((x, i) => quad.indexOf(x) === i);
      if (!isValidLoop(loop)) continue;
      const id = idGen();
      work.setFace(id, loop);
      created.set(id, loop);
    }
  }
  // Coins.
  for (const pb of perVert.values()) {
    for (const patch of pb.patches) {
      if (!isValidLoop(patch)) continue;
      const id = idGen();
      work.setFace(id, patch);
      created.set(id, patch);
    }
  }
  work.dropUnused(bevelVerts);
  // Sommets créés mais finalement inutilisés (sécurité).
  const fresh: string[] = [];
  for (const v of work.verts.keys()) if (!mesh.verts.has(v)) fresh.push(v);
  work.dropUnused(fresh);
  return { delta: work.toDelta(), select: selectionOfFaces(created) };
}
