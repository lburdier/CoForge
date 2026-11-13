/**
 * Bibliothèque GLSL (WebGL 2 / GLSL ES 3.0) des nœuds de shader, transposée des shaders GPU de
 * Blender (source/blender/gpu/shaders/material/*) : même hachage (Jenkins lookup3), même bruit
 * de Perlin et mêmes formules de textures, de calcul et de mélange. Préfixe `cf_` partout.
 */
export const SHADER_GLSL_LIBRARY = /* glsl */ `
// ---------------------------------------------------------------- hachage (Jenkins lookup3)
uint cf_rot(uint x, uint k) { return (x << k) | (x >> (32u - k)); }
void cf_hfinal(inout uint a, inout uint b, inout uint c) {
  c ^= b; c -= cf_rot(b, 14u); a ^= c; a -= cf_rot(c, 11u); b ^= a; b -= cf_rot(a, 25u);
  c ^= b; c -= cf_rot(b, 16u); a ^= c; a -= cf_rot(c, 4u); b ^= a; b -= cf_rot(a, 14u);
  c ^= b; c -= cf_rot(b, 24u);
}
void cf_hmix(inout uint a, inout uint b, inout uint c) {
  a -= c; a ^= cf_rot(c, 4u); c += b; b -= a; b ^= cf_rot(a, 6u); a += c;
  c -= b; c ^= cf_rot(b, 8u); b += a; a -= c; a ^= cf_rot(c, 16u); c += b;
  b -= a; b ^= cf_rot(a, 19u); a += c; c -= b; c ^= cf_rot(b, 4u); b += a;
}
uint cf_hash_uint(uint kx) { uint a, b, c; a = b = c = 0xdeadbeefu + (1u << 2u) + 13u; a += kx; cf_hfinal(a, b, c); return c; }
uint cf_hash_uint2(uint kx, uint ky) { uint a, b, c; a = b = c = 0xdeadbeefu + (2u << 2u) + 13u; b += ky; a += kx; cf_hfinal(a, b, c); return c; }
uint cf_hash_uint3(uint kx, uint ky, uint kz) { uint a, b, c; a = b = c = 0xdeadbeefu + (3u << 2u) + 13u; c += kz; b += ky; a += kx; cf_hfinal(a, b, c); return c; }
uint cf_hash_uint4(uint kx, uint ky, uint kz, uint kw) {
  uint a, b, c; a = b = c = 0xdeadbeefu + (4u << 2u) + 13u;
  a += kx; b += ky; c += kz; cf_hmix(a, b, c); a += kw; cf_hfinal(a, b, c); return c;
}
float cf_hash_float_to_float(float k) { return float(cf_hash_uint(floatBitsToUint(k))) / 4294967295.0; }
float cf_hash_vec3_to_float(vec3 k) { return float(cf_hash_uint3(floatBitsToUint(k.x), floatBitsToUint(k.y), floatBitsToUint(k.z))) / 4294967295.0; }
float cf_hash_vec4_to_float(vec4 k) { return float(cf_hash_uint4(floatBitsToUint(k.x), floatBitsToUint(k.y), floatBitsToUint(k.z), floatBitsToUint(k.w))) / 4294967295.0; }
vec3 cf_hash_vec3_to_vec3(vec3 k) { return vec3(cf_hash_vec3_to_float(k), cf_hash_vec4_to_float(vec4(k, 1.0)), cf_hash_vec4_to_float(vec4(k, 2.0))); }
float cf_rand_offset(float seed) { return 100.0 + cf_hash_float_to_float(seed) * 100.0; }
vec3 cf_rand_vec3_offset(float seed) { return vec3(cf_rand_offset(seed), cf_rand_offset(seed + 1.0), cf_rand_offset(seed + 2.0)); }

// ---------------------------------------------------------------- bruit de Perlin (Blender)
float cf_fade(float t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
float cf_negate_if(float v, uint c) { return c != 0u ? -v : v; }
float cf_noise_grad(uint hash, float x, float y, float z) {
  uint h = hash & 15u;
  float u = h < 8u ? x : y;
  float vt = (h == 12u || h == 14u) ? x : z;
  float v = h < 4u ? y : vt;
  return cf_negate_if(u, h & 1u) + cf_negate_if(v, h & 2u);
}
float cf_tri_mix(float v0, float v1, float v2, float v3, float v4, float v5, float v6, float v7, float x, float y, float z) {
  float x1 = 1.0 - x, y1 = 1.0 - y, z1 = 1.0 - z;
  return z1 * (y1 * (v0 * x1 + v1 * x) + y * (v2 * x1 + v3 * x)) + z * (y1 * (v4 * x1 + v5 * x) + y * (v6 * x1 + v7 * x));
}
float cf_noise_perlin(vec3 vec) {
  vec3 fl = floor(vec); vec3 fr = vec - fl;
  uint X = uint(int(fl.x)), Y = uint(int(fl.y)), Z = uint(int(fl.z));
  float fx = fr.x, fy = fr.y, fz = fr.z;
  float u = cf_fade(fx), v = cf_fade(fy), w = cf_fade(fz);
  return cf_tri_mix(
    cf_noise_grad(cf_hash_uint3(X, Y, Z), fx, fy, fz),
    cf_noise_grad(cf_hash_uint3(X + 1u, Y, Z), fx - 1.0, fy, fz),
    cf_noise_grad(cf_hash_uint3(X, Y + 1u, Z), fx, fy - 1.0, fz),
    cf_noise_grad(cf_hash_uint3(X + 1u, Y + 1u, Z), fx - 1.0, fy - 1.0, fz),
    cf_noise_grad(cf_hash_uint3(X, Y, Z + 1u), fx, fy, fz - 1.0),
    cf_noise_grad(cf_hash_uint3(X + 1u, Y, Z + 1u), fx - 1.0, fy, fz - 1.0),
    cf_noise_grad(cf_hash_uint3(X, Y + 1u, Z + 1u), fx, fy - 1.0, fz - 1.0),
    cf_noise_grad(cf_hash_uint3(X + 1u, Y + 1u, Z + 1u), fx - 1.0, fy - 1.0, fz - 1.0),
    u, v, w);
}
float cf_snoise(vec3 p) { return 0.9820 * cf_noise_perlin(p); }
float cf_fbm(vec3 p, float detail, float roughness, float lacunarity, bool normalize) {
  float fscale = 1.0, amp = 1.0, maxamp = 0.0, sum = 0.0;
  detail = clamp(detail, 0.0, 15.0);
  int n = int(detail);
  for (int i = 0; i <= 15; i++) {
    if (i > n) break;
    float t = cf_snoise(fscale * p);
    sum += t * amp; maxamp += amp; amp *= clamp(roughness, 0.0, 1.0); fscale *= lacunarity;
  }
  float rmd = detail - floor(detail);
  if (rmd != 0.0) {
    float t = cf_snoise(fscale * p);
    float sum2 = sum + t * amp;
    return normalize ? mix(0.5 * sum / maxamp + 0.5, 0.5 * sum2 / (maxamp + amp) + 0.5, rmd) : mix(sum, sum2, rmd);
  }
  return normalize ? 0.5 * sum / maxamp + 0.5 : sum;
}
void cf_tex_noise(vec3 co, float w, float scale, float detail, float roughness, float lacunarity, float distortion, bool normalize, out float fac, out vec3 color) {
  vec3 p = co * scale + vec3(0.0, 0.0, w * scale * 0.618);
  if (distortion != 0.0) {
    p += vec3(cf_snoise(p + cf_rand_vec3_offset(0.0)) * distortion,
              cf_snoise(p + cf_rand_vec3_offset(1.0)) * distortion,
              cf_snoise(p + cf_rand_vec3_offset(2.0)) * distortion);
  }
  fac = cf_fbm(p, detail, roughness, lacunarity, normalize);
  color = vec3(fac,
               cf_fbm(p + cf_rand_vec3_offset(3.0), detail, roughness, lacunarity, normalize),
               cf_fbm(p + cf_rand_vec3_offset(4.0), detail, roughness, lacunarity, normalize));
}

// ---------------------------------------------------------------- Voronoï (3D)
float cf_vdist(vec3 a, vec3 b, int metric, float e) {
  vec3 d = abs(a - b);
  if (metric == 1) return d.x + d.y + d.z;
  if (metric == 2) return max(d.x, max(d.y, d.z));
  if (metric == 3) return pow(pow(d.x, e) + pow(d.y, e) + pow(d.z, e), 1.0 / e);
  return length(a - b);
}
void cf_tex_voronoi(vec3 co, float scale, float smoothness, float exponent, float randomness, int feature, int metric, out float dist, out vec3 color, out vec3 pos) {
  vec3 coord = co * scale;
  vec3 cell = floor(coord);
  vec3 local = coord - cell;
  randomness = clamp(randomness, 0.0, 1.0);
  if (feature == 3) {
    // Distance au bord
    vec3 vectorToClosest = vec3(0.0);
    float minDist = 8.0;
    for (int k = -1; k <= 1; k++) for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec3 off = vec3(i, j, k);
      vec3 vp = off + cf_hash_vec3_to_vec3(cell + off) * randomness - local;
      float d = dot(vp, vp);
      if (d < minDist) { minDist = d; vectorToClosest = vp; }
    }
    minDist = 8.0;
    for (int k = -1; k <= 1; k++) for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec3 off = vec3(i, j, k);
      vec3 vp = off + cf_hash_vec3_to_vec3(cell + off) * randomness - local;
      vec3 p2c = vectorToClosest - vp;
      if (dot(p2c, p2c) > 0.0001) {
        float d = dot((vectorToClosest + vp) / 2.0, normalize(p2c));
        minDist = min(minDist, d);
      }
    }
    dist = minDist; color = vec3(0.0); pos = vec3(0.0);
    return;
  }
  if (feature == 2) {
    // F1 adouci
    smoothness = clamp(smoothness / 2.0, 0.0, 0.5);
    float sd = 8.0; vec3 sc = vec3(0.0); vec3 sp = vec3(0.0);
    for (int k = -2; k <= 2; k++) for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
      vec3 off = vec3(i, j, k);
      vec3 pp = off + cf_hash_vec3_to_vec3(cell + off) * randomness;
      float d = cf_vdist(pp, local, metric, exponent);
      float h = smoothstep(0.0, 1.0, 0.5 + 0.5 * (sd - d) / max(smoothness, 1e-6));
      float corr = smoothness * h * (1.0 - h);
      sd = mix(sd, d, h) - corr;
      corr /= 1.0 + 3.0 * smoothness;
      vec3 cc = cf_hash_vec3_to_vec3(cell + off);
      sc = mix(sc, cc, h) - corr;
      sp = mix(sp, pp, h) - corr;
    }
    dist = sd; color = sc; pos = (cell + sp) / scale;
    return;
  }
  float d1 = 8.0, d2 = 8.0;
  vec3 o1 = vec3(0.0), o2 = vec3(0.0), p1 = vec3(0.0), p2 = vec3(0.0);
  for (int k = -1; k <= 1; k++) for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec3 off = vec3(i, j, k);
    vec3 pp = off + cf_hash_vec3_to_vec3(cell + off) * randomness;
    float d = cf_vdist(pp, local, metric, exponent);
    if (d < d1) { d2 = d1; o2 = o1; p2 = p1; d1 = d; o1 = off; p1 = pp; }
    else if (d < d2) { d2 = d; o2 = off; p2 = pp; }
  }
  if (feature == 1) { dist = d2; color = cf_hash_vec3_to_vec3(cell + o2); pos = (p2 + cell) / scale; }
  else { dist = d1; color = cf_hash_vec3_to_vec3(cell + o1); pos = (p1 + cell) / scale; }
}

// ---------------------------------------------------------------- autres textures
void cf_tex_checker(vec3 co, vec3 c1, vec3 c2, float scale, out vec3 color, out float fac) {
  vec3 p = co * scale;
  p = (p + 0.000001) * 0.999999;
  int xi = int(abs(floor(p.x))), yi = int(abs(floor(p.y))), zi = int(abs(floor(p.z)));
  bool check = ((xi % 2 == yi % 2) == bool(zi % 2));
  color = check ? c1 : c2; fac = check ? 1.0 : 0.0;
}
float cf_tex_gradient(vec3 p, int type) {
  float r;
  if (type == 0) r = p.x;
  else if (type == 1) { r = max(p.x, 0.0); r *= r; }
  else if (type == 2) { r = clamp(p.x, 0.0, 1.0); float t = r * r; r = 3.0 * t - 2.0 * t * r; }
  else if (type == 3) r = (p.x + p.y) * 0.5;
  else if (type == 6) r = atan(p.y, p.x) / (2.0 * 3.14159265359) + 0.5;
  else { r = max(0.999999 - length(p), 0.0); if (type == 5) r *= r; }
  return clamp(r, 0.0, 1.0);
}
float cf_tex_wave(vec3 co, float scale, float distortion, float detail, float dscale, float drough, float phase, int wtype, int bdir, int rdir, int profile) {
  vec3 p = co * scale;
  p = (p + 0.000001) * 0.999999;
  float n;
  if (wtype == 0) {
    if (bdir == 0) n = p.x * 20.0; else if (bdir == 1) n = p.y * 20.0; else if (bdir == 2) n = p.z * 20.0; else n = (p.x + p.y + p.z) * 10.0;
  } else {
    vec3 rp = p;
    if (rdir == 0) rp *= vec3(0.0, 1.0, 1.0); else if (rdir == 1) rp *= vec3(1.0, 0.0, 1.0); else if (rdir == 2) rp *= vec3(1.0, 1.0, 0.0);
    n = length(rp) * 20.0;
  }
  n += phase;
  if (distortion != 0.0) n += distortion * (cf_fbm(p * dscale, detail, drough, 2.0, true) * 2.0 - 1.0);
  if (profile == 0) return 0.5 + 0.5 * sin(n - 1.5707963);
  if (profile == 1) { n /= 6.28318531; return n - floor(n); }
  n /= 6.28318531; return abs(n - floor(n + 0.5)) * 2.0;
}
vec3 cf_tex_magic(vec3 p, float scale, float dist, int depth) {
  p *= scale;
  float x = sin((p.x + p.y + p.z) * 5.0);
  float y = cos((-p.x + p.y - p.z) * 5.0);
  float z = -cos((-p.x - p.y + p.z) * 5.0);
  if (depth > 0) {
    x *= dist; y *= dist; z *= dist;
    y = -cos(x - y + z); y *= dist;
    if (depth > 1) { x = cos(x - y - z); x *= dist;
    if (depth > 2) { z = sin(-x - y - z); z *= dist;
    if (depth > 3) { x = -cos(-x + y - z); x *= dist;
    if (depth > 4) { y = -sin(-x + y + z); y *= dist;
    if (depth > 5) { y = -cos(-x + y + z); y *= dist;
    if (depth > 6) { x = cos(x + y + z); x *= dist;
    if (depth > 7) { z = sin(x + y - z); z *= dist;
    if (depth > 8) { x = -cos(-x - y + z); x *= dist;
    if (depth > 9) { y = -sin(x - y + z); y *= dist; }}}}}}}}}
  }
  if (dist != 0.0) { dist *= 2.0; x /= dist; y /= dist; z /= dist; }
  return vec3(0.5 - x, 0.5 - y, 0.5 - z);
}

// ---------------------------------------------------------------- couleur
vec3 cf_rgb2hsv(vec3 c) {
  float cmax = max(c.r, max(c.g, c.b)), cmin = min(c.r, min(c.g, c.b)), cd = cmax - cmin;
  float h = 0.0, s = cmax != 0.0 ? cd / cmax : 0.0;
  if (s != 0.0) {
    vec3 cc = (vec3(cmax) - c) / cd;
    if (c.r == cmax) h = cc.b - cc.g; else if (c.g == cmax) h = 2.0 + cc.r - cc.b; else h = 4.0 + cc.g - cc.r;
    h /= 6.0; if (h < 0.0) h += 1.0;
  }
  return vec3(h, s, cmax);
}
vec3 cf_hsv2rgb(vec3 hsv) {
  float h = hsv.x, s = hsv.y, v = hsv.z;
  if (s == 0.0) return vec3(v);
  if (h == 1.0) h = 0.0;
  h *= 6.0; float i = floor(h); float f = h - i;
  float p = v * (1.0 - s), q = v * (1.0 - s * f), t = v * (1.0 - s * (1.0 - f));
  if (i == 0.0) return vec3(v, t, p); if (i == 1.0) return vec3(q, v, p); if (i == 2.0) return vec3(p, v, t);
  if (i == 3.0) return vec3(p, q, v); if (i == 4.0) return vec3(t, p, v); return vec3(v, p, q);
}
vec3 cf_rgb2hsl(vec3 c) {
  float cmax = max(c.r, max(c.g, c.b)), cmin = min(c.r, min(c.g, c.b));
  float h = 0.0, s = 0.0, l = min(1.0, (cmax + cmin) / 2.0);
  if (cmax != cmin) {
    float d = cmax - cmin;
    s = l > 0.5 ? d / (2.0 - cmax - cmin) : d / (cmax + cmin);
    if (cmax == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    else if (cmax == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
  }
  return vec3(h / 6.0, s, l);
}
vec3 cf_hsl2rgb(vec3 hsl) {
  float nr = abs(hsl.x * 6.0 - 3.0) - 1.0, ng = 2.0 - abs(hsl.x * 6.0 - 2.0), nb = 2.0 - abs(hsl.x * 6.0 - 4.0);
  vec3 n = clamp(vec3(nr, ng, nb), 0.0, 1.0);
  float chroma = (1.0 - abs(2.0 * hsl.z - 1.0)) * hsl.y;
  return (n - 0.5) * chroma + hsl.z;
}
float cf_dodge1(float a, float b, float f) {
  if (a == 0.0) return a;
  float t = 1.0 - f * b;
  if (t <= 0.0) return 1.0;
  return min(a / t, 1.0);
}
float cf_burn1(float a, float b, float f) {
  float t = (1.0 - f) + f * b;
  if (t <= 0.0) return 0.0;
  return clamp(1.0 - (1.0 - a) / t, 0.0, 1.0);
}
float cf_overlay1(float a, float b, float f) {
  float fm = 1.0 - f;
  return a < 0.5 ? a * (fm + 2.0 * f * b) : 1.0 - (fm + 2.0 * f * (1.0 - b)) * (1.0 - a);
}
vec3 cf_blend(int mode, float f, vec3 a, vec3 b) {
  if (mode == 0) return mix(a, b, f);
  if (mode == 1) return mix(a, min(a, b), f);
  if (mode == 2) return mix(a, a * b, f);
  if (mode == 3) return vec3(cf_burn1(a.r, b.r, f), cf_burn1(a.g, b.g, f), cf_burn1(a.b, b.b, f));
  if (mode == 4) return mix(a, max(a, b), f);
  if (mode == 5) return vec3(1.0) - (vec3(1.0 - f) + f * (vec3(1.0) - b)) * (vec3(1.0) - a);
  if (mode == 6) return vec3(cf_dodge1(a.r, b.r, f), cf_dodge1(a.g, b.g, f), cf_dodge1(a.b, b.b, f));
  if (mode == 7) return a + b * f;
  if (mode == 8) return vec3(cf_overlay1(a.r, b.r, f), cf_overlay1(a.g, b.g, f), cf_overlay1(a.b, b.b, f));
  if (mode == 9) { vec3 scr = vec3(1.0) - (vec3(1.0) - b) * (vec3(1.0) - a); return (1.0 - f) * a + f * ((vec3(1.0) - a) * b * a + a * scr); }
  if (mode == 10) return a + f * (2.0 * b - vec3(1.0));
  if (mode == 11) return mix(a, abs(a - b), f);
  if (mode == 12) return max(mix(a, a + b - 2.0 * a * b, f), vec3(0.0));
  if (mode == 13) return a - b * f;
  if (mode == 14) return vec3(b.r != 0.0 ? (1.0 - f) * a.r + f * a.r / b.r : a.r, b.g != 0.0 ? (1.0 - f) * a.g + f * a.g / b.g : a.g, b.b != 0.0 ? (1.0 - f) * a.b + f * a.b / b.b : a.b);
  vec3 ha = cf_rgb2hsv(a), hb = cf_rgb2hsv(b);
  if (mode == 15) { if (hb.y == 0.0) return a; ha.x = hb.x; return mix(a, cf_hsv2rgb(ha), f); }
  if (mode == 16) { if (ha.y == 0.0) return a; ha.y = mix(ha.y, hb.y, f); return cf_hsv2rgb(ha); }
  if (mode == 17) { if (hb.y == 0.0) return a; ha.x = hb.x; ha.y = hb.y; return mix(a, cf_hsv2rgb(ha), f); }
  ha.z = mix(ha.z, hb.z, f); return cf_hsv2rgb(ha);
}
vec3 cf_hue_sat(float hue, float sat, float value, float fac, vec3 col) {
  vec3 hsv = cf_rgb2hsv(col);
  hsv.x = fract(hsv.x + hue + 0.5);
  hsv.y = clamp(hsv.y * sat, 0.0, 1.0);
  hsv.z *= value;
  return max(mix(col, cf_hsv2rgb(hsv), fac), vec3(0.0));
}

// ---------------------------------------------------------------- calcul
float cf_safe_div(float a, float b) { return b != 0.0 ? a / b : 0.0; }
vec3 cf_safe_div3(vec3 a, vec3 b) { return vec3(cf_safe_div(a.x, b.x), cf_safe_div(a.y, b.y), cf_safe_div(a.z, b.z)); }
float cf_safe_pow(float a, float b) { if (a < 0.0 && b != floor(b)) return 0.0; return pow(abs(a), b) * (a < 0.0 && mod(b, 2.0) == 1.0 ? -1.0 : 1.0); }
float cf_safe_log(float a, float b) { return (a > 0.0 && b > 0.0) ? log(a) / log(b) : 0.0; }
float cf_smin(float a, float b, float c) { if (c != 0.0) { float h = max(c - abs(a - b), 0.0) / c; return min(a, b) - h * h * h * c * (1.0 / 6.0); } return min(a, b); }
float cf_wrap(float a, float b, float c) { float r = b - c; return r != 0.0 ? a - r * floor((a - c) / r) : c; }
float cf_pingpong(float a, float b) { return b != 0.0 ? abs(fract((a - b) / (b * 2.0)) * b * 2.0 - b) : 0.0; }
float cf_fmod(float a, float b) { return b != 0.0 ? a - b * trunc(a / b) : 0.0; }
float cf_fmodf(float a, float b) { return b != 0.0 ? a - b * floor(a / b) : 0.0; }
vec3 cf_fmod3(vec3 a, vec3 b) { return vec3(cf_fmod(a.x, b.x), cf_fmod(a.y, b.y), cf_fmod(a.z, b.z)); }
float cf_smootherstep(float e0, float e1, float x) { x = clamp(cf_safe_div(x - e0, e1 - e0), 0.0, 1.0); return x * x * x * (x * (x * 6.0 - 15.0) + 10.0); }
float cf_map_range(float v, float fmin, float fmax, float tmin, float tmax, float steps, int interp, bool clampIt) {
  float fac;
  if (interp == 0 || interp == 1) {
    fac = cf_safe_div(v - fmin, fmax - fmin);
    if (interp == 1) fac = steps > 0.0 ? floor(fac * (steps + 1.0)) / steps : 0.0;
    float r = tmin + fac * (tmax - tmin);
    return clampIt ? (tmin > tmax ? clamp(r, tmax, tmin) : clamp(r, tmin, tmax)) : r;
  }
  if (interp == 2) fac = fmin > fmax ? 1.0 - smoothstep(fmax, fmin, v) : smoothstep(fmin, fmax, v);
  else fac = fmin > fmax ? 1.0 - cf_smootherstep(fmax, fmin, v) : cf_smootherstep(fmin, fmax, v);
  return tmin + fac * (tmax - tmin);
}
mat3 cf_euler_to_mat3(vec3 e) {
  float cx = cos(e.x), cy = cos(e.y), cz = cos(e.z), sx = sin(e.x), sy = sin(e.y), sz = sin(e.z);
  return mat3(cy * cz, cy * sz, -sy,
              sy * sx * cz - cx * sz, sy * sx * sz + cx * cz, cy * sx,
              sy * cx * cz + sx * sz, sy * cx * sz - sx * cz, cy * cx);
}
vec3 cf_snap3(vec3 a, vec3 b) { return vec3(b.x != 0.0 ? floor(a.x / b.x) * b.x : 0.0, b.y != 0.0 ? floor(a.y / b.y) * b.y : 0.0, b.z != 0.0 ? floor(a.z / b.z) * b.z : 0.0); }
vec3 cf_project3(vec3 a, vec3 b) { float l = dot(b, b); return l != 0.0 ? b * (dot(a, b) / l) : vec3(0.0); }

// ---------------------------------------------------------------- éclairage
float cf_fresnel_dielectric_cos(float cosi, float eta) {
  float c = abs(cosi);
  float g = eta * eta - 1.0 + c * c;
  if (g > 0.0) {
    g = sqrt(g);
    float A = (g - c) / (g + c);
    float B = (c * (g + c) - 1.0) / (c * (g - c) + 1.0);
    return 0.5 * A * A * (1.0 + B * B);
  }
  return 1.0;
}
float cf_fresnel(float ior, vec3 N, vec3 I, bool back) {
  float eta = max(ior, 0.00001);
  return cf_fresnel_dielectric_cos(dot(I, N), back ? 1.0 / eta : eta);
}
void cf_layer_weight(float blend, vec3 N, vec3 I, bool back, out float fresnel, out float facing) {
  float eta = max(1.0 - blend, 0.00001);
  fresnel = cf_fresnel_dielectric_cos(dot(I, N), back ? eta : 1.0 / eta);
  facing = abs(dot(I, N));
  if (blend != 0.5) {
    float b = clamp(blend, 0.0, 0.99999);
    b = b < 0.5 ? 2.0 * b : 0.5 / (1.0 - b);
    facing = pow(facing, b);
  }
  facing = 1.0 - facing;
}
vec3 cf_bump(float strength, float dist, float height, vec3 N, vec3 P, bool invert) {
  vec3 dPdx = dFdx(P), dPdy = dFdy(P);
  vec3 Rx = cross(dPdy, N), Ry = cross(N, dPdx);
  float det = dot(dPdx, Rx);
  float dHdx = dFdx(height), dHdy = dFdy(height);
  vec3 surfgrad = dHdx * Rx + dHdy * Ry;
  strength = max(strength, 0.0);
  if (invert) dist = -dist;
  vec3 result = normalize(abs(det) * N - dist * sign(det) * surfgrad);
  return normalize(mix(N, result, strength));
}
`;
