/**
 * Caméras (bloc `CA`) → `CameraData`.
 *
 * Champ de vision : CoForge stocke le champ VERTICAL en degrés. Comme Blender
 * (BKE_camera_params_compute_viewplane) : en ajustement « Auto », le capteur `sensor_x` couvre
 * la plus grande dimension de l'image ; « Horizontal » : `sensor_x` couvre la largeur ;
 * « Vertical » : `sensor_y` couvre la hauteur. Orthographique : `ortho_scale` suit la même règle,
 * CoForge attend la hauteur visible.
 */
import type { CameraData } from '../../../core/doc/schema';
import type { Rec } from './reader';
import { RAD2DEG, clamp, finite, idPropNumber, idPropPath, type Ctx } from './util';

const CAM_PERSP = 0;
const CAM_ORTHO = 1;
const CAM_PANO = 2;

const SENSOR_FIT_AUTO = 0;
const SENSOR_FIT_HOR = 1;
const SENSOR_FIT_VERT = 2;

/** `CameraDOFSettings.flag` (Blender ≥ 2.81). */
const CAM_DOF_ENABLED = 1 << 0;

const cams = (n: number): string => `${n} ${n > 1 ? 'caméras' : 'caméra'}`;

/** Dimension couverte par le capteur : true = verticale. */
function fitsVertical(fit: number, aspect: number): boolean {
  if (fit === SENSOR_FIT_VERT) return true;
  if (fit === SENSOR_FIT_HOR) return false;
  return aspect < 1;
}

export function readCamera(ctx: Ctx, camera: Rec, aspect: number): Partial<Omit<CameraData, 'id'>> {
  const name = camera.idName || 'Caméra';
  const out: Partial<Omit<CameraData, 'id'>> = {};
  try {
    const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
    let type = camera.num('type', CAM_PERSP);
    if (type === CAM_PANO) {
      ctx.notes.add('cam-pano', (n, names) => `Caméras panoramiques converties en perspective (${cams(n)} : ${names}).`, name);
      type = CAM_PERSP;
    } else if (type !== CAM_PERSP && type !== CAM_ORTHO) {
      type = CAM_PERSP;
    }
    out.kind = type === CAM_ORTHO ? 'ortho' : 'persp';

    const fit = camera.num('sensor_fit', SENSOR_FIT_AUTO);
    const vertical = fitsVertical(fit, a);
    const sensor = fit === SENSOR_FIT_VERT ? camera.num('sensor_y', 24) : camera.num('sensor_x', 32);
    const lens = Math.max(1e-3, finite(camera.num('lens', 50), 50));
    // Demi-hauteur de l'image à une distance de 1, d'après la focale et le capteur.
    const half = finite(sensor, 32) / (2 * lens);
    const halfH = vertical ? half : half / a;
    out.fov = clamp(2 * Math.atan(halfH) * RAD2DEG, 0.1, 179);

    const scale = Math.max(1e-4, finite(camera.num('ortho_scale', 6), 6));
    out.orthoScale = vertical ? scale : scale / a;

    const near = finite(camera.num(['clipsta', 'clip_start'], 0.1), 0.1);
    const far = finite(camera.num(['clipend', 'clip_end'], 1000), 1000);
    out.near = Math.max(1e-6, near);
    out.far = Math.max(out.near * 1.0001, far);

    if (camera.num('shiftx') !== 0 || camera.num('shifty') !== 0) {
      ctx.notes.add('cam-shift', (n, names) => `Décentrement (shift) des caméras non repris (${cams(n)} : ${names}).`, name);
    }

    // --- profondeur de champ
    const dof = camera.sub('dof');
    if (dof && dof.has('aperture_fstop')) {
      out.dofEnabled = (dof.num('flag') & CAM_DOF_ENABLED) !== 0;
      out.focusDistance = Math.max(0, finite(dof.num('focus_distance', 10), 10));
      out.fstop = Math.max(0.01, finite(dof.num('aperture_fstop', 2.8), 2.8));
      if (out.dofEnabled && dof.ptr('focus_object') !== 0) {
        ctx.notes.add('cam-focus-object', (n, names) => `Mise au point sur un objet non reprise : distance fixe retenue (${cams(n)} : ${names}).`, name);
      }
    } else {
      // Avant 2.81 : distance dans la caméra, ouverture dans les réglages Cycles (IDProperties).
      const dist = finite(camera.num(['YF_dofdist', 'dof_distance'], 0), 0);
      const fstop = idPropNumber(idPropPath(camera, ['cycles', 'aperture_fstop']));
      const size = idPropNumber(idPropPath(camera, ['cycles', 'aperture_size']));
      const apType = idPropNumber(idPropPath(camera, ['cycles', 'aperture_type']));
      if (apType === 1 && fstop !== null && fstop > 0) {
        // Ouverture par nombre f : profondeur de champ active (Cycles 2.7x).
        out.dofEnabled = true;
        out.fstop = fstop;
      } else if (size !== null && size > 0) {
        // Ouverture par rayon (mètres) : f = focale / (2 × rayon).
        out.dofEnabled = true;
        out.fstop = Math.max(0.01, lens / 1000 / (2 * size));
      } else {
        out.dofEnabled = false;
        if (fstop !== null && fstop > 0) out.fstop = fstop;
      }
      if (dist > 0) out.focusDistance = dist;
      if (out.dofEnabled && camera.ptr('dof_ob') !== 0) {
        ctx.notes.add('cam-focus-object', (n, names) => `Mise au point sur un objet non reprise : distance fixe retenue (${cams(n)} : ${names}).`, name);
      }
    }
  } catch {
    ctx.notes.add('cam-error', (n, names) => `Caméras illisibles remplacées par des valeurs par défaut (${cams(n)} : ${names}).`, name);
  }
  return out;
}
