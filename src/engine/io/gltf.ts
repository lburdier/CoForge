import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  Object3D,
  Scene,
  Vector3,
  type Material,
} from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MATERIAL_DEFAULTS } from '../../core/doc/schema';
import { triangulate } from '../../core/mesh/triangulate';
import { convertTransform, physicalParamsFromData } from './convert';
import type { ExportItem } from './types';

/**
 * Export glTF binaire (.glb), Y vers le haut :
 *  - un nœud par élément ; sa matrice est la matrice monde convertie (C · M · C⁻¹) et la
 *    géométrie est exprimée dans le repère local converti, ce qui conserve l'orientation
 *    naturelle des objets et rend l'aller-retour avec `importFile` exact ;
 *  - triangulation de `src/core/mesh/triangulate` (n-gones concaves gérés), normales plates
 *    ou lissées selon `smooth` / `autoSmoothAngle` ;
 *  - matériaux PBR (métal/rugosité, émission + KHR_materials_emissive_strength, alpha,
 *    transmission et IOR via les extensions KHR correspondantes).
 */
export async function exportGLB(items: ExportItem[]): Promise<ArrayBuffer> {
  const scene = new Scene();
  scene.name = 'CoForge';
  const materials = new Map<string, MeshPhysicalMaterial>();
  const geometries: BufferGeometry[] = [];
  let fallback: MeshPhysicalMaterial | null = null;

  const materialFor = (item: ExportItem): MeshPhysicalMaterial => {
    const data = item.material;
    if (!data) {
      if (!fallback) {
        fallback = makeMaterial('Défaut', MATERIAL_DEFAULTS);
      }
      return fallback;
    }
    let mat = materials.get(data.id);
    if (!mat) {
      mat = makeMaterial(data.name, data);
      materials.set(data.id, mat);
    }
    return mat;
  };

  const nodeMatrix = new Matrix4();
  for (const item of items) {
    convertTransform(item.matrixWorld, true, nodeMatrix);
    const rm = triangulate(item.mesh, { smooth: item.smooth, autoSmoothAngle: item.autoSmoothAngle });
    let node: Object3D;
    if (rm.positions.length >= 9) {
      const pos = toYUp(rm.positions);
      const nrm = toYUp(rm.normals);
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(pos, 3));
      g.setAttribute('normal', new BufferAttribute(nrm, 3));
      geometries.push(g);
      node = new Mesh(g, materialFor(item));
    } else {
      // Maillage sans face : nœud vide, la transformation est tout de même conservée.
      node = new Group();
    }
    node.name = item.name;
    node.matrixAutoUpdate = false;
    node.matrix.copy(nodeMatrix);
    scene.add(node);
  }
  scene.updateMatrixWorld(true);

  try {
    const exporter = new GLTFExporter();
    const result = await exporter.parseAsync(scene, { binary: true, onlyVisible: false, trs: false });
    if (!(result instanceof ArrayBuffer)) throw new Error('Export glTF : résultat inattendu');
    return result;
  } finally {
    for (const g of geometries) g.dispose();
    for (const m of materials.values()) m.dispose();
    (fallback as MeshPhysicalMaterial | null)?.dispose();
  }
}

function makeMaterial(name: string, data: Parameters<typeof physicalParamsFromData>[0]): MeshPhysicalMaterial {
  const p = physicalParamsFromData(data);
  const m = new MeshPhysicalMaterial({
    name,
    color: p.color,
    metalness: p.metalness,
    roughness: p.roughness,
    emissive: p.emissive,
    emissiveIntensity: p.emissiveIntensity,
    opacity: p.opacity,
    transparent: p.transparent,
    transmission: p.transmission,
    ior: p.ior,
    // Les surfaces de CoForge sont rendues des deux côtés (comme Blender sans « backface culling »).
    side: DoubleSide,
  });
  return m;
}

/** Vecteurs (positions ou normales) Z-up → Y-up : (x, y, z) → (x, z, −y). */
function toYUp(src: Float32Array): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i + 2 < src.length; i += 3) {
    out[i] = src[i];
    out[i + 1] = src[i + 2];
    out[i + 2] = -src[i + 1];
  }
  return out;
}

// ------------------------------------------------------------------ lecture

/** Une surface importée : sommets (repère local Z-up), triangles, matériau et transformation Z-up. */
export interface ImportedPart {
  name: string;
  /** Clé de partage : deux parties de même clé utilisent la même géométrie (données liées). */
  geometryKey: string;
  positions: Float64Array;
  triangles: number[][];
  material: Material | null;
  /** Transformation monde en Z-up. */
  matrix: Matrix4;
  smooth: boolean;
}

/** Charge un fichier glTF (.glb ou .gltf autonome) et en extrait les surfaces triangulées. */
export async function readGLTF(data: ArrayBuffer | string): Promise<ImportedPart[]> {
  const loader = new GLTFLoader();
  const gltf = await new Promise<{ scene: Object3D }>((resolve, reject) => {
    try {
      loader.parse(
        data,
        '',
        (g) => resolve(g as unknown as { scene: Object3D }),
        (err) => reject(err instanceof Error ? err : new Error(String((err as any)?.message ?? err))),
      );
    } catch (err) {
      reject(err);
    }
  });
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const parts: ImportedPart[] = [];
  const instanceMatrix = new Matrix4();
  const world = new Matrix4();
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!(mesh as any).isMesh || !mesh.geometry) return;
    const geometry = mesh.geometry as BufferGeometry;
    const position = geometry.getAttribute('position');
    if (!position || position.count < 3) return;
    const baseName = mesh.name || mesh.parent?.name || 'Objet importé';
    const local = localPositionsZUp(geometry);
    const groups = triangleGroups(geometry, mesh.material);
    const smooth = hasSmoothNormals(geometry);
    const instances: Matrix4[] = [];
    if ((mesh as any).isInstancedMesh) {
      const im = mesh as any;
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, instanceMatrix);
        instances.push(new Matrix4().multiplyMatrices(mesh.matrixWorld, instanceMatrix));
      }
    } else {
      instances.push(world.copy(mesh.matrixWorld).clone());
    }
    for (const grp of groups) {
      if (grp.triangles.length === 0) continue;
      for (const m of instances) {
        parts.push({
          name: groups.length > 1 && grp.material?.name ? `${baseName}.${grp.material.name}` : baseName,
          geometryKey: `${geometry.uuid}:${grp.index}`,
          positions: local,
          triangles: grp.triangles,
          material: grp.material,
          matrix: convertTransform(m, false),
          smooth,
        });
      }
    }
  });
  return parts;
}

/** Positions locales converties en Z-up (attributs normalisés/quantifiés gérés par getX). */
function localPositionsZUp(geometry: BufferGeometry): Float64Array {
  const pos = geometry.getAttribute('position');
  const out = new Float64Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    out[i * 3] = pos.getX(i);
    out[i * 3 + 1] = -pos.getZ(i);
    out[i * 3 + 2] = pos.getY(i);
  }
  return out;
}

/** Triangles par matériau (groupes de géométrie), en respectant index et drawRange. */
function triangleGroups(
  geometry: BufferGeometry,
  material: Material | Material[],
): { index: number; material: Material | null; triangles: number[][] }[] {
  const index = geometry.getIndex();
  const count = index ? index.count : geometry.getAttribute('position').count;
  const vertexAt = (i: number) => (index ? index.getX(i) : i);
  const drawStart = Math.max(0, geometry.drawRange.start);
  const drawEnd = Math.min(count, drawStart + (Number.isFinite(geometry.drawRange.count) ? geometry.drawRange.count : count));
  const ranges =
    Array.isArray(material) && geometry.groups.length > 0
      ? geometry.groups.map((g) => ({ start: g.start, end: g.start + g.count, mat: g.materialIndex ?? 0 }))
      : [{ start: 0, end: count, mat: 0 }];
  const byMat = new Map<number, number[][]>();
  for (const r of ranges) {
    const start = Math.max(r.start, drawStart);
    const end = Math.min(r.end, drawEnd);
    let list = byMat.get(r.mat);
    if (!list) byMat.set(r.mat, (list = []));
    for (let i = start; i + 2 < end; i += 3) {
      list.push([vertexAt(i), vertexAt(i + 1), vertexAt(i + 2)]);
    }
  }
  const mats = Array.isArray(material) ? material : [material];
  return [...byMat.entries()].map(([mi, triangles]) => ({ index: mi, material: mats[mi] ?? mats[0] ?? null, triangles }));
}

/** Les normales du fichier s'écartent-elles des normales de faces (ombrage lisse) ? */
function hasSmoothNormals(geometry: BufferGeometry): boolean {
  const normal = geometry.getAttribute('normal');
  const pos = geometry.getAttribute('position');
  if (!normal) return false;
  const index = geometry.getIndex();
  const count = index ? index.count : pos.count;
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const n = new Vector3();
  const vn = new Vector3();
  const cosLimit = Math.cos((8 * Math.PI) / 180);
  // Échantillonnage borné : inutile de parcourir des millions de triangles pour décider.
  const step = Math.max(1, Math.floor(count / 3 / 20000)) * 3;
  for (let t = 0; t + 2 < count; t += step) {
    const i0 = index ? index.getX(t) : t;
    const i1 = index ? index.getX(t + 1) : t + 1;
    const i2 = index ? index.getX(t + 2) : t + 2;
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    n.subVectors(c, b).cross(a.sub(b));
    if (n.lengthSq() < 1e-20) continue;
    n.normalize();
    for (const i of [i0, i1, i2]) {
      vn.fromBufferAttribute(normal, i);
      if (vn.lengthSq() < 1e-12) continue;
      if (vn.normalize().dot(n) < cosLimit) return true;
    }
  }
  return false;
}

