import type { MeshData, Vec3 } from '../../doc/schema';
import type { MeshOpResult } from '../types';
import { isFiniteVec } from '../vec';
import { canonicalLoop, loopSetKey, splitLoop, WorkMesh } from './work';
import { dedupeLoop, emptyResult, randomId, type IdGen } from './common';

/**
 * Remplace des sommets par d'autres (`map` : ancien → survivant) dans toutes les faces concernées,
 * puis nettoie : répétitions consécutives retirées, boucles pincées découpées en sous-faces, faces
 * dégénérées (< 3 sommets) supprimées, faces en double supprimées (une face identique de même sens
 * est retirée ; deux faces identiques de sens opposés (feuille d'épaisseur nulle) sont retirées toutes deux).
 * Les sommets remplacés sont supprimés.
 */
export function remapVerts(work: WorkMesh, map: ReadonlyMap<string, string>, idGen: IdGen): void {
  const touched = new Set<string>();
  for (const v of map.keys()) for (const f of work.facesOf(v)) touched.add(f);
  const created: string[] = [];
  for (const fid of touched) {
    const loop = work.faces.get(fid);
    if (!loop) continue;
    const mapped = dedupeLoop(loop.map((v) => map.get(v) ?? v));
    const pieces = new Set(mapped).size === mapped.length ? (mapped.length >= 3 ? [mapped] : []) : splitLoop(mapped);
    if (pieces.length === 0) {
      work.delFace(fid);
      continue;
    }
    work.setFace(fid, pieces[0]);
    created.push(fid);
    for (let i = 1; i < pieces.length; i++) {
      const id = idGen();
      work.setFace(id, pieces[i]);
      created.push(id);
    }
  }
  for (const v of map.keys()) {
    if (map.get(v) === v) continue;
    work.delVert(v);
  }
  // Faces en double parmi les faces modifiées et leurs voisines.
  const candidates = new Set<string>();
  for (const f of created) {
    const loop = work.faces.get(f);
    if (!loop) continue;
    for (const g of work.facesOf(loop[0])) candidates.add(g);
  }
  const bySet = new Map<string, string[]>();
  for (const f of candidates) {
    const loop = work.faces.get(f);
    if (!loop) continue;
    const k = loopSetKey(loop);
    const l = bySet.get(k);
    if (l) l.push(f);
    else bySet.set(k, [f]);
  }
  for (const group of bySet.values()) {
    if (group.length < 2) continue;
    // Regroupe par sens : on garde une face par sens, et si les deux sens existent on retire tout.
    const bySense = new Map<string, string[]>();
    for (const f of group) {
      const k = canonicalLoop(work.faces.get(f)!);
      const l = bySense.get(k);
      if (l) l.push(f);
      else bySense.set(k, [f]);
    }
    if (bySense.size >= 2) {
      for (const f of group) work.delFace(f);
    } else {
      for (const l of bySense.values()) for (let i = 1; i < l.length; i++) work.delFace(l[i]);
    }
  }
}

/**
 * Fusionne les sommets donnés en un seul sommet placé en `target` (le premier sommet existant
 * survit et garde son identifiant). Les faces dégénérées et en double sont nettoyées.
 * `select` = le sommet fusionné. Avec un seul sommet, celui-ci est simplement déplacé.
 */
export function mergeVerts(mesh: MeshData, vertIds: Iterable<string>, target: Vec3, idGen: IdGen = randomId): MeshOpResult {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const v of vertIds) {
    if (seen.has(v) || !mesh.verts.has(v)) continue;
    seen.add(v);
    ids.push(v);
  }
  if (ids.length === 0 || !Array.isArray(target) || !isFiniteVec(target)) return emptyResult();
  const keep = ids[0];
  const work = new WorkMesh(mesh);
  work.setVert(keep, [target[0], target[1], target[2]]);
  const map = new Map<string, string>();
  for (const v of ids) if (v !== keep) map.set(v, keep);
  if (map.size) remapVerts(work, map, idGen);
  return { delta: work.toDelta(), select: { verts: [keep], edges: [], faces: [] } };
}

/**
 * Fusion par distance : parmi les sommets donnés, ceux qui sont à moins de `distance` les uns des
 * autres (de proche en proche) sont fusionnés sur le premier du groupe, qui garde sa position.
 * `merged` = nombre de sommets supprimés. `select` = les sommets restants de la sélection.
 */
export function mergeByDistance(mesh: MeshData, vertIds: Iterable<string>, distance: number): MeshOpResult & { merged: number } {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const v of vertIds) {
    if (seen.has(v)) continue;
    const p = mesh.verts.get(v);
    if (!p || !isFiniteVec(p)) continue;
    seen.add(v);
    ids.push(v);
  }
  const d = Number.isFinite(distance) ? Math.max(0, distance) : 0;
  if (ids.length < 2) return { ...emptyResult(), merged: 0 };
  // Union-find sur une grille de pas `cell`.
  const parent = new Map<string, string>();
  for (const v of ids) parent.set(v, v);
  const find = (v: string): string => {
    let r = v;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = v;
    while (parent.get(c) !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  const order = new Map<string, number>();
  ids.forEach((v, i) => order.set(v, i));
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // La racine est le sommet le plus ancien dans l'ordre fourni.
    if (order.get(ra)! < order.get(rb)!) parent.set(rb, ra);
    else parent.set(ra, rb);
  };
  const cell = Math.max(d, 1e-9);
  const grid = new Map<string, string[]>();
  const keyOf = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const d2 = d * d;
  for (const v of ids) {
    const p = mesh.verts.get(v)!;
    const cx = Math.floor(p[0] / cell);
    const cy = Math.floor(p[1] / cell);
    const cz = Math.floor(p[2] / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const w of grid.get(keyOf(cx + dx, cy + dy, cz + dz)) ?? []) {
            const q = mesh.verts.get(w)!;
            const ddx = p[0] - q[0];
            const ddy = p[1] - q[1];
            const ddz = p[2] - q[2];
            if (ddx * ddx + ddy * ddy + ddz * ddz <= d2) union(v, w);
          }
        }
      }
    }
    const k = keyOf(cx, cy, cz);
    const l = grid.get(k);
    if (l) l.push(v);
    else grid.set(k, [v]);
  }
  const map = new Map<string, string>();
  for (const v of ids) {
    const r = find(v);
    if (r !== v) map.set(v, r);
  }
  if (map.size === 0) return { ...emptyResult(), merged: 0 };
  const work = new WorkMesh(mesh);
  remapVerts(work, map, randomId);
  const remaining = ids.filter((v) => !map.has(v));
  return { delta: work.toDelta(), select: { verts: remaining, edges: [], faces: [] }, merged: map.size };
}
