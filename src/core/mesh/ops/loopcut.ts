import { edgeKey, type MeshData, type Vec3 } from '../../doc/schema';
import type { MeshOpResult } from '../types';
import { walkEdgeRing } from '../select';
import { lerp } from '../vec';
import { emptyResult, isValidLoop, randomId, type IdGen } from './common';
import { insertOnEdge, loopHasEdge, WorkMesh } from './work';

/** Plan d'une coupe en boucle : anneau orienté, paramètres de coupe le long de chaque arête. */
interface LoopCutPlan {
  edges: [string, string][];
  faces: string[];
  closed: boolean;
  /** Paramètres (0..1, de a vers b) des coupes, identiques pour toutes les arêtes de l'anneau. */
  ts: number[];
}

function planLoopCut(mesh: MeshData, key: string, cuts: number, factor: number): LoopCutPlan | null {
  if (typeof key !== 'string') return null;
  const ring = walkEdgeRing(mesh, key);
  if (!ring || ring.faces.length === 0) return null;
  for (const [a, b] of ring.edges) if (!mesh.verts.has(a) || !mesh.verts.has(b)) return null;
  const E = ring.edges.length;
  // Vérifie que chaque quad relie bien deux arêtes consécutives de l'anneau.
  for (let i = 0; i < ring.faces.length; i++) {
    const loop = mesh.faces.get(ring.faces[i]);
    if (!loop || loop.length !== 4) return null;
    const [a, b] = ring.edges[i];
    const [c, d] = ring.edges[(i + 1) % E];
    if (loopHasEdge(loop, a, b) === 0 || loopHasEdge(loop, c, d) === 0) return null;
    // Orientation cohérente : le quad est [a, b, d, c] ou [b, a, c, d].
    if (loopHasEdge(loop, b, d) === 0 || loopHasEdge(loop, a, c) === 0) return null;
  }
  const n = Math.max(1, Math.min(128, Math.round(Number.isFinite(cuts) ? cuts : 1)));
  const f = Math.max(-1, Math.min(1, Number.isFinite(factor) ? factor : 0));
  const step = 1 / (n + 1);
  const ts: number[] = [];
  for (let k = 1; k <= n; k++) ts.push(Math.max(0, Math.min(1, k * step + f * step)));
  return { edges: ring.edges, faces: ring.faces, closed: ring.closed, ts };
}

/**
 * Coupe en boucle (Ctrl+R) à travers l'anneau de quads passant par l'arête `edgeKey` :
 * `cuts` boucles régulièrement espacées, glissées de `factor` (-1..1, en fraction de l'espacement,
 * dans le sens de l'arête de départ). Les faces non quadrangulaires aux extrémités d'un anneau ouvert
 * reçoivent les nouveaux sommets (pas de fissure). `select` = les nouvelles arêtes de boucle.
 */
export function loopCut(mesh: MeshData, edgeKey_: string, cuts: number, factor: number, idGen: IdGen = randomId): MeshOpResult {
  const plan = planLoopCut(mesh, edgeKey_, cuts, factor);
  if (!plan) return emptyResult();
  const work = new WorkMesh(mesh);
  const E = plan.edges.length;
  // pts[i][k] : k-ième point de coupe sur l'arête i, ordonné de a vers b.
  const pts: string[][] = plan.edges.map(([a, b]) => {
    const pa = mesh.verts.get(a)!;
    const pb = mesh.verts.get(b)!;
    return plan.ts.map((t) => {
      const id = idGen();
      work.setVert(id, lerp(pa, pb, t));
      return id;
    });
  });
  const ringFaces = new Set(plan.faces);
  const newEdges: string[] = [];
  for (let i = 0; i < plan.faces.length; i++) {
    const fid = plan.faces[i];
    const loop = mesh.faces.get(fid)!;
    const j = (i + 1) % E;
    const [a, b] = plan.edges[i];
    const [a2, b2] = plan.edges[j];
    const A = [a, ...pts[i], b];
    const B = [a2, ...pts[j], b2];
    const forward = loopHasEdge(loop, a, b) === 1;
    const strips: string[][] = [];
    for (let k = 0; k + 1 < A.length; k++) {
      strips.push(forward ? [A[k], A[k + 1], B[k + 1], B[k]] : [A[k + 1], A[k], B[k], B[k + 1]]);
    }
    if (!strips.every(isValidLoop)) return emptyResult();
    work.delFace(fid);
    work.setFace(fid, strips[0]);
    for (let s = 1; s < strips.length; s++) work.setFace(idGen(), strips[s]);
    for (let k = 0; k < pts[i].length; k++) newEdges.push(edgeKey(pts[i][k], pts[j][k]));
  }
  // Autres faces portant une arête de l'anneau (extrémités d'un anneau ouvert, arêtes non manifold).
  for (let i = 0; i < E; i++) {
    const [a, b] = plan.edges[i];
    for (const f of work.edgeFaces(a, b)) {
      if (ringFaces.has(f)) continue;
      work.setFace(f, insertOnEdge(work.faces.get(f)!, a, b, pts[i]));
    }
  }
  const verts = pts.flat();
  return { delta: work.toDelta(), select: { verts, edges: newEdges, faces: [] } };
}

/**
 * Aperçu de la coupe en boucle : une polyligne (coordonnées locales) par coupe, fermée (premier point
 * répété à la fin) si l'anneau est fermé. Liste vide si la coupe est impossible.
 */
export function loopCutPreview(mesh: MeshData, edgeKey_: string, cuts: number, factor: number): Vec3[][] {
  const plan = planLoopCut(mesh, edgeKey_, cuts, factor);
  if (!plan) return [];
  const lines: Vec3[][] = plan.ts.map(() => []);
  for (const [a, b] of plan.edges) {
    const pa = mesh.verts.get(a)!;
    const pb = mesh.verts.get(b)!;
    plan.ts.forEach((t, k) => lines[k].push(lerp(pa, pb, t)));
  }
  if (plan.closed) for (const l of lines) if (l.length) l.push([l[0][0], l[0][1], l[0][2]]);
  return lines;
}
