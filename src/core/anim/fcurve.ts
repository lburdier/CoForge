import { ANIM_FRAME_EPS, type CurveSmoothing, type Easing, type HandleType, type Interpolation, type KeyframeData } from '../doc/schema';
import { easeSegment } from './easing';

/**
 * Courbes d'animation (F-Curves) : fonctions PURES.
 *
 *  - `resolveKeys`    : règle de fusion des clés concurrentes (une seule clé effective par image) ;
 *  - `computePoints`  : poignées comme Blender (BKE_fcurve_handles_recalc : auto, auto-clamped,
 *                       vecteur, alignées, libres, puis lissage « accélération continue ») ;
 *  - `evaluatePoints` : valeur à une image (bezier : on résout la cubique en x puis on calcule y ;
 *                       linéaire, constante, atténuations ; extrapolation constante).
 *
 * Transcription de blenkernel/intern/curve.cc et fcurve.cc (Blender 5.1), vérifiée par les tests
 * `tests/anim.blender.test.ts` contre des valeurs produites par Blender lui-même.
 */

// ------------------------------------------------------------------ fusion

/** Compare deux clés : la plus « récente » gagne (horodatage, puis identifiant). */
function newer(a: KeyframeData, b: KeyframeData): boolean {
  if (a.t !== b.t) return a.t > b.t;
  return a.id > b.id;
}

/**
 * Trie les clés d'une courbe et applique la règle de fusion : parmi des clés à moins de
 * ANIM_FRAME_EPS l'une de l'autre (groupées à partir de la première du groupe, dans l'ordre
 * (image, id)), seule la plus récente reste effective. Déterministe : même entrée → même sortie.
 */
export function resolveKeys(raw: Iterable<KeyframeData>): { keys: KeyframeData[]; shadowed: KeyframeData[] } {
  const all = [...raw].filter((k) => Number.isFinite(k.frame) && Number.isFinite(k.value));
  all.sort((a, b) => a.frame - b.frame || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const keys: KeyframeData[] = [];
  const shadowed: KeyframeData[] = [];
  let i = 0;
  while (i < all.length) {
    const start = all[i].frame;
    let best = all[i];
    let j = i + 1;
    while (j < all.length && all[j].frame - start < ANIM_FRAME_EPS) {
      if (newer(all[j], best)) {
        shadowed.push(best);
        best = all[j];
      } else shadowed.push(all[j]);
      j++;
    }
    keys.push(best);
    i = j;
  }
  return { keys, shadowed };
}

// ------------------------------------------------------------------ poignées

const HD_FREE = 0;
const HD_AUTO = 1;
const HD_VECT = 2;
const HD_ALIGN = 3;
const HD_AUTO_ANIM = 4;

const HANDLE_CODE: Record<HandleType, number> = { FREE: HD_FREE, AUTO: HD_AUTO, VECTOR: HD_VECT, ALIGNED: HD_ALIGN, AUTO_CLAMPED: HD_AUTO_ANIM };

/** Point de courbe évalué : clé + poignées effectives (après recalcul). */
export interface BezPoint {
  /** Identifiant de la clé d'origine. */
  id: string;
  f: number;
  v: number;
  /** Poignée gauche / droite [image, valeur]. */
  hl: [number, number];
  hr: [number, number];
  h1: number;
  h2: number;
  ipo: Interpolation;
  easing: Easing;
  /** false : poignées figées (extremum auto-clamped, extrémité de courbe…) ; exclues du lissage. */
  autoNormal: boolean;
}

const isAuto = (h: number) => h === HD_AUTO || h === HD_AUTO_ANIM;
const isAutoH = (p: BezPoint) => isAuto(p.h1) && isAuto(p.h2);

/** calchandleNurb_intern (cas F-Curve, 2D). */
function calcHandle(p: BezPoint, prev: BezPoint | null, next: BezPoint | null, smoothing: CurveSmoothing): void {
  p.autoNormal = true;
  if (p.h1 === HD_FREE && p.h2 === HD_FREE) return;
  const p2x = p.f;
  const p2y = p.v;
  let p1x: number, p1y: number, p3x: number, p3y: number;
  if (!prev) {
    p3x = next!.f;
    p3y = next!.v;
    p1x = 2 * p2x - p3x;
    p1y = 2 * p2y - p3y;
  } else {
    p1x = prev.f;
    p1y = prev.v;
  }
  if (!next) {
    p3x = 2 * p2x - p1x;
    p3y = 2 * p2y - p1y;
  } else {
    p3x = next.f;
    p3y = next.v;
  }
  const dax = p2x - p1x;
  const day = p2y - p1y;
  const dbx = p3x - p2x;
  const dby = p3y - p2y;
  let lenA = dax;
  let lenB = dbx;
  if (lenA === 0) lenA = 1;
  if (lenB === 0) lenB = 1;

  if (isAuto(p.h1) || isAuto(p.h2)) {
    const tx = dbx / lenB + dax / lenA;
    const ty = dby / lenB + day / lenA;
    let len = smoothing !== 'NONE' ? 6 / 2.5614 : tx;
    len *= 2.5614;
    if (len !== 0) {
      let leftViolate = false;
      let rightViolate = false;
      if (smoothing === 'NONE') {
        lenA = Math.min(lenA, 5 * lenB);
        lenB = Math.min(lenB, 5 * lenA);
      }
      if (isAuto(p.h1)) {
        lenA /= len;
        p.hl[0] = p2x - tx * lenA;
        p.hl[1] = p2y - ty * lenA;
        if (p.h1 === HD_AUTO_ANIM && next && prev) {
          const yd1 = prev.v - p.v;
          const yd2 = next.v - p.v;
          if ((yd1 <= 0 && yd2 <= 0) || (yd1 >= 0 && yd2 >= 0)) {
            p.hl[1] = p.v;
            p.autoNormal = false;
          } else if (yd1 <= 0) {
            if (prev.v > p.hl[1]) {
              p.hl[1] = prev.v;
              leftViolate = true;
            }
          } else if (prev.v < p.hl[1]) {
            p.hl[1] = prev.v;
            leftViolate = true;
          }
        }
      }
      if (isAuto(p.h2)) {
        lenB /= len;
        p.hr[0] = p2x + tx * lenB;
        p.hr[1] = p2y + ty * lenB;
        if (p.h2 === HD_AUTO_ANIM && next && prev) {
          const yd1 = prev.v - p.v;
          const yd2 = next.v - p.v;
          if ((yd1 <= 0 && yd2 <= 0) || (yd1 >= 0 && yd2 >= 0)) {
            p.hr[1] = p.v;
            p.autoNormal = false;
          } else if (yd1 <= 0) {
            if (next.v < p.hr[1]) {
              p.hr[1] = next.v;
              rightViolate = true;
            }
          } else if (next.v > p.hr[1]) {
            p.hr[1] = next.v;
            rightViolate = true;
          }
        }
      }
      if (leftViolate || rightViolate) {
        const h1x = p.hl[0] - p2x;
        const h2x = p2x - p.hr[0];
        if (leftViolate) p.hr[1] = p2y + ((p2y - p.hl[1]) / h1x) * h2x;
        else p.hl[1] = p2y + ((p2y - p.hr[1]) / h2x) * h1x;
      }
    }
  }

  if (p.h1 === HD_VECT) {
    p.hl[0] = p2x - dax / 3;
    p.hl[1] = p2y - day / 3;
  }
  if (p.h2 === HD_VECT) {
    p.hr[0] = p2x + dbx / 3;
    p.hr[1] = p2y + dby / 3;
  }

  if (p.h1 === HD_FREE || p.h2 === HD_FREE || (p.h1 !== HD_ALIGN && p.h2 !== HD_ALIGN)) return;

  let la = Math.hypot(p2x - p.hl[0], p2y - p.hl[1]);
  let lb = Math.hypot(p2x - p.hr[0], p2y - p.hr[1]);
  if (la === 0) la = 1;
  if (lb === 0) lb = 1;
  const ratio = la / lb;
  const eps = 1e-5;
  // Poignées non sélectionnées (ordre de Blender) : la gauche s'aligne sur la droite, puis l'inverse.
  if (p.h1 === HD_ALIGN && lb > eps) {
    p.hl[0] = p2x + ratio * (p2x - p.hr[0]);
    p.hl[1] = p2y + ratio * (p2y - p.hr[1]);
  }
  if (p.h2 === HD_ALIGN && la > eps) {
    const l = 1 / ratio;
    p.hr[0] = p2x + l * (p2x - p.hl[0]);
    p.hr[1] = p2y + l * (p2y - p.hl[1]);
  }
}

// ---- lissage « accélération continue » (bezier_handle_calc_smooth_fcurve)

function tridiagonalSolve(a: Float64Array, b: Float64Array, c: Float64Array, d: Float64Array, x: Float64Array, n: number): boolean {
  if (n < 1) return false;
  const c1 = new Float64Array(n);
  const d1 = new Float64Array(n);
  let cPrev = (c1[0] = c[0] / b[0]);
  let dPrev = (d1[0] = d[0] / b[0]);
  let i: number;
  for (i = 1; i < n; i++) {
    const den = b[i] - a[i] * cPrev;
    cPrev = c1[i] = c[i] / den;
    dPrev = d1[i] = (d[i] - a[i] * dPrev) / den;
  }
  let xPrev = dPrev;
  x[--i] = xPrev;
  while (--i >= 0) {
    xPrev = d1[i] - c1[i] * xPrev;
    x[i] = xPrev;
  }
  return Number.isFinite(xPrev);
}

function solveWithLimits(a: Float64Array, b: Float64Array, c: Float64Array, d: Float64Array, h: Float64Array, hmin: Float64Array, hmax: Float64Array, n: number): boolean {
  const a0 = a.slice();
  const b0 = b.slice();
  const c0 = c.slice();
  const d0 = d.slice();
  const locked = new Uint8Array(n);
  const unlocks = new Uint8Array(n);
  const lock = (i: number, v: number) => {
    a[i] = c[i] = 0;
    b[i] = 1;
    d[i] = v;
  };
  let overshoot: boolean;
  let unlocked: boolean;
  let guard = 0;
  do {
    if (!tridiagonalSolve(a, b, c, d, h, n)) return false;
    let all = false;
    let didLock = false;
    overshoot = unlocked = false;
    do {
      for (let i = 0; i < n; i++) {
        if (h[i] >= hmin[i] && h[i] <= hmax[i]) continue;
        overshoot = true;
        const target = h[i] > hmax[i] ? hmax[i] : hmin[i];
        if (target !== 0 || all) {
          locked[i] = 1;
          lock(i, target);
          didLock = true;
        }
      }
      all = true;
    } while (overshoot && !didLock);
    if (!didLock) {
      for (let i = 0; i < n; i++) {
        if (!locked[i] || unlocks[i] >= 2) continue;
        const state = a0[i] * h[(i + n - 1) % n] + b0[i] * h[i] + c0[i] * h[(i + 1) % n] - d0[i];
        const relax = -state * b0[i];
        if ((relax > 0 && h[i] < hmax[i]) || (relax < 0 && h[i] > hmin[i])) {
          a[i] = a0[i];
          b[i] = b0[i];
          c[i] = c0[i];
          d[i] = d0[i];
          locked[i] = 0;
          unlocks[i]++;
          unlocked = true;
        }
      }
    }
  } while ((overshoot || unlocked) && ++guard < 1000);
  return true;
}

function clampRange(hmax: Float64Array, hmin: Float64Array, i: number, dy: number, noReverse: boolean, noOvershoot: boolean): void {
  if (dy > 0) {
    if (noOvershoot) hmax[i] = Math.min(hmax[i], dy);
    if (noReverse) hmin[i] = 0;
  } else if (dy < 0) {
    if (noReverse) hmax[i] = 0;
    if (noOvershoot) hmin[i] = Math.max(hmin[i], dy);
  } else if (noReverse || noOvershoot) hmax[i] = hmin[i] = 0;
}

function outputHandle(p: BezPoint, right: boolean, dy: number, endpoint: boolean): void {
  const hr = right ? p.h2 : p.h1;
  const hm = right ? p.h1 : p.h2;
  if (!(isAuto(hr) || hr === HD_VECT)) return;
  const own = right ? p.hr : p.hl;
  const other = right ? p.hl : p.hr;
  own[1] = p.v + dy;
  if (hm === HD_ALIGN) {
    const hlen = Math.hypot(p.f - other[0], p.v - other[1]);
    const h2len = Math.hypot(p.f - own[0], p.v - own[1]);
    other[0] = p.f + (p.f - own[0]) * (hlen / h2len);
    other[1] = p.v + (p.v - own[1]) * (hlen / h2len);
  } else if (endpoint && (isAuto(hm) || hm === HD_VECT)) {
    other[0] = p.f + (p.f - own[0]);
    other[1] = p.v + (p.v - own[1]);
  }
}

function checkSolveEnd(p: BezPoint, htype: number, end: boolean): boolean {
  return htype === HD_VECT || (end && isAuto(htype) && p.autoNormal);
}

function handleAdj(hsize: [number, number], dx: number): number {
  const fac = dx / (hsize[0] + dx / 3);
  if (fac < 1) {
    hsize[0] *= fac;
    hsize[1] *= fac;
  }
  return 1 - (3 * hsize[0]) / dx;
}

function smoothSegment(pts: BezPoint[], start: number, count: number): void {
  const total = pts.length;
  if (count < 2) return;
  const first = pts[start];
  const last = pts[start + count - 1];
  const solveFirst = checkSolveEnd(first, first.h2, start === 0);
  const solveLast = checkSolveEnd(last, last.h1, start + count === total);
  if (count === 2 && solveFirst === solveLast) return;

  const dx = new Float64Array(count);
  const dy = new Float64Array(count);
  const l = new Float64Array(count);
  const a = new Float64Array(count);
  const b = new Float64Array(count);
  const c = new Float64Array(count);
  const d = new Float64Array(count);
  const h = new Float64Array(count);
  const hmax = new Float64Array(count);
  const hmin = new Float64Array(count);
  dx[0] = dy[0] = NaN;
  for (let i = 1, j = start + 1; i < count; i++, j++) {
    dx[i] = pts[j].f - pts[j - 1].f;
    dy[i] = pts[j].v - pts[j - 1].v;
  }
  l[0] = l[count - 1] = 1;
  for (let i = 1; i < count - 1; i++) l[i] = dx[i + 1] / dx[i];

  const clampedOf = (p: BezPoint) => p.h1 === HD_AUTO_ANIM || p.h2 === HD_AUTO_ANIM;
  let clampedCur = clampedOf(first);
  hmax.fill(Number.MAX_VALUE);
  hmin.fill(-Number.MAX_VALUE);
  for (let i = 1, j = start + 1; i < count; i++, j++) {
    const clampedPrev = clampedCur;
    clampedCur = clampedOf(pts[j]);
    clampRange(hmax, hmin, i - 1, dy[i], clampedPrev, clampedPrev);
    clampRange(hmax, hmin, i, dy[i] * l[i], clampedCur, clampedCur);
  }

  let firstAdj = 0;
  let lastAdj = 0;
  const lock = (i: number, v: number) => {
    a[i] = c[i] = 0;
    b[i] = 1;
    d[i] = v;
  };
  if (!solveFirst) {
    const tmp: [number, number] = [first.hr[0] - first.f, first.hr[1] - first.v];
    firstAdj = handleAdj(tmp, dx[1]);
    lock(0, tmp[1]);
  } else {
    a[0] = 0;
    b[0] = 2;
    c[0] = 1 / l[1];
    d[0] = dy[1];
  }
  if (!solveLast) {
    const tmp: [number, number] = [last.f - last.hl[0], last.v - last.hl[1]];
    lastAdj = handleAdj(tmp, dx[count - 1]);
    lock(count - 1, tmp[1]);
  } else {
    const i = count - 1;
    a[i] = l[i] * l[i];
    b[i] = 2 * l[i];
    c[i] = 0;
    d[i] = dy[i] * l[i] * l[i];
  }
  for (let i = 1; i < count - 1; i++) {
    a[i] = l[i] * l[i];
    b[i] = 2 * (l[i] + 1);
    c[i] = 1 / l[i + 1];
    d[i] = dy[i] * l[i] * l[i] + dy[i + 1];
  }
  if (count > 2 || solveLast) b[1] += l[1] * firstAdj;
  if (count > 2 || solveFirst) b[count - 2] += lastAdj;

  if (solveWithLimits(a, b, c, d, h, hmin, hmax, count)) {
    for (let i = 1, j = start + 1; i < count - 1; i++, j++) {
      const end = j === total - 1;
      outputHandle(pts[j], false, -h[i] / l[i], end);
      outputHandle(pts[j], true, h[i], end);
    }
    if (solveFirst) outputHandle(first, true, h[0], start === 0);
    if (solveLast) outputHandle(last, false, -h[count - 1] / l[count - 1], start + count === total);
  }
}

/** BKE_nurb_handle_smooth_fcurve, sans cycle. */
function smoothFCurve(pts: BezPoint[]): void {
  const total = pts.length;
  const free = (p: BezPoint) => isAutoH(p) && p.autoNormal;
  let start = 0;
  let count = 1;
  for (let j = 1; j < total; j++) {
    if (!free(pts[j])) {
      smoothSegment(pts, start, count + 1);
      start = j;
      count = 1;
    } else count++;
  }
  if (count > 1) smoothSegment(pts, start, count);
}

/** Points de courbe (poignées recalculées comme Blender) à partir des clés effectives triées. */
export function computePoints(keys: readonly KeyframeData[], smoothing: CurveSmoothing = 'CONT_ACCEL'): BezPoint[] {
  const pts: BezPoint[] = keys.map((k) => ({
    id: k.id,
    f: k.frame,
    v: k.value,
    hl: [finiteOr(k.hl?.[0], k.frame - 1), finiteOr(k.hl?.[1], k.value)],
    hr: [finiteOr(k.hr?.[0], k.frame + 1), finiteOr(k.hr?.[1], k.value)],
    h1: HANDLE_CODE[k.hlType] ?? HD_AUTO_ANIM,
    h2: HANDLE_CODE[k.hrType] ?? HD_AUTO_ANIM,
    ipo: k.interp ?? 'BEZIER',
    easing: k.easing ?? 'AUTO',
    autoNormal: true,
  }));
  const n = pts.length;
  if (n < 2) return pts;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const prev = i > 0 ? pts[i - 1] : null;
    const next = i < n - 1 ? pts[i + 1] : null;
    // Les poignées restent de part et d'autre de la clé.
    p.hl[0] = Math.min(p.hl[0], p.f - 0.001);
    p.hr[0] = Math.max(p.hr[0], p.f + 0.001);
    calcHandle(p, prev, next, smoothing);
    // Extrémités automatiques : poignées horizontales (extrapolation constante).
    if (isAutoH(p) && (i === 0 || i === n - 1)) {
      p.hl[1] = p.hr[1] = p.v;
      p.autoNormal = false;
    }
    if (prev && prev.f >= p.f) prev.autoNormal = p.autoNormal = false;
  }
  if (smoothing !== 'NONE') smoothFCurve(pts);
  return pts;
}

function finiteOr(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

// ------------------------------------------------------------------ évaluation

const SMALL = -1.0e-10;
const inUnit = (t: number) => t >= SMALL && t <= 1.000001;

/** Racines dans [0, 1] de c0 + c1 t + c2 t² + c3 t³ (solve_cubic de Blender). */
function solveCubic(c0: number, c1: number, c2: number, c3: number, o: number[]): number {
  let nr = 0;
  if (c3 !== 0) {
    let a = c2 / c3;
    const b = c1 / c3;
    const c = c0 / c3;
    a = a / 3;
    let p = b / 3 - a * a;
    let q = (2 * a * a * a - a * b + c) / 2;
    const d = q * q + p * p * p;
    if (d > 0) {
      const t = Math.sqrt(d);
      o[0] = Math.cbrt(-q + t) + Math.cbrt(-q - t) - a;
      return inUnit(o[0]) ? 1 : 0;
    }
    if (d === 0) {
      const t = Math.cbrt(-q);
      o[0] = 2 * t - a;
      if (inUnit(o[0])) nr++;
      o[nr] = -t - a;
      return inUnit(o[nr]) ? nr + 1 : nr;
    }
    const phi = Math.acos(-q / Math.sqrt(-(p * p * p)));
    const t = Math.sqrt(-p);
    p = Math.cos(phi / 3);
    q = Math.sqrt(3 - 3 * p * p);
    o[0] = 2 * t * p - a;
    if (inUnit(o[0])) nr++;
    o[nr] = -t * (p + q) - a;
    if (inUnit(o[nr])) nr++;
    o[nr] = -t * (p - q) - a;
    return inUnit(o[nr]) ? nr + 1 : nr;
  }
  const a = c2;
  const b = c1;
  const c = c0;
  if (a !== 0) {
    let p = b * b - 4 * a * c;
    if (p > 0) {
      p = Math.sqrt(p);
      o[0] = (-b - p) / (2 * a);
      if (inUnit(o[0])) nr++;
      o[nr] = (-b + p) / (2 * a);
      return inUnit(o[nr]) ? nr + 1 : nr;
    }
    if (p === 0) {
      o[0] = -b / (2 * a);
      if (inUnit(o[0])) return 1;
    }
    return 0;
  }
  if (b !== 0) {
    o[0] = -c / b;
    return inUnit(o[0]) ? 1 : 0;
  }
  if (c === 0) {
    o[0] = 0;
    return 1;
  }
  return 0;
}

const FLT_EPSILON = 1.1920929e-7;
const roots: number[] = [0, 0, 0];

/** Segment bezier entre deux points (avec correction des poignées qui dépassent l'intervalle). */
export function bezierSegment(a: BezPoint, b: BezPoint, time: number): number {
  const v1x = a.f;
  const v1y = a.v;
  let v2x = a.hr[0];
  let v2y = a.hr[1];
  let v3x = b.hl[0];
  let v3y = b.hl[1];
  const v4x = b.f;
  const v4y = b.v;
  if (Math.abs(v1y - v4y) < FLT_EPSILON && Math.abs(v2y - v3y) < FLT_EPSILON && Math.abs(v3y - v4y) < FLT_EPSILON) return v1y;
  // BKE_fcurve_correct_bezpart : une poignée ne dépasse jamais l'image de la clé voisine.
  const h1x = v1x - v2x;
  const h1y = v1y - v2y;
  const h2x = v4x - v3x;
  const h2y = v4y - v3y;
  const len = v4x - v1x;
  const len1 = Math.abs(h1x);
  const len2 = Math.abs(h2x);
  if (len1 + len2 !== 0) {
    if (len1 > len) {
      const fac = len / len1;
      v2x = v1x - fac * h1x;
      v2y = v1y - fac * h1y;
    }
    if (len2 > len) {
      const fac = len / len2;
      v3x = v4x - fac * h2x;
      v3y = v4y - fac * h2y;
    }
  }
  const c0 = v1x - time;
  const c1 = 3 * (v2x - v1x);
  const c2 = 3 * (v1x - 2 * v2x + v3x);
  const c3 = v4x - v1x + 3 * (v2x - v3x);
  if (!solveCubic(c0, c1, c2, c3, roots)) return 0;
  const t = roots[0];
  const y1 = 3 * (v2y - v1y);
  const y2 = 3 * (v1y - 2 * v2y + v3y);
  const y3 = v4y - v1y + 3 * (v2y - v3y);
  return v1y + t * y1 + t * t * y2 + t * t * t * y3;
}

/** Valeur de la courbe à l'image `frame` (extrapolation constante). null si la courbe est vide. */
export function evaluatePoints(pts: readonly BezPoint[], frame: number): number | null {
  const n = pts.length;
  if (n === 0) return null;
  if (frame <= pts[0].f) return pts[0].v;
  if (frame >= pts[n - 1].f) return pts[n - 1].v;
  // recherche dichotomique du segment
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].f <= frame) lo = mid;
    else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  if (Math.abs(frame - a.f) <= 0.0001) return a.v;
  if (Math.abs(frame - b.f) <= 0.0001) return b.v;
  const begin = a.v;
  const change = b.v - a.v;
  const duration = b.f - a.f;
  const time = frame - a.f;
  if (a.ipo === 'CONSTANT' || duration === 0) return a.v;
  if (a.ipo === 'BEZIER') return bezierSegment(a, b, frame);
  if (a.ipo === 'LINEAR') return (change * time) / duration + begin;
  return easeSegment(a.ipo, a.easing, time, begin, change, duration) ?? a.v;
}

// ------------------------------------------------------------------ courbe complète

export interface CurveEval {
  /** Clés effectives triées par image. */
  keys: KeyframeData[];
  /** Clés masquées par la règle de fusion. */
  shadowed: KeyframeData[];
  points: BezPoint[];
}

export function buildCurve(raw: Iterable<KeyframeData>, smoothing: CurveSmoothing = 'CONT_ACCEL'): CurveEval {
  const { keys, shadowed } = resolveKeys(raw);
  return { keys, shadowed, points: computePoints(keys, smoothing) };
}

/** Clé effective à l'image donnée (à ANIM_FRAME_EPS près), ou null. */
export function keyAtFrame(keys: readonly KeyframeData[], frame: number): KeyframeData | null {
  for (const k of keys) if (Math.abs(k.frame - frame) < ANIM_FRAME_EPS) return k;
  return null;
}
