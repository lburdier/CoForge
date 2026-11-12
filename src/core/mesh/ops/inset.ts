import type { MeshData, Vec3 } from '../../doc/schema';
import type { MeshOpResult } from '../types';
import { faceNormal, regionBoundaryEdges, selectionOfFaces, vertexNormals } from '../topology';
import { addScaled, cross, dot, normalize, sub } from '../vec';
import { existingFaces, randomId, type IdGen } from './common';
import { regionCornerKeys } from './work';

/**
 * Incrustation par région (touche I) : le bord de la région sélectionnée est décalé vers l'intérieur
 * de `thickness` (mesuré perpendiculairement aux arêtes de bord), une couronne de quads relie l'ancien
 * bord au nouveau. `depth` déplace ensuite la région incrustée le long de ses normales.
 * Les faces sélectionnées gardent leurs identifiants ; `select` = ces faces (intérieures).
 */
export function insetFaces(mesh: MeshData, faceIds: Iterable<string>, thickness: number, depth = 0, idGen: IdGen = randomId): MeshOpResult {
  const region = existingFaces(mesh, faceIds);
  if (region.size === 0) return { delta: {} };
  const t = Number.isFinite(thickness) ? thickness : 0;
  const d = Number.isFinite(depth) ? depth : 0;

  // Arêtes de bord orientées, avec la direction « vers l'intérieur » dans le plan de leur face.
  const directedOwner = new Map<string, string>();
  for (const [fid, loop] of region) {
    for (let i = 0; i < loop.length; i++) directedOwner.set(loop[i] + '|' + loop[(i + 1) % loop.length], fid);
  }
  const boundary = regionBoundaryEdges(region.values());
  if (boundary.length === 0) return { delta: {}, select: selectionOfFaces(region) };
  // Clé de duplication par coin : un sommet où la région ne se touche que par un point est dupliqué par groupe.
  const cornerKey = regionCornerKeys(region);
  const normalCache = new Map<string, Vec3>();
  const inward = new Map<string, Vec3[]>();
  /** Clé de coin → sommet d'origine. */
  const boundaryCorners = new Map<string, string>();
  const boundaryVerts = new Set<string>();
  for (const [a, b] of boundary) {
    const fid = directedOwner.get(a + '|' + b)!;
    boundaryVerts.add(a);
    boundaryVerts.add(b);
    boundaryCorners.set(cornerKey(a, fid), a);
    boundaryCorners.set(cornerKey(b, fid), b);
    const pa = mesh.verts.get(a);
    const pb = mesh.verts.get(b);
    if (!pa || !pb) continue;
    let n = normalCache.get(fid);
    if (!n) normalCache.set(fid, (n = faceNormal(mesh, fid)));
    const inDir = normalize(cross(n, sub(pb, pa)));
    if (dot(inDir, inDir) === 0) continue;
    for (const v of [a, b]) {
      const k = cornerKey(v, fid);
      const l = inward.get(k);
      if (l) l.push(inDir);
      else inward.set(k, [inDir]);
    }
  }

  const normals = vertexNormals(mesh, region.keys());
  const dup = new Map<string, string>();
  const setVerts: Record<string, Vec3> = {};
  const setFaces: Record<string, string[]> = {};
  for (const [k, v] of boundaryCorners) {
    const p = mesh.verts.get(v);
    if (!p) continue;
    const ins = inward.get(k) ?? [];
    let offset: Vec3 = [0, 0, 0];
    if (ins.length === 2) {
      // Point à distance t des deux droites de bord : t (i1 + i2) / (1 + i1·i2).
      const denom = Math.max(0.15, 1 + dot(ins[0], ins[1]));
      offset = [((ins[0][0] + ins[1][0]) * t) / denom, ((ins[0][1] + ins[1][1]) * t) / denom, ((ins[0][2] + ins[1][2]) * t) / denom];
    } else if (ins.length > 0) {
      const s: Vec3 = [0, 0, 0];
      for (const i of ins) {
        s[0] += i[0];
        s[1] += i[1];
        s[2] += i[2];
      }
      const u = normalize(s);
      offset = [u[0] * t, u[1] * t, u[2] * t];
    }
    const id = idGen();
    dup.set(k, id);
    const n = normals.get(v) ?? [0, 0, 1];
    setVerts[id] = [p[0] + offset[0] + n[0] * d, p[1] + offset[1] + n[1] * d, p[2] + offset[2] + n[2] * d];
  }
  // Sommets intérieurs de la région : seulement déplacés par la profondeur.
  if (d !== 0) {
    for (const loop of region.values()) {
      for (const v of loop) {
        if (boundaryVerts.has(v) || setVerts[v]) continue;
        const p = mesh.verts.get(v);
        const n = normals.get(v);
        if (p && n) setVerts[v] = addScaled(p, n, d);
      }
    }
  }
  const inner = new Map<string, string[]>();
  for (const [fid, loop] of region) {
    const mapped = loop.map((v) => dup.get(cornerKey(v, fid)) ?? v);
    inner.set(fid, mapped);
    setFaces[fid] = mapped;
  }
  for (const [a, b] of boundary) {
    const fid = directedOwner.get(a + '|' + b)!;
    const a2 = dup.get(cornerKey(a, fid));
    const b2 = dup.get(cornerKey(b, fid));
    if (a2 && b2) setFaces[idGen()] = [a, b, b2, a2];
  }
  return { delta: { setVerts, setFaces }, select: selectionOfFaces(inner) };
}

/**
 * Incrustation individuelle : chaque face est incrustée séparément (tous ses sommets sont dupliqués,
 * décalés de `thickness` vers l'intérieur de la face puis de `depth` le long de sa normale).
 * Les faces gardent leurs identifiants ; `select` = ces faces (intérieures).
 */
export function insetFacesIndividual(mesh: MeshData, faceIds: Iterable<string>, thickness: number, depth = 0, idGen: IdGen = randomId): MeshOpResult {
  const region = existingFaces(mesh, faceIds);
  if (region.size === 0) return { delta: {} };
  const t = Number.isFinite(thickness) ? thickness : 0;
  const d = Number.isFinite(depth) ? depth : 0;
  const setVerts: Record<string, Vec3> = {};
  const setFaces: Record<string, string[]> = {};
  const inner = new Map<string, string[]>();
  for (const [fid, loop] of region) {
    const n = faceNormal(mesh, loop);
    const m = loop.length;
    const pts = loop.map((v) => mesh.verts.get(v));
    if (pts.some((p) => !p)) continue;
    const mapped: string[] = [];
    for (let i = 0; i < m; i++) {
      const p = pts[i]!;
      const prev = pts[(i + m - 1) % m]!;
      const next = pts[(i + 1) % m]!;
      const in1 = normalize(cross(n, sub(p, prev)));
      const in2 = normalize(cross(n, sub(next, p)));
      const denom = Math.max(0.15, 1 + dot(in1, in2));
      const id = idGen();
      mapped.push(id);
      setVerts[id] = [
        p[0] + ((in1[0] + in2[0]) * t) / denom + n[0] * d,
        p[1] + ((in1[1] + in2[1]) * t) / denom + n[1] * d,
        p[2] + ((in1[2] + in2[2]) * t) / denom + n[2] * d,
      ];
    }
    setFaces[fid] = mapped;
    inner.set(fid, mapped);
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      setFaces[idGen()] = [loop[i], loop[j], mapped[j], mapped[i]];
    }
  }
  if (inner.size === 0) return { delta: {} };
  return { delta: { setVerts, setFaces }, select: selectionOfFaces(inner) };
}
