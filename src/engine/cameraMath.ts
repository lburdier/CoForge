import type { CameraData } from '../core/doc/schema';

/**
 * Mathématiques de caméra PURES (aucune dépendance à three.js ni au DOM) : conversions
 * focale ↔ champ, tronc de vision décentré (shift), cadre de la vue caméra, guides de
 * composition, zones de sécurité, mise au point, gizmo filaire, cadrage d'un nuage de points.
 *
 * Conventions : la caméra regarde selon −Z local, +X à droite, +Y en haut (comme three.js et
 * Blender). `CameraData.fov` est le champ VERTICAL de l'image en degrés : c'est la référence,
 * la focale en millimètres s'en déduit par le capteur et le rapport de l'image.
 */

type LensData = Partial<Pick<CameraData, 'kind' | 'fov' | 'orthoScale' | 'sensorFit' | 'sensorWidth' | 'sensorHeight' | 'shiftX' | 'shiftY'>>;

const DEG = Math.PI / 180;

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function safeAspect(aspect: number): number {
  return Number.isFinite(aspect) && aspect > 1e-6 ? aspect : 16 / 9;
}

/** Champ vertical borné (degrés) d'une caméra du document. */
export function verticalFov(cam: LensData): number {
  return clamp(num(cam.fov, 40), 0.05, 175);
}

/** Dimension de l'image sur laquelle le capteur est ajusté (« auto » : la plus grande). */
export function sensorFitAxis(cam: LensData, aspect: number): 'horizontal' | 'vertical' {
  if (cam.sensorFit === 'horizontal' || cam.sensorFit === 'vertical') return cam.sensorFit;
  return safeAspect(aspect) >= 1 ? 'horizontal' : 'vertical';
}

/** Taille du capteur (mm) utilisée pour la dimension d'ajustement. Comme Blender, « auto » emploie la largeur. */
export function sensorSize(cam: LensData, aspect: number): number {
  const w = Math.max(0.01, num(cam.sensorWidth, 36));
  const h = Math.max(0.01, num(cam.sensorHeight, 24));
  if (cam.sensorFit === 'vertical') return h;
  void aspect;
  return w;
}

/** Champ horizontal (degrés) à partir du champ vertical et du rapport largeur/hauteur. */
export function horizontalFov(fovV: number, aspect: number): number {
  return (2 * Math.atan(Math.tan((fovV * DEG) / 2) * safeAspect(aspect))) / DEG;
}

/** Focale (mm) correspondant au champ vertical de la caméra, pour un rapport d'image donné. */
export function focalLengthFromFov(cam: LensData, aspect: number): number {
  const a = safeAspect(aspect);
  const tanV = Math.tan((verticalFov(cam) * DEG) / 2);
  const tanFit = sensorFitAxis(cam, a) === 'horizontal' ? tanV * a : tanV;
  return sensorSize(cam, a) / 2 / tanFit;
}

/** Champ vertical (degrés) correspondant à une focale (mm), pour un rapport d'image donné. */
export function fovFromFocalLength(mm: number, cam: LensData, aspect: number): number {
  const a = safeAspect(aspect);
  const f = Math.max(0.01, num(mm, 50));
  const tanFit = sensorSize(cam, a) / 2 / f;
  const tanV = sensorFitAxis(cam, a) === 'horizontal' ? tanFit / a : tanFit;
  return clamp((2 * Math.atan(tanV)) / DEG, 0.05, 175);
}

/** Diamètre de la pupille d'entrée (mm) : focale / nombre d'ouverture. */
export function apertureDiameterMm(cam: LensData & { fstop?: number }, aspect: number): number {
  const n = Math.max(0.01, num(cam.fstop, 2.8));
  return focalLengthFromFov(cam, aspect) / n;
}

// ---------------------------------------------------------------------- tronc de vision

/**
 * Fenêtre de projection. Perspective : tangentes (étendue à la distance 1 devant la caméra) ;
 * orthographique : mètres. Peut être décentrée (shift, déplacement de la vue caméra).
 */
export interface Frustum {
  left: number;
  right: number;
  bottom: number;
  top: number;
  ortho: boolean;
}

/**
 * Fenêtre de l'IMAGE d'une caméra du document, shift compris. Le shift est exprimé en fraction
 * de la dimension d'ajustement du capteur (la plus grande en « auto ») et déplace la fenêtre
 * dans le sens du décalage : shiftX > 0 montre davantage ce qui est à droite.
 */
export function imageFrustum(cam: LensData, aspect: number): Frustum {
  const a = safeAspect(aspect);
  const ortho = cam.kind === 'ortho';
  const halfH = ortho ? Math.max(1e-4, num(cam.orthoScale, 6)) / 2 : Math.tan((verticalFov(cam) * DEG) / 2);
  const halfW = halfH * a;
  const unit = 2 * (sensorFitAxis(cam, a) === 'horizontal' ? halfW : halfH);
  const sx = clamp(num(cam.shiftX, 0), -10, 10) * unit;
  const sy = clamp(num(cam.shiftY, 0), -10, 10) * unit;
  return { left: -halfW + sx, right: halfW + sx, bottom: -halfH + sy, top: halfH + sy, ortho };
}

/** Rectangle écran (px, origine en haut à gauche, y vers le bas). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Cadre de l'image en vue caméra : rectangle au rapport `imageAspect` inscrit dans le viewport,
 * mis à l'échelle par `zoom` (1 = inscrit exactement) puis déplacé de (offsetX, offsetY) pixels.
 */
export function cameraFrameRect(viewW: number, viewH: number, imageAspect: number, zoom = 1, offsetX = 0, offsetY = 0): Rect {
  const W = Math.max(1, num(viewW, 1));
  const H = Math.max(1, num(viewH, 1));
  const A = safeAspect(imageAspect);
  const s = clamp(num(zoom, 1), 1e-3, 1e3);
  let w: number;
  let h: number;
  if (W / H > A) {
    h = s * H;
    w = h * A;
  } else {
    w = s * W;
    h = w / A;
  }
  return { x: (W - w) / 2 + num(offsetX, 0), y: (H - h) / 2 + num(offsetY, 0), w, h };
}

/**
 * Fenêtre de projection du VIEWPORT entier quand l'image (fenêtre `image`) occupe le rectangle
 * `frame` de l'écran : prolongement linéaire de la fenêtre de l'image.
 */
export function extendFrustum(image: Frustum, frame: Rect, viewW: number, viewH: number): Frustum {
  const fw = Math.max(1e-6, frame.w);
  const fh = Math.max(1e-6, frame.h);
  const perX = (image.right - image.left) / fw;
  const perY = (image.top - image.bottom) / fh;
  const left = image.left - frame.x * perX;
  const top = image.top + frame.y * perY;
  return { left, right: left + viewW * perX, top, bottom: top - viewH * perY, ortho: image.ortho };
}

/**
 * Matrice de projection (16 nombres, ordre colonne, conventions OpenGL/three.js : z ∈ [−1, 1])
 * d'une fenêtre éventuellement décentrée.
 */
export function projectionMatrix(f: Frustum, near: number, far: number): number[] {
  const { left: l, right: r, bottom: b, top: t } = f;
  const w = r - l;
  const h = t - b;
  const d = far - near;
  if (f.ortho) {
    // prettier-ignore
    return [
      2 / w, 0, 0, 0,
      0, 2 / h, 0, 0,
      0, 0, -2 / d, 0,
      -(r + l) / w, -(t + b) / h, -(far + near) / d, 1,
    ];
  }
  // la fenêtre est donnée à la distance 1 : l'échelle par `near` se simplifie
  // prettier-ignore
  return [
    2 / w, 0, 0, 0,
    0, 2 / h, 0, 0,
    (r + l) / w, (t + b) / h, -(far + near) / d, -1,
    0, 0, (-2 * far * near) / d, 0,
  ];
}

// ---------------------------------------------------------------------- guides de composition

export type GuideFlags = Partial<
  Pick<
    CameraData,
    | 'guideThirds'
    | 'guideCenter'
    | 'guideCenterDiagonal'
    | 'guideGolden'
    | 'guideGoldenTriangleA'
    | 'guideGoldenTriangleB'
    | 'guideHarmonyTriangleA'
    | 'guideHarmonyTriangleB'
  >
>;

const INV_PHI = 1 / 1.618033989;

/** Trois diagonales d'un guide « triangle » (même construction que Blender), en coordonnées normalisées. */
function triangleGuide(out: number[], aspect: number, harmony: boolean, dir: 'A' | 'B'): void {
  const w = aspect;
  const h = 1;
  let x1 = 0;
  let x2 = 1;
  let y1 = 0;
  let y2 = 1;
  if (w > h) {
    // décalage horizontal, en fraction de la largeur
    const ofs = harmony ? 1 - INV_PHI : (h * (h / w)) / w;
    if (dir === 'B') [y1, y2] = [y2, y1];
    out.push(x1, y1, x2, y2, x2, y1, x1 + (1 - ofs), y2, x1, y2, x1 + ofs, y1);
  } else {
    const ofs = harmony ? 1 - INV_PHI : (w * (w / h)) / h;
    if (dir === 'B') [x1, x2] = [x2, x1];
    out.push(x1, y1, x2, y2, x2, y1, x1, y1 + ofs, x1, y2, x2, y1 + (1 - ofs));
  }
}

/**
 * Segments des guides de composition actifs, en coordonnées NORMALISÉES du cadre
 * (x de 0 à gauche à 1 à droite, y de 0 en bas à 1 en haut) : tableau plat x0, y0, x1, y1…
 * `aspect` (largeur/hauteur de l'image) n'influe que sur les triangles.
 */
export function compositionGuides(flags: GuideFlags, aspect: number): number[] {
  const a = safeAspect(aspect);
  const out: number[] = [];
  const grid = (f: number) => out.push(f, 0, f, 1, 1 - f, 0, 1 - f, 1, 0, f, 1, f, 0, 1 - f, 1, 1 - f);
  if (flags.guideThirds) grid(1 / 3);
  if (flags.guideGolden) grid(1 - INV_PHI);
  if (flags.guideCenter) out.push(0.5, 0, 0.5, 1, 0, 0.5, 1, 0.5);
  if (flags.guideCenterDiagonal) out.push(0, 0, 1, 1, 0, 1, 1, 0);
  if (flags.guideGoldenTriangleA) triangleGuide(out, a, false, 'A');
  if (flags.guideGoldenTriangleB) triangleGuide(out, a, false, 'B');
  if (flags.guideHarmonyTriangleA) triangleGuide(out, a, true, 'A');
  if (flags.guideHarmonyTriangleB) triangleGuide(out, a, true, 'B');
  return out;
}

/** Marges totales des zones de sécurité, en fraction de l'image (valeurs par défaut de Blender). */
export const SAFE_TITLE = 0.1;
export const SAFE_ACTION = 0.05;

/** Rectangles des zones de sécurité (titre, puis action) : segments normalisés comme `compositionGuides`. */
export function safeAreaSegments(): number[] {
  const out: number[] = [];
  for (const total of [SAFE_TITLE, SAFE_ACTION]) {
    const m = total / 2;
    out.push(m, m, 1 - m, m, 1 - m, m, 1 - m, 1 - m, 1 - m, 1 - m, m, 1 - m, m, 1 - m, m, m);
  }
  return out;
}

/**
 * Rectangle du capteur par rapport au cadre de l'image (coordonnées normalisées, peut déborder) :
 * la dimension d'ajustement coïncide avec l'image, l'autre suit le rapport du capteur.
 */
export function sensorRectSegments(cam: LensData, aspect: number): number[] {
  const a = safeAspect(aspect);
  const sw = Math.max(0.01, num(cam.sensorWidth, 36));
  const sh = Math.max(0.01, num(cam.sensorHeight, 24));
  let w = 1;
  let h = 1;
  if (sensorFitAxis(cam, a) === 'horizontal') h = a / (sw / sh);
  else w = sw / sh / a;
  const x0 = 0.5 - w / 2;
  const x1 = 0.5 + w / 2;
  const y0 = 0.5 - h / 2;
  const y1 = 0.5 + h / 2;
  return [x0, y0, x1, y0, x1, y0, x1, y1, x1, y1, x0, y1, x0, y1, x0, y0];
}

// ---------------------------------------------------------------------- mise au point

type V3 = readonly [number, number, number];

/**
 * Distance de mise au point : avec un objet cible, distance le long de l'axe de visée entre la
 * caméra et l'origine de l'objet (pas la distance euclidienne) ; sinon `fallback` (focusDistance).
 * `forward` doit être unitaire. Le résultat est toujours strictement positif.
 */
export function focusDistanceAlongAxis(camPos: V3, forward: V3, target: V3 | null, fallback: number): number {
  const fb = Math.max(1e-3, num(fallback, 10));
  if (!target || !target.every((v) => Number.isFinite(v))) return fb;
  const d = (target[0] - camPos[0]) * forward[0] + (target[1] - camPos[1]) * forward[1] + (target[2] - camPos[2]) * forward[2];
  return Number.isFinite(d) ? Math.max(1e-3, d) : fb;
}

// ---------------------------------------------------------------------- gizmo filaire

export type GizmoData = LensData & Partial<Pick<CameraData, 'near' | 'far' | 'focusDistance' | 'showLimits' | 'showFocus' | 'displaySize'>>;

/**
 * Segments (tableau plat xyz, espace local de la caméra) du gizmo d'une caméra : pyramide de
 * champ (boîte en orthographique) au rapport de l'image et décalée par le shift, triangle
 * « haut », et selon les options : limites near → far, croix à la distance de mise au point.
 * En perspective la plus grande dimension du cadre vaut `displaySize` mètres (comme Blender).
 */
export function cameraGizmoSegments(data: GizmoData, aspect: number, focusDistance?: number): number[] {
  const p: number[] = [];
  const f = imageFrustum(data, aspect);
  const size = clamp(num(data.displaySize, 1), 0.01, 1000);
  const halfW = (f.right - f.left) / 2;
  const halfH = (f.top - f.bottom) / 2;
  // profondeur du cadre et facteur d'échelle de la fenêtre
  let d: number;
  let k: number;
  if (f.ortho) {
    d = size;
    k = 1;
  } else {
    d = (0.5 * size) / Math.max(halfW, halfH, 1e-6);
    k = d;
  }
  const l = f.left * k;
  const r = f.right * k;
  const b = f.bottom * k;
  const t = f.top * k;
  const c: [number, number][] = [
    [l, b],
    [r, b],
    [r, t],
    [l, t],
  ];
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = c[i];
    const [x1, y1] = c[(i + 1) % 4];
    p.push(x0, y0, -d, x1, y1, -d);
    if (f.ortho) p.push(x0, y0, 0, x1, y1, 0, x0, y0, 0, x0, y0, -d);
    else p.push(0, 0, 0, x0, y0, -d);
  }
  // triangle « haut », au-dessus du cadre
  const hw = (r - l) / 2;
  const hh = (t - b) / 2;
  const cx = (l + r) / 2;
  const base = t + hh * 0.1;
  const tip = base + Math.min(hw, hh * 2) * 0.55;
  p.push(cx - hw * 0.6, base, -d, cx + hw * 0.6, base, -d);
  p.push(cx + hw * 0.6, base, -d, cx, tip, -d);
  p.push(cx, tip, -d, cx - hw * 0.6, base, -d);

  const mark = 0.08 * size;
  if (data.showLimits) {
    const near = Math.max(1e-4, num(data.near, 0.1));
    const far = Math.max(near, num(data.far, 1000));
    p.push(0, 0, -near, 0, 0, -far);
    for (const z of [near, far]) p.push(-mark, 0, -z, mark, 0, -z, 0, -mark, -z, 0, mark, -z);
  }
  if (data.showFocus) {
    const z = Math.max(1e-3, num(focusDistance, num(data.focusDistance, 10)));
    const m = mark * 2;
    p.push(-m, 0, -z, m, 0, -z, 0, -m, -z, 0, m, -z);
  }
  return p;
}

// ---------------------------------------------------------------------- cadrage

/**
 * Position (dans le repère d'ORIENTATION de la caméra : mêmes axes, origine quelconque) où placer
 * une caméra perspective de fenêtre `f` pour que tous les points (exprimés dans ce même repère)
 * tiennent exactement dans l'image, sans changer son orientation. null s'il n'y a pas de point.
 */
export function fitPerspective(points: ArrayLike<number>, f: Frustum): [number, number, number] | null {
  const n = Math.floor(points.length / 3);
  if (n === 0 || f.ortho) return null;
  const { left: l, right: r, bottom: b, top: t } = f;
  if (!(r > l) || !(t > b)) return null;
  // contraintes : l·(cz − z) ≤ x − cx ≤ r·(cz − z) (et de même en y)
  let A = -Infinity;
  let B = Infinity;
  let C = -Infinity;
  let D = Infinity;
  for (let i = 0; i < n; i++) {
    const x = points[i * 3];
    const y = points[i * 3 + 1];
    const z = points[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    A = Math.max(A, x + r * z);
    B = Math.min(B, x + l * z);
    C = Math.max(C, y + t * z);
    D = Math.min(D, y + b * z);
  }
  if (!Number.isFinite(A) || !Number.isFinite(C)) return null;
  const czH = (A - B) / (r - l);
  const czV = (C - D) / (t - b);
  const cz = Math.max(czH, czV);
  // centre le jeu restant dans la dimension non limitante
  const cx = (A - r * cz + (B - l * cz)) / 2;
  const cy = (C - t * cz + (D - b * cz)) / 2;
  return [cx, cy, cz];
}
