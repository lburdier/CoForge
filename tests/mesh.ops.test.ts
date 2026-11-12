import { describe, expect, it } from 'vitest';
import { edgeKey, type MeshData, type Vec3 } from '../src/core/doc/schema';
import { createPrimitive, type PrimitiveKind } from '../src/core/mesh/primitives';
import { applyDelta, buildTopology, faceNormal, meshVolume } from '../src/core/mesh/topology';
import * as ops from '../src/core/mesh/ops';
import {
  appendMesh,
  bevelEdges,
  bridgeEdgeLoops,
  deleteElements,
  dissolveElements,
  duplicateFaces,
  extractFaces,
  extrudeFaces,
  extrudeFacesAlongNormals,
  fillFromVerts,
  flipFaces,
  insetFaces,
  loopCut,
  loopCutPreview,
  mergeByDistance,
  mergeVerts,
  recalcNormalsOutside,
  subdivideFaces,
  triangulateFaces,
} from '../src/core/mesh/ops';
import type { MeshOpResult, MeshSelection } from '../src/core/mesh/types';

// ------------------------------------------------------------------ utilitaires

/** Générateur d'identifiants déterministe. */
function seqIds(prefix = 'n'): () => string {
  let i = 0;
  return () => `${prefix}${i++}`;
}

function cube(size = 2): MeshData {
  return createPrimitive('cube', { size });
}

function apply(mesh: MeshData, res: MeshOpResult): MeshData {
  return applyDelta(mesh, res.delta);
}

/** Aucune face invalide (< 3 sommets, sommet répété, sommet manquant). */
function expectValidFaces(mesh: MeshData): void {
  for (const [fid, loop] of mesh.faces) {
    expect(loop.length, `face ${fid}`).toBeGreaterThanOrEqual(3);
    expect(new Set(loop).size, `face ${fid} répète un sommet`).toBe(loop.length);
    for (const v of loop) expect(mesh.verts.has(v), `face ${fid} : sommet ${v} manquant`).toBe(true);
  }
}

/** Maillage fermé manifold : chaque arête est partagée par exactement 2 faces, de sens opposés. */
function expectClosedManifold(mesh: MeshData): void {
  expectValidFaces(mesh);
  const directed = new Map<string, number>();
  for (const loop of mesh.faces.values()) {
    for (let i = 0; i < loop.length; i++) {
      const k = loop[i] + '>' + loop[(i + 1) % loop.length];
      directed.set(k, (directed.get(k) ?? 0) + 1);
    }
  }
  for (const [k, n] of directed) {
    expect(n, `arête orientée ${k} en double`).toBe(1);
    const [a, b] = k.split('>');
    expect(directed.get(b + '>' + a), `arête ${k} sans jumelle opposée`).toBe(1);
  }
}

/** Pas de sommet inutilisé. */
function expectNoOrphans(mesh: MeshData): void {
  const used = new Set<string>();
  for (const loop of mesh.faces.values()) for (const v of loop) used.add(v);
  for (const v of mesh.verts.keys()) expect(used.has(v), `sommet orphelin ${v}`).toBe(true);
}

function edgesOf(mesh: MeshData): Set<string> {
  const out = new Set<string>();
  for (const loop of mesh.faces.values()) for (let i = 0; i < loop.length; i++) out.add(edgeKey(loop[i], loop[(i + 1) % loop.length]));
  return out;
}

/** Face dont la normale est la plus proche de `dir`. */
function faceToward(mesh: MeshData, dir: Vec3): string {
  let best = '';
  let bestDot = -Infinity;
  for (const f of mesh.faces.keys()) {
    const n = faceNormal(mesh, f);
    const d = n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2];
    if (d > bestDot) {
      bestDot = d;
      best = f;
    }
  }
  return best;
}

/** Arête du cube entre les faces +Z et +X. */
function topRightEdge(mesh: MeshData): string {
  const top = mesh.faces.get(faceToward(mesh, [0, 0, 1]))!;
  const right = new Set(mesh.faces.get(faceToward(mesh, [1, 0, 0]))!);
  const shared = top.filter((v) => right.has(v));
  return edgeKey(shared[0], shared[1]);
}

function sel(verts: Iterable<string> = [], edges: Iterable<string> = [], faces: Iterable<string> = []): MeshSelection {
  return { verts: new Set(verts), edges: new Set(edges), faces: new Set(faces) };
}

const EMPTY: MeshData = { verts: new Map(), faces: new Map() };

// ------------------------------------------------------------------ tests

describe('index des opérations', () => {
  it('exporte toutes les fonctions du contrat', () => {
    const names = [
      'bevelEdges',
      'loopCut',
      'loopCutPreview',
      'subdivideFaces',
      'fillFromVerts',
      'bridgeEdgeLoops',
      'triangulateFaces',
      'duplicateFaces',
      'extractFaces',
      'mergeVerts',
      'mergeByDistance',
      'flipFaces',
      'recalcNormalsOutside',
      'deleteElements',
      'dissolveElements',
      'appendMesh',
      'extrudeFaces',
      'extrudeFacesAlongNormals',
      'extrudeFacesIndividual',
      'extrudeEdges',
      'extrudeVerts',
      'insetFaces',
      'insetFacesIndividual',
      'emptyResult',
      'randomId',
    ];
    for (const n of names) expect(typeof (ops as Record<string, unknown>)[n], n).toBe('function');
  });
});

describe('primitives', () => {
  it('le cube est fermé, manifold, de volume positif', () => {
    const m = cube(2);
    expect(m.verts.size).toBe(8);
    expect(m.faces.size).toBe(6);
    expectClosedManifold(m);
    expect(meshVolume(m)).toBeCloseTo(8, 6);
  });
  it('les primitives fermées ont un volume positif', () => {
    for (const k of ['uvsphere', 'icosphere', 'cylinder', 'cone', 'torus'] as const) {
      const m = createPrimitive(k);
      expectClosedManifold(m);
      expect(meshVolume(m), k).toBeGreaterThan(0);
    }
  });
});

describe('extrusion et incrustation', () => {
  it('extrusion de la face du dessus : manifold, volume augmenté', () => {
    const m = cube();
    const top = faceToward(m, [0, 0, 1]);
    const res = extrudeFacesAlongNormals(m, [top], 1, seqIds());
    const out = apply(m, res);
    expect(out.verts.size).toBe(12);
    expect(out.faces.size).toBe(10);
    expectClosedManifold(out);
    expect(meshVolume(out)).toBeCloseTo(12, 6);
    expect(res.select?.faces).toEqual([top]);
  });
  it('extrusion par région de deux faces voisines', () => {
    const m = cube();
    const res = extrudeFaces(m, [faceToward(m, [0, 0, 1]), faceToward(m, [1, 0, 0])], seqIds());
    const out = apply(m, res);
    expectClosedManifold(out);
  });
  it('incrustation : manifold, volume conservé', () => {
    const m = cube();
    const top = faceToward(m, [0, 0, 1]);
    const out = apply(m, insetFaces(m, [top], 0.25, 0, seqIds()));
    expect(out.verts.size).toBe(12);
    expect(out.faces.size).toBe(10);
    expectClosedManifold(out);
    expect(meshVolume(out)).toBeCloseTo(8, 6);
  });
  it('faces qui ne se touchent que par un sommet : extrusion et incrustation restent manifold', () => {
    const m0 = cube();
    const m = apply(m0, subdivideFaces(m0, [faceToward(m0, [0, 0, 1])], 1, seqIds('s')));
    // Deux quads diagonaux du dessus, reliés seulement par le sommet central.
    const tops = [...m.faces.keys()].filter((f) => faceNormal(m, f)[2] > 0.9);
    const a = tops[0];
    const la = new Set(m.faces.get(a)!);
    const b = tops.find((f) => f !== a && m.faces.get(f)!.filter((v) => la.has(v)).length === 1)!;
    expect(b).toBeDefined();
    const ext = apply(m, extrudeFacesAlongNormals(m, [a, b], 0.5, seqIds()));
    expectClosedManifold(ext);
    expect(meshVolume(ext)).toBeCloseTo(8 + 2 * 0.5, 6);
    const ins = apply(m, insetFaces(m, [a, b], 0.1, 0, seqIds()));
    expectClosedManifold(ins);
    expect(meshVolume(ins)).toBeCloseTo(8, 6);
  });
});

describe('bevelEdges', () => {
  it('chanfrein d’une arête du cube : 10 sommets, 7 faces, manifold', () => {
    const m = cube();
    const res = bevelEdges(m, [topRightEdge(m)], 0.2, 1, seqIds());
    const out = apply(m, res);
    expect(out.verts.size).toBe(10);
    expect(out.faces.size).toBe(7);
    expectClosedManifold(out);
    expectNoOrphans(out);
    // Volume du cube moins le prisme retiré (triangle rectangle 0,2 × 0,2 sur 2 de long).
    expect(meshVolume(out)).toBeCloseTo(8 - 0.5 * 0.2 * 0.2 * 2, 6);
    expect(res.select?.faces.length).toBe(1);
  });
  it('arrondi d’une arête (3 segments) : la face d’extrémité absorbe le profil', () => {
    const m = cube();
    const out = apply(m, bevelEdges(m, [topRightEdge(m)], 0.3, 3, seqIds()));
    expect(out.faces.size).toBe(6 + 3);
    expect(out.verts.size).toBe(8 - 2 + 2 * 4);
    expectClosedManifold(out);
    expectNoOrphans(out);
    const v = meshVolume(out);
    expect(v).toBeLessThan(8);
    expect(v).toBeGreaterThan(8 - 0.5 * 0.3 * 0.3 * 2);
  });
  it('chanfrein de toutes les arêtes du cube : coins triangulaires, 26 faces', () => {
    const m = cube();
    const out = apply(m, bevelEdges(m, edgesOf(m), 0.2, 1, seqIds()));
    expect(out.verts.size).toBe(24);
    expect(out.faces.size).toBe(26);
    expectClosedManifold(out);
    expectNoOrphans(out);
    const tris = [...out.faces.values()].filter((l) => l.length === 3).length;
    expect(tris).toBe(8);
    expect(meshVolume(out)).toBeGreaterThan(0);
    expect(meshVolume(out)).toBeLessThan(8);
  });
  it('arrondi de toutes les arêtes du cube (4 segments) : sans trou', () => {
    const m = cube();
    const out = apply(m, bevelEdges(m, edgesOf(m), 0.3, 4, seqIds()));
    expectClosedManifold(out);
    expectNoOrphans(out);
    const v = meshVolume(out);
    expect(v).toBeGreaterThan(7);
    expect(v).toBeLessThan(8);
  });
  it('deux arêtes qui se rejoignent à un coin (chanfrein et arrondi)', () => {
    for (const segs of [1, 3]) {
      const m = cube();
      const top = m.faces.get(faceToward(m, [0, 0, 1]))!;
      const e1 = edgeKey(top[0], top[1]);
      const e2 = edgeKey(top[1], top[2]);
      const out = apply(m, bevelEdges(m, [e1, e2], 0.2, segs, seqIds()));
      expectClosedManifold(out);
      expectNoOrphans(out);
      expect(meshVolume(out)).toBeGreaterThan(0);
    }
  });
  it('boucle d’arêtes du dessus (4 arêtes) en arrondi', () => {
    const m = cube();
    const top = m.faces.get(faceToward(m, [0, 0, 1]))!;
    const keys = top.map((v, i) => edgeKey(v, top[(i + 1) % 4]));
    const out = apply(m, bevelEdges(m, keys, 0.25, 2, seqIds()));
    expectClosedManifold(out);
    expectNoOrphans(out);
    expect(meshVolume(out)).toBeGreaterThan(7);
  });
  it('arête sur un maillage subdivisé (sommet de valence 4)', () => {
    const m0 = cube();
    const m = apply(m0, subdivideFaces(m0, [...m0.faces.keys()], 1, seqIds('s')));
    expectClosedManifold(m);
    const someEdge = [...edgesOf(m)][0];
    for (const segs of [1, 2]) {
      const out = apply(m, bevelEdges(m, [someEdge], 0.1, segs, seqIds()));
      expectClosedManifold(out);
      expectNoOrphans(out);
    }
  });
  it('entrées invalides : résultat vide, aucune exception', () => {
    const m = cube();
    expect(bevelEdges(m, ['x|y'], 0.2, 1).delta).toEqual({});
    expect(bevelEdges(m, [topRightEdge(m)], 0, 1).delta).toEqual({});
    expect(bevelEdges(m, [topRightEdge(m)], NaN, 1).delta).toEqual({});
    expect(bevelEdges(EMPTY, [], 0.2, 2).delta).toEqual({});
  });
});

describe('loopCut', () => {
  it('une coupe autour du cube : +4 sommets, +4 faces, manifold', () => {
    const m = cube();
    const key = topRightEdge(m);
    const res = loopCut(m, key, 1, 0, seqIds());
    const out = apply(m, res);
    expect(out.verts.size).toBe(12);
    expect(out.faces.size).toBe(10);
    expectClosedManifold(out);
    expect(meshVolume(out)).toBeCloseTo(8, 6);
    expect(res.select?.edges.length).toBe(4);
  });
  it('trois coupes glissées', () => {
    const m = cube();
    const out = apply(m, loopCut(m, topRightEdge(m), 3, 0.5, seqIds()));
    expect(out.verts.size).toBe(8 + 12);
    expect(out.faces.size).toBe(6 + 12);
    expectClosedManifold(out);
    expect(meshVolume(out)).toBeCloseTo(8, 6);
  });
  it('aperçu : polylignes fermées', () => {
    const m = cube();
    const lines = loopCutPreview(m, topRightEdge(m), 2, 0);
    expect(lines.length).toBe(2);
    for (const l of lines) {
      expect(l.length).toBe(5);
      expect(l[0]).toEqual(l[4]);
    }
    expect(loopCutPreview(m, 'nope|x', 1, 0)).toEqual([]);
  });
  it('anneau ouvert : la face d’extrémité non quadrangulaire reçoit les sommets (cylindre)', () => {
    const m = createPrimitive('cylinder', { vertices: 8 });
    // Arête verticale d'une paroi : anneau fermé autour du cylindre.
    const side = [...m.faces.values()].find((l) => l.length === 4)!;
    const out = apply(m, loopCut(m, edgeKey(side[1], side[2]), 1, 0, seqIds()));
    expectClosedManifold(out);
    expect(meshVolume(out)).toBeGreaterThan(0);
    // Arête horizontale d'une paroi : anneau ouvert terminé par les n-gones du haut et du bas.
    const out2 = apply(m, loopCut(m, edgeKey(side[0], side[1]), 2, 0, seqIds()));
    expectClosedManifold(out2);
  });
  it('arête inexistante : résultat vide', () => {
    expect(loopCut(cube(), 'a|b', 1, 0).delta).toEqual({});
  });
});

describe('subdivideFaces', () => {
  it('cube entier, 1 coupe : 26 sommets, 24 faces, manifold', () => {
    const m = cube();
    const res = subdivideFaces(m, [...m.faces.keys()], 1, seqIds());
    const out = apply(m, res);
    expect(out.verts.size).toBe(26);
    expect(out.faces.size).toBe(24);
    expectClosedManifold(out);
    expect(meshVolume(out)).toBeCloseTo(8, 6);
    expect(res.select?.faces.length).toBe(24);
  });
  it('une seule face, 2 coupes : les voisines reçoivent les sommets (pas de fissure)', () => {
    const m = cube();
    const out = apply(m, subdivideFaces(m, [faceToward(m, [0, 0, 1])], 2, seqIds()));
    expect(out.faces.size).toBe(5 + 9);
    expectClosedManifold(out);
    expect(meshVolume(out)).toBeCloseTo(8, 6);
  });
  it('triangles et n-gones', () => {
    const ico = createPrimitive('icosphere', { subdivisions: 1 });
    const o1 = apply(ico, subdivideFaces(ico, [...ico.faces.keys()].slice(0, 5), 2, seqIds()));
    expectClosedManifold(o1);
    const cyl = createPrimitive('cylinder', { vertices: 6 });
    const o2 = apply(cyl, subdivideFaces(cyl, [...cyl.faces.keys()], 2, seqIds()));
    expectClosedManifold(o2);
    expect(meshVolume(o2)).toBeCloseTo(meshVolume(cyl), 6);
  });
});

describe('triangulateFaces', () => {
  it('cube : 12 triangles, manifold', () => {
    const m = cube();
    const out = apply(m, triangulateFaces(m, [...m.faces.keys()], seqIds()));
    expect(out.faces.size).toBe(12);
    expect([...out.faces.values()].every((l) => l.length === 3)).toBe(true);
    expectClosedManifold(out);
    expect(meshVolume(out)).toBeCloseTo(8, 6);
  });
  it('déjà triangulé : résultat vide', () => {
    const m = createPrimitive('icosphere', { subdivisions: 1 });
    expect(triangulateFaces(m, [...m.faces.keys()]).delta).toEqual({});
  });
});

describe('duplicateFaces / extractFaces / appendMesh', () => {
  it('duplication : la copie est sélectionnée et indépendante', () => {
    const m = cube();
    const faces = [faceToward(m, [0, 0, 1]), faceToward(m, [1, 0, 0])];
    const res = duplicateFaces(m, faces, seqIds());
    const out = apply(m, res);
    expect(out.faces.size).toBe(8);
    expect(out.verts.size).toBe(8 + 6);
    expect(res.select?.faces.length).toBe(2);
    for (const f of res.select!.faces) for (const v of out.faces.get(f)!) expect(m.verts.has(v)).toBe(false);
  });
  it('séparation : retire les faces et leurs sommets orphelins', () => {
    const m = cube();
    const top = faceToward(m, [0, 0, 1]);
    const { delta, extracted } = extractFaces(m, [top]);
    expect(extracted.faces.size).toBe(1);
    expect(extracted.verts.size).toBe(4);
    const out = applyDelta(m, delta);
    expect(out.faces.size).toBe(5);
    expect(out.verts.size).toBe(8);
    const all = extractFaces(m, [...m.faces.keys()]);
    expect(applyDelta(m, all.delta).verts.size).toBe(0);
    expect(extractFaces(m, ['inexistante']).delta).toEqual({});
  });
  it('ajout d’un maillage : nouveaux identifiants, sélection = l’ajout', () => {
    const m = cube();
    const res = appendMesh(m, cube(1), seqIds());
    const out = apply(m, res);
    expect(out.verts.size).toBe(16);
    expect(out.faces.size).toBe(12);
    expect(res.select?.faces.length).toBe(6);
    expect(res.select?.verts.length).toBe(8);
    expect(meshVolume(out)).toBeCloseTo(9, 6);
  });
});

describe('fillFromVerts', () => {
  it('rebouche un trou le long des arêtes de bord, orientation cohérente', () => {
    const m = cube();
    const top = faceToward(m, [0, 0, 1]);
    const loop = m.faces.get(top)!;
    const holed = applyDelta(m, { delFaces: [top] });
    // Ordre volontairement mélangé.
    const res = fillFromVerts(holed, [loop[2], loop[0], loop[3], loop[1]], seqIds());
    const out = apply(holed, res);
    expect(out.faces.size).toBe(6);
    expectClosedManifold(out);
    expect(meshVolume(out)).toBeCloseTo(8, 6);
  });
  it('trois sommets de bord : triangle orienté avec les voisines', () => {
    const m = cube();
    const top = faceToward(m, [0, 0, 1]);
    const loop = m.faces.get(top)!;
    const holed = applyDelta(m, { delFaces: [top] });
    const r1 = fillFromVerts(holed, [loop[0], loop[1], loop[2]], seqIds('a'));
    const step = apply(holed, r1);
    const r2 = fillFromVerts(step, [loop[0], loop[2], loop[3]], seqIds('b'));
    const out = apply(step, r2);
    expectClosedManifold(out);
    expect(meshVolume(out)).toBeCloseTo(8, 6);
  });
  it('face déjà existante ou moins de 3 sommets : résultat vide', () => {
    const m = cube();
    const top = m.faces.get(faceToward(m, [0, 0, 1]))!;
    expect(fillFromVerts(m, top).delta).toEqual({});
    expect(fillFromVerts(m, top.slice(0, 2)).delta).toEqual({});
  });
});

describe('bridgeEdgeLoops', () => {
  it('relie deux ouvertures de cubes face à face en un volume fermé', () => {
    const a = cube(2);
    const b0 = cube(2);
    // Deuxième cube décalé de 4 en X.
    const b: MeshData = { verts: new Map([...b0.verts].map(([k, p]) => [k, [p[0] + 4, p[1], p[2]] as Vec3])), faces: b0.faces };
    const joined = apply(a, appendMesh(a, b, seqIds('j')));
    // Retire la face +X du premier et la face -X du second.
    let fa = '';
    let fb = '';
    for (const [f] of joined.faces) {
      const n = faceNormal(joined, f);
      const c = joined.faces.get(f)!.reduce((s, v) => s + joined.verts.get(v)![0], 0) / 4;
      if (n[0] > 0.9 && Math.abs(c - 1) < 1e-9) fa = f;
      if (n[0] < -0.9 && Math.abs(c - 3) < 1e-9) fb = f;
    }
    const la = joined.faces.get(fa)!;
    const lb = joined.faces.get(fb)!;
    const holed = applyDelta(joined, { delFaces: [fa, fb] });
    const keys = [...la.map((v, i) => edgeKey(v, la[(i + 1) % 4])), ...lb.map((v, i) => edgeKey(v, lb[(i + 1) % 4]))];
    const res = bridgeEdgeLoops(holed, keys, seqIds());
    const out = apply(holed, res);
    expect(res.select?.faces.length).toBe(4);
    expect(out.faces.size).toBe(14);
    expectClosedManifold(out);
    expect(meshVolume(out)).toBeCloseTo(8 + 8 + 8, 6);
    // Boucles de longueurs différentes : refus.
    expect(bridgeEdgeLoops(holed, keys.slice(0, 7)).delta).toEqual({});
  });
});

describe('mergeVerts / mergeByDistance', () => {
  it('fusion des 4 sommets du dessus : pyramide fermée', () => {
    const m = cube();
    const top = m.faces.get(faceToward(m, [0, 0, 1]))!;
    const res = mergeVerts(m, top, [0, 0, 1], seqIds());
    const out = apply(m, res);
    expect(out.verts.size).toBe(5);
    expect(out.faces.size).toBe(5);
    expectClosedManifold(out);
    expect(meshVolume(out)).toBeCloseTo(8 / 3, 6);
    expect(res.select?.verts).toEqual([top[0]]);
  });
  it('fusion de deux sommets d’une arête', () => {
    const m = cube();
    const top = m.faces.get(faceToward(m, [0, 0, 1]))!;
    const out = apply(m, mergeVerts(m, [top[0], top[1]], [0, 0, 1], seqIds()));
    expect(out.verts.size).toBe(7);
    expectClosedManifold(out);
  });
  it('fusion par distance : recolle une copie superposée', () => {
    const m = cube();
    const top = faceToward(m, [0, 0, 1]);
    const ext = apply(m, extrudeFaces(m, [top], seqIds()));
    // L'extrusion sans déplacement crée 4 sommets superposés.
    const res = mergeByDistance(ext, ext.verts.keys(), 0.001);
    expect(res.merged).toBe(4);
    const out = apply(ext, res);
    expect(out.verts.size).toBe(8);
    expect(out.faces.size).toBe(6);
    expectClosedManifold(out);
    expect(mergeByDistance(m, m.verts.keys(), 0.001).merged).toBe(0);
  });
});

describe('flipFaces / recalcNormalsOutside', () => {
  it('inversion : volume négatif', () => {
    const m = cube();
    const out = apply(m, flipFaces(m, [...m.faces.keys()]));
    expect(meshVolume(out)).toBeCloseTo(-8, 6);
  });
  it('recalcul : faces incohérentes ramenées vers l’extérieur', () => {
    const m = cube();
    const ids = [...m.faces.keys()];
    const broken = apply(m, flipFaces(m, [ids[0], ids[3]]));
    const out = apply(broken, recalcNormalsOutside(broken, ids));
    expectClosedManifold(out);
    expect(meshVolume(out)).toBeCloseTo(8, 6);
    const allFlipped = apply(m, flipFaces(m, ids));
    const out2 = apply(allFlipped, recalcNormalsOutside(allFlipped, ids));
    expect(meshVolume(out2)).toBeCloseTo(8, 6);
    expect(recalcNormalsOutside(m, ids).delta).toEqual({});
  });
});

describe('deleteElements', () => {
  it('suppression de sommet : faces adjacentes et orphelins retirés', () => {
    const m = cube();
    const v = [...m.verts.keys()][0];
    const out = apply(m, deleteElements(m, sel([v]), 'verts'));
    expect(out.faces.size).toBe(3);
    expect(out.verts.size).toBe(7);
    expectNoOrphans(out);
  });
  it('suppression d’arête, de faces, de faces seules', () => {
    const m = cube();
    const e = topRightEdge(m);
    const o1 = apply(m, deleteElements(m, sel([], [e]), 'edges'));
    expect(o1.faces.size).toBe(4);
    expect(o1.verts.size).toBe(8);
    const top = faceToward(m, [0, 0, 1]);
    const bottom = faceToward(m, [0, 0, -1]);
    const o2 = apply(m, deleteElements(m, sel([], [], [top]), 'faces'));
    expect(o2.faces.size).toBe(5);
    expect(o2.verts.size).toBe(8);
    const sides = [...m.faces.keys()].filter((f) => f !== top && f !== bottom);
    const o3 = apply(m, deleteElements(m, sel([], [], [top, ...sides]), 'faces'));
    expect(o3.faces.size).toBe(1);
    expect(o3.verts.size).toBe(4);
    const o4 = apply(m, deleteElements(m, sel([], [], [top, ...sides]), 'only_faces'));
    expect(o4.verts.size).toBe(8);
    expect(deleteElements(m, sel(['inexistant']), 'verts').delta).toEqual({});
  });
});

describe('dissolveElements', () => {
  it('dissolution d’arête après coupe en boucle : retour au cube', () => {
    const m = cube();
    const res = loopCut(m, topRightEdge(m), 1, 0, seqIds());
    const cut = apply(m, res);
    const out = apply(cut, dissolveElements(cut, sel([], res.select!.edges), 'edge'));
    expect(out.faces.size).toBe(6);
    expect(out.verts.size).toBe(8);
    expectClosedManifold(out);
    expect(meshVolume(out)).toBeCloseTo(8, 6);
  });
  it('dissolution de sommets de valence 2 et de sommet central', () => {
    const m = cube();
    const top = faceToward(m, [0, 0, 1]);
    const sub = subdivideFaces(m, [top], 1, seqIds());
    const cut = apply(m, sub);
    // Le sommet central (valence 4) : les 4 quads fusionnent.
    const center = [...cut.verts.entries()].find(([, p]) => Math.abs(p[0]) < 1e-9 && Math.abs(p[1]) < 1e-9 && p[2] > 0.9)![0];
    const o1 = apply(cut, dissolveElements(cut, sel([center]), 'vert'));
    expect(o1.faces.size).toBe(6);
    expectClosedManifold(o1);
    // Puis les sommets de milieu d'arête (valence 2 désormais… sauf côtés : valence 3) via dissolution de faces.
    const o2 = apply(cut, dissolveElements(cut, sel([], [], sub.select!.faces), 'face'));
    expect(o2.faces.size).toBe(6);
    expectClosedManifold(o2);
    expect(meshVolume(o2)).toBeCloseTo(8, 6);
  });
  it('dissolution d’une arête du cube : 5 faces, manifold', () => {
    const m = cube();
    const out = apply(m, dissolveElements(m, sel([], [topRightEdge(m)]), 'edge'));
    expect(out.faces.size).toBe(5);
    expectClosedManifold(out);
  });
  it('sélection vide ou invalide : résultat vide', () => {
    const m = cube();
    expect(dissolveElements(m, sel(), 'edge').delta).toEqual({});
    expect(dissolveElements(m, sel(['zz']), 'vert').delta).toEqual({});
    expect(dissolveElements(m, sel([], [], ['zz']), 'face').delta).toEqual({});
  });
});

describe('robustesse (sélections aléatoires)', () => {
  it('aucune exception, aucune face invalide, manifold conservé pour les opérations qui le doivent', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pick = <T,>(a: T[], n: number) => a.filter(() => rnd() < n / Math.max(1, a.length));
    const kinds: PrimitiveKind[] = ['cube', 'uvsphere', 'icosphere', 'cylinder', 'cone', 'torus', 'plane', 'circle'];
    const errs: string[] = [];
    const manifoldErr = (m: MeshData): string | null => {
      const d = new Map<string, number>();
      for (const l of m.faces.values()) for (let i = 0; i < l.length; i++) {
        const k = l[i] + '>' + l[(i + 1) % l.length];
        d.set(k, (d.get(k) ?? 0) + 1);
      }
      for (const [k, n] of d) {
        const [a, b] = k.split('>');
        if (n !== 1 || d.get(b + '>' + a) !== 1) return 'non manifold ' + k;
      }
      return null;
    };
    for (let it = 0; it < 240; it++) {
      const kind = kinds[it % kinds.length];
      const closed = kind !== 'plane' && kind !== 'circle';
      let m = createPrimitive(kind, { segments: 8, rings: 4, vertices: 6, subdivisions: 1, majorSegments: 8, minorSegments: 4 });
      if (rnd() < 0.5) m = applyDelta(m, subdivideFaces(m, pick([...m.faces.keys()], 3), 1).delta);
      const edges = [...buildTopology(m).edges.keys()];
      const faces = [...m.faces.keys()];
      const verts = [...m.verts.keys()];
      const cases: [string, boolean, () => MeshOpResult][] = [
        ['bevel', true, () => bevelEdges(m, pick(edges, 1 + rnd() * 6), 0.05 + rnd() * 0.3, 1 + Math.floor(rnd() * 4))],
        ['loopCut', true, () => loopCut(m, edges[Math.floor(rnd() * edges.length)], 1 + Math.floor(rnd() * 3), rnd() * 2 - 1)],
        ['subdivide', true, () => subdivideFaces(m, pick(faces, 3), 1 + Math.floor(rnd() * 3))],
        ['extrude', true, () => extrudeFaces(m, pick(faces, 3))],
        ['inset', true, () => insetFaces(m, pick(faces, 3), 0.05)],
        ['triangulate', true, () => triangulateFaces(m, pick(faces, 3))],
        ['recalc', true, () => recalcNormalsOutside(m, faces)],
        ['dissolveEdge', false, () => dissolveElements(m, sel([], pick(edges, 3)), 'edge')],
        ['dissolveVert', false, () => dissolveElements(m, sel(pick(verts, 3)), 'vert')],
        ['dissolveFace', false, () => dissolveElements(m, sel([], [], pick(faces, 4)), 'face')],
        ['mergeVerts', false, () => mergeVerts(m, pick(verts, 3), [0, 0, 0])],
        ['mergeByDistance', false, () => mergeByDistance(m, verts, rnd() * 0.5)],
        ['fill', false, () => fillFromVerts(m, pick(verts, 4))],
        ['bridge', false, () => bridgeEdgeLoops(m, pick(edges, 8))],
        ['delete', false, () => deleteElements(m, sel(pick(verts, 2), pick(edges, 2), pick(faces, 2)), (['verts', 'edges', 'faces', 'only_faces'] as const)[it % 4])],
      ];
      for (const [name, keep, fn] of cases) {
        try {
          const r = fn();
          for (const l of Object.values(r.delta.setFaces ?? {})) if (l.length < 3 || new Set(l).size !== l.length) errs.push(`${name}/${kind} : face invalide`);
          const out = applyDelta(m, r.delta);
          for (const l of Object.values(r.delta.setFaces ?? {})) for (const v of l) if (!out.verts.has(v)) errs.push(`${name}/${kind} : sommet manquant`);
          if (closed && keep) {
            const e = manifoldErr(out);
            if (e) errs.push(`${name}/${kind} : ${e}`);
          }
        } catch (ex) {
          errs.push(`${name}/${kind} : exception ${(ex as Error).message}`);
        }
      }
    }
    expect(errs.slice(0, 10)).toEqual([]);
  });
});

describe('données incohérentes (édition concurrente)', () => {
  it('face qui référence un sommet disparu : aucune exception', () => {
    const m = cube();
    const gone = [...m.verts.keys()][0];
    const broken: MeshData = { verts: new Map([...m.verts].filter(([k]) => k !== gone)), faces: m.faces };
    const edges = [...edgesOf(broken)];
    const faces = [...broken.faces.keys()];
    const verts = [...broken.verts.keys()];
    expect(() => {
      bevelEdges(broken, edges, 0.2, 2);
      loopCut(broken, edges[0], 2, 0.3);
      loopCutPreview(broken, edges[0], 2, 0.3);
      subdivideFaces(broken, faces, 2);
      fillFromVerts(broken, verts);
      bridgeEdgeLoops(broken, edges);
      triangulateFaces(broken, faces);
      duplicateFaces(broken, faces);
      extractFaces(broken, faces);
      mergeVerts(broken, verts, [0, 0, 0]);
      mergeByDistance(broken, verts, 10);
      flipFaces(broken, faces);
      recalcNormalsOutside(broken, faces);
      deleteElements(broken, sel(verts, edges, faces), 'verts');
      dissolveElements(broken, sel(verts, edges, faces), 'edge');
      dissolveElements(broken, sel(verts, edges, faces), 'vert');
      dissolveElements(broken, sel(verts, edges, faces), 'face');
      appendMesh(broken, broken);
      extrudeFaces(broken, faces);
      insetFaces(broken, faces, 0.1, 0.1);
    }).not.toThrow();
  });
});
