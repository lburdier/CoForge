import { socketsCompatible, type NodeTypeDef, type SocketType } from '../../core/nodes/types';
import type { Rect } from './layout';

/**
 * Logique PURE de l'éditeur de nœuds (sans DOM ni React) : transformations vue / écran, cadrage,
 * menu Ajouter (catégories dans l'ordre de Blender, recherche en français et en anglais),
 * sélection rectangle. Testée par tests/nodes.editor.test.ts.
 */

// ------------------------------------------------------------------ vue

/** Vue de l'éditeur : décalage (px écran) et facteur de zoom. Écran = arbre × z + (x, y). */
export interface View {
  x: number;
  y: number;
  z: number;
}

export const ZOOM_MIN = 0.15;
export const ZOOM_MAX = 3;

/** Point écran (relatif au coin du canevas) → coordonnées de l'arbre. */
export function screenToTree(v: View, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - v.x) / v.z, y: (sy - v.y) / v.z };
}

/** Coordonnées de l'arbre → point écran (relatif au coin du canevas). */
export function treeToScreen(v: View, tx: number, ty: number): { x: number; y: number } {
  return { x: tx * v.z + v.x, y: ty * v.z + v.y };
}

/** Zoom à la molette centré sur le curseur : le point de l'arbre sous (mx, my) ne bouge pas. */
export function zoomAt(v: View, mx: number, my: number, deltaY: number): View {
  const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v.z * Math.pow(1.0015, -deltaY)));
  return { z, x: mx - ((mx - v.x) / v.z) * z, y: my - ((my - v.y) / v.z) * z };
}

/** Vue qui cadre des rectangles dans une zone de W × H px (marge de 30 px), ou null s'il n'y en a pas. */
export function frameView(rects: Rect[], W: number, H: number, maxZoom = 1.2): View | null {
  if (rects.length === 0 || W <= 0 || H <= 0) return null;
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  const z = Math.max(0.2, Math.min(maxZoom, Math.min((W - 60) / Math.max(1, x1 - x0), (H - 60) / Math.max(1, y1 - y0))));
  return { z, x: W / 2 - ((x0 + x1) / 2) * z, y: H / 2 - ((y0 + y1) / 2) * z };
}

// ------------------------------------------------------------------ sélection rectangle

export type BoxMode = 'set' | 'add' | 'sub';

/**
 * Nœuds touchés par un rectangle (coordonnées de l'arbre, coins dans n'importe quel ordre). Un
 * cadre n'est pris que s'il est ENTIÈREMENT dans le rectangle (sinon on ne pourrait jamais
 * sélectionner ses enfants au rectangle sans lui).
 */
export function boxHits(rects: ReadonlyMap<string, Rect>, isFrame: (id: string) => boolean, ax: number, ay: number, bx: number, by: number): string[] {
  const x0 = Math.min(ax, bx);
  const x1 = Math.max(ax, bx);
  const y0 = Math.min(ay, by);
  const y1 = Math.max(ay, by);
  const out: string[] = [];
  for (const [id, r] of rects) {
    if (isFrame(id)) {
      if (r.x >= x0 && r.x + r.w <= x1 && r.y >= y0 && r.y + r.h <= y1) out.push(id);
    } else if (r.x < x1 && r.x + r.w > x0 && r.y < y1 && r.y + r.h > y0) out.push(id);
  }
  return out;
}

/** Applique une sélection rectangle : nouvelle sélection et nœud actif. */
export function applyBox(prev: ReadonlySet<string>, active: string | null, hits: string[], mode: BoxMode): { sel: Set<string>; active: string | null } {
  const sel = mode === 'set' ? new Set<string>() : new Set(prev);
  for (const id of hits) {
    if (mode === 'sub') sel.delete(id);
    else sel.add(id);
  }
  if (mode === 'sub') return { sel, active: active && sel.has(active) ? active : null };
  return { sel, active: hits.length ? hits[hits.length - 1] : active && sel.has(active) ? active : null };
}

// ------------------------------------------------------------------ menu Ajouter

/**
 * Ordre des catégories du menu Ajouter de l'éditeur de shaders de Blender (4.x / 5.x) :
 * Entrée, Sortie | Shader, Déplacement, Couleur, Texture, Vecteur, Convertisseur | Script |
 * Groupe, Disposition. Chaque entrée accepte les libellés français et anglais.
 */
export const BLENDER_CATEGORY_ORDER: { id: string; aliases: string[] }[] = [
  { id: 'Entrée', aliases: ['input', 'entree'] },
  { id: 'Sortie', aliases: ['output'] },
  { id: 'Shader', aliases: ['shaders'] },
  { id: 'Déplacement', aliases: ['displacement', 'deplacement'] },
  { id: 'Couleur', aliases: ['color', 'colour'] },
  { id: 'Texture', aliases: ['textures'] },
  { id: 'Vecteur', aliases: ['vector'] },
  { id: 'Convertisseur', aliases: ['converter', 'utilitaires', 'utilities'] },
  { id: 'Script', aliases: ['script'] },
  { id: 'Groupe', aliases: ['group'] },
  { id: 'Disposition', aliases: ['layout'] },
];

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

/** Rang d'une catégorie dans l'ordre de Blender (catégories inconnues : avant Groupe / Disposition). */
export function categoryRank(category: string): number {
  const n = norm(category);
  const i = BLENDER_CATEGORY_ORDER.findIndex((c) => norm(c.id) === n || c.aliases.includes(n));
  return i >= 0 ? i : BLENDER_CATEGORY_ORDER.findIndex((c) => c.id === 'Groupe') - 0.5;
}

/** Catégories présentes dans une liste de types, dans l'ordre du menu de Blender. */
export function orderedCategories(defs: readonly NodeTypeDef[]): string[] {
  const seen: string[] = [];
  for (const d of defs) if (!seen.includes(d.category)) seen.push(d.category);
  return seen.map((c, i) => ({ c, r: categoryRank(c), i })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.c);
}

/** Noms anglais de Blender qui ne se déduisent pas de l'identifiant. */
const ENGLISH_NAMES: Record<string, string> = {
  ShaderNodeOutputMaterial: 'Material Output',
  ShaderNodeOutputWorld: 'World Output',
  ShaderNodeOutputLight: 'Light Output',
  ShaderNodeOutputAOV: 'AOV Output',
  ShaderNodeBsdfPrincipled: 'Principled BSDF',
  ShaderNodeBsdfDiffuse: 'Diffuse BSDF',
  ShaderNodeBsdfGlossy: 'Glossy BSDF',
  ShaderNodeBsdfGlass: 'Glass BSDF',
  ShaderNodeBsdfRefraction: 'Refraction BSDF',
  ShaderNodeBsdfTranslucent: 'Translucent BSDF',
  ShaderNodeBsdfTransparent: 'Transparent BSDF',
  ShaderNodeBsdfSheen: 'Sheen BSDF',
  ShaderNodeBsdfToon: 'Toon BSDF',
  ShaderNodeBsdfHair: 'Hair BSDF',
  ShaderNodeBsdfHairPrincipled: 'Principled Hair BSDF',
  ShaderNodeBsdfMetallic: 'Metallic BSDF',
  ShaderNodeBsdfRayPortal: 'Ray Portal BSDF',
  ShaderNodeSubsurfaceScattering: 'Subsurface Scattering',
  ShaderNodeEeveeSpecular: 'Specular BSDF',
  ShaderNodeHoldout: 'Holdout',
  ShaderNodeVolumePrincipled: 'Principled Volume',
  ShaderNodeVolumeAbsorption: 'Volume Absorption',
  ShaderNodeVolumeScatter: 'Volume Scatter',
  ShaderNodeRGB: 'RGB',
  ShaderNodeValue: 'Value',
  ShaderNodeTexCoord: 'Texture Coordinate',
  ShaderNodeNewGeometry: 'Geometry',
  ShaderNodeObjectInfo: 'Object Info',
  ShaderNodeLayerWeight: 'Layer Weight',
  ShaderNodeAmbientOcclusion: 'Ambient Occlusion',
  ShaderNodeVertexColor: 'Color Attribute',
  ShaderNodeUVMap: 'UV Map',
  ShaderNodeLightPath: 'Light Path',
  ShaderNodeCameraData: 'Camera Data',
  ShaderNodeTexImage: 'Image Texture',
  ShaderNodeTexEnvironment: 'Environment Texture',
  ShaderNodeTexSky: 'Sky Texture',
  ShaderNodeTexNoise: 'Noise Texture',
  ShaderNodeTexVoronoi: 'Voronoi Texture',
  ShaderNodeTexChecker: 'Checker Texture',
  ShaderNodeTexGradient: 'Gradient Texture',
  ShaderNodeTexWave: 'Wave Texture',
  ShaderNodeTexMagic: 'Magic Texture',
  ShaderNodeTexBrick: 'Brick Texture',
  ShaderNodeTexMusgrave: 'Musgrave Texture',
  ShaderNodeTexGabor: 'Gabor Texture',
  ShaderNodeTexWhiteNoise: 'White Noise Texture',
  ShaderNodeTexIES: 'IES Texture',
  ShaderNodeTexPointDensity: 'Point Density',
  ShaderNodeMix: 'Mix',
  ShaderNodeMixRGB: 'Mix (Legacy)',
  ShaderNodeInvert: 'Invert Color',
  ShaderNodeHueSaturation: 'Hue/Saturation/Value',
  ShaderNodeBrightContrast: 'Brightness/Contrast',
  ShaderNodeGamma: 'Gamma',
  ShaderNodeRGBCurve: 'RGB Curves',
  ShaderNodeLightFalloff: 'Light Falloff',
  ShaderNodeValToRGB: 'Color Ramp',
  ShaderNodeRGBToBW: 'RGB to BW',
  ShaderNodeMapRange: 'Map Range',
  ShaderNodeSeparateColor: 'Separate Color',
  ShaderNodeCombineColor: 'Combine Color',
  ShaderNodeSeparateXYZ: 'Separate XYZ',
  ShaderNodeCombineXYZ: 'Combine XYZ',
  ShaderNodeShaderToRGB: 'Shader to RGB',
  ShaderNodeWavelength: 'Wavelength',
  ShaderNodeBlackbody: 'Blackbody',
  ShaderNodeFloatCurve: 'Float Curve',
  ShaderNodeVectorMath: 'Vector Math',
  ShaderNodeVectorRotate: 'Vector Rotate',
  ShaderNodeVectorTransform: 'Vector Transform',
  ShaderNodeVectorCurve: 'Vector Curves',
  ShaderNodeNormalMap: 'Normal Map',
  ShaderNodeDisplacement: 'Displacement',
  ShaderNodeVectorDisplacement: 'Vector Displacement',
  ShaderNodeAddShader: 'Add Shader',
  ShaderNodeMixShader: 'Mix Shader',
  NodeFrame: 'Frame',
  NodeReroute: 'Reroute',
};

/** Nom anglais de Blender d'un type de nœud (table ci-dessus, sinon déduit de l'identifiant). */
export function englishName(def: Pick<NodeTypeDef, 'id'>): string {
  const known = ENGLISH_NAMES[def.id];
  if (known) return known;
  const bare = def.id.replace(/^(ShaderNode|GeometryNode|FunctionNode|CompositorNode|Node)/, '');
  let words = bare.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  if (/^Tex /.test(words)) words = `${words.slice(4)} Texture`;
  if (/^Bsdf /.test(words)) words = `${words.slice(5)} BSDF`;
  return words;
}

/** Texte de recherche d'un type : libellé français, identifiant, nom anglais, catégorie. */
export function searchText(def: NodeTypeDef): string {
  return norm(`${def.label} ${def.id} ${englishName(def)} ${def.category}`);
}

/**
 * Recherche du menu Ajouter : tous les mots de la requête doivent apparaître (sans accents ni
 * casse) dans le libellé français, l'identifiant ou le nom anglais. Classement : libellé qui
 * commence par la requête, puis nom anglais qui commence par la requête, puis le reste ; à rang
 * égal, ordre des catégories de Blender puis ordre du catalogue.
 */
export function searchNodeTypes(defs: readonly NodeTypeDef[], query: string): NodeTypeDef[] {
  const q = norm(query);
  if (!q) return [];
  const words = q.split(/\s+/).filter(Boolean);
  const scored: { d: NodeTypeDef; s: number; i: number }[] = [];
  defs.forEach((d, i) => {
    const text = searchText(d);
    if (!words.every((w) => text.includes(w))) return;
    const fr = norm(d.label);
    const en = norm(englishName(d));
    const s = fr === q || en === q ? 0 : fr.startsWith(q) ? 1 : en.startsWith(q) ? 2 : fr.includes(q) || en.includes(q) ? 3 : 4;
    scored.push({ d, s, i });
  });
  return scored.sort((a, b) => a.s - b.s || categoryRank(a.d.category) - categoryRank(b.d.category) || a.i - b.i).map((x) => x.d);
}

// ------------------------------------------------------------------ support du rendu

/**
 * Indication facultative du catalogue sur le rendu d'un nœud (champs `support` / `note` que la
 * zone « noeuds-moteur » peut ajouter aux définitions) : null si le nœud est rendu fidèlement.
 */
export function supportNote(def: NodeTypeDef | null): { level: 'approx' | 'none'; text: string } | null {
  if (!def) return null;
  const extra = def as NodeTypeDef & { support?: unknown; note?: unknown };
  const note = typeof extra.note === 'string' ? extra.note.trim() : '';
  const s = typeof extra.support === 'string' ? extra.support.toLowerCase() : '';
  if (s === 'full') return null;
  const none = ['none', 'unsupported', 'non', 'aucun', 'ignored', 'cycles'].includes(s);
  const approx = ['approx', 'approximate', 'approché', 'approche', 'partial', 'partiel', 'eevee'].includes(s);
  if (!none && !approx && !note) return null;
  const level = none ? 'none' : 'approx';
  const text = note || (none ? 'Nœud non rendu en temps réel dans CoForge.' : 'Rendu approché dans CoForge.');
  return { level, text };
}

/**
 * Types proposés par le menu Ajouter. Avec un lien en attente (lâché dans le vide), seuls les
 * types qui peuvent s'y brancher (entrée compatible pour une sortie, et inversement), et jamais
 * la Sortie du matériau.
 */
export function addMenuTypes(defs: readonly NodeTypeDef[], link: { fromOutput: boolean; type: SocketType } | null): NodeTypeDef[] {
  if (!link) return [...defs];
  return defs.filter((d) => {
    if (d.id.startsWith('ShaderNodeOutput') || d.layout === 'frame') return false;
    const list = link.fromOutput ? d.inputs : d.outputs;
    return list.some((s) => (link.fromOutput ? socketsCompatible(link.type, s.type) : socketsCompatible(s.type, link.type)));
  });
}

// ------------------------------------------------------------------ courbes (Courbes RVB…)

export interface CurvePt {
  x: number;
  y: number;
  handle?: 'AUTO' | 'VECTOR';
}

/** Points valides d'une courbe lue dans le document (triés par x ; au moins deux). */
export function curvePoints(raw: unknown, lo = 0, hi = 1): CurvePt[] {
  const pts = Array.isArray(raw)
    ? raw
        .filter((p): p is CurvePt => !!p && typeof p === 'object' && Number.isFinite((p as CurvePt).x) && Number.isFinite((p as CurvePt).y))
        .map((p) => ({ ...p }))
    : [];
  pts.sort((a, b) => a.x - b.x);
  return pts.length >= 2 ? pts : [{ x: lo, y: lo }, { x: hi, y: hi }];
}

/** Ajoute un point (x, y) borné à [lo, hi] ; renvoie la courbe et l'indice du point ajouté. */
export function curveAdd(pts: CurvePt[], x: number, y: number, lo = 0, hi = 1): { pts: CurvePt[]; index: number } {
  const c = (v: number) => Math.max(lo, Math.min(hi, v));
  const p = { x: c(x), y: c(y) };
  const next = [...pts.map((q) => ({ ...q })), p].sort((a, b) => a.x - b.x);
  return { pts: next, index: next.indexOf(p) };
}

/**
 * Déplace le point `i` : borné à [lo, hi] et entre ses voisins (l'ordre des points ne change
 * jamais pendant un glissé, comme dans Blender).
 */
export function curveMove(pts: CurvePt[], i: number, x: number, y: number, lo = 0, hi = 1): CurvePt[] {
  if (i < 0 || i >= pts.length) return pts;
  const eps = 1e-4;
  const minX = i > 0 ? pts[i - 1].x + eps : lo;
  const maxX = i < pts.length - 1 ? pts[i + 1].x - eps : hi;
  return pts.map((p, k) => (k === i ? { ...p, x: Math.max(minX, Math.min(maxX, x)), y: Math.max(lo, Math.min(hi, y)) } : p));
}

/** Retire le point `i` (une courbe garde toujours au moins deux points). */
export function curveRemove(pts: CurvePt[], i: number): CurvePt[] {
  if (pts.length <= 2 || i < 0 || i >= pts.length) return pts;
  return pts.filter((_, k) => k !== i);
}
