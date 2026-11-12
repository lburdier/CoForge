import { Matrix4, SRGBColorSpace, type BufferGeometry, type Color, type Material, type Mesh, type Object3D } from 'three';
import { MATERIAL_DEFAULTS, type CameraData, type LightData, type LightKind, type MaterialData } from '../../core/doc/schema';
import { finiteOr, hasSmoothNormals, isDegenerateTriangle, linearToHex, sanitizeMatrix } from './convert';
import type { ImportedMesh, ImportedObject, ImportedScene } from './scene';

/**
 * Convertisseur commun « arbre Object3D de three.js → ImportedScene », utilisé pour les formats
 * lus par un chargeur de three.js (FBX, Collada, STL).
 *
 *  - Hiérarchie complète : un objet par Object3D (maillage, lumière, caméra, vide sinon), parents
 *    conservés, matrices MONDE. `rootTransform` (changement d'axe et d'unité) est appliquée à
 *    gauche de chaque matrice monde : les sommets locaux ne sont jamais modifiés, les
 *    transformations relatives parent → enfant non plus.
 *  - Géométries indexées ou non, `drawRange`, groupes de matériaux → `polygonSlots` ; une géométrie
 *    partagée par plusieurs Mesh donne un seul `ImportedMesh`. Les `InstancedMesh` deviennent un
 *    vide et un objet par instance.
 *  - Matériaux Standard / Physical / Phong / Lambert / Basic → MaterialData.
 *  - Lumières ponctuelles, spots, directionnelles et surfaciques ; caméras perspective et ortho.
 *    Seule l'orientation de l'objet compte (visée −Z local) : la « cible » des lumières de three.js
 *    est ignorée. `lightFix` / `cameraFix` corrigent les formats dont le repère local diffère.
 *  - Non repris (signalé) : textures, animations, déformation par armature, cibles de morphing,
 *    lignes et nuages de points, lumières d'ambiance. Les branches d'os sans géométrie sont écartées.
 */
export interface ThreeSceneOptions {
  /** Nom de la scène. */
  name?: string;
  /** Appliquée à gauche de toutes les matrices monde (défaut : identité). */
  rootTransform?: Matrix4;
  /** true : `root` est lui-même un objet du fichier ; false (défaut) : simple conteneur. */
  includeRoot?: boolean;
  /** Corrections du repère local (visée), appliquées à droite de la matrice monde. */
  lightFix?: (light: Object3D) => Matrix4 | undefined;
  cameraFix?: (camera: Object3D) => Matrix4 | undefined;
  /** true : `SpotLight.angle` porte l'angle complet du cône et non le demi-angle (FBXLoader). */
  spotFullAngle?: boolean;
  /**
   * true : les couleurs du fichier étaient linéaires alors que le chargeur les a lues comme du
   * sRGB (FBX écrit par Blender) ; les valeurs brutes du fichier sont rétablies.
   */
  rawColorsLinear?: boolean;
  /**
   * Puissance CoForge (W, ou W/m² pour un soleil) d'une lumière de three.js d'intensité donnée.
   * Défaut : l'inverse exact de la conversion du moteur (`lightIntensity` de src/engine/lights.ts),
   * pour que la scène importée soit éclairée comme la scène three.js d'origine.
   */
  lightPower?: (intensity: number, kind: LightKind, area: number) => number;
  /** Plans de coupe d'une caméra, en mètres (défaut : ceux de la caméra three.js). */
  cameraRange?: (near: number, far: number) => [number, number];
  /** Facteur des longueurs de caméra orthographique (unité du fichier → mètres). */
  lengthScale?: number;
  /** false : aucun matériau n'est créé (formats sans matériaux : STL). */
  materials?: boolean;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n > 1 ? many : one}`;
}

/**
 * Couleur three.js (linéaire) → '#rrggbb' sRGB, en ramenant d'abord chaque composante dans 0..1
 * (`scale` : le facteur retiré, à reporter sur l'intensité). `rawLinear` : voir `rawColorsLinear`.
 */
/**
 * Inverse EXACT de `SRGBToLinear` de three.js (mêmes constantes) : `Color.getRGB(…, SRGBColorSpace)`
 * passe par `LinearToSRGB`, dont l'exposant arrondi (0,41666) fausse de 1e-4 les grandes valeurs.
 */
function undoSRGBToLinear(l: number): number {
  if (!Number.isFinite(l)) return 0;
  if (l < 0.04045 * 0.0773993808) return l / 0.0773993808;
  // Arrondi à 10 chiffres significatifs : retire le bruit de l’aller-retour (1000.0000000000001).
  return Number(((Math.pow(l, 1 / 2.4) - 0.0521327014) / 0.9478672986).toPrecision(10));
}

function colorHex(c: Color | undefined, fallback: string, rawLinear = false): { hex: string; scale: number } {
  if (!c || typeof c.r !== 'number') return { hex: fallback, scale: 1 };
  if (rawLinear) {
    // Valeurs telles qu'écrites dans le fichier (le chargeur leur a appliqué sRGB → linéaire) :
    // on les retrouve AVANT de retirer l'intensité, sinon une couleur 1000 500 250 serait élevée
    // à la puissance 2,4 par le chargeur.
    const raw = { r: undoSRGBToLinear(c.r), g: undoSRGBToLinear(c.g), b: undoSRGBToLinear(c.b) };
    const rawMax = Math.max(raw.r, raw.g, raw.b);
    const s = Number.isFinite(rawMax) && rawMax > 1 ? rawMax : 1;
    return { hex: linearToHex(finiteOr(raw.r / s, 0, 0, 1), finiteOr(raw.g / s, 0, 0, 1), finiteOr(raw.b / s, 0, 0, 1)), scale: s };
  }
  const max = Math.max(c.r, c.g, c.b);
  const scale = Number.isFinite(max) && max > 1 ? max : 1;
  const tmp = c.clone();
  tmp.setRGB(finiteOr(c.r / scale, 0, 0, 1), finiteOr(c.g / scale, 0, 0, 1), finiteOr(c.b / scale, 0, 0, 1));
  return { hex: `#${tmp.getHexString()}`, scale };
}

/**
 * Matériau three.js → MaterialData.
 *  - Standard / Physical : métal, rugosité, transmission et indice repris tels quels.
 *  - Phong (FBX, Collada) : rugosité = 1 − √brillance / 10, la règle de l'import FBX de Blender
 *    (réciproque de son export : brillance = (1 − rugosité)² × 100). Le métal vient de
 *    `reflectivity` (ReflectionFactor du FBX), mais seulement strictement entre 0 et 1 : la valeur
 *    1 est aussi la valeur par défaut du chargeur quand le fichier ne dit rien, et la reprendre
 *    rendrait métalliques tous les matériaux Phong ordinaires.
 *  - Lambert / Basic et autres : métal 0, rugosité par défaut.
 */
export function materialFromThree(m: Material, rawColorsLinear = false): Omit<MaterialData, 'id'> {
  const any = m as any;
  const emissive = colorHex(any.emissive, '#000000', rawColorsLinear);
  const emissiveStrength = finiteOr(any.emissiveIntensity, 1, 0) * emissive.scale;
  // Une émission d'intensité nulle (FBX de Blender : couleur blanche × facteur 0) est une absence d'émission.
  const emissiveOn = !!any.emissive && (any.emissive.r > 0 || any.emissive.g > 0 || any.emissive.b > 0) && emissiveStrength > 0;
  let metallic = 0;
  let roughness = MATERIAL_DEFAULTS.roughness;
  if (any.isMeshStandardMaterial) {
    metallic = finiteOr(any.metalness, 0, 0, 1);
    roughness = finiteOr(any.roughness, 1, 0, 1);
  } else if (any.isMeshPhongMaterial) {
    roughness = Math.min(1, Math.max(0, 1 - Math.sqrt(finiteOr(any.shininess, 30, 0)) / 10));
    const reflectivity = finiteOr(any.reflectivity, 0, 0, 1);
    metallic = reflectivity > 0 && reflectivity < 1 ? reflectivity : 0;
  }
  const opacity = finiteOr(m.opacity, 1, 0, 1);
  return {
    name: typeof m.name === 'string' && m.name.trim() ? m.name.trim() : 'Matériau importé',
    baseColor: colorHex(any.color, MATERIAL_DEFAULTS.baseColor, rawColorsLinear).hex,
    metallic,
    roughness,
    emission: emissiveOn ? emissive.hex : '#000000',
    emissionStrength: emissiveOn ? emissiveStrength : 0,
    alpha: m.transparent || opacity < 1 ? opacity : 1,
    transmission: any.isMeshPhysicalMaterial ? finiteOr(any.transmission, 0, 0, 1) : 0,
    ior: any.isMeshPhysicalMaterial ? finiteOr(any.ior, MATERIAL_DEFAULTS.ior, 1, 2.333) : MATERIAL_DEFAULTS.ior,
  };
}

/** Inverse de `lightIntensity` (src/engine/lights.ts) : intensité three.js → watts à la Blender. */
function defaultLightPower(intensity: number, kind: LightKind, area: number): number {
  if (kind === 'sun') return intensity;
  if (kind === 'area') return intensity * 4 * Math.PI * Math.max(1e-4, area);
  return intensity * 4 * Math.PI;
}

interface BuiltGeometry {
  index: number | null;
  slotCount: number;
  smooth: boolean;
}

export function sceneFromThree(root: Object3D, options: ThreeSceneOptions = {}): ImportedScene {
  const rootTransform = options.rootTransform ?? new Matrix4();
  const lightPower = options.lightPower ?? defaultLightPower;
  const lengthScale = finiteOr(options.lengthScale, 1, 1e-12);
  const withMaterials = options.materials !== false;
  const rawLinear = options.rawColorsLinear === true;

  const objects: ImportedObject[] = [];
  const meshes: ImportedMesh[] = [];
  const materials: Omit<MaterialData, 'id'>[] = [];
  const warnings: string[] = [];
  let activeCamera: number | null = null;

  let texturedMaterials = 0;
  let prunedBones = 0;
  let skinned = 0;
  let morphs = false;
  let curves = 0;
  let ambient = 0;
  let brokenMatrices = 0;
  let invalidTriangles = 0;

  root.updateMatrixWorld(true);

  // Les cibles des lumières de three.js sont des aides, pas des objets du fichier.
  const targets = new Set<Object3D>();
  root.traverse((o) => {
    const t = (o as any).target;
    if ((o as any).isLight && t && t.isObject3D) targets.add(t);
  });

  const hasPayload = (o: Object3D): boolean => {
    const any = o as any;
    return !!(any.isMesh || any.isCamera || any.isPointLight || any.isSpotLight || any.isDirectionalLight || any.isRectAreaLight);
  };
  const usefulMemo = new Map<Object3D, boolean>();
  const useful = (o: Object3D): boolean => {
    let u = usefulMemo.get(o);
    if (u === undefined) {
      u = hasPayload(o) || o.children.some(useful);
      usefulMemo.set(o, u);
    }
    return u;
  };

  // ---------------------------------------------------------------- matériaux

  const materialIndex = new Map<string, number>();
  const materialOf = (m: Material | null | undefined): number | null => {
    if (!m || !(m as any).isMaterial) return null;
    let i = materialIndex.get(m.uuid);
    if (i === undefined) {
      i = materials.length;
      materials.push(materialFromThree(m, rawLinear));
      materialIndex.set(m.uuid, i);
      const any = m as any;
      if (any.map || any.emissiveMap || any.metalnessMap || any.roughnessMap || any.alphaMap) texturedMaterials++;
    }
    return i;
  };

  // ---------------------------------------------------------------- géométries

  const built = new Map<string, BuiltGeometry>();
  const buildGeometry = (geometry: BufferGeometry, label: string): BuiltGeometry => {
    const known = built.get(geometry.uuid);
    if (known) return known;
    let result: BuiltGeometry = { index: null, slotCount: 1, smooth: false };
    const pos = geometry.getAttribute('position');
    if (pos && pos.count >= 3) {
      const count = pos.count;
      const positions = new Float64Array(count * 3);
      for (let i = 0; i < count; i++) {
        positions[i * 3] = pos.getX(i);
        positions[i * 3 + 1] = pos.getY(i);
        positions[i * 3 + 2] = pos.getZ(i);
      }
      const index = geometry.getIndex();
      const total = index ? index.count : count;
      const vertexAt = index ? (i: number) => index.getX(i) : (i: number) => i;
      const drawStart = Math.max(0, geometry.drawRange.start | 0);
      const drawCount = geometry.drawRange.count;
      const drawEnd = Math.min(total, Number.isFinite(drawCount) ? drawStart + drawCount : total);
      const ranges =
        geometry.groups.length > 0
          ? geometry.groups.map((g) => ({ start: g.start, end: g.start + g.count, slot: Math.max(0, (g.materialIndex ?? 0) | 0) }))
          : [{ start: 0, end: total, slot: 0 }];
      const polygons: number[][] = [];
      const slots: number[] = [];
      let slotCount = 1;
      for (const r of ranges) {
        const start = Math.max(r.start, drawStart);
        const end = Math.min(Number.isFinite(r.end) ? r.end : total, drawEnd);
        for (let i = start; i + 2 < end; i += 3) {
          const a = vertexAt(i);
          const b = vertexAt(i + 1);
          const c = vertexAt(i + 2);
          if (!(a >= 0 && a < count && b >= 0 && b < count && c >= 0 && c < count)) {
            invalidTriangles++;
            continue;
          }
          if (isDegenerateTriangle(positions, a, b, c)) continue;
          polygons.push([a, b, c]);
          slots.push(r.slot);
          if (r.slot + 1 > slotCount) slotCount = r.slot + 1;
        }
      }
      if (polygons.length > 0) {
        let smooth = false;
        const normal = geometry.getAttribute('normal');
        if (normal && normal.count === count) {
          const normals = new Float64Array(count * 3);
          for (let i = 0; i < count; i++) {
            normals[i * 3] = normal.getX(i);
            normals[i * 3 + 1] = normal.getY(i);
            normals[i * 3 + 2] = normal.getZ(i);
          }
          smooth = hasSmoothNormals(positions, normals, polygons);
        }
        const multi = slots.some((s) => s !== slots[0]);
        meshes.push({ name: geometry.name || label, positions, polygons, polygonSlots: multi ? slots : undefined, weld: true });
        result = { index: meshes.length - 1, slotCount, smooth };
      }
      if (geometry.morphAttributes && Object.keys(geometry.morphAttributes).length > 0) morphs = true;
    }
    built.set(geometry.uuid, result);
    return result;
  };

  const slotMaterials = (mesh: Mesh, slotCount: number): (number | null)[] | undefined => {
    if (!withMaterials) return undefined;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const out: (number | null)[] = [];
    for (let s = 0; s < slotCount; s++) out.push(materialOf(list[s] ?? list[0]));
    return out;
  };

  // ---------------------------------------------------------------- objets

  const worldOf = (o: Object3D, fix?: Matrix4): Matrix4 => {
    const m = new Matrix4().multiplyMatrices(rootTransform, o.matrixWorld);
    if (fix) m.multiply(fix);
    if (!sanitizeMatrix(m)) brokenMatrices++;
    return m;
  };

  const lightData = (o: Object3D): Partial<Omit<LightData, 'id'>> | null => {
    const any = o as any;
    const kind: LightKind | null = any.isPointLight ? 'point' : any.isSpotLight ? 'spot' : any.isDirectionalLight ? 'sun' : any.isRectAreaLight ? 'area' : null;
    if (!kind) return null;
    // Une couleur dont une composante dépasse 1 porte une partie de l'intensité (Collada).
    const color = colorHex(any.color, '#ffffff', rawLinear);
    const intensity = finiteOr(any.intensity, 1, 0) * color.scale;
    const sizeX = finiteOr(any.width, 1, 1e-3);
    const sizeY = finiteOr(any.height, 1, 1e-3);
    const data: Partial<Omit<LightData, 'id'>> = { kind, color: color.hex, power: Math.max(0, finiteOr(lightPower(intensity, kind, sizeX * sizeY), 0)) };
    if (kind === 'spot') {
      // SpotLight.angle est le demi-angle du cône, en radians (sauf `spotFullAngle`).
      const full = finiteOr(any.angle, Math.PI / 4, 0) * (options.spotFullAngle ? 1 : 2);
      data.spotAngle = Math.min(180, Math.max(1, (full * 180) / Math.PI));
      data.spotBlend = finiteOr(any.penumbra, 0, 0, 1);
    }
    if (kind === 'area') {
      data.sizeX = sizeX * lengthScale;
      data.sizeY = sizeY * lengthScale;
    }
    return data;
  };

  const cameraData = (o: Object3D): Partial<Omit<CameraData, 'id'>> | null => {
    const any = o as any;
    if (!any.isPerspectiveCamera && !any.isOrthographicCamera) return null;
    let near = finiteOr(any.near, 0.1, 0);
    let far = finiteOr(any.far, 1000, 0);
    if (options.cameraRange) [near, far] = options.cameraRange(near, far);
    near = Math.max(1e-6, finiteOr(near, 0.1));
    far = Math.max(near + 1e-6, finiteOr(far, 1000));
    if (any.isOrthographicCamera) {
      const height = Math.abs(finiteOr(any.top, 1) - finiteOr(any.bottom, -1)) / finiteOr(any.zoom, 1, 1e-6);
      return { kind: 'ortho', orthoScale: Math.max(1e-6, height * lengthScale), near, far };
    }
    // PerspectiveCamera.fov : champ vertical en degrés.
    return { kind: 'persp', fov: finiteOr(any.fov, 40, 1, 179), near, far };
  };

  const visit = (o: Object3D, parent: number | null, emit: boolean): void => {
    if (targets.has(o)) return;
    const any = o as any;
    if (any.isBone && !useful(o)) {
      prunedBones++;
      return;
    }
    let self = parent;
    if (emit) {
      const label = (typeof o.name === 'string' && o.name.trim()) || '';
      const light = any.isLight ? lightData(o) : null;
      const camera = any.isCamera ? cameraData(o) : null;
      if (any.isLight && !light) {
        // Lumière d'ambiance ou d'hémisphère : pas d'équivalent comme objet (réglage du monde).
        ambient++;
        for (const c of o.children) visit(c, parent, true);
        return;
      }
      if (any.isMesh && any.geometry) {
        const mesh = o as Mesh;
        const name = label || 'Objet';
        const geo = buildGeometry(mesh.geometry, name);
        if (any.isSkinnedMesh) skinned++;
        if (geo.index === null) {
          objects.push({ name, type: 'empty', parent, matrixWorld: worldOf(o), collection: null });
          self = objects.length - 1;
        } else if (any.isInstancedMesh && typeof any.getMatrixAt === 'function') {
          objects.push({ name, type: 'empty', parent, matrixWorld: worldOf(o), collection: null });
          self = objects.length - 1;
          const inst = new Matrix4();
          const mats = slotMaterials(mesh, geo.slotCount);
          for (let i = 0; i < (any.count | 0); i++) {
            any.getMatrixAt(i, inst);
            const m = new Matrix4().multiplyMatrices(rootTransform, o.matrixWorld).multiply(inst);
            if (!sanitizeMatrix(m)) brokenMatrices++;
            objects.push({
              name: `${name}.${String(i + 1).padStart(3, '0')}`,
              type: 'mesh',
              parent: self,
              matrixWorld: m,
              collection: null,
              mesh: geo.index,
              materials: mats,
              shadeSmooth: geo.smooth,
            });
          }
        } else {
          objects.push({
            name,
            type: 'mesh',
            parent,
            matrixWorld: worldOf(o),
            collection: null,
            visible: o.visible !== false,
            mesh: geo.index,
            materials: slotMaterials(mesh, geo.slotCount),
            shadeSmooth: geo.smooth,
          });
          self = objects.length - 1;
        }
      } else if (light) {
        objects.push({ name: label || 'Lumière', type: 'light', parent, matrixWorld: worldOf(o, options.lightFix?.(o)), collection: null, light });
        self = objects.length - 1;
      } else if (camera) {
        objects.push({ name: label || 'Caméra', type: 'camera', parent, matrixWorld: worldOf(o, options.cameraFix?.(o)), collection: null, camera });
        self = objects.length - 1;
        if (activeCamera === null) activeCamera = self;
      } else {
        if (any.isLine || any.isPoints || any.isSprite) curves++;
        objects.push({ name: label || 'Vide', type: 'empty', parent, matrixWorld: worldOf(o), collection: null, visible: o.visible !== false });
        self = objects.length - 1;
      }
    }
    for (const c of o.children) visit(c, self, true);
  };
  visit(root, null, options.includeRoot === true);

  // ---------------------------------------------------------------- avertissements regroupés

  if (texturedMaterials > 0) {
    warnings.push(
      `${plural(texturedMaterials, 'matériau texturé', 'matériaux texturés')} : CoForge n'affiche pas les textures image, la couleur de base du matériau est conservée.`,
    );
  }
  const notKept: string[] = [];
  const animations = Array.isArray((root as any).animations) ? (root as any).animations.length : 0;
  if (animations > 0) notKept.push(plural(animations, 'animation', 'animations'));
  if (skinned > 0) notKept.push(`déformation par armature (${plural(skinned, 'maillage importé', 'maillages importés')} en pose de repos)`);
  if (morphs) notKept.push('cibles de morphing');
  if (notKept.length > 0) warnings.push(`Non repris : ${notKept.join(', ')}.`);
  if (prunedBones > 0) warnings.push(`${plural(prunedBones, "branche d'os sans géométrie ignorée", "branches d'os sans géométrie ignorées")}.`);
  if (curves > 0) warnings.push(`${plural(curves, 'ligne ou nuage de points importé comme vide', 'lignes ou nuages de points importés comme vides')}.`);
  if (ambient > 0) warnings.push(`${plural(ambient, "lumière d'ambiance non reprise", "lumières d'ambiance non reprises")} (réglage du monde dans CoForge).`);
  if (invalidTriangles > 0) warnings.push(`${plural(invalidTriangles, 'triangle à indice invalide ignoré', 'triangles à indices invalides ignorés')}.`);
  if (brokenMatrices > 0) warnings.push(`${plural(brokenMatrices, 'transformation non finie remplacée', 'transformations non finies remplacées')} par l'identité.`);

  return { name: options.name, objects, meshes, materials, collections: [], activeCamera, warnings };
}
