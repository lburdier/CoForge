import type { AnimPath, CameraData, LightData, MaterialData, ObjectData } from '../doc/schema';

/**
 * Propriétés animables : où se trouve la valeur dans les données de scène, combien de
 * composantes, comment la lire et l'écrire en nombres (fonctions pures).
 *
 *  - couleurs '#rrggbb' : trois composantes 0..1 (sRGB), recomposées en hexadécimal ;
 *  - focale de caméra : animée en millimètres (comme Blender, `lens`), convertie en champ de
 *    vision vertical (`fov`, référence du document) avec le capteur et le rapport de l'image ;
 *  - visibilité : 0 / 1, interpolation constante, vraie au-dessus de 1 - ε (comme Blender).
 */

export type AnimOwnerKind = 'object' | 'light' | 'camera' | 'material';

export interface AnimPropDef {
  path: AnimPath;
  owner: AnimOwnerKind;
  /** Champ des données de scène (ObjectData.pos, LightData.color…). */
  field: string;
  size: number;
  kind: 'float' | 'bool' | 'color' | 'lens';
  /** Libellé du groupe (canal parent). */
  label: string;
  /** Libellés des composantes. */
  components: string[];
}

export const ANIM_PROPS: readonly AnimPropDef[] = [
  { path: 'location', owner: 'object', field: 'pos', size: 3, kind: 'float', label: 'Position', components: ['X', 'Y', 'Z'] },
  { path: 'rotation_euler', owner: 'object', field: 'rot', size: 3, kind: 'float', label: 'Rotation', components: ['X', 'Y', 'Z'] },
  { path: 'scale', owner: 'object', field: 'scl', size: 3, kind: 'float', label: 'Échelle', components: ['X', 'Y', 'Z'] },
  { path: 'visible', owner: 'object', field: 'visible', size: 1, kind: 'bool', label: 'Visibilité', components: [''] },
  { path: 'light.color', owner: 'light', field: 'color', size: 3, kind: 'color', label: 'Couleur de la lumière', components: ['R', 'V', 'B'] },
  { path: 'light.energy', owner: 'light', field: 'power', size: 1, kind: 'float', label: 'Puissance', components: [''] },
  { path: 'camera.lens', owner: 'camera', field: 'fov', size: 1, kind: 'lens', label: 'Focale', components: [''] },
  { path: 'material.base_color', owner: 'material', field: 'baseColor', size: 3, kind: 'color', label: 'Couleur de base', components: ['R', 'V', 'B'] },
  { path: 'material.metallic', owner: 'material', field: 'metallic', size: 1, kind: 'float', label: 'Métallique', components: [''] },
  { path: 'material.roughness', owner: 'material', field: 'roughness', size: 1, kind: 'float', label: 'Rugosité', components: [''] },
  { path: 'material.alpha', owner: 'material', field: 'alpha', size: 1, kind: 'float', label: 'Opacité', components: [''] },
  { path: 'material.emission_strength', owner: 'material', field: 'emissionStrength', size: 1, kind: 'float', label: "Force d'émission", components: [''] },
];

const BY_PATH = new Map(ANIM_PROPS.map((d) => [d.path, d]));

export function animProp(path: string): AnimPropDef | null {
  return BY_PATH.get(path as AnimPath) ?? null;
}

/** Définitions dont le champ est `field` pour ce type de propriétaire. */
export function animPropByField(owner: AnimOwnerKind, field: string): AnimPropDef | null {
  for (const d of ANIM_PROPS) if (d.owner === owner && d.field === field) return d;
  return null;
}

export function animPropsOf(owner: AnimOwnerKind): AnimPropDef[] {
  return ANIM_PROPS.filter((d) => d.owner === owner);
}

/** Libellé d'un canal : « Position X », « Couleur de base R », « Puissance ». */
export function channelLabel(path: string, index: number): string {
  const d = animProp(path);
  if (!d) return `${path}[${index}]`;
  const c = d.components[index] ?? '';
  return c ? `${d.label} ${c}` : d.label;
}

/** Couleur d'un canal dans les éditeurs (X/R rouge, Y/V vert, Z/B bleu, comme Blender). */
export function channelColor(path: string, index: number): string {
  const d = animProp(path);
  if (d && d.size === 3) return ['#e05a5a', '#6fbf4a', '#4f8fe6'][index] ?? '#cccccc';
  if (d?.kind === 'bool') return '#d9c35c';
  return '#c08be0';
}

/** Ordre d'affichage des propriétés. */
export function propOrder(path: string): number {
  const i = ANIM_PROPS.findIndex((d) => d.path === path);
  return i < 0 ? 999 : i;
}

// ------------------------------------------------------------------ couleurs

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return [1, 1, 1];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(rgb: readonly number[]): string {
  const c = (v: number) =>
    Math.round(Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
}

// ------------------------------------------------------------------ focale ↔ champ de vision

const DEG = Math.PI / 180;

function pos(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

type Sensor = Pick<CameraData, 'sensorFit' | 'sensorWidth' | 'sensorHeight'>;

function fitAxis(cam: Sensor, aspect: number): { size: number; vertical: boolean } {
  const w = pos(cam.sensorWidth, 36);
  const h = pos(cam.sensorHeight, 24);
  if (cam.sensorFit === 'vertical') return { size: h, vertical: true };
  if (cam.sensorFit === 'horizontal') return { size: w, vertical: false };
  return { size: w, vertical: pos(aspect, 1) < 1 };
}

/** Focale (mm) d'une caméra dont `fov` est le champ vertical (même formule que l'onglet Données). */
export function lensFromFov(cam: Sensor & Pick<CameraData, 'fov'>, aspect: number): number {
  const fit = fitAxis(cam, aspect);
  const fov = Math.max(0.01, Math.min(179.9, Number.isFinite(cam.fov) ? cam.fov : 40));
  const axisFov = fit.vertical ? fov : (2 * Math.atan(Math.tan((fov * DEG) / 2) * pos(aspect, 1))) / DEG;
  return fit.size / 2 / Math.tan((axisFov * DEG) / 2);
}

/** Champ vertical (degrés) donnant la focale `mm`. */
export function fovFromLens(mm: number, cam: Sensor, aspect: number): number {
  const fit = fitAxis(cam, aspect);
  const axisFov = (2 * Math.atan(fit.size / 2 / Math.max(0.01, pos(mm, 50)))) / DEG;
  return fit.vertical ? axisFov : (2 * Math.atan(Math.tan((axisFov * DEG) / 2) / pos(aspect, 1))) / DEG;
}

// ------------------------------------------------------------------ lecture / écriture

export type AnimTarget = ObjectData | LightData | CameraData | MaterialData;

/** Composantes numériques actuelles d'une propriété. */
export function readProp(def: AnimPropDef, data: AnimTarget, aspect: number): number[] {
  const v = (data as unknown as Record<string, unknown>)[def.field];
  switch (def.kind) {
    case 'bool':
      return [v ? 1 : 0];
    case 'color':
      return hexToRgb(typeof v === 'string' ? v : '#ffffff');
    case 'lens':
      return [lensFromFov(data as CameraData, aspect)];
    default:
      if (Array.isArray(v)) return v.slice(0, def.size).map((x) => (typeof x === 'number' ? x : 0));
      return [typeof v === 'number' ? v : 0];
  }
}

/** Valeur de champ obtenue en remplaçant certaines composantes (undefined = inchangée). */
export function writeProp(def: AnimPropDef, data: AnimTarget, comps: readonly (number | undefined)[], aspect: number): unknown {
  const cur = readProp(def, data, aspect);
  const next = cur.map((c, i) => (comps[i] === undefined || !Number.isFinite(comps[i]!) ? c : comps[i]!));
  switch (def.kind) {
    case 'bool':
      return next[0] > 1 - 1.1920929e-7;
    case 'color':
      return rgbToHex(next);
    case 'lens':
      return fovFromLens(next[0], data as CameraData, aspect);
    default:
      return def.size === 1 ? next[0] : next;
  }
}

/** Composantes d'une valeur de champ (telle qu'écrite par un patch). */
export function fieldComponents(def: AnimPropDef, value: unknown, data: AnimTarget, aspect: number): number[] {
  switch (def.kind) {
    case 'bool':
      return [value ? 1 : 0];
    case 'color':
      return hexToRgb(typeof value === 'string' ? value : '#ffffff');
    case 'lens':
      return [lensFromFov({ ...(data as CameraData), fov: Number(value) }, aspect)];
    default:
      if (Array.isArray(value)) return value.slice(0, def.size).map((x) => Number(x));
      return [Number(value)];
  }
}
