import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { SceneDoc } from '../src/core/doc/SceneDoc';
import { worldMatrix } from '../src/core/doc/transforms';
import { applyImportedScene, importScene, readScene } from '../src/engine/io';
import type { ImportedObject, ImportedScene } from '../src/engine/io';
import { linearToHex } from '../src/engine/io/convert';
import { readFBXScene } from '../src/engine/io/fbx';
import { readGLTFScene } from '../src/engine/io/gltfScene';
import { readOBJScene } from '../src/engine/io/objScene';

/**
 * Lecteurs glTF / OBJ / FBX / STL / PLY / Collada vers le format neutre.
 *
 * Deux familles de fichiers :
 *  - construits ici, octet par octet, pour viser un cas précis ;
 *  - fixtures RÉELLES exportées par Blender 5.1 (tests/fixtures/formats/blender_*, fabriquées par
 *    make_fixtures.py dans le même dossier) avec leur vérité `blender_scene.json` : matrices
 *    monde, comptes, matériaux, lumières et caméras tels que Blender les connaît.
 */

const FIXTURES = resolve(__dirname, 'fixtures/formats');

function fixture(name: string): ArrayBuffer {
  const b = readFileSync(resolve(FIXTURES, name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

function bytesOf(text: string): ArrayBuffer {
  const u = new TextEncoder().encode(text);
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

interface TruthObject {
  name: string;
  type: 'MESH' | 'EMPTY' | 'LIGHT' | 'CAMERA';
  parent: string | null;
  matrix_world: number[];
  verts?: number;
  polys?: number;
  tris?: number;
  poly_sizes?: number[];
  materials?: (string | null)[];
  slot_polys?: number[];
  slot_tris?: number[];
  smooth?: boolean;
  world_verts?: number[][];
  light?: { type: string; energy: number; color: number[]; spot_size_deg?: number; spot_blend?: number };
  camera?: { type: string; clip_start: number; clip_end: number; vfov_deg?: number; ortho_scale?: number; ortho_height?: number };
  aim?: number[];
  up?: number[];
}
interface TruthMaterial {
  name: string;
  base_color_linear: number[];
  metallic: number;
  roughness: number;
  emission_linear: number[];
  emission_strength: number;
  alpha: number;
  transmission: number;
  ior: number;
}
const truth: { blender: string; objects: TruthObject[]; materials: TruthMaterial[] } = JSON.parse(
  readFileSync(resolve(FIXTURES, 'blender_scene.json'), 'utf8'),
);
const truthObject = (name: string): TruthObject => truth.objects.find((o) => o.name === name)!;
const truthMaterial = (name: string): TruthMaterial => truth.materials.find((m) => m.name === name)!;
const TYPE_OF: Record<TruthObject['type'], ImportedObject['type']> = { MESH: 'mesh', EMPTY: 'empty', LIGHT: 'light', CAMERA: 'camera' };

/** Matrice de Blender (16 valeurs ligne par ligne) → Matrix4. */
function fromRows(m: number[]): Matrix4 {
  return new Matrix4().set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11], m[12], m[13], m[14], m[15]);
}

function expectMatrix(actual: Matrix4, expected: Matrix4, eps = 1e-4): void {
  for (let i = 0; i < 16; i++) {
    expect(Math.abs(actual.elements[i] - expected.elements[i]), `élément ${i} : ${actual.elements[i]} ≠ ${expected.elements[i]}`).toBeLessThan(eps);
  }
}

function expectVector(actual: Vector3, expected: number[], eps = 1e-4): void {
  expect(actual.distanceTo(new Vector3(expected[0], expected[1], expected[2])), `${actual.toArray()} ≠ ${expected}`).toBeLessThan(eps);
}

/** Chaque point de `a` a un correspondant dans `b`, et réciproquement. */
function samePoints(a: Vector3[], b: Vector3[], eps = 1e-4): boolean {
  if (a.length === 0 || b.length === 0) return false;
  return a.every((p) => b.some((q) => p.distanceTo(q) < eps)) && b.every((p) => a.some((q) => p.distanceTo(q) < eps));
}

const points = (list: number[][]): Vector3[] => list.map((p) => new Vector3(p[0], p[1], p[2]));

function objectNamed(scene: ImportedScene, name: string): ImportedObject {
  const o = scene.objects.find((x) => x.name === name);
  expect(o, `objet « ${name} » absent`).toBeDefined();
  return o!;
}

/** Sommets d'un objet importé, en coordonnées monde. */
function importedWorldPoints(scene: ImportedScene, o: ImportedObject): Vector3[] {
  const mesh = scene.meshes[o.mesh!];
  const out: Vector3[] = [];
  const used = new Set<number>();
  for (const poly of mesh.polygons) for (let k = 0; k < poly.length; k++) used.add(poly[k]);
  for (const i of used) out.push(new Vector3(mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]).applyMatrix4(o.matrixWorld));
  return out;
}

/** Sommets d'un objet du document, en coordonnées monde. */
function docWorldPoints(doc: SceneDoc, id: string): Vector3[] {
  const obj = doc.getObject(id)!;
  const m = worldMatrix(doc, id);
  return [...doc.getMesh(obj.data!)!.verts.values()].map((p) => new Vector3(p[0], p[1], p[2]).applyMatrix4(m));
}

function docObject(doc: SceneDoc, name: string) {
  const o = doc.listObjects().find((x) => x.name === name);
  expect(o, `objet « ${name} » absent du document`).toBeDefined();
  return o!;
}

const aimOf = (m: Matrix4): Vector3 => new Vector3(0, 0, -1).transformDirection(m);
const upOf = (m: Matrix4): Vector3 => new Vector3(0, 1, 0).transformDirection(m);
const polygonSizes = (scene: ImportedScene, o: ImportedObject): number[] => scene.meshes[o.mesh!].polygons.map((p) => p.length).sort((a, b) => a - b);

/** Nombre de polygones par nom de matériau d'un objet importé. */
function polygonsByMaterial(scene: ImportedScene, o: ImportedObject): Record<string, number> {
  const mesh = scene.meshes[o.mesh!];
  const out: Record<string, number> = {};
  for (let i = 0; i < mesh.polygons.length; i++) {
    const slot = mesh.polygonSlots ? mesh.polygonSlots[i] : 0;
    const mat = o.materials?.[slot];
    const name = mat === null || mat === undefined ? '(aucun)' : scene.materials[mat].name;
    out[name] = (out[name] ?? 0) + 1;
  }
  return out;
}

// ------------------------------------------------------------------ fabrique de GLB

type Typed = Float32Array | Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array;
const COMPONENT: [new (...a: any[]) => Typed, number][] = [
  [Float32Array, 5126],
  [Uint32Array, 5125],
  [Uint16Array, 5123],
  [Int16Array, 5122],
  [Uint8Array, 5121],
  [Int8Array, 5120],
];

/** Assemble un glTF : les accesseurs sont ajoutés un à un, le tampon binaire est construit autour. */
class GltfBuilder {
  private chunks: Uint8Array[] = [];
  private length = 0;
  readonly bufferViews: any[] = [];
  readonly accessors: any[] = [];

  view(data: Typed, extra: Record<string, unknown> = {}): number {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.chunks.push(new Uint8Array(pad));
      this.length += pad;
    }
    this.bufferViews.push({ buffer: 0, byteOffset: this.length, byteLength: bytes.byteLength, ...extra });
    this.chunks.push(bytes);
    this.length += bytes.byteLength;
    return this.bufferViews.length - 1;
  }

  accessor(data: Typed, type: 'SCALAR' | 'VEC3' | 'VEC4', extra: Record<string, unknown> = {}): number {
    const size = type === 'SCALAR' ? 1 : type === 'VEC3' ? 3 : 4;
    const componentType = COMPONENT.find(([ctor]) => data instanceof ctor)![1];
    this.accessors.push({ bufferView: this.view(data), componentType, count: data.length / size, type, ...extra });
    return this.accessors.length - 1;
  }

  private binary(): Uint8Array {
    const out = new Uint8Array(this.length + ((4 - (this.length % 4)) % 4));
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.byteLength;
    }
    return out;
  }

  private json(doc: Record<string, unknown>, uri?: string): Record<string, unknown> {
    const bin = this.binary();
    return {
      asset: { version: '2.0', generator: 'tests CoForge' },
      ...doc,
      buffers: [uri === undefined ? { byteLength: bin.byteLength } : { byteLength: bin.byteLength, uri }],
      bufferViews: this.bufferViews,
      accessors: this.accessors,
    };
  }

  glb(doc: Record<string, unknown>): ArrayBuffer {
    const bin = this.binary();
    let json = new TextEncoder().encode(JSON.stringify(this.json(doc)));
    const padded = new Uint8Array(json.byteLength + ((4 - (json.byteLength % 4)) % 4)).fill(0x20);
    padded.set(json);
    json = padded;
    const total = 12 + 8 + json.byteLength + 8 + bin.byteLength;
    const out = new ArrayBuffer(total);
    const dv = new DataView(out);
    dv.setUint32(0, 0x46546c67, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, json.byteLength, true);
    dv.setUint32(16, 0x4e4f534a, true);
    new Uint8Array(out, 20, json.byteLength).set(json);
    dv.setUint32(20 + json.byteLength, bin.byteLength, true);
    dv.setUint32(24 + json.byteLength, 0x004e4942, true);
    new Uint8Array(out, 28 + json.byteLength, bin.byteLength).set(bin);
    return out;
  }

  /** .gltf texte autonome (tampon en URI data:). */
  text(doc: Record<string, unknown>): string {
    return JSON.stringify(this.json(doc, `data:application/octet-stream;base64,${Buffer.from(this.binary()).toString('base64')}`));
  }

  /** .gltf texte qui renvoie à un fichier .bin voisin. */
  external(doc: Record<string, unknown>): string {
    return JSON.stringify(this.json(doc, 'geometrie.bin'));
  }
}

/** Candelas qui donnent `watts` après conversion (règle de Blender : W = cd × 4π / 683). */
const candela = (watts: number): number => (watts * 683) / (4 * Math.PI);

/** Rotation glTF (quaternion x, y, z, w) d'un angle en degrés autour d'un axe. */
function quat(axis: [number, number, number], degrees: number): number[] {
  return new Quaternion().setFromAxisAngle(new Vector3(...axis), (degrees * Math.PI) / 180).toArray();
}

/** Point exprimé en Y-up (glTF) → Z-up (CoForge). */
const zUp = (x: number, y: number, z: number): Vector3 => new Vector3(x, -z, y);

/**
 * Scène de référence : hiérarchie, maillage partagé à deux primitives (triangles indexés +
 * bande sans indices), éventail, lignes ignorées, lumières, caméras, nœud cumulant maillage
 * et caméra, deux scènes, une animation.
 */
function referenceGltf(): { builder: GltfBuilder; doc: Record<string, unknown> } {
  const b = new GltfBuilder();
  // Primitive 0 : quad dans le plan XY (Y-up), deux triangles indexés + deux triangles dégénérés.
  const quadPos = b.accessor(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), 'VEC3', { min: [0, 0, 0], max: [1, 1, 0] });
  const quadIdx = b.accessor(new Uint16Array([0, 1, 2, 0, 2, 3, /* dégénérés */ 0, 0, 1, 1, 1, 1]), 'SCALAR');
  // Primitive 1 : bande de 4 sommets sans indices, dans le plan z = 1.
  const stripPos = b.accessor(new Float32Array([0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1]), 'VEC3');
  // Éventail de 5 sommets (pentagone) sans indices, et une primitive de lignes.
  const fanPos = b.accessor(new Float32Array([0, 0, 0, 2, 0, 0, 3, 1, 0, 1, 2, 0, -1, 1, 0]), 'VEC3');
  const doc = {
    scene: 0,
    scenes: [
      { name: 'Principale', nodes: [0, 3, 4, 6, 7, 8, 9] },
      { name: 'Annexe', nodes: [10] },
    ],
    nodes: [
      /* 0 */ { name: 'Racine', translation: [1, 2, 3], rotation: quat([0, 1, 0], 90), children: [1, 2, 5] },
      /* 1 */ { name: 'A', mesh: 0, translation: [2, 0, 0] },
      /* 2 */ { name: 'B', mesh: 0, scale: [2, 2, 2] },
      /* 3 */ { name: 'Lampe', translation: [0, 5, 0], extensions: { KHR_lights_punctual: { light: 0 } } },
      /* 4 */ { name: 'Cam', camera: 0, translation: [0, 10, 0], rotation: quat([1, 0, 0], -90) },
      /* 5 */ { name: 'Spot', translation: [0, 0, 4], rotation: quat([1, 0, 0], -90), extensions: { KHR_lights_punctual: { light: 1 } } },
      /* 6 */ { name: 'Soleil', extensions: { KHR_lights_punctual: { light: 2 } } },
      /* 7 */ { name: 'Ortho', camera: 1 },
      /* 8 */ { name: 'Eventail', mesh: 1, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1] },
      /* 9 */ { name: 'Mixte', mesh: 1, camera: 0, translation: [0, 0, -3] },
      /* 10 */ { name: 'Hors scène', mesh: 1 },
    ],
    meshes: [
      {
        name: 'Deux matières',
        primitives: [
          { attributes: { POSITION: quadPos }, indices: quadIdx, material: 0 },
          { attributes: { POSITION: stripPos }, mode: 5, material: 1 },
        ],
      },
      {
        name: 'Pentagone',
        primitives: [
          { attributes: { POSITION: fanPos }, mode: 6 },
          { attributes: { POSITION: fanPos }, mode: 1 },
        ],
      },
    ],
    materials: [
      {
        name: 'Or',
        pbrMetallicRoughness: { baseColorFactor: [1, 0.5, 0, 1], metallicFactor: 1, roughnessFactor: 0.2 },
        emissiveFactor: [1, 0, 0],
        extensions: { KHR_materials_emissive_strength: { emissiveStrength: 3 } },
      },
      {
        name: 'Verre',
        alphaMode: 'BLEND',
        pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 0.5], metallicFactor: 0 },
        extensions: { KHR_materials_transmission: { transmissionFactor: 0.8 }, KHR_materials_ior: { ior: 1.33 } },
      },
    ],
    cameras: [
      { name: 'Persp', type: 'perspective', perspective: { yfov: 0.5, znear: 0.25, zfar: 80, aspectRatio: 1.5 } },
      { name: 'Plan', type: 'orthographic', orthographic: { xmag: 4, ymag: 2.5, znear: 0.1, zfar: 30 } },
    ],
    extensionsUsed: ['KHR_lights_punctual', 'KHR_materials_emissive_strength', 'KHR_materials_transmission', 'KHR_materials_ior'],
    extensions: {
      KHR_lights_punctual: {
        lights: [
          { name: 'Ampoule', type: 'point', color: [1, 0.5, 0.25], intensity: candela(100) },
          { name: 'Projecteur', type: 'spot', intensity: candela(250), spot: { innerConeAngle: 0.2, outerConeAngle: 0.4 } },
          { name: 'Soleil', type: 'directional', intensity: 683 * 2 },
        ],
      },
    },
    animations: [{ channels: [], samplers: [] }],
  };
  return { builder: b, doc };
}

// ================================================================== glTF construit ici

describe('glTF - fichier construit dans le test', () => {
  const { builder, doc } = referenceGltf();
  const glb = builder.glb(doc);

  it('hiérarchie, types et matrices monde (Y-up → Z-up)', async () => {
    const s = await readGLTFScene(glb, 'reference.glb');
    expect(s.name).toBe('Principale');
    // 10 nœuds de la scène par défaut + la caméra du nœud « Mixte » ; « Hors scène » n'y est pas.
    expect(s.objects.map((o) => [o.name, o.type])).toEqual([
      ['Racine', 'empty'],
      ['A', 'mesh'],
      ['B', 'mesh'],
      ['Spot', 'light'],
      ['Lampe', 'light'],
      ['Cam', 'camera'],
      ['Soleil', 'light'],
      ['Ortho', 'camera'],
      ['Eventail', 'mesh'],
      ['Mixte', 'mesh'],
      ['Mixte (caméra)', 'camera'],
    ]);
    const parentName = (o: ImportedObject) => (o.parent === null ? null : s.objects[o.parent].name);
    expect(parentName(objectNamed(s, 'A'))).toBe('Racine');
    expect(parentName(objectNamed(s, 'B'))).toBe('Racine');
    expect(parentName(objectNamed(s, 'Spot'))).toBe('Racine');
    expect(parentName(objectNamed(s, 'Racine'))).toBeNull();
    expect(parentName(objectNamed(s, 'Mixte (caméra)'))).toBe('Mixte');

    // Racine : translation (1, 2, 3) en Y-up = (1, −3, 2) en Z-up ; rotation de 90° autour de la
    // verticale : l'axe X local part vers −Z (Y-up), soit +Y (Z-up).
    const racine = objectNamed(s, 'Racine').matrixWorld;
    expectVector(new Vector3().setFromMatrixPosition(racine), [1, -3, 2]);
    expectVector(new Vector3(1, 0, 0).transformDirection(racine), [0, 1, 0]);
    expectVector(new Vector3(0, 0, 1).transformDirection(racine), [0, 0, 1]);

    // Sommets monde, calculés à la main depuis les données du fichier (indépendamment du lecteur) :
    // monde Y-up = Racine · locale · p, avec Racine = T(1,2,3) · R_y(90°) : (x, y, z) → (z + 1, y + 2, −x + 3).
    const racineYUp = (x: number, y: number, z: number): Vector3 => zUp(z + 1, y + 2, -x + 3);
    const local = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
      [0, 0, 1],
      [1, 0, 1],
      [0, 1, 1],
      [1, 1, 1],
    ];
    const a = objectNamed(s, 'A');
    expect(samePoints(importedWorldPoints(s, a), local.map(([x, y, z]) => racineYUp(x + 2, y, z)))).toBe(true);
    const bObj = objectNamed(s, 'B');
    expect(samePoints(importedWorldPoints(s, bObj), local.map(([x, y, z]) => racineYUp(2 * x, 2 * y, 2 * z)))).toBe(true);
    // Nœud donné par une matrice : translation (5, 6, 7) en Y-up.
    const fan = objectNamed(s, 'Eventail');
    expect(
      samePoints(
        importedWorldPoints(s, fan),
        [
          [0, 0, 0],
          [2, 0, 0],
          [3, 1, 0],
          [1, 2, 0],
          [-1, 1, 0],
        ].map(([x, y, z]) => zUp(x + 5, y + 6, z + 7)),
      ),
    ).toBe(true);
  });

  it('maillage partagé, primitives multiples, bande, éventail, triangles dégénérés', async () => {
    const s = await readGLTFScene(glb, 'reference.glb');
    const a = objectNamed(s, 'A');
    const b = objectNamed(s, 'B');
    expect(a.mesh).toBe(b.mesh); // même indice glTF → même ImportedMesh
    expect(objectNamed(s, 'Eventail').mesh).toBe(objectNamed(s, 'Mixte').mesh);
    expect(s.meshes).toHaveLength(2);
    const two = s.meshes[a.mesh!];
    expect(two.name).toBe('Deux matières');
    expect(two.weld).toBe(true);
    // 2 triangles indexés (les 2 dégénérés sont écartés) + 2 triangles de bande.
    expect(two.polygons).toHaveLength(4);
    expect(Array.from(two.polygonSlots!)).toEqual([0, 0, 1, 1]);
    expect(a.materials!.map((m) => s.materials[m!].name)).toEqual(['Or', 'Verre']);
    expect(polygonsByMaterial(s, a)).toEqual({ Or: 2, Verre: 2 });
    // Bande : le deuxième triangle est retourné, toutes les normales pointent du même côté.
    // Plan XY en Y-up, sens antihoraire → normale +Z (Y-up) = −Y (Z-up).
    for (const poly of two.polygons) {
      const [p0, p1, p2] = [0, 1, 2].map((k) => new Vector3(two.positions[poly[k] * 3], two.positions[poly[k] * 3 + 1], two.positions[poly[k] * 3 + 2]));
      const n = p1.sub(p0).cross(p2.sub(p0)).normalize();
      expectVector(n, [0, -1, 0]);
    }
    // Éventail de 5 sommets : 3 triangles ; la primitive de lignes est ignorée et signalée.
    const fan = s.meshes[objectNamed(s, 'Eventail').mesh!];
    expect(fan.polygons).toHaveLength(3);
    expect(fan.polygonSlots).toBeUndefined();
    expect(objectNamed(s, 'Eventail').materials).toEqual([null]);
    expect(s.warnings.some((w) => /1 primitive de points ou de lignes ignorée/.test(w))).toBe(true);
  });

  it('matériaux PBR, émission, transmission, indice, alpha', async () => {
    const s = await readGLTFScene(glb, 'reference.glb');
    expect(s.materials.map((m) => m.name)).toEqual(['Or', 'Verre']);
    const [or, verre] = s.materials;
    expect(or.baseColor).toBe(linearToHex(1, 0.5, 0));
    expect(or.baseColor).toBe('#ffbc00');
    expect(or.metallic).toBe(1);
    expect(or.roughness).toBeCloseTo(0.2, 9);
    expect(or.emission).toBe('#ff0000');
    expect(or.emissionStrength).toBe(3);
    expect(or.alpha).toBe(1);
    expect(or.transmission).toBe(0);
    expect(or.ior).toBe(1.5); // valeur de glTF sans KHR_materials_ior
    expect(verre.alpha).toBe(0.5);
    expect(verre.roughness).toBe(1); // facteur absent : 1 par défaut en glTF
    expect(verre.emission).toBe('#000000');
    expect(verre.emissionStrength).toBe(0);
    expect(verre.transmission).toBeCloseTo(0.8, 9);
    expect(verre.ior).toBeCloseTo(1.33, 9);
  });

  it('lumières : conversion candela / lux → watts, cône, orientation −Z', async () => {
    const s = await readGLTFScene(glb, 'reference.glb');
    const lampe = objectNamed(s, 'Lampe');
    expect(lampe.light).toMatchObject({ kind: 'point', color: linearToHex(1, 0.5, 0.25) });
    expect(lampe.light!.power).toBeCloseTo(100, 6);
    expectVector(new Vector3().setFromMatrixPosition(lampe.matrixWorld), [0, 0, 5]);
    // Sans rotation, une lumière glTF vise −Z (Y-up), soit +Y en Z-up.
    expectVector(aimOf(lampe.matrixWorld), [0, 1, 0]);

    const spot = objectNamed(s, 'Spot');
    expect(spot.light!.kind).toBe('spot');
    expect(spot.light!.power).toBeCloseTo(250, 6);
    expect(spot.light!.spotAngle).toBeCloseTo((0.8 * 180) / Math.PI, 6); // 2 × outerConeAngle
    expect(spot.light!.spotBlend).toBeCloseTo(0.5, 9); // 1 − inner / outer
    // Tourné de −90° autour de X : il vise −Y (Y-up), donc le bas en Z-up, quel que soit le parent
    // (la rotation de Racine se fait autour de la verticale).
    expectVector(aimOf(spot.matrixWorld), [0, 0, -1]);
    // Position : Racine · (0, 0, 4) = (4 + 1, 2, 3) en Y-up.
    expectVector(new Vector3().setFromMatrixPosition(spot.matrixWorld), zUp(5, 2, 3).toArray());

    const soleil = objectNamed(s, 'Soleil');
    expect(soleil.light!.kind).toBe('sun');
    expect(soleil.light!.power).toBeCloseTo(2, 9); // 1366 lux / 683
    expect(soleil.light!.color).toBe('#ffffff');
  });

  it('caméras : champ vertical en degrés, plans de coupe, ortho, orientation', async () => {
    const s = await readGLTFScene(glb, 'reference.glb');
    const cam = objectNamed(s, 'Cam');
    expect(cam.camera!.kind).toBe('persp');
    expect(cam.camera!.fov).toBeCloseTo((0.5 * 180) / Math.PI, 9);
    expect(cam.camera!.near).toBe(0.25);
    expect(cam.camera!.far).toBe(80);
    // À 10 de haut, tournée de −90° autour de X : elle regarde le sol ; son « haut » part vers
    // −Z (Y-up) = +Y (Z-up).
    expectVector(new Vector3().setFromMatrixPosition(cam.matrixWorld), [0, 0, 10]);
    expectVector(aimOf(cam.matrixWorld), [0, 0, -1]);
    expectVector(upOf(cam.matrixWorld), [0, 1, 0]);
    // Sans rotation : visée −Z (Y-up) = +Y, haut +Y (Y-up) = +Z.
    const ortho = objectNamed(s, 'Ortho');
    expect(ortho.camera).toMatchObject({ kind: 'ortho', orthoScale: 5, near: 0.1, far: 30 }); // 2 × ymag
    expectVector(aimOf(ortho.matrixWorld), [0, 1, 0]);
    expectVector(upOf(ortho.matrixWorld), [0, 0, 1]);
    expect(s.objects[s.activeCamera!].name).toBe('Cam');
    // Nœud maillage + caméra : la caméra est un enfant, orientée comme une caméra.
    const extra = objectNamed(s, 'Mixte (caméra)');
    expect(extra.camera!.kind).toBe('persp');
    expectVector(new Vector3().setFromMatrixPosition(extra.matrixWorld), zUp(0, 0, -3).toArray());
    expectVector(aimOf(extra.matrixWorld), [0, 1, 0]);
  });

  it('avertissements regroupés : scènes multiples, animations', async () => {
    const s = await readGLTFScene(glb, 'reference.glb');
    expect(s.warnings).toHaveLength(3);
    expect(s.warnings.some((w) => /2 scènes/.test(w) && /Principale/.test(w))).toBe(true);
    expect(s.warnings.some((w) => /Non repris : 1 animation/.test(w))).toBe(true);
    for (const w of s.warnings) expect(w.length).toBeLessThan(160);
  });

  it('applyImportedScene : objets, hiérarchie, maillages liés et parties par matériau dans un vrai document', async () => {
    const s = await readGLTFScene(glb, 'reference.glb');
    const doc = SceneDoc.createEmpty();
    const result = applyImportedScene(doc, s);
    // A et B (deux matériaux) : un vide + deux parties chacun.
    expect(result.counts).toEqual({ objects: 15, meshes: 6, lights: 3, cameras: 3, empties: 3, materials: 2, collections: 0 });
    expect(result.warnings.some((w) => /2 objet\(s\) à plusieurs matériaux/.test(w))).toBe(true);
    const a = docObject(doc, 'A');
    const aOr = docObject(doc, 'A · Or');
    const bOr = docObject(doc, 'B · Or');
    const bVerre = docObject(doc, 'B · Verre');
    expect(a.type).toBe('empty');
    expect(a.parent).toBe(docObject(doc, 'Racine').id);
    expect(aOr.parent).toBe(a.id);
    expect(aOr.data).toBe(bOr.data); // données liées
    expect(aOr.data).not.toBe(bVerre.data);
    expect(doc.getMaterial(aOr.material!)!.name).toBe('Or');
    expect(doc.getMaterial(bVerre.material!)!.transmission).toBeCloseTo(0.8, 9);
    // Quad soudé : 4 sommets, 2 triangles ; même position monde qu'avant l'écriture.
    const quad = doc.getMesh(aOr.data!)!;
    expect(quad.verts.size).toBe(4);
    expect(quad.faces.size).toBe(2);
    const racineYUp = (x: number, y: number, z: number): Vector3 => zUp(z + 1, y + 2, -x + 3);
    expect(samePoints(docWorldPoints(doc, bVerre.id), [racineYUp(0, 0, 2), racineYUp(2, 0, 2), racineYUp(0, 2, 2), racineYUp(2, 2, 2)])).toBe(true);
    // Pentagone : 5 sommets, 3 triangles, partagé entre Eventail et Mixte.
    const fan = docObject(doc, 'Eventail');
    expect(doc.getMesh(fan.data!)!.verts.size).toBe(5);
    expect(doc.getMesh(fan.data!)!.faces.size).toBe(3);
    expect(docObject(doc, 'Mixte').data).toBe(fan.data);
    // Lumières et caméras.
    const spot = docObject(doc, 'Spot');
    expect(spot.type).toBe('light');
    expect(doc.getLight(spot.data!)!.kind).toBe('spot');
    expectVector(aimOf(worldMatrix(doc, spot.id)), [0, 0, -1]);
    const cam = docObject(doc, 'Cam');
    expect(doc.getCamera(cam.data!)!.fov).toBeCloseTo((0.5 * 180) / Math.PI, 9);
    expectVector(aimOf(worldMatrix(doc, cam.id)), [0, 0, -1]);
    // Une seule étape d'annulation via importScene.
    const doc2 = SceneDoc.createEmpty();
    const r2 = await importScene(doc2, 'reference.glb', glb);
    expect(r2.objectIds).toHaveLength(15);
    doc2.undo();
    expect(doc2.listObjects()).toHaveLength(0);
  });

  it('.gltf texte autonome (URI data:) : même scène ; tampon externe : erreur claire', async () => {
    const fromGlb = await readGLTFScene(glb, 'reference.glb');
    const fromText = await readGLTFScene(builder.text(doc), 'reference.gltf');
    expect(fromText.objects.map((o) => [o.name, o.type, o.parent])).toEqual(fromGlb.objects.map((o) => [o.name, o.type, o.parent]));
    expect(fromText.meshes.map((m) => m.polygons.length)).toEqual(fromGlb.meshes.map((m) => m.polygons.length));
    fromText.objects.forEach((o, i) => expectMatrix(o.matrixWorld, fromGlb.objects[i].matrixWorld, 1e-12));
    // Le même texte fourni en octets, via le répartiteur.
    const viaDispatcher = await readScene('reference.gltf', bytesOf(builder.text(doc)));
    expect(viaDispatcher.objects).toHaveLength(fromGlb.objects.length);
    await expect(readGLTFScene(builder.external(doc), 'reference.gltf')).rejects.toThrow(/tampon externe.*geometrie\.bin/);
  });

  it('accesseurs : positions quantifiées normalisées, pas entrelacé, données creuses, indices 8 et 32 bits', async () => {
    const b = new GltfBuilder();
    // Entrelacé : int16 normalisés (x, y, z) + 2 octets de bourrage, pas de 8 octets.
    const q = (v: number) => Math.round(v * 32767);
    const interleaved = new Int16Array([q(0), q(0), q(0), 0, q(1), q(0), q(0), 0, q(1), q(1), q(0), 0, q(0), q(1), q(0), 0]);
    const viewIndex = b.view(interleaved, { byteStride: 8 });
    b.accessors.push({ bufferView: viewIndex, componentType: 5122, normalized: true, count: 4, type: 'VEC3' });
    const idx8 = b.accessor(new Uint8Array([0, 1, 2, 0, 2, 3]), 'SCALAR');
    // Creux : accesseur sans vue (zéros) dont 3 sommets sont fournis.
    const sparseIdx = b.view(new Uint16Array([1, 2, 3]));
    const sparseVal = b.view(new Float32Array([4, 0, 0, 4, 4, 0, 0, 4, 0]));
    b.accessors.push({
      componentType: 5126,
      count: 4,
      type: 'VEC3',
      sparse: { count: 3, indices: { bufferView: sparseIdx, componentType: 5123 }, values: { bufferView: sparseVal } },
    });
    const idx32 = b.accessor(new Uint32Array([0, 1, 2, 0, 2, 3]), 'SCALAR');
    const s = await readGLTFScene(
      b.glb({
        scenes: [{ nodes: [0, 1] }],
        nodes: [
          { name: 'Quantifié', mesh: 0, scale: [2, 2, 2] },
          { name: 'Creux', mesh: 1 },
        ],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: idx8 }] }, { primitives: [{ attributes: { POSITION: 2 }, indices: idx32 }] }],
        extensionsUsed: ['KHR_mesh_quantization'],
        extensionsRequired: ['KHR_mesh_quantization'],
      }),
    );
    expect(s.warnings).toEqual([]);
    expect(samePoints(importedWorldPoints(s, objectNamed(s, 'Quantifié')), [zUp(0, 0, 0), zUp(2, 0, 0), zUp(2, 2, 0), zUp(0, 2, 0)])).toBe(true);
    expect(samePoints(importedWorldPoints(s, objectNamed(s, 'Creux')), [zUp(0, 0, 0), zUp(4, 0, 0), zUp(4, 4, 0), zUp(0, 4, 0)])).toBe(true);
    expect(s.meshes.map((m) => m.name)).toEqual(['Maillage 1', 'Maillage 2']);
  });

  it('instances GPU, os sans géométrie, skins et morphing signalés, sans scène déclarée', async () => {
    const b = new GltfBuilder();
    const pos = b.accessor(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 'VEC3');
    const translations = b.accessor(new Float32Array([0, 0, 0, 10, 0, 0, 0, 0, 10]), 'VEC3');
    const s = await readGLTFScene(
      b.glb({
        // ni `scene` ni `scenes` : toutes les racines sont importées
        nodes: [
          { name: 'Forêt', mesh: 0, extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: translations } } } },
          { name: 'Armature', children: [2] },
          { name: 'Os', children: [3] },
          { name: 'Os.001' },
          { name: 'Peau', mesh: 0, skin: 0 },
        ],
        meshes: [{ name: 'Triangle', primitives: [{ attributes: { POSITION: pos }, targets: [{ POSITION: pos }] }] }],
        skins: [{ joints: [2, 3] }],
        extensionsUsed: ['EXT_mesh_gpu_instancing'],
      }),
    );
    expect(s.objects.map((o) => [o.name, o.type, o.parent === null ? null : s.objects[o.parent].name])).toEqual([
      ['Forêt', 'empty', null],
      ['Forêt.001', 'mesh', 'Forêt'],
      ['Forêt.002', 'mesh', 'Forêt'],
      ['Forêt.003', 'mesh', 'Forêt'],
      ['Armature', 'empty', null],
      ['Peau', 'mesh', null],
    ]);
    expect(new Set(s.objects.filter((o) => o.type === 'mesh').map((o) => o.mesh)).size).toBe(1);
    expectVector(new Vector3().setFromMatrixPosition(objectNamed(s, 'Forêt.003').matrixWorld), zUp(0, 0, 10).toArray());
    expect(s.warnings.some((w) => /Non repris : 1 armature de déformation.*cibles de morphing/.test(w))).toBe(true);
    expect(s.warnings.some((w) => /1 branche d'os sans géométrie ignorée/.test(w))).toBe(true);
  });

  it('valeurs non finies neutralisées, compression non prise en charge signalée', async () => {
    const b = new GltfBuilder();
    const pos = b.accessor(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, NaN, 0, 0]), 'VEC3');
    const idx = b.accessor(new Uint16Array([0, 1, 2, 1, 3, 2, 0, 1, 9]), 'SCALAR');
    const s = await readGLTFScene(
      b.glb({
        scenes: [{ nodes: [0, 1] }],
        nodes: [
          { name: 'Cassé', mesh: 0, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1e400, 0, 0, 1] },
          { name: 'Draco', mesh: 1 },
        ],
        meshes: [
          { primitives: [{ attributes: { POSITION: pos }, indices: idx }] },
          { primitives: [{ attributes: { POSITION: pos }, extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: {} } } }] },
        ],
      }),
    );
    // JSON.stringify écrit null pour l'infini : la matrice illisible devient l'identité.
    expectMatrix(objectNamed(s, 'Cassé').matrixWorld, new Matrix4(), 1e-12);
    // Le triangle à sommet NaN et celui à indice hors limites n'arrivent pas dans le document.
    expect(s.meshes[objectNamed(s, 'Cassé').mesh!].polygons).toHaveLength(1);
    expect(s.warnings.some((w) => /1 triangle à indice invalide ignoré/.test(w))).toBe(true);
    expect(objectNamed(s, 'Draco').type).toBe('empty');
    expect(s.warnings.some((w) => /1 primitive compressée \(Draco\) ignorée/.test(w))).toBe(true);
    const doc = SceneDoc.createEmpty();
    applyImportedScene(doc, s);
    const mesh = doc.getMesh(docObject(doc, 'Cassé').data!)!;
    expect(mesh.verts.size).toBe(3);
    expect(mesh.faces.size).toBe(1);
  });

  it('fichiers vides, tronqués ou étrangers : erreurs en français, pas de plantage', async () => {
    await expect(readGLTFScene(new ArrayBuffer(0), 'vide.glb')).rejects.toThrow(/vide/);
    await expect(readGLTFScene('', 'vide.gltf')).rejects.toThrow(/vide/);
    await expect(readGLTFScene('{"asset":', 'coupe.gltf')).rejects.toThrow(/JSON invalide ou tronqué/);
    await expect(readGLTFScene('[1,2]', 'tableau.gltf')).rejects.toThrow(/objet JSON/);
    await expect(readGLTFScene('{"nodes":[]}', 'autre.gltf')).rejects.toThrow(/asset/);
    await expect(readGLTFScene('{"asset":{"version":"1.0"}}', 'v1.gltf')).rejects.toThrow(/glTF 1\.0 non pris en charge/);
    await expect(readGLTFScene(glb.slice(0, 16), 'entete.glb')).rejects.toThrow(/tronqué/);
    await expect(readGLTFScene(glb.slice(0, Math.floor(glb.byteLength / 2)), 'moitie.glb')).rejects.toThrow(/tronqué/);
    // Bloc binaire raccourci mais conteneur cohérent : l'accesseur déborde.
    const b = new GltfBuilder();
    b.accessor(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 'VEC3');
    b.accessors[0].count = 300;
    await expect(readGLTFScene(b.glb({ scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }] }))).rejects.toThrow(
      /tronqué : positions du maillage/,
    );
    // Un glTF sans rien : scène vide, que le répartiteur refuse proprement.
    expect((await readGLTFScene('{"asset":{"version":"2.0"}}')).objects).toEqual([]);
    await expect(importScene(SceneDoc.createEmpty(), 'rien.gltf', bytesOf('{"asset":{"version":"2.0"}}'))).rejects.toThrow(/aucun objet/);
  });
});

// ================================================================== glTF exporté par Blender

/** Vérifications communes aux exports GLB et FBX de la même scène Blender. */
function expectBlenderScene(s: ImportedScene, options: { orthoCamera: boolean; fovTolerance: number; transmission: boolean; ior: number }): void {
  for (const t of truth.objects) {
    const o = objectNamed(s, t.name);
    const expectedType = t.name === 'Ortho' && !options.orthoCamera ? 'empty' : TYPE_OF[t.type];
    expect(o.type, t.name).toBe(expectedType);
    expect(o.parent === null ? null : s.objects[o.parent].name, `parent de ${t.name}`).toBe(t.parent);
    // Matrice monde identique à celle de Blender (les lumières et caméras visent −Z local).
    if (expectedType === TYPE_OF[t.type]) expectMatrix(o.matrixWorld, fromRows(t.matrix_world), 2e-4);
    else expectVector(new Vector3().setFromMatrixPosition(o.matrixWorld), [t.matrix_world[3], t.matrix_world[7], t.matrix_world[11]], 2e-4);
    if (t.type === 'MESH') {
      expect(samePoints(importedWorldPoints(s, o), points(t.world_verts!), 2e-4), `sommets de ${t.name}`).toBe(true);
      expect(s.meshes[o.mesh!].polygons, `triangles de ${t.name}`).toHaveLength(t.tris!);
      expect(s.meshes[o.mesh!].weld).toBe(true);
      expect(!!o.shadeSmooth, `lissage de ${t.name}`).toBe(t.smooth);
      const expected: Record<string, number> = {};
      t.materials!.forEach((m, i) => {
        if (t.slot_tris![i] > 0) expected[m!] = t.slot_tris![i];
      });
      expect(polygonsByMaterial(s, o), `matériaux de ${t.name}`).toEqual(expected);
    }
    if (t.aim && o.type !== 'empty') expectVector(aimOf(o.matrixWorld), t.aim, 2e-4);
    if (t.up && o.type !== 'empty') expectVector(upOf(o.matrixWorld), t.up, 2e-4);
  }
  // Données liées : les deux caisses partagent le même maillage.
  expect(objectNamed(s, 'Caisse').mesh).toBe(objectNamed(s, 'CaisseLiee').mesh);
  expect(s.meshes[objectNamed(s, 'Bicolore').mesh!].polygonSlots).toBeDefined();

  // Lumières : watts de Blender retrouvés.
  const ampoule = objectNamed(s, 'Ampoule').light!;
  expect(ampoule.kind).toBe('point');
  expect(ampoule.power).toBeCloseTo(truthObject('Ampoule').light!.energy, 2);
  expect(ampoule.color).toBe(linearToHex(1, 0.5, 0.25));
  const soleil = objectNamed(s, 'Soleil').light!;
  expect(soleil.kind).toBe('sun');
  expect(soleil.power).toBeCloseTo(truthObject('Soleil').light!.energy, 4);
  const spot = objectNamed(s, 'Projecteur').light!;
  expect(spot.kind).toBe('spot');
  expect(spot.power).toBeCloseTo(truthObject('Projecteur').light!.energy, 2);
  expect(spot.spotAngle).toBeCloseTo(truthObject('Projecteur').light!.spot_size_deg!, 3);
  expect(spot.spotBlend).toBeCloseTo(truthObject('Projecteur').light!.spot_blend!, 5);

  // Caméras.
  const cam = objectNamed(s, 'Camera').camera!;
  const camTruth = truthObject('Camera').camera!;
  expect(cam.kind).toBe('persp');
  expect(Math.abs(cam.fov! - camTruth.vfov_deg!)).toBeLessThan(options.fovTolerance);
  expect(cam.near).toBeCloseTo(camTruth.clip_start, 5);
  expect(cam.far).toBeCloseTo(camTruth.clip_end, 3);
  expect(s.objects[s.activeCamera!].type).toBe('camera');
  if (options.orthoCamera) {
    const ortho = objectNamed(s, 'Ortho').camera!;
    const orthoTruth = truthObject('Ortho').camera!;
    expect(ortho.kind).toBe('ortho');
    expect(ortho.orthoScale).toBeCloseTo(orthoTruth.ortho_height!, 5); // hauteur visible
    expect(ortho.near).toBeCloseTo(orthoTruth.clip_start, 5);
    expect(ortho.far).toBeCloseTo(orthoTruth.clip_end, 4);
  }

  // Matériaux.
  expect(s.materials.map((m) => m.name).sort()).toEqual(truth.materials.map((m) => m.name).sort());
  for (const t of truth.materials) {
    const m = s.materials.find((x) => x.name === t.name)!;
    expect(m.baseColor, t.name).toBe(linearToHex(t.base_color_linear[0], t.base_color_linear[1], t.base_color_linear[2]));
    expect(m.metallic, t.name).toBeCloseTo(t.metallic, 5);
    expect(m.roughness, t.name).toBeCloseTo(t.roughness, 5);
    expect(m.alpha, t.name).toBeCloseTo(t.alpha, 5);
    if (t.emission_strength > 0) {
      expect(m.emission, t.name).toBe(linearToHex(t.emission_linear[0], t.emission_linear[1], t.emission_linear[2]));
      expect(m.emissionStrength, t.name).toBeCloseTo(t.emission_strength, 5);
    } else {
      expect(m.emission, t.name).toBe('#000000');
      expect(m.emissionStrength, t.name).toBe(0);
    }
    expect(m.transmission, t.name).toBeCloseTo(options.transmission ? t.transmission : 0, 5);
    expect(m.ior, t.name).toBeCloseTo(options.transmission && t.transmission > 0 ? t.ior : options.ior, 5);
  }
}

/** Écrit la scène Blender dans un vrai document et la compare à la vérité. */
function expectBlenderDocument(s: ImportedScene, orthoCamera: boolean): void {
  const doc = SceneDoc.createEmpty();
  const result = applyImportedScene(doc, s, { mode: 'open' });
  // 11 objets Blender + 2 parties de « Bicolore » (un vide porteur et une partie par matériau).
  expect(result.counts).toEqual({
    objects: 13,
    meshes: 6,
    lights: 3,
    cameras: orthoCamera ? 2 : 1,
    empties: orthoCamera ? 2 : 3,
    materials: 4,
    collections: 0,
  });
  expect(result.warnings.some((w) => /1 objet\(s\) à plusieurs matériaux/.test(w))).toBe(true);
  for (const t of truth.objects) {
    const o = docObject(doc, t.name);
    expect(o.parent === null ? null : doc.getObject(o.parent)!.name, `parent de ${t.name}`).toBe(t.parent);
    if (o.type !== 'empty' || t.type === 'EMPTY') expectMatrix(worldMatrix(doc, o.id), fromRows(t.matrix_world), 5e-4);
    if (t.type === 'MESH' && t.name !== 'Bicolore') {
      expect(o.type).toBe('mesh');
      const mesh = doc.getMesh(o.data!)!;
      expect(mesh.verts.size, `sommets soudés de ${t.name}`).toBe(t.verts);
      expect(mesh.faces.size, `faces de ${t.name}`).toBe(t.tris);
      expect(samePoints(docWorldPoints(doc, o.id), points(t.world_verts!), 5e-4), `sommets de ${t.name}`).toBe(true);
      expect(doc.getMaterial(o.material!)!.name).toBe(t.materials![0]);
      expect(o.shadeSmooth).toBe(t.smooth);
    }
  }
  expect(docObject(doc, 'Caisse').data).toBe(docObject(doc, 'CaisseLiee').data);
  // Bicolore : vide porteur + « Bicolore · Rouge » (5 faces) et « Bicolore · Verre » (dessus).
  const bi = docObject(doc, 'Bicolore');
  const biTruth = truthObject('Bicolore');
  expect(bi.type).toBe('empty');
  const rouge = docObject(doc, 'Bicolore · Rouge');
  const verre = docObject(doc, 'Bicolore · Verre');
  expect(rouge.parent).toBe(bi.id);
  expect(verre.parent).toBe(bi.id);
  expect(doc.getMesh(rouge.data!)!.faces.size).toBe(biTruth.slot_tris![0]);
  expect(doc.getMesh(verre.data!)!.faces.size).toBe(biTruth.slot_tris![1]);
  expect(doc.getMaterial(verre.material!)!.name).toBe('Verre');
  expect(samePoints([...docWorldPoints(doc, rouge.id), ...docWorldPoints(doc, verre.id)], points(biTruth.world_verts!), 5e-4)).toBe(true);
  // Lumières, caméra active (mode « ouvrir »).
  const spot = docObject(doc, 'Projecteur');
  const light = doc.getLight(spot.data!)!;
  expect(light.kind).toBe('spot');
  expect(light.power).toBeCloseTo(500, 2);
  expect(light.spotAngle).toBeCloseTo(60, 3);
  expect(doc.getScene().activeCamera).toBe(docObject(doc, 'Camera').id);
  expect(doc.getCamera(docObject(doc, 'Camera').data!)!.near).toBeCloseTo(0.1, 5);
}

describe('glTF - export réel de Blender 5.1 (blender_scene.glb)', () => {
  it('correspond à la vérité de Blender : hiérarchie, matrices, maillages, matériaux, lumières, caméras', async () => {
    const s = await readScene('blender_scene.glb', fixture('blender_scene.glb'));
    expect(s.warnings).toEqual([]);
    expect(s.objects).toHaveLength(truth.objects.length);
    expect(s.name).toBe('Scene');
    expectBlenderScene(s, { orthoCamera: true, fovTolerance: 1e-4, transmission: true, ior: 1.5 });
  });

  it('s’écrit dans un document conforme à la vérité', async () => {
    const s = await readScene('blender_scene.glb', fixture('blender_scene.glb'));
    expectBlenderDocument(s, true);
    expect(s.name).toBe('Scene');
  });
});

// ================================================================== OBJ

describe('OBJ', () => {
  const source = [
    '# maison',
    'mtllib maison.mtl',
    'o Maison',
    'g murs',
    'v 0 0 0',
    'v 2 0 0',
    'v 2 3 0',
    'v 0 3 0',
    'usemtl Brique',
    'f 1/1/1 2/2/1 3/3/1 4/4/1',
    'v 0 0 5',
    'v 2 0 5',
    'v 2 3 5',
    'v 0 3 5',
    'usemtl Bois',
    'f -4//1 -3//1 -2//1 -1//1', // indices négatifs : les quatre derniers sommets
    'usemtl Brique',
    'f 1 2 6 5',
    'g toit',
    'v 1 4 2.5',
    'usemtl Tuile',
    's 1',
    'f 4 3 7 \\',
    '  9 8', // n-gone, ligne prolongée
    'l 1 2',
    'o Sol',
    's off',
    'v -5 0 -5',
    'v 5 0 -5',
    'v 5 0 5',
    'f 10 11 12',
    'f 10 11 99', // indice hors limites
    '',
  ].join('\r\n');

  it('objets, groupes, usemtl → emplacements, n-gones, indices négatifs, Y-up → Z-up', async () => {
    const s = await readOBJScene(source, 'maison.obj');
    expect(s.name).toBe('maison');
    expect(s.objects.map((o) => [o.name, o.type, o.parent === null ? null : s.objects[o.parent].name])).toEqual([
      ['Maison', 'empty', null],
      ['murs', 'mesh', 'Maison'],
      ['toit', 'mesh', 'Maison'],
      ['Sol', 'mesh', null],
    ]);
    const murs = objectNamed(s, 'murs');
    expect(polygonsByMaterial(s, murs)).toEqual({ Brique: 2, Bois: 1 });
    expect(Array.from(s.meshes[murs.mesh!].polygonSlots!)).toEqual([0, 1, 0]);
    expect(polygonSizes(s, murs)).toEqual([4, 4, 4]);
    // Y-up → Z-up : (x, y, z) → (x, −z, y) ; les sommets sont en coordonnées monde.
    expect(samePoints(importedWorldPoints(s, murs), [zUp(0, 0, 0), zUp(2, 0, 0), zUp(2, 3, 0), zUp(0, 3, 0), zUp(0, 0, 5), zUp(2, 0, 5), zUp(2, 3, 5), zUp(0, 3, 5)])).toBe(true);
    expectMatrix(murs.matrixWorld, new Matrix4(), 1e-12);
    // Face « Bois » : indices négatifs → sommets 5 à 8.
    const bois = s.meshes[murs.mesh!].polygons[1];
    const boisPts = Array.from(bois).map((i) => new Vector3(s.meshes[murs.mesh!].positions[i * 3], s.meshes[murs.mesh!].positions[i * 3 + 1], s.meshes[murs.mesh!].positions[i * 3 + 2]));
    expect(samePoints(boisPts, [zUp(0, 0, 5), zUp(2, 0, 5), zUp(2, 3, 5), zUp(0, 3, 5)])).toBe(true);

    const toit = objectNamed(s, 'toit');
    expect(polygonSizes(s, toit)).toEqual([5]); // pentagone conservé
    expect(toit.shadeSmooth).toBe(true);
    expect(toit.materials!.map((m) => s.materials[m!].name)).toEqual(['Tuile']);
    expect(s.meshes[toit.mesh!].polygonSlots).toBeUndefined();

    const sol = objectNamed(s, 'Sol');
    expect(sol.shadeSmooth).toBe(false);
    expect(polygonsByMaterial(s, sol)).toEqual({ Tuile: 1 }); // le matériau courant se prolonge d'un objet à l'autre
    // Matériaux créés par leur nom, réglages par défaut.
    expect(s.materials.map((m) => m.name)).toEqual(['Brique', 'Bois', 'Tuile']);
    expect(s.materials[0].baseColor).toBe('#cccccc');
    expect(s.warnings.some((w) => /maison\.mtl.*non lue : 3 matériaux/.test(w))).toBe(true);
    expect(s.warnings.some((w) => /1 face invalide ignorée/.test(w))).toBe(true);
    expect(s.warnings.some((w) => /1 ligne ou point ignoré/.test(w))).toBe(true);
  });

  it('s’écrit dans un document : n-gone intact, parties par matériau', async () => {
    const doc = SceneDoc.createEmpty();
    const r = await importScene(doc, 'maison.obj', bytesOf(source));
    // Maison (vide) + murs (vide porteur) + 2 parties + toit + Sol.
    expect(r.counts).toMatchObject({ objects: 6, meshes: 4, empties: 2, materials: 3 });
    const toit = docObject(doc, 'toit');
    const faces = [...doc.getMesh(toit.data!)!.faces.values()];
    expect(faces).toHaveLength(1);
    expect(faces[0]).toHaveLength(5);
    expect(docObject(doc, 'murs · Brique').parent).toBe(docObject(doc, 'murs').id);
    expect(doc.getMesh(docObject(doc, 'murs · Brique').data!)!.faces.size).toBe(2);
    expect(doc.getMaterial(docObject(doc, 'murs · Bois').material!)!.name).toBe('Bois');
  });

  it('groupes sans objet, fichier sans nom, fichier sans face, fichier vide', async () => {
    const s = await readOBJScene('v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\ng a\nf 1 2 3\ng b\nf 1 2 4\ng a\nf 2 3 4\n', 'pieces.obj');
    expect(s.objects.map((o) => [o.name, o.parent, s.meshes[o.mesh!].polygons.length])).toEqual([
      ['a', null, 2], // le groupe « a » repris plus loin complète la même pièce
      ['b', null, 1],
    ]);
    expect(s.objects.every((o) => o.materials![0] === null)).toBe(true);
    const anonymous = await readOBJScene(bytesOf('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'), 'dossier/triangle.obj');
    expect(anonymous.objects.map((o) => o.name)).toEqual(['triangle']);
    const cloud = await readOBJScene('v 0 0 0\nv 1 0 0\n', 'nuage.obj');
    expect(cloud.objects).toEqual([]);
    expect(cloud.warnings.some((w) => /aucune face/.test(w))).toBe(true);
    expect((await readOBJScene('', 'vide.obj')).objects).toEqual([]);
    await expect(importScene(SceneDoc.createEmpty(), 'vide.obj', new ArrayBuffer(0))).rejects.toThrow(/aucun objet/);
    // Coordonnée illisible : la face qui l'utilise disparaît, pas le reste.
    const doc = SceneDoc.createEmpty();
    await importScene(doc, 'nan.obj', bytesOf('v 0 0 0\nv 1 0 0\nv 0 1 0\nv x y z\nf 1 2 3\nf 1 2 4\n'));
    expect(doc.getMesh(docObject(doc, 'nan').data!)!.faces.size).toBe(1);
  });

  it('export réel de Blender (blender_scene.obj) : polygones d’origine, matériaux, positions monde', async () => {
    const s = await readScene('blender_scene.obj', fixture('blender_scene.obj'));
    const meshTruth = truth.objects.filter((o) => o.type === 'MESH');
    expect(s.objects.map((o) => o.name).sort()).toEqual(meshTruth.map((o) => o.name).sort());
    for (const t of meshTruth) {
      const o = objectNamed(s, t.name);
      expect(o.type).toBe('mesh');
      expect(samePoints(importedWorldPoints(s, o), points(t.world_verts!), 1e-4), `sommets de ${t.name}`).toBe(true);
      expect(polygonSizes(s, o), `polygones de ${t.name}`).toEqual(t.poly_sizes); // quads et octogones intacts
      const expected: Record<string, number> = {};
      t.materials!.forEach((m, i) => (expected[m!] = t.slot_polys![i]));
      expect(polygonsByMaterial(s, o)).toEqual(expected);
      expect(!!o.shadeSmooth).toBe(t.smooth);
    }
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]).toMatch(/blender_scene\.mtl/);
    const doc = SceneDoc.createEmpty();
    applyImportedScene(doc, s);
    const colonne = doc.getMesh(docObject(doc, 'Colonne').data!)!;
    expect(colonne.verts.size).toBe(truthObject('Colonne').verts);
    expect([...colonne.faces.values()].map((f) => f.length).sort((a, b) => a - b)).toEqual(truthObject('Colonne').poly_sizes);
  });
});

// ================================================================== STL

/** Tétraèdre : 4 sommets, 4 triangles tournés vers l'extérieur. */
const TETRA: [number, number, number][] = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 2],
];
const TETRA_FACES = [
  [0, 2, 1],
  [0, 1, 3],
  [1, 2, 3],
  [2, 0, 3],
];

function binarySTL(triangles: [number, number, number][][]): ArrayBuffer {
  const out = new ArrayBuffer(84 + triangles.length * 50);
  const dv = new DataView(out);
  dv.setUint32(80, triangles.length, true);
  triangles.forEach((tri, t) => {
    let at = 84 + t * 50 + 12; // normale laissée à zéro
    for (const p of tri) for (const c of p) (dv.setFloat32(at, c, true), (at += 4));
  });
  return out;
}

function asciiSTL(solids: [number, number, number][][][]): string {
  return solids
    .map(
      (tris, i) =>
        `solid partie${i}\n` +
        tris.map((tri) => ` facet normal 0 0 0\n  outer loop\n${tri.map((p) => `   vertex ${p.join(' ')}\n`).join('')}  endloop\n endfacet\n`).join('') +
        `endsolid partie${i}\n`,
    )
    .join('');
}

describe('STL', () => {
  const tetra = TETRA_FACES.map((f) => f.map((i) => TETRA[i]));

  it('binaire construit ici : sommets soudés, coordonnées reprises telles quelles (Z vers le haut)', async () => {
    const s = await readScene('tetra.stl', binarySTL(tetra));
    expect(s.objects).toHaveLength(1);
    expect(s.objects[0]).toMatchObject({ name: 'tetra', type: 'mesh', parent: null, shadeSmooth: false });
    expectMatrix(s.objects[0].matrixWorld, new Matrix4(), 1e-12);
    expect(s.materials).toEqual([]);
    expect(s.objects[0].materials).toBeUndefined();
    expect(s.meshes[0].polygons).toHaveLength(4);
    expect(samePoints(importedWorldPoints(s, s.objects[0]), points(TETRA))).toBe(true); // z reste z
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]).toMatch(/ni unité ni axe vertical/);
    const doc = SceneDoc.createEmpty();
    applyImportedScene(doc, s);
    const mesh = doc.getMesh(docObject(doc, 'tetra').data!)!;
    expect(mesh.verts.size).toBe(4); // 12 sommets de triangles soudés
    expect(mesh.faces.size).toBe(4);
  });

  it('ASCII à deux solides : un seul objet ; détection sans extension', async () => {
    const text = asciiSTL([tetra.slice(0, 2), tetra.slice(2)]);
    const s = await readScene('tetra_ascii.stl', bytesOf(text));
    expect(s.objects).toHaveLength(1);
    expect(s.meshes[0].polygons).toHaveLength(4);
    expect(s.meshes[0].polygonSlots).toBeUndefined();
    expect(samePoints(importedWorldPoints(s, s.objects[0]), points(TETRA))).toBe(true);
    // Sans extension : signature « solid » ou taille d'un STL binaire.
    expect((await readFBXScene(text, '')).meshes[0].polygons).toHaveLength(4);
    expect((await readFBXScene(binarySTL(tetra), 'sans_extension')).meshes[0].polygons).toHaveLength(4);
    expect((await readScene('sans_extension', bytesOf(text))).objects).toHaveLength(1);
  });

  it('exports réels de Blender (binaire et ASCII) : la colonne, à sa place', async () => {
    const t = truthObject('Colonne');
    for (const file of ['blender_colonne.stl', 'blender_colonne_ascii.stl']) {
      const s = await readScene(file, fixture(file));
      expect(s.meshes[0].polygons, file).toHaveLength(t.tris!);
      expect(samePoints(importedWorldPoints(s, s.objects[0]), points(t.world_verts!), 1e-4), file).toBe(true);
      const doc = SceneDoc.createEmpty();
      applyImportedScene(doc, s);
      const mesh = doc.getMesh(doc.listObjects()[0].data!)!;
      expect(mesh.verts.size, file).toBe(t.verts);
      expect(mesh.faces.size, file).toBe(t.tris);
    }
  });

  it('vide, tronqué, sans triangle : erreurs en français', async () => {
    await expect(readFBXScene(new ArrayBuffer(0), 'vide.stl')).rejects.toThrow(/STL vide/);
    await expect(readFBXScene(new ArrayBuffer(40), 'court.stl')).rejects.toThrow(/STL tronqué/);
    const full = binarySTL(tetra);
    await expect(readFBXScene(full.slice(0, full.byteLength - 60), 'coupe.stl')).rejects.toThrow(/STL illisible \(tronqué ou corrompu\)/);
    await expect(readFBXScene('solid rien\nendsolid rien\n', 'rien.stl')).rejects.toThrow(/aucun triangle/);
    // Triangles dégénérés seulement.
    await expect(readFBXScene(binarySTL([[TETRA[0], TETRA[0], TETRA[1]]]), 'plat.stl')).rejects.toThrow(/aucun triangle/);
  });
});

// ================================================================== PLY

describe('PLY', () => {
  // Maison en coupe : un quad et un pentagone qui partagent une arête.
  const verts: [number, number, number][] = [
    [0, 0, 0],
    [2, 0, 0],
    [2, 0, 2],
    [0, 0, 2],
    [1, 0, 3],
    [9, 9, 9], // sommet inutilisé
  ];
  const faces = [
    [0, 1, 2, 3],
    [3, 2, 4],
    [0, 3, 2, 1, 4].slice(0, 5),
  ];
  const header = (format: string, coord: string, extra = ''): string =>
    `ply\nformat ${format} 1.0\ncomment test CoForge\nelement vertex ${verts.length}\nproperty ${coord} x\nproperty ${coord} y\nproperty ${coord} z\n${extra}` +
    `element face ${faces.length}\nproperty list uchar int vertex_indices\nend_header\n`;

  function binaryPLY(littleEndian: boolean): ArrayBuffer {
    const head = new TextEncoder().encode(header(littleEndian ? 'binary_little_endian' : 'binary_big_endian', 'double', 'property uchar red\n'));
    const size = head.length + verts.length * 25 + faces.reduce((n, f) => n + 1 + f.length * 4, 0);
    const out = new ArrayBuffer(size);
    new Uint8Array(out).set(head);
    const dv = new DataView(out);
    let at = head.length;
    for (const v of verts) {
      for (const c of v) (dv.setFloat64(at, c, littleEndian), (at += 8));
      dv.setUint8(at++, 200); // propriété étrangère entre deux sommets
    }
    for (const f of faces) {
      dv.setUint8(at++, f.length);
      for (const i of f) (dv.setInt32(at, i, littleEndian), (at += 4));
    }
    return out;
  }

  const asciiPLY = (): string => header('ascii', 'float') + verts.map((v) => v.join(' ')).join('\n') + '\n' + faces.map((f) => `${f.length} ${f.join(' ')}`).join('\r\n') + '\n';

  it('ASCII et binaire (petit et gros boutiste) : polygones d’origine, coordonnées telles quelles', async () => {
    const sources: [string, ArrayBuffer][] = [
      ['ascii.ply', bytesOf(asciiPLY())],
      ['le.ply', binaryPLY(true)],
      ['be.ply', binaryPLY(false)],
    ];
    for (const [file, data] of sources) {
      const s = await readScene(file, data);
      expect(s.objects, file).toHaveLength(1);
      expect(s.objects[0]).toMatchObject({ type: 'mesh', parent: null, shadeSmooth: false });
      expect(polygonSizes(s, s.objects[0]), file).toEqual([3, 4, 5]); // pas de triangulation
      expect(samePoints(importedWorldPoints(s, s.objects[0]), points(verts.slice(0, 5))), file).toBe(true);
      expect(s.warnings.some((w) => /PLY : .*ni unité ni axe vertical/.test(w)), file).toBe(true);
      const doc = SceneDoc.createEmpty();
      applyImportedScene(doc, s);
      const mesh = doc.getMesh(doc.listObjects()[0].data!)!;
      expect(mesh.verts.size, file).toBe(5); // le sommet inutilisé n'est pas créé
      expect(mesh.faces.size, file).toBe(3);
    }
    expect((await readFBXScene(binaryPLY(true), '')).objects).toHaveLength(1); // détection par signature
  });

  it('normales de sommets : ombrage lisse détecté', async () => {
    const text =
      'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nproperty float nx\nproperty float ny\nproperty float nz\n' +
      'element face 1\nproperty list uchar uint vertex_index\nend_header\n';
    const flat = await readFBXScene(`${text}0 0 0 0 0 1\n1 0 0 0 0 1\n0 1 0 0 0 1\n3 0 1 2\n`, 'plat.ply');
    expect(flat.objects[0].shadeSmooth).toBe(false);
    const smooth = await readFBXScene(`${text}0 0 0 -1 -1 1\n1 0 0 1 -1 1\n0 1 0 -1 1 1\n3 0 1 2\n`, 'lisse.ply');
    expect(smooth.objects[0].shadeSmooth).toBe(true);
  });

  it('exports réels de Blender (binaire et ASCII) : octogones conservés', async () => {
    const t = truthObject('Colonne');
    for (const file of ['blender_colonne.ply', 'blender_colonne_ascii.ply']) {
      const s = await readScene(file, fixture(file));
      expect(polygonSizes(s, s.objects[0]), file).toEqual(t.poly_sizes);
      expect(samePoints(importedWorldPoints(s, s.objects[0]), points(t.world_verts!), 1e-4), file).toBe(true);
      const doc = SceneDoc.createEmpty();
      applyImportedScene(doc, s);
      const mesh = doc.getMesh(doc.listObjects()[0].data!)!;
      expect(mesh.verts.size, file).toBe(t.verts);
      expect([...mesh.faces.values()].map((f) => f.length).sort((a, b) => a - b), file).toEqual(t.poly_sizes);
    }
  });

  it('vide, tronqué, nuage de points, format inconnu : erreurs en français', async () => {
    await expect(readFBXScene(new ArrayBuffer(0), 'vide.ply')).rejects.toThrow(/PLY vide/);
    await expect(readFBXScene('plouf', 'faux.ply')).rejects.toThrow(/n'est pas un PLY/);
    await expect(readFBXScene('ply\nformat ascii 1.0\nelement vertex 3\n', 'entete.ply')).rejects.toThrow(/tronqué \(en-tête incomplet\)/);
    const le = binaryPLY(true);
    await expect(readFBXScene(le.slice(0, le.byteLength - 10), 'coupe.ply')).rejects.toThrow(/PLY tronqué/);
    await expect(readFBXScene(asciiPLY().slice(0, -12), 'coupe_ascii.ply')).rejects.toThrow(/PLY tronqué/);
    await expect(readFBXScene('ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n', 'nuage.ply')).rejects.toThrow(
      /nuage de points/,
    );
    await expect(readFBXScene('ply\nformat binaire_exotique 1.0\nelement vertex 0\nend_header\n', 'exotique.ply')).rejects.toThrow(/Format PLY inconnu/);
    await expect(readFBXScene('ply\nformat ascii 1.0\nelement vertex 1\nproperty quaternion x\nend_header\n', 'type.ply')).rejects.toThrow(/Type de donnée PLY inconnu/);
  });
});

// ================================================================== FBX

/** FBX ASCII 7.4 minimal : un quad en centimètres, Y vers le haut, un matériau Phong, une lumière. */
const ASCII_FBX = `; FBX 7.4.0 project file
FBXHeaderExtension:  {
	FBXHeaderVersion: 1003
	FBXVersion: 7400
	Creator: "tests CoForge"
}
GlobalSettings:  {
	Version: 1000
	Properties70:  {
		P: "UpAxis", "int", "Integer", "",1
		P: "UpAxisSign", "int", "Integer", "",1
		P: "FrontAxis", "int", "Integer", "",2
		P: "FrontAxisSign", "int", "Integer", "",1
		P: "CoordAxis", "int", "Integer", "",0
		P: "CoordAxisSign", "int", "Integer", "",1
		P: "UnitScaleFactor", "double", "Number", "",1
	}
}
Objects:  {
	Geometry: 1000, "Geometry::Dalle", "Mesh" {
		Vertices: *12 {
			a: -100,0,100,100,0,100,100,0,-100,-100,0,-100
		}
		PolygonVertexIndex: *4 {
			a: 0,1,2,-4
		}
		GeometryVersion: 124
	}
	Model: 2000, "Model::Dalle", "Mesh" {
		Version: 232
		Properties70:  {
			P: "Lcl Translation", "Lcl Translation", "", "A",100,200,300
		}
	}
	Material: 3000, "Material::Bleu", "" {
		Version: 102
		ShadingModel: "phong"
		Properties70:  {
			P: "DiffuseColor", "Color", "", "A",0,0,1
			P: "Shininess", "double", "Number", "",25
		}
	}
	NodeAttribute: 4000, "NodeAttribute::Phare", "Light" {
		Properties70:  {
			P: "LightType", "enum", "", "",2
			P: "Intensity", "Number", "", "A",25000
			P: "OuterAngle", "Number", "", "A",90
			P: "InnerAngle", "Number", "", "A",45
		}
	}
	Model: 5000, "Model::Phare", "Light" {
		Version: 232
		Properties70:  {
			P: "Lcl Translation", "Lcl Translation", "", "A",0,500,0
		}
	}
}
Connections:  {
	C: "OO",2000,0
	C: "OO",1000,2000
	C: "OO",3000,2000
	C: "OO",5000,0
	C: "OO",4000,5000
}
`;

describe('FBX', () => {
  it('ASCII minimal construit ici : centimètres → mètres, Y-up → Z-up, Phong, spot', async () => {
    const s = await readScene('dalle.fbx', bytesOf(ASCII_FBX));
    const dalle = objectNamed(s, 'Dalle');
    expect(dalle.type).toBe('mesh');
    // Sommets du fichier (cm, Y-up) décalés de (100, 200, 300) → mètres, Z-up.
    expect(
      samePoints(importedWorldPoints(s, dalle), [
        zUp(0, 2, 4),
        zUp(2, 2, 4),
        zUp(2, 2, 2),
        zUp(0, 2, 2),
      ]),
    ).toBe(true);
    expect(s.meshes[dalle.mesh!].polygons).toHaveLength(2); // quad triangulé par le chargeur
    const bleu = s.materials[dalle.materials![0]!];
    expect(bleu.name).toBe('Bleu');
    expect(bleu.baseColor).toBe('#0000ff'); // créateur autre que Blender : couleurs lues en sRGB
    expect(bleu.roughness).toBeCloseTo(0.5, 9); // 1 − √25 / 10
    expect(bleu.metallic).toBe(0);
    const phare = objectNamed(s, 'Phare');
    expect(phare.light).toMatchObject({ kind: 'spot', power: 250, color: '#ffffff' }); // Intensity / 100
    expect(phare.light!.spotAngle).toBeCloseTo(90, 9); // OuterAngle : angle complet
    expect(phare.light!.spotBlend).toBeCloseTo(0.5, 9);
    // À 5 m de haut, sans rotation : une lumière FBX vise −Y local, soit le bas.
    expectVector(new Vector3().setFromMatrixPosition(phare.matrixWorld), [0, 0, 5]);
    expectVector(aimOf(phare.matrixWorld), [0, 0, -1]);
    expect(s.warnings.some((w) => /polygones importés triangulés/.test(w))).toBe(true);
    const doc = SceneDoc.createEmpty();
    applyImportedScene(doc, s);
    const mesh = doc.getMesh(docObject(doc, 'Dalle').data!)!;
    expect(mesh.verts.size).toBe(4);
    expect(mesh.faces.size).toBe(2);
    // Le texte fourni directement, sans extension (signature « ; FBX »).
    expect((await readFBXScene(ASCII_FBX, '')).objects).toHaveLength(2);
  });

  it('binaire réel de Blender 5.1 (blender_scene.fbx) : conforme à la vérité', async () => {
    const s = await readScene('blender_scene.fbx', fixture('blender_scene.fbx'));
    expect(s.objects).toHaveLength(truth.objects.length);
    // Limites connues du chargeur FBX de three.js : caméra ortho → vide, champ approché (pellicule
    // de 35 mm au lieu du capteur de 36 mm), pas de transmission ni d'indice dans un Phong.
    expectBlenderScene(s, { orthoCamera: false, fovTolerance: 1, transmission: false, ior: 1.45 });
    expect(s.warnings.some((w) => /1 caméra orthographique importée comme vide/.test(w))).toBe(true);
    expect(s.warnings.some((w) => /champ de vision/.test(w))).toBe(true);
    expect(s.warnings).toHaveLength(3);
  });

  it('s’écrit dans un document conforme à la vérité', async () => {
    const s = await readScene('blender_scene.fbx', fixture('blender_scene.fbx'));
    expectBlenderDocument(s, false);
  });

  it('ne laisse aucune trace dans l’environnement (window, console.warn, URL.createObjectURL)', async () => {
    const warn = console.warn;
    const create = URL.createObjectURL;
    const hadWindow = 'window' in globalThis;
    await readScene('blender_scene.fbx', fixture('blender_scene.fbx'));
    await expect(readFBXScene(new Uint8Array([1, 2, 3, 4]).buffer, 'faux.fbx')).rejects.toThrow();
    expect(console.warn).toBe(warn);
    expect(URL.createObjectURL).toBe(create);
    expect('window' in globalThis).toBe(hadWindow);
  });

  it('vide, tronqué, étranger, version trop ancienne : erreurs en français', async () => {
    await expect(readFBXScene(new ArrayBuffer(0), 'vide.fbx')).rejects.toThrow(/FBX vide/);
    const real = fixture('blender_scene.fbx');
    await expect(readFBXScene(real.slice(0, Math.floor(real.byteLength / 2)), 'moitie.fbx')).rejects.toThrow(/FBX illisible \(tronqué ou corrompu\)/);
    await expect(readFBXScene(real.slice(0, 40), 'entete.fbx')).rejects.toThrow(/FBX/);
    await expect(readFBXScene('ceci est un texte quelconque', 'faux.fbx')).rejects.toThrow(/n'est pas un FBX reconnu/);
    await expect(readFBXScene(ASCII_FBX.replace('FBXVersion: 7400', 'FBXVersion: 6100'), 'ancien.fbx')).rejects.toThrow(/version 6100 non pris en charge/);
    await expect(readScene('moitie.fbx', real.slice(0, Math.floor(real.byteLength / 2)))).rejects.toThrow(/Lecture de « moitie\.fbx » impossible/);
  });
});

// ================================================================== Collada

describe('Collada (.dae)', () => {
  const dae = (): ArrayBuffer => fixture('manuel_scene.dae');

  it('sans DOMParser (Node) : erreur claire, pas de plantage', async () => {
    if (typeof DOMParser !== 'undefined') return; // environnement doté d'un DOM : cas sans objet
    await expect(readScene('manuel_scene.dae', dae())).rejects.toThrow(/Collada.*DOMParser/);
    await expect(readFBXScene('', 'vide.dae')).rejects.toThrow(/Collada vide/);
  });

  it('avec un DOMParser (xmldom en substitution du navigateur) : unité, axe, matériau, lumière, caméra', async () => {
    // @xmldom/xmldom n'est qu'une dépendance indirecte du projet : sans lui, ce test est sans objet.
    const g = globalThis as any;
    const spec = '@xmldom/xmldom';
    const xmldom: any = await import(/* @vite-ignore */ spec).catch(() => null);
    if (!xmldom?.DOMParser || typeof g.DOMParser !== 'undefined') return;
    g.DOMParser = xmldom.DOMParser;
    const hadNode = 'Node' in g;
    if (!hadNode) g.Node = { TEXT_NODE: 3 };
    try {
      const s = await readScene('manuel_scene.dae', dae());
      expect(s.objects.map((o) => [o.name, o.type, o.parent === null ? null : s.objects[o.parent].name])).toEqual([
        ['Plan', 'mesh', null],
        ['Enfant', 'empty', 'Plan'],
        ['Lampe', 'light', null],
        ['Cam', 'camera', null],
      ]);
      // Fichier en centimètres, Z vers le haut : tout revient en mètres, sans basculement.
      const plan = objectNamed(s, 'Plan');
      expect(samePoints(importedWorldPoints(s, plan), points([[0, 1, 3], [2, 1, 3], [2, 3, 3], [0, 3, 3]]))).toBe(true);
      expectVector(new Vector3().setFromMatrixPosition(objectNamed(s, 'Enfant').matrixWorld), [1, 2, 3.5]);
      const rouge = s.materials[plan.materials![0]!];
      expect(rouge.name).toBe('Rouge');
      expect(rouge.roughness).toBeCloseTo(0.3, 9); // 1 − √49 / 10
      const lampe = objectNamed(s, 'Lampe');
      expect(lampe.light).toMatchObject({ kind: 'point', power: 1000, color: linearToHex(1, 0.5, 0.25) });
      expectVector(new Vector3().setFromMatrixPosition(lampe.matrixWorld), [4, 1, 6]);
      const cam = objectNamed(s, 'Cam');
      expect(cam.camera!.kind).toBe('persp');
      expect(cam.camera!.fov).toBeCloseTo(40, 6);
      expect(cam.camera!.near).toBeCloseTo(0.1, 9);
      expect(cam.camera!.far).toBeCloseTo(100, 9);
      expectVector(new Vector3().setFromMatrixPosition(cam.matrixWorld), [0, 0, 10]);
      expectVector(aimOf(cam.matrixWorld), [0, 0, -1]);
      expectVector(upOf(cam.matrixWorld), [0, 1, 0]);
      const doc = SceneDoc.createEmpty();
      const r = applyImportedScene(doc, s);
      expect(r.counts).toMatchObject({ objects: 4, meshes: 1, lights: 1, cameras: 1, empties: 1, materials: 1 });
      expect(doc.getMesh(docObject(doc, 'Plan').data!)!.verts.size).toBe(4);
    } finally {
      delete g.DOMParser;
      if (!hadNode) delete g.Node;
    }
  });
});
