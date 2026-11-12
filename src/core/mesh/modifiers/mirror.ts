import type { MeshData, MirrorParams, Vec3 } from '../../doc/schema';
import { finiteOr, hashId } from './common';

/**
 * Symétrie par rapport aux plans passant par l'origine de l'objet (axes combinables).
 * Les faces symétriques sont retournées pour garder leurs normales vers l'extérieur. Avec `merge`,
 * les sommets à moins de `mergeDist` du plan sont ramenés dessus et partagés entre les deux moitiés.
 */
export function mirrorModifier(mesh: MeshData, params: MirrorParams, salt: string): MeshData {
  const axes = [params.axisX === true, params.axisY === true, params.axisZ === true];
  const merge = params.merge !== false;
  const dist = Math.max(0, finiteOr(params.mergeDist, 0.001));
  let cur = mesh;
  for (let axis = 0; axis < 3; axis++) {
    if (axes[axis]) cur = mirrorAxis(cur, axis, merge, dist, salt + ':' + axis);
  }
  return cur;
}

function mirrorAxis(mesh: MeshData, axis: number, merge: boolean, dist: number, salt: string): MeshData {
  if (mesh.verts.size === 0) return mesh;
  const verts = new Map<string, Vec3>();
  const faces = new Map<string, string[]>();
  /** Sommet d'origine → son symétrique (lui-même s'il est soudé sur le plan). */
  const twin = new Map<string, string>();
  for (const [id, p] of mesh.verts) {
    if (merge && Math.abs(p[axis]) <= dist) {
      const q: Vec3 = [p[0], p[1], p[2]];
      q[axis] = 0;
      verts.set(id, q);
      twin.set(id, id);
    } else {
      verts.set(id, p);
    }
  }
  for (const [id, p] of mesh.verts) {
    if (twin.has(id)) continue;
    const q: Vec3 = [p[0], p[1], p[2]];
    q[axis] = -q[axis];
    const nid = hashId(salt, 'v', id);
    verts.set(nid, q);
    twin.set(id, nid);
  }
  for (const [fid, loop] of mesh.faces) faces.set(fid, loop);
  for (const [fid, loop] of mesh.faces) {
    const n = loop.length;
    if (n < 3) continue;
    const out = new Array<string>(n);
    let onPlane = true;
    let valid = true;
    for (let i = 0; i < n; i++) {
      const t = twin.get(loop[i]);
      if (t === undefined) {
        valid = false;
        break;
      }
      if (t !== loop[i]) onPlane = false;
      // boucle inversée en conservant le premier sommet
      out[i === 0 ? 0 : n - i] = t;
    }
    // une face entièrement dans le plan de symétrie serait son propre double retourné
    if (!valid || onPlane) continue;
    faces.set(hashId(salt, 'f', fid), out);
  }
  return { verts, faces };
}
