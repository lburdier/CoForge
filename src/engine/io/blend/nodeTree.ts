import type { NodeData, NodeLink } from '../../../core/doc/schema';
import { registerShaderNodes, SHADER_NODE_ALIASES } from '../../../core/nodes/shaderNodes';
import { nodeDefaults, nodeType, type SocketDef } from '../../../core/nodes/types';
import { findOutput, readTree, socketValues, type SNode, type SSocket, type STree } from './nodes';
import { recAt, type Rec } from './reader';
import { linearToHex, type Ctx } from './util';

/**
 * Arbre de nœuds d'un matériau Blender → arbre de nœuds CoForge (mêmes identifiants de nœuds et
 * de sockets que Blender 4.x / 5.x). Les énumérations sont stockées en entiers dans le fichier
 * (`custom1`, `storage`) : les tables ci-dessous ont été RELEVÉES sur des fichiers écrits par
 * Blender 3.6, 4.3, 5.0 et 5.1 (scripts/blend-fixtures/make_nodes.py), pas supposées.
 *
 * Vague 3 : catalogue complet ; les énumérations des nouveaux nœuds ont été relevées de la même
 * façon sur Blender 4.3, 5.0 et 5.1 (tests/fixtures/blend-nodes/make_enums_v3.py).
 *
 * Non repris (signalé) : groupes de nœuds, images des nœuds Texture image / d'environnement (le
 * nœud et ses réglages sont repris, l'image est à rouvrir dans CoForge), nœuds propres au monde, aux
 * lumières ou aux scripts.
 */

registerShaderNodes();

export interface ConvertedTree {
  nodes: Record<string, NodeData>;
  links: NodeLink[];
}

// ------------------------------------------------------------------ tables relevées sur Blender

const MATH_OPS: Record<number, string> = {
  0: 'ADD', 1: 'SUBTRACT', 2: 'MULTIPLY', 3: 'DIVIDE', 4: 'SINE', 5: 'COSINE', 6: 'TANGENT', 7: 'ARCSINE', 8: 'ARCCOSINE', 9: 'ARCTANGENT',
  10: 'POWER', 11: 'LOGARITHM', 12: 'MINIMUM', 13: 'MAXIMUM', 14: 'ROUND', 15: 'LESS_THAN', 16: 'GREATER_THAN', 17: 'MODULO', 18: 'ABSOLUTE',
  19: 'ARCTAN2', 20: 'FLOOR', 21: 'CEIL', 22: 'FRACT', 23: 'SQRT', 24: 'INVERSE_SQRT', 25: 'SIGN', 26: 'EXPONENT', 27: 'RADIANS', 28: 'DEGREES',
  29: 'SINH', 30: 'COSH', 31: 'TANH', 32: 'TRUNC', 33: 'SNAP', 34: 'WRAP', 35: 'COMPARE', 36: 'MULTIPLY_ADD', 37: 'PINGPONG', 38: 'SMOOTH_MIN',
  39: 'SMOOTH_MAX', 40: 'FLOORED_MODULO',
};
const VMATH_OPS: Record<number, string> = {
  0: 'ADD', 1: 'SUBTRACT', 2: 'MULTIPLY', 3: 'DIVIDE', 4: 'CROSS_PRODUCT', 5: 'PROJECT', 6: 'REFLECT', 7: 'DOT_PRODUCT', 8: 'DISTANCE', 9: 'LENGTH',
  10: 'SCALE', 11: 'NORMALIZE', 12: 'SNAP', 13: 'FLOOR', 14: 'CEIL', 15: 'MODULO', 16: 'FRACTION', 17: 'ABSOLUTE', 18: 'MINIMUM', 19: 'MAXIMUM',
  20: 'WRAP', 21: 'SINE', 22: 'COSINE', 23: 'TANGENT', 24: 'REFRACT', 25: 'FACEFORWARD', 26: 'MULTIPLY_ADD', 27: 'POWER', 28: 'SIGN', 29: 'ROUND',
};
/** Modes de fusion (MA_RAMP_*), communs à « Mélanger » et à l'ancien « MixRGB ». */
const BLEND: Record<number, string> = {
  0: 'MIX', 1: 'ADD', 2: 'MULTIPLY', 3: 'SUBTRACT', 4: 'SCREEN', 5: 'DIVIDE', 6: 'DIFFERENCE', 7: 'DARKEN', 8: 'LIGHTEN', 9: 'OVERLAY',
  10: 'DODGE', 11: 'BURN', 12: 'HUE', 13: 'SATURATION', 14: 'VALUE', 15: 'COLOR', 16: 'SOFT_LIGHT', 17: 'LINEAR_LIGHT', 18: 'EXCLUSION',
};
const MIX_DATA: Record<number, string> = { 0: 'FLOAT', 1: 'VECTOR', 2: 'RGBA' };
const MAPPING: Record<number, string> = { 0: 'POINT', 1: 'TEXTURE', 2: 'VECTOR', 3: 'NORMAL' };
const MAP_RANGE: Record<number, string> = { 0: 'LINEAR', 1: 'STEPPED', 2: 'SMOOTHSTEP', 3: 'SMOOTHERSTEP' };
const GRADIENT: Record<number, string> = { 0: 'LINEAR', 1: 'QUADRATIC', 2: 'EASING', 3: 'DIAGONAL', 4: 'RADIAL', 5: 'QUADRATIC_SPHERE', 6: 'SPHERICAL' };
const WAVE_TYPE: Record<number, string> = { 0: 'BANDS', 1: 'RINGS' };
const BANDS: Record<number, string> = { 0: 'X', 1: 'Y', 2: 'Z', 3: 'DIAGONAL' };
const RINGS: Record<number, string> = { 0: 'X', 1: 'Y', 2: 'Z', 3: 'SPHERICAL' };
const PROFILE: Record<number, string> = { 0: 'SIN', 1: 'SAW', 2: 'TRI' };
const VOR_FEATURE: Record<number, string> = { 0: 'F1', 1: 'F2', 2: 'SMOOTH_F1', 3: 'DISTANCE_TO_EDGE', 4: 'F1' };
const VOR_DIST: Record<number, string> = { 0: 'EUCLIDEAN', 1: 'MANHATTAN', 2: 'CHEBYCHEV', 3: 'MINKOWSKI' };
const COLOR_MODE: Record<number, string> = { 0: 'RGB', 1: 'HSV', 2: 'HSL' };
const RAMP_INTERP: Record<number, string> = { 0: 'LINEAR', 1: 'EASE', 2: 'B_SPLINE', 3: 'CARDINAL', 4: 'CONSTANT' };
const OUTPUT_TARGET: Record<number, string> = { 0: 'ALL', 1: 'EEVEE', 2: 'CYCLES' };
const NOISE_TYPE: Record<number, string> = { 0: 'MULTIFRACTAL', 1: 'FBM', 2: 'HYBRID_MULTIFRACTAL', 3: 'RIDGED_MULTIFRACTAL', 4: 'HETERO_TERRAIN' };
const VOR_FEATURE_V3: Record<number, string> = { 0: 'F1', 1: 'F2', 2: 'SMOOTH_F1', 3: 'DISTANCE_TO_EDGE', 4: 'N_SPHERE_RADIUS' };
const IMG_PROJ: Record<number, string> = { 0: 'FLAT', 1: 'BOX', 2: 'SPHERE', 3: 'TUBE' };
const IMG_EXT: Record<number, string> = { 0: 'REPEAT', 1: 'EXTEND', 2: 'CLIP', 3: 'MIRROR' };
const IMG_INTERP: Record<number, string> = { 0: 'Linear', 1: 'Closest', 2: 'Cubic', 3: 'Smart' };
/** Ciel, numérotation de Blender 5 ; en 4.x, 2 = Nishita (repris comme diffusion multiple). */
const SKY_MODEL_5: Record<number, string> = { 0: 'PREETHAM', 1: 'HOSEK_WILKIE', 2: 'SINGLE_SCATTERING', 3: 'MULTIPLE_SCATTERING' };
const SKY_MODEL_4: Record<number, string> = { 0: 'PREETHAM', 1: 'HOSEK_WILKIE', 2: 'MULTIPLE_SCATTERING' };
const NORMAL_MAP_SPACE: Record<number, string> = { 0: 'TANGENT', 1: 'OBJECT', 2: 'WORLD', 3: 'BLENDER_OBJECT', 4: 'BLENDER_WORLD' };
const DISP_SPACE: Record<number, string> = { 1: 'OBJECT', 2: 'WORLD' };
const VDISP_SPACE: Record<number, string> = { 0: 'TANGENT', 1: 'OBJECT', 2: 'WORLD' };
const ROTATE_TYPE: Record<number, string> = { 0: 'AXIS_ANGLE', 1: 'X_AXIS', 2: 'Y_AXIS', 3: 'Z_AXIS', 4: 'EULER_XYZ' };
const VT_TYPE: Record<number, string> = { 0: 'VECTOR', 1: 'POINT', 2: 'NORMAL' };
const VT_SPACE: Record<number, string> = { 0: 'WORLD', 1: 'OBJECT', 2: 'CAMERA' };
const ATTR_TYPE: Record<number, string> = { 0: 'GEOMETRY', 1: 'OBJECT', 2: 'INSTANCER', 3: 'VIEW_LAYER' };
const HAIR_PARAM: Record<number, string> = { 0: 'COLOR', 1: 'MELANIN', 2: 'ABSORPTION' };
const SSS_FALLOFF: Record<number, string> = { 3: 'BURLEY', 4: 'RANDOM_WALK', 5: 'RANDOM_WALK_SKIN' };
const SCATTER_PHASE: Record<number, string> = { 0: 'HENYEY_GREENSTEIN', 1: 'FOURNIER_FORAND', 2: 'DRAINE', 3: 'RAYLEIGH', 4: 'MIE' };
/** CurveMapPoint.flag : poignée vectorielle (CUMA_HANDLE_VECTOR). */
const CUMA_HANDLE_VECTOR = 2;

/** Drapeaux de bNode (DNA_node_types.h), vérifiés sur fichiers. */
const NODE_HIDDEN = 1 << 3;
const NODE_MUTED = 1 << 9;

/** Anciens types → type CoForge, avec renommage des sockets (Blender 2.8 → 4.0) : table du catalogue. */
const ALIASES = SHADER_NODE_ALIASES;

/** Principled BSDF d'avant Blender 4.0 : anciens noms de sockets. */
const PRINCIPLED_LEGACY: Record<string, string> = {
  Subsurface: 'Subsurface Weight',
  Specular: 'Specular IOR Level',
  Sheen: 'Sheen Weight',
  Clearcoat: 'Coat Weight',
  'Clearcoat Roughness': 'Coat Roughness',
  'Clearcoat Normal': 'Coat Normal',
  Transmission: 'Transmission Weight',
  Emission: 'Emission Color',
};

const DROPPED_LEGACY = new Set(['Subsurface Color', 'Transmission Roughness']);

// ------------------------------------------------------------------ lecture

function socketValue(s: SSocket, def: SocketDef): unknown {
  const v = socketValues(s);
  if (!v) return undefined;
  switch (def.type) {
    case 'color':
      return linearToHex(v.length >= 3 ? v : [v[0], v[0], v[0]]);
    case 'vector':
      return [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
    case 'bool':
      return v[0] !== 0;
    default:
      return v[0];
  }
}

function enumOf(table: Record<number, string>, n: number, fallback: string): string {
  return table[n] ?? fallback;
}

/** Courbes d'un CurveMapping (Courbes RVB / vectorielles / flottante). */
function readCurves(storage: Rec | null, count: number): unknown {
  if (!storage || !storage.has('cm')) return undefined;
  const curves: { points: { x: number; y: number; handle?: 'VECTOR' }[] }[] = [];
  for (let i = 0; i < count; i++) {
    const cm = storage.sub('cm', i);
    const first = cm?.get('curve', 'CurveMapPoint') ?? null;
    const tot = Math.max(0, Math.min(256, cm?.num('totpoint') ?? 0));
    const points: { x: number; y: number; handle?: 'VECTOR' }[] = [];
    for (let k = 0; first && k < tot; k++) {
      const pt = k === 0 ? first : recAt(first.file, first.block, k, 'CurveMapPoint');
      if (!pt) break;
      const p: { x: number; y: number; handle?: 'VECTOR' } = { x: pt.num('x'), y: pt.num('y') };
      if (pt.num('flag') & CUMA_HANDLE_VECTOR) p.handle = 'VECTOR';
      points.push(p);
    }
    if (points.length < 2) return undefined;
    curves.push({ points });
  }
  return { curves };
}

function readRamp(storage: Rec | null): unknown {
  if (!storage) return undefined;
  const tot = Math.max(0, Math.min(32, storage.num('tot')));
  const elements: { position: number; color: string; alpha: number }[] = [];
  for (let i = 0; i < tot; i++) {
    const d = storage.sub('data', i);
    if (!d) break;
    elements.push({ position: d.num('pos'), color: linearToHex([d.num('r'), d.num('g'), d.num('b')]), alpha: d.num('a', 1) });
  }
  if (!elements.length) return undefined;
  return { interpolation: enumOf(RAMP_INTERP, storage.num('ipotype'), 'LINEAR'), elements };
}

/** Propriétés (énumérations, cases) d'un nœud, lues dans `custom1/2` ou `storage`. */
function readProps(n: SNode, type: string, props: Record<string, unknown>, blender5: boolean): void {
  const r = n.rec;
  const c1 = r.num('custom1');
  const c2 = r.num('custom2');
  const st = r.get('storage');
  switch (n.idname) {
    case 'ShaderNodeMath':
      props.operation = enumOf(MATH_OPS, c1, 'ADD');
      props.use_clamp = (c2 & 1) !== 0;
      break;
    case 'ShaderNodeVectorMath':
      props.operation = enumOf(VMATH_OPS, c1, 'ADD');
      break;
    case 'ShaderNodeMix':
      if (st) {
        const dt = st.num('data_type', 2);
        props.data_type = enumOf(MIX_DATA, dt, 'RGBA');
        props.blend_type = enumOf(BLEND, st.num('blend_type'), 'MIX');
        props.clamp_factor = st.num('clamp_factor', 1) !== 0;
        props.clamp_result = st.num('clamp_result') !== 0;
        if (st.has('factor_mode')) props.factor_mode = st.num('factor_mode') === 1 ? 'NON_UNIFORM' : 'UNIFORM';
      }
      break;
    case 'ShaderNodeMixRGB':
      props.blend_type = enumOf(BLEND, c1, 'MIX');
      props.clamp_result = (c2 & 2) !== 0;
      break;
    case 'ShaderNodeMapping':
      props.vector_type = enumOf(MAPPING, c1, 'POINT');
      break;
    case 'ShaderNodeMapRange':
      if (st) {
        props.interpolation_type = enumOf(MAP_RANGE, st.num('interpolation_type'), 'LINEAR');
        props.data_type = st.num('data_type', 10) === 48 ? 'FLOAT_VECTOR' : 'FLOAT';
        props.clamp = st.num('clamp', 1) !== 0;
      }
      break;
    case 'ShaderNodeClamp':
      props.clamp_type = c1 === 1 ? 'RANGE' : 'MINMAX';
      break;
    case 'ShaderNodeTexGradient':
      if (st) props.gradient_type = enumOf(GRADIENT, st.num('gradient_type'), 'LINEAR');
      break;
    case 'ShaderNodeTexWave':
      if (st) {
        props.wave_type = enumOf(WAVE_TYPE, st.num('wave_type'), 'BANDS');
        props.bands_direction = enumOf(BANDS, st.num('bands_direction'), 'X');
        props.rings_direction = enumOf(RINGS, st.num('rings_direction'), 'X');
        props.wave_profile = enumOf(PROFILE, st.num('wave_profile'), 'SIN');
      }
      break;
    case 'ShaderNodeTexVoronoi':
      if (st) {
        props.feature = enumOf(VOR_FEATURE_V3, st.num('feature'), 'F1');
        props.distance = enumOf(VOR_DIST, st.num('distance'), 'EUCLIDEAN');
        const d = st.num('dimensions', 3);
        props.voronoi_dimensions = d >= 1 && d <= 4 ? `${d}D` : '3D';
        if (st.has('normalize')) props.normalize = st.num('normalize') !== 0;
      }
      break;
    case 'ShaderNodeTexNoise':
      if (st) {
        const d = st.num('dimensions', 3);
        props.noise_dimensions = d >= 1 && d <= 4 ? `${d}D` : '3D';
        if (st.has('normalize')) props.normalize = st.num('normalize') !== 0;
        if (st.has('type')) props.noise_type = enumOf(NOISE_TYPE, st.num('type'), 'FBM');
      }
      break;
    case 'ShaderNodeTexMusgrave':
      // Blender ≤ 4.0 : même numérotation des types que le bruit de Blender 4.1.
      if (st) {
        props.noise_type = enumOf(NOISE_TYPE, st.num('musgrave_type', 1), 'FBM');
        const d = st.num('dimensions', 3);
        props.noise_dimensions = d >= 1 && d <= 4 ? `${d}D` : '3D';
      }
      break;
    case 'ShaderNodeTexBrick':
      if (st) {
        props.offset = st.num('offset', 0.5);
        props.offset_frequency = st.num('offset_freq', 2);
        props.squash = st.num('squash', 1);
        props.squash_frequency = st.num('squash_freq', 2);
      }
      break;
    case 'ShaderNodeTexGabor':
      if (st) props.gabor_type = st.num('type') === 1 ? '3D' : '2D';
      break;
    case 'ShaderNodeTexImage':
      if (st) {
        props.projection = enumOf(IMG_PROJ, st.num('projection'), 'FLAT');
        props.projection_blend = st.num('projection_blend');
        props.extension = enumOf(IMG_EXT, st.num('extension'), 'REPEAT');
        props.interpolation = enumOf(IMG_INTERP, st.num('interpolation'), 'Linear');
      }
      break;
    case 'ShaderNodeTexEnvironment':
      if (st) {
        props.projection = st.num('projection') === 1 ? 'MIRROR_BALL' : 'EQUIRECTANGULAR';
        props.interpolation = enumOf(IMG_INTERP, st.num('interpolation'), 'Linear');
      }
      break;
    case 'ShaderNodeTexSky':
      if (st) {
        props.sky_type = enumOf(blender5 ? SKY_MODEL_5 : SKY_MODEL_4, st.num('sky_model', 3), 'MULTIPLE_SCATTERING');
        props.sun_disc = st.num('sun_disc', 1) !== 0;
        props.sun_size = (st.num('sun_size', 0.009512) * 180) / Math.PI;
        props.sun_intensity = st.num('sun_intensity', 1);
        props.sun_elevation = (st.num('sun_elevation', 0.261799) * 180) / Math.PI;
        props.sun_rotation = (st.num('sun_rotation') * 180) / Math.PI;
        props.altitude = st.num('altitude');
        props.air_density = st.num('air_density', 1);
        props.aerosol_density = st.num('dust_density', 1);
        props.ozone_density = st.num('ozone_density', 1);
        props.turbidity = st.num('turbidity', 2.2);
        props.ground_albedo = st.num('ground_albedo', 0.3);
      }
      break;
    case 'ShaderNodeTexIES':
      if (st) props.mode = st.num('mode') === 1 ? 'EXTERNAL' : 'INTERNAL';
      break;
    case 'ShaderNodeTexPointDensity':
      if (st) {
        props.point_source = st.num('point_source') === 1 ? 'OBJECT' : 'PARTICLE_SYSTEM';
        props.space = st.num('space') === 1 ? 'WORLD' : 'OBJECT';
        props.radius = st.num('radius', 0.3);
        props.resolution = st.num('resolution', 100);
      }
      break;
    case 'ShaderNodeTangent':
      if (st) {
        props.direction_type = st.num('direction_type') === 1 ? 'UV_MAP' : 'RADIAL';
        props.axis = ['X', 'Y', 'Z'][st.num('axis', 2)] ?? 'Z';
      }
      break;
    case 'ShaderNodeAttribute':
      if (st) {
        props.attribute_type = enumOf(ATTR_TYPE, st.num('type'), 'GEOMETRY');
        props.attribute_name = st.str('name');
      }
      break;
    case 'ShaderNodeNormalMap':
      if (st) props.space = enumOf(NORMAL_MAP_SPACE, st.num('space'), 'TANGENT');
      break;
    case 'ShaderNodeDisplacement':
      props.space = enumOf(DISP_SPACE, c1, 'OBJECT');
      break;
    case 'ShaderNodeVectorDisplacement':
      props.space = enumOf(VDISP_SPACE, c1, 'TANGENT');
      break;
    case 'ShaderNodeVectorRotate':
      props.rotation_type = enumOf(ROTATE_TYPE, c1, 'AXIS_ANGLE');
      props.invert = c2 !== 0;
      break;
    case 'ShaderNodeVectorTransform':
      if (st) {
        props.vector_type = enumOf(VT_TYPE, st.num('type'), 'VECTOR');
        props.convert_from = enumOf(VT_SPACE, st.num('convert_from'), 'WORLD');
        props.convert_to = enumOf(VT_SPACE, st.num('convert_to'), 'OBJECT');
      }
      break;
    case 'ShaderNodeBsdfToon':
      props.component = c1 === 1 ? 'GLOSSY' : 'DIFFUSE';
      break;
    case 'ShaderNodeBsdfHair':
      props.component = c1 === 1 ? 'Transmission' : 'Reflection';
      break;
    case 'ShaderNodeBsdfHairPrincipled':
      if (st) {
        props.model = st.num('model') === 1 ? 'HUANG' : 'CHIANG';
        props.parametrization = enumOf(HAIR_PARAM, st.num('parametrization'), 'COLOR');
      }
      break;
    case 'ShaderNodeBsdfMetallic':
      props.fresnel_type = c2 === 1 ? 'F82' : 'PHYSICAL_CONDUCTOR';
      break;
    case 'ShaderNodeSubsurfaceScattering':
      props.falloff = enumOf(SSS_FALLOFF, c1, 'RANDOM_WALK');
      break;
    case 'ShaderNodeBsdfSheen':
      props.distribution = c1 === 0 ? 'ASHIKHMIN' : 'MICROFIBER';
      break;
    case 'ShaderNodeVolumeScatter':
      props.phase = enumOf(SCATTER_PHASE, c1, 'HENYEY_GREENSTEIN');
      break;
    case 'ShaderNodeRGBCurve': {
      const cv = readCurves(st, 4);
      if (cv) props.mapping = cv;
      break;
    }
    case 'ShaderNodeVectorCurve': {
      const cv = readCurves(st, 3);
      if (cv) props.mapping = cv;
      break;
    }
    case 'ShaderNodeFloatCurve': {
      const cv = readCurves(st, 1);
      if (cv) props.mapping = cv;
      break;
    }
    case 'ShaderNodeTexWhiteNoise':
      props.noise_dimensions = c1 >= 1 && c1 <= 4 ? `${c1}D` : '3D';
      break;
    case 'ShaderNodeTexMagic':
      if (st) props.turbulence_depth = st.num('depth', 2);
      break;
    case 'ShaderNodeSeparateColor':
    case 'ShaderNodeCombineColor':
      if (st) props.mode = enumOf(COLOR_MODE, st.num('mode'), 'RGB');
      break;
    case 'ShaderNodeValToRGB': {
      const ramp = readRamp(st);
      if (ramp) props.color_ramp = ramp;
      break;
    }
    case 'ShaderNodeBump':
      props.invert = c1 !== 0;
      break;
    case 'ShaderNodeOutputMaterial':
      props.target = enumOf(OUTPUT_TARGET, c1, 'ALL');
      break;
    case 'ShaderNodeRGB': {
      const v = n.outputs[0] ? socketValues(n.outputs[0]) : null;
      if (v && v.length >= 3) props.color = linearToHex(v);
      break;
    }
    case 'ShaderNodeValue': {
      const v = n.outputs[0] ? socketValues(n.outputs[0]) : null;
      if (v) props.value = v[0];
      break;
    }
    case 'NodeFrame':
      if (st) {
        props.shrink = (st.num('flag') & 1) !== 0;
        props.label_size = st.num('label_size', 20);
      }
      break;
    default:
      break;
  }
  void type;
}

/** Position absolue (Blender, Y vers le haut) : `location` absolu depuis Blender 4.4, sinon relatif au cadre. */
function absoluteLocation(n: SNode, byBlock: Map<number, SNode>, depth = 0): [number, number] {
  const r = n.rec;
  if (r.has('location')) {
    const l = r.nums('location', 2) ?? [0, 0];
    return [l[0], l[1]];
  }
  const own: [number, number] = [r.num('locx'), r.num('locy')];
  const parent = byBlock.get(r.target('parent'));
  if (!parent || depth > 32) return own;
  const p = absoluteLocation(parent, byBlock, depth + 1);
  return [own[0] + p[0], own[1] + p[1]];
}

/**
 * Convertit l'arbre de nœuds d'un matériau. null si le matériau n'utilise pas de nœuds (ou
 * s'il n'a pas de sortie de matériau) : il est alors importé en mode simple.
 */
export function convertMaterialTree(ctx: Ctx, mat: Rec): ConvertedTree | null {
  if (mat.has('use_nodes') && mat.num('use_nodes') === 0) return null;
  const tree = readTree(mat.get('nodetree', 'bNodeTree'));
  if (!tree || !findOutput(tree, ['ShaderNodeOutputMaterial'])) return null;
  return convertTree(ctx, tree, mat.idName || 'Matériau');
}

export function convertTree(ctx: Ctx, tree: STree, matName: string): ConvertedTree | null {
  const nodes: Record<string, NodeData> = {};
  const ids = new Map<number, string>();
  const byBlock = new Map<number, SNode>();
  const sockMap = new Map<number, { node: string; socket: string; dir: 'in' | 'out' }>();
  for (const n of tree.nodes) byBlock.set(n.block, n);

  tree.nodes.forEach((n, index) => {
    const alias = ALIASES[n.idname];
    const type = alias?.type ?? n.idname;
    const def = nodeType('shader', type);
    if (!def) {
      const what =
        n.idname === 'ShaderNodeGroup'
          ? 'groupes de nœuds'
          : `nœud « ${n.idname.replace(/^ShaderNode/, '')} »`;
      ctx.notes.add(`nodes-unsupported:${what}`, (count, names) => `Nœuds non repris dans l'éditeur de shaders (${what}, ${count} : ${names}) : leurs liens sont retirés.`, matName);
      return;
    }
    const id = `b${index}`;
    ids.set(n.block, id);
    const d = nodeDefaults(def);
    const props = { ...d.props, ...(alias?.props ?? {}) };
    readProps(n, type, props, ctx.version >= 500);
    const [lx, ly] = absoluteLocation(n, byBlock);
    const node: NodeData = { id, type, x: Math.round(lx), y: Math.round(-ly), inputs: d.inputs, props };
    const label = n.rec.str('label');
    if (label) node.label = label;
    if (n.flag & NODE_MUTED) node.muted = true;
    if (n.flag & NODE_HIDDEN) node.collapsed = true;
    const w = n.rec.num('width');
    if (w > 0 && !def.layout && Math.abs(w - (def.width ?? 150)) > 1) node.width = Math.round(w);
    // Entrées : valeurs par défaut stockées, par identifiant (anciens noms convertis).
    for (const s of n.inputs) {
      if (n.idname === 'ShaderNodeTexMusgrave' && s.identifier === 'Dimension') continue;
      let sid = alias?.inputs?.[s.identifier] ?? alias?.inputs?.[s.name] ?? s.identifier;
      if (type === 'ShaderNodeBsdfPrincipled') {
        if (DROPPED_LEGACY.has(sid)) continue;
        // Blender 3.x : « Specular Tint » / « Sheen Tint » étaient des flottants (teinte vers la couleur de base).
        if ((sid === 'Specular Tint' || sid === 'Sheen Tint') && s.kind === 'float') continue;
        sid = PRINCIPLED_LEGACY[sid] ?? sid;
      }
      const sd = def.inputs.find((x) => x.id === sid) ?? def.inputs.find((x) => x.label === s.name);
      if (!sd) continue;
      sockMap.set(s.block, { node: id, socket: sd.id, dir: 'in' });
      if (sd.hideValue || sd.type === 'shader' || sd.type === 'any') continue;
      const v = socketValue(s, sd);
      if (v !== undefined) node.inputs[sd.id] = v;
    }
    for (const s of n.outputs) {
      const sid = alias?.outputs?.[s.identifier] ?? alias?.outputs?.[s.name] ?? s.identifier;
      const sd = def.outputs.find((x) => x.id === sid) ?? def.outputs.find((x) => x.label === s.name);
      if (sd) sockMap.set(s.block, { node: id, socket: sd.id, dir: 'out' });
    }
    if (n.idname === 'ShaderNodeTexMusgrave') {
      // Conversion de Blender 4.1 (Musgrave → Bruit) : rugosité = lacunarité^(−dimension), détail − 1.
      const dim = n.inputs.find((x) => x.identifier === 'Dimension');
      const dv = dim ? socketValues(dim)?.[0] : undefined;
      const lac = Number(node.inputs.Lacunarity ?? 2);
      if (dv !== undefined) node.inputs.Roughness = Math.min(1, Math.max(0, Math.pow(Math.max(lac, 1e-6), -dv)));
      node.inputs.Detail = Math.max(0, Number(node.inputs.Detail ?? 2) - 1);
      ctx.notes.add('nodes-musgrave', (count, names) => `Textures Musgrave converties en textures de bruit, comme Blender 4.1 (${count} : ${names}).`, matName);
    }
    if ((type === 'ShaderNodeTexImage' || type === 'ShaderNodeTexEnvironment') && n.rec.target('id') >= 0) {
      ctx.notes.add('nodes-images', (count, names) => `Images des nœuds de texture non reprises (${count} : ${names}) : rouvrez-les dans le nœud (bouton « Ouvrir »).`, matName);
    }
    nodes[id] = node;
  });
  if (Object.keys(nodes).length === 0) return null;

  // Parents (cadres).
  for (const n of tree.nodes) {
    const id = ids.get(n.block);
    const parent = ids.get(n.rec.target('parent'));
    if (id && parent && nodes[parent]?.type === 'NodeFrame') nodes[id].parent = parent;
  }

  // Liens : entrée → sortie qui l'alimente (redirections et groupes déjà traversés par readTree ? non :
  // `incoming` garde le lien direct, une redirection est un nœud comme un autre).
  const links: NodeLink[] = [];
  let k = 0;
  for (const n of tree.nodes) {
    for (const s of n.inputs) {
      const from = tree.incoming.get(s.block);
      if (!from) continue;
      const to = sockMap.get(s.block);
      const src = sockMap.get(from.block);
      if (!to || !src || to.dir !== 'in' || src.dir !== 'out') continue;
      links.push({ id: `bl${k++}`, fromNode: src.node, fromSocket: src.socket, toNode: to.node, toSocket: to.socket });
    }
  }
  return { nodes, links };
}
