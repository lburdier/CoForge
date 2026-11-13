/**
 * Évaluation CPU (JavaScript) des textures et fonctions des nœuds de shader : transposition
 * EXACTE de la bibliothèque GLSL (shaderGlsl.ts / shader/glsl.ts), elle-même reprise des shaders
 * de Blender (même hachage Jenkins lookup3, même bruit de Perlin). Sert au repli constant
 * (`evaluateShaderConstants`, path tracing, export) et aux tests.
 */

export type V3 = [number, number, number];

// ------------------------------------------------------------------ hachage (Jenkins lookup3)

const rot = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;

function final(a: number, b: number, c: number): number {
  c = (c ^ b) >>> 0; c = (c - rot(b, 14)) >>> 0;
  a = (a ^ c) >>> 0; a = (a - rot(c, 11)) >>> 0;
  b = (b ^ a) >>> 0; b = (b - rot(a, 25)) >>> 0;
  c = (c ^ b) >>> 0; c = (c - rot(b, 16)) >>> 0;
  a = (a ^ c) >>> 0; a = (a - rot(c, 4)) >>> 0;
  b = (b ^ a) >>> 0; b = (b - rot(a, 14)) >>> 0;
  c = (c ^ b) >>> 0; c = (c - rot(b, 24)) >>> 0;
  return c;
}

function mix3(a: number, b: number, c: number): [number, number, number] {
  a = (a - c) >>> 0; a = (a ^ rot(c, 4)) >>> 0; c = (c + b) >>> 0;
  b = (b - a) >>> 0; b = (b ^ rot(a, 6)) >>> 0; a = (a + c) >>> 0;
  c = (c - b) >>> 0; c = (c ^ rot(b, 8)) >>> 0; b = (b + a) >>> 0;
  a = (a - c) >>> 0; a = (a ^ rot(c, 16)) >>> 0; c = (c + b) >>> 0;
  b = (b - a) >>> 0; b = (b ^ rot(a, 19)) >>> 0; a = (a + c) >>> 0;
  c = (c - b) >>> 0; c = (c ^ rot(b, 4)) >>> 0; b = (b + a) >>> 0;
  return [a, b, c];
}

const INIT = (n: number) => (0xdeadbeef + (n << 2) + 13) >>> 0;

export function hashUint(kx: number): number {
  const a = (INIT(1) + kx) >>> 0;
  return final(a, INIT(1), INIT(1));
}
export function hashUint2(kx: number, ky: number): number {
  const i = INIT(2);
  return final((i + kx) >>> 0, (i + ky) >>> 0, i);
}
export function hashUint3(kx: number, ky: number, kz: number): number {
  const i = INIT(3);
  return final((i + kx) >>> 0, (i + ky) >>> 0, (i + kz) >>> 0);
}
export function hashUint4(kx: number, ky: number, kz: number, kw: number): number {
  const i = INIT(4);
  let [a, b, c] = mix3((i + kx) >>> 0, (i + ky) >>> 0, (i + kz) >>> 0);
  a = (a + kw) >>> 0;
  return final(a, b, c);
}

const fbuf = new Float32Array(1);
const ubuf = new Uint32Array(fbuf.buffer);
/** floatBitsToUint de GLSL (sur un flottant 32 bits). */
export function floatBits(x: number): number {
  fbuf[0] = x;
  return ubuf[0];
}
const U = 4294967295;
export const hashFloat = (k: number) => hashUint(floatBits(k)) / U;
export const hashVec3 = (k: V3) => hashUint3(floatBits(k[0]), floatBits(k[1]), floatBits(k[2])) / U;
export const hashVec4 = (x: number, y: number, z: number, w: number) => hashUint4(floatBits(x), floatBits(y), floatBits(z), floatBits(w)) / U;
export const hashVec3ToVec3 = (k: V3): V3 => [hashVec3(k), hashVec4(k[0], k[1], k[2], 1), hashVec4(k[0], k[1], k[2], 2)];
const randOffset = (seed: number) => 100 + hashFloat(seed) * 100;
const randVec3Offset = (seed: number): V3 => [randOffset(seed), randOffset(seed + 1), randOffset(seed + 2)];

// ------------------------------------------------------------------ bruit de Perlin (Blender)

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
function grad(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const vt = h === 12 || h === 14 ? x : z;
  const v = h < 4 ? y : vt;
  return (h & 1 ? -u : u) + (h & 2 ? -v : v);
}
function triMix(v0: number, v1: number, v2: number, v3: number, v4: number, v5: number, v6: number, v7: number, x: number, y: number, z: number): number {
  const x1 = 1 - x, y1 = 1 - y, z1 = 1 - z;
  return z1 * (y1 * (v0 * x1 + v1 * x) + y * (v2 * x1 + v3 * x)) + z * (y1 * (v4 * x1 + v5 * x) + y * (v6 * x1 + v7 * x));
}
export function perlin(p: V3): number {
  const fl = [Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[2])];
  // Même arithmétique que GLSL : calculs en flottants 32 bits.
  const fx = Math.fround(p[0] - fl[0]), fy = Math.fround(p[1] - fl[1]), fz = Math.fround(p[2] - fl[2]);
  const X = fl[0] >>> 0, Y = fl[1] >>> 0, Z = fl[2] >>> 0;
  const X1 = (X + 1) >>> 0, Y1 = (Y + 1) >>> 0, Z1 = (Z + 1) >>> 0;
  return triMix(
    grad(hashUint3(X, Y, Z), fx, fy, fz),
    grad(hashUint3(X1, Y, Z), fx - 1, fy, fz),
    grad(hashUint3(X, Y1, Z), fx, fy - 1, fz),
    grad(hashUint3(X1, Y1, Z), fx - 1, fy - 1, fz),
    grad(hashUint3(X, Y, Z1), fx, fy, fz - 1),
    grad(hashUint3(X1, Y, Z1), fx - 1, fy, fz - 1),
    grad(hashUint3(X, Y1, Z1), fx, fy - 1, fz - 1),
    grad(hashUint3(X1, Y1, Z1), fx - 1, fy - 1, fz - 1),
    fade(fx), fade(fy), fade(fz),
  );
}
export const snoise = (p: V3) => 0.982 * perlin(p);

const sc = (p: V3, s: number): V3 => [p[0] * s, p[1] * s, p[2] * s];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function fbm(p: V3, detail: number, roughness: number, lacunarity: number, normalize: boolean): number {
  let fscale = 1, amp = 1, maxamp = 0, sum = 0;
  detail = clamp(detail, 0, 15);
  const n = Math.floor(detail);
  const r = clamp(roughness, 0, 1);
  for (let i = 0; i <= n; i++) {
    const t = snoise(sc(p, fscale));
    sum += t * amp;
    maxamp += amp;
    amp *= r;
    fscale *= lacunarity;
  }
  const rmd = detail - Math.floor(detail);
  if (rmd !== 0) {
    const t = snoise(sc(p, fscale));
    const sum2 = sum + t * amp;
    return normalize ? lerp((0.5 * sum) / maxamp + 0.5, (0.5 * sum2) / (maxamp + amp) + 0.5, rmd) : lerp(sum, sum2, rmd);
  }
  return normalize ? (0.5 * sum) / maxamp + 0.5 : sum;
}

export function multiFractal(p: V3, detail: number, roughness: number, lacunarity: number): number {
  let value = 1, pwr = 1;
  detail = clamp(detail, 0, 15);
  for (let i = 0; i <= Math.floor(detail); i++) {
    value *= pwr * snoise(p) + 1;
    pwr *= roughness;
    p = sc(p, lacunarity);
  }
  const rmd = detail - Math.floor(detail);
  if (rmd !== 0) value *= rmd * pwr * snoise(p) + 1;
  return value;
}

export function heteroTerrain(p: V3, detail: number, roughness: number, lacunarity: number, offset: number): number {
  detail = clamp(detail, 0, 15);
  let pwr = roughness;
  let value = offset + snoise(p);
  p = sc(p, lacunarity);
  for (let i = 1; i <= Math.floor(detail); i++) {
    value += (snoise(p) + offset) * pwr * value;
    pwr *= roughness;
    p = sc(p, lacunarity);
  }
  const rmd = detail - Math.floor(detail);
  if (rmd !== 0) value += rmd * ((snoise(p) + offset) * pwr * value);
  return value;
}

export function hybridMultiFractal(p: V3, detail: number, roughness: number, lacunarity: number, offset: number, gain: number): number {
  detail = clamp(detail, 0, 15);
  let pwr = 1, value = 0, weight = 1;
  for (let i = 0; weight > 0.001 && i <= Math.floor(detail); i++) {
    if (weight > 1) weight = 1;
    const signal = (snoise(p) + offset) * pwr;
    pwr *= roughness;
    value += weight * signal;
    weight *= gain * signal;
    p = sc(p, lacunarity);
  }
  const rmd = detail - Math.floor(detail);
  if (rmd !== 0 && weight > 0.001) {
    if (weight > 1) weight = 1;
    value += rmd * weight * ((snoise(p) + offset) * pwr);
  }
  return value;
}

export function ridgedMultiFractal(p: V3, detail: number, roughness: number, lacunarity: number, offset: number, gain: number): number {
  detail = clamp(detail, 0, 15);
  let pwr = roughness;
  let signal = offset - Math.abs(snoise(p));
  signal *= signal;
  let value = signal;
  let weight = 1;
  for (let i = 1; i <= Math.floor(detail); i++) {
    p = sc(p, lacunarity);
    weight = clamp(signal * gain, 0, 1);
    signal = offset - Math.abs(snoise(p));
    signal *= signal;
    signal *= weight;
    value += signal * pwr;
    pwr *= roughness;
  }
  return value;
}

/** Types de bruit : 0 multifractal, 1 multifractal à crêtes, 2 hybride, 3 fBM, 4 terrain hétérogène. */
export function noiseFractal(type: number, p: V3, detail: number, roughness: number, lacunarity: number, offset: number, gain: number, normalize: boolean): number {
  switch (type) {
    case 0:
      return multiFractal(p, detail, roughness, lacunarity);
    case 1:
      return ridgedMultiFractal(p, detail, roughness, lacunarity, offset, gain);
    case 2:
      return hybridMultiFractal(p, detail, roughness, lacunarity, offset, gain);
    case 4:
      return heteroTerrain(p, detail, roughness, lacunarity, offset);
    default:
      return fbm(p, detail, roughness, lacunarity, normalize);
  }
}

export function texNoise(co: V3, w: number, scale: number, detail: number, roughness: number, lacunarity: number, offset: number, gain: number, distortion: number, type: number, normalize: boolean): [number, V3] {
  let p: V3 = add(sc(co, scale), [0, 0, w * scale * 0.618]);
  if (distortion !== 0) {
    p = add(p, [snoise(add(p, randVec3Offset(0))) * distortion, snoise(add(p, randVec3Offset(1))) * distortion, snoise(add(p, randVec3Offset(2))) * distortion]);
  }
  const fac = noiseFractal(type, p, detail, roughness, lacunarity, offset, gain, normalize);
  return [fac, [fac, noiseFractal(type, add(p, randVec3Offset(3)), detail, roughness, lacunarity, offset, gain, normalize), noiseFractal(type, add(p, randVec3Offset(4)), detail, roughness, lacunarity, offset, gain, normalize)]];
}

// ------------------------------------------------------------------ Voronoï (3D, fractal)

function vdist(a: V3, b: V3, metric: number, e: number): number {
  const d = [Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])];
  if (metric === 1) return d[0] + d[1] + d[2];
  if (metric === 2) return Math.max(d[0], d[1], d[2]);
  if (metric === 3) return Math.pow(Math.pow(d[0], e) + Math.pow(d[1], e) + Math.pow(d[2], e), 1 / e);
  return Math.hypot(d[0], d[1], d[2]);
}

/** Un octave : distance, couleur, position (dans l'espace des cellules). feature : 0 F1, 1 F2, 2 F1 adouci. */
export function voronoiBase(coord: V3, smoothness: number, exponent: number, randomness: number, feature: number, metric: number): [number, V3, V3] {
  const cell: V3 = [Math.floor(coord[0]), Math.floor(coord[1]), Math.floor(coord[2])];
  const local: V3 = [coord[0] - cell[0], coord[1] - cell[1], coord[2] - cell[2]];
  randomness = clamp(randomness, 0, 1);
  if (feature === 2) {
    const s = clamp(smoothness / 2, 0, 0.5);
    let sd = 8;
    let scol: V3 = [0, 0, 0];
    let spos: V3 = [0, 0, 0];
    for (let k = -2; k <= 2; k++)
      for (let j = -2; j <= 2; j++)
        for (let i = -2; i <= 2; i++) {
          const cc: V3 = [cell[0] + i, cell[1] + j, cell[2] + k];
          const h = hashVec3ToVec3(cc);
          const pp: V3 = [i + h[0] * randomness, j + h[1] * randomness, k + h[2] * randomness];
          const d = vdist(pp, local, metric, exponent);
          const t = clamp(0.5 + (0.5 * (sd - d)) / Math.max(s, 1e-6), 0, 1);
          const hh = t * t * (3 - 2 * t);
          let corr = s * hh * (1 - hh);
          sd = lerp(sd, d, hh) - corr;
          corr /= 1 + 3 * s;
          scol = [lerp(scol[0], h[0], hh) - corr, lerp(scol[1], h[1], hh) - corr, lerp(scol[2], h[2], hh) - corr];
          spos = [lerp(spos[0], pp[0], hh) - corr, lerp(spos[1], pp[1], hh) - corr, lerp(spos[2], pp[2], hh) - corr];
        }
    return [sd, scol, add(cell, spos)];
  }
  let d1 = 8, d2 = 8;
  let o1: V3 = [0, 0, 0], o2: V3 = [0, 0, 0], p1: V3 = [0, 0, 0], p2: V3 = [0, 0, 0];
  for (let k = -1; k <= 1; k++)
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) {
        const off: V3 = [i, j, k];
        const h = hashVec3ToVec3(add(cell, off));
        const pp: V3 = [i + h[0] * randomness, j + h[1] * randomness, k + h[2] * randomness];
        const d = vdist(pp, local, metric, exponent);
        if (d < d1) {
          d2 = d1; o2 = o1; p2 = p1;
          d1 = d; o1 = off; p1 = pp;
        } else if (d < d2) {
          d2 = d; o2 = off; p2 = pp;
        }
      }
  if (feature === 1) return [d2, hashVec3ToVec3(add(cell, o2)), add(p2, cell)];
  return [d1, hashVec3ToVec3(add(cell, o1)), add(p1, cell)];
}

export function voronoiEdge(coord: V3, randomness: number): number {
  const cell: V3 = [Math.floor(coord[0]), Math.floor(coord[1]), Math.floor(coord[2])];
  const local: V3 = [coord[0] - cell[0], coord[1] - cell[1], coord[2] - cell[2]];
  randomness = clamp(randomness, 0, 1);
  let toClosest: V3 = [0, 0, 0];
  let minDist = 8;
  const vp = (i: number, j: number, k: number): V3 => {
    const h = hashVec3ToVec3([cell[0] + i, cell[1] + j, cell[2] + k]);
    return [i + h[0] * randomness - local[0], j + h[1] * randomness - local[1], k + h[2] * randomness - local[2]];
  };
  for (let k = -1; k <= 1; k++)
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) {
        const v = vp(i, j, k);
        const d = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
        if (d < minDist) {
          minDist = d;
          toClosest = v;
        }
      }
  minDist = 8;
  for (let k = -1; k <= 1; k++)
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) {
        const v = vp(i, j, k);
        const p2c: V3 = [toClosest[0] - v[0], toClosest[1] - v[1], toClosest[2] - v[2]];
        const l = Math.hypot(...p2c);
        if (l * l > 0.0001) {
          const d = ((toClosest[0] + v[0]) / 2) * (p2c[0] / l) + ((toClosest[1] + v[1]) / 2) * (p2c[1] / l) + ((toClosest[2] + v[2]) / 2) * (p2c[2] / l);
          minDist = Math.min(minDist, d);
        }
      }
  return minDist;
}

export function voronoiNSphere(coord: V3, randomness: number): number {
  const cell: V3 = [Math.floor(coord[0]), Math.floor(coord[1]), Math.floor(coord[2])];
  const local: V3 = [coord[0] - cell[0], coord[1] - cell[1], coord[2] - cell[2]];
  randomness = clamp(randomness, 0, 1);
  const pt = (c: V3, off: V3): V3 => {
    const h = hashVec3ToVec3(add(c, off));
    return [off[0] + h[0] * randomness, off[1] + h[1] * randomness, off[2] + h[2] * randomness];
  };
  let closest: V3 = [0, 0, 0];
  let closestOff: V3 = [0, 0, 0];
  let minD = 8;
  for (let k = -1; k <= 1; k++)
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) {
        const p = pt(cell, [i, j, k]);
        const d = Math.hypot(p[0] - local[0], p[1] - local[1], p[2] - local[2]);
        if (d < minD) {
          minD = d;
          closest = p;
          closestOff = [i, j, k];
        }
      }
  minD = 8;
  let toClosest: V3 = [0, 0, 0];
  for (let k = -1; k <= 1; k++)
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) {
        if (i === 0 && j === 0 && k === 0) continue;
        const off: V3 = add([i, j, k], closestOff);
        const p = pt(cell, off);
        const d = Math.hypot(closest[0] - p[0], closest[1] - p[1], closest[2] - p[2]);
        if (d < minD) {
          minD = d;
          toClosest = p;
        }
      }
  return Math.hypot(toClosest[0] - closest[0], toClosest[1] - closest[1], toClosest[2] - closest[2]) / 2;
}

/** Voronoï fractal de Blender 4 (détail, rugosité, lacunarité, normalisation). feature : 0 F1, 1 F2, 2 F1 adouci, 3 bord, 4 N-sphère. */
export function texVoronoi(
  co: V3, scale: number, detail: number, roughness: number, lacunarity: number, smoothness: number, exponent: number, randomness: number, feature: number, metric: number, normalize: boolean,
): [number, V3, V3, number] {
  const coord = sc(co, scale);
  if (feature === 3) return [voronoiEdge(coord, randomness), [0, 0, 0], [0, 0, 0], 0];
  if (feature === 4) return [0, [0, 0, 0], [0, 0, 0], voronoiNSphere(coord, randomness)];
  detail = clamp(detail, 0, 15);
  roughness = clamp(roughness, 0, 1);
  let amp = 1, maxAmp = 0, oscale = 1;
  let dist = 0;
  let col: V3 = [0, 0, 0];
  let pos: V3 = [0, 0, 0];
  const zero = detail === 0 || roughness === 0;
  for (let i = 0; i <= Math.ceil(detail); i++) {
    const [d, c, p] = voronoiBase(sc(coord, oscale), smoothness, exponent, randomness, feature, metric);
    const pp = sc(p, 1 / oscale);
    if (zero) {
      maxAmp = 1;
      dist = d;
      col = c;
      pos = pp;
      break;
    }
    if (i <= detail) {
      maxAmp += amp;
      dist += d * amp;
      col = add(col, sc(c, amp));
      pos = [lerp(pos[0], pp[0], amp), lerp(pos[1], pp[1], amp), lerp(pos[2], pp[2], amp)];
      oscale *= lacunarity;
      amp *= roughness;
    } else {
      const r = detail - Math.floor(detail);
      if (r !== 0) {
        maxAmp = lerp(maxAmp, maxAmp + amp, r);
        dist = lerp(dist, dist + d * amp, r);
        col = [lerp(col[0], col[0] + c[0] * amp, r), lerp(col[1], col[1] + c[1] * amp, r), lerp(col[2], col[2] + c[2] * amp, r)];
        pos = [lerp(pos[0], lerp(pos[0], pp[0], amp), r), lerp(pos[1], lerp(pos[1], pp[1], amp), r), lerp(pos[2], lerp(pos[2], pp[2], amp), r)];
      }
    }
  }
  if (normalize) {
    const maxD = voronoiMaxDistance(metric, exponent, randomness, feature);
    dist /= maxAmp * maxD;
    col = sc(col, 1 / maxAmp);
  } else if (!zero) {
    col = sc(col, 1 / maxAmp);
  }
  return [dist, col, sc(pos, scale !== 0 ? 1 / scale : 0), 0];
}

export function voronoiMaxDistance(metric: number, exponent: number, randomness: number, feature: number): number {
  const base = 0.5 + 0.5 * clamp(randomness, 0, 1);
  const m = metric === 1 ? 3 : metric === 2 ? 1 : metric === 3 ? Math.pow(3, 1 / Math.max(exponent, 1e-3)) : Math.sqrt(3);
  return base * m * (feature === 1 ? 2 : 1);
}

// ------------------------------------------------------------------ autres textures

export function texChecker(co: V3, c1: V3, c2: V3, scale: number): [V3, number] {
  const p = co.map((x) => (x * scale + 0.000001) * 0.999999);
  const xi = Math.abs(Math.floor(p[0])) | 0, yi = Math.abs(Math.floor(p[1])) | 0, zi = Math.abs(Math.floor(p[2])) | 0;
  const check = (xi % 2 === yi % 2) === !!(zi % 2);
  return [check ? c1 : c2, check ? 1 : 0];
}

export function texGradient(p: V3, type: number): number {
  let r: number;
  if (type === 0) r = p[0];
  else if (type === 1) {
    r = Math.max(p[0], 0);
    r *= r;
  } else if (type === 2) {
    r = clamp(p[0], 0, 1);
    const t = r * r;
    r = 3 * t - 2 * t * r;
  } else if (type === 3) r = (p[0] + p[1]) * 0.5;
  else if (type === 6) r = Math.atan2(p[1], p[0]) / (2 * Math.PI) + 0.5;
  else {
    r = Math.max(0.999999 - Math.hypot(...p), 0);
    if (type === 5) r *= r;
  }
  return clamp(r, 0, 1);
}

export function texWave(co: V3, scale: number, distortion: number, detail: number, dscale: number, drough: number, phase: number, wtype: number, bdir: number, rdir: number, profile: number): number {
  const p = co.map((x) => (x * scale + 0.000001) * 0.999999) as V3;
  let n: number;
  if (wtype === 0) n = bdir === 0 ? p[0] * 20 : bdir === 1 ? p[1] * 20 : bdir === 2 ? p[2] * 20 : (p[0] + p[1] + p[2]) * 10;
  else {
    const rp: V3 = rdir === 0 ? [0, p[1], p[2]] : rdir === 1 ? [p[0], 0, p[2]] : rdir === 2 ? [p[0], p[1], 0] : p;
    n = Math.hypot(...rp) * 20;
  }
  n += phase;
  if (distortion !== 0) n += distortion * (fbm(sc(p, dscale), detail, drough, 2, true) * 2 - 1);
  if (profile === 0) return 0.5 + 0.5 * Math.sin(n - 1.5707963);
  n /= 6.28318531;
  if (profile === 1) return n - Math.floor(n);
  return Math.abs(n - Math.floor(n + 0.5)) * 2;
}

export function texMagic(p0: V3, scale: number, dist: number, depth: number): V3 {
  const p = sc(p0, scale);
  let x = Math.sin((p[0] + p[1] + p[2]) * 5);
  let y = Math.cos((-p[0] + p[1] - p[2]) * 5);
  let z = -Math.cos((-p[0] - p[1] + p[2]) * 5);
  if (depth > 0) {
    x *= dist; y *= dist; z *= dist;
    y = -Math.cos(x - y + z); y *= dist;
    if (depth > 1) { x = Math.cos(x - y - z); x *= dist;
    if (depth > 2) { z = Math.sin(-x - y - z); z *= dist;
    if (depth > 3) { x = -Math.cos(-x + y - z); x *= dist;
    if (depth > 4) { y = -Math.sin(-x + y + z); y *= dist;
    if (depth > 5) { y = -Math.cos(-x + y + z); y *= dist;
    if (depth > 6) { x = Math.cos(x + y + z); x *= dist;
    if (depth > 7) { z = Math.sin(x + y - z); z *= dist;
    if (depth > 8) { x = -Math.cos(-x - y + z); x *= dist;
    if (depth > 9) { y = -Math.sin(x - y + z); y *= dist; }}}}}}}}}
  }
  if (dist !== 0) {
    dist *= 2;
    x /= dist; y /= dist; z /= dist;
  }
  return [0.5 - x, 0.5 - y, 0.5 - z];
}

/** Bruit de briques de Blender (svm_brick.h), arithmétique entière 32 bits. */
function brickNoise(n: number): number {
  n = ((n + 1013) & 0x7fffffff) | 0;
  n = ((n >> 13) ^ n) | 0;
  const nn = (Math.imul(n, (Math.imul(Math.imul(n, n), 60493) + 19990303) | 0) + 1376312589) & 0x7fffffff;
  return (0.5 * nn) / 1073741824.0;
}
export function texBrick(
  co: V3, c1: V3, c2: V3, mortarCol: V3, scale: number, mortarSize: number, mortarSmooth: number, bias: number, brickWidth: number, rowHeight: number,
  offsetAmount: number, offsetFreq: number, squashAmount: number, squashFreq: number,
): [V3, number] {
  const p = sc(co, scale);
  const rownum = Math.floor(p[1] / rowHeight) | 0;
  let offset = 0;
  let bw = brickWidth;
  if (offsetFreq && squashFreq) {
    bw *= rownum % squashFreq ? 1 : squashAmount;
    offset = rownum % offsetFreq ? 0 : bw * offsetAmount;
  }
  const bricknum = Math.floor((p[0] + offset) / bw) | 0;
  const x = p[0] + offset - bw * bricknum;
  const y = p[1] - rowHeight * rownum;
  const tint = clamp(brickNoise(((rownum << 16) + (bricknum & 0xffff)) | 0) + bias, 0, 1);
  let minDist = Math.min(x, y, bw - x, rowHeight - y);
  let mortar: number;
  if (minDist >= mortarSize) mortar = 0;
  else if (mortarSmooth === 0) mortar = 1;
  else {
    minDist = 1 - minDist / mortarSize;
    const t = clamp(minDist / mortarSmooth, 0, 1);
    mortar = minDist < mortarSmooth ? t * t * (3 - 2 * t) : 1;
  }
  let col = c1;
  if (mortar !== 1) col = [(1 - tint) * c1[0] + tint * c2[0], (1 - tint) * c1[1] + tint * c2[1], (1 - tint) * c1[2] + tint * c2[2]];
  return [[lerp(col[0], mortarCol[0], mortar), lerp(col[1], mortarCol[1], mortar), lerp(col[2], mortarCol[2], mortar)], mortar];
}

/**
 * Gabor (même principe que Blender : 8 impulsions de noyaux de Gabor par cellule, voisinage 3×3
 * en 2D ou 3×3×3 en 3D, normalisation par l'écart type théorique). Sorties : valeur, phase, intensité.
 */
export function texGabor(co: V3, scale: number, frequency: number, anisotropy: number, orient2d: number, orient3d: V3, is3d: boolean): [number, number, number] {
  const p = sc(co, scale);
  let re = 0, im = 0;
  const cell: V3 = [Math.floor(p[0]), Math.floor(p[1]), is3d ? Math.floor(p[2]) : 0];
  const local: V3 = [p[0] - cell[0], p[1] - cell[1], is3d ? p[2] - cell[2] : 0];
  const ol = Math.hypot(...orient3d) || 1;
  const base3: V3 = [orient3d[0] / ol, orient3d[1] / ol, orient3d[2] / ol];
  const kz = is3d ? 1 : 0;
  for (let k = -kz; k <= kz; k++)
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) {
        const c: V3 = [cell[0] + i, cell[1] + j, cell[2] + k];
        for (let n = 0; n < 8; n++) {
          const h: V3 = [hashVec4(c[0], c[1], c[2], n + 16), hashVec4(c[0], c[1], c[2], n + 24), hashVec4(c[0], c[1], c[2], n + 32)];
          const center: V3 = [i + h[0], j + h[1], k * kz + (is3d ? h[2] : 0)];
          const d: V3 = [local[0] - center[0], local[1] - center[1], local[2] - center[2]];
          const d2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
          if (d2 >= 1) continue;
          const rnd = (hashVec4(c[0], c[1], c[2], n) - 0.5) * 2 * Math.PI * (1 - clamp(anisotropy, 0, 1));
          let dir: V3;
          if (is3d) dir = base3;
          else {
            const a = orient2d + rnd;
            dir = [Math.cos(a), Math.sin(a), 0];
          }
          const weight = hashVec4(c[0], c[1], c[2], n + 8) < 0.5 ? -1 : 1;
          const env = (0.5 + 0.5 * Math.cos(Math.PI * d2)) * Math.exp(-Math.PI * d2);
          const ph = 2 * Math.PI * frequency * (d[0] * dir[0] + d[1] * dir[1] + d[2] * dir[2]);
          re += weight * env * Math.cos(ph);
          im += weight * env * Math.sin(ph);
        }
      }
  const sd = Math.sqrt(8 * 0.25) * 0.35 * (is3d ? 1.6 : 1);
  return [clamp(im / (6 * sd) * 0.5 + 0.5, 0, 1), (Math.atan2(im, re) + Math.PI) / (2 * Math.PI), clamp(Math.hypot(re, im) / (6 * sd), 0, 1)];
}

// ------------------------------------------------------------------ lumière et couleur

export function fresnelDielectricCos(cosi: number, eta: number): number {
  const c = Math.abs(cosi);
  let g = eta * eta - 1 + c * c;
  if (g > 0) {
    g = Math.sqrt(g);
    const A = (g - c) / (g + c);
    const B = (c * (g + c) - 1) / (c * (g - c) + 1);
    return 0.5 * A * A * (1 + B * B);
  }
  return 1;
}

export function layerWeight(blend: number, cosi: number, back: boolean): [number, number] {
  const eta = Math.max(1 - blend, 0.00001);
  const fr = fresnelDielectricCos(cosi, back ? eta : 1 / eta);
  let facing = Math.abs(cosi);
  if (blend !== 0.5) {
    let b = clamp(blend, 0, 0.99999);
    b = b < 0.5 ? 2 * b : 0.5 / (1 - b);
    facing = Math.pow(facing, b);
  }
  return [fr, 1 - facing];
}

/** Corps noir → couleur linéaire (formule de Tanner Helland, normalisée au maximum). */
export function blackbody(t: number): V3 {
  const k = clamp(t, 800, 40000) / 100;
  let r: number, g: number, b: number;
  if (k <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(k) - 161.1195681661;
    b = k <= 19 ? 0 : 138.5177312231 * Math.log(k - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(k - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(k - 60, -0.0755148492);
    b = 255;
  }
  const lin = [r, g, b].map((x) => {
    const s = clamp(x, 0, 255) / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  const m = Math.max(...lin, 1e-6);
  return [lin[0] / m, lin[1] / m, lin[2] / m];
}

/** Longueur d'onde (nm) → couleur linéaire Rec.709 (ajustement multi-lobes des fonctions CIE 1931). */
export function wavelengthToRgb(nm: number): V3 {
  const g = (x: number, mu: number, s1: number, s2: number) => {
    const t = (x - mu) / (x < mu ? s1 : s2);
    return Math.exp(-0.5 * t * t);
  };
  const X = 1.056 * g(nm, 599.8, 37.9, 31.0) + 0.362 * g(nm, 442.0, 16.0, 26.7) - 0.065 * g(nm, 501.1, 20.4, 26.2);
  const Y = 0.821 * g(nm, 568.8, 46.9, 40.5) + 0.286 * g(nm, 530.9, 16.3, 31.1);
  const Z = 1.217 * g(nm, 437.0, 11.8, 36.0) + 0.681 * g(nm, 459.0, 26.0, 13.8);
  const r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  const gg = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  const b = 0.0557 * X - 0.204 * Y + 1.057 * Z;
  return [Math.max(r, 0), Math.max(gg, 0), Math.max(b, 0)];
}

/** Ciel analytique simplifié : direction (Z vers le haut), élévation et rotation du soleil (radians). */
export function skyColor(d: V3, elevation: number, rotation: number, sunDisc: boolean, sunSize: number, sunIntensity: number): V3 {
  const l = Math.hypot(...d) || 1;
  const z = d[2] / l;
  const sun: V3 = [Math.cos(elevation) * Math.sin(rotation), -Math.cos(elevation) * Math.cos(rotation), Math.sin(elevation)];
  const day = clamp(Math.sin(elevation) * 3 + 0.3, 0.02, 1);
  const zenith: V3 = [0.12 * day, 0.25 * day, 0.6 * day];
  const horizon: V3 = [0.55 * day, 0.6 * day, 0.7 * day];
  const t = Math.pow(clamp(z, 0, 1), 0.45);
  const base: V3 = z < 0 ? [0.08 * day, 0.08 * day, 0.08 * day] : [lerp(horizon[0], zenith[0], t), lerp(horizon[1], zenith[1], t), lerp(horizon[2], zenith[2], t)];
  const cosA = (d[0] * sun[0] + d[1] * sun[1] + d[2] * sun[2]) / l;
  const halo = Math.pow(clamp(cosA, 0, 1), 16) * 0.4 * day;
  const disc = sunDisc && cosA > Math.cos(Math.max(sunSize, 1e-4) / 2) ? 50 * sunIntensity : 0;
  return [base[0] + halo + disc, base[1] + halo * 0.9 + disc, base[2] + halo * 0.7 + disc * 0.9];
}

// ------------------------------------------------------------------ courbes

export interface CurvePts {
  x: number[];
  y: number[];
  m: number[];
}

/** Prépare une courbe (points triés, pentes de Fritsch-Carlson : cubique monotone). */
export function prepareCurve(points: unknown): CurvePts {
  const list = Array.isArray(points) ? points : [];
  const pts = list
    .map((p) => ({ x: Number((p as { x?: unknown })?.x), y: Number((p as { y?: unknown })?.y), v: (p as { handle?: unknown })?.handle === 'VECTOR' }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .sort((a, b) => a.x - b.x);
  if (pts.length === 0) pts.push({ x: 0, y: 0, v: false }, { x: 1, y: 1, v: false });
  if (pts.length === 1) pts.push({ x: pts[0].x + 1, y: pts[0].y, v: false });
  const n = pts.length;
  const x = pts.map((p) => p.x);
  const y = pts.map((p) => p.y);
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push(x[i + 1] - x[i] > 1e-9 ? (y[i + 1] - y[i]) / (x[i + 1] - x[i]) : 0);
  const m: number[] = new Array(n).fill(0);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i], b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  pts.forEach((p, i) => {
    if (p.v) m[i] = i < n - 1 ? d[i] : d[n - 2];
  });
  return { x, y, m };
}

/** Évalue une courbe préparée (extrapolation horizontale, comme Blender par défaut). */
export function evalCurve(c: CurvePts, t: number): number {
  const { x, y, m } = c;
  const n = x.length;
  if (t <= x[0]) return y[0];
  if (t >= x[n - 1]) return y[n - 1];
  let i = 0;
  while (i < n - 2 && t > x[i + 1]) i++;
  const h = x[i + 1] - x[i];
  if (h <= 1e-9) return y[i + 1];
  const s = (t - x[i]) / h;
  const s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * y[i] + (s3 - 2 * s2 + s) * h * m[i] + (-2 * s3 + 3 * s2) * y[i + 1] + (s3 - s2) * h * m[i + 1];
}

// ------------------------------------------------------------------ images (moyennes pour le repli CPU)

const imageAverages = new Map<string, [number, number, number, number]>();

/** Couleur moyenne (linéaire) et alpha moyen d'une image, renseignés par le moteur au décodage. */
export function setImageAverage(id: string, rgba: [number, number, number, number]): void {
  imageAverages.set(id, rgba);
}
export function imageAverage(id: unknown): [number, number, number, number] | null {
  return typeof id === 'string' ? (imageAverages.get(id) ?? null) : null;
}
