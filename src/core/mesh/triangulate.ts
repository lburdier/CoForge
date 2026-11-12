import type { MeshData, Vec3 } from '../doc/schema';
import type { RenderMesh, TriangulateOptions } from './types';
import { newellNormal } from './topology';

/**
 * Triangule un polygone 3D (éventuellement concave) par découpe d'oreilles dans son plan moyen.
 * Renvoie des triplets d'indices dans `pts` (n - 2 triangles, même sens de parcours que le polygone).
 * Ne boucle jamais : sur une entrée dégénérée, les triangles restants sont produits de force.
 */
export function triangulatePolygon(pts: readonly Vec3[]): number[] {
  const n = pts.length;
  if (n < 3) return [];
  if (n === 3) return [0, 1, 2];
  const nrm = newellNormal(pts);
  const ax = Math.abs(nrm[0]);
  const ay = Math.abs(nrm[1]);
  const az = Math.abs(nrm[2]);
  if (ax + ay + az < 1e-20) return fan(n);
  // Projection 2D : on abandonne l'axe dominant de la normale, en gardant un polygone antihoraire.
  let iu: number;
  let iv: number;
  if (az >= ax && az >= ay) {
    iu = nrm[2] > 0 ? 0 : 1;
    iv = nrm[2] > 0 ? 1 : 0;
  } else if (ax >= ay) {
    iu = nrm[0] > 0 ? 1 : 2;
    iv = nrm[0] > 0 ? 2 : 1;
  } else {
    iu = nrm[1] > 0 ? 2 : 0;
    iv = nrm[1] > 0 ? 0 : 2;
  }
  const X = new Float64Array(n);
  const Y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    X[i] = pts[i][iu];
    Y[i] = pts[i][iv];
  }
  const area2 = (a: number, b: number, c: number) => (X[b] - X[a]) * (Y[c] - Y[a]) - (X[c] - X[a]) * (Y[b] - Y[a]);

  if (n === 4) {
    if (area2(0, 1, 2) > 0 && area2(0, 2, 3) > 0) return [0, 1, 2, 0, 2, 3];
    if (area2(1, 2, 3) > 0 && area2(1, 3, 0) > 0) return [1, 2, 3, 1, 3, 0];
    return area2(0, 1, 2) >= 0 && area2(0, 2, 3) >= 0 ? [0, 1, 2, 0, 2, 3] : [1, 2, 3, 1, 3, 0];
  }

  const prev = new Int32Array(n);
  const next = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    prev[i] = (i + n - 1) % n;
    next[i] = (i + 1) % n;
  }
  let scaleSq = 0;
  for (let i = 0; i < n; i++) scaleSq = Math.max(scaleSq, X[i] * X[i] + Y[i] * Y[i]);
  const eps = scaleSq * 1e-14;

  /** Aucun autre sommet restant strictement dans le triangle (a, b, c) ? */
  const isClear = (a: number, b: number, c: number): boolean => {
    let p = next[c];
    while (p !== a) {
      // on ignore les sommets confondus avec un coin du triangle
      const same = (X[p] === X[a] && Y[p] === Y[a]) || (X[p] === X[b] && Y[p] === Y[b]) || (X[p] === X[c] && Y[p] === Y[c]);
      if (!same && area2(a, b, p) >= -eps && area2(b, c, p) >= -eps && area2(c, a, p) >= -eps) return false;
      p = next[p];
    }
    return true;
  };

  const out: number[] = [];
  let remaining = n;
  let cur = 0;
  let sinceClip = 0;
  // 0 : oreilles strictement convexes ; 1 : oreilles plates acceptées ; 2 : découpe forcée.
  let level = 0;
  while (remaining > 3) {
    const a = prev[cur];
    const c = next[cur];
    const ar = area2(a, cur, c);
    let ok: boolean;
    if (level === 0) ok = ar > eps && isClear(a, cur, c);
    else if (level === 1) ok = ar >= -eps && isClear(a, cur, c);
    else ok = true;
    if (ok) {
      out.push(a, cur, c);
      next[a] = c;
      prev[c] = a;
      remaining--;
      sinceClip = 0;
      level = 0;
      cur = c;
    } else {
      cur = c;
      sinceClip++;
      if (sinceClip > remaining) {
        level++;
        sinceClip = 0;
      }
    }
  }
  out.push(prev[cur], cur, next[cur]);
  return out;
}

function fan(n: number): number[] {
  const out: number[] = [];
  for (let i = 1; i + 1 < n; i++) out.push(0, i, i + 1);
  return out;
}

/**
 * CONTRAT — géométrie d'affichage d'un maillage.
 * Triangles/quads : éventail (diagonale valide choisie pour les quads concaves) ; n-gones : découpe d'oreilles.
 * Normales plates, ou lissées par sommet en ne moyennant que les faces dont l'angle avec la face
 * courante ne dépasse pas `autoSmoothAngle` (les arêtes plus vives restent vives).
 */
/**
 * Topologie d'un maillage, indépendante des positions : tout ce qui coûte cher à recalculer
 * (tables à clés texte, CSR sommet → faces, arêtes uniques, faces d'origine des triangles).
 * Mise en cache selon l'IDENTITÉ de la table des faces : SceneDoc réutilise la même table
 * quand seuls des sommets bougent (G/R/S, glisser), si bien qu'un déplacement ne coûte plus
 * que des boucles numériques.
 */
interface Topology {
  vIds: string[];
  faceIds: string[];
  loopStart: Int32Array;
  corners: Int32Array;
  triCount: number;
  triFace: string[];
  edgeA: Int32Array;
  edgeB: Int32Array;
  edgeKeys: string[];
  vStart: Int32Array | null;
  vFaces: Int32Array | null;
}

const topologyCache = new WeakMap<ReadonlyMap<string, readonly string[]>, Topology>();

function buildTopology(mesh: MeshData): Topology {
  const nv = mesh.verts.size;
  const vIndex = new Map<string, number>();
  const vIds = new Array<string>(nv);
  let vi = 0;
  for (const id of mesh.verts.keys()) {
    vIndex.set(id, vi);
    vIds[vi++] = id;
  }
  const faceIds: string[] = [];
  const loopStartArr: number[] = [0];
  const cornersArr: number[] = [];
  let triCount = 0;
  for (const [fid, loop] of mesh.faces) {
    const n = loop.length;
    if (n < 3) continue;
    const base = cornersArr.length;
    let ok = true;
    for (let i = 0; i < n; i++) {
      const idx = vIndex.get(loop[i]);
      if (idx === undefined) {
        ok = false;
        break;
      }
      cornersArr.push(idx);
    }
    if (!ok) {
      cornersArr.length = base;
      continue;
    }
    faceIds.push(fid);
    loopStartArr.push(cornersArr.length);
    triCount += n - 2;
  }
  const loopStart = Int32Array.from(loopStartArr);
  const corners = Int32Array.from(cornersArr);
  const nf = faceIds.length;

  // Faces d'origine des triangles (n - 2 triangles consécutifs par face, dans l'ordre des faces).
  const triFace = new Array<string>(triCount);
  let t = 0;
  for (let f = 0; f < nf; f++) {
    const n = loopStart[f + 1] - loopStart[f];
    for (let k = 0; k < n - 2; k++) triFace[t++] = faceIds[f];
  }

  // Arêtes polygonales uniques.
  const seen = new Set<number>();
  const ea: number[] = [];
  const eb: number[] = [];
  const edgeKeys: string[] = [];
  for (let f = 0; f < nf; f++) {
    const s = loopStart[f];
    const e = loopStart[f + 1];
    for (let i = s; i < e; i++) {
      const a = corners[i];
      const b = corners[i + 1 < e ? i + 1 : s];
      if (a === b) continue;
      const key = a < b ? a * nv + b : b * nv + a;
      if (seen.has(key)) continue;
      seen.add(key);
      const ia = vIds[a];
      const ib = vIds[b];
      edgeKeys.push(ia < ib ? ia + '|' + ib : ib + '|' + ia);
      ea.push(a);
      eb.push(b);
    }
  }
  return {
    vIds,
    faceIds,
    loopStart,
    corners,
    triCount,
    triFace,
    edgeA: Int32Array.from(ea),
    edgeB: Int32Array.from(eb),
    edgeKeys,
    vStart: null,
    vFaces: null,
  };
}

/** Table sommet → faces incidentes (CSR), construite à la demande (ombrage lisse). */
function vertexFaces(topo: Topology): { vStart: Int32Array; vFaces: Int32Array } {
  if (topo.vStart && topo.vFaces) return { vStart: topo.vStart, vFaces: topo.vFaces };
  const nv = topo.vIds.length;
  const nf = topo.faceIds.length;
  const { corners, loopStart } = topo;
  const nc = corners.length;
  const vStart = new Int32Array(nv + 1);
  for (let i = 0; i < nc; i++) vStart[corners[i] + 1]++;
  for (let i = 0; i < nv; i++) vStart[i + 1] += vStart[i];
  const fill = vStart.slice(0, nv);
  const vFaces = new Int32Array(nc);
  for (let f = 0; f < nf; f++) {
    for (let i = loopStart[f]; i < loopStart[f + 1]; i++) vFaces[fill[corners[i]]++] = f;
  }
  topo.vStart = vStart;
  topo.vFaces = vFaces;
  return { vStart, vFaces };
}

/**
 * Positions des sommets dans l'ordre de la topologie. Renvoie null si l'ordre ou l'ensemble des
 * sommets ne correspond plus (la topologie mise en cache doit alors être reconstruite).
 */
function fillPositions(mesh: MeshData, topo: Topology, P: Float64Array): boolean {
  const vIds = topo.vIds;
  if (mesh.verts.size !== vIds.length) return false;
  let i = 0;
  for (const [id, p] of mesh.verts) {
    if (vIds[i] !== id) return false;
    P[i * 3] = p[0];
    P[i * 3 + 1] = p[1];
    P[i * 3 + 2] = p[2];
    i++;
  }
  return true;
}

export function triangulate(mesh: MeshData, opts: TriangulateOptions): RenderMesh {
  let topo = topologyCache.get(mesh.faces);
  let P = new Float64Array(mesh.verts.size * 3);
  if (!topo || !fillPositions(mesh, topo, P)) {
    topo = buildTopology(mesh);
    topologyCache.set(mesh.faces, topo);
    P = new Float64Array(mesh.verts.size * 3);
    fillPositions(mesh, topo, P);
  }
  const { faceIds, loopStart, corners, triCount } = topo;
  const nf = faceIds.length;
  const nc = corners.length;

  // Normales de faces (Newell).
  const FN = new Float64Array(nf * 3);
  for (let f = 0; f < nf; f++) {
    const s = loopStart[f];
    const e = loopStart[f + 1];
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = s; i < e; i++) {
      const a = corners[i] * 3;
      const b = corners[i + 1 < e ? i + 1 : s] * 3;
      nx += (P[a + 1] - P[b + 1]) * (P[a + 2] + P[b + 2]);
      ny += (P[a + 2] - P[b + 2]) * (P[a] + P[b]);
      nz += (P[a] - P[b]) * (P[a + 1] + P[b + 1]);
    }
    const l = Math.hypot(nx, ny, nz);
    if (l > 1e-20) {
      FN[f * 3] = nx / l;
      FN[f * 3 + 1] = ny / l;
      FN[f * 3 + 2] = nz / l;
    } else {
      FN[f * 3 + 2] = 1;
    }
  }

  // Normales par coin (ombrage lisse avec angle d'auto-lissage).
  let CN: Float32Array | null = null;
  if (opts.smooth) {
    CN = new Float32Array(nc * 3);
    const angle = Number.isFinite(opts.autoSmoothAngle) ? Math.max(0, Math.min(180, opts.autoSmoothAngle)) : 180;
    const cosLimit = angle >= 180 ? -2 : Math.cos((angle * Math.PI) / 180) - 1e-6;
    // Table sommet → faces incidentes (CSR), en cache avec la topologie.
    const { vStart, vFaces } = vertexFaces(topo);
    for (let f = 0; f < nf; f++) {
      const fx = FN[f * 3];
      const fy = FN[f * 3 + 1];
      const fz = FN[f * 3 + 2];
      for (let i = loopStart[f]; i < loopStart[f + 1]; i++) {
        const v = corners[i];
        let nx = 0;
        let ny = 0;
        let nz = 0;
        for (let k = vStart[v]; k < vStart[v + 1]; k++) {
          const g = vFaces[k] * 3;
          if (fx * FN[g] + fy * FN[g + 1] + fz * FN[g + 2] >= cosLimit) {
            nx += FN[g];
            ny += FN[g + 1];
            nz += FN[g + 2];
          }
        }
        const l = Math.hypot(nx, ny, nz);
        if (l > 1e-12) {
          CN[i * 3] = nx / l;
          CN[i * 3 + 1] = ny / l;
          CN[i * 3 + 2] = nz / l;
        } else {
          CN[i * 3] = fx;
          CN[i * 3 + 1] = fy;
          CN[i * 3 + 2] = fz;
        }
      }
    }
  }

  const positions = new Float32Array(triCount * 9);
  const normals = new Float32Array(triCount * 9);
  let t = 0;
  const emit = (f: number, c0: number, c1: number, c2: number) => {
    const o = t * 9;
    const a = corners[c0] * 3;
    const b = corners[c1] * 3;
    const c = corners[c2] * 3;
    positions[o] = P[a];
    positions[o + 1] = P[a + 1];
    positions[o + 2] = P[a + 2];
    positions[o + 3] = P[b];
    positions[o + 4] = P[b + 1];
    positions[o + 5] = P[b + 2];
    positions[o + 6] = P[c];
    positions[o + 7] = P[c + 1];
    positions[o + 8] = P[c + 2];
    if (CN) {
      normals[o] = CN[c0 * 3];
      normals[o + 1] = CN[c0 * 3 + 1];
      normals[o + 2] = CN[c0 * 3 + 2];
      normals[o + 3] = CN[c1 * 3];
      normals[o + 4] = CN[c1 * 3 + 1];
      normals[o + 5] = CN[c1 * 3 + 2];
      normals[o + 6] = CN[c2 * 3];
      normals[o + 7] = CN[c2 * 3 + 1];
      normals[o + 8] = CN[c2 * 3 + 2];
    } else {
      const fx = FN[f * 3];
      const fy = FN[f * 3 + 1];
      const fz = FN[f * 3 + 2];
      normals[o] = normals[o + 3] = normals[o + 6] = fx;
      normals[o + 1] = normals[o + 4] = normals[o + 7] = fy;
      normals[o + 2] = normals[o + 5] = normals[o + 8] = fz;
    }
    t++;
  };

  for (let f = 0; f < nf; f++) {
    const s = loopStart[f];
    const n = loopStart[f + 1] - s;
    if (n === 3) {
      emit(f, s, s + 1, s + 2);
    } else if (n === 4) {
      // Diagonale 0-2 si les deux triangles sont orientés comme la face, sinon diagonale 1-3.
      const a = corners[s] * 3;
      const b = corners[s + 1] * 3;
      const c = corners[s + 2] * 3;
      const d = corners[s + 3] * 3;
      const fx = FN[f * 3];
      const fy = FN[f * 3 + 1];
      const fz = FN[f * 3 + 2];
      const acx = P[c] - P[a];
      const acy = P[c + 1] - P[a + 1];
      const acz = P[c + 2] - P[a + 2];
      const abx = P[b] - P[a];
      const aby = P[b + 1] - P[a + 1];
      const abz = P[b + 2] - P[a + 2];
      const adx = P[d] - P[a];
      const ady = P[d + 1] - P[a + 1];
      const adz = P[d + 2] - P[a + 2];
      const d1 = (aby * acz - abz * acy) * fx + (abz * acx - abx * acz) * fy + (abx * acy - aby * acx) * fz;
      const d2 = (acy * adz - acz * ady) * fx + (acz * adx - acx * adz) * fy + (acx * ady - acy * adx) * fz;
      if (d1 >= 0 && d2 >= 0) {
        emit(f, s, s + 1, s + 2);
        emit(f, s, s + 2, s + 3);
      } else {
        emit(f, s + 1, s + 2, s + 3);
        emit(f, s + 1, s + 3, s);
      }
    } else {
      const pts = new Array<Vec3>(n);
      for (let i = 0; i < n; i++) {
        const a = corners[s + i] * 3;
        pts[i] = [P[a], P[a + 1], P[a + 2]];
      }
      const tris = triangulatePolygon(pts);
      for (let i = 0; i + 2 < tris.length; i += 3) emit(f, s + tris[i], s + tris[i + 1], s + tris[i + 2]);
    }
  }

  // Arêtes polygonales uniques (paires d'indices en cache avec la topologie).
  const { edgeA, edgeB, edgeKeys } = topo;
  const ne = edgeA.length;
  const edgePositions = new Float32Array(ne * 6);
  for (let i = 0; i < ne; i++) {
    const a = edgeA[i] * 3;
    const b = edgeB[i] * 3;
    const o = i * 6;
    edgePositions[o] = P[a];
    edgePositions[o + 1] = P[a + 1];
    edgePositions[o + 2] = P[a + 2];
    edgePositions[o + 3] = P[b];
    edgePositions[o + 4] = P[b + 1];
    edgePositions[o + 5] = P[b + 2];
  }

  // triFace et edgeKeys sont partagés entre les résultats d'une même topologie (lecture seule).
  return {
    positions: t === triCount ? positions : positions.slice(0, t * 9),
    normals: t === triCount ? normals : normals.slice(0, t * 9),
    triFace: t === triCount ? topo.triFace : topo.triFace.slice(0, t),
    edgePositions,
    edgeKeys,
  };
}
