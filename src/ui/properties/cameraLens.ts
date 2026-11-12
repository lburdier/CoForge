import type { CameraData } from '../../core/doc/schema';

/**
 * Conversions focale ↔ champ de vision et préréglages de capteur (logique pure).
 *
 * Dans le document, `CameraData.fov` est le champ de vision VERTICAL en degrés ; la focale
 * affichée s'en déduit :
 *
 *   focale = (dimension du capteur dans l'axe de cadrage / 2) / tan(champ dans cet axe / 2)
 *
 * Axe de cadrage (`sensorFit`), comme dans Blender :
 *  - 'vertical'   : hauteur du capteur, champ vertical ;
 *  - 'horizontal' : largeur du capteur, champ horizontal ;
 *  - 'auto'       : la LARGEUR du capteur est appliquée à la plus grande dimension de l'image
 *                   (horizontale si l'image est en paysage, verticale si elle est en portrait).
 */

const DEG = Math.PI / 180;

export type LensSensor = Pick<CameraData, 'sensorFit' | 'sensorWidth' | 'sensorHeight'>;

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Dimension du capteur (mm) qui sert de référence et axe correspondant. */
export function sensorFitAxis(cam: LensSensor, aspect: number): { size: number; axis: 'horizontal' | 'vertical' } {
  const w = num(cam.sensorWidth, 36);
  const h = num(cam.sensorHeight, 24);
  if (cam.sensorFit === 'vertical') return { size: h, axis: 'vertical' };
  if (cam.sensorFit === 'horizontal') return { size: w, axis: 'horizontal' };
  return { size: w, axis: num(aspect, 1) >= 1 ? 'horizontal' : 'vertical' };
}

/** Champ horizontal (degrés) correspondant à un champ vertical (degrés) pour un rapport largeur / hauteur. */
export function horizontalFov(fovVertical: number, aspect: number): number {
  return (2 * Math.atan(Math.tan((clampFov(fovVertical) * DEG) / 2) * num(aspect, 1))) / DEG;
}

/** Champ vertical (degrés) correspondant à un champ horizontal (degrés). */
export function verticalFov(fovHorizontal: number, aspect: number): number {
  return (2 * Math.atan(Math.tan((clampFov(fovHorizontal) * DEG) / 2) / num(aspect, 1))) / DEG;
}

function clampFov(fov: number): number {
  return Math.max(0.01, Math.min(179.9, Number.isFinite(fov) ? fov : 40));
}

/** Focale (mm) d'une caméra dont `fov` est le champ vertical, pour une image de rapport `aspect`. */
export function focalLengthFromFov(cam: LensSensor & Pick<CameraData, 'fov'>, aspect: number): number {
  const fit = sensorFitAxis(cam, aspect);
  const fovAxis = fit.axis === 'vertical' ? clampFov(cam.fov) : horizontalFov(cam.fov, aspect);
  return fit.size / 2 / Math.tan((fovAxis * DEG) / 2);
}

/** Champ vertical (degrés) donnant la focale `mm` avec ce capteur et ce rapport d'image. */
export function fovFromFocalLength(mm: number, cam: LensSensor, aspect: number): number {
  const fit = sensorFitAxis(cam, aspect);
  const fovAxis = (2 * Math.atan(fit.size / 2 / Math.max(0.01, num(mm, 50)))) / DEG;
  return fit.axis === 'vertical' ? fovAxis : verticalFov(fovAxis, aspect);
}

export interface SensorPreset {
  id: string;
  label: string;
  width: number;
  height: number;
}

/** Capteurs courants (largeur × hauteur en mm). */
export const SENSOR_PRESETS: SensorPreset[] = [
  { id: 'full_frame', label: 'Plein format 36 × 24', width: 36, height: 24 },
  { id: 'aps_c', label: 'APS-C 23,6 × 15,6', width: 23.6, height: 15.6 },
  { id: 'aps_c_canon', label: 'APS-C (Canon) 22,3 × 14,9', width: 22.3, height: 14.9 },
  { id: 'super_35', label: 'Super 35 24,89 × 18,66', width: 24.89, height: 18.66 },
  { id: 'micro_43', label: 'Micro 4/3 17,3 × 13', width: 17.3, height: 13 },
  { id: 'one_inch', label: '1" 13,2 × 8,8', width: 13.2, height: 8.8 },
  { id: 'two_thirds', label: '2/3" 8,8 × 6,6', width: 8.8, height: 6.6 },
  { id: 'medium_format', label: 'Moyen format 43,8 × 32,9', width: 43.8, height: 32.9 },
  { id: 'imax', label: 'IMAX 70,41 × 52,63', width: 70.41, height: 52.63 },
];

/** Préréglage correspondant aux dimensions données (à 0,01 mm près), ou null. */
export function matchSensorPreset(width: number, height: number): SensorPreset | null {
  return SENSOR_PRESETS.find((p) => Math.abs(p.width - width) < 0.01 && Math.abs(p.height - height) < 0.01) ?? null;
}
