import type { ArrayParams, MeshData, Vec3 } from '../../doc/schema';
import { meshBounds } from '../topology';
import { clamp, finiteOr, hashId } from './common';

/** Nombre maximal de copies et de faces produites (garde-fou contre un paramètre aberrant). */
const MAX_COUNT = 1000;
const MAX_FACES = 2_000_000;

/**
 * Réseau linéaire : `count` exemplaires, chacun décalé du précédent de
 * `relative` × taille de la boîte englobante + `constant`.
 */
export function arrayModifier(mesh: MeshData, params: ArrayParams, salt: string): MeshData {
  let count = clamp(Math.round(finiteOr(params.count, 2)), 1, MAX_COUNT);
  if (mesh.faces.size > 0) count = Math.max(1, Math.min(count, Math.floor(MAX_FACES / mesh.faces.size)));
  const bounds = meshBounds(mesh);
  if (count <= 1 || !bounds) return mesh;
  const rel = params.relative ?? [1, 0, 0];
  const cst = params.constant ?? [0, 0, 0];
  const step: Vec3 = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    step[a] = finiteOr(rel[a], 0) * (bounds.max[a] - bounds.min[a]) + finiteOr(cst[a], 0);
  }
  const verts = new Map<string, Vec3>(mesh.verts);
  const faces = new Map<string, string[]>(mesh.faces);
  const ids = new Map<string, string>();
  for (let k = 1; k < count; k++) {
    const s = salt + ':' + k;
    const dx = step[0] * k;
    const dy = step[1] * k;
    const dz = step[2] * k;
    ids.clear();
    for (const [id, p] of mesh.verts) {
      const nid = hashId(s, 'v', id);
      ids.set(id, nid);
      verts.set(nid, [p[0] + dx, p[1] + dy, p[2] + dz]);
    }
    for (const [fid, loop] of mesh.faces) {
      const out = new Array<string>(loop.length);
      let valid = true;
      for (let i = 0; i < loop.length; i++) {
        const m = ids.get(loop[i]);
        if (m === undefined) {
          valid = false;
          break;
        }
        out[i] = m;
      }
      if (valid) faces.set(hashId(s, 'f', fid), out);
    }
  }
  return { verts, faces };
}
