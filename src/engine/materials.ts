import { Color, DoubleSide, MeshPhysicalMaterial, ShaderMaterial } from 'three';
import type { SceneDoc } from '../core/doc/SceneDoc';
import { MATERIAL_DEFAULTS, type MaterialData } from '../core/doc/schema';
import { clearShaderCache, compileShaderTree, defaultShaderTree } from '../core/nodes/shaderCompile';
import type { NodeTreeData } from '../core/doc/schema';
import { applyCompiledShader, clearNodeShader } from './nodeMaterial';
import { nodeImageTexture, onNodeImagesReady } from './nodeImages';
import { clamp, finite, parseColor } from './util';

/**
 * Applique un MaterialData (« Principled » simplifié) à un MeshPhysicalMaterial.
 * `xray` rend la surface semi-transparente (aperçu matériau en mode rayons X).
 */
export function applyMaterialData(mat: MeshPhysicalMaterial, data: Omit<MaterialData, 'id' | 'name'>, xray = false): void {
  parseColor(data.baseColor, mat.color, MATERIAL_DEFAULTS.baseColor);
  mat.metalness = clamp(finite(data.metallic, 0), 0, 1);
  mat.roughness = clamp(finite(data.roughness, 0.5), 0, 1);
  parseColor(data.emission, mat.emissive, '#000000');
  mat.emissiveIntensity = Math.max(0, finite(data.emissionStrength, 0));
  const alpha = clamp(finite(data.alpha, 1), 0, 1);
  mat.opacity = xray ? alpha * 0.35 : alpha;
  const transparent = mat.opacity < 1;
  const transmission = clamp(finite(data.transmission, 0), 0, 1);
  // La transmission temps réel de three exige une passe supplémentaire : inutile en rayons X.
  const effTransmission = xray ? 0 : transmission;
  const needsUpdate = mat.transparent !== transparent || mat.transmission > 0 !== effTransmission > 0;
  mat.transparent = transparent;
  mat.depthWrite = !transparent;
  mat.transmission = effTransmission;
  mat.ior = clamp(finite(data.ior, 1.45), 1, 2.333);
  mat.thickness = effTransmission > 0 ? 0.5 : 0;
  if (needsUpdate) mat.needsUpdate = true;
}

/**
 * Matériau du document → MeshPhysicalMaterial : par son arbre de nœuds s'il en a un (Principled
 * complet, textures procédurales), sinon par ses champs simples.
 */
export function applyDocMaterial(mat: MeshPhysicalMaterial, doc: SceneDoc, data: MaterialData, xray = false, onShaderReady?: () => void): void {
  const tree = data.nodeTree && data.useNodes !== false ? doc.getNodeTree(data.nodeTree) : null;
  if (tree && tree.kind === 'shader') {
    try {
      applyCompiledShader(mat, compileShaderTree(tree), xray, (img) => nodeImageTexture(doc, img), onShaderReady);
      return;
    } catch (err) {
      console.warn('[nœuds] compilation du matériau impossible, champs simples utilisés', err);
    }
  }
  clearNodeShader(mat);
  applyMaterialData(mat, data, xray);
}

/**
 * Arbre de nœuds initial d'un matériau (« Utiliser les nœuds ») : Principled BSDF → Sortie du
 * matériau, initialisés d'après les champs simples du matériau. À écrire avec `doc.addNodeTree`.
 */
export function createDefaultShaderTree(material?: Partial<MaterialData>): Pick<NodeTreeData, 'nodes' | 'links'> {
  return defaultShaderTree(material);
}

export function createPhysicalMaterial(): MeshPhysicalMaterial {
  const m = new MeshPhysicalMaterial({ side: DoubleSide });
  // Recule légèrement les surfaces pour que les arêtes et la cage d'édition dessinées par-dessus ne scintillent pas.
  m.polygonOffset = true;
  m.polygonOffsetFactor = 1;
  m.polygonOffsetUnits = 1;
  return m;
}

/**
 * Bibliothèque de matériaux three.js : un MeshPhysicalMaterial par identifiant
 * de matériau du document, partagé entre tous les objets et mis à jour en place.
 */
export class MaterialLibrary {
  private map = new Map<string, MeshPhysicalMaterial>();
  private xray = false;
  /** Matériau des objets sans matériau : gris neutre. */
  readonly fallback: MeshPhysicalMaterial;
  /** Appelé quand un matériau change hors événement du document (image décodée) : redessiner. */
  onAsyncChange: (() => void) | null = null;
  private lastDoc: SceneDoc | null = null;
  /** Programme d'un matériau à nœuds compilé en tâche de fond et devenu actif : redessiner. */
  private readonly shaderReady = () => this.onAsyncChange?.();
  private stopImages: () => void;

  constructor() {
    this.fallback = createPhysicalMaterial();
    this.fallback.name = 'defaut';
    applyMaterialData(this.fallback, MATERIAL_DEFAULTS);
    // Image décodée : sa couleur moyenne change le repli (path tracing) et sa texture remplace le gris d'attente.
    this.stopImages = onNodeImagesReady(() => {
      const doc = this.lastDoc;
      if (!doc || this.map.size === 0) return;
      clearShaderCache();
      for (const id of [...this.map.keys()]) if (doc.getMaterial(id)?.nodeTree) this.update(doc, id);
      this.onAsyncChange?.();
    });
  }

  get(doc: SceneDoc | null, id: string | null): MeshPhysicalMaterial {
    if (!id || !doc) return this.fallback;
    this.lastDoc = doc;
    const cached = this.map.get(id);
    if (cached) return cached;
    const data = doc.getMaterial(id);
    if (!data) return this.fallback;
    const mat = createPhysicalMaterial();
    mat.name = data.name;
    applyDocMaterial(mat, doc, data, this.xray, this.shaderReady);
    this.map.set(id, mat);
    return mat;
  }

  /** Relit un matériau du document (ou le supprime s'il n'existe plus). */
  update(doc: SceneDoc, id: string): void {
    const mat = this.map.get(id);
    if (!mat) return;
    const data = doc.getMaterial(id);
    if (!data) {
      this.map.delete(id);
      mat.dispose();
      return;
    }
    mat.name = data.name;
    applyDocMaterial(mat, doc, data, this.xray, this.shaderReady);
  }

  /** Relit les matériaux qui utilisent ces arbres de nœuds. */
  updateTrees(doc: SceneDoc, treeIds: Iterable<string>): boolean {
    const set = new Set(treeIds);
    let any = false;
    for (const id of [...this.map.keys()]) {
      const data = doc.getMaterial(id);
      if (!data || (data.nodeTree && set.has(data.nodeTree))) {
        this.update(doc, id);
        any = true;
      }
    }
    return any;
  }

  setXray(doc: SceneDoc | null, xray: boolean): void {
    if (this.xray === xray) return;
    this.xray = xray;
    applyMaterialData(this.fallback, MATERIAL_DEFAULTS, xray);
    if (!doc) return;
    for (const id of [...this.map.keys()]) this.update(doc, id);
  }

  clear(): void {
    for (const m of this.map.values()) m.dispose();
    this.map.clear();
  }

  dispose(): void {
    this.stopImages();
    this.clear();
    this.fallback.dispose();
  }
}

/**
 * Matériau du mode « Solide » : éclairage studio fixe attaché à la caméra
 * (trois sources + ambiance), indépendant des lumières de la scène, sans ombres.
 * Le résultat est écrit directement en sRGB (pas de tone mapping).
 */
export function createStudioMaterial(): ShaderMaterial {
  const mat = new ShaderMaterial({
    name: 'studio',
    uniforms: {
      uColor: { value: new Color(0.8, 0.8, 0.8) },
      uOpacity: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vViewPos;
      void main() {
        vNormal = normalMatrix * normal;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewPos = mv.xyz;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec3 vNormal;
      varying vec3 vViewPos;
      void main() {
        vec3 n = normalize(vNormal);
        // direction vers l'observateur (perspective : depuis le fragment ; ortho : axe Z)
        vec3 v = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(-vViewPos);
        if (dot(n, v) < 0.0) n = -n;
        vec3 key = normalize(vec3(0.45, 0.55, 0.7));
        vec3 fill = normalize(vec3(-0.7, 0.15, 0.5));
        vec3 rim = normalize(vec3(0.1, -0.8, 0.2));
        float d = 0.30
          + 0.62 * max(dot(n, key), 0.0)
          + 0.22 * max(dot(n, fill), 0.0)
          + 0.12 * max(dot(n, rim), 0.0);
        vec3 h = normalize(key + v);
        float spec = pow(max(dot(n, h), 0.0), 48.0) * 0.12;
        vec3 col = uColor * d + vec3(spec);
        gl_FragColor = vec4(min(col, vec3(1.0)), uOpacity);
      }
    `,
    side: DoubleSide,
  });
  // couleur d'interface déjà en sRGB : jamais de tone mapping
  mat.toneMapped = false;
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = 1;
  mat.polygonOffsetUnits = 1;
  return mat;
}
