import { edgeKey, edgeVerts, type MeshData } from '../../doc/schema';
import type { MeshOpResult, MeshSelection } from '../types';
import { chainBoundaryLoops, regionBoundaryEdges, selectionOfFaces } from '../topology';
import { emptyResult, isValidLoop, orphanVertsAfterRemoving } from './common';
import { loopHasEdge, WorkMesh } from './work';

const EMPTY_SELECT = (): { verts: string[]; edges: string[]; faces: string[] } => ({ verts: [], edges: [], faces: [] });

/**
 * Suppression (X) :
 *  - 'verts' : les sommets et toutes les faces qui les utilisent ;
 *  - 'edges' : les faces qui contiennent une des arêtes ;
 *  - 'faces' : les faces ;
 *  - 'only_faces' : les faces seulement (les sommets restent, même isolés).
 * Sauf pour 'only_faces', les sommets qui ne servent plus à aucune face sont supprimés.
 * `select` = sélection vide.
 */
export function deleteElements(mesh: MeshData, sel: MeshSelection, what: 'verts' | 'edges' | 'faces' | 'only_faces'): MeshOpResult {
  const delFaces = new Set<string>();
  const delVerts = new Set<string>();
  if (what === 'verts') {
    for (const v of sel.verts) if (mesh.verts.has(v)) delVerts.add(v);
    if (delVerts.size === 0) return emptyResult();
    for (const [f, loop] of mesh.faces) if (loop.some((v) => delVerts.has(v))) delFaces.add(f);
  } else if (what === 'edges') {
    const keys = new Set<string>();
    for (const k of sel.edges) keys.add(k);
    if (keys.size === 0) return emptyResult();
    for (const [f, loop] of mesh.faces) {
      for (let i = 0; i < loop.length; i++) {
        if (keys.has(edgeKey(loop[i], loop[(i + 1) % loop.length]))) {
          delFaces.add(f);
          break;
        }
      }
    }
  } else if (what === 'faces' || what === 'only_faces') {
    for (const f of sel.faces) if (mesh.faces.has(f)) delFaces.add(f);
  } else return emptyResult();
  if (what !== 'only_faces') for (const v of orphanVertsAfterRemoving(mesh, delFaces)) delVerts.add(v);
  if (delFaces.size === 0 && delVerts.size === 0) return emptyResult();
  const delta: MeshOpResult['delta'] = {};
  if (delFaces.size) delta.delFaces = [...delFaces];
  if (delVerts.size) delta.delVerts = [...delVerts];
  return { delta, select: EMPTY_SELECT() };
}

/** Retire les allers-retours (… a, b, a …) d'une boucle, puis les répétitions consécutives. */
function removeSpikes(loop: readonly string[]): string[] {
  let cur = loop.slice();
  let changed = true;
  while (changed && cur.length >= 3) {
    changed = false;
    // Répétitions consécutives.
    const d: string[] = [];
    for (const v of cur) if (d.length === 0 || d[d.length - 1] !== v) d.push(v);
    while (d.length > 1 && d[0] === d[d.length - 1]) d.pop();
    if (d.length !== cur.length) changed = true;
    cur = d;
    const n = cur.length;
    for (let i = 0; i < n && n >= 3; i++) {
      if (cur[i] === cur[(i + 2) % n]) {
        // cur[i+1] est la pointe : on retire la pointe et le doublon.
        const a = (i + 1) % n;
        const b = (i + 2) % n;
        cur = cur.filter((_, j) => j !== a && j !== b);
        changed = true;
        break;
      }
    }
  }
  return cur;
}

/** Contour unique d'une région de faces (orientation des faces), ou null s'il y en a plusieurs ou s'il est ambigu. */
function regionOutline(loops: readonly (readonly string[])[]): string[] | null {
  const chains = chainBoundaryLoops(regionBoundaryEdges(loops));
  if (!chains || chains.length !== 1) return null;
  return chains[0];
}

/** Sommets voisins (par arêtes) d'un sommet dans la copie de travail. */
function neighbors(work: WorkMesh, v: string): Set<string> {
  const out = new Set<string>();
  for (const f of work.facesOf(v)) {
    const loop = work.faces.get(f)!;
    const n = loop.length;
    for (let i = 0; i < n; i++) {
      if (loop[i] !== v) continue;
      out.add(loop[(i + 1) % n]);
      out.add(loop[(i + n - 1) % n]);
    }
  }
  out.delete(v);
  return out;
}

/** Retire un sommet de valence 2 des boucles qui l'utilisent ; refusé si une face tomberait sous 3 sommets. */
function dissolveValence2(work: WorkMesh, v: string): boolean {
  if (neighbors(work, v).size !== 2) return false;
  const faces = work.facesOf(v);
  if (faces.length === 0) return false;
  const next: [string, string[]][] = [];
  for (const f of faces) {
    const loop = work.faces.get(f)!.filter((x) => x !== v);
    if (!isValidLoop(loop)) return false;
    next.push([f, loop]);
  }
  for (const [f, loop] of next) work.setFace(f, loop);
  work.delVert(v);
  return true;
}

/** Fusionne des faces en une seule (contour unique), la première garde son identifiant. */
function mergeFaces(work: WorkMesh, faceIds: readonly string[], drop?: string): string | null {
  const loops = faceIds.map((f) => work.faces.get(f)).filter((l): l is string[] => !!l);
  if (loops.length !== faceIds.length || loops.length === 0) return null;
  let outline = regionOutline(loops);
  if (!outline) return null;
  if (drop !== undefined) outline = outline.filter((x) => x !== drop);
  outline = removeSpikes(outline);
  if (!isValidLoop(outline)) return null;
  const inner = new Set<string>();
  for (const l of loops) for (const v of l) inner.add(v);
  for (let i = 1; i < faceIds.length; i++) work.delFace(faceIds[i]);
  work.setFace(faceIds[0], outline);
  work.dropUnused(inner);
  return faceIds[0];
}

/**
 * Dissolution (Ctrl+X / menu) en conservant la surface :
 *  - 'edge' : chaque arête partagée par deux faces disparaît, les deux faces fusionnent ; les sommets
 *    de ses extrémités restés de valence 2 sont ensuite retirés des boucles ;
 *  - 'vert' : un sommet de valence 2 est retiré des boucles ; sinon les faces qui l'entourent sont
 *    fusionnées en une seule (le sommet disparaît) ;
 *  - 'face' : chaque région connexe de faces sélectionnées devient un seul n-gone (régions à trou ignorées).
 * Les cas impossibles sont ignorés. `select` = faces fusionnées en mode 'face', sélection vide sinon.
 */
export function dissolveElements(mesh: MeshData, sel: MeshSelection, mode: 'vert' | 'edge' | 'face'): MeshOpResult {
  const work = new WorkMesh(mesh);
  let select = EMPTY_SELECT();
  if (mode === 'edge') {
    const ends = new Set<string>();
    for (const k of sel.edges) {
      const [a, b] = edgeVerts(k);
      if (!work.verts.has(a) || !work.verts.has(b)) continue;
      const faces = work.edgeFaces(a, b);
      if (faces.length !== 2) continue;
      const [f1, f2] = faces;
      const l1 = work.faces.get(f1)!;
      const l2 = work.faces.get(f2)!;
      const d1 = loopHasEdge(l1, a, b);
      const d2 = loopHasEdge(l2, a, b);
      if (d1 === 0 || d2 === 0 || d1 === d2) continue;
      // f1 parcourt p → q, f2 parcourt q → p.
      const [p, q] = d1 === 1 ? [a, b] : [b, a];
      const i1 = l1.indexOf(q);
      const r1: string[] = [];
      for (let i = 0; i < l1.length; i++) r1.push(l1[(i1 + i) % l1.length]); // q … p
      const i2 = l2.indexOf(p);
      const r2: string[] = [];
      for (let i = 0; i < l2.length; i++) r2.push(l2[(i2 + i) % l2.length]); // p … q
      const merged = removeSpikes([...r1, ...r2.slice(1, r2.length - 1)]);
      if (!isValidLoop(merged)) continue;
      work.delFace(f2);
      work.setFace(f1, merged);
      ends.add(a);
      ends.add(b);
    }
    if (ends.size === 0) return emptyResult();
    for (const v of ends) {
      if (!work.verts.has(v)) continue;
      if (!work.isUsed(v)) {
        work.delVert(v);
        continue;
      }
      dissolveValence2(work, v);
    }
  } else if (mode === 'vert') {
    let any = false;
    for (const v of sel.verts) {
      if (!work.verts.has(v)) continue;
      if (!work.isUsed(v)) continue;
      if (dissolveValence2(work, v)) {
        any = true;
        continue;
      }
      const faces = work.facesOf(v);
      if (faces.length < 2) continue;
      if (mergeFaces(work, faces, v) !== null) {
        if (work.verts.has(v) && !work.isUsed(v)) work.delVert(v);
        any = true;
      }
    }
    if (!any) return emptyResult();
  } else if (mode === 'face') {
    const region = new Set<string>();
    for (const f of sel.faces) if (work.faces.has(f)) region.add(f);
    if (region.size === 0) return emptyResult();
    // Composantes connexes par arêtes partagées.
    const byEdge = new Map<string, string[]>();
    for (const f of region) {
      const loop = work.faces.get(f)!;
      for (let i = 0; i < loop.length; i++) {
        const k = edgeKey(loop[i], loop[(i + 1) % loop.length]);
        const l = byEdge.get(k);
        if (l) l.push(f);
        else byEdge.set(k, [f]);
      }
    }
    const seen = new Set<string>();
    const result = new Map<string, string[]>();
    for (const seed of region) {
      if (seen.has(seed)) continue;
      const comp: string[] = [];
      const stack = [seed];
      seen.add(seed);
      while (stack.length) {
        const f = stack.pop()!;
        comp.push(f);
        const loop = work.faces.get(f)!;
        for (let i = 0; i < loop.length; i++) {
          for (const g of byEdge.get(edgeKey(loop[i], loop[(i + 1) % loop.length])) ?? []) {
            if (!seen.has(g)) {
              seen.add(g);
              stack.push(g);
            }
          }
        }
      }
      if (comp.length < 2) continue;
      const id = mergeFaces(work, comp);
      if (id) result.set(id, work.faces.get(id)!);
    }
    if (result.size === 0) return emptyResult();
    select = selectionOfFaces(result);
  } else return emptyResult();
  return { delta: work.toDelta(), select };
}
