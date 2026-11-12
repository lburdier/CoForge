import { edgeKey, edgeVerts, type MeshData, type Vec3 } from '../../doc/schema';
import type { MeshOpResult } from '../types';
import { faceNormal, loopPositions, newellNormal, regionBoundaryEdges, selectionOfFaces, vertexNormals } from '../topology';
import { addScaled, cross, dot, normalize, sub } from '../vec';
import { existingFaces, randomId, type IdGen } from './common';
import { regionCornerKeys } from './work';

/** Résultat d'une extrusion : en plus du delta, la direction moyenne à utiliser pour le déplacement interactif. */
export interface ExtrudeResult extends MeshOpResult {
  /** Normale moyenne (unitaire) de la région extrudée. */
  normal: Vec3;
}

/** Normale moyenne d'un ensemble de faces, pondérée par l'aire. */
export function regionNormal(mesh: MeshData, loops: Iterable<readonly string[]>): Vec3 {
  const n: Vec3 = [0, 0, 0];
  for (const loop of loops) {
    const fn = newellNormal(loopPositions(mesh, loop));
    n[0] += fn[0];
    n[1] += fn[1];
    n[2] += fn[2];
  }
  return normalize(n, [0, 0, 1]);
}

/**
 * Extrusion par région (touche E) : les sommets du bord de la région sont dupliqués AUX MÊMES
 * POSITIONS, les faces sélectionnées (identifiants conservés) passent sur les nouveaux sommets et
 * des parois en quads relient l'ancien bord au nouveau. Les arêtes internes à la région ne créent pas de paroi.
 * `select` = faces du dessus (avec leurs sommets et arêtes) : c'est ce que l'outil doit déplacer.
 */
export function extrudeFaces(mesh: MeshData, faceIds: Iterable<string>, idGen: IdGen = randomId): ExtrudeResult {
  const region = existingFaces(mesh, faceIds);
  if (region.size === 0) return { delta: {}, normal: [0, 0, 1] };
  const boundary = regionBoundaryEdges(region.values());
  // Face de la région qui porte chaque arête orientée ; clé de duplication par coin (sommets pincés séparés).
  const owner = new Map<string, string>();
  for (const [fid, loop] of region) for (let i = 0; i < loop.length; i++) owner.set(loop[i] + '|' + loop[(i + 1) % loop.length], fid);
  const cornerKey = regionCornerKeys(region);
  const dup = new Map<string, string>();
  const setVerts: Record<string, Vec3> = {};
  const setFaces: Record<string, string[]> = {};
  const dupOf = (v: string, fid: string): string | undefined => dup.get(cornerKey(v, fid));
  for (const [a, b] of boundary) {
    const fid = owner.get(a + '|' + b)!;
    for (const v of [a, b]) {
      const k = cornerKey(v, fid);
      if (dup.has(k)) continue;
      const p = mesh.verts.get(v);
      if (!p) continue;
      const id = idGen();
      dup.set(k, id);
      setVerts[id] = [p[0], p[1], p[2]];
    }
  }
  const top = new Map<string, string[]>();
  for (const [fid, loop] of region) {
    const mapped = loop.map((v) => dupOf(v, fid) ?? v);
    top.set(fid, mapped);
    if (mapped.some((v, i) => v !== loop[i])) setFaces[fid] = mapped;
  }
  for (const [a, b] of boundary) {
    const fid = owner.get(a + '|' + b)!;
    const a2 = dupOf(a, fid);
    const b2 = dupOf(b, fid);
    if (!a2 || !b2) continue;
    setFaces[idGen()] = [a, b, b2, a2];
  }
  return { delta: { setVerts, setFaces }, select: selectionOfFaces(top), normal: regionNormal(mesh, region.values()) };
}

/**
 * Extrusion le long des normales (Alt+E) : comme `extrudeFaces`, puis chaque sommet du dessus est
 * déplacé de `distance` le long de la normale moyenne des faces de la région qui le touchent.
 */
export function extrudeFacesAlongNormals(mesh: MeshData, faceIds: Iterable<string>, distance: number, idGen: IdGen = randomId): ExtrudeResult {
  const region = existingFaces(mesh, faceIds);
  const res = extrudeFaces(mesh, region.keys(), idGen);
  if (region.size === 0 || !Number.isFinite(distance) || distance === 0) return res;
  const normals = vertexNormals(mesh, region.keys());
  const setVerts = res.delta.setVerts ?? (res.delta.setVerts = {});
  for (const [fid, loop] of region) {
    const mapped = res.delta.setFaces?.[fid] ?? loop;
    for (let i = 0; i < loop.length; i++) {
      const p = mesh.verts.get(loop[i]);
      const n = normals.get(loop[i]);
      if (!p || !n) continue;
      setVerts[mapped[i]] = addScaled(p, n, distance);
    }
  }
  return res;
}

/**
 * Extrusion individuelle : chaque face est extrudée séparément le long de sa propre normale
 * (tous ses sommets sont dupliqués, une paroi par arête).
 */
export function extrudeFacesIndividual(mesh: MeshData, faceIds: Iterable<string>, distance = 0, idGen: IdGen = randomId): ExtrudeResult {
  const region = existingFaces(mesh, faceIds);
  if (region.size === 0) return { delta: {}, normal: [0, 0, 1] };
  const d = Number.isFinite(distance) ? distance : 0;
  const setVerts: Record<string, Vec3> = {};
  const setFaces: Record<string, string[]> = {};
  const top = new Map<string, string[]>();
  for (const [fid, loop] of region) {
    const n = faceNormal(mesh, loop);
    const mapped = loop.map((v) => {
      const id = idGen();
      setVerts[id] = addScaled(mesh.verts.get(v) ?? [0, 0, 0], n, d);
      return id;
    });
    setFaces[fid] = mapped;
    top.set(fid, mapped);
    for (let i = 0; i < loop.length; i++) {
      const j = (i + 1) % loop.length;
      setFaces[idGen()] = [loop[i], loop[j], mapped[j], mapped[i]];
    }
  }
  return { delta: { setVerts, setFaces }, select: selectionOfFaces(top), normal: regionNormal(mesh, region.values()) };
}

/**
 * Extrusion d'arêtes : chaque arête donne un quad vers une copie de ses sommets (créée aux mêmes positions).
 * Le quad est orienté dans la continuité de la face voisine quand il y en a une.
 * `select` = les nouvelles arêtes et leurs sommets ; `normal` = direction conseillée (dans le plan des faces voisines, vers l'extérieur du bord).
 */
export function extrudeEdges(mesh: MeshData, edgeKeys: Iterable<string>, idGen: IdGen = randomId): ExtrudeResult {
  // Arêtes orientées présentes dans le maillage, avec la face qui les porte.
  const directed = new Map<string, string>();
  for (const [fid, loop] of mesh.faces) {
    for (let i = 0; i < loop.length; i++) directed.set(loop[i] + '|' + loop[(i + 1) % loop.length], fid);
  }
  const dup = new Map<string, string>();
  const setVerts: Record<string, Vec3> = {};
  const setFaces: Record<string, string[]> = {};
  const newEdges: string[] = [];
  const dir: Vec3 = [0, 0, 0];
  const seen = new Set<string>();
  const copyOf = (v: string): string => {
    let id = dup.get(v);
    if (!id) {
      id = idGen();
      dup.set(v, id);
      const p = mesh.verts.get(v)!;
      setVerts[id] = [p[0], p[1], p[2]];
    }
    return id;
  };
  for (const key of edgeKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const [a, b] = edgeVerts(key);
    const pa = mesh.verts.get(a);
    const pb = mesh.verts.get(b);
    if (!pa || !pb || a === b) continue;
    const fwd = directed.get(a + '|' + b);
    const rev = directed.get(b + '|' + a);
    if (fwd === undefined && rev === undefined) continue;
    const a2 = copyOf(a);
    const b2 = copyOf(b);
    // Si une face parcourt a → b, le nouveau quad doit parcourir b → a (et inversement).
    const owner = fwd !== undefined ? fwd : rev!;
    const [p, q, p2, q2] = fwd !== undefined ? [b, a, a2, b2] : [a, b, b2, a2];
    setFaces[idGen()] = [p, q, p2, q2];
    newEdges.push(edgeKey(a2, b2));
    // Direction sortante : dans le plan de la face porteuse, perpendiculaire à l'arête, à l'opposé de la face.
    const n = faceNormal(mesh, owner);
    const along = fwd !== undefined ? sub(pb, pa) : sub(pa, pb);
    const out = normalize(cross(along, n));
    if (dot(out, out) > 0) {
      dir[0] += out[0];
      dir[1] += out[1];
      dir[2] += out[2];
    }
  }
  if (newEdges.length === 0) return { delta: {}, normal: [0, 0, 1] };
  return {
    delta: { setVerts, setFaces },
    select: { verts: [...dup.values()], edges: newEdges, faces: [] },
    normal: normalize(dir, [0, 0, 1]),
  };
}

/**
 * Extrusion en mode sommets. Un sommet isolé ne peut pas être extrudé (une arête sans face n'est pas
 * représentable dans MeshData) ; la sélection est donc interprétée ainsi :
 *  - s'il existe des faces dont tous les sommets sont sélectionnés → extrusion par région de ces faces ;
 *  - sinon, les arêtes dont les deux sommets sont sélectionnés sont extrudées comme des arêtes ;
 *  - sinon, résultat vide.
 */
export function extrudeVerts(mesh: MeshData, vertIds: Iterable<string>, idGen: IdGen = randomId): ExtrudeResult {
  const verts = new Set<string>();
  for (const v of vertIds) if (mesh.verts.has(v)) verts.add(v);
  if (verts.size < 2) return { delta: {}, normal: [0, 0, 1] };
  const faces: string[] = [];
  const edges = new Set<string>();
  for (const [fid, loop] of mesh.faces) {
    let all = loop.length >= 3;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      if (!verts.has(a)) all = false;
      else if (verts.has(b) && a !== b) edges.add(edgeKey(a, b));
    }
    if (all) faces.push(fid);
  }
  if (faces.length > 0) return extrudeFaces(mesh, faces, idGen);
  if (edges.size > 0) return extrudeEdges(mesh, edges, idGen);
  return { delta: {}, normal: [0, 0, 1] };
}
