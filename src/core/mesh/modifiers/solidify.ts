import type { MeshData, SolidifyParams, Vec3 } from '../../doc/schema';
import { vertexNormals } from '../topology';
import { clamp, finiteOr, hashId } from './common';

/**
 * Donne une épaisseur à une surface : deux coques décalées le long des normales de sommets,
 * reliées par des parois sur les bords ouverts (le résultat est fermé).
 * `offset` : -1 = l'épaisseur part vers l'intérieur (la surface d'origine reste en place),
 * 0 = centrée, 1 = vers l'extérieur.
 */
export function solidifyModifier(mesh: MeshData, params: SolidifyParams, salt: string): MeshData {
  const thickness = finiteOr(params.thickness, 0.05);
  if (Math.abs(thickness) < 1e-9 || mesh.faces.size === 0) return mesh;
  const offset = clamp(finiteOr(params.offset, -1), -1, 1);
  // Décalages des deux coques le long de la normale ; la coque « extérieure » garde l'orientation d'origine.
  const d1 = (thickness * (offset + 1)) / 2;
  const d2 = (-thickness * (1 - offset)) / 2;
  const dOuter = Math.max(d1, d2);
  const dInner = Math.min(d1, d2);

  const normals = vertexNormals(mesh);
  const verts = new Map<string, Vec3>();
  const faces = new Map<string, string[]>();
  const inner = new Map<string, string>();
  for (const [id, p] of mesh.verts) {
    const n = normals.get(id);
    if (!n) {
      // sommet isolé : conservé tel quel
      verts.set(id, p);
      continue;
    }
    verts.set(id, dOuter === 0 ? p : [p[0] + n[0] * dOuter, p[1] + n[1] * dOuter, p[2] + n[2] * dOuter]);
  }
  for (const [id, p] of mesh.verts) {
    const n = normals.get(id);
    if (!n) continue;
    const nid = hashId(salt, 'i', id);
    inner.set(id, nid);
    verts.set(nid, [p[0] + n[0] * dInner, p[1] + n[1] * dInner, p[2] + n[2] * dInner]);
  }

  // Coque extérieure, coque intérieure retournée, et recensement des arêtes orientées.
  const directed = new Set<string>();
  const valid: [string, string[]][] = [];
  for (const [fid, loop] of mesh.faces) {
    const n = loop.length;
    let ok = n >= 3;
    for (let i = 0; ok && i < n; i++) if (!inner.has(loop[i])) ok = false;
    if (!ok) continue;
    valid.push([fid, loop]);
    faces.set(fid, loop);
    for (let i = 0; i < n; i++) directed.add(loop[i] + '|' + loop[(i + 1) % n]);
  }
  for (const [fid, loop] of valid) {
    const n = loop.length;
    const out = new Array<string>(n);
    for (let i = 0; i < n; i++) out[i === 0 ? 0 : n - i] = inner.get(loop[i])!;
    faces.set(hashId(salt, 'f', fid), out);
  }
  // Parois : une par arête de bord (arête orientée sans jumelle).
  for (const [, loop] of valid) {
    const n = loop.length;
    for (let i = 0; i < n; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % n];
      if (a === b || directed.has(b + '|' + a)) continue;
      faces.set(hashId(salt, 'r', a, b), [b, a, inner.get(a)!, inner.get(b)!]);
    }
  }
  return { verts, faces };
}
