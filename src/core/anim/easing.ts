import type { Easing, Interpolation } from '../doc/schema';

/**
 * Fonctions d'atténuation (Robert Penner), transcrites de Blender (blenlib/intern/easing.cc).
 * Signature commune : (temps écoulé, valeur de départ, variation, durée).
 */

type EaseFn = (t: number, b: number, c: number, d: number) => number;

/** Paramètres par défaut des clés de Blender (BezTriple.back / amplitude / period). */
export const BACK_OVERSHOOT = 1.70158;
export const ELASTIC_AMPLITUDE = 0.8;
export const ELASTIC_PERIOD = 4.1;

const backIn = (t: number, b: number, c: number, d: number, s = BACK_OVERSHOOT) => {
  t /= d;
  return c * t * t * ((s + 1) * t - s) + b;
};
const backOut = (t: number, b: number, c: number, d: number, s = BACK_OVERSHOOT) => {
  t = t / d - 1;
  return c * (t * t * ((s + 1) * t + s) + 1) + b;
};
const backInOut = (t: number, b: number, c: number, d: number, s = BACK_OVERSHOOT) => {
  s *= 1.525;
  if ((t /= d / 2) < 1) return (c / 2) * (t * t * ((s + 1) * t - s)) + b;
  t -= 2;
  return (c / 2) * (t * t * ((s + 1) * t + s) + 2) + b;
};

const bounceOut: EaseFn = (t, b, c, d) => {
  t /= d;
  if (t < 1 / 2.75) return c * (7.5625 * t * t) + b;
  if (t < 2 / 2.75) {
    t -= 1.5 / 2.75;
    return c * (7.5625 * t * t + 0.75) + b;
  }
  if (t < 2.5 / 2.75) {
    t -= 2.25 / 2.75;
    return c * (7.5625 * t * t + 0.9375) + b;
  }
  t -= 2.625 / 2.75;
  return c * (7.5625 * t * t + 0.984375) + b;
};
const bounceIn: EaseFn = (t, b, c, d) => c - bounceOut(d - t, 0, c, d) + b;
const bounceInOut: EaseFn = (t, b, c, d) => {
  if (t < d / 2) return bounceIn(t * 2, 0, c, d) * 0.5 + b;
  return bounceOut(t * 2 - d, 0, c, d) * 0.5 + c * 0.5 + b;
};

const circIn: EaseFn = (t, b, c, d) => {
  t /= d;
  return -c * (Math.sqrt(1 - t * t) - 1) + b;
};
const circOut: EaseFn = (t, b, c, d) => {
  t = t / d - 1;
  return c * Math.sqrt(1 - t * t) + b;
};
const circInOut: EaseFn = (t, b, c, d) => {
  if ((t /= d / 2) < 1) return (-c / 2) * (Math.sqrt(1 - t * t) - 1) + b;
  t -= 2;
  return (c / 2) * (Math.sqrt(1 - t * t) + 1) + b;
};

const cubicIn: EaseFn = (t, b, c, d) => {
  t /= d;
  return c * t * t * t + b;
};
const cubicOut: EaseFn = (t, b, c, d) => {
  t = t / d - 1;
  return c * (t * t * t + 1) + b;
};
const cubicInOut: EaseFn = (t, b, c, d) => {
  if ((t /= d / 2) < 1) return (c / 2) * t * t * t + b;
  t -= 2;
  return (c / 2) * (t * t * t + 2) + b;
};

/** Raccord progressif du début de l'oscillation élastique (USE_ELASTIC_BLEND de Blender). */
function elasticBlend(time: number, change: number, duration: number, amplitude: number, s: number, f: number): number {
  if (change) {
    const t = Math.abs(s);
    if (amplitude) f *= amplitude / Math.abs(change);
    else f = 0;
    if (Math.abs(time * duration) < t) {
      const l = Math.abs(time * duration) / t;
      f = f * l + (1 - l);
    }
  }
  return f;
}

function elasticIn(time: number, begin: number, change: number, duration: number, amplitude = ELASTIC_AMPLITUDE, period = ELASTIC_PERIOD): number {
  let s: number;
  let f = 1;
  if (time === 0) return begin;
  if ((time /= duration) === 1) return begin + change;
  time -= 1;
  if (!period) period = duration * 0.3;
  if (!amplitude || amplitude < Math.abs(change)) {
    s = period / 4;
    f = elasticBlend(time, change, duration, amplitude, s, f);
    amplitude = change;
  } else s = (period / (2 * Math.PI)) * Math.asin(change / amplitude);
  return -f * (amplitude * Math.pow(2, 10 * time) * Math.sin(((time * duration - s) * (2 * Math.PI)) / period)) + begin;
}

function elasticOut(time: number, begin: number, change: number, duration: number, amplitude = ELASTIC_AMPLITUDE, period = ELASTIC_PERIOD): number {
  let s: number;
  let f = 1;
  if (time === 0) return begin;
  if ((time /= duration) === 1) return begin + change;
  time = -time;
  if (!period) period = duration * 0.3;
  if (!amplitude || amplitude < Math.abs(change)) {
    s = period / 4;
    f = elasticBlend(time, change, duration, amplitude, s, f);
    amplitude = change;
  } else s = (period / (2 * Math.PI)) * Math.asin(change / amplitude);
  return f * (amplitude * Math.pow(2, 10 * time) * Math.sin(((time * duration - s) * (2 * Math.PI)) / period)) + change + begin;
}

function elasticInOut(time: number, begin: number, change: number, duration: number, amplitude = ELASTIC_AMPLITUDE, period = ELASTIC_PERIOD): number {
  let s: number;
  let f = 1;
  if (time === 0) return begin;
  if ((time /= duration / 2) === 2) return begin + change;
  time -= 1;
  if (!period) period = duration * (0.3 * 1.5);
  if (!amplitude || amplitude < Math.abs(change)) {
    s = period / 4;
    f = elasticBlend(time, change, duration, amplitude, s, f);
    amplitude = change;
  } else s = (period / (2 * Math.PI)) * Math.asin(change / amplitude);
  if (time < 0) {
    f *= -0.5;
    return f * (amplitude * Math.pow(2, 10 * time) * Math.sin(((time * duration - s) * (2 * Math.PI)) / period)) + begin;
  }
  time = -time;
  f *= 0.5;
  return f * (amplitude * Math.pow(2, 10 * time) * Math.sin(((time * duration - s) * (2 * Math.PI)) / period)) + change + begin;
}

const POW_MIN = 0.0009765625; // 2^-10
const POW_SCALE = 1 / (1 - 0.0009765625);
const expoIn: EaseFn = (t, b, c, d) => (t === 0 ? b : c * (Math.pow(2, 10 * (t / d - 1)) - POW_MIN) * POW_SCALE + b);
const expoOut: EaseFn = (t, b, c, d) => (t === 0 ? b : c * (1 - (Math.pow(2, (-10 * t) / d) - POW_MIN) * POW_SCALE) + b);
const expoInOut: EaseFn = (t, b, c, d) => {
  const dh = d / 2;
  const ch = c / 2;
  if (t <= dh) return expoIn(t, b, ch, dh);
  return expoOut(t - dh, b + ch, ch, dh);
};

const quadIn: EaseFn = (t, b, c, d) => {
  t /= d;
  return c * t * t + b;
};
const quadOut: EaseFn = (t, b, c, d) => {
  t /= d;
  return -c * t * (t - 2) + b;
};
const quadInOut: EaseFn = (t, b, c, d) => {
  if ((t /= d / 2) < 1) return (c / 2) * t * t + b;
  t -= 1;
  return (-c / 2) * (t * (t - 2) - 1) + b;
};

const quartIn: EaseFn = (t, b, c, d) => {
  t /= d;
  return c * t * t * t * t + b;
};
const quartOut: EaseFn = (t, b, c, d) => {
  t = t / d - 1;
  return -c * (t * t * t * t - 1) + b;
};
const quartInOut: EaseFn = (t, b, c, d) => {
  if ((t /= d / 2) < 1) return (c / 2) * t * t * t * t + b;
  t -= 2;
  return (-c / 2) * (t * t * t * t - 2) + b;
};

const quintIn: EaseFn = (t, b, c, d) => {
  t /= d;
  return c * t * t * t * t * t + b;
};
const quintOut: EaseFn = (t, b, c, d) => {
  t = t / d - 1;
  return c * (t * t * t * t * t + 1) + b;
};
const quintInOut: EaseFn = (t, b, c, d) => {
  if ((t /= d / 2) < 1) return (c / 2) * t * t * t * t * t + b;
  t -= 2;
  return (c / 2) * (t * t * t * t * t + 2) + b;
};

const sineIn: EaseFn = (t, b, c, d) => -c * Math.cos((t / d) * (Math.PI / 2)) + c + b;
const sineOut: EaseFn = (t, b, c, d) => c * Math.sin((t / d) * (Math.PI / 2)) + b;
const sineInOut: EaseFn = (t, b, c, d) => (-c / 2) * (Math.cos((Math.PI * t) / d) - 1) + b;

/** [entrée, sortie, entrée-sortie, choix de « Auto »] par interpolation dynamique. */
const TABLE: Partial<Record<Interpolation, [EaseFn, EaseFn, EaseFn, 'in' | 'out']>> = {
  SINE: [sineIn, sineOut, sineInOut, 'in'],
  QUAD: [quadIn, quadOut, quadInOut, 'in'],
  CUBIC: [cubicIn, cubicOut, cubicInOut, 'in'],
  QUART: [quartIn, quartOut, quartInOut, 'in'],
  QUINT: [quintIn, quintOut, quintInOut, 'in'],
  EXPO: [expoIn, expoOut, expoInOut, 'in'],
  CIRC: [circIn, circOut, circInOut, 'in'],
  BACK: [(t, b, c, d) => backIn(t, b, c, d), (t, b, c, d) => backOut(t, b, c, d), (t, b, c, d) => backInOut(t, b, c, d), 'out'],
  BOUNCE: [bounceIn, bounceOut, bounceInOut, 'out'],
  ELASTIC: [(t, b, c, d) => elasticIn(t, b, c, d), (t, b, c, d) => elasticOut(t, b, c, d), (t, b, c, d) => elasticInOut(t, b, c, d), 'out'],
};

/**
 * Valeur d'un segment à interpolation dynamique. « Auto » vaut « entrée » pour SINE…CIRC et
 * « sortie » pour BACK, BOUNCE, ELASTIC (comme Blender). Renvoie null si `ipo` n'est pas dynamique.
 */
export function easeSegment(ipo: Interpolation, easing: Easing, time: number, begin: number, change: number, duration: number): number | null {
  const row = TABLE[ipo];
  if (!row) return null;
  const mode = easing === 'AUTO' ? row[3] : easing === 'EASE_IN' ? 'in' : easing === 'EASE_OUT' ? 'out' : 'inout';
  const fn = mode === 'in' ? row[0] : mode === 'out' ? row[1] : row[2];
  return fn(time, begin, change, duration);
}

/** Interpolations dynamiques (celles qui utilisent l'atténuation). */
export const DYNAMIC_INTERPOLATIONS: Interpolation[] = Object.keys(TABLE) as Interpolation[];
