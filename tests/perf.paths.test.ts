import { describe, expect, it } from 'vitest';
import { SceneDoc } from '../src/core/doc/SceneDoc';
import type { MeshData, Vec3 } from '../src/core/doc/schema';
import { createPrimitive } from '../src/core/mesh/primitives';
import { triangulate } from '../src/core/mesh/triangulate';
import { computeOutlineNormals } from '../src/engine/geometryPool';

/** Copie profonde : nouvelles tables (aucun cache de topologie ne peut la reconnaître). */
function fresh(m: MeshData): MeshData {
  return {
    verts: new Map([...m.verts].map(([k, p]) => [k, [p[0], p[1], p[2]] as Vec3])),
    faces: new Map([...m.faces].map(([k, l]) => [k, [...l]])),
  };
}

/** Ancienne implémentation (clés texte), référence pour la nouvelle. */
function outlineNormalsReference(positions: Float32Array, normals: Float32Array): Float32Array {
  const n = positions.length / 3;
  const out = new Float32Array(positions.length);
  const groups = new Map<string, number[]>();
  const q = (v: number) => Math.round(v * 1e4);
  for (let i = 0; i < n; i++) {
    const key = `${q(positions[i * 3])},${q(positions[i * 3 + 1])},${q(positions[i * 3 + 2])}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(i);
  }
  for (const g of groups.values()) {
    let x = 0;
    let y = 0;
    let z = 0;
    const seen: number[][] = [];
    for (const i of g) {
      const nx = normals[i * 3];
      const ny = normals[i * 3 + 1];
      const nz = normals[i * 3 + 2];
      if (seen.some((s) => Math.abs(s[0] - nx) < 1e-4 && Math.abs(s[1] - ny) < 1e-4 && Math.abs(s[2] - nz) < 1e-4)) continue;
      seen.push([nx, ny, nz]);
      x += nx;
      y += ny;
      z += nz;
    }
    const len = Math.hypot(x, y, z) || 1;
    for (const i of g) {
      out[i * 3] = x / len;
      out[i * 3 + 1] = y / len;
      out[i * 3 + 2] = z / len;
    }
  }
  return out;
}

describe('chemins rapides (déplacement de sommets)', () => {
  it("SceneDoc : instantané incrémental, table des faces réutilisée, positions exactes", () => {
    const doc = SceneDoc.createEmpty();
    const id = doc.createMesh(createPrimitive('cube', {}), 'Cube');
    doc.clearHistory();
    const before = doc.getMesh(id)!;
    const vid = [...before.verts.keys()][0];
    doc.setMeshVerts(id, { [vid]: [9, 8, 7] });
    const after = doc.getMesh(id)!;
    expect(after).not.toBe(before);
    expect(after.faces).toBe(before.faces);
    expect(after.verts.get(vid)).toEqual([9, 8, 7]);
    expect(before.verts.get(vid)).not.toEqual([9, 8, 7]); // l'ancien instantané est intact
    // Un changement de topologie produit une nouvelle table des faces.
    const fid = [...after.faces.keys()][0];
    doc.applyMeshDelta(id, { delFaces: [fid] });
    const topo = doc.getMesh(id)!;
    expect(topo.faces).not.toBe(after.faces);
    expect(topo.faces.has(fid)).toBe(false);
    // Annulation : retour à l'état d'origine.
    while (doc.canUndo()) doc.undo();
    const restored = doc.getMesh(id)!;
    expect(restored.verts.get(vid)).toEqual(before.verts.get(vid));
    expect(restored.faces.has(fid)).toBe(true);
  });

  for (const smooth of [false, true]) {
    it(`triangulate en cache = triangulate à neuf (${smooth ? 'lisse' : 'plat'})`, () => {
      const base = createPrimitive('uvsphere', { segments: 24, rings: 12 });
      const opts = { smooth, autoSmoothAngle: 40 };
      triangulate(base, opts); // remplit le cache de topologie
      // Même table des faces, positions déplacées : chemin rapide.
      const moved: MeshData = { verts: new Map(base.verts), faces: base.faces };
      let k = 0;
      for (const [vid, p] of moved.verts) moved.verts.set(vid, [p[0] + (k++ % 3) * 0.1, p[1] * 1.5, p[2] - 0.2]);
      const a = triangulate(moved, opts);
      const b = triangulate(fresh(moved), opts);
      expect(a.positions).toEqual(b.positions);
      expect(a.normals).toEqual(b.normals);
      expect(a.triFace).toEqual(b.triFace);
      expect(a.edgePositions).toEqual(b.edgePositions);
      expect(a.edgeKeys).toEqual(b.edgeKeys);
    });
  }

  it('triangulate : table des faces réutilisée avec d\'autres sommets → reconstruction correcte', () => {
    const base = createPrimitive('cube', {});
    triangulate(base, { smooth: false, autoSmoothAngle: 30 });
    // Même faces, mais un sommet de plus (ordre/ensemble différent) : le cache doit être ignoré.
    const extra: MeshData = { verts: new Map([['zz', [5, 5, 5] as Vec3], ...base.verts]), faces: base.faces };
    expect(triangulate(extra, { smooth: false, autoSmoothAngle: 30 }).positions).toEqual(
      triangulate(fresh(extra), { smooth: false, autoSmoothAngle: 30 }).positions,
    );
  });

  it('computeOutlineNormals = ancienne implémentation', () => {
    for (const kind of ['cube', 'uvsphere', 'cylinder', 'torus'] as const) {
      for (const smooth of [false, true]) {
        const rm = triangulate(createPrimitive(kind, {}), { smooth, autoSmoothAngle: 30 });
        const got = computeOutlineNormals(rm.positions, rm.normals);
        const ref = outlineNormalsReference(rm.positions, rm.normals);
        expect(got.length).toBe(ref.length);
        for (let i = 0; i < got.length; i++) expect(got[i]).toBeCloseTo(ref[i], 5);
      }
    }
  });
});
