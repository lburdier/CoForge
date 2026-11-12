import { Matrix4 } from 'three';
import { edgeKey, type MeshData, type MeshDelta, type Vec3 } from '../doc/schema';
import type { MeshSelection } from './types';
import { cross, dot, normalize, sub } from './vec';

/**
 * Topologie dérivée d'un maillage (les arêtes sont implicites dans MeshData).
 * Toutes les listes suivent l'ordre d'itération des faces du maillage.
 */
export interface Topology {
  /** Clé d'arête → ses deux sommets (dans l'ordre de la clé). */
  edges: Map<string, [string, string]>;
  /** Clé d'arête → faces qui l'utilisent (1 = bord, 2 = manifold, 3+ = non-manifold). */
  edgeFaces: Map<string, string[]>;
  /** Sommet → clés des arêtes incidentes. */
  vertEdges: Map<string, string[]>;
  /** Sommet → faces incidentes. */
  vertFaces: Map<string, string[]>;
  /** Sommet → sommets voisins (reliés par une arête). */
  vertNeighbors: Map<string, string[]>;
}

export function buildTopology(mesh: MeshData): Topology {
  const edges = new Map<string, [string, string]>();
  const edgeFaces = new Map<string, string[]>();
  const vertEdges = new Map<string, string[]>();
  const vertFaces = new Map<string, string[]>();
  const vertNeighbors = new Map<string, string[]>();
  for (const v of mesh.verts.keys()) {
    vertEdges.set(v, []);
    vertFaces.set(v, []);
    vertNeighbors.set(v, []);
  }
  const push = (map: Map<string, string[]>, k: string, v: string) => {
    const l = map.get(k);
    if (l) l.push(v);
    else map.set(k, [v]);
  };
  for (const [fid, loop] of mesh.faces) {
    const n = loop.length;
    for (let i = 0; i < n; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % n];
      push(vertFaces, a, fid);
      if (a === b) continue;
      const k = edgeKey(a, b);
      const ef = edgeFaces.get(k);
      if (ef) {
        if (ef[ef.length - 1] !== fid) ef.push(fid);
      } else {
        edgeFaces.set(k, [fid]);
        edges.set(k, a < b ? [a, b] : [b, a]);
        push(vertEdges, a, k);
        push(vertEdges, b, k);
        push(vertNeighbors, a, b);
        push(vertNeighbors, b, a);
      }
    }
  }
  return { edges, edgeFaces, vertEdges, vertFaces, vertNeighbors };
}

/** Positions des sommets d'une boucle (les sommets manquants sont ignorés). */
export function loopPositions(mesh: MeshData, loop: readonly string[]): Vec3[] {
  const out: Vec3[] = [];
  for (const v of loop) {
    const p = mesh.verts.get(v);
    if (p) out.push(p);
  }
  return out;
}

/** Normale non normalisée d'un polygone (méthode de Newell) ; sa longueur vaut 2 × l'aire. */
export function newellNormal(pts: readonly Vec3[]): Vec3 {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [nx, ny, nz];
}

/** Normale unitaire d'une face (Newell). Accepte un identifiant de face ou une boucle de sommets. */
export function faceNormal(mesh: MeshData, face: string | readonly string[]): Vec3 {
  const loop = typeof face === 'string' ? mesh.faces.get(face) : face;
  if (!loop) return [0, 0, 1];
  return normalize(newellNormal(loopPositions(mesh, loop)), [0, 0, 1]);
}

/** Centre d'une face (moyenne de ses sommets). */
export function faceCenter(mesh: MeshData, face: string | readonly string[]): Vec3 {
  const loop = typeof face === 'string' ? mesh.faces.get(face) : face;
  const c: Vec3 = [0, 0, 0];
  if (!loop) return c;
  let n = 0;
  for (const v of loop) {
    const p = mesh.verts.get(v);
    if (!p) continue;
    c[0] += p[0];
    c[1] += p[1];
    c[2] += p[2];
    n++;
  }
  if (n > 0) {
    c[0] /= n;
    c[1] /= n;
    c[2] /= n;
  }
  return c;
}

/** Aire d'une face. */
export function faceArea(mesh: MeshData, face: string | readonly string[]): number {
  const loop = typeof face === 'string' ? mesh.faces.get(face) : face;
  if (!loop) return 0;
  const n = newellNormal(loopPositions(mesh, loop));
  return 0.5 * Math.hypot(n[0], n[1], n[2]);
}

/**
 * Normales de sommets : moyenne des normales des faces incidentes, pondérée par l'aire.
 * `faceIds` restreint le calcul à certaines faces (les autres sommets sont absents du résultat).
 */
export function vertexNormals(mesh: MeshData, faceIds?: Iterable<string>): Map<string, Vec3> {
  const acc = new Map<string, Vec3>();
  const ids = faceIds ?? mesh.faces.keys();
  for (const fid of ids) {
    const loop = mesh.faces.get(fid);
    if (!loop) continue;
    const n = newellNormal(loopPositions(mesh, loop));
    for (const v of loop) {
      const a = acc.get(v);
      if (a) {
        a[0] += n[0];
        a[1] += n[1];
        a[2] += n[2];
      } else acc.set(v, [n[0], n[1], n[2]]);
    }
  }
  for (const [v, n] of acc) acc.set(v, normalize(n, [0, 0, 1]));
  return acc;
}

/** Copie profonde, modifiable, d'un maillage. */
export function cloneMesh(mesh: MeshData): MeshData {
  const verts = new Map<string, Vec3>();
  const faces = new Map<string, string[]>();
  for (const [k, p] of mesh.verts) verts.set(k, [p[0], p[1], p[2]]);
  for (const [k, l] of mesh.faces) faces.set(k, l.slice());
  return { verts, faces };
}

/** Applique une matrice à un point. */
export function applyMatrix(p: Vec3, m: Matrix4): Vec3 {
  const e = m.elements;
  const x = p[0];
  const y = p[1];
  const z = p[2];
  const w = e[3] * x + e[7] * y + e[11] * z + e[15] || 1;
  return [(e[0] * x + e[4] * y + e[8] * z + e[12]) / w, (e[1] * x + e[5] * y + e[9] * z + e[13]) / w, (e[2] * x + e[6] * y + e[10] * z + e[14]) / w];
}

/**
 * Nouveau maillage transformé par une matrice (mêmes identifiants).
 * Si la matrice inverse l'orientation (déterminant négatif), les faces sont retournées
 * pour que les normales restent tournées vers l'extérieur.
 */
export function transformMesh(mesh: MeshData, matrix: Matrix4): MeshData {
  const verts = new Map<string, Vec3>();
  const faces = new Map<string, string[]>();
  for (const [k, p] of mesh.verts) verts.set(k, applyMatrix(p, matrix));
  const flip = matrix.determinant() < 0;
  for (const [k, l] of mesh.faces) faces.set(k, flip ? reversedLoop(l) : l.slice());
  return { verts, faces };
}

/** Boucle parcourue en sens inverse, en conservant le premier sommet. */
export function reversedLoop(loop: readonly string[]): string[] {
  const out = new Array<string>(loop.length);
  out[0] = loop[0];
  for (let i = 1; i < loop.length; i++) out[i] = loop[loop.length - i];
  return out;
}

/** CONTRAT — boîte englobante, null si le maillage n'a aucun sommet. */
export function meshBounds(mesh: MeshData): { min: Vec3; max: Vec3 } | null {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let any = false;
  for (const p of mesh.verts.values()) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) continue;
    any = true;
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[2] < minZ) minZ = p[2];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
    if (p[2] > maxZ) maxZ = p[2];
  }
  if (!any) return null;
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/** Centre (moyenne des sommets) d'une sélection, null si elle est vide. Sert de pivot aux transformations. */
export function selectionCenter(mesh: MeshData, sel: MeshSelection | Iterable<string>): Vec3 | null {
  const ids = new Set<string>();
  if (isSelection(sel)) {
    for (const v of sel.verts) ids.add(v);
    for (const e of sel.edges) {
      const i = e.indexOf('|');
      ids.add(e.slice(0, i));
      ids.add(e.slice(i + 1));
    }
    for (const f of sel.faces) for (const v of mesh.faces.get(f) ?? []) ids.add(v);
  } else {
    for (const v of sel) ids.add(v);
  }
  const c: Vec3 = [0, 0, 0];
  let n = 0;
  for (const v of ids) {
    const p = mesh.verts.get(v);
    if (!p) continue;
    c[0] += p[0];
    c[1] += p[1];
    c[2] += p[2];
    n++;
  }
  if (n === 0) return null;
  return [c[0] / n, c[1] / n, c[2] / n];
}

function isSelection(s: MeshSelection | Iterable<string>): s is MeshSelection {
  return typeof (s as MeshSelection).verts === 'object' && typeof (s as MeshSelection).faces === 'object';
}

/**
 * Volume signé d'un maillage (positif si les normales sortent d'un maillage fermé).
 * Calculé par éventail autour du premier sommet de chaque face, relativement à `origin`.
 */
export function meshVolume(mesh: MeshData, faceIds?: Iterable<string>, origin: Vec3 = [0, 0, 0]): number {
  let vol = 0;
  const ids = faceIds ?? mesh.faces.keys();
  for (const fid of ids) {
    const loop = mesh.faces.get(fid);
    if (!loop || loop.length < 3) continue;
    const p0 = mesh.verts.get(loop[0]);
    if (!p0) continue;
    const a = sub(p0, origin);
    for (let i = 1; i + 1 < loop.length; i++) {
      const p1 = mesh.verts.get(loop[i]);
      const p2 = mesh.verts.get(loop[i + 1]);
      if (!p1 || !p2) continue;
      vol += dot(a, cross(sub(p1, origin), sub(p2, origin)));
    }
  }
  return vol / 6;
}

/**
 * Applique un delta à un maillage et renvoie un NOUVEAU maillage (l'entrée n'est pas modifiée).
 * Même ordre que SceneDoc.applyMeshDelta : suppressions, puis sommets, puis faces ; comme
 * SceneDoc.getMesh, les faces invalides (sommet manquant, moins de 3 sommets, sommet répété) sont écartées.
 */
export function applyDelta(mesh: MeshData, delta: MeshDelta): MeshData {
  const verts = new Map(mesh.verts);
  const faces = new Map(mesh.faces);
  if (delta.delFaces) for (const f of delta.delFaces) faces.delete(f);
  if (delta.delVerts) for (const v of delta.delVerts) verts.delete(v);
  if (delta.setVerts) for (const k of Object.keys(delta.setVerts)) verts.set(k, delta.setVerts[k]);
  if (delta.setFaces) for (const k of Object.keys(delta.setFaces)) faces.set(k, delta.setFaces[k]);
  for (const [fid, loop] of faces) {
    let ok = loop.length >= 3 && new Set(loop).size === loop.length;
    if (ok) for (const v of loop) if (!verts.has(v)) ok = false;
    if (!ok) faces.delete(fid);
  }
  return { verts, faces };
}

/** Delta qui transforme `before` en `after` (deux maillages partageant leurs identifiants). */
export function diffMesh(before: MeshData, after: MeshData): MeshDelta {
  const delta: MeshDelta = {};
  const setVerts: Record<string, Vec3> = {};
  const setFaces: Record<string, string[]> = {};
  const delVerts: string[] = [];
  const delFaces: string[] = [];
  for (const v of before.verts.keys()) if (!after.verts.has(v)) delVerts.push(v);
  for (const f of before.faces.keys()) if (!after.faces.has(f)) delFaces.push(f);
  for (const [v, p] of after.verts) {
    const o = before.verts.get(v);
    if (!o || o[0] !== p[0] || o[1] !== p[1] || o[2] !== p[2]) setVerts[v] = [p[0], p[1], p[2]];
  }
  for (const [f, l] of after.faces) {
    const o = before.faces.get(f);
    let same = !!o && o.length === l.length;
    if (same) for (let i = 0; i < l.length; i++) if (o![i] !== l[i]) same = false;
    if (!same) setFaces[f] = l.slice();
  }
  if (Object.keys(setVerts).length) delta.setVerts = setVerts;
  if (Object.keys(setFaces).length) delta.setFaces = setFaces;
  if (delVerts.length) delta.delVerts = delVerts;
  if (delFaces.length) delta.delFaces = delFaces;
  return delta;
}

/** Vrai si le delta ne contient aucune modification. */
export function isEmptyDelta(delta: MeshDelta): boolean {
  return (
    (!delta.setVerts || Object.keys(delta.setVerts).length === 0) &&
    (!delta.setFaces || Object.keys(delta.setFaces).length === 0) &&
    (!delta.delVerts || delta.delVerts.length === 0) &&
    (!delta.delFaces || delta.delFaces.length === 0)
  );
}

/** Clés des arêtes d'une boucle de face. */
export function loopEdgeKeys(loop: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < loop.length; i++) out.push(edgeKey(loop[i], loop[(i + 1) % loop.length]));
  return out;
}

/**
 * Sélection cohérente décrivant un ensemble de faces : les faces, leurs sommets et leurs arêtes.
 * `faces` est une table id → boucle (les faces peuvent ne pas encore exister dans le maillage).
 */
export function selectionOfFaces(faces: Iterable<[string, readonly string[]]>): { verts: string[]; edges: string[]; faces: string[] } {
  const v = new Set<string>();
  const e = new Set<string>();
  const f: string[] = [];
  for (const [fid, loop] of faces) {
    f.push(fid);
    for (let i = 0; i < loop.length; i++) {
      v.add(loop[i]);
      e.add(edgeKey(loop[i], loop[(i + 1) % loop.length]));
    }
  }
  return { verts: [...v], edges: [...e], faces: f };
}

/**
 * Bord d'une région de faces : arêtes orientées (a → b, dans le sens de la face de la région)
 * qui n'ont pas d'arête jumelle (b → a) dans la région.
 */
export function regionBoundaryEdges(loops: Iterable<readonly string[]>): [string, string][] {
  const directed = new Set<string>();
  const list: [string, string][] = [];
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      directed.add(a + '|' + b);
      list.push([a, b]);
    }
  }
  return list.filter(([a, b]) => !directed.has(b + '|' + a));
}

/**
 * Chaîne les arêtes orientées du bord d'une région en boucles fermées.
 * Renvoie null si le bord est ambigu (sommet pincé, orientation incohérente) ou n'est pas fermé.
 */
export function chainBoundaryLoops(edges: readonly [string, string][]): string[][] | null {
  const next = new Map<string, string>();
  for (const [a, b] of edges) {
    if (next.has(a)) return null;
    next.set(a, b);
  }
  const loops: string[][] = [];
  const seen = new Set<string>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop: string[] = [];
    let cur = start;
    for (let guard = 0; guard <= next.size; guard++) {
      if (seen.has(cur)) break;
      seen.add(cur);
      loop.push(cur);
      const n = next.get(cur);
      if (n === undefined) return null;
      cur = n;
    }
    if (cur !== start) return null;
    loops.push(loop);
  }
  return loops;
}
