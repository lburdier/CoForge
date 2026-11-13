import type { MaterialData, NodeData, NodeLink, NodeTreeData } from '../doc/schema';
import { BLEND_TYPES, PRINCIPLED_PANELS, registerShaderNodes } from './shaderNodes';
import { SHADER_GLSL_LIBRARY } from './shaderGlsl';
import { nodeType, type NodeTypeDef, type SocketDef } from './types';
import { newId } from './graph';
import { SHADER_GLSL_MORE } from './shader/glsl';
import {
  blackbody, evalCurve, fresnelDielectricCos, hashVec3, hashVec3ToVec3, imageAverage, layerWeight, prepareCurve, skyColor, texBrick, texChecker, texGabor,
  texGradient, texMagic, texNoise, texVoronoi, texWave, wavelengthToRgb, type CurvePts,
} from './shader/cpu';

/**
 * Compilation d'un arbre de nœuds de shader.
 *
 * Une seule passe sur l'arbre, à partir de « Sortie du matériau » :
 *  - tout ce qui ne dépend que de constantes est calculé ici, en JavaScript (repli des constantes) ;
 *  - ce qui varie d'un pixel à l'autre (textures procédurales, Fresnel, coordonnées, relief…) est
 *    traduit en GLSL, injecté dans le MeshPhysicalMaterial du moteur temps réel (src/engine/nodeMaterial.ts) ;
 *  - chaque valeur porte aussi une estimation moyenne (`a`) : elle sert au path tracer, à l'export
 *    et aux champs simples du matériau, qui ne savent pas évaluer de texture par pixel.
 *
 * Les shaders (closures) sont ramenés à un jeu de paramètres « Principled » : un Mélanger les
 * shaders interpole les paramètres, Ajouter les shaders additionne l'émission. C'est le modèle
 * d'EEVEE : exact pour un Principled seul, approché pour les combinaisons de BSDF.
 */

registerShaderNodes();

export type V3 = [number, number, number];
type K = number | V3;
/** f : flottant ; v : vecteur ; c : couleur (linéaire). */
type T = 'f' | 'v' | 'c';

interface Val {
  t: T;
  /** Valeur constante (absente si la valeur varie par pixel). */
  k?: K;
  /** Expression GLSL (variable temporaire) quand la valeur varie. */
  g?: string;
  /** Estimation moyenne (toujours présente). */
  a: K;
  /** Constante modifiable par l'utilisateur (valeur de socket, propriété) : uniforme GLSL, pas littéral. */
  u?: boolean;
}

/** Paramètres « Principled » (couleurs linéaires) : la forme commune de tout shader compilé. */
export interface ShaderParams {
  baseColor: V3;
  metallic: number;
  roughness: number;
  ior: number;
  alpha: number;
  diffuseRoughness: number;
  subsurface: number;
  specularLevel: number;
  specularTint: V3;
  anisotropic: number;
  transmission: number;
  coat: number;
  coatRoughness: number;
  coatIor: number;
  coatTint: V3;
  sheen: number;
  sheenRoughness: number;
  sheenTint: V3;
  /** Radiance émise (couleur × intensité), linéaire. */
  emission: V3;
  thinFilmThickness: number;
  thinFilmIor: number;
}

type Ch = keyof ShaderParams;

const CH_TYPES: Record<Ch, T> = {
  baseColor: 'c',
  metallic: 'f',
  roughness: 'f',
  ior: 'f',
  alpha: 'f',
  diffuseRoughness: 'f',
  subsurface: 'f',
  specularLevel: 'f',
  specularTint: 'c',
  anisotropic: 'f',
  transmission: 'f',
  coat: 'f',
  coatRoughness: 'f',
  coatIor: 'f',
  coatTint: 'c',
  sheen: 'f',
  sheenRoughness: 'f',
  sheenTint: 'c',
  emission: 'c',
  thinFilmThickness: 'f',
  thinFilmIor: 'f',
};
const CHANNELS = Object.keys(CH_TYPES) as Ch[];

export const PRINCIPLED_DEFAULTS: ShaderParams = {
  baseColor: [0.8, 0.8, 0.8],
  metallic: 0,
  roughness: 0.5,
  ior: 1.5,
  alpha: 1,
  diffuseRoughness: 0,
  subsurface: 0,
  specularLevel: 0.5,
  specularTint: [1, 1, 1],
  anisotropic: 0,
  transmission: 0,
  coat: 0,
  coatRoughness: 0.03,
  coatIor: 1.5,
  coatTint: [1, 1, 1],
  sheen: 0,
  sheenRoughness: 0.5,
  sheenTint: [1, 1, 1],
  emission: [0, 0, 0],
  thinFilmThickness: 0,
  thinFilmIor: 1.33,
};

/** Canaux que le moteur temps réel sait faire varier par pixel. */
export type VaryingChannel = 'baseColor' | 'alpha' | 'metallic' | 'roughness' | 'emission' | 'normal';

export interface CompiledShader {
  /** Valeurs constantes, ou moyennes estimées des canaux qui varient. */
  params: ShaderParams;
  /** Expressions GLSL des canaux qui varient (normale : en repère monde). */
  varying: Partial<Record<VaryingChannel, string>>;
  /** Instructions GLSL à exécuter avant d'utiliser `varying`. */
  code: string;
  /** Bibliothèque de fonctions GLSL (vide si aucun canal ne varie). */
  library: string;
  /** Variables d'entrée utilisées (cf_gen, cf_N…). */
  builtins: string[];
  /** Ce qui n'est pas rendu exactement, en français (une phrase par cause). */
  notes: string[];
  /** La sortie du matériau reçoit un shader. */
  hasSurface: boolean;
  /**
   * Valeurs des uniformes `uniform vec4 cf_u[uniformVec4]` (4 flottants par vec4) : valeurs des
   * sockets et propriétés numériques. Changer une valeur change ce tableau, pas `key`.
   */
  uniforms: Float32Array;
  uniformVec4: number;
  /** Identifiants des images du document, liées aux samplers `cf_img0`, `cf_img1`… */
  images: string[];
  /** Clé de cache du programme GPU (identique ⇔ même GLSL). */
  key: string;
}

// ------------------------------------------------------------------ couleurs

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
export function linearToSrgb(c: number): number {
  c = Math.max(0, c);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
export function hexToLinear(hex: unknown, fallback: V3 = [0, 0, 0]): V3 {
  if (typeof hex !== 'string') return fallback;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255)];
}
export function linearToHex(c: readonly number[]): string {
  let s = '#';
  for (let i = 0; i < 3; i++) {
    const v = Math.round(Math.min(1, linearToSrgb(Number.isFinite(c[i]) ? c[i] : 0)) * 255);
    s += v.toString(16).padStart(2, '0');
  }
  return s;
}

// ------------------------------------------------------------------ calculs JS (repli des constantes)

const v3 = (k: K): V3 => (typeof k === 'number' ? [k, k, k] : k);
const map3 = (a: V3, fn: (x: number, i: number) => number): V3 => [fn(a[0], 0), fn(a[1], 1), fn(a[2], 2)];
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const safeDiv = (a: number, b: number) => (b !== 0 ? a / b : 0);
const fract = (x: number) => x - Math.floor(x);
const lum = (c: V3) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.sqrt(dot(a, a));
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp(safeDiv(x - e0, e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
const smootherstep = (e0: number, e1: number, x: number) => {
  const t = clamp(safeDiv(x - e0, e1 - e0), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

export function rgbToHsv(c: V3): V3 {
  const cmax = Math.max(...c);
  const cmin = Math.min(...c);
  const cd = cmax - cmin;
  let h = 0;
  const s = cmax !== 0 ? cd / cmax : 0;
  if (s !== 0) {
    const cc = c.map((x) => (cmax - x) / cd);
    if (c[0] === cmax) h = cc[2] - cc[1];
    else if (c[1] === cmax) h = 2 + cc[0] - cc[2];
    else h = 4 + cc[1] - cc[0];
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, s, cmax];
}
export function hsvToRgb([h0, s, v]: V3): V3 {
  if (s === 0) return [v, v, v];
  let h = h0 === 1 ? 0 : h0;
  h *= 6;
  const i = Math.floor(h);
  const f2 = h - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f2);
  const t = v * (1 - s * (1 - f2));
  switch (i) {
    case 0:
      return [v, t, p];
    case 1:
      return [q, v, p];
    case 2:
      return [p, v, t];
    case 3:
      return [p, q, v];
    case 4:
      return [t, p, v];
    default:
      return [v, p, q];
  }
}
function rgbToHsl(c: V3): V3 {
  const cmax = Math.max(...c);
  const cmin = Math.min(...c);
  let h = 0;
  let s = 0;
  const l = Math.min(1, (cmax + cmin) / 2);
  if (cmax !== cmin) {
    const d = cmax - cmin;
    s = l > 0.5 ? d / (2 - cmax - cmin) : d / (cmax + cmin);
    if (cmax === c[0]) h = (c[1] - c[2]) / d + (c[1] < c[2] ? 6 : 0);
    else if (cmax === c[1]) h = (c[2] - c[0]) / d + 2;
    else h = (c[0] - c[1]) / d + 4;
  }
  return [h / 6, s, l];
}
function hslToRgb([h, s, l]: V3): V3 {
  const n: V3 = [clamp(Math.abs(h * 6 - 3) - 1, 0, 1), clamp(2 - Math.abs(h * 6 - 2), 0, 1), clamp(2 - Math.abs(h * 6 - 4), 0, 1)];
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  return map3(n, (x) => (x - 0.5) * chroma + l);
}

function blendJs(mode: number, f: number, a: V3, b: V3): V3 {
  const dodge = (x: number, y: number) => {
    if (x === 0) return x;
    const t = 1 - f * y;
    return t <= 0 ? 1 : Math.min(x / t, 1);
  };
  const burn = (x: number, y: number) => {
    const t = 1 - f + f * y;
    return t <= 0 ? 0 : clamp(1 - (1 - x) / t, 0, 1);
  };
  const overlay = (x: number, y: number) => (x < 0.5 ? x * (1 - f + 2 * f * y) : 1 - (1 - f + 2 * f * (1 - y)) * (1 - x));
  switch (mode) {
    case 0:
      return map3(a, (x, i) => lerp(x, b[i], f));
    case 1:
      return map3(a, (x, i) => lerp(x, Math.min(x, b[i]), f));
    case 2:
      return map3(a, (x, i) => lerp(x, x * b[i], f));
    case 3:
      return map3(a, (x, i) => burn(x, b[i]));
    case 4:
      return map3(a, (x, i) => lerp(x, Math.max(x, b[i]), f));
    case 5:
      return map3(a, (x, i) => 1 - (1 - f + f * (1 - b[i])) * (1 - x));
    case 6:
      return map3(a, (x, i) => dodge(x, b[i]));
    case 7:
      return map3(a, (x, i) => x + b[i] * f);
    case 8:
      return map3(a, (x, i) => overlay(x, b[i]));
    case 9:
      return map3(a, (x, i) => {
        const scr = 1 - (1 - b[i]) * (1 - x);
        return (1 - f) * x + f * ((1 - x) * b[i] * x + x * scr);
      });
    case 10:
      return map3(a, (x, i) => x + f * (2 * b[i] - 1));
    case 11:
      return map3(a, (x, i) => lerp(x, Math.abs(x - b[i]), f));
    case 12:
      return map3(a, (x, i) => Math.max(lerp(x, x + b[i] - 2 * x * b[i], f), 0));
    case 13:
      return map3(a, (x, i) => x - b[i] * f);
    case 14:
      return map3(a, (x, i) => (b[i] !== 0 ? (1 - f) * x + (f * x) / b[i] : x));
  }
  const ha = rgbToHsv(a);
  const hb = rgbToHsv(b);
  const mix3 = (p: V3, q: V3): V3 => map3(p, (x, i) => lerp(x, q[i], f));
  switch (mode) {
    case 15:
      if (hb[1] === 0) return a;
      return mix3(a, hsvToRgb([hb[0], ha[1], ha[2]]));
    case 16:
      if (ha[1] === 0) return a;
      return hsvToRgb([ha[0], lerp(ha[1], hb[1], f), ha[2]]);
    case 17:
      if (hb[1] === 0) return a;
      return mix3(a, hsvToRgb([hb[0], hb[1], ha[2]]));
    default:
      return hsvToRgb([ha[0], ha[1], lerp(ha[2], hb[2], f)]);
  }
}

function mathJs(op: string, a: number, b: number, c: number): number {
  switch (op) {
    case 'ADD':
      return a + b;
    case 'SUBTRACT':
      return a - b;
    case 'MULTIPLY':
      return a * b;
    case 'DIVIDE':
      return safeDiv(a, b);
    case 'MULTIPLY_ADD':
      return a * b + c;
    case 'POWER':
      if (a < 0 && b !== Math.floor(b)) return 0;
      return Math.pow(a, b);
    case 'LOGARITHM':
      return a > 0 && b > 0 ? Math.log(a) / Math.log(b) : 0;
    case 'SQRT':
      return a > 0 ? Math.sqrt(a) : 0;
    case 'INVERSE_SQRT':
      return a > 0 ? 1 / Math.sqrt(a) : 0;
    case 'ABSOLUTE':
      return Math.abs(a);
    case 'EXPONENT':
      return Math.exp(a);
    case 'MINIMUM':
      return Math.min(a, b);
    case 'MAXIMUM':
      return Math.max(a, b);
    case 'LESS_THAN':
      return a < b ? 1 : 0;
    case 'GREATER_THAN':
      return a > b ? 1 : 0;
    case 'SIGN':
      return Math.sign(a);
    case 'COMPARE':
      return Math.abs(a - b) <= Math.max(c, 1e-5) ? 1 : 0;
    case 'SMOOTH_MIN':
    case 'SMOOTH_MAX': {
      const sm = (x: number, y: number) => {
        if (c !== 0) {
          const h = Math.max(c - Math.abs(x - y), 0) / c;
          return Math.min(x, y) - (h * h * h * c) / 6;
        }
        return Math.min(x, y);
      };
      return op === 'SMOOTH_MIN' ? sm(a, b) : -sm(-a, -b);
    }
    case 'ROUND':
      return Math.floor(a + 0.5);
    case 'FLOOR':
      return Math.floor(a);
    case 'CEIL':
      return Math.ceil(a);
    case 'TRUNC':
      return Math.trunc(a);
    case 'FRACT':
      return fract(a);
    case 'MODULO':
      return b !== 0 ? a - b * Math.trunc(a / b) : 0;
    case 'FLOORED_MODULO':
      return b !== 0 ? a - b * Math.floor(a / b) : 0;
    case 'WRAP': {
      const r = b - c;
      return r !== 0 ? a - r * Math.floor((a - c) / r) : c;
    }
    case 'SNAP':
      return b !== 0 ? Math.floor(a / b) * b : 0;
    case 'PINGPONG':
      return b !== 0 ? Math.abs(fract((a - b) / (b * 2)) * b * 2 - b) : 0;
    case 'SINE':
      return Math.sin(a);
    case 'COSINE':
      return Math.cos(a);
    case 'TANGENT':
      return Math.tan(a);
    case 'ARCSINE':
      return a >= -1 && a <= 1 ? Math.asin(a) : 0;
    case 'ARCCOSINE':
      return a >= -1 && a <= 1 ? Math.acos(a) : 0;
    case 'ARCTANGENT':
      return Math.atan(a);
    case 'ARCTAN2':
      return Math.atan2(a, b);
    case 'SINH':
      return Math.sinh(a);
    case 'COSH':
      return Math.cosh(a);
    case 'TANH':
      return Math.tanh(a);
    case 'RADIANS':
      return (a * Math.PI) / 180;
    case 'DEGREES':
      return (a * 180) / Math.PI;
    default:
      return 0;
  }
}

function mathGlsl(op: string, a: string, b: string, c: string): string {
  switch (op) {
    case 'ADD':
      return `${a} + ${b}`;
    case 'SUBTRACT':
      return `${a} - ${b}`;
    case 'MULTIPLY':
      return `${a} * ${b}`;
    case 'DIVIDE':
      return `cf_safe_div(${a}, ${b})`;
    case 'MULTIPLY_ADD':
      return `${a} * ${b} + ${c}`;
    case 'POWER':
      return `cf_safe_pow(${a}, ${b})`;
    case 'LOGARITHM':
      return `cf_safe_log(${a}, ${b})`;
    case 'SQRT':
      return `(${a} > 0.0 ? sqrt(${a}) : 0.0)`;
    case 'INVERSE_SQRT':
      return `(${a} > 0.0 ? inversesqrt(${a}) : 0.0)`;
    case 'ABSOLUTE':
      return `abs(${a})`;
    case 'EXPONENT':
      return `exp(${a})`;
    case 'MINIMUM':
      return `min(${a}, ${b})`;
    case 'MAXIMUM':
      return `max(${a}, ${b})`;
    case 'LESS_THAN':
      return `(${a} < ${b} ? 1.0 : 0.0)`;
    case 'GREATER_THAN':
      return `(${a} > ${b} ? 1.0 : 0.0)`;
    case 'SIGN':
      return `sign(${a})`;
    case 'COMPARE':
      return `(abs(${a} - ${b}) <= max(${c}, 1e-5) ? 1.0 : 0.0)`;
    case 'SMOOTH_MIN':
      return `cf_smin(${a}, ${b}, ${c})`;
    case 'SMOOTH_MAX':
      return `-cf_smin(-(${a}), -(${b}), ${c})`;
    case 'ROUND':
      return `floor(${a} + 0.5)`;
    case 'FLOOR':
      return `floor(${a})`;
    case 'CEIL':
      return `ceil(${a})`;
    case 'TRUNC':
      return `trunc(${a})`;
    case 'FRACT':
      return `fract(${a})`;
    case 'MODULO':
      return `cf_fmod(${a}, ${b})`;
    case 'FLOORED_MODULO':
      return `cf_fmodf(${a}, ${b})`;
    case 'WRAP':
      return `cf_wrap(${a}, ${b}, ${c})`;
    case 'SNAP':
      return `(${b} != 0.0 ? floor(${a} / ${b}) * ${b} : 0.0)`;
    case 'PINGPONG':
      return `cf_pingpong(${a}, ${b})`;
    case 'SINE':
      return `sin(${a})`;
    case 'COSINE':
      return `cos(${a})`;
    case 'TANGENT':
      return `tan(${a})`;
    case 'ARCSINE':
      return `(abs(${a}) <= 1.0 ? asin(${a}) : 0.0)`;
    case 'ARCCOSINE':
      return `(abs(${a}) <= 1.0 ? acos(${a}) : 0.0)`;
    case 'ARCTANGENT':
      return `atan(${a})`;
    case 'ARCTAN2':
      return `atan(${a}, ${b})`;
    case 'SINH':
      return `sinh(${a})`;
    case 'COSH':
      return `cosh(${a})`;
    case 'TANH':
      return `tanh(${a})`;
    case 'RADIANS':
      return `radians(${a})`;
    case 'DEGREES':
      return `degrees(${a})`;
    default:
      return '0.0';
  }
}

const VMATH_SCALAR = new Set(['DOT_PRODUCT', 'DISTANCE', 'LENGTH']);

function vmathJs(op: string, a: V3, b: V3, c: V3, s: number): K {
  switch (op) {
    case 'ADD':
      return map3(a, (x, i) => x + b[i]);
    case 'SUBTRACT':
      return map3(a, (x, i) => x - b[i]);
    case 'MULTIPLY':
      return map3(a, (x, i) => x * b[i]);
    case 'DIVIDE':
      return map3(a, (x, i) => safeDiv(x, b[i]));
    case 'MULTIPLY_ADD':
      return map3(a, (x, i) => x * b[i] + c[i]);
    case 'CROSS_PRODUCT':
      return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    case 'PROJECT': {
      const l = dot(b, b);
      return l !== 0 ? map3(b, (x) => (x * dot(a, b)) / l) : [0, 0, 0];
    }
    case 'REFLECT': {
      const n = len(b) > 0 ? map3(b, (x) => x / len(b)) : b;
      const d = dot(n, a);
      return map3(a, (x, i) => x - 2 * d * n[i]);
    }
    case 'REFRACT': {
      // Blender : refract(normalize(a), normalize(b), échelle = rapport d'indices).
      const na = len(a) > 0 ? map3(a, (x) => x / len(a)) : a;
      const nb = len(b) > 0 ? map3(b, (x) => x / len(b)) : b;
      const d = dot(nb, na);
      const k = 1 - s * s * (1 - d * d);
      return k < 0 ? [0, 0, 0] : map3(na, (x, i) => s * x - (s * d + Math.sqrt(k)) * nb[i]);
    }
    case 'FACEFORWARD':
      return dot(c, b) < 0 ? a : map3(a, (x) => -x);
    case 'POWER':
      return map3(a, (x, i) => (x < 0 && b[i] !== Math.floor(b[i]) ? 0 : Math.pow(x, b[i])));
    case 'SIGN':
      return map3(a, Math.sign);
    case 'ROUND':
      return map3(a, (x) => Math.floor(x + 0.5));
    case 'WRAP':
      return map3(a, (x, i) => {
        const r = b[i] - c[i];
        return r !== 0 ? x - r * Math.floor((x - c[i]) / r) : c[i];
      });
    case 'DOT_PRODUCT':
      return dot(a, b);
    case 'DISTANCE':
      return len(map3(a, (x, i) => x - b[i]));
    case 'LENGTH':
      return len(a);
    case 'SCALE':
      return map3(a, (x) => x * s);
    case 'NORMALIZE': {
      const l = len(a);
      return l !== 0 ? map3(a, (x) => x / l) : [0, 0, 0];
    }
    case 'ABSOLUTE':
      return map3(a, Math.abs);
    case 'MINIMUM':
      return map3(a, (x, i) => Math.min(x, b[i]));
    case 'MAXIMUM':
      return map3(a, (x, i) => Math.max(x, b[i]));
    case 'FLOOR':
      return map3(a, Math.floor);
    case 'CEIL':
      return map3(a, Math.ceil);
    case 'FRACTION':
      return map3(a, fract);
    case 'MODULO':
      return map3(a, (x, i) => (b[i] !== 0 ? x - b[i] * Math.trunc(x / b[i]) : 0));
    case 'SNAP':
      return map3(a, (x, i) => (b[i] !== 0 ? Math.floor(x / b[i]) * b[i] : 0));
    case 'SINE':
      return map3(a, Math.sin);
    case 'COSINE':
      return map3(a, Math.cos);
    case 'TANGENT':
      return map3(a, Math.tan);
    default:
      return [0, 0, 0];
  }
}

function vmathGlsl(op: string, a: string, b: string, c: string, s: string): string {
  switch (op) {
    case 'ADD':
      return `${a} + ${b}`;
    case 'SUBTRACT':
      return `${a} - ${b}`;
    case 'MULTIPLY':
      return `${a} * ${b}`;
    case 'DIVIDE':
      return `cf_safe_div3(${a}, ${b})`;
    case 'MULTIPLY_ADD':
      return `${a} * ${b} + ${c}`;
    case 'CROSS_PRODUCT':
      return `cross(${a}, ${b})`;
    case 'PROJECT':
      return `cf_project3(${a}, ${b})`;
    case 'REFLECT':
      return `reflect(${a}, normalize(${b}))`;
    case 'REFRACT':
      return `refract(normalize(${a}), normalize(${b}), ${s})`;
    case 'FACEFORWARD':
      return `faceforward(${a}, ${b}, ${c})`;
    case 'POWER':
      return `vec3(cf_safe_pow((${a}).x, (${b}).x), cf_safe_pow((${a}).y, (${b}).y), cf_safe_pow((${a}).z, (${b}).z))`;
    case 'SIGN':
      return `sign(${a})`;
    case 'ROUND':
      return `floor(${a} + 0.5)`;
    case 'WRAP':
      return `vec3(cf_wrap((${a}).x, (${b}).x, (${c}).x), cf_wrap((${a}).y, (${b}).y, (${c}).y), cf_wrap((${a}).z, (${b}).z, (${c}).z))`;
    case 'DOT_PRODUCT':
      return `dot(${a}, ${b})`;
    case 'DISTANCE':
      return `distance(${a}, ${b})`;
    case 'LENGTH':
      return `length(${a})`;
    case 'SCALE':
      return `${a} * ${s}`;
    case 'NORMALIZE':
      return `(length(${a}) != 0.0 ? normalize(${a}) : vec3(0.0))`;
    case 'ABSOLUTE':
      return `abs(${a})`;
    case 'MINIMUM':
      return `min(${a}, ${b})`;
    case 'MAXIMUM':
      return `max(${a}, ${b})`;
    case 'FLOOR':
      return `floor(${a})`;
    case 'CEIL':
      return `ceil(${a})`;
    case 'FRACTION':
      return `fract(${a})`;
    case 'MODULO':
      return `cf_fmod3(${a}, ${b})`;
    case 'SNAP':
      return `cf_snap3(${a}, ${b})`;
    case 'SINE':
      return `sin(${a})`;
    case 'COSINE':
      return `cos(${a})`;
    case 'TANGENT':
      return `tan(${a})`;
    default:
      return 'vec3(0.0)';
  }
}

function eulerToMat3(e: V3): number[] {
  const [cx, cy, cz] = e.map(Math.cos);
  const [sx, sy, sz] = e.map(Math.sin);
  // Colonnes (comme mat3 GLSL) : m[col][row].
  return [cy * cz, cy * sz, -sy, sy * sx * cz - cx * sz, sy * sx * sz + cx * cz, cy * sx, sy * cx * cz + sx * sz, sy * cx * sz - sx * cz, cy * cx];
}
const mulMat = (m: number[], v: V3): V3 => [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];
const mulMatT = (m: number[], v: V3): V3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];

function mappingJs(type: string, v: V3, loc: V3, rot: V3, scale: V3): V3 {
  const m = eulerToMat3(rot);
  switch (type) {
    case 'TEXTURE':
      return map3(mulMatT(m, map3(v, (x, i) => x - loc[i])), (x, i) => safeDiv(x, scale[i]));
    case 'VECTOR':
      return mulMat(m, map3(v, (x, i) => x * scale[i]));
    case 'NORMAL': {
      const r = mulMat(m, map3(v, (x, i) => safeDiv(x, scale[i])));
      const l = len(r);
      return l > 0 ? map3(r, (x) => x / l) : r;
    }
    default:
      return map3(mulMat(m, map3(v, (x, i) => x * scale[i])), (x, i) => x + loc[i]);
  }
}

interface RampStop {
  position: number;
  color: string;
  alpha: number;
}
interface Ramp {
  interpolation: string;
  elements: RampStop[];
}

function normalizeRamp(r: unknown): { interp: string; stops: { p: number; c: V3; a: number }[] } {
  const ramp = (r && typeof r === 'object' ? r : {}) as Partial<Ramp>;
  const list = Array.isArray(ramp.elements) ? ramp.elements : [];
  const stops = list
    .map((e) => ({ p: clamp(Number(e?.position) || 0, 0, 1), c: hexToLinear(e?.color, [0, 0, 0]), a: Number.isFinite(e?.alpha) ? Number(e.alpha) : 1 }))
    .sort((x, y) => x.p - y.p);
  if (stops.length === 0) stops.push({ p: 0, c: [0, 0, 0], a: 1 }, { p: 1, c: [1, 1, 1], a: 1 });
  return { interp: String(ramp.interpolation ?? 'LINEAR'), stops };
}

function rampJs(r: ReturnType<typeof normalizeRamp>, t: number): [V3, number] {
  const s = r.stops;
  if (t <= s[0].p) return [s[0].c, s[0].a];
  for (let i = 1; i < s.length; i++) {
    if (t < s[i].p || i === s.length - 1) {
      if (t >= s[i].p) return [s[i].c, s[i].a];
      if (r.interp === 'CONSTANT') return [s[i - 1].c, s[i - 1].a];
      let f2 = safeDiv(t - s[i - 1].p, s[i].p - s[i - 1].p);
      if (r.interp === 'EASE') f2 = f2 * f2 * (3 - 2 * f2);
      return [map3(s[i - 1].c, (x, k) => lerp(x, s[i].c[k], f2)), lerp(s[i - 1].a, s[i].a, f2)];
    }
  }
  return [s[s.length - 1].c, s[s.length - 1].a];
}

// ------------------------------------------------------------------ littéraux GLSL

function litF(n: number): string {
  if (!Number.isFinite(n)) n = 0;
  const s = String(Math.fround(n) === n ? n : +n.toPrecision(9));
  return /[.e]/.test(s) ? s : `${s}.0`;
}
function lit(k: K): string {
  return typeof k === 'number' ? litF(k) : `vec3(${litF(k[0])}, ${litF(k[1])}, ${litF(k[2])})`;
}

// ------------------------------------------------------------------ compilateur

interface Closure {
  surface: boolean;
  ch: Record<Ch, Val>;
  /** Normale (repère monde) imposée par un nœud Relief. */
  normal?: Val;
  /** Shader de volume (non rendu). */
  volume?: boolean;
}

type Outputs = Record<string, Val | Closure>;

const isClosure = (x: Val | Closure | null | undefined): x is Closure => !!x && 'ch' in x;

const konst = (t: T, k: K, u?: boolean): Val => (u ? { t, k, a: k, u } : { t, k, a: k });

/** Valeur d'entrée stockée dans le nœud (ou défaut du catalogue), selon le type du socket. Modifiable → uniforme. */
function storedValue(sock: SocketDef, raw: unknown): Val {
  const value = raw === undefined ? sock.default : raw;
  switch (sock.type) {
    case 'color':
      return konst('c', hexToLinear(value, hexToLinear(sock.default, [0, 0, 0])), true);
    case 'vector': {
      const a = Array.isArray(value) ? value : Array.isArray(sock.default) ? sock.default : [0, 0, 0];
      return konst('v', [Number(a[0]) || 0, Number(a[1]) || 0, Number(a[2]) || 0], true);
    }
    case 'bool':
      return konst('f', value ? 1 : 0, true);
    default: {
      const n = Number(value);
      return konst('f', Number.isFinite(n) ? n : 0, true);
    }
  }
}

const sockType = (s: SocketDef): T => (s.type === 'color' ? 'c' : s.type === 'vector' ? 'v' : 'f');

/** Valeurs des variables d'entrée (cf_gen, cf_N…) en un point, pour l'évaluation CPU. */
export type SamplePoint = Record<string, K>;

/** Nombre maximal de vec4 d'uniformes de valeurs par matériau (au-delà : littéraux, donc recompilation). */
export const MAX_UNIFORM_VEC4 = 128;
/** Nombre maximal d'images par matériau (unités de texture). */
export const MAX_IMAGES = 8;

const enumIndex = (list: string[], v: unknown, fallback = 0) => {
  const i = list.indexOf(String(v));
  return i >= 0 ? i : fallback;
};
const bool01 = (b: boolean) => (b ? 'true' : 'false');

class Compiler {
  private lines: string[] = [];
  private counter = 0;
  readonly notes = new Set<string>();
  readonly builtins = new Set<string>();
  usesGlsl = false;
  private memo = new Map<string, Outputs>();
  private visiting = new Set<string>();
  private incoming = new Map<string, NodeLink>();
  /** Valeurs des uniformes `cf_u` (vec4 empaquetés). */
  readonly uvals: number[] = [];
  private uref = new WeakMap<Val, string>();
  private ufloat = -1;
  /** Images utilisées (indice = unité cf_img<i>). */
  readonly images: string[] = [];

  constructor(
    private tree: NodeTreeData,
    private point: SamplePoint | null = null,
  ) {
    for (const l of tree.links ?? []) {
      if (!l || !tree.nodes[l.fromNode] || !tree.nodes[l.toNode]) continue;
      this.incoming.set(`${l.toNode}\u0000${l.toSocket}`, l);
    }
  }

  get cpu(): boolean {
    return this.point !== null;
  }

  code(): string {
    return this.lines.join('\n');
  }

  // ---------------------------------------------------------------- valeurs

  tmp(t: T, expr: string): string {
    const name = `cf_t${this.counter++}`;
    this.lines.push(`${t === 'f' ? 'float' : 'vec3'} ${name} = ${expr};`);
    this.usesGlsl = true;
    return name;
  }

  /** Réserve des flottants dans `cf_u` ; renvoie l'indice du premier, ou -1 si plein. */
  private allocFloats(values: number[], aligned: boolean): number {
    if (aligned || this.ufloat < 0 || (this.ufloat & 3) + values.length > 4) {
      if (this.uvals.length / 4 >= MAX_UNIFORM_VEC4) return -1;
      if (!aligned && values.length === 1 && this.ufloat >= 0 && (this.ufloat & 3) !== 0) {
        // place libre dans le vec4 courant
      } else {
        this.ufloat = this.uvals.length;
        this.uvals.push(0, 0, 0, 0);
      }
    }
    const at = this.ufloat;
    values.forEach((x, i) => (this.uvals[at + i] = Number.isFinite(x) ? x : 0));
    this.ufloat = at + values.length;
    if ((this.ufloat & 3) === 0) this.ufloat = -1;
    return at;
  }

  /** Expression GLSL d'une valeur : variable, uniforme (valeur modifiable par l'utilisateur) ou littéral. */
  g(v: Val): string {
    if (v.k === undefined) return v.g!;
    if (!v.u || this.cpu) return lit(v.k);
    const hit = this.uref.get(v);
    if (hit) return hit;
    let ref: string;
    if (typeof v.k === 'number') {
      const i = this.allocFloats([v.k], false);
      ref = i < 0 ? lit(v.k) : `cf_u[${i >> 2}].${'xyzw'[i & 3]}`;
    } else {
      const i = this.allocFloats([...v.k], true);
      ref = i < 0 ? lit(v.k) : `cf_u[${i >> 2}].xyz`;
    }
    this.uref.set(v, ref);
    return ref;
  }

  /** Table de flottants dans `cf_u` (courbes, rampes) ; renvoie l'indice de base, -1 si plein. */
  table(values: number[]): number {
    if (this.uvals.length / 4 + Math.ceil(values.length / 4) > MAX_UNIFORM_VEC4) return -1;
    const at = this.uvals.length;
    this.uvals.push(...values.map((x) => (Number.isFinite(x) ? x : 0)));
    while (this.uvals.length & 3) this.uvals.push(0);
    this.ufloat = -1;
    return at;
  }

  conv(v: Val, to: T): Val {
    if (v.t === to) return v;
    if (to === 'f') {
      const fn = v.t === 'c' ? (k: K) => lum(v3(k)) : (k: K) => (v3(k)[0] + v3(k)[1] + v3(k)[2]) / 3;
      const a = fn(v.a);
      if (v.k !== undefined) return konst('f', a, v.u);
      const expr = v.t === 'c' ? `dot(${v.g}, vec3(0.2126, 0.7152, 0.0722))` : `((${v.g}).x + (${v.g}).y + (${v.g}).z) / 3.0`;
      return { t: 'f', g: this.tmp('f', expr), a };
    }
    if (v.t === 'f') {
      const a = v3(v.a);
      if (v.k !== undefined) return konst(to, v3(v.k), v.u);
      return { t: to, g: `vec3(${v.g})`, a };
    }
    return { ...v, t: to };
  }

  builtin(name: string, t: T, approx: K): Val {
    if (this.point) {
      const k = this.point[name] ?? approx;
      return konst(t, t === 'f' ? (typeof k === 'number' ? k : k[0]) : v3(k));
    }
    this.builtins.add(name);
    this.usesGlsl = true;
    return { t, g: name, a: approx };
  }

  /** Opération pure : repliée si toutes les entrées sont constantes, sinon traduite en GLSL. */
  pure(t: T, ins: Val[], cpu: (...k: any[]) => K, glsl: (...g: string[]) => string): Val {
    const a = cpu(...ins.map((i) => i.a));
    if (ins.every((i) => i.k !== undefined)) return konst(t, a, ins.some((i) => i.u));
    return { t, g: this.tmp(t, glsl(...ins.map((i) => this.g(i)))), a };
  }

  /**
   * Fonction à plusieurs sorties (textures…) : évaluée en JavaScript si toutes les entrées sont
   * constantes (repli, évaluation CPU), sinon appel GLSL avec paramètres `out`.
   */
  fn(types: T[], ins: Val[], js: (...k: any[]) => K[], call: (args: string[], outs: string[]) => string): Val[] {
    if (ins.every((i) => i.k !== undefined)) {
      const r = js(...ins.map((i) => i.k));
      return types.map((t, i) => konst(t, r[i]));
    }
    const a = js(...ins.map((i) => i.a));
    const names = types.map(() => `cf_t${this.counter++}`);
    const args = ins.map((i) => this.g(i));
    this.lines.push(types.map((t, i) => `${t === 'f' ? 'float' : 'vec3'} ${names[i]};`).join(' '));
    this.lines.push(`${call(args, names)};`);
    this.usesGlsl = true;
    return types.map((t, i) => ({ t, g: names[i], a: a[i] }));
  }

  // ---------------------------------------------------------------- entrées d'un nœud

  private linkTo(node: NodeData, socket: string): NodeLink | undefined {
    return this.incoming.get(`${node.id}\u0000${socket}`);
  }

  linked(node: NodeData, socket: string): boolean {
    return !!this.linkTo(node, socket);
  }

  output(nodeId: string, socket: string): Val | Closure | null {
    const outs = this.evalNode(nodeId);
    return outs?.[socket] ?? null;
  }

  in(node: NodeData, def: NodeTypeDef, id: string): Val | null {
    const sock = def.inputs.find((s) => s.id === id);
    if (!sock) return null;
    const t = sockType(sock);
    const link = this.linkTo(node, id);
    if (link) {
      const src = this.output(link.fromNode, link.fromSocket);
      if (src && !isClosure(src)) return this.conv(src, t);
      if (src && isClosure(src)) {
        this.notes.add('Un shader branché sur une entrée de valeur vaut 0 (comme dans Blender).');
        return konst(t, t === 'f' ? 0 : [0, 0, 0]);
      }
    }
    if (sock.hideValue) return null;
    return storedValue(sock, node.inputs?.[id]);
  }

  req(node: NodeData, def: NodeTypeDef, id: string, t: T = 'f'): Val {
    const v = this.in(node, def, id);
    return v ? this.conv(v, t) : konst(t, t === 'f' ? 0 : [0, 0, 0]);
  }

  /** Vecteur d'une texture : lien, sinon coordonnées « Générées ». */
  texVec(node: NodeData, def: NodeTypeDef): Val {
    return this.in(node, def, 'Vector') ?? this.builtin('cf_gen', 'v', [0.5, 0.5, 0.5]);
  }

  normalIn(node: NodeData, def: NodeTypeDef, id = 'Normal'): Val {
    const v = this.linked(node, id) ? this.in(node, def, id) : null;
    return v ? this.conv(v, 'v') : this.builtin('cf_N', 'v', [0, 0, 1]);
  }

  optNormal(node: NodeData, def: NodeTypeDef): Val | undefined {
    return this.linked(node, 'Normal') ? this.normalIn(node, def) : undefined;
  }

  closureIn(node: NodeData, id: string): Closure | null {
    const link = this.linkTo(node, id);
    if (!link) return null;
    const src = this.output(link.fromNode, link.fromSocket);
    if (isClosure(src)) return src;
    if (src) {
      const em = this.conv(src, 'c');
      return this.closure({ emission: em }, false);
    }
    return null;
  }

  /** Propriété numérique d'un nœud, modifiable sans recompilation (uniforme). */
  propF(p: Record<string, unknown>, id: string, def: number): Val {
    const n = Number(p[id]);
    return konst('f', Number.isFinite(n) ? n : def, true);
  }

  // ---------------------------------------------------------------- closures

  closure(over: Partial<Record<Ch, Val>>, surface = true, normal?: Val): Closure {
    const ch = {} as Record<Ch, Val>;
    for (const c of CHANNELS) ch[c] = over[c] ?? konst(CH_TYPES[c], PRINCIPLED_DEFAULTS[c]);
    if (!surface && !over.baseColor) ch.baseColor = konst('c', [0, 0, 0]);
    if (!surface && !over.specularLevel) ch.specularLevel = konst('f', 0);
    return { surface, ch, normal };
  }

  emptyClosure(): Closure {
    return this.closure({ baseColor: konst('c', [0, 0, 0]), specularLevel: konst('f', 0), roughness: konst('f', 1) }, false);
  }

  volumeClosure(): Closure {
    this.notes.add('Volume : non rendu (ni en temps réel ni en path tracing).');
    return { ...this.emptyClosure(), volume: true };
  }

  mixVal(a: Val, b: Val, f: Val): Val {
    return this.pure(
      a.t,
      [a, b, f],
      (x: K, y: K, t: number) => (typeof x === 'number' && typeof y === 'number' ? lerp(x, y, t) : map3(v3(x), (p, i) => lerp(p, v3(y)[i], t))),
      (x, y, t) => `mix(${x}, ${y}, ${t})`,
    );
  }

  addVal(a: Val, b: Val): Val {
    return this.pure(a.t, [a, b], (x: K, y: K) => (typeof x === 'number' && typeof y === 'number' ? x + y : map3(v3(x), (p, i) => p + v3(y)[i])), (x, y) => `${x} + ${y}`);
  }

  mulC(c: Val, s: Val): Val {
    return this.pure('c', [c, s], (c2: K, k: number) => map3(v3(c2), (x) => x * k), (c2, k) => `${c2} * ${k}`);
  }

  /** Normale perturbée par une hauteur (Relief). */
  bump(strength: Val, dist: Val, height: Val, N: Val, invert: boolean): Val {
    if (height.k !== undefined) return N;
    this.builtin('cf_wpos', 'v', [0, 0, 0]);
    return { t: 'v', g: this.tmp('v', `cf_bump(${this.g(strength)}, ${this.g(dist)}, ${this.g(height)}, ${this.g(N)}, cf_wpos, ${bool01(invert)})`), a: N.a };
  }

  /** Indice d'unité de texture d'une image (null si trop d'images). */
  imageUnit(id: string): number | null {
    let i = this.images.indexOf(id);
    if (i >= 0) return i;
    if (this.images.length >= MAX_IMAGES) {
      this.notes.add(`Plus de ${MAX_IMAGES} images dans un matériau : les suivantes sont rendues en noir.`);
      return null;
    }
    this.images.push(id);
    return this.images.length - 1;
  }

  /** Courbe → table de 32 valeurs dans cf_u (GLSL) ; null si plus de place. */
  curveLut(cv: CurvePts): { base: number; lo: number; hi: number } | null {
    const lo = cv.x[0];
    const hi = cv.x[cv.x.length - 1];
    const vals: number[] = [];
    for (let i = 0; i < 32; i++) vals.push(evalCurve(cv, lo + ((hi - lo) * i) / 31));
    const base = this.table(vals);
    return base < 0 ? null : { base, lo, hi };
  }

  curveVal(cv: CurvePts, x: Val): Val {
    if (x.k !== undefined) return konst('f', evalCurve(cv, x.k as number), true);
    const lut = this.curveLut(cv);
    const a = evalCurve(cv, x.a as number);
    if (!lut) return { t: 'f', g: this.g(x), a };
    return { t: 'f', g: this.tmp('f', `cf_curve_lut(${lut.base}, ${litF(lut.lo)}, ${litF(lut.hi)}, ${this.g(x)})`), a };
  }

  // ---------------------------------------------------------------- nœuds

  evalNode(id: string): Outputs | null {
    const hit = this.memo.get(id);
    if (hit) return hit;
    const node = this.tree.nodes[id];
    if (!node || typeof node !== 'object') return null;
    if (this.visiting.has(id)) {
      this.notes.add('Boucle dans l’arbre de nœuds : le lien qui la ferme est ignoré.');
      return {};
    }
    this.visiting.add(id);
    let out: Outputs;
    try {
      out = this.computeNode(node);
    } finally {
      this.visiting.delete(id);
    }
    this.memo.set(id, out);
    return out;
  }

  private lazy(out: Outputs, name: string, get: () => Val): void {
    let v: Val | null = null;
    Object.defineProperty(out, name, { enumerable: true, get: () => (v ??= get()) });
  }

  private computeNode(node: NodeData): Outputs {
    const def = nodeType('shader', node.type);
    if (!def) {
      this.notes.add(`Nœud inconnu de CoForge ignoré (« ${node.type} »).`);
      return {};
    }
    if (def.layout === 'reroute') {
      const link = this.linkTo(node, 'Input');
      const src = link ? this.output(link.fromNode, link.fromSocket) : null;
      return { Output: src ?? konst('f', 0) };
    }
    if (def.layout) return {};
    if (node.muted) return this.muted(node, def);
    const p = (node.props && typeof node.props === 'object' ? node.props : {}) as Record<string, unknown>;
    const I = (id: string, t?: T) => (t ? this.req(node, def, id, t) : this.req(node, def, id, sockType(def.inputs.find((s) => s.id === id) ?? { id, label: '', type: 'float' })));
    if (def.support === 'none' && def.note) this.notes.add(`${def.label} : ${def.note}`);
    const zf = konst('f', 0);
    const zv = konst('v', [0, 0, 0]);
    const zc = konst('c', [0, 0, 0]);

    switch (node.type) {
      // -------------------------------------------------------------- shaders
      case 'ShaderNodeBsdfPrincipled': {
        const ch: Partial<Record<Ch, Val>> = {
          baseColor: I('Base Color', 'c'),
          metallic: I('Metallic'),
          roughness: I('Roughness'),
          ior: I('IOR'),
          alpha: I('Alpha'),
          diffuseRoughness: I('Diffuse Roughness'),
          subsurface: I('Subsurface Weight'),
          specularLevel: I('Specular IOR Level'),
          specularTint: I('Specular Tint', 'c'),
          anisotropic: I('Anisotropic'),
          transmission: I('Transmission Weight'),
          coat: I('Coat Weight'),
          coatRoughness: I('Coat Roughness'),
          coatIor: I('Coat IOR'),
          coatTint: I('Coat Tint', 'c'),
          sheen: I('Sheen Weight'),
          sheenRoughness: I('Sheen Roughness'),
          sheenTint: I('Sheen Tint', 'c'),
          thinFilmThickness: I('Thin Film Thickness'),
          thinFilmIor: I('Thin Film IOR'),
        };
        ch.emission = this.mulC(I('Emission Color', 'c'), I('Emission Strength'));
        if (this.linked(node, 'Coat Normal')) this.notes.add('Normale du vernis : non rendue séparément (normale principale utilisée).');
        if (this.linked(node, 'Tangent') || (ch.anisotropic!.a as number) > 0) this.notes.add('Anisotropie : non rendue (CoForge n’a pas de tangentes ni d’UV).');
        if ((ch.subsurface!.a as number) > 0) this.notes.add('Sous-surface : non simulée, la surface reste diffuse (couleur de base).');
        const tint = ch.coatTint!.a as V3;
        if ((ch.coat!.a as number) > 0 && (tint[0] < 0.999 || tint[1] < 0.999 || tint[2] < 0.999)) this.notes.add('Teinte du vernis : non rendue.');
        return { BSDF: this.closure(ch, true, this.optNormal(node, def)) };
      }
      case 'ShaderNodeBsdfDiffuse':
        return { BSDF: this.closure({ baseColor: I('Color', 'c'), diffuseRoughness: I('Roughness'), roughness: konst('f', 1), specularLevel: zf }, true, this.optNormal(node, def)) };
      case 'ShaderNodeBsdfGlossy':
        if ((I('Anisotropy').a as number) !== 0) this.notes.add('Anisotropie : non rendue (CoForge n’a pas de tangentes ni d’UV).');
        return { BSDF: this.closure({ baseColor: I('Color', 'c'), metallic: konst('f', 1), roughness: I('Roughness') }, true, this.optNormal(node, def)) };
      case 'ShaderNodeBsdfMetallic': {
        const base = I('Base Color', 'c');
        let color = base;
        if (p.fresnel_type === 'PHYSICAL_CONDUCTOR') {
          // Réflectance à incidence normale d'un conducteur : ((n-1)² + k²) / ((n+1)² + k²).
          color = this.pure('c', [I('IOR', 'v'), I('Extinction', 'v')], (n: K, k: K) => map3(v3(n), (x, i) => ((x - 1) ** 2 + v3(k)[i] ** 2) / ((x + 1) ** 2 + v3(k)[i] ** 2)), (n, k) => `((${n} - 1.0) * (${n} - 1.0) + ${k} * ${k}) / ((${n} + 1.0) * (${n} + 1.0) + ${k} * ${k})`);
        }
        return { BSDF: this.closure({ baseColor: color, metallic: konst('f', 1), roughness: I('Roughness'), thinFilmThickness: I('Thin Film Thickness'), thinFilmIor: I('Thin Film IOR') }, true, this.optNormal(node, def)) };
      }
      case 'ShaderNodeBsdfGlass':
        return {
          BSDF: this.closure(
            { baseColor: I('Color', 'c'), transmission: konst('f', 1), roughness: I('Roughness'), ior: I('IOR'), thinFilmThickness: I('Thin Film Thickness'), thinFilmIor: I('Thin Film IOR') },
            true,
            this.optNormal(node, def),
          ),
        };
      case 'ShaderNodeBsdfRefraction':
        return { BSDF: this.closure({ baseColor: I('Color', 'c'), transmission: konst('f', 1), roughness: I('Roughness'), ior: I('IOR') }, true, this.optNormal(node, def)) };
      case 'ShaderNodeBsdfTranslucent':
        this.notes.add('BSDF translucide : approché par un diffus.');
        return { BSDF: this.closure({ baseColor: I('Color', 'c'), roughness: konst('f', 1), specularLevel: zf }, true, this.optNormal(node, def)) };
      case 'ShaderNodeBsdfTransparent':
        return { BSDF: this.closure({ baseColor: I('Color', 'c'), alpha: zf, specularLevel: zf }) };
      case 'ShaderNodeBsdfSheen':
        return { BSDF: this.closure({ baseColor: zc, sheen: konst('f', 1), sheenTint: I('Color', 'c'), sheenRoughness: I('Roughness'), specularLevel: zf }, true, this.optNormal(node, def)) };
      case 'ShaderNodeSubsurfaceScattering':
        this.notes.add('Sous-surface : non simulée, la surface reste diffuse (couleur de base).');
        return { BSSRDF: this.closure({ baseColor: I('Color', 'c'), subsurface: konst('f', 1) }, true, this.optNormal(node, def)) };
      case 'ShaderNodeBsdfToon':
        this.notes.add('BSDF cartoon : paliers d’éclairage non rendus.');
        return {
          BSDF: this.closure(
            p.component === 'GLOSSY' ? { baseColor: I('Color', 'c'), metallic: konst('f', 1), roughness: I('Size') } : { baseColor: I('Color', 'c'), roughness: konst('f', 1), specularLevel: zf },
            true,
            this.optNormal(node, def),
          ),
        };
      case 'ShaderNodeBsdfHair':
        this.notes.add('Shader de cheveux : rendu comme une surface brillante.');
        return { BSDF: this.closure({ baseColor: I('Color', 'c'), metallic: konst('f', 1), roughness: I('RoughnessU') }) };
      case 'ShaderNodeBsdfHairPrincipled': {
        this.notes.add('Shader de cheveux : rendu comme une surface diffuse-brillante.');
        let col = I('Color', 'c');
        if (p.parametrization === 'MELANIN') {
          col = this.pure('c', [I('Melanin'), I('Melanin Redness'), I('Tint', 'c')], (m: number, r: number, t: K) => map3([0.42, 0.24, 0.14], (x, i) => x * (1 - m) ** 2 * (1 + 0.3 * r * (i === 0 ? 1 : 0)) * v3(t)[i]), (m, r, t) => `vec3(0.42, 0.24, 0.14) * (1.0 - ${m}) * (1.0 - ${m}) * vec3(1.0 + 0.3 * ${r}, 1.0, 1.0) * ${t}`);
        } else if (p.parametrization === 'ABSORPTION') {
          col = this.pure('c', [I('Absorption Coefficient', 'v')], (a: K) => map3(v3(a), (x) => Math.exp(-x)), (a) => `exp(-${a})`);
        }
        return { BSDF: this.closure({ baseColor: col, roughness: I('Roughness'), ior: I('IOR'), coat: I('Coat') }) };
      }
      case 'ShaderNodeEeveeSpecular': {
        const spec = I('Specular', 'c');
        return {
          BSDF: this.closure(
            {
              baseColor: I('Base Color', 'c'),
              roughness: I('Roughness'),
              specularTint: this.pure('c', [spec], (s: K) => { const m = Math.max(...v3(s), 1e-6); return map3(v3(s), (x) => x / m); }, (s) => `${s} / max(max(${s}.r, max(${s}.g, ${s}.b)), 1e-6)`),
              specularLevel: this.pure('f', [spec], (s: K) => clamp(Math.max(...v3(s)) / 0.08, 0, 1), (s) => `clamp(max(${s}.r, max(${s}.g, ${s}.b)) / 0.08, 0.0, 1.0)`),
              emission: I('Emissive Color', 'c'),
              alpha: this.pure('f', [I('Transparency')], (t: number) => 1 - t, (t) => `1.0 - ${t}`),
              coat: I('Clear Coat'),
              coatRoughness: I('Clear Coat Roughness'),
            },
            true,
            this.optNormal(node, def),
          ),
        };
      }
      case 'ShaderNodeHoldout':
        return { Holdout: this.closure({ baseColor: zc, alpha: zf, specularLevel: zf }) };
      case 'ShaderNodeBsdfRayPortal':
        return { BSDF: this.closure({ baseColor: zc, alpha: zf, specularLevel: zf }) };
      case 'ShaderNodeVolumePrincipled':
      case 'ShaderNodeVolumeAbsorption':
      case 'ShaderNodeVolumeScatter':
        return { Volume: this.volumeClosure() };
      case 'ShaderNodeEmission':
        return { Emission: this.closure({ emission: this.mulC(I('Color', 'c'), I('Strength')) }, false) };
      case 'ShaderNodeMixShader': {
        const fac = this.pure('f', [I('Fac')], (x: number) => clamp(x, 0, 1), (x) => `clamp(${x}, 0.0, 1.0)`);
        const a = this.closureIn(node, 'Shader') ?? this.emptyClosure();
        const b = this.closureIn(node, 'Shader_001') ?? this.emptyClosure();
        if (fac.k === 0 && !fac.u) return { Shader: a };
        if (fac.k === 1 && !fac.u) return { Shader: b };
        const ch = {} as Record<Ch, Val>;
        for (const c2 of CHANNELS) ch[c2] = this.mixVal(a.ch[c2], b.ch[c2], fac);
        let normal = a.normal ?? b.normal;
        if (a.normal && b.normal) normal = this.pure('v', [a.normal, b.normal, fac], () => [0, 0, 1], (x, y, t) => `normalize(mix(${x}, ${y}, ${t}))`);
        return { Shader: { surface: a.surface || b.surface, ch, normal } };
      }
      case 'ShaderNodeAddShader': {
        const a = this.closureIn(node, 'Shader') ?? this.emptyClosure();
        const b = this.closureIn(node, 'Shader_001') ?? this.emptyClosure();
        if (!a.surface && !b.surface) return { Shader: { ...a, ch: { ...a.ch, emission: this.addVal(a.ch.emission, b.ch.emission) } } };
        if (!a.surface || !b.surface) {
          const surf = a.surface ? a : b;
          return { Shader: { ...surf, ch: { ...surf.ch, emission: this.addVal(a.ch.emission, b.ch.emission) } } };
        }
        this.notes.add('Ajouter les shaders entre deux BSDF : paramètres moyennés (approché).');
        const half = konst('f', 0.5);
        const ch = {} as Record<Ch, Val>;
        for (const c2 of CHANNELS) ch[c2] = this.mixVal(a.ch[c2], b.ch[c2], half);
        ch.baseColor = this.addVal(a.ch.baseColor, b.ch.baseColor);
        ch.emission = this.addVal(a.ch.emission, b.ch.emission);
        return { Shader: { surface: true, ch, normal: a.normal ?? b.normal } };
      }

      // -------------------------------------------------------------- entrées
      case 'ShaderNodeRGB':
        return { Color: konst('c', hexToLinear(p.color, [0.5, 0.5, 0.5]), true) };
      case 'ShaderNodeValue':
        return { Value: this.propF(p, 'value', 0) };
      case 'ShaderNodeTexCoord':
      case 'ShaderNodeUVMap': {
        const out: Outputs = {};
        const defs: [string, string, K][] = [
          ['Generated', 'cf_gen', [0.5, 0.5, 0.5]],
          ['Normal', 'cf_onrm', [0, 0, 1]],
          ['UV', 'cf_gen', [0.5, 0.5, 0.5]],
          ['Object', 'cf_opos', [0, 0, 0]],
          ['Camera', 'cf_cam', [0, 0, -5]],
          ['Window', 'cf_win', [0.5, 0.5, 0]],
          ['Reflection', 'cf_refl', [0, 0, 1]],
        ];
        for (const [o, name, approx] of defs) this.lazy(out, o, () => this.builtin(name, 'v', approx));
        if (node.type === 'ShaderNodeUVMap' || this.tree.links.some((l) => l && l.fromNode === node.id && l.fromSocket === 'UV')) this.notes.add('Coordonnées UV : CoForge n’a pas d’UV, les coordonnées « Générées » les remplacent.');
        return out;
      }
      case 'ShaderNodeNewGeometry': {
        const out: Outputs = {};
        const defs: [string, string, T, K][] = [
          ['Position', 'cf_wpos', 'v', [0, 0, 0]],
          ['Normal', 'cf_N', 'v', [0, 0, 1]],
          ['Tangent', 'cf_tangent', 'v', [1, 0, 0]],
          ['True Normal', 'cf_trueN', 'v', [0, 0, 1]],
          ['Incoming', 'cf_I', 'v', [0, 0, 1]],
          ['Backfacing', 'cf_back', 'f', 0],
        ];
        for (const [o, name, t, approx] of defs) this.lazy(out, o, () => this.builtin(name, t, approx));
        out.Parametric = zv;
        out.Pointiness = konst('f', 0.5);
        out['Random Per Island'] = zf;
        return out;
      }
      case 'ShaderNodeTangent': {
        const axis = enumIndex(['X', 'Y', 'Z'], p.axis, 2);
        if (p.direction_type === 'UV_MAP') this.notes.add('Tangente « Carte UV » : pas d’UV, tangente radiale utilisée.');
        if (this.cpu) return { Tangent: this.builtin('cf_tangent', 'v', [1, 0, 0]) };
        this.builtin('cf_gen', 'v', [0.5, 0.5, 0.5]);
        this.builtin('cf_N', 'v', [0, 0, 1]);
        const t = axis === 0 ? 'vec3(0.0, -(cf_gen.z - 0.5), cf_gen.y - 0.5)' : axis === 1 ? 'vec3(-(cf_gen.z - 0.5), 0.0, cf_gen.x - 0.5)' : 'vec3(-(cf_gen.y - 0.5), cf_gen.x - 0.5, 0.0)';
        return { Tangent: { t: 'v', g: this.tmp('v', `cf_orthotangent(${t}, cf_N)`), a: [1, 0, 0] } };
      }
      case 'ShaderNodeObjectInfo': {
        const out: Outputs = { Color: konst('c', [1, 1, 1]), Alpha: konst('f', 1), 'Object Index': zf, 'Material Index': zf };
        this.lazy(out, 'Location', () => this.builtin('cf_oloc', 'v', [0, 0, 0]));
        this.lazy(out, 'Random', () => this.builtin('cf_orand', 'f', 0.5));
        return out;
      }
      case 'ShaderNodeCameraData': {
        const out: Outputs = {};
        this.lazy(out, 'View Vector', () => {
          const c = this.builtin('cf_cam', 'v', [0, 0, -5]);
          return this.pure('v', [c], (k: K) => { const l = len(v3(k)) || 1; return map3(v3(k), (x) => x / l); }, (x) => `normalize(${x})`);
        });
        this.lazy(out, 'View Z Depth', () => this.pure('f', [this.builtin('cf_cam', 'v', [0, 0, -5])], (k: K) => -v3(k)[2], (x) => `-(${x}).z`));
        this.lazy(out, 'View Distance', () => this.pure('f', [this.builtin('cf_cam', 'v', [0, 0, -5])], (k: K) => len(v3(k)), (x) => `length(${x})`));
        return out;
      }
      case 'ShaderNodeLightPath': {
        const out: Outputs = {};
        for (const o of def.outputs) out[o.id] = konst('f', o.id === 'Is Camera Ray' ? 1 : 0);
        this.lazy(out, 'Ray Length', () => this.pure('f', [this.builtin('cf_cam', 'v', [0, 0, -5])], (k: K) => len(v3(k)), (x) => `length(${x})`));
        this.notes.add('Chemin lumineux : valeurs d’un rayon de caméra (pas de rebonds en temps réel).');
        return out;
      }
      case 'ShaderNodeFresnel': {
        const ior = I('IOR');
        const N = this.normalIn(node, def);
        const Iv = this.builtin('cf_I', 'v', [0, 0, 1]);
        const back = this.builtin('cf_back', 'f', 0);
        const [fac] = this.fn(['f'], [ior, N, Iv, back], (r: number, n: K, i: K, b: number) => [fresnelDielectricCos(dot(v3(i), v3(n)), b > 0.5 ? 1 / Math.max(r, 1e-5) : Math.max(r, 1e-5))], (a, [o]) => `${o} = cf_fresnel(${a[0]}, ${a[1]}, ${a[2]}, ${a[3]} > 0.5)`);
        return { Fac: fac };
      }
      case 'ShaderNodeLayerWeight': {
        const N = this.normalIn(node, def);
        const Iv = this.builtin('cf_I', 'v', [0, 0, 1]);
        const back = this.builtin('cf_back', 'f', 0);
        const [fr, fa] = this.fn(['f', 'f'], [I('Blend'), N, Iv, back], (b: number, n: K, i: K, bk: number) => layerWeight(b, dot(v3(i), v3(n)), bk > 0.5), (a, [x, y]) => `cf_layer_weight(${a[0]}, ${a[1]}, ${a[2]}, ${a[3]} > 0.5, ${x}, ${y})`);
        return { Fresnel: fr, Facing: fa };
      }
      case 'ShaderNodeAmbientOcclusion':
        return { Color: I('Color', 'c'), AO: konst('f', 1) };
      case 'ShaderNodeBevel':
        return { Normal: this.normalIn(node, def) };
      case 'ShaderNodeAttribute':
        return { Color: zc, Vector: zv, Fac: zf, Alpha: zf };
      case 'ShaderNodeVertexColor':
        return { Color: zc, Alpha: zf };
      case 'ShaderNodeWireframe':
        return { Fac: zf };
      case 'ShaderNodeHairInfo':
      case 'ShaderNodeParticleInfo':
      case 'ShaderNodePointInfo':
      case 'ShaderNodeVolumeInfo':
      case 'ShaderNodeTexPointDensity':
      case 'ShaderNodeVectorDisplacement': {
        const out: Outputs = {};
        for (const o of def.outputs) out[o.id] = konst(sockType(o), sockType(o) === 'f' ? 0 : [0, 0, 0]);
        return out;
      }

      // -------------------------------------------------------------- textures
      case 'ShaderNodeTexNoise': {
        const dims = String(p.noise_dimensions ?? '3D');
        let co = this.texVec(node, def);
        const w = I('W');
        if (dims === '1D') co = this.pure('v', [w], (x: number) => [x, 0, 0], (x) => `vec3(${x}, 0.0, 0.0)`);
        else if (dims === '2D') co = this.pure('v', [co], (k: K) => [v3(k)[0], v3(k)[1], 0], (x) => `vec3((${x}).xy, 0.0)`);
        const wv = dims === '4D' ? w : zf;
        if (dims !== '3D') this.notes.add('Texture de bruit 1D, 2D ou 4D : calculée en 3D (aspect proche de Blender, pas identique).');
        const type = enumIndex(['MULTIFRACTAL', 'RIDGED_MULTIFRACTAL', 'HYBRID_MULTIFRACTAL', 'FBM', 'HETERO_TERRAIN'], p.noise_type ?? 'FBM', 3);
        const norm = p.normalize !== false;
        const [fac, col] = this.fn(
          ['f', 'c'],
          [co, wv, I('Scale'), I('Detail'), I('Roughness'), I('Lacunarity'), I('Offset'), I('Gain'), I('Distortion')],
          (c2: K, w2: number, s: number, d: number, r: number, l: number, o: number, g: number, dist: number) => texNoise(v3(c2), w2, s, d, r, l, o, g, dist, type, norm),
          (a, [x, y]) => `cf_tex_noise2(${a.join(', ')}, ${type}, ${bool01(norm)}, ${x}, ${y})`,
        );
        return { Fac: fac, Color: col };
      }
      case 'ShaderNodeTexVoronoi': {
        const dims = String(p.voronoi_dimensions ?? '3D');
        let co = this.texVec(node, def);
        const w = I('W');
        if (dims === '1D') co = this.pure('v', [w], (x: number) => [x, 0, 0], (x) => `vec3(${x}, 0.0, 0.0)`);
        else if (dims === '2D') co = this.pure('v', [co], (k: K) => [v3(k)[0], v3(k)[1], 0], (x) => `vec3((${x}).xy, 0.0)`);
        else if (dims === '4D') co = this.pure('v', [co, w], (k: K, x: number) => [v3(k)[0], v3(k)[1], v3(k)[2] + x * 0.618], (k, x) => `(${k} + vec3(0.0, 0.0, ${x} * 0.618))`);
        if (dims !== '3D') this.notes.add('Texture de Voronoï 1D, 2D ou 4D : calculée en 3D (aspect proche de Blender, pas identique).');
        const feature = enumIndex(['F1', 'F2', 'SMOOTH_F1', 'DISTANCE_TO_EDGE', 'N_SPHERE_RADIUS'], p.feature);
        const metric = enumIndex(['EUCLIDEAN', 'MANHATTAN', 'CHEBYCHEV', 'MINKOWSKI'], p.distance);
        const norm = p.normalize === true;
        const [d, col, pos, rad] = this.fn(
          ['f', 'c', 'v', 'f'],
          [co, I('Scale'), I('Detail'), I('Roughness'), I('Lacunarity'), I('Smoothness'), I('Exponent'), I('Randomness')],
          (c2: K, s: number, de: number, r: number, l: number, sm: number, e: number, rnd: number) => texVoronoi(v3(c2), s, de, r, l, sm, e, rnd, feature, metric, norm),
          (a, [x, y, z, r]) => `cf_tex_voronoi2(${a.join(', ')}, ${feature}, ${metric}, ${bool01(norm)}, ${x}, ${y}, ${z}, ${r})`,
        );
        const wOut = this.pure('f', [pos], (k: K) => v3(k)[dims === '1D' ? 0 : 2], (x) => `(${x}).${dims === '1D' ? 'x' : 'z'}`);
        return { Distance: d, Color: col, Position: pos, W: wOut, Radius: rad };
      }
      case 'ShaderNodeTexChecker': {
        const [col, fac] = this.fn(['c', 'f'], [this.texVec(node, def), I('Color1', 'c'), I('Color2', 'c'), I('Scale')], (co: K, a: K, b: K, s: number) => texChecker(v3(co), v3(a), v3(b), s), (a, [x, y]) => `cf_tex_checker(${a.join(', ')}, ${x}, ${y})`);
        return { Color: col, Fac: fac };
      }
      case 'ShaderNodeTexBrick': {
        const off = Number(p.offset ?? 0.5);
        const offF = Math.round(Number(p.offset_frequency ?? 2)) | 0;
        const sq = Number(p.squash ?? 1);
        const sqF = Math.round(Number(p.squash_frequency ?? 2)) | 0;
        const [col, fac] = this.fn(
          ['c', 'f'],
          [this.texVec(node, def), I('Color1', 'c'), I('Color2', 'c'), I('Mortar', 'c'), I('Scale'), I('Mortar Size'), I('Mortar Smooth'), I('Bias'), I('Brick Width'), I('Row Height'), this.propF(p, 'offset', 0.5), this.propF(p, 'squash', 1)],
          (co: K, c1: K, c2: K, m: K, s: number, ms: number, msm: number, bias: number, bw: number, rh: number, o: number, sqa: number) => texBrick(v3(co), v3(c1), v3(c2), v3(m), s, ms, msm, bias, bw, rh, o, offF, sqa, sqF),
          (a, [x, y]) => `cf_tex_brick(${a.slice(0, 10).join(', ')}, ${a[10]}, ${offF}, ${a[11]}, ${sqF}, ${x}, ${y})`,
        );
        void off;
        void sq;
        return { Color: col, Fac: fac };
      }
      case 'ShaderNodeTexGradient': {
        const type = enumIndex(['LINEAR', 'QUADRATIC', 'EASING', 'DIAGONAL', 'SPHERICAL', 'QUADRATIC_SPHERE', 'RADIAL'], p.gradient_type);
        const [fac] = this.fn(['f'], [this.texVec(node, def)], (co: K) => [texGradient(v3(co), type)], (a, [x]) => `${x} = cf_tex_gradient(${a[0]}, ${type})`);
        return { Fac: fac, Color: this.conv(fac, 'c') };
      }
      case 'ShaderNodeTexWave': {
        const wtype = p.wave_type === 'RINGS' ? 1 : 0;
        const bdir = enumIndex(['X', 'Y', 'Z', 'DIAGONAL'], p.bands_direction);
        const rdir = enumIndex(['X', 'Y', 'Z', 'SPHERICAL'], p.rings_direction);
        const profile = enumIndex(['SIN', 'SAW', 'TRI'], p.wave_profile);
        const [fac] = this.fn(
          ['f'],
          [this.texVec(node, def), I('Scale'), I('Distortion'), I('Detail'), I('Detail Scale'), I('Detail Roughness'), I('Phase Offset')],
          (co: K, ...r: number[]) => [texWave(v3(co), r[0], r[1], r[2], r[3], r[4], r[5], wtype, bdir, rdir, profile)],
          (a, [x]) => `${x} = cf_tex_wave(${a.join(', ')}, ${wtype}, ${bdir}, ${rdir}, ${profile})`,
        );
        return { Fac: fac, Color: this.conv(fac, 'c') };
      }
      case 'ShaderNodeTexMagic': {
        const depth = clamp(Math.round(Number(p.turbulence_depth ?? 2)), 0, 10);
        const [col] = this.fn(['c'], [this.texVec(node, def), I('Scale'), I('Distortion')], (co: K, s: number, d: number) => [texMagic(v3(co), s, d, depth)], (a, [x]) => `${x} = cf_tex_magic(${a.join(', ')}, ${depth})`);
        return { Color: col, Fac: this.pure('f', [col], (k: K) => (v3(k)[0] + v3(k)[1] + v3(k)[2]) / 3, (x) => `((${x}).x + (${x}).y + (${x}).z) / 3.0`) };
      }
      case 'ShaderNodeTexWhiteNoise': {
        const dims = String(p.noise_dimensions ?? '3D');
        const co = this.texVec(node, def);
        const w = I('W');
        const key = this.pure(
          'v',
          [co, w],
          (k: K, x: number) => (dims === '1D' ? [x, 0, 0] : dims === '2D' ? [v3(k)[0], v3(k)[1], 0] : dims === '4D' ? map3(v3(k), (y) => y + x * 0.618) : v3(k)),
          (k, x) => (dims === '1D' ? `vec3(${x}, 0.0, 0.0)` : dims === '2D' ? `vec3((${k}).xy, 0.0)` : dims === '4D' ? `(${k} + vec3(${x} * 0.618))` : k),
        );
        const [val, col] = this.fn(['f', 'c'], [key], (k: K) => [hashVec3(v3(k).map(Math.fround) as V3), hashVec3ToVec3(v3(k).map(Math.fround) as V3)], (a, [x, y]) => `${x} = cf_hash_vec3_to_float(${a[0]}); ${y} = cf_hash_vec3_to_vec3(${a[0]})`);
        return { Value: val, Color: col };
      }
      case 'ShaderNodeTexGabor': {
        const is3d = p.gabor_type === '3D';
        const [val, ph, inten] = this.fn(
          ['f', 'f', 'f'],
          [this.texVec(node, def), I('Scale'), I('Frequency'), I('Anisotropy'), I('Orientation 2D'), I('Orientation 3D', 'v')],
          (co: K, s: number, fq: number, an: number, o2: number, o3: K) => texGabor(v3(co), s, fq, an, o2, v3(o3), is3d),
          (a, [x, y, z]) => `cf_tex_gabor(${a.join(', ')}, ${bool01(is3d)}, ${x}, ${y}, ${z})`,
        );
        return { Value: val, Phase: ph, Intensity: inten };
      }
      case 'ShaderNodeTexImage':
      case 'ShaderNodeTexEnvironment':
        return this.imageNode(node, def, p);
      case 'ShaderNodeTexSky': {
        const vec = this.in(node, def, 'Vector') ?? this.pure('v', [this.builtin('cf_I', 'v', [0, 0, 1])], (k: K) => map3(v3(k), (x) => -x), (x) => `-${x}`);
        const deg = Math.PI / 180;
        const elev = konst('f', Number(p.sun_elevation ?? 15) * deg, true);
        const rot = konst('f', Number(p.sun_rotation ?? 0) * deg, true);
        const size = konst('f', Number(p.sun_size ?? 0.545) * deg, true);
        const inten = this.propF(p, 'sun_intensity', 1);
        const disc = p.sun_disc !== false;
        const [col] = this.fn(['c'], [vec, elev, rot, size, inten], (d: K, e: number, r: number, s: number, i: number) => [skyColor(v3(d), e, r, disc, s, i)], (a, [x]) => `${x} = cf_sky(${a[0]}, ${a[1]}, ${a[2]}, ${bool01(disc)}, ${a[3]}, ${a[4]})`);
        return { Color: col };
      }
      case 'ShaderNodeTexIES':
        return { Fac: I('Strength') };

      // -------------------------------------------------------------- couleur
      case 'ShaderNodeMix': {
        const type = String(p.data_type ?? 'RGBA');
        let f2 = I('Factor_Float');
        if (type === 'VECTOR' && p.factor_mode === 'NON_UNIFORM') {
          let fv = I('Factor_Vector', 'v');
          if (p.clamp_factor !== false) fv = this.pure('v', [fv], (x: K) => map3(v3(x), (y) => clamp(y, 0, 1)), (x) => `clamp(${x}, 0.0, 1.0)`);
          return { Result_Vector: this.pure('v', [I('A_Vector', 'v'), I('B_Vector', 'v'), fv], (a: K, b: K, t: K) => map3(v3(a), (x, i) => lerp(x, v3(b)[i], v3(t)[i])), (a, b, t) => `mix(${a}, ${b}, ${t})`) };
        }
        if (p.clamp_factor !== false) f2 = this.pure('f', [f2], (x: number) => clamp(x, 0, 1), (x) => `clamp(${x}, 0.0, 1.0)`);
        if (type === 'FLOAT') return { Result_Float: this.mixVal(I('A_Float'), I('B_Float'), f2) };
        if (type === 'VECTOR') return { Result_Vector: this.mixVal(I('A_Vector', 'v'), I('B_Vector', 'v'), f2) };
        const mode = Math.max(0, BLEND_TYPES.findIndex(([id]) => id === String(p.blend_type ?? 'MIX')));
        let r = this.pure('c', [f2, I('A_Color', 'c'), I('B_Color', 'c')], (t: number, a: K, b: K) => blendJs(mode, t, v3(a), v3(b)), (t, a, b) => `cf_blend(${mode}, ${t}, ${a}, ${b})`);
        if (p.clamp_result) r = this.pure('c', [r], (x: K) => map3(v3(x), (y) => clamp(y, 0, 1)), (x) => `clamp(${x}, 0.0, 1.0)`);
        return { Result_Color: r };
      }
      case 'ShaderNodeInvert':
        return { Color: this.pure('c', [I('Fac'), I('Color', 'c')], (f3: number, c2: K) => map3(v3(c2), (x) => lerp(x, 1 - x, f3)), (f3, c2) => `mix(${c2}, vec3(1.0) - ${c2}, ${f3})`) };
      case 'ShaderNodeHueSaturation':
        return {
          Color: this.pure(
            'c',
            [I('Hue'), I('Saturation'), I('Value'), I('Fac'), I('Color', 'c')],
            (h: number, s: number, val: number, f3: number, c2: K) => {
              const hsv = rgbToHsv(v3(c2));
              const r = hsvToRgb([fract(hsv[0] + h + 0.5), clamp(hsv[1] * s, 0, 1), hsv[2] * val]);
              return map3(v3(c2), (x, i) => Math.max(lerp(x, r[i], f3), 0));
            },
            (h, s, val, f3, c2) => `cf_hue_sat(${h}, ${s}, ${val}, ${f3}, ${c2})`,
          ),
        };
      case 'ShaderNodeBrightContrast':
        return {
          Color: this.pure('c', [I('Color', 'c'), I('Bright'), I('Contrast')], (c2: K, b: number, ct: number) => map3(v3(c2), (x) => Math.max((1 + ct) * x + (b - ct * 0.5), 0)), (c2, b, ct) => `max((1.0 + ${ct}) * ${c2} + vec3(${b} - ${ct} * 0.5), vec3(0.0))`),
        };
      case 'ShaderNodeGamma':
        return {
          Color: this.pure('c', [I('Color', 'c'), I('Gamma')], (c2: K, gm: number) => map3(v3(c2), (x) => (x > 0 ? Math.pow(x, gm) : x)), (c2, gm) => `mix(${c2}, pow(max(${c2}, vec3(1e-8)), vec3(${gm})), vec3(greaterThan(${c2}, vec3(0.0))))`),
        };
      case 'ShaderNodeLightFalloff': {
        const rl = this.pure('f', [this.builtin('cf_cam', 'v', [0, 0, -5])], (k: K) => len(v3(k)), (x) => `length(${x})`);
        const strength = this.pure('f', [I('Strength'), I('Smooth'), rl], (s: number, sm: number, r: number) => (sm > 0 ? (s * r * r) / (sm + r * r) : s), (s, sm, r) => `(${sm} > 0.0 ? ${s} * ${r} * ${r} / (${sm} + ${r} * ${r}) : ${s})`);
        return {
          Quadratic: strength,
          Linear: this.pure('f', [strength, rl], (s: number, r: number) => s * r, (s, r) => `${s} * ${r}`),
          Constant: this.pure('f', [strength, rl], (s: number, r: number) => s * r * r, (s, r) => `${s} * ${r} * ${r}`),
        };
      }
      case 'ShaderNodeRGBCurve': {
        const cv = curvesOf(p.mapping, 4, 0, 1);
        const col = I('Color', 'c');
        const ch = [0, 1, 2].map((i) => this.curveVal(cv[i + 1], this.curveVal(cv[0], this.pure('f', [col], (k: K) => v3(k)[i], (x) => `(${x})[${i}]`))));
        const res = this.pure('c', ch, (r: number, g2: number, b: number) => [r, g2, b], (r, g2, b) => `vec3(${r}, ${g2}, ${b})`);
        return { Color: this.mixVal(col, res, I('Fac')) };
      }

      // -------------------------------------------------------------- vecteur
      case 'ShaderNodeMapping': {
        const type = String(p.vector_type ?? 'POINT');
        const vec = this.in(node, def, 'Vector') ?? zv;
        const glslFor: Record<string, (v: string, l: string, r: string, s: string) => string> = {
          POINT: (v, l, r, s) => `cf_euler_to_mat3(${r}) * (${v} * ${s}) + ${l}`,
          TEXTURE: (v, l, r, s) => `cf_safe_div3(transpose(cf_euler_to_mat3(${r})) * (${v} - ${l}), ${s})`,
          VECTOR: (v, _l, r, s) => `cf_euler_to_mat3(${r}) * (${v} * ${s})`,
          NORMAL: (v, _l, r, s) => `normalize(cf_euler_to_mat3(${r}) * cf_safe_div3(${v}, ${s}))`,
        };
        const gl = glslFor[type] ?? glslFor.POINT;
        return { Vector: this.pure('v', [this.conv(vec, 'v'), I('Location', 'v'), I('Rotation', 'v'), I('Scale', 'v')], (v: K, l: K, r: K, s: K) => mappingJs(type, v3(v), v3(l), v3(r), v3(s)), gl) };
      }
      case 'ShaderNodeBump': {
        const height = this.linked(node, 'Height') ? this.req(node, def, 'Height') : null;
        const N = this.normalIn(node, def);
        if (!height) return { Normal: N };
        return { Normal: this.bump(I('Strength'), I('Distance'), height, N, !!p.invert) };
      }
      case 'ShaderNodeDisplacement': {
        // Vecteur de déplacement = (hauteur − niveau moyen) × échelle × normale. Le relief qui en
        // découle est calculé par la sortie du matériau.
        const N = this.normalIn(node, def);
        const h = this.pure('f', [I('Height'), I('Midlevel'), I('Scale')], (hh: number, m: number, s: number) => (hh - m) * s, (hh, m, s) => `(${hh} - ${m}) * ${s}`);
        return { Displacement: this.pure('v', [N, h], (n: K, x: number) => map3(v3(n), (y) => y * x), (n, x) => `${n} * ${x}`) };
      }
      case 'ShaderNodeNormal': {
        const n = I('Normal', 'v');
        const nl = this.pure('v', [n], (k: K) => { const l = len(v3(k)) || 1; return map3(v3(k), (x) => x / l); }, (x) => `normalize(${x})`);
        const stored = this.pure('v', [storedValue(def.inputs[0], node.inputs?.Normal)], (k: K) => { const l = len(v3(k)) || 1; return map3(v3(k), (x) => x / l); }, (x) => `normalize(${x})`);
        return { Normal: stored, Dot: this.pure('f', [nl, stored], (a: K, b: K) => -dot(v3(a), v3(b)), (a, b) => `-dot(${a}, ${b})`) };
      }
      case 'ShaderNodeNormalMap': {
        const space = String(p.space ?? 'TANGENT');
        const strength = I('Strength');
        const col = I('Color', 'c');
        if (col.k !== undefined) return { Normal: this.builtin('cf_N', 'v', [0, 0, 1]) };
        const N = this.builtin('cf_N', 'v', [0, 0, 1]);
        if (space === 'TANGENT') {
          this.builtin('cf_wpos', 'v', [0, 0, 0]);
          this.builtin('cf_gen', 'v', [0.5, 0.5, 0.5]);
          this.notes.add('Carte de normales en espace tangent : repère tangent déduit des coordonnées générées (pas d’UV).');
          return { Normal: { t: 'v', g: this.tmp('v', `cf_normal_map_tangent(${this.g(col)}, ${this.g(strength)}, ${this.g(N)}, cf_wpos, cf_gen)`), a: N.a } };
        }
        const blender = space.startsWith('BLENDER_');
        const raw = `(${this.g(col)} * 2.0 - 1.0)${blender ? ' * vec3(1.0, -1.0, -1.0)' : ''}`;
        const world = space.endsWith('OBJECT') ? `normalize(mat3(cfModel) * ${raw})` : `normalize(${raw})`;
        if (space.endsWith('OBJECT')) this.builtins.add('cfModel');
        return { Normal: { t: 'v', g: this.tmp('v', `cf_normal_strength(${world}, ${this.g(strength)}, ${this.g(N)})`), a: N.a } };
      }
      case 'ShaderNodeVectorCurve': {
        const cv = curvesOf(p.mapping, 3, -1, 1);
        const vec = I('Vector', 'v');
        const ch = [0, 1, 2].map((i) => this.curveVal(cv[i], this.pure('f', [vec], (k: K) => v3(k)[i], (x) => `(${x})[${i}]`)));
        const res = this.pure('v', ch, (x: number, y: number, z: number) => [x, y, z], (x, y, z) => `vec3(${x}, ${y}, ${z})`);
        return { Vector: this.mixVal(vec, res, I('Fac')) };
      }
      case 'ShaderNodeVectorRotate': {
        const type = enumIndex(['AXIS_ANGLE', 'X_AXIS', 'Y_AXIS', 'Z_AXIS', 'EULER_XYZ'], p.rotation_type);
        const inv = !!p.invert;
        const vec = this.in(node, def, 'Vector') ?? zv;
        return {
          Vector: this.pure(
            'v',
            [this.conv(vec, 'v'), I('Center', 'v'), I('Axis', 'v'), I('Angle'), I('Rotation', 'v')],
            (v: K, c2: K, ax: K, an: number, r: K) => vectorRotateJs(v3(v), v3(c2), v3(ax), an, v3(r), type, inv),
            (v, c2, ax, an, r) => `cf_vector_rotate(${v}, ${c2}, ${ax}, ${an}, ${r}, ${type}, ${bool01(inv)})`,
          ),
        };
      }
      case 'ShaderNodeVectorTransform': {
        const vec = I('Vector', 'v');
        const from = String(p.convert_from ?? 'WORLD');
        const to = String(p.convert_to ?? 'OBJECT');
        const type = String(p.vector_type ?? 'VECTOR');
        if (from === to || this.cpu) return { Vector: vec };
        this.builtins.add('cfModel');
        const w = type === 'POINT' ? '1.0' : '0.0';
        const toWorld = from === 'OBJECT' ? `(cfModel * vec4(${'$'}, ${w})).xyz` : from === 'CAMERA' ? `(inverse(viewMatrix) * vec4(${'$'}, ${w})).xyz` : '$';
        const fromWorld = to === 'OBJECT' ? `(inverse(cfModel) * vec4(${'$'}, ${w})).xyz` : to === 'CAMERA' ? `(viewMatrix * vec4(${'$'}, ${w})).xyz` : '$';
        let expr = fromWorld.replace('$', toWorld.replace('$', this.g(vec)));
        if (type === 'NORMAL') expr = `normalize(${expr})`;
        return { Vector: { t: 'v', g: this.tmp('v', expr), a: vec.a } };
      }

      // -------------------------------------------------------------- convertisseurs
      case 'ShaderNodeMath': {
        const op = String(p.operation ?? 'ADD');
        let r = this.pure('f', [I('Value'), I('Value_001'), I('Value_002')], (a: number, b: number, c2: number) => mathJs(op, a, b, c2), (a, b, c2) => mathGlsl(op, a, b, c2));
        if (p.use_clamp) r = this.pure('f', [r], (x: number) => clamp(x, 0, 1), (x) => `clamp(${x}, 0.0, 1.0)`);
        return { Value: r };
      }
      case 'ShaderNodeMapRange': {
        const interp = enumIndex(['LINEAR', 'STEPPED', 'SMOOTHSTEP', 'SMOOTHERSTEP'], p.interpolation_type);
        const doClamp = p.clamp !== false;
        const one = (v: Val, fmin: Val, fmax: Val, tmin: Val, tmax: Val, steps: Val) =>
          this.pure('f', [v, fmin, fmax, tmin, tmax, steps], (...a: number[]) => mapRangeJs(interp, doClamp, a[0], a[1], a[2], a[3], a[4], a[5]), (v2, a, b, c2, d, s) => `cf_map_range(${v2}, ${a}, ${b}, ${c2}, ${d}, ${s}, ${interp}, ${doClamp})`);
        if (p.data_type === 'FLOAT_VECTOR') {
          const ins = ['Vector', 'From_Min_FLOAT3', 'From_Max_FLOAT3', 'To_Min_FLOAT3', 'To_Max_FLOAT3', 'Steps_FLOAT3'].map((id) => I(id, 'v'));
          const comp = (v: Val, i: number) => this.pure('f', [v], (k: K) => v3(k)[i], (x) => `(${x})[${i}]`);
          const r = [0, 1, 2].map((i) => one(...(ins.map((v) => comp(v, i)) as [Val, Val, Val, Val, Val, Val])));
          return { Vector: this.pure('v', r, (x: number, y: number, z: number) => [x, y, z], (x, y, z) => `vec3(${x}, ${y}, ${z})`), Result: zf };
        }
        return { Result: one(I('Value'), I('From Min'), I('From Max'), I('To Min'), I('To Max'), I('Steps')), Vector: zv };
      }
      case 'ShaderNodeClamp': {
        const range = p.clamp_type === 'RANGE';
        return {
          Result: this.pure(
            'f',
            [I('Value'), I('Min'), I('Max')],
            (v: number, lo: number, hi: number) => (range && lo > hi ? clamp(v, hi, lo) : clamp(v, lo, hi)),
            (v, lo, hi) => (range ? `(${lo} > ${hi} ? clamp(${v}, ${hi}, ${lo}) : clamp(${v}, ${lo}, ${hi}))` : `clamp(${v}, ${lo}, ${hi})`),
          ),
        };
      }
      case 'ShaderNodeValToRGB':
        return this.colorRamp(p, I('Fac'));
      case 'ShaderNodeRGBToBW':
        return { Val: this.conv(I('Color', 'c'), 'f') };
      case 'ShaderNodeSeparateColor': {
        const mode = String(p.mode ?? 'RGB');
        const col = I('Color', 'c');
        const conv = mode === 'HSV' ? this.pure('v', [col], (c2: K) => rgbToHsv(v3(c2)), (c2) => `cf_rgb2hsv(${c2})`) : mode === 'HSL' ? this.pure('v', [col], (c2: K) => rgbToHsl(v3(c2)), (c2) => `cf_rgb2hsl(${c2})`) : col;
        const comp = (i: number) => this.pure('f', [conv], (c2: K) => v3(c2)[i], (c2) => `(${c2}).${'xyz'[i]}`);
        return { Red: comp(0), Green: comp(1), Blue: comp(2) };
      }
      case 'ShaderNodeCombineColor': {
        const mode = String(p.mode ?? 'RGB');
        const v = this.pure('c', [I('Red'), I('Green'), I('Blue')], (r: number, g2: number, b: number) => [r, g2, b], (r, g2, b) => `vec3(${r}, ${g2}, ${b})`);
        if (mode === 'HSV') return { Color: this.pure('c', [v], (c2: K) => hsvToRgb(v3(c2)), (c2) => `cf_hsv2rgb(${c2})`) };
        if (mode === 'HSL') return { Color: this.pure('c', [v], (c2: K) => hslToRgb(v3(c2)), (c2) => `cf_hsl2rgb(${c2})`) };
        return { Color: v };
      }
      case 'ShaderNodeSeparateXYZ': {
        const vec = I('Vector', 'v');
        const comp = (i: number) => this.pure('f', [vec], (k: K) => v3(k)[i], (x) => `(${x}).${'xyz'[i]}`);
        return { X: comp(0), Y: comp(1), Z: comp(2) };
      }
      case 'ShaderNodeCombineXYZ':
        return { Vector: this.pure('v', [I('X'), I('Y'), I('Z')], (x: number, y: number, z: number) => [x, y, z], (x, y, z) => `vec3(${x}, ${y}, ${z})`) };
      case 'ShaderNodeFloatCurve': {
        const cv = curvesOf(p.mapping, 1, 0, 1);
        const val = I('Value');
        return { Value: this.mixVal(val, this.curveVal(cv[0], val), I('Factor')) };
      }
      case 'ShaderNodeBlackbody':
        return { Color: this.pure('c', [I('Temperature')], (t: number) => blackbody(t), (t) => `cf_blackbody(${t})`) };
      case 'ShaderNodeWavelength':
        return { Color: this.pure('c', [I('Wavelength')], (w: number) => wavelengthToRgb(w), (w) => `cf_wavelength(${w})`) };
      case 'ShaderNodeShaderToRGB': {
        const cl = this.closureIn(node, 'Shader') ?? this.emptyClosure();
        this.notes.add('Shader vers RVB : couleur de base + émission (l’éclairage n’est pas évalué dans l’arbre).');
        return { Color: this.addVal(cl.ch.baseColor, cl.ch.emission), Alpha: cl.ch.alpha };
      }
      default:
        return {};
    }
  }

  /** Rampe de couleurs : arrêts en uniformes (déplacer un arrêt ne recompile pas). */
  private colorRamp(p: Record<string, unknown>, fac: Val): Outputs {
    const ramp = normalizeRamp(p.color_ramp);
    if (fac.k !== undefined) {
      const [c2, a] = rampJs(ramp, fac.k as number);
      return { Color: konst('c', c2, true), Alpha: konst('f', a, true) };
    }
    const [ac, aa] = rampJs(ramp, fac.a as number);
    const t = this.g(fac);
    const s = ramp.stops;
    const vals: number[] = [];
    for (const st of s) vals.push(st.c[0], st.c[1], st.c[2], st.a);
    const posBase = this.table(s.map((st) => st.p));
    const colBase = this.table(vals);
    const stop = (i: number) => (colBase < 0 ? `vec4(${lit(s[i].c)}, ${litF(s[i].a)})` : `cf_u[${(colBase >> 2) + i}]`);
    const pos = (i: number) => (posBase < 0 ? litF(s[i].p) : `cf_u[${(posBase + i) >> 2}].${'xyzw'[(posBase + i) & 3]}`);
    const name = `cf_t${this.counter++}`;
    const body: string[] = [`vec4 ${name} = ${stop(0)};`];
    for (let i = 1; i < s.length; i++) {
      if (ramp.interp === 'CONSTANT') body.push(`if (${t} >= ${pos(i)}) ${name} = ${stop(i)};`);
      else {
        let f3 = `clamp((${t} - ${pos(i - 1)}) / max(${pos(i)} - ${pos(i - 1)}, 1e-6), 0.0, 1.0)`;
        if (ramp.interp === 'EASE') f3 = `smoothstep(0.0, 1.0, ${f3})`;
        body.push(`if (${t} > ${pos(i - 1)}) ${name} = mix(${stop(i - 1)}, ${stop(i)}, ${f3});`);
      }
    }
    this.lines.push(...body);
    this.usesGlsl = true;
    if (ramp.interp !== 'LINEAR' && ramp.interp !== 'CONSTANT' && ramp.interp !== 'EASE') this.notes.add('Rampe de couleurs B-spline / cardinale : interpolée linéairement.');
    return { Color: { t: 'c', g: `${name}.rgb`, a: ac }, Alpha: { t: 'f', g: `${name}.a`, a: aa } };
  }

  /** Texture image / d'environnement : image du document, projection sans UV. */
  private imageNode(node: NodeData, def: NodeTypeDef, p: Record<string, unknown>): Outputs {
    const env = node.type === 'ShaderNodeTexEnvironment';
    const id = typeof p.image === 'string' && p.image ? p.image : null;
    const avg = imageAverage(id);
    const missing = { Color: konst('c', env ? [0, 0, 0] : [1, 0, 1]), Alpha: konst('f', 1) };
    if (!id) {
      this.notes.add(`${def.label} sans image : ${env ? 'noir' : 'magenta'} (comme Blender).`);
      return missing;
    }
    const avgC: V3 = avg ? [avg[0], avg[1], avg[2]] : [0.5, 0.5, 0.5];
    const avgA = avg ? avg[3] : 1;
    if (this.cpu) return { Color: konst('c', avgC), Alpha: konst('f', avgA) };
    const unit = this.imageUnit(id);
    if (unit === null) return missing;
    const closest = p.interpolation === 'Closest';
    const srgb = p.color_space !== 'Non-Color';
    const name = `cf_t${this.counter++}`;
    if (env) {
      const vec = this.in(node, def, 'Vector') ?? this.pure('v', [this.builtin('cf_refl', 'v', [0, 0, 1])], (k: K) => k, (x) => x);
      const uv = p.projection === 'MIRROR_BALL' ? `cf_mirror_ball(${this.g(vec)})` : `cf_equirect(${this.g(vec)})`;
      this.lines.push(`vec4 ${name} = cf_img_fetch(cf_img${unit}, ${uv}, 0, ${bool01(closest)});`);
    } else {
      const co = this.texVec(node, def);
      const proj = enumIndex(['FLAT', 'BOX', 'SPHERE', 'TUBE'], p.projection ?? 'BOX', 1);
      const ext = enumIndex(['REPEAT', 'EXTEND', 'CLIP', 'MIRROR'], p.extension);
      const blend = this.propF(p, 'projection_blend', 0.2);
      const n = proj === 1 ? this.builtin('cf_onrm', 'v', [0, 0, 1]) : zvConst;
      if (!this.linked(node, 'Vector')) this.notes.add('Texture image : projetée sur les coordonnées générées (CoForge n’a pas d’UV).');
      this.lines.push(`vec4 ${name} = cf_tex_image(cf_img${unit}, ${this.g(co)}, ${this.g(n)}, ${proj}, ${this.g(blend)}, ${ext}, ${bool01(closest)});`);
    }
    this.usesGlsl = true;
    const rgb = srgb ? `cf_srgb2lin(${name}.rgb)` : `${name}.rgb`;
    return { Color: { t: 'c', g: this.tmp('c', rgb), a: avgC }, Alpha: { t: 'f', g: `${name}.a`, a: avgA } };
  }

  /** Nœud muet : chaque sortie reprend la première entrée de même nature (règle de Blender). */
  private muted(node: NodeData, def: NodeTypeDef): Outputs {
    const out: Outputs = {};
    for (const o of def.outputs) {
      if (o.type === 'shader') {
        const sIn = def.inputs.find((i) => i.type === 'shader' && this.linked(node, i.id));
        out[o.id] = (sIn && this.closureIn(node, sIn.id)) ?? this.emptyClosure();
        continue;
      }
      const t = sockType(o);
      const same = def.inputs.find((i) => i.type !== 'shader' && sockType(i) === t && this.linked(node, i.id)) ?? def.inputs.find((i) => i.type !== 'shader' && this.linked(node, i.id));
      out[o.id] = same ? this.req(node, def, same.id, t) : konst(t, t === 'f' ? 0 : [0, 0, 0]);
    }
    return out;
  }
}

const zvConst: Val = konst('v', [0, 0, 0]);

function mapRangeJs(interp: number, doClamp: boolean, v: number, fmin: number, fmax: number, tmin: number, tmax: number, steps: number): number {
  let fac: number;
  if (interp <= 1) {
    fac = safeDiv(v - fmin, fmax - fmin);
    if (interp === 1) fac = steps > 0 ? Math.floor(fac * (steps + 1)) / steps : 0;
    const r = tmin + fac * (tmax - tmin);
    return doClamp ? (tmin > tmax ? clamp(r, tmax, tmin) : clamp(r, tmin, tmax)) : r;
  }
  const sm = interp === 2 ? smoothstep : smootherstep;
  fac = fmin > fmax ? 1 - sm(fmax, fmin, v) : sm(fmin, fmax, v);
  return tmin + fac * (tmax - tmin);
}

function rotateAxis(p: V3, axis: V3, angle: number): V3 {
  const c = Math.cos(angle), s = Math.sin(angle);
  const cr: V3 = [axis[1] * p[2] - axis[2] * p[1], axis[2] * p[0] - axis[0] * p[2], axis[0] * p[1] - axis[1] * p[0]];
  const d = dot(axis, p);
  return map3(p, (x, i) => x * c + cr[i] * s + axis[i] * d * (1 - c));
}

function vectorRotateJs(v: V3, center: V3, axis: V3, angle: number, rot: V3, type: number, invert: boolean): V3 {
  const p = map3(v, (x, i) => x - center[i]);
  if (type === 4) {
    const m = eulerToMat3(rot);
    return map3(invert ? mulMatT(m, p) : mulMat(m, p), (x, i) => x + center[i]);
  }
  const a: V3 = type === 1 ? [1, 0, 0] : type === 2 ? [0, 1, 0] : type === 3 ? [0, 0, 1] : axis;
  const l = len(a);
  if (l === 0) return v;
  return map3(rotateAxis(p, map3(a, (x) => x / l), invert ? -angle : angle), (x, i) => x + center[i]);
}

/** Courbes d'un nœud (n courbes) préparées pour l'évaluation ; défaut : identité sur [lo, hi]. */
function curvesOf(mapping: unknown, n: number, lo: number, hi: number): CurvePts[] {
  const list = mapping && typeof mapping === 'object' && Array.isArray((mapping as { curves?: unknown }).curves) ? ((mapping as { curves: { points?: unknown }[] }).curves) : [];
  return Array.from({ length: n }, (_, i) => prepareCurve(list[i]?.points ?? [{ x: lo, y: lo }, { x: hi, y: hi }]));
}

// ------------------------------------------------------------------ point d'entrée

/** Nœud de sortie actif : le premier « Sortie du matériau » non muet (cible Tous ou EEVEE en priorité). */
export function activeOutput(tree: NodeTreeData): NodeData | null {
  let best: NodeData | null = null;
  let score = -1;
  for (const n of Object.values(tree.nodes ?? {})) {
    if (!n || n.type !== 'ShaderNodeOutputMaterial') continue;
    const target = String(n.props?.target ?? 'ALL');
    const s = (n.muted ? 0 : 4) + (target === 'ALL' ? 2 : target === 'EEVEE' ? 1 : 0) + (n.props?.is_active_output === false ? 0 : 1);
    if (s > score) {
      best = n;
      score = s;
    }
  }
  return best;
}

const cache = new Map<string, CompiledShader>();

/** Vide le cache de compilation (par exemple quand la couleur moyenne d'une image devient connue). */
export function clearShaderCache(): void {
  cache.clear();
}

/**
 * Compile un arbre (mémoïsé par contenu). Le programme GPU dépend de `key` seulement : changer une
 * valeur de socket ou de propriété numérique modifie `uniforms`, pas `key` (pas de recompilation).
 */
export function compileShaderTree(tree: NodeTreeData): CompiledShader {
  const key = JSON.stringify([tree.nodes, tree.links]);
  const hit = cache.get(key);
  if (hit) return hit;
  const result = compileUncached(tree);
  if (cache.size > 256) cache.clear();
  cache.set(key, result);
  return result;
}

interface Evaluated {
  comp: Compiler;
  closure: Closure;
  hasSurface: boolean;
  displacement: Val | null;
}

function evaluate(tree: NodeTreeData, point: SamplePoint | null): Evaluated {
  const comp = new Compiler(tree, point);
  const output = activeOutput(tree);
  let closure: Closure | null = null;
  let displacement: Val | null = null;
  if (output) {
    closure = comp.closureIn(output, 'Surface');
    if (closure?.volume) {
      comp.notes.add('Shader de volume branché sur la surface : rendu noir.');
      closure = null;
    }
    if (comp.linked(output, 'Volume')) comp.notes.add('Volume du matériau : non rendu.');
    if (comp.linked(output, 'Displacement')) {
      const outDef = nodeType('shader', 'ShaderNodeOutputMaterial')!;
      displacement = comp.in(output, outDef, 'Displacement');
      comp.notes.add('Déplacement : rendu en relief seulement (les sommets ne bougent pas), comme « Relief seulement » d’EEVEE.');
    }
  } else {
    comp.notes.add('Aucune « Sortie du matériau » : le matériau est rendu noir.');
  }
  const hasSurface = !!closure;
  return { comp, closure: closure ?? comp.emptyClosure(), hasSurface, displacement };
}

function paramsOf(closure: Closure): ShaderParams {
  const params = {} as ShaderParams;
  for (const c of CHANNELS) {
    const v = closure.ch[c];
    const k = v.k !== undefined ? v.k : v.a;
    (params as any)[c] = CH_TYPES[c] === 'f' ? (typeof k === 'number' ? k : lum(k)) : v3(k);
  }
  for (const c of ['metallic', 'roughness', 'alpha', 'diffuseRoughness', 'subsurface', 'specularLevel', 'transmission', 'coat', 'coatRoughness', 'sheen', 'sheenRoughness', 'anisotropic'] as const) {
    params[c] = clamp(Number.isFinite(params[c]) ? params[c] : PRINCIPLED_DEFAULTS[c], 0, 1);
  }
  params.ior = clamp(Number.isFinite(params.ior) ? params.ior : 1.5, 1, 4);
  for (const c of ['baseColor', 'specularTint', 'coatTint', 'sheenTint', 'emission'] as const) params[c] = params[c].map((x) => (Number.isFinite(x) ? Math.max(0, x) : 0)) as V3;
  return params;
}

function compileUncached(tree: NodeTreeData): CompiledShader {
  const { comp, closure, hasSurface, displacement } = evaluate(tree, null);
  let params = paramsOf(closure);

  const varying: Partial<Record<VaryingChannel, string>> = {};
  const ch = closure.ch;
  const pick = (c: Ch, out: VaryingChannel) => {
    if (ch[c].k === undefined || ch[c].u) varying[out] = comp.g(ch[c]);
  };
  // Un canal constant mais modifiable (uniforme) n'est injecté que si l'arbre a déjà du GLSL : sinon
  // les propriétés du matériau suffisent (aucun programme spécifique).
  let normal = closure.normal;
  if (displacement && displacement.k === undefined) {
    const N = normal ?? comp.builtin('cf_N', 'v', [0, 0, 1]);
    const h = comp.pure('f', [displacement, N], (d: K, n: K) => dot(v3(d), v3(n)), (d, n) => `dot(${d}, ${n})`);
    normal = comp.bump(konst('f', 1), konst('f', 1), h, N, false);
  }
  const anyPixel = CHANNELS.some((c) => ch[c].k === undefined) || (!!normal && normal.k === undefined);
  if (anyPixel) {
    pick('baseColor', 'baseColor');
    pick('alpha', 'alpha');
    pick('metallic', 'metallic');
    pick('roughness', 'roughness');
    pick('emission', 'emission');
    if (normal && normal.k === undefined) varying.normal = comp.g(normal);
    for (const c of ['ior', 'transmission', 'coat', 'coatRoughness', 'sheen', 'sheenRoughness', 'specularLevel', 'specularTint', 'sheenTint', 'thinFilmThickness', 'diffuseRoughness'] as const) {
      if (ch[c].k === undefined) {
        comp.notes.add('Textures sur l’IOR, la transmission, le vernis, le lustre, le spéculaire ou le film mince : valeur moyenne utilisée.');
        break;
      }
    }
    // Valeurs moyennes pour le path tracer et les champs simples : échantillonnage CPU de l'arbre.
    params = sampleParams(tree) ?? params;
  }

  const code = anyPixel ? comp.code() : '';
  const notes = [...comp.notes];
  if (anyPixel) notes.push('Path tracing : les textures sont remplacées par leur valeur moyenne (échantillonnée).');
  const nU = anyPixel ? Math.max(1, comp.uvals.length / 4) : 0;
  return {
    params,
    varying,
    code,
    library: anyPixel ? `${SHADER_GLSL_LIBRARY}\n${SHADER_GLSL_MORE}` : '',
    builtins: anyPixel ? [...comp.builtins] : [],
    notes,
    hasSurface,
    uniforms: anyPixel ? Float32Array.from(comp.uvals.length ? comp.uvals : [0, 0, 0, 0]) : new Float32Array(0),
    uniformVec4: nU,
    images: anyPixel ? [...comp.images] : [],
    key: anyPixel ? `${code}|${Object.entries(varying).join(';')}|${[...comp.builtins].join(',')}|u${nU}|i${comp.images.length}` : 'const',
  };
}

// ------------------------------------------------------------------ évaluation CPU (path tracing, export)

/** Points d'échantillonnage déterministes : coordonnées générées dans [0,1]³, normales et vues variées. */
function samplePoints(n: number): SamplePoint[] {
  const pts: SamplePoint[] = [];
  for (let i = 0; i < n; i++) {
    const r = (k: number) => {
      const x = Math.sin((i + 1) * (12.9898 + k * 78.233)) * 43758.5453;
      return x - Math.floor(x);
    };
    const gen: V3 = [(i + 0.5) / n, r(1), r(2)];
    const z = r(3) * 2 - 1;
    const phi = r(4) * Math.PI * 2;
    const s = Math.sqrt(1 - z * z);
    const N: V3 = [s * Math.cos(phi), s * Math.sin(phi), z];
    // Direction de vue : dans l'hémisphère de la normale, cos θ réparti uniformément.
    const ct = 0.15 + 0.85 * r(5);
    const tAxis: V3 = Math.abs(N[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const tx = (() => {
      const c: V3 = [N[1] * tAxis[2] - N[2] * tAxis[1], N[2] * tAxis[0] - N[0] * tAxis[2], N[0] * tAxis[1] - N[1] * tAxis[0]];
      const l = len(c) || 1;
      return map3(c, (x) => x / l);
    })();
    const st = Math.sqrt(1 - ct * ct);
    const I: V3 = map3(N, (x, k) => x * ct + tx[k] * st);
    const opos = map3(gen, (x) => x * 2 - 1);
    const cam: V3 = [opos[0], opos[1], -5 + opos[2]];
    pts.push({
      cf_gen: gen,
      cf_opos: opos,
      cf_onrm: N,
      cf_wpos: opos,
      cf_N: N,
      cf_trueN: N,
      cf_I: I,
      cf_back: 0,
      cf_cam: cam,
      cf_win: [gen[0], gen[1], 0],
      cf_refl: map3(I, (x, k) => 2 * dot(N, I) * N[k] - x),
      cf_oloc: [0, 0, 0],
      cf_orand: 0.5,
      cf_tangent: [-N[1], N[0], 0],
    });
  }
  return pts;
}

const SAMPLES = 48;
let cachedPoints: SamplePoint[] | null = null;

/** Paramètres moyens de l'arbre sur un jeu de points (null si l'évaluation échoue). */
function sampleParams(tree: NodeTreeData, points?: SamplePoint[]): ShaderParams | null {
  const pts = points ?? (cachedPoints ??= samplePoints(SAMPLES));
  const acc: Record<string, number[]> = {};
  try {
    for (const pt of pts) {
      const { closure } = evaluate(tree, pt);
      const p = paramsOf(closure);
      for (const c of CHANNELS) {
        const v = p[c];
        const arr = Array.isArray(v) ? v : [v];
        const a = (acc[c] ??= new Array(arr.length).fill(0));
        arr.forEach((x, i) => (a[i] += x / pts.length));
      }
    }
  } catch {
    return null;
  }
  const out = {} as ShaderParams;
  for (const c of CHANNELS) (out as any)[c] = CH_TYPES[c] === 'f' ? acc[c][0] : (acc[c] as V3);
  return out;
}

/**
 * Évalue l'arbre en un point (coordonnées générées `gen` dans [0,1]³, normale `normal`) : paramètres
 * Principled en ce point. Sert à cuire des couleurs par sommet et aux tests.
 */
export function evaluateShaderAt(tree: NodeTreeData, gen: V3, normal: V3 = [0, 0, 1], extra: SamplePoint = {}): ShaderParams {
  const opos = map3(gen, (x) => x * 2 - 1);
  const pt: SamplePoint = { cf_gen: gen, cf_opos: opos, cf_onrm: normal, cf_wpos: opos, cf_N: normal, cf_trueN: normal, cf_I: normal, cf_back: 0, cf_cam: [opos[0], opos[1], -5], cf_win: [gen[0], gen[1], 0], cf_refl: normal, cf_oloc: [0, 0, 0], cf_orand: 0.5, cf_tangent: [-normal[1], normal[0], 0], ...extra };
  return paramsOf(evaluate(tree, pt).closure);
}

/**
 * Repli constant du matériau (path tracing, export, mode Solide, champs simples) : valeurs exactes
 * quand l'arbre se réduit à des constantes, sinon MOYENNE d'échantillons des textures procédurales
 * (48 points). Les textures image comptent pour leur couleur moyenne (connue après décodage).
 */
export function evaluateShaderConstants(tree: NodeTreeData): Partial<MaterialData> {
  return paramsToMaterial(compileShaderTree(tree).params);
}

function paramsToMaterial(p: ShaderParams): Omit<MaterialData, 'id' | 'name' | 'nodeTree'> {
  const emission = Math.max(...p.emission);
  return {
    baseColor: linearToHex(p.baseColor),
    metallic: p.metallic,
    roughness: p.roughness,
    emission: emission > 0 ? linearToHex(p.emission.map((x) => x / Math.max(1, emission))) : '#000000',
    emissionStrength: emission > 1 ? emission : emission > 0 ? 1 : 0,
    alpha: p.alpha,
    transmission: p.transmission,
    ior: p.ior,
  };
}

/**
 * Couleur de base par sommet (linéaire, RVBA) d'un arbre, pour le path tracer (qui multiplie la
 * couleur du matériau par la couleur de sommet). `positions` en repère objet, `bbox` = boîte locale.
 * null si la couleur de base ne varie pas (rien à cuire).
 */
export function bakeBaseColor(tree: NodeTreeData, positions: ArrayLike<number>, normals: ArrayLike<number> | null, bboxMin: V3, bboxSize: V3, maxVertices = 200000): Float32Array | null {
  const compiled = compileShaderTree(tree);
  if (!compiled.varying.baseColor) return null;
  const n = Math.floor(positions.length / 3);
  if (n === 0 || n > maxVertices) return null;
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const gen: V3 = [0, 1, 2].map((k) => (bboxSize[k] > 1e-9 ? (positions[i * 3 + k] - bboxMin[k]) / bboxSize[k] : 0.5)) as V3;
    const nrm: V3 = normals ? [normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]] : [0, 0, 1];
    const opos: V3 = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
    const p = evaluateShaderAt(tree, gen, nrm, { cf_opos: opos, cf_onrm: nrm });
    out[i * 4] = p.baseColor[0];
    out[i * 4 + 1] = p.baseColor[1];
    out[i * 4 + 2] = p.baseColor[2];
    out[i * 4 + 3] = 1;
  }
  return out;
}

// ------------------------------------------------------------------ outils pour l'interface et le document

/** Identifiant de nœud ou de lien, unique dans un arbre (voir graph.ts). */
export const nodeId = newId;

/** Arbre initial « Utiliser les nœuds » : Principled BSDF → Sortie, repris des champs simples du matériau. */
export function defaultShaderTree(mat?: Partial<MaterialData>): Pick<NodeTreeData, 'nodes' | 'links'> {
  const bsdf: NodeData = {
    id: nodeId(),
    type: 'ShaderNodeBsdfPrincipled',
    x: -300,
    y: -120,
    inputs: {
      'Base Color': mat?.baseColor ?? '#e7e7e7',
      Metallic: mat?.metallic ?? 0,
      Roughness: mat?.roughness ?? 0.5,
      IOR: mat?.ior ?? 1.5,
      Alpha: mat?.alpha ?? 1,
      'Transmission Weight': mat?.transmission ?? 0,
      'Emission Color': mat?.emission && mat.emission !== '#000000' ? mat.emission : '#ffffff',
      'Emission Strength': mat?.emission && mat.emission !== '#000000' ? (mat.emissionStrength ?? 0) : 0,
    },
    props: { distribution: 'MULTI_GGX', subsurface_method: 'RANDOM_WALK' },
  };
  const out: NodeData = { id: nodeId(), type: 'ShaderNodeOutputMaterial', x: 40, y: -120, inputs: {}, props: { target: 'ALL', is_active_output: true } };
  return {
    nodes: { [bsdf.id]: bsdf, [out.id]: out },
    links: [{ id: nodeId('l'), fromNode: bsdf.id, fromSocket: 'BSDF', toNode: out.id, toSocket: 'Surface' }],
  };
}

/**
 * Champs simples du matériau déduits de l'arbre : repli du path tracer, de l'export glTF, de la
 * vignette de la liste des matériaux et des pairs qui ne savent pas lire les nœuds.
 */
export function materialFallback(tree: NodeTreeData): Omit<MaterialData, 'id' | 'name' | 'nodeTree'> {
  return paramsToMaterial(compileShaderTree(tree).params);
}

export { PRINCIPLED_PANELS };
