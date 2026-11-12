import { edgeKey, type MeshData, type Vec3 } from '../../doc/schema';
import type { MeshOpResult } from '../types';
import { selectionOfFaces } from '../topology';
import { lerp } from '../vec';
import { emptyResult, existingFaces, isValidLoop, randomId, type IdGen } from './common';
import { insertOnEdge, WorkMesh } from './work';

/**
 * Subdivision (menu Arête › Subdiviser) : chaque arête des faces sélectionnées reçoit `cuts`
 * sommets régulièrement espacés ; les quads deviennent des grilles (cuts + 1)², les triangles
 * (cuts + 1)² triangles, les n-gones un éventail autour d'un sommet central (quads aux coins).
 * Les faces voisines non sélectionnées reçoivent les nouveaux sommets dans leur boucle : pas de fissure.
 * Le premier morceau de chaque face garde son identifiant ; `select` = tous les morceaux.
 */
export function subdivideFaces(mesh: MeshData, faceIds: Iterable<string>, cuts: number, idGen: IdGen = randomId): MeshOpResult {
  const c = Math.max(1, Math.min(64, Math.round(Number.isFinite(cuts) ? cuts : 1)));
  const region = new Map<string, string[]>();
  for (const [f, loop] of existingFaces(mesh, faceIds)) {
    if (isValidLoop(loop) && loop.every((v) => mesh.verts.has(v))) region.set(f, loop);
  }
  if (region.size === 0) return emptyResult();
  const work = new WorkMesh(mesh);
  const pos = (v: string): Vec3 => work.verts.get(v)!;
  const newVert = (p: Vec3): string => {
    const id = idGen();
    work.setVert(id, p);
    return id;
  };

  // Points intermédiaires de chaque arête coupée, rangés du plus petit identifiant vers le plus grand.
  const edgePts = new Map<string, string[]>();
  const along = (a: string, b: string): string[] => {
    const k = edgeKey(a, b);
    let pts = edgePts.get(k);
    if (!pts) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      pts = [];
      for (let i = 1; i <= c; i++) pts.push(newVert(lerp(pos(lo), pos(hi), i / (c + 1))));
      edgePts.set(k, pts);
    }
    return a < b ? pts : pts.slice().reverse();
  };
  // Crée d'abord tous les points d'arêtes (ordre déterministe).
  for (const loop of region.values()) for (let i = 0; i < loop.length; i++) along(loop[i], loop[(i + 1) % loop.length]);

  const result = new Map<string, string[]>();
  const emit = (fid: string, first: { done: boolean }, loop: string[]) => {
    if (!isValidLoop(loop)) return;
    const id = first.done ? idGen() : fid;
    first.done = true;
    work.setFace(id, loop);
    result.set(id, loop);
  };

  for (const [fid, loop] of region) {
    const n = loop.length;
    const first = { done: false };
    if (n === 4) {
      const [q0, q1, q2, q3] = loop;
      const N = c + 1;
      // G[i][j] : i le long de q0 → q1, j le long de q0 → q3.
      const G: string[][] = [];
      const bottom = [q0, ...along(q0, q1), q1];
      const right = [q1, ...along(q1, q2), q2];
      const top = [q3, ...along(q3, q2), q2];
      const left = [q0, ...along(q0, q3), q3];
      for (let i = 0; i <= N; i++) {
        G.push([]);
        for (let j = 0; j <= N; j++) {
          let id: string;
          if (j === 0) id = bottom[i];
          else if (j === N) id = top[i];
          else if (i === 0) id = left[j];
          else if (i === N) id = right[j];
          else {
            const u = i / N;
            const v = j / N;
            const a = lerp(pos(q0), pos(q1), u);
            const b = lerp(pos(q3), pos(q2), u);
            id = newVert(lerp(a, b, v));
          }
          G[i].push(id);
        }
      }
      // Le morceau qui garde l'identifiant est retiré en premier de la face d'origine.
      work.delFace(fid);
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) emit(fid, first, [G[i][j], G[i + 1][j], G[i + 1][j + 1], G[i][j + 1]]);
    } else if (n === 3) {
      const [t0, t1, t2] = loop;
      const N = c + 1;
      const e01 = [t0, ...along(t0, t1), t1];
      const e12 = [t1, ...along(t1, t2), t2];
      const e02 = [t0, ...along(t0, t2), t2];
      // P(i, j) = t0 + i/N (t1 - t0) + j/N (t2 - t0), i + j ≤ N.
      const P = new Map<string, string>();
      const at = (i: number, j: number): string => {
        const k = i + ',' + j;
        let id = P.get(k);
        if (id) return id;
        if (j === 0) id = e01[i];
        else if (i === 0) id = e02[j];
        else if (i + j === N) id = e12[j];
        else {
          const p0 = pos(t0);
          const p1 = pos(t1);
          const p2 = pos(t2);
          const u = i / N;
          const v = j / N;
          id = newVert([
            p0[0] + (p1[0] - p0[0]) * u + (p2[0] - p0[0]) * v,
            p0[1] + (p1[1] - p0[1]) * u + (p2[1] - p0[1]) * v,
            p0[2] + (p1[2] - p0[2]) * u + (p2[2] - p0[2]) * v,
          ]);
        }
        P.set(k, id);
        return id;
      };
      work.delFace(fid);
      for (let j = 0; j < N; j++) {
        for (let i = 0; i + j < N; i++) {
          emit(fid, first, [at(i, j), at(i + 1, j), at(i, j + 1)]);
          if (i + j < N - 1) emit(fid, first, [at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]);
        }
      }
    } else {
      // N-gone : sommet central, un quad par coin et des triangles entre les points d'arête.
      const center: Vec3 = [0, 0, 0];
      for (const v of loop) {
        const p = pos(v);
        center[0] += p[0] / n;
        center[1] += p[1] / n;
        center[2] += p[2] / n;
      }
      const ctr = newVert(center);
      const sides = loop.map((v, i) => along(v, loop[(i + 1) % n]));
      work.delFace(fid);
      for (let i = 0; i < n; i++) {
        const prev = sides[(i + n - 1) % n];
        const cur = sides[i];
        emit(fid, first, [prev[prev.length - 1], loop[i], cur[0], ctr]);
        for (let k = 0; k + 1 < cur.length; k++) emit(fid, first, [ctr, cur[k], cur[k + 1]]);
      }
    }
  }

  // Faces voisines : insertion des nouveaux points sur les arêtes coupées.
  for (const [k, pts] of edgePts) {
    const i = k.indexOf('|');
    const a = k.slice(0, i);
    const b = k.slice(i + 1);
    for (const f of work.edgeFaces(a, b)) {
      if (result.has(f)) continue;
      const loop = work.faces.get(f)!;
      work.setFace(f, insertOnEdge(loop, a, b, pts));
    }
  }
  return { delta: work.toDelta(), select: selectionOfFaces(result) };
}
