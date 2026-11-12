import { describe, expect, it } from 'vitest';
import { Matrix4 } from 'three';
import { MODIFIER_DEFAULTS, type MeshData, type ModifierData, type ModifierParamsMap, type ModifierType, type Vec3 } from '../src/core/doc/schema';
import type { ModifierContext } from '../src/core/mesh/types';
import { evaluateModifiers } from '../src/core/mesh/modifiers';
import { meshBounds, meshVolume, newellNormal } from '../src/core/mesh/topology';
import { triangulate, triangulatePolygon } from '../src/core/mesh/triangulate';
import { createPrimitive, type PrimitiveKind } from '../src/core/mesh/primitives';

// ---------------------------------------------------------------- outils

function mesh(verts: Record<string, Vec3>, faces: Record<string, string[]>): MeshData {
  return { verts: new Map(Object.entries(verts)), faces: new Map(Object.entries(faces)) };
}

/** Cube axé de côté `size` centré en `c`, identifiants préfixés par `p`. */
function cube(size = 2, c: Vec3 = [0, 0, 0], p = 'v'): MeshData {
  const h = size / 2;
  const pts: Vec3[] = [
    [-h, -h, -h],
    [h, -h, -h],
    [h, h, -h],
    [-h, h, -h],
    [-h, -h, h],
    [h, -h, h],
    [h, h, h],
    [-h, h, h],
  ];
  const verts: Record<string, Vec3> = {};
  pts.forEach((q, i) => (verts[p + i] = [q[0] + c[0], q[1] + c[1], q[2] + c[2]]));
  const quads = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ];
  const faces: Record<string, string[]> = {};
  quads.forEach((q, i) => (faces[p + 'f' + i] = q.map((k) => p + k)));
  return mesh(verts, faces);
}

/** Boîte quelconque [min, max] (mêmes faces que cube()). */
function box(min: Vec3, max: Vec3, p = 'b'): MeshData {
  const m = cube(2, [0, 0, 0], p);
  for (const [id, q] of m.verts) {
    m.verts.set(id, [q[0] < 0 ? min[0] : max[0], q[1] < 0 ? min[1] : max[1], q[2] < 0 ? min[2] : max[2]]);
  }
  return m;
}

function mod<T extends ModifierType>(type: T, params: Partial<ModifierParamsMap[T]> = {}, id = 'm-' + type, enabled = true): ModifierData {
  return { id, type, name: type, enabled, params: { ...MODIFIER_DEFAULTS[type], ...params } } as ModifierData;
}

const noCtx: ModifierContext = { getOperand: () => null };

/** Fermé et bien orienté : chaque arête orientée a exactement une jumelle opposée, faces valides. */
function expectClosed(m: MeshData): void {
  const directed = new Map<string, number>();
  for (const [fid, loop] of m.faces) {
    expect(loop.length, `face ${fid}`).toBeGreaterThanOrEqual(3);
    expect(new Set(loop).size, `face ${fid} sans répétition`).toBe(loop.length);
    for (let i = 0; i < loop.length; i++) {
      expect(m.verts.has(loop[i]), `sommet ${loop[i]} de ${fid}`).toBe(true);
      const k = loop[i] + '>' + loop[(i + 1) % loop.length];
      directed.set(k, (directed.get(k) ?? 0) + 1);
    }
  }
  let bad = 0;
  for (const [k, n] of directed) {
    const [a, b] = k.split('>');
    if (n !== 1 || directed.get(b + '>' + a) !== 1) bad++;
  }
  expect(bad, 'arêtes non appariées').toBe(0);
}

/** Aucune arête utilisée par plus de deux faces, aucune arête orientée en double (surface ouverte permise). */
function expectManifoldWithBorder(m: MeshData): number {
  const directed = new Map<string, number>();
  for (const loop of m.faces.values()) {
    for (let i = 0; i < loop.length; i++) {
      const k = loop[i] + '>' + loop[(i + 1) % loop.length];
      directed.set(k, (directed.get(k) ?? 0) + 1);
    }
  }
  let border = 0;
  for (const [k, n] of directed) {
    expect(n).toBe(1);
    const [a, b] = k.split('>');
    if (!directed.has(b + '>' + a)) border++;
  }
  return border;
}

function snapshot(m: MeshData): string {
  return JSON.stringify([[...m.verts], [...m.faces]]);
}

function noNaN(m: MeshData): void {
  for (const p of m.verts.values()) for (const x of p) expect(Number.isFinite(x)).toBe(true);
}

// ---------------------------------------------------------------- pile

describe('evaluateModifiers - pile', () => {
  it('renvoie le maillage d’entrée lui-même si la pile est vide ou inactive', () => {
    const m = cube();
    expect(evaluateModifiers(m, [], noCtx)).toBe(m);
    expect(evaluateModifiers(m, [mod('subsurf', {}, 'a', false), mod('bevel', {}, 'b', false)], noCtx)).toBe(m);
    // booléen sans opérande : ignoré
    expect(evaluateModifiers(m, [mod('boolean', { target: 'absent' })], noCtx)).toBe(m);
    expect(evaluateModifiers(m, [mod('boolean', { target: null })], noCtx)).toBe(m);
  });

  it('ne lève jamais : paramètres aberrants et contexte qui échoue sont ignorés', () => {
    const m = cube();
    const ctx: ModifierContext = {
      getOperand: () => {
        throw new Error('panne');
      },
    };
    const weird = [
      { id: 'x', type: 'inconnu', name: '?', enabled: true, params: {} },
      { id: 'y', type: 'array', name: '?', enabled: true, params: { count: Number.NaN, relative: null, constant: [Infinity, 0, 0] } },
      { id: 'z', type: 'subsurf', name: '?', enabled: true, params: null },
      mod('boolean', { target: 'obj' }),
    ] as unknown as ModifierData[];
    let out: MeshData | null = null;
    expect(() => (out = evaluateModifiers(m, weird, ctx))).not.toThrow();
    expect(out).not.toBeNull();
    noNaN(out!);
    expect(m.faces.size).toBe(6); // entrée intacte
    expect(m.verts.size).toBe(8);
  });

  it('ne modifie pas le maillage d’entrée', () => {
    const m = cube();
    const before = snapshot(m);
    evaluateModifiers(m, [mod('mirror'), mod('array', { count: 3 }), mod('bevel'), mod('subsurf'), mod('solidify')], noCtx);
    expect(snapshot(m)).toBe(before);
  });

  it('est déterministe (mêmes entrées → mêmes identifiants)', () => {
    const operand = cube(1, [0, 0, 0], 'o');
    const toLocal = new Matrix4().makeTranslation(1.5, 0.3, 0.2);
    const ctx: ModifierContext = { getOperand: (id) => (id === 'obj' ? { mesh: operand, toLocal } : null) };
    const stack = [
      mod('mirror', { axisX: true, axisY: true }),
      mod('array', { count: 2, relative: [1, 0, 0], constant: [0.5, 0, 0] }),
      mod('bevel', { width: 0.1, segments: 2 }),
      mod('boolean', { operation: 'difference', target: 'obj' }),
      mod('subsurf', { levels: 1 }),
    ];
    const a = evaluateModifiers(cube(2, [1.5, 1.5, 0]), stack, ctx);
    const b = evaluateModifiers(cube(2, [1.5, 1.5, 0]), stack, ctx);
    expect(a.faces.size).toBeGreaterThan(100);
    expect(snapshot(a)).toBe(snapshot(b));
  });

  it('pile combinée miroir + biseau + subdivision : maillage fermé', () => {
    // demi-boîte ouverte sur le plan x = 0
    const half = box([0, -1, -1], [1, 1, 1], 'h');
    const openFace = [...half.faces].find(([, l]) => l.every((v) => half.verts.get(v)![0] === 0))![0];
    half.faces.delete(openFace);
    const out = evaluateModifiers(half, [mod('mirror'), mod('bevel', { width: 0.1, segments: 2 }), mod('subsurf', { levels: 1 })], noCtx);
    expectClosed(out);
    noNaN(out);
    const v = meshVolume(out);
    expect(v).toBeGreaterThan(7.5);
    expect(v).toBeLessThan(8);
  });
});

// ---------------------------------------------------------------- miroir

describe('modificateur miroir', () => {
  it('referme une demi-boîte en soudant les sommets du plan', () => {
    const half = box([0, -1, -1], [1, 1, 1], 'h');
    const openFace = [...half.faces].find(([, l]) => l.every((v) => half.verts.get(v)![0] === 0))![0];
    half.faces.delete(openFace);
    const out = evaluateModifiers(half, [mod('mirror')], noCtx);
    expect(out.verts.size).toBe(12);
    expect(out.faces.size).toBe(10);
    expectClosed(out);
    expect(meshVolume(out)).toBeCloseTo(8, 6);
    expect(meshBounds(out)).toEqual({ min: [-1, -1, -1], max: [1, 1, 1] });
  });

  it('combine les axes X, Y et Z (huitième de boîte → boîte complète)', () => {
    const q = box([0, 0, 0], [1, 1, 1], 'q');
    for (const [fid, l] of [...q.faces]) {
      for (let a = 0; a < 3; a++) if (l.every((v) => q.verts.get(v)![a] === 0)) q.faces.delete(fid);
    }
    expect(q.faces.size).toBe(3);
    q.verts.delete('q0'); // coin à l'origine, devenu isolé
    const out = evaluateModifiers(q, [mod('mirror', { axisX: true, axisY: true, axisZ: true })], noCtx);
    expect(out.faces.size).toBe(24);
    expect(out.verts.size).toBe(26);
    expectClosed(out);
    expect(meshVolume(out)).toBeCloseTo(8, 6);
  });

  it('sans soudure : copie retournée disjointe', () => {
    const out = evaluateModifiers(cube(1, [2, 0, 0]), [mod('mirror', { merge: false })], noCtx);
    expect(out.verts.size).toBe(16);
    expect(out.faces.size).toBe(12);
    expectClosed(out);
    expect(meshVolume(out)).toBeCloseTo(2, 6);
    expect(meshBounds(out)!.min[0]).toBeCloseTo(-2.5, 9);
  });

  it('soude les sommets proches du plan selon mergeDist', () => {
    const half = box([0.0005, -1, -1], [1, 1, 1], 'h');
    const openFace = [...half.faces].find(([, l]) => l.every((v) => half.verts.get(v)![0] < 0.01))![0];
    half.faces.delete(openFace);
    const merged = evaluateModifiers(half, [mod('mirror', { mergeDist: 0.001 })], noCtx);
    expect(merged.verts.size).toBe(12);
    expectClosed(merged);
    const apart = evaluateModifiers(half, [mod('mirror', { mergeDist: 0.0001 })], noCtx);
    expect(apart.verts.size).toBe(16);
  });
});

// ---------------------------------------------------------------- réseau

describe('modificateur réseau', () => {
  it('copies décalées (relatif + constant)', () => {
    const out = evaluateModifiers(cube(2), [mod('array', { count: 3, relative: [1, 0, 0], constant: [0.5, 0, 1] })], noCtx);
    expect(out.verts.size).toBe(24);
    expect(out.faces.size).toBe(18);
    expectClosed(out);
    expect(meshVolume(out)).toBeCloseTo(24, 6);
    const b = meshBounds(out)!;
    expect(b.max[0]).toBeCloseTo(1 + 2 * 2.5, 9);
    expect(b.max[2]).toBeCloseTo(1 + 2, 9);
  });

  it('count = 1 renvoie le maillage d’entrée', () => {
    const m = cube();
    expect(evaluateModifiers(m, [mod('array', { count: 1 })], noCtx)).toBe(m);
  });
});

// ---------------------------------------------------------------- biseau

describe('modificateur biseau', () => {
  const L = 2;
  const r = 0.1;
  const chamferVolume = (L - 2 * r) ** 3 + 6 * (L - 2 * r) ** 2 * r + 12 * (L - 2 * r) * (r * r) / 2 + (8 * r ** 3) / 6;
  const roundVolume = (L - 2 * r) ** 3 + 6 * (L - 2 * r) ** 2 * r + 3 * (L - 2 * r) * Math.PI * r * r + (4 / 3) * Math.PI * r ** 3;

  it('chanfrein (1 segment) d’un cube : fermé, comptes et volume exacts', () => {
    const out = evaluateModifiers(cube(L), [mod('bevel', { width: r, segments: 1, angleLimit: 30 })], noCtx);
    expect(out.verts.size).toBe(24);
    expect(out.faces.size).toBe(6 + 12 + 8);
    expectClosed(out);
    expect(meshVolume(out)).toBeCloseTo(chamferVolume, 6);
  });

  it('2 segments : coins en quads, fermé, volume entre chanfrein et arrondi', () => {
    const out = evaluateModifiers(cube(L), [mod('bevel', { width: r, segments: 2 })], noCtx);
    expect(out.faces.size).toBe(6 + 24 + 24);
    expect(out.verts.size).toBe(24 + 24 + 8);
    for (const loop of out.faces.values()) expect(loop.length).toBe(4);
    expectClosed(out);
    const v = meshVolume(out);
    expect(v).toBeGreaterThan(chamferVolume);
    expect(v).toBeLessThan(roundVolume);
  });

  it('3 et 8 segments : fermé, le volume tend vers celui de l’arrondi', () => {
    const out3 = evaluateModifiers(cube(L), [mod('bevel', { width: r, segments: 3 })], noCtx);
    expectClosed(out3);
    const out8 = evaluateModifiers(cube(L), [mod('bevel', { width: r, segments: 8 })], noCtx);
    expectClosed(out8);
    expect(Math.abs(meshVolume(out8) - roundVolume)).toBeLessThan(3e-3);
    expect(meshVolume(out3)).toBeLessThan(meshVolume(out8));
  });

  it('respecte angleLimit et réduit une largeur excessive', () => {
    const m = cube(L);
    expect(evaluateModifiers(m, [mod('bevel', { angleLimit: 95 })], noCtx)).toBe(m);
    const big = evaluateModifiers(m, [mod('bevel', { width: 5, segments: 2 })], noCtx);
    expectClosed(big);
    noNaN(big);
    const b = meshBounds(big)!;
    expect(b.max[0]).toBeLessThanOrEqual(1 + 1e-9);
    expect(meshVolume(big)).toBeGreaterThan(0);
  });

  it('prisme octogonal : seules les arêtes des bases sont biseautées, résultat fermé', () => {
    const n = 8;
    const verts: Record<string, Vec3> = {};
    const faces: Record<string, string[]> = {};
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      verts['b' + k] = [Math.cos(a), Math.sin(a), 0];
      verts['t' + k] = [Math.cos(a), Math.sin(a), 1];
      faces['s' + k] = ['b' + k, 'b' + ((k + 1) % n), 't' + ((k + 1) % n), 't' + k];
    }
    faces.top = Array.from({ length: n }, (_, k) => 't' + k);
    faces.bot = Array.from({ length: n }, (_, k) => 'b' + (n - 1 - k));
    const m = mesh(verts, faces);
    const v0 = meshVolume(m);
    const out = evaluateModifiers(m, [mod('bevel', { width: 0.05, segments: 3, angleLimit: 60 })], noCtx);
    expectClosed(out);
    // 8 côtés + 2 bases + 2 × 8 × 3 quads de bande + 16 coins rebouchés (2 arêtes biseautées par sommet)
    expect(out.faces.size).toBe(8 + 2 + 2 * 8 * 3 + 16);
    const v = meshVolume(out);
    expect(v).toBeLessThan(v0);
    expect(v).toBeGreaterThan(v0 * 0.9);
  });

  it('toit en croupe : une arête vive qui s’arrête sur une face (rebouchage fusionné)', () => {
    const h = Math.tan((20 * Math.PI) / 180);
    const m = mesh(
      {
        a: [-2, -1, 0], b: [2, -1, 0], c: [2, 1, 0], d: [-2, 1, 0],
        e: [-2, -1, 1], f: [2, -1, 1], g: [2, 1, 1], k: [-2, 1, 1],
        r1: [-1, 0, 1 + h], r2: [1, 0, 1 + h],
      },
      {
        bottom: ['a', 'd', 'c', 'b'],
        front: ['a', 'b', 'f', 'e'],
        right: ['b', 'c', 'g', 'f'],
        back: ['c', 'd', 'k', 'g'],
        left: ['d', 'a', 'e', 'k'],
        roofF: ['e', 'f', 'r2', 'r1'],
        roofB: ['g', 'k', 'r1', 'r2'],
        hipR: ['f', 'g', 'r2'],
        hipL: ['k', 'e', 'r1'],
      },
    );
    expectClosed(m);
    const v0 = meshVolume(m);
    const out = evaluateModifiers(m, [mod('bevel', { width: 0.05, segments: 2, angleLimit: 35 })], noCtx);
    expectClosed(out);
    noNaN(out);
    // le faîtage (40°) est biseauté, les arêtiers (≈28°) non : r1 et r2 disparaissent dans les croupes
    expect(out.verts.has('r1')).toBe(false);
    expect(out.faces.get('hipR')!.length).toBeGreaterThan(3);
    const v = meshVolume(out);
    expect(v).toBeLessThan(v0);
    expect(v).toBeGreaterThan(v0 * 0.95);
  });

  it('primitives fermées, toutes arêtes biseautées (angleLimit 0) : reste fermé', () => {
    const kinds: [PrimitiveKind, Record<string, number>][] = [
      ['cube', {}],
      ['uvsphere', { segments: 12, rings: 6 }],
      ['icosphere', { subdivisions: 1 }],
      ['cylinder', { vertices: 12 }],
      ['cone', { vertices: 12 }],
      ['torus', {}],
    ];
    for (const [kind, params] of kinds) {
      const m = createPrimitive(kind, params);
      const v0 = meshVolume(m);
      for (const segments of [1, 2, 3]) {
        const out = evaluateModifiers(m, [mod('bevel', { width: 0.05, segments, angleLimit: 0 })], noCtx);
        expect(out.faces.size, kind).toBeGreaterThan(m.faces.size);
        expectClosed(out);
        noNaN(out);
        const v = meshVolume(out);
        expect(v, kind).toBeLessThanOrEqual(v0 + 1e-9);
        expect(v, kind).toBeGreaterThan(v0 * 0.7);
      }
    }
  });

  it('biseau d’un résultat booléen (polygones à sommets alignés)', () => {
    const ctx: ModifierContext = { getOperand: () => ({ mesh: cube(2, [0, 0, 0], 'o'), toLocal: new Matrix4().makeTranslation(1, 1, 1) }) };
    const out = evaluateModifiers(cube(2), [mod('boolean', { target: 'x' }), mod('bevel', { width: 0.05, segments: 2 })], ctx);
    expectClosed(out);
    noNaN(out);
    expect(meshVolume(out)).toBeLessThan(7);
    expect(meshVolume(out)).toBeGreaterThan(6.8);
  });

  it('surface ouverte pliée : bords conservés, pas d’arête non-manifold', () => {
    const m = mesh(
      { a: [0, 0, 0], b: [1, 0, 0], c: [1, 1, 0], d: [0, 1, 0], e: [1, 0, 1], f: [0, 0, 1] },
      { floor: ['a', 'b', 'c', 'd'], wall: ['a', 'f', 'e', 'b'] },
    );
    const out = evaluateModifiers(m, [mod('bevel', { width: 0.1, segments: 3 })], noCtx);
    expect(out.faces.size).toBe(2 + 3);
    const border = expectManifoldWithBorder(out);
    expect(border).toBe(6 + 2 * 3);
  });
});

// ---------------------------------------------------------------- subdivision

describe('modificateur subdivision (Catmull-Clark)', () => {
  it('cube niveau 1 et 2 : comptes, fermé, volume réduit', () => {
    const o1 = evaluateModifiers(cube(2), [mod('subsurf', { levels: 1 })], noCtx);
    expect(o1.faces.size).toBe(24);
    expect(o1.verts.size).toBe(26);
    expectClosed(o1);
    const o2 = evaluateModifiers(cube(2), [mod('subsurf', { levels: 2 })], noCtx);
    expect(o2.faces.size).toBe(96);
    expect(o2.verts.size).toBe(98);
    expectClosed(o2);
    const v1 = meshVolume(o1);
    const v2 = meshVolume(o2);
    expect(v1).toBeLessThan(8);
    expect(v2).toBeLessThan(v1);
    expect(v2).toBeGreaterThan(2.5);
    // sommet d'origine d'un cube : (F + 2R + (n - 3)P) / n = (1/9, ...) × 5 → 5/9
    expect(o1.verts.get('v6')![0]).toBeCloseTo(5 / 9, 9);
  });

  it('borne les niveaux à 4', () => {
    const o = evaluateModifiers(cube(2), [mod('subsurf', { levels: 10 })], noCtx);
    expect(o.faces.size).toBe(6 * 4 ** 4);
    expectClosed(o);
  });

  it('n-gones et bords ouverts', () => {
    // prisme pentagonal (deux pentagones) : fermé après subdivision
    const n = 5;
    const verts: Record<string, Vec3> = {};
    const faces: Record<string, string[]> = {};
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      verts['b' + k] = [Math.cos(a), Math.sin(a), 0];
      verts['t' + k] = [Math.cos(a), Math.sin(a), 1];
      faces['s' + k] = ['b' + k, 'b' + ((k + 1) % n), 't' + ((k + 1) % n), 't' + k];
    }
    faces.top = Array.from({ length: n }, (_, k) => 't' + k);
    faces.bot = Array.from({ length: n }, (_, k) => 'b' + (n - 1 - k));
    const o = evaluateModifiers(mesh(verts, faces), [mod('subsurf', { levels: 2 })], noCtx);
    expectClosed(o);
    expect(o.faces.size).toBe((5 * 4 + 2 * 5) * 4);
    // plan ouvert : les coins restent en place, le bord reste droit
    const plane = mesh({ a: [0, 0, 0], b: [1, 0, 0], c: [1, 1, 0], d: [0, 1, 0] }, { f: ['a', 'b', 'c', 'd'] });
    const op = evaluateModifiers(plane, [mod('subsurf', { levels: 2 })], noCtx);
    expect(op.faces.size).toBe(16);
    expect(op.verts.get('a')).toEqual([0, 0, 0]);
    expect(expectManifoldWithBorder(op)).toBe(16);
    for (const p of op.verts.values()) expect(p[2]).toBe(0);
  });
});

// ---------------------------------------------------------------- solidifier

describe('modificateur solidifier', () => {
  const plane = () => mesh({ a: [0, 0, 0], b: [1, 0, 0], c: [1, 1, 0], d: [0, 1, 0] }, { f: ['a', 'b', 'c', 'd'] });

  it('plan → pavé fermé, selon offset', () => {
    for (const offset of [-1, 0, 1]) {
      const out = evaluateModifiers(plane(), [mod('solidify', { thickness: 0.1, offset })], noCtx);
      expect(out.verts.size).toBe(8);
      expect(out.faces.size).toBe(6);
      expectClosed(out);
      expect(meshVolume(out)).toBeCloseTo(0.1, 9);
      const b = meshBounds(out)!;
      expect(b.min[2]).toBeCloseTo(offset === -1 ? -0.1 : offset === 0 ? -0.05 : 0, 9);
    }
  });

  it('boîte ouverte → coque fermée', () => {
    const m = cube(2);
    m.faces.delete('vf1'); // face du haut
    const out = evaluateModifiers(m, [mod('solidify', { thickness: 0.05 })], noCtx);
    expect(out.faces.size).toBe(5 * 2 + 4);
    expectClosed(out);
    const v = meshVolume(out);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(5 * 4 * 0.05 + 1e-9);
  });
});

// ---------------------------------------------------------------- booléen

describe('modificateur booléen', () => {
  const operand = cube(2, [0, 0, 0], 'o');
  const ctx: ModifierContext = {
    getOperand: (id) => (id === 'other' ? { mesh: operand, toLocal: new Matrix4().makeTranslation(1, 1, 1) } : null),
  };

  it('différence cube − cube décalé', () => {
    const out = evaluateModifiers(cube(2), [mod('boolean', { operation: 'difference', target: 'other' })], ctx);
    expect(Math.abs(meshVolume(out) - 7)).toBeLessThan(1e-3);
    noNaN(out);
    expectClosed(out);
    // refusion coplanaire : bien moins de faces que de triangles
    expect(out.faces.size).toBeLessThan(40);
    // les sommets d'entrée conservés gardent leur identifiant
    expect(out.verts.get('v0')).toEqual([-1, -1, -1]);
  });

  it('union et intersection', () => {
    const u = evaluateModifiers(cube(2), [mod('boolean', { operation: 'union', target: 'other' })], ctx);
    expect(Math.abs(meshVolume(u) - 15)).toBeLessThan(1e-3);
    expectClosed(u);
    const i = evaluateModifiers(cube(2), [mod('boolean', { operation: 'intersect', target: 'other' })], ctx);
    expect(Math.abs(meshVolume(i) - 1)).toBeLessThan(1e-3);
    expectClosed(i);
    expect(i.faces.size).toBe(6);
  });

  it('opérande transformé (rotation + échelle négative)', () => {
    const toLocal = new Matrix4().makeRotationZ(Math.PI / 4).premultiply(new Matrix4().makeScale(-1, 1, 1)).premultiply(new Matrix4().makeTranslation(0, 0, 1));
    const c2: ModifierContext = { getOperand: () => ({ mesh: cube(1, [0, 0, 0], 'o'), toLocal }) };
    const out = evaluateModifiers(cube(2), [mod('boolean', { operation: 'difference', target: 'x' })], c2);
    // la moitié inférieure du petit cube (0.5) est retirée
    expect(Math.abs(meshVolume(out) - 7.5)).toBeLessThan(1e-3);
  });

  it('déterministe', () => {
    const a = evaluateModifiers(cube(2), [mod('boolean', { operation: 'difference', target: 'other' })], ctx);
    const b = evaluateModifiers(cube(2), [mod('boolean', { operation: 'difference', target: 'other' })], ctx);
    expect(snapshot(a)).toBe(snapshot(b));
  });
});

// ---------------------------------------------------------------- triangulation

describe('triangulate', () => {
  it('polygone concave (étoile) : n - 2 triangles bien orientés, aire conservée, arêtes sans diagonales', () => {
    const n = 10;
    const verts: Record<string, Vec3> = {};
    const loop: string[] = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const rr = k % 2 === 0 ? 1 : 0.4;
      verts['s' + k] = [Math.cos(a) * rr, Math.sin(a) * rr, 0];
      loop.push('s' + k);
    }
    const m = mesh(verts, { star: loop });
    const rm = triangulate(m, { smooth: false, autoSmoothAngle: 30 });
    expect(rm.triFace.length).toBe(n - 2);
    expect(rm.triFace.every((f) => f === 'star')).toBe(true);
    let area = 0;
    for (let t = 0; t < n - 2; t++) {
      const p = rm.positions;
      const ux = p[t * 9 + 3] - p[t * 9];
      const uy = p[t * 9 + 4] - p[t * 9 + 1];
      const vx = p[t * 9 + 6] - p[t * 9];
      const vy = p[t * 9 + 7] - p[t * 9 + 1];
      const a2 = ux * vy - uy * vx;
      expect(a2).toBeGreaterThan(0);
      area += a2 / 2;
      expect(rm.normals[t * 9 + 2]).toBeCloseTo(1, 6);
    }
    const ref = newellNormal(loop.map((v) => verts[v]));
    expect(area).toBeCloseTo(ref[2] / 2, 5);
    expect(rm.edgeKeys.length).toBe(n);
    expect(rm.edgePositions.length).toBe(n * 6);
    expect(new Set(rm.edgeKeys).size).toBe(n);
  });

  it('quad concave : diagonale intérieure', () => {
    const pts: Vec3[] = [
      [0, 0, 0],
      [2, 0, 0],
      [0.5, 0.5, 0],
      [0, 2, 0],
    ];
    const t = triangulatePolygon(pts);
    expect(t.length).toBe(6);
    // la diagonale doit partir du sommet réflexe (indice 2)
    for (let i = 0; i < 6; i += 3) expect([t[i], t[i + 1], t[i + 2]]).toContain(2);
  });

  it('lissage avec autoSmoothAngle', () => {
    const m = cube(2);
    const sharp = triangulate(m, { smooth: true, autoSmoothAngle: 30 });
    for (let i = 0; i < sharp.normals.length; i += 3) {
      const l = Math.abs(sharp.normals[i]) + Math.abs(sharp.normals[i + 1]) + Math.abs(sharp.normals[i + 2]);
      expect(l).toBeCloseTo(1, 5); // normales d'axe : arêtes vives conservées
    }
    const smooth = triangulate(m, { smooth: true, autoSmoothAngle: 180 });
    for (let i = 0; i < smooth.normals.length; i += 3) {
      for (let k = 0; k < 3; k++) expect(Math.abs(smooth.normals[i + k])).toBeCloseTo(1 / Math.sqrt(3), 5);
    }
    expect(sharp.edgeKeys.length).toBe(12);
    expect(sharp.triFace.length).toBe(12);
  });

  it('100 000 faces en bien moins d’une seconde', () => {
    const N = 317; // 317 × 317 ≈ 100 489 quads
    const verts = new Map<string, Vec3>();
    const faces = new Map<string, string[]>();
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) verts.set(`${i}_${j}`, [i, j, Math.sin(i * 0.1) * Math.cos(j * 0.1)]);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) faces.set(`f${i}_${j}`, [`${i}_${j}`, `${i + 1}_${j}`, `${i + 1}_${j + 1}`, `${i}_${j + 1}`]);
    const m: MeshData = { verts, faces };
    triangulate(m, { smooth: true, autoSmoothAngle: 30 }); // échauffement JIT
    const t0 = performance.now();
    const rm = triangulate(m, { smooth: true, autoSmoothAngle: 30 });
    const dt = performance.now() - t0;
    expect(rm.triFace.length).toBe(2 * N * N);
    expect(dt).toBeLessThan(1000);
  });
});
