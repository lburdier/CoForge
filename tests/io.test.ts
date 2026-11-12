import { beforeAll, describe, expect, it } from 'vitest';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { SceneDoc } from '../src/core/doc/SceneDoc';
import { MATERIAL_DEFAULTS, type MaterialData, type MeshData, type Vec3 } from '../src/core/doc/schema';
import { localMatrix } from '../src/core/doc/transforms';
import { newellNormal } from '../src/core/mesh/topology';
import { exportGLB, exportOBJ, importFile, parseOBJ, buildMeshData, convertTransform, Z_UP_TO_Y_UP, Y_UP_TO_Z_UP } from '../src/engine/io';
import type { ExportItem } from '../src/engine/io';

/** Cube unité centré, faces antihoraires vues de l'extérieur. */
function cube(): MeshData {
  const verts = new Map<string, Vec3>();
  const p: Vec3[] = [
    [-1, -1, -1],
    [1, -1, -1],
    [1, 1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
    [1, -1, 1],
    [1, 1, 1],
    [-1, 1, 1],
  ];
  p.forEach((v, i) => verts.set(`v${i}`, v));
  const quads = [
    [0, 3, 2, 1], // bas (−Z)
    [4, 5, 6, 7], // haut (+Z)
    [0, 1, 5, 4], // −Y
    [1, 2, 6, 5], // +X
    [2, 3, 7, 6], // +Y
    [3, 0, 4, 7], // −X
  ];
  const faces = new Map<string, string[]>();
  quads.forEach((q, i) => faces.set(`f${i}`, q.map((k) => `v${k}`)));
  return { verts, faces };
}

function material(over: Partial<MaterialData> = {}): MaterialData {
  return { id: 'm1', name: 'Acier', ...MATERIAL_DEFAULTS, ...over };
}

function worldPositions(mesh: MeshData, m: Matrix4): Vector3[] {
  return [...mesh.verts.values()].map((p) => new Vector3(...p).applyMatrix4(m));
}

/** Chaque point de `a` a un correspondant dans `b` (et réciproquement). */
function samePointSet(a: Vector3[], b: Vector3[], eps = 1e-5): boolean {
  if (a.length !== b.length) return false;
  return a.every((p) => b.some((q) => p.distanceTo(q) < eps)) && b.every((p) => a.some((q) => p.distanceTo(q) < eps));
}

/** Toutes les faces pointent vers l'extérieur (maillage convexe). */
function facesPointOutward(mesh: MeshData): boolean {
  const pts = [...mesh.verts.values()];
  const c = pts.reduce((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length, s[2] + p[2] / pts.length] as Vec3, [0, 0, 0] as Vec3);
  for (const loop of mesh.faces.values()) {
    const fp = loop.map((v) => mesh.verts.get(v)!);
    const n = newellNormal(fp);
    const fc = fp.reduce((s, p) => [s[0] + p[0] / fp.length, s[1] + p[1] / fp.length, s[2] + p[2] / fp.length] as Vec3, [0, 0, 0] as Vec3);
    const d = (fc[0] - c[0]) * n[0] + (fc[1] - c[1]) * n[1] + (fc[2] - c[2]) * n[2];
    if (d <= 0) return false;
  }
  return true;
}

function toArrayBuffer(text: string): ArrayBuffer {
  const u = new TextEncoder().encode(text);
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

// GLTFExporter (mode binaire) s'appuie sur FileReader, présent dans Electron mais pas dans Node.
beforeAll(() => {
  if (typeof (globalThis as any).FileReader === 'undefined') {
    class NodeFileReader {
      result: ArrayBuffer | string | null = null;
      onloadend: (() => void) | null = null;
      onload: (() => void) | null = null;
      readAsArrayBuffer(blob: Blob): void {
        void blob.arrayBuffer().then((buf) => {
          this.result = buf;
          this.onload?.();
          this.onloadend?.();
        });
      }
      readAsDataURL(blob: Blob): void {
        void blob.arrayBuffer().then((buf) => {
          this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`;
          this.onload?.();
          this.onloadend?.();
        });
      }
    }
    (globalThis as any).FileReader = NodeFileReader;
  }
});

describe('conversion de repère', () => {
  it('Z-up ↔ Y-up', () => {
    const up = new Vector3(0, 0, 1).applyMatrix4(Z_UP_TO_Y_UP);
    expect(up.x).toBeCloseTo(0, 9);
    expect(up.y).toBeCloseTo(1, 9);
    expect(up.z).toBeCloseTo(0, 9);
    const fwd = new Vector3(0, 1, 0).applyMatrix4(Z_UP_TO_Y_UP); // +Y (Z-up) → −Z (Y-up)
    expect(fwd.z).toBeCloseTo(-1, 9);
    const back = up.clone().applyMatrix4(Y_UP_TO_Z_UP);
    expect(back.z).toBeCloseTo(1, 9);
  });

  it('convertTransform est exactement inversible', () => {
    const m = localMatrix({ pos: [1, 2, 3], rot: [0.3, -0.2, 1.1], scl: [1, 2, 0.5] });
    const y = convertTransform(m, true);
    const z = convertTransform(y, false);
    for (let i = 0; i < 16; i++) expect(z.elements[i]).toBeCloseTo(m.elements[i], 9);
    // un point monde converti correspond au point converti par la matrice convertie
    const p = new Vector3(0.5, -0.25, 2);
    const viaZ = p.clone().applyMatrix4(m).applyMatrix4(Z_UP_TO_Y_UP);
    const viaY = p.clone().applyMatrix4(Z_UP_TO_Y_UP).applyMatrix4(y);
    expect(viaZ.distanceTo(viaY)).toBeLessThan(1e-9);
  });
});

describe('soudure des sommets', () => {
  it('soude les sommets confondus et retire les faces dégénérées ou en double', () => {
    // deux triangles d'un quad, sommets dupliqués (comme une géométrie non indexée)
    const pos = [0, 0, 0, 1, 0, 0, 1, 1, 0, /**/ 0, 0, 0, 1, 1, 0, 0, 1, 0, /**/ 0, 0, 0, 1e-7, 0, 0, 1, 1, 0];
    const m = buildMeshData(pos, [
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8], // dégénéré après soudure (0 ≈ 7)
      [5, 3, 4], // doublon du deuxième
    ]);
    expect(m.verts.size).toBe(4);
    expect(m.faces.size).toBe(2);
    for (const loop of m.faces.values()) expect(new Set(loop).size).toBe(3);
  });
});

describe('OBJ', () => {
  it('aller-retour export → import d’un cube : 8 sommets, 6 faces, mêmes positions', async () => {
    const mesh = cube();
    const matrixWorld = localMatrix({ pos: [1, 2, 3], rot: [0.4, 0.1, -0.7], scl: [1, 1.5, 0.5] });
    const item: ExportItem = { name: 'Cube', mesh, matrixWorld, material: material(), smooth: false, autoSmoothAngle: 30 };
    const text = exportOBJ([item]);
    expect(text).toMatch(/^o Cube$/m);
    expect(text).toMatch(/^usemtl Acier$/m);
    expect((text.match(/^f /gm) ?? []).length).toBe(6);
    expect((text.match(/^f \d+ \d+ \d+ \d+$/gm) ?? []).length).toBe(6); // quads conservés

    const doc = SceneDoc.createEmpty();
    const ids = await importFile(doc, 'cube.obj', toArrayBuffer(text));
    expect(ids).toHaveLength(1);
    const obj = doc.getObject(ids[0])!;
    expect(obj.type).toBe('mesh');
    expect(obj.name).toBe('Cube');
    const imported = doc.getMesh(obj.data!)!;
    expect(imported.verts.size).toBe(8);
    expect(imported.faces.size).toBe(6);
    for (const loop of imported.faces.values()) expect(loop).toHaveLength(4);
    // OBJ : sommets en coordonnées monde, objet à l'identité
    expect(obj.pos).toEqual([0, 0, 0]);
    const expected = worldPositions(mesh, matrixWorld);
    const got = [...imported.verts.values()].map((p) => new Vector3(...p));
    expect(samePointSet(expected, got, 1e-5)).toBe(true);
    expect(facesPointOutward(imported)).toBe(true);
    // matériau recréé par son nom
    expect(doc.getMaterial(obj.material!)?.name).toBe('Acier');
    // une seule étape d'annulation
    doc.undo();
    expect(doc.listObjects()).toHaveLength(0);
  });

  it('conserve le sens des faces sous une transformation miroir', async () => {
    const item: ExportItem = {
      name: 'Miroir',
      mesh: cube(),
      matrixWorld: new Matrix4().makeScale(-1, 1, 1),
      material: null,
      smooth: true,
      autoSmoothAngle: 30,
    };
    const text = exportOBJ([item]);
    expect(text).toMatch(/^s 1$/m);
    const doc = SceneDoc.createEmpty();
    const [id] = await importFile(doc, 'miroir.obj', toArrayBuffer(text));
    const obj = doc.getObject(id)!;
    expect(obj.shadeSmooth).toBe(true);
    expect(facesPointOutward(doc.getMesh(obj.data!)!)).toBe(true);
  });

  it('lit les variantes de syntaxe (v/vt/vn, indices négatifs, groupes, matériaux)', () => {
    const src = [
      '# test',
      'mtllib a.mtl',
      'o A',
      'v 0 0 0',
      'v 1 0 0',
      'v 1 1 0',
      'v 0 1 0',
      'vt 0 0',
      'vn 0 0 1',
      'usemtl Rouge',
      'f 1/1/1 2/1/1 3/1/1 4/1/1',
      'usemtl Bleu',
      'f -4//1 -2//1 -1//1',
      'g B',
      'f 1 2 \\',
      '  3',
    ].join('\r\n');
    const p = parseOBJ(src);
    expect(p.positions.length).toBe(12);
    expect(p.chunks.map((c) => [c.name, c.material, c.faces.length])).toEqual([
      ['A', 'Rouge', 1],
      ['A', 'Bleu', 1],
      ['B', 'Bleu', 1],
    ]);
    expect(p.chunks[0].faces[0]).toEqual([0, 1, 2, 3]);
    expect(p.chunks[1].faces[0]).toEqual([0, 2, 3]);
    expect(p.chunks[2].faces[0]).toEqual([0, 1, 2]);
  });

  it('rejette un format inconnu', async () => {
    const doc = SceneDoc.createEmpty();
    await expect(importFile(doc, 'image.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer)).rejects.toThrow(/non pris en charge/);
  });
});

describe('glTF binaire', () => {
  it('aller-retour export → import : transformation, sommets soudés, matériau PBR', async () => {
    const mesh = cube();
    const pos: Vec3 = [1, 2, 3];
    const rot: Vec3 = [0.3, 0.2, 0.1];
    const scl: Vec3 = [1, 2, 1];
    const matrixWorld = localMatrix({ pos, rot, scl });
    const mat = material({ baseColor: '#ff8000', metallic: 0.7, roughness: 0.2, emission: '#00ff00', emissionStrength: 2 });
    const glb = await exportGLB([{ name: 'Cube', mesh, matrixWorld, material: mat, smooth: false, autoSmoothAngle: 30 }]);
    expect(glb.byteLength).toBeGreaterThan(100);
    // signature « glTF »
    expect(new TextDecoder().decode(new Uint8Array(glb, 0, 4))).toBe('glTF');

    const doc = SceneDoc.createEmpty();
    const ids = await importFile(doc, 'cube.glb', glb);
    expect(ids).toHaveLength(1);
    const obj = doc.getObject(ids[0])!;
    expect(obj.name).toBe('Cube');
    expect(obj.shadeSmooth).toBe(false);
    for (let i = 0; i < 3; i++) {
      expect(obj.pos[i]).toBeCloseTo(pos[i], 5);
      expect(obj.scl[i]).toBeCloseTo(scl[i], 5);
    }
    // rotation : comparaison par quaternion (plusieurs triplets d'Euler sont équivalents)
    const qa = new Quaternion().setFromEuler(new Euler(...rot, 'XYZ'));
    const qb = new Quaternion().setFromEuler(new Euler(...obj.rot, 'XYZ'));
    expect(Math.abs(qa.dot(qb))).toBeCloseTo(1, 6);

    const imported = doc.getMesh(obj.data!)!;
    expect(imported.verts.size).toBe(8); // 36 sommets de triangles soudés
    expect(imported.faces.size).toBe(12); // triangles
    // mêmes positions locales que le cube d'origine (repère local reconverti en Z-up)
    expect(samePointSet(worldPositions(mesh, new Matrix4()), worldPositions(imported, new Matrix4()), 1e-5)).toBe(true);
    expect(facesPointOutward(imported)).toBe(true);

    const m = doc.getMaterial(obj.material!)!;
    expect(m.name).toBe('Acier');
    expect(m.baseColor).toBe('#ff8000');
    expect(m.metallic).toBeCloseTo(0.7, 5);
    expect(m.roughness).toBeCloseTo(0.2, 5);
    expect(m.emission).toBe('#00ff00');
    expect(m.emissionStrength).toBeCloseTo(2, 5);
  });

  it('exporte un ombrage lisse détecté à la réimportation', async () => {
    // cube biseauté approximé : avec un angle de lissage de 180°, toutes les normales sont moyennées
    const glb = await exportGLB([{ name: 'Lisse', mesh: cube(), matrixWorld: new Matrix4(), material: null, smooth: true, autoSmoothAngle: 180 }]);
    const doc = SceneDoc.createEmpty();
    const [id] = await importFile(doc, 'lisse.glb', glb);
    expect(doc.getObject(id)!.shadeSmooth).toBe(true);
  });

  it('détecte le format sans extension', async () => {
    const glb = await exportGLB([{ name: 'X', mesh: cube(), matrixWorld: new Matrix4(), material: null, smooth: false, autoSmoothAngle: 30 }]);
    const doc = SceneDoc.createEmpty();
    const ids = await importFile(doc, 'sans_extension', glb);
    expect(ids).toHaveLength(1);
  });
});

describe('rendu (parties testables sans GPU)', () => {
  it('le module se charge sous Node et expose le contrat', async () => {
    const r = await import('../src/engine/render');
    expect(typeof r.RenderPipeline).toBe('function');
    expect(typeof r.renderFinalImage).toBe('function');
    expect(r.exposureOf({ exposure: 1 })).toBeCloseTo(2, 9);
    expect(r.exposureOf({ exposure: -2 })).toBeCloseTo(0.25, 9);
  });

  it('la caméra du rendu final suit le rapport de l’image sans modifier l’originale', async () => {
    const { PerspectiveCamera, OrthographicCamera } = await import('three');
    const { cameraForAspect } = await import('../src/engine/render/finalImage');
    const cam = new PerspectiveCamera(40, 1, 0.1, 100);
    cam.up.set(0, 0, 1);
    cam.position.set(5, -5, 3);
    cam.lookAt(0, 0, 0);
    const c = cameraForAspect(cam, 16 / 9) as InstanceType<typeof PerspectiveCamera>;
    expect(c.aspect).toBeCloseTo(16 / 9, 9);
    expect(cam.aspect).toBe(1);
    c.updateMatrixWorld();
    for (let i = 0; i < 16; i++) expect(c.matrixWorld.elements[i]).toBeCloseTo(cam.matrixWorld.elements[i], 9);
    const o = new OrthographicCamera(-3, 3, 2, -2, 0.1, 100);
    const oc = cameraForAspect(o, 2) as InstanceType<typeof OrthographicCamera>;
    expect(oc.top - oc.bottom).toBeCloseTo(4, 9);
    expect(oc.right - oc.left).toBeCloseTo(8, 9);
  });
});
