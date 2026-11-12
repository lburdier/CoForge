import { edgeKey, type BevelParams, type MeshData, type Vec3 } from '../../doc/schema';
import { newellNormal, loopPositions } from '../topology';
import { add, cross, dot, length, normalize, scale, sub } from '../vec';
import { cleanLoop, clamp, finiteOr, hashId } from './common';

/** Nombre maximal de segments du profil (garde-fou). */
const MAX_SEGMENTS = 32;
/** Part maximale d'une arête qu'un décalage peut consommer à chacune de ses extrémités. */
const MAX_EDGE_SHARE = 0.49;

/** Coin d'une face autour d'un sommet : la face et ses voisins dans la boucle (prev → v → next). */
interface Corner {
  face: string;
  prev: string;
  next: string;
}

/** Éventail des faces autour d'un sommet, dans l'ordre (le coin i+1 suit le coin i à travers l'arête (v, corner[i].next)). */
interface Fan {
  corners: Corner[];
  closed: boolean;
}

/** Arête biseautée : F1 parcourt a → b, F2 parcourt b → a. */
interface BevEdge {
  key: string;
  a: string;
  b: string;
  f1: string;
  f2: string;
}

/**
 * Biseau des arêtes vives : chaque arête dont l'angle entre ses deux faces dépasse `angleLimit`
 * est remplacée par une bande de `segments` quads suivant un profil arrondi (ellipse tangente aux
 * deux faces ; un arc de cercle pour un angle droit). Les faces voisines sont rognées de `width`.
 * Aux sommets, le trou laissé par les bandes est rebouché (polygone unique, ou secteurs autour d'un
 * point central arrondi quand trois bandes ou plus s'y rejoignent) : le résultat reste fermé.
 * La largeur est réduite automatiquement si elle ferait se chevaucher deux biseaux.
 * Les arêtes de bord, non-manifold ou d'orientation incohérente ne sont jamais biseautées.
 */
export function bevelModifier(mesh: MeshData, params: BevelParams, salt: string): MeshData {
  const width = finiteOr(params.width, 0.02);
  const segments = clamp(Math.round(finiteOr(params.segments, 2)), 1, MAX_SEGMENTS);
  const angleLimit = clamp(finiteOr(params.angleLimit, 30), 0, 180);
  if (!(width > 1e-9) || mesh.faces.size === 0) return mesh;

  // ---------------------------------------------------------------- faces valides et normales
  const faces = new Map<string, string[]>();
  const faceN = new Map<string, Vec3>();
  for (const [fid, loop] of mesh.faces) {
    if (loop.length < 3) continue;
    let ok = new Set(loop).size === loop.length;
    for (const v of loop) if (!mesh.verts.has(v)) ok = false;
    if (!ok) continue;
    faces.set(fid, loop);
    faceN.set(fid, normalize(newellNormal(loopPositions(mesh, loop)), [0, 0, 1]));
  }
  const P = (v: string): Vec3 => mesh.verts.get(v)!;

  // ---------------------------------------------------------------- coins par sommet et arêtes orientées
  const cornersOf = new Map<string, Corner[]>();
  /** Arête orientée « a|b » → faces qui la parcourent dans ce sens. */
  const directed = new Map<string, string[]>();
  for (const [fid, loop] of faces) {
    const n = loop.length;
    for (let i = 0; i < n; i++) {
      const v = loop[i];
      const c: Corner = { face: fid, prev: loop[(i + n - 1) % n], next: loop[(i + 1) % n] };
      const l = cornersOf.get(v);
      if (l) l.push(c);
      else cornersOf.set(v, [c]);
      const dk = v + '|' + c.next;
      const d = directed.get(dk);
      if (d) d.push(fid);
      else directed.set(dk, [fid]);
    }
  }

  // ---------------------------------------------------------------- éventails simples
  const fans = new Map<string, Fan>();
  for (const [v, list] of cornersOf) {
    const fan = buildFan(list);
    if (fan) fans.set(v, fan);
  }

  // ---------------------------------------------------------------- arêtes à biseauter
  const cosLimit = Math.cos((angleLimit * Math.PI) / 180);
  const bev = new Map<string, BevEdge>();
  for (const [dk, fl] of directed) {
    if (fl.length !== 1) continue;
    const i = dk.indexOf('|');
    const a = dk.slice(0, i);
    const b = dk.slice(i + 1);
    if (!(a < b)) continue; // chaque arête une seule fois, depuis le sens a < b
    const back = directed.get(b + '|' + a);
    if (!back || back.length !== 1) continue;
    const f1 = fl[0];
    const f2 = back[0];
    if (f1 === f2) continue;
    if (!fans.has(a) || !fans.has(b)) continue;
    const d = dot(faceN.get(f1)!, faceN.get(f2)!);
    // angle entre faces > limite ⇔ cos(angle) < cos(limite) ; une limite de 0° biseaute toute arête non plane
    if (angleLimit <= 0 ? d < 1 - 1e-9 : d < cosLimit - 1e-12) bev.set(edgeKey(a, b), { key: edgeKey(a, b), a, b, f1, f2 });
  }
  if (bev.size === 0) return mesh;
  const isBev = (v: string, w: string) => bev.has(edgeKey(v, w));

  // ---------------------------------------------------------------- géométrie aux sommets (pour une largeur unité)
  /** Sommets concernés (au moins une arête biseautée). */
  const bevVerts: string[] = [];
  for (const [v, fan] of fans) {
    let any = false;
    for (const c of fan.corners) if (isBev(v, c.next) || isBev(v, c.prev)) any = true;
    if (any) bevVerts.push(v);
  }

  /** Déplacement (pour width = 1) du point de coin d'une face dont les deux arêtes au sommet sont biseautées : clé face|v. */
  const cornerDisp = new Map<string, Vec3>();
  /** Glissements le long d'une arête non biseautée : clé v|autre → somme des distances demandées et leur nombre. */
  const slideAcc = new Map<string, { sum: number; n: number }>();
  /** Longueur minimale des arêtes touchées par un décalage, par sommet (pour la limitation de largeur). */
  let maxScale = Infinity;

  const unitDir = (v: string, w: string): Vec3 => normalize(sub(P(w), P(v)), [1, 0, 0]);
  const edgeLen = (v: string, w: string): number => length(sub(P(w), P(v)));
  const requestSlide = (v: string, along: string, dist: number) => {
    const k = v + '|' + along;
    const s = slideAcc.get(k);
    if (s) {
      s.sum += dist;
      s.n++;
    } else slideAcc.set(k, { sum: dist, n: 1 });
  };

  for (const v of bevVerts) {
    const fan = fans.get(v)!;
    for (const c of fan.corners) {
      const bA = isBev(v, c.prev);
      const bB = isBev(v, c.next);
      if (!bA && !bB) continue;
      const n = faceN.get(c.face)!;
      const dA = unitDir(v, c.prev);
      const dB = unitDir(v, c.next);
      // Perpendiculaires intérieures (dans le plan de la face) aux arêtes prev → v et v → next.
      const inA = normalize(cross(dA, n), [0, 0, 0]);
      const inB = normalize(cross(n, dB), [0, 0, 0]);
      const lenMin = Math.min(edgeLen(v, c.prev), edgeLen(v, c.next));
      if (bA && bB) {
        const cc = dot(inA, inB);
        const x = scale(add(inA, inB), 1 / Math.max(1 + cc, 0.1));
        cornerDisp.set(c.face + '|' + v, x);
        const m = length(x);
        if (m > 1e-12) maxScale = Math.min(maxScale, (MAX_EDGE_SHARE * lenMin) / m);
      } else if (bA) {
        // point sur l'arête v → next à distance unité de la droite de l'arête biseautée prev → v
        const t = 1 / Math.max(dot(dB, inA), 0.25);
        requestSlide(v, c.next, t);
      } else {
        const t = 1 / Math.max(dot(dA, inB), 0.25);
        requestSlide(v, c.prev, t);
      }
    }
  }
  for (const [k, s] of slideAcc) {
    const i = k.indexOf('|');
    const t = s.sum / s.n;
    const l = edgeLen(k.slice(0, i), k.slice(i + 1));
    if (t > 1e-12) maxScale = Math.min(maxScale, (MAX_EDGE_SHARE * l) / t);
  }
  const w = Math.min(width, maxScale);
  if (!(w > 1e-9)) return mesh;

  // ---------------------------------------------------------------- nouveaux points
  const outVerts = new Map<string, Vec3>();
  const slideId = (v: string, along: string) => hashId(salt, 's', v, along);
  const cornerId = (face: string, v: string) => hashId(salt, 'c', face, v);
  for (const [k, s] of slideAcc) {
    const i = k.indexOf('|');
    const v = k.slice(0, i);
    const along = k.slice(i + 1);
    outVerts.set(slideId(v, along), add(P(v), scale(unitDir(v, along), (s.sum / s.n) * w)));
  }
  for (const [k, x] of cornerDisp) {
    const i = k.indexOf('|');
    const face = k.slice(0, i);
    const v = k.slice(i + 1);
    outVerts.set(cornerId(face, v), add(P(v), scale(x, w)));
  }

  /** Séquence remplaçant le coin `c` (sommet v) dans sa face, dans le sens de la face. */
  const cornerSeq = (v: string, c: Corner): string[] => {
    const bA = isBev(v, c.prev);
    const bB = isBev(v, c.next);
    if (bA && bB) return [cornerId(c.face, v)];
    if (bA) return [slideId(v, c.next)];
    if (bB) return [slideId(v, c.prev)];
    const out: string[] = [];
    if (slideAcc.has(v + '|' + c.prev)) out.push(slideId(v, c.prev));
    out.push(v);
    if (slideAcc.has(v + '|' + c.next)) out.push(slideId(v, c.next));
    return out;
  };
  /** Extrémité de bande du coin `c` (un seul point, car l'une au moins de ses arêtes est biseautée). */
  const endPoint = (v: string, c: Corner): string => cornerSeq(v, c)[0];

  // ---------------------------------------------------------------- profils aux extrémités des arêtes biseautées
  const profiles = new Map<string, string[]>(); // clé arête|v → points de F1 vers F2 (segments + 1)
  const arcCenters = new Map<string, Vec3[]>(); // v → centres des profils qui y aboutissent
  const cornerOfFace = (v: string, face: string): Corner | null => {
    for (const c of fans.get(v)!.corners) if (c.face === face) return c;
    return null;
  };
  for (const e of bev.values()) {
    for (const v of [e.a, e.b]) {
      const c1 = cornerOfFace(v, e.f1);
      const c2 = cornerOfFace(v, e.f2);
      if (!c1 || !c2) continue;
      const L = endPoint(v, c1);
      const R = endPoint(v, c2);
      const pl = outVerts.get(L)!;
      const pr = outVerts.get(R)!;
      // point de l'arête d'origine en regard du profil
      const other = v === e.a ? e.b : e.a;
      const d = unitDir(v, other);
      const mid = scale(add(pl, pr), 0.5);
      const E = add(P(v), scale(d, dot(sub(mid, P(v)), d)));
      const u = sub(pl, E);
      const vv = sub(pr, E);
      const O = add(E, add(u, vv));
      const ids: string[] = [L];
      for (let j = 1; j < segments; j++) {
        const th = ((j / segments) * Math.PI) / 2;
        const id = hashId(salt, 'p', e.key, v, j);
        outVerts.set(id, sub(sub(O, scale(vv, Math.cos(th))), scale(u, Math.sin(th))));
        ids.push(id);
      }
      ids.push(R);
      profiles.set(e.key + '|' + v, ids);
      const ac = arcCenters.get(v);
      if (ac) ac.push(O);
      else arcCenters.set(v, [O]);
    }
  }

  // ---------------------------------------------------------------- faces d'origine rognées
  const outFaces = new Map<string, string[]>();
  const bevVertSet = new Set(bevVerts);
  /** Faces dont un coin est remplacé par un polygone de rebouchage fusionné : clé face|v → séquence. */
  const mergedCorner = new Map<string, string[]>();
  const holeFaces: [string, string[]][] = [];

  // Rebouchage des sommets (calculé avant la réécriture des faces, car il peut fusionner dans une face).
  for (const v of bevVerts) {
    const fan = fans.get(v)!;
    const k = fan.corners.length;
    const seq: string[] = [];
    const spoke: boolean[] = [];
    /** Indice (dans seq) du sommet v pour chaque coin qui le conserve. */
    const vOwner: number[] = [];
    let mBev = 0;
    const push = (id: string, isSpoke: boolean, ownerCorner = -1) => {
      if (seq.length > 0 && seq[seq.length - 1] === id) {
        if (isSpoke) spoke[spoke.length - 1] = true;
        return;
      }
      seq.push(id);
      spoke.push(isSpoke);
      vOwner.push(ownerCorner);
    };
    for (let i = 0; i < k; i++) {
      const c = fan.corners[i];
      for (const id of cornerSeq(v, c)) push(id, false, id === v ? i : -1);
      if (!fan.closed && i === k - 1) break;
      if (isBev(v, c.next)) {
        mBev++;
        const e = bev.get(edgeKey(v, c.next))!;
        const prof = profiles.get(e.key + '|' + v);
        if (!prof) continue;
        const pts = e.f1 === c.face ? prof : prof.slice().reverse();
        for (let j = 1; j < segments; j++) {
          const isSpoke = segments % 2 === 0 ? j === segments / 2 : j === (segments - 1) / 2 || j === (segments + 1) / 2;
          push(pts[j], isSpoke);
        }
      }
    }
    if (fan.closed) {
      while (seq.length > 1 && seq[0] === seq[seq.length - 1]) {
        seq.pop();
        spoke.pop();
        vOwner.pop();
      }
    }
    const vIdx: number[] = [];
    for (let i = 0; i < seq.length; i++) if (seq[i] === v) vIdx.push(i);
    /** Nombre de coins qui conservent v (deux coins voisins peuvent partager la même occurrence). */
    let owners = 0;
    for (const c of fan.corners) if (!isBev(v, c.prev) && !isBev(v, c.next)) owners++;

    if (vIdx.length === 0) {
      if (!fan.closed || seq.length < 3) continue;
      const spokes: number[] = [];
      for (let i = 0; i < seq.length; i++) if (spoke[i]) spokes.push(i);
      if (segments >= 2 && mBev >= 3 && spokes.length >= 3) {
        // secteurs autour d'un point central placé sur la « sphère » des profils
        const zid = hashId(salt, 'z', v);
        outVerts.set(zid, cornerCenter(seq.map((id) => outVerts.get(id)!), arcCenters.get(v) ?? [], P(v)));
        for (let s = 0; s < spokes.length; s++) {
          const i0 = spokes[s];
          const i1 = spokes[(s + 1) % spokes.length];
          const poly: string[] = [zid];
          for (let i = i0; ; i = (i + 1) % seq.length) {
            poly.push(seq[i]);
            if (i === i1) break;
          }
          holeFaces.push([hashId(salt, 'h', v, s), poly.reverse()]);
        }
      } else {
        holeFaces.push([hashId(salt, 'h', v, 0), seq.slice().reverse()]);
      }
      continue;
    }

    // Le sommet v est conservé par certains coins : un polygone entre deux occurrences successives de v.
    const runs: { start: number; end: number }[] = [];
    if (fan.closed) {
      for (let r = 0; r < vIdx.length; r++) runs.push({ start: vIdx[r], end: vIdx[(r + 1) % vIdx.length] + (r + 1 === vIdx.length ? seq.length : 0) });
    } else {
      for (let r = 0; r + 1 < vIdx.length; r++) runs.push({ start: vIdx[r], end: vIdx[r + 1] });
    }
    for (let r = 0; r < runs.length; r++) {
      const { start, end } = runs[r];
      const inner: string[] = [];
      for (let i = start + 1; i < end; i++) inner.push(seq[i % seq.length]);
      if (inner.length < 2) continue;
      // Un seul coin conserve v et le trou en fait le tour : on fusionne dans sa face.
      if (fan.closed && vIdx.length === 1 && owners === 1) {
        const owner = fan.corners[vOwner[start]];
        mergedCorner.set(owner.face + '|' + v, inner.slice().reverse());
        continue;
      }
      holeFaces.push([hashId(salt, 'h', v, r), [v, ...inner].reverse()]);
    }
  }

  for (const [fid, loop] of mesh.faces) {
    if (!faces.has(fid)) {
      // face invalide : conservée telle quelle si ses sommets existent
      outFaces.set(fid, loop);
      continue;
    }
    let changed = false;
    const out: string[] = [];
    for (let i = 0; i < loop.length; i++) {
      const v = loop[i];
      if (!bevVertSet.has(v)) {
        out.push(v);
        continue;
      }
      const merged = mergedCorner.get(fid + '|' + v);
      if (merged) {
        out.push(...merged);
        changed = true;
        continue;
      }
      const c: Corner = { face: fid, prev: loop[(i + loop.length - 1) % loop.length], next: loop[(i + 1) % loop.length] };
      const s = cornerSeq(v, c);
      if (s.length !== 1 || s[0] !== v) changed = true;
      out.push(...s);
    }
    if (!changed) {
      outFaces.set(fid, loop);
      continue;
    }
    const cl = cleanLoop(out);
    if (cl) outFaces.set(fid, cl);
  }

  // ---------------------------------------------------------------- bandes
  for (const e of bev.values()) {
    const pa = profiles.get(e.key + '|' + e.a);
    const pb = profiles.get(e.key + '|' + e.b);
    if (!pa || !pb) continue;
    for (let j = 0; j < segments; j++) {
      const q = cleanLoop([pb[j], pa[j], pa[j + 1], pb[j + 1]]);
      if (q) outFaces.set(hashId(salt, 'q', e.key, j), q);
    }
  }
  for (const [id, loop] of holeFaces) {
    const cl = cleanLoop(loop);
    if (cl) outFaces.set(id, cl);
  }

  // ---------------------------------------------------------------- sommets utilisés
  const used = new Set<string>();
  for (const loop of outFaces.values()) for (const v of loop) used.add(v);
  const usedBefore = new Set<string>();
  for (const loop of mesh.faces.values()) for (const v of loop) usedBefore.add(v);
  const verts = new Map<string, Vec3>();
  for (const [id, p] of mesh.verts) if (used.has(id) || !usedBefore.has(id)) verts.set(id, p);
  for (const [id, p] of outVerts) if (used.has(id)) verts.set(id, p);
  // garde-fou : toute face doit référencer des sommets existants
  for (const [fid, loop] of outFaces) {
    for (const v of loop) {
      if (!verts.has(v)) {
        outFaces.delete(fid);
        break;
      }
    }
  }
  return { verts, faces: outFaces };
}

/**
 * Ordonne les coins d'un sommet en éventail. Renvoie null si le voisinage n'est pas un disque
 * ou un demi-disque simple (sommet non-manifold, face repassant par le sommet, orientation incohérente).
 */
function buildFan(list: Corner[]): Fan | null {
  const byPrev = new Map<string, Corner>();
  const nexts = new Set<string>();
  const faceSeen = new Set<string>();
  for (const c of list) {
    if (byPrev.has(c.prev) || nexts.has(c.next) || faceSeen.has(c.face)) return null;
    byPrev.set(c.prev, c);
    nexts.add(c.next);
    faceSeen.add(c.face);
  }
  // début d'un éventail ouvert : coin dont l'arête « prev » n'est la « next » d'aucun autre coin
  let start: Corner | null = null;
  for (const c of list) {
    if (!nexts.has(c.prev)) {
      if (start) return null;
      start = c;
    }
  }
  const closed = start === null;
  const first = start ?? list[0];
  const corners: Corner[] = [];
  let cur: Corner | undefined = first;
  while (cur && corners.length <= list.length) {
    corners.push(cur);
    cur = byPrev.get(cur.next);
    if (cur === first) break;
  }
  if (corners.length !== list.length) return null;
  if (closed && cur !== first) return null;
  if (!closed && cur !== undefined) return null;
  return { corners, closed };
}

/**
 * Point central arrondi d'un coin : sur la sphère moyenne des profils, du côté du sommet d'origine,
 * ramené sur le segment (centre du trou, sommet d'origine).
 */
function cornerCenter(boundary: Vec3[], centers: Vec3[], v: Vec3): Vec3 {
  const c: Vec3 = [0, 0, 0];
  for (const p of boundary) {
    c[0] += p[0] / boundary.length;
    c[1] += p[1] / boundary.length;
    c[2] += p[2] / boundary.length;
  }
  if (centers.length === 0) return c;
  const O: Vec3 = [0, 0, 0];
  for (const p of centers) {
    O[0] += p[0] / centers.length;
    O[1] += p[1] / centers.length;
    O[2] += p[2] / centers.length;
  }
  let r = 0;
  for (const p of boundary) r += length(sub(p, O)) / boundary.length;
  const dir = sub(v, O);
  if (length(dir) < 1e-12 || !(r > 1e-12)) return c;
  const z = add(O, scale(normalize(dir), r));
  // On reste sur le segment centre du trou → sommet d'origine : jamais au-delà de la surface initiale.
  const cv = sub(v, c);
  const l2 = dot(cv, cv);
  if (l2 < 1e-24) return c;
  const k = clamp(dot(sub(z, c), cv) / l2, 0, 1);
  return add(c, scale(cv, k));
}
