import { edgeKey, type MeshData, type MeshDelta, type Vec3 } from '../../doc/schema';
import type { MeshOpResult } from '../types';
import { faceCenter, loopPositions, meshVolume, newellNormal, reversedLoop, selectionOfFaces } from '../topology';
import { triangulatePolygon } from '../triangulate';
import { dot, sub } from '../vec';
import { emptyResult, existingFaces, isValidLoop, orphanVertsAfterRemoving, randomId, type IdGen } from './common';

/** Faces existantes dont tous les sommets existent (les autres sont ignorées). */
function completeFaces(mesh: MeshData, faceIds: Iterable<string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [f, loop] of existingFaces(mesh, faceIds)) {
    if (isValidLoop(loop) && loop.every((v) => mesh.verts.has(v))) out.set(f, loop);
  }
  return out;
}

/**
 * Triangule les faces sélectionnées (polygones concaves gérés). Le premier triangle de chaque face
 * garde l'identifiant de la face ; `select` = tous les triangles produits. Résultat vide si toutes
 * les faces sont déjà des triangles.
 */
export function triangulateFaces(mesh: MeshData, faceIds: Iterable<string>, idGen: IdGen = randomId): MeshOpResult {
  const region = completeFaces(mesh, faceIds);
  const setFaces: Record<string, string[]> = {};
  const result = new Map<string, string[]>();
  let changed = false;
  for (const [fid, loop] of region) {
    if (loop.length === 3) {
      result.set(fid, loop);
      continue;
    }
    const tris = triangulatePolygon(loopPositions(mesh, loop));
    let first = true;
    for (let i = 0; i + 2 < tris.length; i += 3) {
      const tri = [loop[tris[i]], loop[tris[i + 1]], loop[tris[i + 2]]];
      if (!isValidLoop(tri)) continue;
      const id = first ? fid : idGen();
      first = false;
      setFaces[id] = tri;
      result.set(id, tri);
      changed = true;
    }
  }
  if (!changed) return emptyResult();
  return { delta: { setFaces }, select: selectionOfFaces(result) };
}

/**
 * Duplique les faces (avec leurs sommets ; les sommets partagés entre faces copiées restent partagés).
 * La copie est superposée à l'original ; `select` = la copie.
 */
export function duplicateFaces(mesh: MeshData, faceIds: Iterable<string>, idGen: IdGen = randomId): MeshOpResult {
  const region = completeFaces(mesh, faceIds);
  if (region.size === 0) return emptyResult();
  const map = new Map<string, string>();
  const setVerts: Record<string, Vec3> = {};
  const setFaces: Record<string, string[]> = {};
  const copy = new Map<string, string[]>();
  for (const loop of region.values()) {
    const mapped = loop.map((v) => {
      let id = map.get(v);
      if (!id) {
        id = idGen();
        map.set(v, id);
        const p = mesh.verts.get(v)!;
        setVerts[id] = [p[0], p[1], p[2]];
      }
      return id;
    });
    const fid = idGen();
    setFaces[fid] = mapped;
    copy.set(fid, mapped);
  }
  return { delta: { setVerts, setFaces }, select: selectionOfFaces(copy) };
}

/**
 * Séparation (P) : retire les faces du maillage (ainsi que les sommets qui deviennent orphelins) et
 * renvoie la partie extraite comme maillage autonome (mêmes identifiants, sommets copiés).
 */
export function extractFaces(mesh: MeshData, faceIds: Iterable<string>): { delta: MeshDelta; extracted: MeshData } {
  const region = completeFaces(mesh, faceIds);
  const extracted: MeshData = { verts: new Map(), faces: new Map() };
  if (region.size === 0) return { delta: {}, extracted };
  for (const [fid, loop] of region) {
    extracted.faces.set(fid, loop.slice());
    for (const v of loop) {
      const p = mesh.verts.get(v)!;
      if (!extracted.verts.has(v)) extracted.verts.set(v, [p[0], p[1], p[2]]);
    }
  }
  const removed = new Set(region.keys());
  const delVerts = orphanVertsAfterRemoving(mesh, removed);
  const delta: MeshDelta = { delFaces: [...removed] };
  if (delVerts.length) delta.delVerts = delVerts;
  return { delta, extracted };
}

/** Inverse le sens des faces (et donc leurs normales). La sélection est inchangée. */
export function flipFaces(mesh: MeshData, faceIds: Iterable<string>): MeshOpResult {
  const region = existingFaces(mesh, faceIds);
  if (region.size === 0) return emptyResult();
  const setFaces: Record<string, string[]> = {};
  for (const [fid, loop] of region) setFaces[fid] = reversedLoop(loop);
  return { delta: { setFaces } };
}

/**
 * Recalcule les normales vers l'extérieur : les faces sont d'abord orientées de façon cohérente
 * dans chaque composante connexe (par arêtes partagées entre faces de la sélection), puis chaque
 * composante est retournée si son volume signé (relatif à son centre) est négatif. Pour une
 * composante ouverte de volume quasi nul, on oriente selon la position des faces par rapport au centre.
 * Résultat vide si rien ne change.
 */
export function recalcNormalsOutside(mesh: MeshData, faceIds: Iterable<string>): MeshOpResult {
  const region = existingFaces(mesh, faceIds);
  if (region.size === 0) return emptyResult();
  // Arête non orientée → faces de la région qui l'utilisent.
  const edgeFaces = new Map<string, string[]>();
  for (const [fid, loop] of region) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      if (a === b) continue;
      const k = edgeKey(a, b);
      const l = edgeFaces.get(k);
      if (l) {
        if (!l.includes(fid)) l.push(fid);
      } else edgeFaces.set(k, [fid]);
    }
  }
  const flipped = new Map<string, boolean>();
  const oriented = (fid: string): string[] => {
    const loop = region.get(fid)!;
    return flipped.get(fid) ? reversedLoop(loop) : loop;
  };
  const setFaces: Record<string, string[]> = {};
  for (const seed of region.keys()) {
    if (flipped.has(seed)) continue;
    flipped.set(seed, false);
    const component: string[] = [];
    const queue = [seed];
    while (queue.length) {
      const f = queue.shift()!;
      component.push(f);
      const loop = oriented(f);
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        if (a === b) continue;
        for (const g of edgeFaces.get(edgeKey(a, b)) ?? []) {
          if (g === f || flipped.has(g)) continue;
          // g doit parcourir b → a ; s'il parcourt a → b, on le retourne.
          const gl = region.get(g)!;
          let same = false;
          for (let j = 0; j < gl.length; j++) {
            if (gl[j] === a && gl[(j + 1) % gl.length] === b) {
              same = true;
              break;
            }
          }
          flipped.set(g, same);
          queue.push(g);
        }
      }
    }
    // Centre de la composante.
    const c: Vec3 = [0, 0, 0];
    let n = 0;
    for (const f of component) {
      for (const v of region.get(f)!) {
        const p = mesh.verts.get(v);
        if (!p) continue;
        c[0] += p[0];
        c[1] += p[1];
        c[2] += p[2];
        n++;
      }
    }
    if (n > 0) {
      c[0] /= n;
      c[1] /= n;
      c[2] /= n;
    }
    const tmp: MeshData = { verts: mesh.verts, faces: new Map(component.map((f) => [f, oriented(f)])) };
    let score = meshVolume(tmp, undefined, c);
    let scale = 0;
    for (const f of component) {
      const nn = newellNormal(loopPositions(mesh, oriented(f)));
      scale += Math.hypot(nn[0], nn[1], nn[2]);
    }
    if (Math.abs(score) <= 1e-9 * Math.max(1, scale)) {
      // Composante ouverte / plate : normales tournées à l'opposé du centre.
      score = 0;
      for (const f of component) {
        const loop = oriented(f);
        score += dot(newellNormal(loopPositions(mesh, loop)), sub(faceCenter(mesh, loop), c));
      }
    }
    const flipAll = score < 0;
    for (const f of component) {
      const fl = (flipped.get(f) ?? false) !== flipAll;
      if (fl) setFaces[f] = reversedLoop(region.get(f)!);
    }
  }
  if (Object.keys(setFaces).length === 0) return emptyResult();
  return { delta: { setFaces } };
}

/**
 * Ajoute au maillage une copie de `other` avec de nouveaux identifiants (les faces invalides de
 * `other` sont ignorées). `select` = la partie ajoutée. Sert à l'ajout de primitive et à la jointure.
 */
export function appendMesh(mesh: MeshData, other: MeshData, idGen: IdGen = randomId): MeshOpResult {
  void mesh;
  const map = new Map<string, string>();
  const setVerts: Record<string, Vec3> = {};
  const setFaces: Record<string, string[]> = {};
  for (const [v, p] of other.verts) {
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) continue;
    const id = idGen();
    map.set(v, id);
    setVerts[id] = [p[0], p[1], p[2]];
  }
  const added = new Map<string, string[]>();
  for (const loop of other.faces.values()) {
    if (!isValidLoop(loop) || !loop.every((v) => map.has(v))) continue;
    const mapped = loop.map((v) => map.get(v)!);
    const fid = idGen();
    setFaces[fid] = mapped;
    added.set(fid, mapped);
  }
  if (map.size === 0) return emptyResult();
  const select = selectionOfFaces(added);
  const inFaces = new Set(select.verts);
  for (const id of map.values()) if (!inFaces.has(id)) select.verts.push(id);
  const delta: MeshDelta = { setVerts };
  if (added.size) delta.setFaces = setFaces;
  return { delta, select };
}
