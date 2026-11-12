import { Matrix4, Quaternion, Vector3 } from 'three';
import { CAMERA_DEFAULTS, type CameraData, type LightData, type MaterialData } from '../../core/doc/schema';
import {
  Y_UP_TO_Z_UP,
  baseName,
  convertTransform,
  finiteOr,
  hasSmoothNormals,
  isDegenerateTriangle,
  linearToHex,
  sanitizeMatrix,
  srgbToLinear,
} from './convert';
import type { ImportedMesh, ImportedObject, ImportedScene } from './scene';

/**
 * Lecteur glTF 2.0 (.glb binaire et .gltf texte autonome) vers le format neutre `ImportedScene`.
 *
 * Écrit sans GLTFLoader : aucune dépendance au DOM ni à WebGL (utilisable sous Node), et la
 * structure du fichier est reprise telle quelle — hiérarchie complète, maillages partagés,
 * primitives multiples, lumières et caméras.
 *
 * REPÈRE. glTF est Y vers le haut, CoForge Z vers le haut ; C = rotation de +90° autour de X.
 *  - Maillages et vides : sommets locaux convertis (p → C·p) et matrice monde conjuguée
 *    (C·M·C⁻¹). Un objet debout garde une rotation nulle, l'aller-retour avec `exportGLB` est exact.
 *  - Lumières et caméras : elles visent −Z local (+Y vers le haut) en glTF comme dans CoForge et
 *    Blender (voir `src/engine/lights.ts`). Leur repère local ne doit donc PAS être converti :
 *    matrice monde = C·M seulement.
 *
 * LUMIÈRES (KHR_lights_punctual). glTF donne des candelas (point, spot) ou des lux (directionnelle),
 * CoForge des watts « à la Blender ». La conversion est celle de l'import glTF de Blender en mode
 * standard, avec 683 lm/W :
 *    point, spot : W    = cd × 4π / 683          soleil : W/m² = lux / 683
 *    spot        : angle = 2 × outerConeAngle,  adoucissement = 1 − innerConeAngle / outerConeAngle
 *
 * NON REPRIS (signalé dans `warnings`) : textures (CoForge n'en affiche pas ; la couleur moyenne de
 * l'image de couleur de base est utilisée quand l'environnement sait la décoder), animations,
 * skins, cibles de morphing, primitives de points et de lignes, compression Draco et Meshopt.
 * Les triangles coplanaires issus d'un quad ne sont pas refusionnés.
 */

const GLB_MAGIC = 0x46546c67; // « glTF »
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** Efficacité lumineuse retenue par Blender pour convertir lumens et watts. */
const LUMENS_PER_WATT = 683;

const TYPE_SIZES: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const HANDLED_EXTENSIONS = new Set([
  'KHR_lights_punctual',
  'KHR_materials_emissive_strength',
  'KHR_materials_transmission',
  'KHR_materials_ior',
  'KHR_materials_pbrSpecularGlossiness',
  'KHR_mesh_quantization',
  'EXT_mesh_gpu_instancing',
]);

type Json = Record<string, any>;

interface Container {
  json: Json;
  bin: Uint8Array | null;
}

function parseJson(text: string): Json {
  let json: unknown;
  try {
    json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new Error('Fichier glTF illisible : JSON invalide ou tronqué.');
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error("Fichier glTF illisible : le contenu n'est pas un objet JSON.");
  return json as Json;
}

function parseContainer(data: ArrayBuffer | string): Container {
  if (typeof data === 'string') {
    if (!data.trim()) throw new Error('Fichier glTF vide.');
    return { json: parseJson(data), bin: null };
  }
  if (data.byteLength === 0) throw new Error('Fichier glTF vide.');
  const view = new DataView(data);
  if (data.byteLength < 4 || view.getUint32(0, true) !== GLB_MAGIC) {
    // Un .gltf texte fourni sous forme d'octets.
    return { json: parseJson(new TextDecoder().decode(new Uint8Array(data))), bin: null };
  }
  if (data.byteLength < 20) throw new Error('Fichier GLB tronqué (en-tête incomplet).');
  const version = view.getUint32(4, true);
  if (version !== 2) throw new Error(`Version ${version} du conteneur GLB non prise en charge (seul glTF 2.0 est lu).`);
  let json: Json | null = null;
  let bin: Uint8Array | null = null;
  let offset = 12;
  while (offset + 8 <= data.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + length > data.byteLength) throw new Error('Fichier GLB tronqué (bloc de données incomplet).');
    if (type === CHUNK_JSON && !json) json = parseJson(new TextDecoder().decode(new Uint8Array(data, start, length)));
    else if (type === CHUNK_BIN && !bin) bin = new Uint8Array(data, start, length);
    offset = start + length + ((4 - (length % 4)) % 4);
  }
  if (!json) throw new Error('Fichier GLB invalide : bloc JSON absent.');
  return { json, bin };
}

function decodeDataUri(uri: string): Uint8Array {
  const comma = uri.indexOf(',');
  if (comma < 0) throw new Error('URI de données illisible.');
  const meta = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  try {
    if (/;base64$/i.test(meta)) {
      const bin = atob(payload.replace(/\s+/g, ''));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new TextEncoder().encode(decodeURIComponent(payload));
  } catch {
    throw new Error('URI de données illisible (base64 invalide).');
  }
}

function shortUri(uri: string): string {
  return uri.length > 60 ? `${uri.slice(0, 57)}…` : uri;
}

function vec(value: unknown, size: number, fallback: number[]): number[] {
  if (!Array.isArray(value) || value.length < size) return fallback;
  const out = new Array<number>(size);
  for (let i = 0; i < size; i++) out[i] = typeof value[i] === 'number' && Number.isFinite(value[i]) ? value[i] : fallback[i];
  return out;
}

function validIndex(i: unknown, list: unknown): i is number {
  return typeof i === 'number' && Number.isInteger(i) && i >= 0 && Array.isArray(list) && i < list.length;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n > 1 ? many : one}`;
}

interface BuiltMesh {
  /** Indice dans `scene.meshes`, null si aucune face exploitable. */
  index: number | null;
  /** Matériau glTF de chaque emplacement (null = aucun). */
  slots: (number | null)[];
  smooth: boolean;
}

/**
 * Lit un fichier glTF 2.0 : `ArrayBuffer` pour un .glb (ou un .gltf en octets), texte JSON pour
 * un .gltf. Les tampons doivent être intégrés (bloc binaire du GLB ou URI `data:`).
 */
export async function readGLTFScene(data: ArrayBuffer | string, name = ''): Promise<ImportedScene> {
  const { json, bin } = parseContainer(data);
  const asset = json.asset;
  if (!asset || typeof asset !== 'object') throw new Error("Ce fichier n'est pas un glTF (bloc « asset » absent).");
  const major = parseInt(String(asset.version ?? '2'), 10);
  if (Number.isFinite(major) && major !== 2) throw new Error(`glTF ${asset.version} non pris en charge (seul glTF 2.0 est lu).`);

  const warnings: string[] = [];
  const nodes: Json[] = Array.isArray(json.nodes) ? json.nodes : [];
  const meshDefs: Json[] = Array.isArray(json.meshes) ? json.meshes : [];
  const materialDefs: Json[] = Array.isArray(json.materials) ? json.materials : [];
  const cameraDefs: Json[] = Array.isArray(json.cameras) ? json.cameras : [];
  const lightDefs: Json[] = Array.isArray(json.extensions?.KHR_lights_punctual?.lights) ? json.extensions.KHR_lights_punctual.lights : [];
  const scenes: Json[] = Array.isArray(json.scenes) ? json.scenes : [];

  // ---------------------------------------------------------------- tampons et accesseurs

  const bufferCache = new Map<number, Uint8Array>();
  const bufferBytes = (index: number): Uint8Array => {
    const cached = bufferCache.get(index);
    if (cached) return cached;
    const def = json.buffers?.[index];
    if (!def || typeof def !== 'object') throw new Error(`Fichier glTF invalide : tampon ${index} introuvable.`);
    let bytes: Uint8Array;
    if (def.uri === undefined || def.uri === null) {
      if (index !== 0 || !bin) throw new Error('Fichier GLB tronqué : bloc binaire absent.');
      bytes = bin;
    } else if (typeof def.uri === 'string' && /^data:/i.test(def.uri)) {
      bytes = decodeDataUri(def.uri);
    } else {
      throw new Error(
        `Le fichier référence un tampon externe (« ${shortUri(String(def.uri))} ») inaccessible à l'import : ` +
          'utilisez un .glb ou un .gltf à données intégrées.',
      );
    }
    bufferCache.set(index, bytes);
    return bytes;
  };

  /** Octets d'une vue de tampon, bornes vérifiées. */
  const viewBytes = (index: number, what: string): { bytes: Uint8Array; stride: number } => {
    const def = json.bufferViews?.[index];
    if (!def || typeof def !== 'object') throw new Error(`Fichier glTF invalide : vue de tampon ${index} introuvable (${what}).`);
    if (def.extensions?.EXT_meshopt_compression) {
      throw new Error('Géométrie compressée (Meshopt) non prise en charge : réexportez le fichier sans compression.');
    }
    const buffer = bufferBytes(def.buffer | 0);
    const offset = Math.max(0, def.byteOffset | 0);
    const length = Math.max(0, def.byteLength | 0);
    if (offset + length > buffer.byteLength) throw new Error(`Fichier glTF tronqué : ${what} dépasse la fin des données.`);
    return { bytes: buffer.subarray(offset, offset + length), stride: Math.max(0, def.byteStride | 0) };
  };

  const readComponent = (dv: DataView, at: number, type: number): number => {
    switch (type) {
      case 5120:
        return dv.getInt8(at);
      case 5121:
        return dv.getUint8(at);
      case 5122:
        return dv.getInt16(at, true);
      case 5123:
        return dv.getUint16(at, true);
      case 5125:
        return dv.getUint32(at, true);
      default:
        return dv.getFloat32(at, true);
    }
  };

  const readRaw = (
    viewIndex: number,
    byteOffset: number,
    componentType: number,
    size: number,
    count: number,
    what: string,
    out: Float64Array,
  ): void => {
    const bytes = COMPONENT_BYTES[componentType];
    const { bytes: src, stride: declared } = viewBytes(viewIndex, what);
    const stride = declared || size * bytes;
    const base = Math.max(0, byteOffset | 0);
    if (count > 0 && base + stride * (count - 1) + size * bytes > src.byteLength) {
      throw new Error(`Fichier glTF tronqué : ${what} dépasse la fin des données.`);
    }
    const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
    for (let i = 0; i < count; i++) {
      const at = base + i * stride;
      for (let k = 0; k < size; k++) out[i * size + k] = readComponent(dv, at + k * bytes, componentType);
    }
  };

  /** Valeurs d'un accesseur en flottants (données creuses et entiers normalisés gérés). */
  const readAccessor = (index: number, what: string): { array: Float64Array; size: number; count: number } => {
    const acc = json.accessors?.[index];
    if (!acc || typeof acc !== 'object') throw new Error(`Fichier glTF invalide : accesseur ${index} introuvable (${what}).`);
    const size = TYPE_SIZES[acc.type];
    const componentType = acc.componentType | 0;
    if (!size || !COMPONENT_BYTES[componentType]) throw new Error(`Fichier glTF invalide : type d'accesseur inconnu (${what}).`);
    const count = Math.max(0, acc.count | 0);
    const array = new Float64Array(count * size);
    if (typeof acc.bufferView === 'number') readRaw(acc.bufferView, acc.byteOffset | 0, componentType, size, count, what, array);
    const sparse = acc.sparse;
    if (sparse && typeof sparse === 'object' && sparse.indices && sparse.values) {
      const n = Math.max(0, sparse.count | 0);
      const idx = new Float64Array(n);
      const val = new Float64Array(n * size);
      readRaw(sparse.indices.bufferView | 0, sparse.indices.byteOffset | 0, sparse.indices.componentType | 0, 1, n, what, idx);
      readRaw(sparse.values.bufferView | 0, sparse.values.byteOffset | 0, componentType, size, n, what, val);
      for (let i = 0; i < n; i++) {
        const target = idx[i];
        if (!(target >= 0 && target < count)) continue;
        for (let k = 0; k < size; k++) array[target * size + k] = val[i * size + k];
      }
    }
    if (acc.normalized === true && componentType !== 5126 && componentType !== 5125) {
      const max = componentType === 5120 ? 127 : componentType === 5121 ? 255 : componentType === 5122 ? 32767 : 65535;
      const signed = componentType === 5120 || componentType === 5122;
      for (let i = 0; i < array.length; i++) array[i] = signed ? Math.max(-1, array[i] / max) : array[i] / max;
    }
    return { array, size, count };
  };

  // ---------------------------------------------------------------- matériaux

  const materials: Omit<MaterialData, 'id'>[] = [];
  const materialIndex = new Map<number, number>();
  let textured = 0;
  let averaged = 0;

  const canDecodeImages = typeof createImageBitmap === 'function' && typeof OffscreenCanvas !== 'undefined';
  const imageAverages = new Map<number, Promise<[number, number, number, number] | null>>();

  /** Couleur moyenne (RVB linéaire pondéré par l'alpha, alpha moyen) de l'image d'une texture. */
  const textureAverage = (textureIndex: unknown): Promise<[number, number, number, number] | null> => {
    if (!canDecodeImages || !validIndex(textureIndex, json.textures)) return Promise.resolve(null);
    const tex = json.textures[textureIndex];
    const source = tex?.source ?? tex?.extensions?.EXT_texture_webp?.source ?? tex?.extensions?.EXT_texture_avif?.source;
    if (!validIndex(source, json.images)) return Promise.resolve(null);
    let pending = imageAverages.get(source);
    if (!pending) {
      pending = (async () => {
        try {
          const image = json.images[source];
          let bytes: Uint8Array;
          if (typeof image.bufferView === 'number') bytes = viewBytes(image.bufferView, 'image').bytes;
          else if (typeof image.uri === 'string' && /^data:/i.test(image.uri)) bytes = decodeDataUri(image.uri);
          else return null; // fichier image externe : inaccessible
          const blob = new Blob([bytes.slice()], typeof image.mimeType === 'string' ? { type: image.mimeType } : undefined);
          const bitmap = await createImageBitmap(blob);
          const w = Math.max(1, Math.min(64, bitmap.width));
          const h = Math.max(1, Math.min(64, bitmap.height));
          const ctx = new OffscreenCanvas(w, h).getContext('2d');
          if (!ctx) return null;
          ctx.drawImage(bitmap, 0, 0, w, h);
          bitmap.close?.();
          const px = ctx.getImageData(0, 0, w, h).data;
          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;
          for (let i = 0; i + 3 < px.length; i += 4) {
            const alpha = px[i + 3] / 255;
            r += srgbToLinear(px[i] / 255) * alpha;
            g += srgbToLinear(px[i + 1] / 255) * alpha;
            b += srgbToLinear(px[i + 2] / 255) * alpha;
            a += alpha;
          }
          if (!(a > 0)) return null;
          return [r / a, g / a, b / a, a / (px.length / 4)] as [number, number, number, number];
        } catch {
          return null;
        }
      })();
      imageAverages.set(source, pending);
    }
    return pending;
  };

  const convertMaterial = async (def: Json, index: number): Promise<Omit<MaterialData, 'id'>> => {
    const pbr: Json = def.pbrMetallicRoughness && typeof def.pbrMetallicRoughness === 'object' ? def.pbrMetallicRoughness : {};
    const ext: Json = def.extensions && typeof def.extensions === 'object' ? def.extensions : {};
    // Ancien modèle spéculaire/brillance : repris au plus proche (diffus → couleur, brillance → rugosité).
    const sg: Json | null = !def.pbrMetallicRoughness && ext.KHR_materials_pbrSpecularGlossiness ? ext.KHR_materials_pbrSpecularGlossiness : null;
    const factor = vec(sg ? sg.diffuseFactor : pbr.baseColorFactor, 4, [1, 1, 1, 1]);
    let [r, g, b, a] = factor;
    const colorTexture = sg ? sg.diffuseTexture : pbr.baseColorTexture;
    let alphaFromTexture = false;
    if (colorTexture && typeof colorTexture === 'object') {
      textured++;
      const avg = await textureAverage(colorTexture.index);
      if (avg) {
        averaged++;
        r *= avg[0];
        g *= avg[1];
        b *= avg[2];
        a *= avg[3];
      } else {
        alphaFromTexture = true; // alpha réel inconnu : celui du facteur seul
      }
    }
    const emissive = vec(def.emissiveFactor, 3, [0, 0, 0]);
    const emissiveOn = emissive[0] > 0 || emissive[1] > 0 || emissive[2] > 0;
    const strength = finiteOr(ext.KHR_materials_emissive_strength?.emissiveStrength, 1, 0);
    const mode = typeof def.alphaMode === 'string' ? def.alphaMode.toUpperCase() : 'OPAQUE';
    let alpha = 1;
    if (mode === 'BLEND') alpha = Math.min(1, Math.max(0, a));
    else if (mode === 'MASK') alpha = alphaFromTexture || a >= finiteOr(def.alphaCutoff, 0.5) ? 1 : 0;
    return {
      name: typeof def.name === 'string' && def.name.trim() ? def.name.trim() : `Matériau ${index + 1}`,
      baseColor: linearToHex(r, g, b),
      metallic: sg ? 0 : finiteOr(pbr.metallicFactor, 1, 0, 1),
      roughness: sg ? 1 - finiteOr(sg.glossinessFactor, 1, 0, 1) : finiteOr(pbr.roughnessFactor, 1, 0, 1),
      emission: emissiveOn ? linearToHex(emissive[0], emissive[1], emissive[2]) : '#000000',
      emissionStrength: emissiveOn ? strength : 0,
      alpha,
      transmission: finiteOr(ext.KHR_materials_transmission?.transmissionFactor, 0, 0, 1),
      // Sans l'extension KHR_materials_ior, l'indice de réfraction de glTF vaut 1,5.
      ior: finiteOr(ext.KHR_materials_ior?.ior, 1.5, 1, 2.333),
    };
  };

  // ---------------------------------------------------------------- maillages

  const meshes: ImportedMesh[] = [];
  const builtMeshes = new Map<number, BuiltMesh>();
  let skippedPrimitives = 0;
  let dracoPrimitives = 0;
  let invalidTriangles = 0;
  let morphTargets = false;

  const buildMesh = (meshIndex: number): BuiltMesh => {
    const known = builtMeshes.get(meshIndex);
    if (known) return known;
    const def = meshDefs[meshIndex];
    const primitives: Json[] = Array.isArray(def?.primitives) ? def.primitives : [];
    const chunks: Float64Array[] = [];
    const bases = new Map<number, { base: number; count: number; array: Float64Array }>();
    const polygons: number[][] = [];
    const polygonSlots: number[] = [];
    const slots: (number | null)[] = [];
    let vertexCount = 0;
    let smooth = false;

    for (const prim of primitives) {
      if (!prim || typeof prim !== 'object') continue;
      if (Array.isArray(prim.targets) && prim.targets.length > 0) morphTargets = true;
      if (prim.extensions?.KHR_draco_mesh_compression) {
        dracoPrimitives++;
        continue;
      }
      const mode = prim.mode === undefined ? 4 : prim.mode | 0;
      if (mode !== 4 && mode !== 5 && mode !== 6) {
        skippedPrimitives++; // points, lignes
        continue;
      }
      const posAccessor = prim.attributes?.POSITION;
      if (typeof posAccessor !== 'number') continue;

      // Plusieurs primitives peuvent partager le même accesseur de positions : lu une seule fois.
      let entry = bases.get(posAccessor);
      if (!entry) {
        const acc = readAccessor(posAccessor, `positions du maillage « ${def?.name ?? meshIndex} »`);
        if (acc.size !== 3) continue;
        // Y vers le haut → Z vers le haut : (x, y, z) → (x, −z, y).
        const src = acc.array;
        const out = new Float64Array(src.length);
        for (let i = 0; i + 2 < src.length; i += 3) {
          out[i] = src[i];
          out[i + 1] = -src[i + 2];
          out[i + 2] = src[i + 1];
        }
        entry = { base: vertexCount, count: acc.count, array: out };
        bases.set(posAccessor, entry);
        chunks.push(out);
        vertexCount += acc.count;
      }
      const { base, count, array } = entry;

      const indices = typeof prim.indices === 'number' ? readAccessor(prim.indices, 'indices').array : null;
      const n = indices ? indices.length : count;
      const at = indices ? (k: number) => indices[k] : (k: number) => k;

      const materialKey = validIndex(prim.material, materialDefs) ? prim.material : null;
      let slot = slots.indexOf(materialKey);
      if (slot < 0) {
        slot = slots.length;
        slots.push(materialKey);
      }

      const first = polygons.length;
      const push = (a: number, b: number, c: number): void => {
        if (!(a >= 0 && a < count && b >= 0 && b < count && c >= 0 && c < count)) {
          invalidTriangles++;
          return;
        }
        if (isDegenerateTriangle(array, a, b, c)) return;
        polygons.push([base + a, base + b, base + c]);
        polygonSlots.push(slot);
      };
      if (mode === 4) {
        for (let k = 0; k + 2 < n; k += 3) push(at(k), at(k + 1), at(k + 2));
      } else if (mode === 5) {
        // Bande : le sens s'inverse un triangle sur deux.
        for (let k = 0; k + 2 < n; k++) {
          if (k % 2 === 0) push(at(k), at(k + 1), at(k + 2));
          else push(at(k + 1), at(k), at(k + 2));
        }
      } else {
        for (let k = 1; k + 1 < n; k++) push(at(0), at(k), at(k + 1));
      }

      // Ombrage lisse : les normales du fichier s'écartent des normales de faces.
      if (!smooth && typeof prim.attributes?.NORMAL === 'number' && polygons.length > first) {
        const nrm = readAccessor(prim.attributes.NORMAL, 'normales');
        if (nrm.size === 3 && nrm.count === count) {
          const src = nrm.array;
          const out = new Float64Array(src.length);
          for (let i = 0; i + 2 < src.length; i += 3) {
            out[i] = src[i];
            out[i + 1] = -src[i + 2];
            out[i + 2] = src[i + 1];
          }
          // Échantillon borné : inutile de recopier des millions de triangles pour décider.
          const step = Math.max(1, Math.floor((polygons.length - first) / 20000));
          const sample: number[][] = [];
          for (let k = first; k < polygons.length; k += step) {
            const p = polygons[k];
            sample.push([p[0] - base, p[1] - base, p[2] - base]);
          }
          smooth = hasSmoothNormals(array, out, sample);
        }
      }
    }

    let index: number | null = null;
    if (polygons.length > 0) {
      let positions: Float64Array;
      if (chunks.length === 1) positions = chunks[0];
      else {
        positions = new Float64Array(vertexCount * 3);
        let o = 0;
        for (const c of chunks) {
          positions.set(c, o);
          o += c.length;
        }
      }
      index = meshes.length;
      meshes.push({
        name: typeof def?.name === 'string' && def.name.trim() ? def.name.trim() : `Maillage ${meshIndex + 1}`,
        positions,
        polygons,
        polygonSlots: slots.length > 1 ? polygonSlots : undefined,
        weld: true,
      });
    }
    const built: BuiltMesh = { index, slots: slots.length > 0 ? slots : [null], smooth };
    builtMeshes.set(meshIndex, built);
    return built;
  };

  // ---------------------------------------------------------------- lumières et caméras

  const lightData = (def: Json): Partial<Omit<LightData, 'id'>> => {
    const color = vec(def.color, 3, [1, 1, 1]);
    const intensity = finiteOr(def.intensity, 1, 0);
    const base = { color: linearToHex(color[0], color[1], color[2]) };
    if (def.type === 'directional') return { ...base, kind: 'sun', power: intensity / LUMENS_PER_WATT };
    const power = (intensity * 4 * Math.PI) / LUMENS_PER_WATT;
    if (def.type === 'spot') {
      const spot: Json = def.spot && typeof def.spot === 'object' ? def.spot : {};
      const outer = finiteOr(spot.outerConeAngle, Math.PI / 4, 1e-4, Math.PI / 2);
      const inner = finiteOr(spot.innerConeAngle, 0, 0, outer);
      return {
        ...base,
        kind: 'spot',
        power,
        spotAngle: Math.min(180, Math.max(1, (outer * 2 * 180) / Math.PI)),
        spotBlend: Math.min(1, Math.max(0, 1 - inner / outer)),
      };
    }
    return { ...base, kind: 'point', power };
  };

  const cameraData = (def: Json): Partial<Omit<CameraData, 'id'>> => {
    if (def.type === 'orthographic') {
      const o: Json = def.orthographic && typeof def.orthographic === 'object' ? def.orthographic : {};
      const near = finiteOr(o.znear, CAMERA_DEFAULTS.near, 0);
      return {
        kind: 'ortho',
        // ymag est la demi-hauteur visible ; `orthoScale` la hauteur complète.
        orthoScale: Math.max(1e-6, 2 * Math.abs(finiteOr(o.ymag, CAMERA_DEFAULTS.orthoScale / 2))),
        near,
        far: Math.max(near + 1e-6, finiteOr(o.zfar, CAMERA_DEFAULTS.far, 0)),
      };
    }
    const p: Json = def.perspective && typeof def.perspective === 'object' ? def.perspective : {};
    const near = finiteOr(p.znear, CAMERA_DEFAULTS.near, 1e-6);
    return {
      kind: 'persp',
      // yfov : champ vertical en radians.
      fov: Math.min(179, Math.max(1, (finiteOr(p.yfov, (CAMERA_DEFAULTS.fov * Math.PI) / 180, 0) * 180) / Math.PI)),
      near,
      // zfar absent = projection infinie : valeur par défaut du document.
      far: Math.max(near + 1e-6, finiteOr(p.zfar, CAMERA_DEFAULTS.far, 0)),
    };
  };

  // ---------------------------------------------------------------- scène et hiérarchie

  const sceneIndex = validIndex(json.scene, scenes) ? json.scene : 0;
  const sceneDef: Json | undefined = scenes[sceneIndex];
  let roots: number[];
  if (sceneDef && Array.isArray(sceneDef.nodes)) roots = sceneDef.nodes;
  else if (scenes.length === 0) {
    // Pas de scène déclarée : toutes les racines (nœuds sans parent).
    const child = new Set<number>();
    for (const n of nodes) if (Array.isArray(n?.children)) for (const c of n.children) child.add(c);
    roots = nodes.map((_, i) => i).filter((i) => !child.has(i));
  } else roots = [];
  if (scenes.length > 1) {
    const label = typeof sceneDef?.name === 'string' && sceneDef.name ? `« ${sceneDef.name} »` : `n° ${sceneIndex + 1}`;
    warnings.push(`Le fichier contient ${scenes.length} scènes : seule la scène par défaut (${label}) est importée.`);
  }

  // Os d'armature : inutiles sans déformation. Ceux qui ne portent rien sont écartés.
  const joints = new Set<number>();
  if (Array.isArray(json.skins)) for (const s of json.skins) if (Array.isArray(s?.joints)) for (const j of s.joints) joints.add(j);
  const lightOf = (n: Json): number | null => {
    const l = n.extensions?.KHR_lights_punctual?.light;
    return validIndex(l, lightDefs) ? l : null;
  };
  const keepMemo = new Map<number, boolean>();
  const keep = (index: number, depth = 0): boolean => {
    const known = keepMemo.get(index);
    if (known !== undefined) return known;
    keepMemo.set(index, true); // garde contre les cycles
    const n = nodes[index];
    let result = true;
    if (!n || typeof n !== 'object') result = false;
    else if (joints.has(index) && depth < 512) {
      result =
        validIndex(n.mesh, meshDefs) ||
        validIndex(n.camera, cameraDefs) ||
        lightOf(n) !== null ||
        (Array.isArray(n.children) && n.children.some((c: unknown) => validIndex(c, nodes) && keep(c, depth + 1)));
    }
    keepMemo.set(index, result);
    return result;
  };

  // Matériaux réellement utilisés par la scène importée, convertis d'abord (décodage d'image asynchrone).
  {
    const seenNodes = new Set<number>();
    const usedMaterials = new Set<number>();
    const stack = roots.filter((r) => validIndex(r, nodes));
    while (stack.length > 0) {
      const i = stack.pop()!;
      if (seenNodes.has(i)) continue;
      seenNodes.add(i);
      const n = nodes[i];
      if (!n || typeof n !== 'object') continue;
      if (validIndex(n.mesh, meshDefs)) {
        const prims = meshDefs[n.mesh]?.primitives;
        if (Array.isArray(prims)) for (const p of prims) if (validIndex(p?.material, materialDefs)) usedMaterials.add(p.material);
      }
      if (Array.isArray(n.children)) for (const c of n.children) if (validIndex(c, nodes)) stack.push(c);
    }
    for (const mi of [...usedMaterials].sort((a, b) => a - b)) {
      materialIndex.set(mi, materials.length);
      materials.push(await convertMaterial(materialDefs[mi] ?? {}, mi));
    }
  }

  const objects: ImportedObject[] = [];
  const visited = new Set<number>();
  let activeCamera: number | null = null;
  let prunedJoints = 0;
  let brokenMatrices = 0;

  const localMatrix = (n: Json, out: Matrix4): Matrix4 => {
    if (Array.isArray(n.matrix) && n.matrix.length === 16) out.fromArray(n.matrix);
    else {
      const t = vec(n.translation, 3, [0, 0, 0]);
      const q = vec(n.rotation, 4, [0, 0, 0, 1]);
      const s = vec(n.scale, 3, [1, 1, 1]);
      const quat = new Quaternion(q[0], q[1], q[2], q[3]);
      if (quat.lengthSq() > 1e-20) quat.normalize();
      else quat.identity();
      out.compose(new Vector3(t[0], t[1], t[2]), quat, new Vector3(s[0], s[1], s[2]));
    }
    if (!sanitizeMatrix(out)) brokenMatrices++;
    return out;
  };

  /** Matrice monde d'un maillage ou d'un vide : C·M·C⁻¹ (les sommets locaux sont convertis aussi). */
  const conjugated = (world: Matrix4): Matrix4 => convertTransform(world, false);
  /** Matrice monde d'une lumière ou d'une caméra : C·M (leur repère local, visée −Z, est conservé). */
  const aimed = (world: Matrix4): Matrix4 => new Matrix4().multiplyMatrices(Y_UP_TO_Z_UP, world);

  const addLight = (def: Json, label: string, parent: number | null, world: Matrix4): number => {
    objects.push({
      name: label,
      type: 'light',
      parent,
      matrixWorld: aimed(world),
      collection: null,
      light: lightData(def),
    });
    return objects.length - 1;
  };
  const addCamera = (def: Json, label: string, parent: number | null, world: Matrix4): number => {
    objects.push({
      name: label,
      type: 'camera',
      parent,
      matrixWorld: aimed(world),
      collection: null,
      camera: cameraData(def),
    });
    if (activeCamera === null) activeCamera = objects.length - 1;
    return objects.length - 1;
  };

  // Parcours itératif (pas de limite de profondeur de pile sur les longues chaînes de nœuds).
  const stack: { node: number; parent: number | null; parentWorld: Matrix4 }[] = [];
  for (let i = roots.length - 1; i >= 0; i--) if (validIndex(roots[i], nodes)) stack.push({ node: roots[i], parent: null, parentWorld: new Matrix4() });
  while (stack.length > 0) {
    const { node: index, parent, parentWorld } = stack.pop()!;
    if (visited.has(index)) continue;
    visited.add(index);
    const n = nodes[index];
    if (!n || typeof n !== 'object') continue;
    if (!keep(index)) {
      prunedJoints++;
      continue;
    }
    const world = new Matrix4().multiplyMatrices(parentWorld, localMatrix(n, new Matrix4()));
    const built = validIndex(n.mesh, meshDefs) ? buildMesh(n.mesh) : null;
    const meshIndex = built ? built.index : null;
    const cameraDef = validIndex(n.camera, cameraDefs) ? cameraDefs[n.camera] : null;
    const li = lightOf(n);
    const lightDef = li !== null ? lightDefs[li] : null;
    const meshName = built && typeof meshDefs[n.mesh]?.name === 'string' ? meshDefs[n.mesh].name : '';
    const label =
      (typeof n.name === 'string' && n.name.trim()) ||
      meshName ||
      (typeof cameraDef?.name === 'string' && cameraDef.name) ||
      (typeof lightDef?.name === 'string' && lightDef.name) ||
      `Nœud ${index + 1}`;

    let self: number;
    const instancing = n.extensions?.EXT_mesh_gpu_instancing?.attributes;
    if (meshIndex !== null && built && instancing && typeof instancing === 'object') {
      // Instances GPU : un vide porteur et un objet par instance, tous liés au même maillage.
      objects.push({ name: label, type: 'empty', parent, matrixWorld: conjugated(world), collection: null });
      self = objects.length - 1;
      const t = typeof instancing.TRANSLATION === 'number' ? readAccessor(instancing.TRANSLATION, 'instances') : null;
      const r = typeof instancing.ROTATION === 'number' ? readAccessor(instancing.ROTATION, 'instances') : null;
      const s = typeof instancing.SCALE === 'number' ? readAccessor(instancing.SCALE, 'instances') : null;
      const count = Math.max(t?.count ?? 0, r?.count ?? 0, s?.count ?? 0);
      const pos = new Vector3();
      const quat = new Quaternion();
      const scl = new Vector3();
      const inst = new Matrix4();
      for (let i = 0; i < count; i++) {
        if (t && i < t.count) pos.set(t.array[i * 3], t.array[i * 3 + 1], t.array[i * 3 + 2]);
        else pos.set(0, 0, 0);
        if (r && i < r.count) quat.set(r.array[i * 4], r.array[i * 4 + 1], r.array[i * 4 + 2], r.array[i * 4 + 3]);
        else quat.identity();
        if (quat.lengthSq() > 1e-20) quat.normalize();
        else quat.identity();
        if (s && i < s.count) scl.set(s.array[i * 3], s.array[i * 3 + 1], s.array[i * 3 + 2]);
        else scl.set(1, 1, 1);
        inst.compose(pos, quat, scl);
        if (!sanitizeMatrix(inst)) brokenMatrices++;
        objects.push({
          name: `${label}.${String(i + 1).padStart(3, '0')}`,
          type: 'mesh',
          parent: self,
          matrixWorld: conjugated(new Matrix4().multiplyMatrices(world, inst)),
          collection: null,
          mesh: meshIndex,
          materials: built.slots.map((m) => (m === null ? null : (materialIndex.get(m) ?? null))),
          shadeSmooth: built.smooth,
        });
      }
    } else if (meshIndex !== null && built) {
      objects.push({
        name: label,
        type: 'mesh',
        parent,
        matrixWorld: conjugated(world),
        collection: null,
        mesh: meshIndex,
        materials: built.slots.map((m) => (m === null ? null : (materialIndex.get(m) ?? null))),
        shadeSmooth: built.smooth,
      });
      self = objects.length - 1;
    } else if (cameraDef && !lightDef) {
      self = addCamera(cameraDef, label, parent, world);
    } else if (lightDef && !cameraDef) {
      self = addLight(lightDef, label, parent, world);
    } else {
      objects.push({ name: label, type: 'empty', parent, matrixWorld: conjugated(world), collection: null });
      self = objects.length - 1;
    }
    // Un nœud qui cumule maillage, caméra ou lumière : les compléments deviennent des enfants.
    if (objects[self].type !== 'camera' && cameraDef) addCamera(cameraDef, `${label} (caméra)`, self, world);
    if (objects[self].type !== 'light' && lightDef) addLight(lightDef, `${label} (lumière)`, self, world);

    if (Array.isArray(n.children)) {
      for (let i = n.children.length - 1; i >= 0; i--) {
        const c = n.children[i];
        if (validIndex(c, nodes) && !visited.has(c)) stack.push({ node: c, parent: self, parentWorld: world });
      }
    }
  }

  // ---------------------------------------------------------------- avertissements regroupés

  if (textured > 0) {
    const rest = textured - averaged;
    warnings.push(
      `${plural(textured, 'matériau texturé', 'matériaux texturés')} : CoForge n'affiche pas les textures image` +
        (averaged > 0 ? ` ; ${averaged} repris avec la couleur moyenne de leur texture` : '') +
        (rest > 0 ? ` ; ${rest} gardent leur facteur de couleur de base` : '') +
        '.',
    );
  }
  const notKept: string[] = [];
  const animations = Array.isArray(json.animations) ? json.animations.length : 0;
  const skins = Array.isArray(json.skins) ? json.skins.length : 0;
  if (animations > 0) notKept.push(plural(animations, 'animation', 'animations'));
  if (skins > 0) notKept.push(`${plural(skins, 'armature', 'armatures')} de déformation (maillages importés en pose de repos)`);
  if (morphTargets) notKept.push('cibles de morphing');
  if (notKept.length > 0) warnings.push(`Non repris : ${notKept.join(', ')}.`);
  if (prunedJoints > 0) warnings.push(`${plural(prunedJoints, "branche d'os sans géométrie ignorée", "branches d'os sans géométrie ignorées")}.`);
  if (skippedPrimitives > 0) warnings.push(`${plural(skippedPrimitives, 'primitive de points ou de lignes ignorée', 'primitives de points ou de lignes ignorées')}.`);
  if (dracoPrimitives > 0) {
    warnings.push(
      `${plural(dracoPrimitives, 'primitive compressée (Draco) ignorée', 'primitives compressées (Draco) ignorées')} : réexportez le fichier sans compression.`,
    );
  }
  if (invalidTriangles > 0) warnings.push(`${plural(invalidTriangles, 'triangle à indice invalide ignoré', 'triangles à indices invalides ignorés')}.`);
  if (brokenMatrices > 0) warnings.push(`${plural(brokenMatrices, 'transformation non finie remplacée', 'transformations non finies remplacées')} par l'identité.`);
  const required: string[] = Array.isArray(json.extensionsRequired) ? json.extensionsRequired.filter((e: unknown) => typeof e === 'string') : [];
  const unsupported = required.filter((e) => !HANDLED_EXTENSIONS.has(e) && e !== 'KHR_draco_mesh_compression' && !/^(KHR|EXT)_texture_/.test(e));
  if (unsupported.length > 0) warnings.push(`Extension(s) requise(s) non prise(s) en charge : ${unsupported.join(', ')}.`);

  return {
    name: (typeof sceneDef?.name === 'string' && sceneDef.name.trim()) || baseName(name, '') || undefined,
    objects,
    meshes,
    materials,
    collections: [],
    activeCamera,
    warnings,
  };
}
