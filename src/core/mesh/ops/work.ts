import type { MeshData, MeshDelta, Vec3 } from '../../doc/schema';
import { diffMesh } from '../topology';

/**
 * Copie de travail d'un maillage, modifiable, avec un index sommet → faces tenu à jour.
 * Les tableaux (positions, boucles) ne sont jamais modifiés en place : ils sont remplacés,
 * ce qui permet de partager ceux de l'instantané d'origine (copie superficielle) sans risque.
 * Usage interne aux opérations : on modifie la copie puis on en déduit le delta.
 */
export class WorkMesh {
  readonly verts: Map<string, Vec3>;
  readonly faces: Map<string, string[]>;
  private readonly vf = new Map<string, Set<string>>();

  constructor(private readonly source: MeshData) {
    this.verts = new Map(source.verts);
    this.faces = new Map(source.faces);
    for (const [fid, loop] of this.faces) for (const v of loop) this.link(v, fid);
  }

  private link(v: string, fid: string): void {
    let s = this.vf.get(v);
    if (!s) this.vf.set(v, (s = new Set()));
    s.add(fid);
  }

  /** Faces qui utilisent le sommet `v`. */
  facesOf(v: string): string[] {
    const s = this.vf.get(v);
    return s ? [...s] : [];
  }

  /** Le sommet est-il encore utilisé par au moins une face ? */
  isUsed(v: string): boolean {
    const s = this.vf.get(v);
    return !!s && s.size > 0;
  }

  /** Faces dont la boucle contient l'arête a–b (dans un sens ou dans l'autre). */
  edgeFaces(a: string, b: string): string[] {
    const out: string[] = [];
    for (const f of this.vf.get(a) ?? []) {
      const loop = this.faces.get(f);
      if (loop && loopHasEdge(loop, a, b) !== 0) out.push(f);
    }
    return out;
  }

  /** Face qui parcourt l'arête orientée a → b, ou undefined. */
  directedFace(a: string, b: string): string | undefined {
    for (const f of this.vf.get(a) ?? []) {
      const loop = this.faces.get(f);
      if (loop && loopHasEdge(loop, a, b) === 1) return f;
    }
    return undefined;
  }

  setFace(id: string, loop: string[]): void {
    this.delFace(id);
    this.faces.set(id, loop);
    for (const v of loop) this.link(v, id);
  }

  delFace(id: string): void {
    const old = this.faces.get(id);
    if (!old) return;
    this.faces.delete(id);
    for (const v of old) this.vf.get(v)?.delete(id);
  }

  setVert(id: string, p: Vec3): void {
    this.verts.set(id, p);
  }

  /** Supprime un sommet et toutes les faces qui l'utilisent. */
  delVert(id: string): void {
    for (const f of this.facesOf(id)) this.delFace(f);
    this.verts.delete(id);
    this.vf.delete(id);
  }

  /** Supprime les sommets de la liste qui ne sont plus utilisés par aucune face. */
  dropUnused(candidates: Iterable<string>): void {
    for (const v of candidates) if (this.verts.has(v) && !this.isUsed(v)) this.delVert(v);
  }

  /** Delta qui transforme le maillage d'origine en l'état courant. */
  toDelta(): MeshDelta {
    return diffMesh(this.source, this);
  }
}

/** 1 si la boucle parcourt a → b, -1 si elle parcourt b → a, 0 si l'arête n'y figure pas. */
export function loopHasEdge(loop: readonly string[], a: string, b: string): number {
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    if (loop[i] !== a) continue;
    if (loop[(i + 1) % n] === b) return 1;
    if (loop[(i + n - 1) % n] === b) return -1;
  }
  return 0;
}

/**
 * Insère `ids` (ordonnés de a vers b) entre a et b dans une boucle qui contient l'arête a–b.
 * Renvoie la boucle inchangée si l'arête n'y figure pas.
 */
export function insertOnEdge(loop: readonly string[], a: string, b: string, ids: readonly string[]): string[] {
  const dir = loopHasEdge(loop, a, b);
  if (dir === 0 || ids.length === 0) return loop.slice();
  const n = loop.length;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const v = loop[i];
    out.push(v);
    const w = loop[(i + 1) % n];
    if (dir === 1 && v === a && w === b) out.push(...ids);
    else if (dir === -1 && v === b && w === a) for (let k = ids.length - 1; k >= 0; k--) out.push(ids[k]);
  }
  return out;
}

/**
 * Découpe une boucle contenant des sommets répétés en sous-boucles sans répétition
 * (l'orientation est conservée). Les sous-boucles de moins de 3 sommets sont écartées.
 */
export function splitLoop(loop: readonly string[]): string[][] {
  const out: string[][] = [];
  const stack: string[] = [];
  const pos = new Map<string, number>();
  for (const v of loop) {
    const j = pos.get(v);
    if (j !== undefined) {
      const sub = stack.splice(j + 1);
      for (const x of sub) pos.delete(x);
      const piece = [v, ...sub];
      if (piece.length >= 3) out.push(piece);
    } else {
      pos.set(v, stack.length);
      stack.push(v);
    }
  }
  if (stack.length >= 3) out.push(stack);
  return out;
}

/** Clé indépendante du sommet de départ et du sens : sert à repérer les faces en double. */
export function loopSetKey(loop: readonly string[]): string {
  return [...loop].sort().join(',');
}

/** Rotation canonique d'une boucle (commence par le plus petit identifiant), sens conservé. */
export function canonicalLoop(loop: readonly string[]): string {
  let m = 0;
  for (let i = 1; i < loop.length; i++) if (loop[i] < loop[m]) m = i;
  const out: string[] = [];
  for (let i = 0; i < loop.length; i++) out.push(loop[(m + i) % loop.length]);
  return out.join(',');
}

/**
 * Groupes de coins d'une région de faces : autour de chaque sommet, les faces de la région reliées
 * entre elles par une arête incidente au sommet forment un groupe. Un sommet où la région ne se touche
 * que par un point (sommet « pincé ») a plusieurs groupes. Renvoie la clé de duplication d'un coin
 * (sommet, face) : `v` s'il n'y a qu'un groupe, `v#g` sinon.
 */
export function regionCornerKeys(region: ReadonlyMap<string, readonly string[]>): (v: string, fid: string) => string {
  const vf = new Map<string, string[]>();
  for (const [f, loop] of region) {
    for (const v of loop) {
      const l = vf.get(v);
      if (l) l.push(f);
      else vf.set(v, [f]);
    }
  }
  const keys = new Map<string, string>();
  for (const [v, fs] of vf) {
    if (fs.length < 2) continue;
    const parent = new Map<string, string>();
    for (const f of fs) parent.set(f, f);
    const find = (f: string): string => {
      while (parent.get(f) !== f) f = parent.get(f)!;
      return f;
    };
    const byNeighbor = new Map<string, string>();
    for (const f of fs) {
      const loop = region.get(f)!;
      const n = loop.length;
      const i = loop.indexOf(v);
      for (const x of [loop[(i + 1) % n], loop[(i + n - 1) % n]]) {
        const g = byNeighbor.get(x);
        if (g === undefined) byNeighbor.set(x, f);
        else parent.set(find(f), find(g));
      }
    }
    const roots = new Map<string, number>();
    for (const f of fs) {
      const r = find(f);
      if (!roots.has(r)) roots.set(r, roots.size);
    }
    if (roots.size < 2) continue;
    for (const f of fs) keys.set(v + '\u0000' + f, `${v}#${roots.get(find(f))}`);
  }
  return (v, fid) => keys.get(v + '\u0000' + fid) ?? v;
}
