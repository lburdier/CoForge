import { Box3, BufferAttribute, BufferGeometry, Sphere, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { RenderMesh } from '../core/mesh/types';

/**
 * Géométries three.js partagées, une par RenderMesh (donc partagées entre
 * objets qui affichent le même maillage évalué, ex. duplications liées).
 * Comptage de références : la géométrie est libérée quand plus personne ne l'utilise.
 *
 * Pour chaque entrée :
 *  - `surface` : BufferGeometry NON indexée (position + normal), utilisée par la scène rendue ;
 *  - `edges`   : arêtes polygonales (LineSegments) ;
 *  - `bvh`     : arbre d'accélération (three-mesh-bvh) construit à la demande, pour le picking ;
 *  - `hull`    : géométrie du contour de sélection (normales lissées par position), à la demande.
 * Les géométries auxiliaires partagent l'attribut position de `surface` mais restent
 * distinctes, pour que la géométrie rendue garde exactement les attributs du contrat.
 */
export interface GeoEntry {
  rm: RenderMesh;
  surface: BufferGeometry;
  edges: BufferGeometry;
  refs: number;
  bounds: Box3;
  sphere: Sphere;
  bvh: MeshBVH | null;
  pickGeom: BufferGeometry | null;
  hull: BufferGeometry | null;
  /** Normales de contour à recalculer (positions remplacées sur place depuis la dernière construction). */
  hullStale: boolean;
}

/**
 * Normales « de contour » : moyenne des normales de tous les sommets de triangle
 * qui partagent la même position (soudure par position quantifiée). Le contour
 * extrudé le long de ces normales reste continu même sur un maillage à ombrage plat.
 */
export function computeOutlineNormals(positions: Float32Array, normals: Float32Array): Float32Array {
  const n = positions.length / 3;
  const out = new Float32Array(positions.length);
  if (n === 0) return out;
  // Soudure par position quantifiée (1e-4 m) via une table de hachage numérique à adressage
  // ouvert : aucune chaîne de caractères (l'ancienne version à clés texte coûtait ~80 ms
  // sur 100 000 sommets).
  const Q = new Float64Array(n * 3);
  for (let i = 0; i < n * 3; i++) Q[i] = Math.round(positions[i] * 1e4);
  let size = 1;
  while (size < n * 2) size <<= 1;
  const mask = size - 1;
  const table = new Int32Array(size).fill(-1); // indice du sommet représentant du groupe
  const groupOf = new Int32Array(n);
  const repGroup = new Int32Array(n); // représentant → numéro de groupe
  let groups = 0;
  for (let i = 0; i < n; i++) {
    const qx = Q[i * 3];
    const qy = Q[i * 3 + 1];
    const qz = Q[i * 3 + 2];
    let h = (Math.imul(qx | 0, 73856093) ^ Math.imul(qy | 0, 19349663) ^ Math.imul(qz | 0, 83492791)) & mask;
    for (;;) {
      const r = table[h];
      if (r === -1) {
        table[h] = i;
        repGroup[i] = groups;
        groupOf[i] = groups++;
        break;
      }
      if (Q[r * 3] === qx && Q[r * 3 + 1] === qy && Q[r * 3 + 2] === qz) {
        groupOf[i] = repGroup[r];
        break;
      }
      h = (h + 1) & mask;
    }
  }
  // Membres de chaque groupe (CSR).
  const start = new Int32Array(groups + 1);
  for (let i = 0; i < n; i++) start[groupOf[i] + 1]++;
  for (let g = 0; g < groups; g++) start[g + 1] += start[g];
  const fill = start.slice(0, groups);
  const members = new Int32Array(n);
  for (let i = 0; i < n; i++) members[fill[groupOf[i]]++] = i;

  for (let g = 0; g < groups; g++) {
    const s = start[g];
    const e = start[g + 1];
    let x = 0;
    let y = 0;
    let z = 0;
    // une direction n'est comptée qu'une fois (les faces quadrangulaires produisent deux triangles)
    for (let k = s; k < e; k++) {
      const i = members[k];
      const nx = normals[i * 3];
      const ny = normals[i * 3 + 1];
      const nz = normals[i * 3 + 2];
      let dup = false;
      for (let j = s; j < k; j++) {
        const m = members[j];
        if (Math.abs(normals[m * 3] - nx) < 1e-4 && Math.abs(normals[m * 3 + 1] - ny) < 1e-4 && Math.abs(normals[m * 3 + 2] - nz) < 1e-4) {
          dup = true;
          break;
        }
      }
      if (dup) continue;
      x += nx;
      y += ny;
      z += nz;
    }
    const len = Math.hypot(x, y, z) || 1;
    for (let k = s; k < e; k++) {
      const i = members[k];
      out[i * 3] = x / len;
      out[i * 3 + 1] = y / len;
      out[i * 3 + 2] = z / len;
    }
  }
  return out;
}

export class GeometryPool {
  private map = new Map<RenderMesh, GeoEntry>();

  acquire(rm: RenderMesh): GeoEntry {
    let e = this.map.get(rm);
    if (!e) {
      const surface = new BufferGeometry();
      surface.setAttribute('position', new BufferAttribute(rm.positions, 3));
      surface.setAttribute('normal', new BufferAttribute(rm.normals, 3));
      surface.computeBoundingBox();
      surface.computeBoundingSphere();
      const edges = new BufferGeometry();
      edges.setAttribute('position', new BufferAttribute(rm.edgePositions, 3));
      edges.computeBoundingSphere();
      const bounds = surface.boundingBox ? surface.boundingBox.clone() : new Box3();
      if (rm.positions.length === 0 && rm.edgePositions.length > 0) bounds.setFromBufferAttribute(edges.getAttribute('position') as BufferAttribute);
      const sphere = bounds.isEmpty() ? new Sphere(new Vector3(), 0) : bounds.getBoundingSphere(new Sphere());
      e = { rm, surface, edges, refs: 0, bounds, sphere, bvh: null, pickGeom: null, hull: null, hullStale: false };
      this.map.set(rm, e);
    }
    e.refs++;
    return e;
  }

  /**
   * Remplace sur place le contenu d'une entrée non partagée par `rm` (même nombre de triangles
   * et d'arêtes : typiquement un déplacement de sommets). Évite de recréer les tampons GPU et les
   * VAO à chaque mouvement de souris. Renvoie l'entrée réutilisée, ou null si impossible.
   */
  replaceInPlace(entry: GeoEntry | null, rm: RenderMesh): GeoEntry | null {
    if (!entry || entry.refs !== 1 || this.map.has(rm)) return null;
    const old = entry.rm;
    if (old.positions.length !== rm.positions.length || old.edgePositions.length !== rm.edgePositions.length) return null;
    if (rm.positions.length === 0) return null;
    this.map.delete(old);
    entry.rm = rm;
    this.map.set(rm, entry);
    const pos = entry.surface.getAttribute('position') as BufferAttribute;
    const nrm = entry.surface.getAttribute('normal') as BufferAttribute;
    const epos = entry.edges.getAttribute('position') as BufferAttribute;
    (pos.array as Float32Array).set(rm.positions);
    (nrm.array as Float32Array).set(rm.normals);
    (epos.array as Float32Array).set(rm.edgePositions);
    pos.needsUpdate = true;
    nrm.needsUpdate = true;
    epos.needsUpdate = true;
    // Volumes englobants en une seule passe (computeBoundingSphere de three en fait deux) ;
    // la sphère dérivée de la boîte suffit au culling.
    const p = rm.positions;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    entry.bounds.min.set(minX, minY, minZ);
    entry.bounds.max.set(maxX, maxY, maxZ);
    if (entry.bounds.isEmpty()) {
      entry.sphere.center.set(0, 0, 0);
      entry.sphere.radius = 0;
    } else entry.bounds.getBoundingSphere(entry.sphere);
    (entry.surface.boundingBox ??= new Box3()).copy(entry.bounds);
    (entry.surface.boundingSphere ??= new Sphere()).copy(entry.sphere);
    (entry.edges.boundingSphere ??= new Sphere()).copy(entry.sphere);
    // Accélérations dérivées des positions : reconstruites au prochain besoin.
    entry.bvh = null;
    // pickGeom n'est jamais dessinée (aucune ressource GPU) : la libérer est sans risque.
    entry.pickGeom?.dispose();
    entry.pickGeom = null;
    // La coque PARTAGE l'attribut `position` de la surface : la libérer (dispose) supprimerait aussi
    // le tampon GPU de la surface, dont le VAO continuerait de pointer vers l'ancien tampon : la
    // surface resterait affichée avec ses anciennes positions (triangles manquants, contour visible
    // à travers les faces). On la garde et on recalcule ses normales au prochain besoin.
    if (entry.hull) entry.hullStale = true;
    return entry;
  }

  release(entry: GeoEntry | null): void {
    if (!entry) return;
    entry.refs--;
    if (entry.refs > 0) return;
    this.map.delete(entry.rm);
    disposeEntry(entry);
  }

  /** BVH de la surface (construit au premier besoin), null si la surface est vide. */
  bvh(entry: GeoEntry): MeshBVH | null {
    if (entry.bvh) return entry.bvh;
    if (entry.rm.positions.length < 9) return null;
    const g = new BufferGeometry();
    g.setAttribute('position', entry.surface.getAttribute('position'));
    try {
      entry.bvh = new MeshBVH(g);
      entry.pickGeom = g;
    } catch (err) {
      console.error('[engine] construction du BVH impossible', err);
      g.dispose();
      return null;
    }
    return entry.bvh;
  }

  /** Géométrie du contour de sélection. */
  hull(entry: GeoEntry): BufferGeometry {
    if (entry.hull && entry.hullStale) {
      const attr = entry.hull.getAttribute('outlineNormal') as BufferAttribute;
      (attr.array as Float32Array).set(computeOutlineNormals(entry.rm.positions, entry.rm.normals));
      attr.needsUpdate = true;
      (entry.hull.boundingSphere ??= new Sphere()).copy(entry.sphere);
      (entry.hull.boundingBox ??= new Box3()).copy(entry.bounds);
      entry.hullStale = false;
    }
    if (entry.hull) return entry.hull;
    const g = new BufferGeometry();
    g.setAttribute('position', entry.surface.getAttribute('position'));
    g.setAttribute('outlineNormal', new BufferAttribute(computeOutlineNormals(entry.rm.positions, entry.rm.normals), 3));
    g.boundingSphere = entry.sphere.clone();
    g.boundingBox = entry.bounds.clone();
    entry.hull = g;
    return g;
  }

  clear(): void {
    for (const e of this.map.values()) disposeEntry(e);
    this.map.clear();
  }
}

function disposeEntry(e: GeoEntry): void {
  e.surface.dispose();
  e.edges.dispose();
  e.pickGeom?.dispose();
  e.hull?.dispose();
  e.bvh = null;
  e.pickGeom = null;
  e.hull = null;
}
