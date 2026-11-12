import { edgeKey, edgeVerts, type MeshData } from '../doc/schema';
import type { MeshSelection } from './types';
import { buildTopology, type Topology } from './topology';

export type SelectMode = 'vert' | 'edge' | 'face';

/** Sélection sous forme d'ensembles modifiables (compatible avec MeshSelection). */
export interface SelectionSets {
  verts: Set<string>;
  edges: Set<string>;
  faces: Set<string>;
}

export function emptySelection(): SelectionSets {
  return { verts: new Set(), edges: new Set(), faces: new Set() };
}

/** Sommets couverts par la sélection, lue selon le mode (sommets, extrémités des arêtes ou sommets des faces). */
export function selectionToVerts(mesh: MeshData, sel: MeshSelection, mode: SelectMode): Set<string> {
  const out = new Set<string>();
  if (mode === 'vert') {
    for (const v of sel.verts) if (mesh.verts.has(v)) out.add(v);
  } else if (mode === 'edge') {
    for (const e of sel.edges) {
      const [a, b] = edgeVerts(e);
      if (mesh.verts.has(a) && mesh.verts.has(b)) {
        out.add(a);
        out.add(b);
      }
    }
  } else {
    for (const f of sel.faces) for (const v of mesh.faces.get(f) ?? []) out.add(v);
  }
  return out;
}

/**
 * Sélection complète et cohérente déduite d'éléments d'un seul type :
 *  - 'vert' : sommets → arêtes dont les 2 sommets sont sélectionnés → faces dont tous les sommets le sont ;
 *  - 'edge' : arêtes (clés) → leurs sommets → faces dont toutes les arêtes sont sélectionnées ;
 *  - 'face' : faces → leurs sommets et leurs arêtes.
 * Les éléments inexistants sont ignorés.
 */
export function expandSelection(mesh: MeshData, elements: Iterable<string>, mode: SelectMode = 'vert'): SelectionSets {
  const out = emptySelection();
  if (mode === 'face') {
    for (const f of elements) {
      const loop = mesh.faces.get(f);
      if (!loop) continue;
      out.faces.add(f);
      for (let i = 0; i < loop.length; i++) {
        out.verts.add(loop[i]);
        out.edges.add(edgeKey(loop[i], loop[(i + 1) % loop.length]));
      }
    }
    return out;
  }
  if (mode === 'edge') {
    const wanted = new Set(elements);
    for (const [f, loop] of mesh.faces) {
      let all = true;
      for (let i = 0; i < loop.length; i++) {
        const k = edgeKey(loop[i], loop[(i + 1) % loop.length]);
        if (wanted.has(k)) {
          out.edges.add(k);
          out.verts.add(loop[i]);
          out.verts.add(loop[(i + 1) % loop.length]);
        } else all = false;
      }
      if (all) out.faces.add(f);
    }
    return out;
  }
  for (const v of elements) if (mesh.verts.has(v)) out.verts.add(v);
  for (const [f, loop] of mesh.faces) {
    let all = true;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      if (!out.verts.has(a)) all = false;
      else if (out.verts.has(b)) out.edges.add(edgeKey(a, b));
    }
    if (all) out.faces.add(f);
  }
  return out;
}

/** Tous les sommets touchés par une sélection, quel que soit le type d'élément. */
function allSelectedVerts(mesh: MeshData, sel: MeshSelection): Set<string> {
  const out = selectionToVerts(mesh, sel, 'vert');
  for (const v of selectionToVerts(mesh, sel, 'edge')) out.add(v);
  for (const v of selectionToVerts(mesh, sel, 'face')) out.add(v);
  return out;
}

/** Ctrl+L : étend la sélection à toutes les parties connexes qu'elle touche. */
export function selectLinked(mesh: MeshData, sel: MeshSelection): SelectionSets {
  const topo = buildTopology(mesh);
  const verts = new Set<string>();
  const stack = [...allSelectedVerts(mesh, sel)];
  while (stack.length) {
    const v = stack.pop()!;
    if (verts.has(v)) continue;
    verts.add(v);
    for (const n of topo.vertNeighbors.get(v) ?? []) if (!verts.has(n)) stack.push(n);
  }
  return expandSelection(mesh, verts, 'vert');
}

/** Ctrl+Num+ : ajoute les sommets des faces qui touchent la sélection. */
export function selectMore(mesh: MeshData, sel: MeshSelection): SelectionSets {
  const cur = allSelectedVerts(mesh, sel);
  const verts = new Set(cur);
  for (const loop of mesh.faces.values()) {
    let touch = false;
    for (const v of loop) {
      if (cur.has(v)) {
        touch = true;
        break;
      }
    }
    if (touch) for (const v of loop) verts.add(v);
  }
  return expandSelection(mesh, verts, 'vert');
}

/** Ctrl+Num- : retire les sommets situés en bordure de la sélection. */
export function selectLess(mesh: MeshData, sel: MeshSelection): SelectionSets {
  const cur = allSelectedVerts(mesh, sel);
  const drop = new Set<string>();
  for (const loop of mesh.faces.values()) {
    let hasUnselected = false;
    for (const v of loop) {
      if (!cur.has(v)) {
        hasUnselected = true;
        break;
      }
    }
    if (hasUnselected) for (const v of loop) drop.add(v);
  }
  const verts = new Set<string>();
  for (const v of cur) if (!drop.has(v)) verts.add(v);
  return expandSelection(mesh, verts, 'vert');
}

/**
 * Boucle d'arêtes passant par `key` (Alt+clic) : traverse les sommets de valence 4 en prenant
 * l'arête « d'en face », s'arrête aux pôles et aux bords. Sur une arête de bord, suit le bord.
 * Renvoie les clés dans l'ordre de parcours (liste vide si l'arête n'existe pas).
 */
export function edgeLoop(mesh: MeshData, key: string, topo: Topology = buildTopology(mesh)): string[] {
  if (!topo.edges.has(key)) return [];
  const [a0, b0] = topo.edges.get(key)!;
  const facesOf = (k: string) => topo.edgeFaces.get(k) ?? [];
  const isBoundary = facesOf(key).length === 1;

  const step = (cur: string, via: string): string | null => {
    const others = (topo.vertEdges.get(via) ?? []).filter((k) => k !== cur);
    if (isBoundary) {
      const b = others.filter((k) => facesOf(k).length === 1);
      return b.length === 1 ? b[0] : null;
    }
    if (others.length !== 3 || facesOf(cur).length !== 2) return null;
    const curFaces = facesOf(cur);
    const cand = others.filter((k) => !facesOf(k).some((f) => curFaces.includes(f)));
    if (cand.length !== 1 || facesOf(cand[0]).length !== 2) return null;
    return cand[0];
  };

  const visited = new Set<string>([key]);
  const walk = (startVia: string): { list: string[]; closed: boolean } => {
    const list: string[] = [];
    let cur = key;
    let via = startVia;
    for (let guard = 0; guard <= topo.edges.size; guard++) {
      const nxt = step(cur, via);
      if (!nxt) break;
      if (nxt === key) return { list, closed: true };
      if (visited.has(nxt)) break;
      visited.add(nxt);
      list.push(nxt);
      const [x, y] = topo.edges.get(nxt)!;
      via = x === via ? y : x;
      cur = nxt;
    }
    return { list, closed: false };
  };
  const fwd = walk(b0);
  if (fwd.closed) return [key, ...fwd.list];
  const back = walk(a0);
  return [...back.list.reverse(), key, ...fwd.list];
}

/** Anneau d'arêtes orienté : arêtes (a → b) toutes orientées dans le même sens à travers les quads. */
export interface OrientedRing {
  /** Arêtes de l'anneau, orientées de façon cohérente. */
  edges: [string, string][];
  /** faces[i] est le quad situé entre edges[i] et edges[i + 1] (ou edges[0] pour la dernière face d'un anneau fermé). */
  faces: string[];
  closed: boolean;
}

/** Parcours de l'anneau d'arêtes à travers les quads, avec orientation cohérente. Null si l'arête n'existe pas. */
export function walkEdgeRing(mesh: MeshData, key: string, topo: Topology = buildTopology(mesh)): OrientedRing | null {
  const start = topo.edges.get(key);
  if (!start) return null;
  const usedFaces = new Set<string>();
  const usedEdges = new Set<string>([key]);

  /** Arête opposée à (a → b) dans le quad `fid`, orientée dans le même sens ; null si ce n'est pas un quad. */
  const across = (fid: string, a: string, b: string): [string, string] | null => {
    const loop = mesh.faces.get(fid);
    if (!loop || loop.length !== 4) return null;
    for (let i = 0; i < 4; i++) {
      const p = loop[i];
      const q = loop[(i + 1) % 4];
      if (p === a && q === b) return [loop[(i + 3) % 4], loop[(i + 2) % 4]];
      if (p === b && q === a) return [loop[(i + 2) % 4], loop[(i + 3) % 4]];
    }
    return null;
  };

  const walk = (firstFace: string | undefined): { edges: [string, string][]; faces: string[]; closed: boolean } => {
    const edges: [string, string][] = [];
    const faces: string[] = [];
    let cur: [string, string] = [start[0], start[1]];
    let face = firstFace;
    for (let guard = 0; guard <= mesh.faces.size; guard++) {
      if (!face || usedFaces.has(face)) break;
      const opp = across(face, cur[0], cur[1]);
      if (!opp) break;
      const k = edgeKey(opp[0], opp[1]);
      if (k === key) {
        usedFaces.add(face);
        faces.push(face);
        return { edges, faces, closed: true };
      }
      if (usedEdges.has(k)) break;
      usedFaces.add(face);
      usedEdges.add(k);
      faces.push(face);
      edges.push(opp);
      const ef: string[] = topo.edgeFaces.get(k) ?? [];
      const from: string = face;
      face = ef.length === 2 ? (ef[0] === from ? ef[1] : ef[0]) : undefined;
      cur = opp;
    }
    return { edges, faces, closed: false };
  };

  const ef = topo.edgeFaces.get(key) ?? [];
  const manifold = ef.length <= 2;
  const fwd = walk(manifold ? ef[0] : undefined);
  if (fwd.closed) return { edges: [[start[0], start[1]], ...fwd.edges], faces: fwd.faces, closed: true };
  const back = walk(manifold ? ef[1] : undefined);
  return {
    edges: [...back.edges.reverse(), [start[0], start[1]], ...fwd.edges],
    faces: [...back.faces.reverse(), ...fwd.faces],
    closed: false,
  };
}

/**
 * Anneau d'arêtes passant par `key` (Ctrl+Alt+clic, base de la coupe en boucle) :
 * arêtes « parallèles » reliées par des quads, dans l'ordre, et indication de fermeture.
 */
export function edgeRing(mesh: MeshData, key: string, topo?: Topology): { edges: string[]; faces: string[]; closed: boolean } {
  const ring = walkEdgeRing(mesh, key, topo);
  if (!ring) return { edges: [], faces: [], closed: false };
  return { edges: ring.edges.map(([a, b]) => edgeKey(a, b)), faces: ring.faces, closed: ring.closed };
}

/** Boucle de faces : les quads traversés par l'anneau d'arêtes de `key`. */
export function faceLoop(mesh: MeshData, key: string, topo?: Topology): string[] {
  return edgeRing(mesh, key, topo).faces;
}
