/**
 * Bibliothèque GLSL complémentaire (vague 3) : types de bruit, Voronoï fractal, briques, Gabor,
 * images, ciel, corps noir, longueur d'onde, rotations, cartes de normales, courbes. Chaque
 * fonction a sa jumelle JavaScript dans shader/cpu.ts (mêmes formules). Suppose la bibliothèque
 * de base (shaderGlsl.ts) déjà déclarée, ainsi que `uniform vec4 cf_u[]` (valeurs des nœuds) et
 * `uniform mat4 cfModel` (matrice monde de l'objet).
 */
export const SHADER_GLSL_MORE = /* glsl */ `
// ---------------------------------------------------------------- valeurs des nœuds (uniformes)
float cf_uf(int k) { return cf_u[k >> 2][k & 3]; }
vec3 cf_srgb2lin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), vec3(greaterThan(c, vec3(0.04045)))); }

// ---------------------------------------------------------------- types de bruit
float cf_multi_fractal(vec3 p, float detail, float rough, float lac) {
  float value = 1.0, pwr = 1.0; detail = clamp(detail, 0.0, 15.0); int n = int(detail);
  for (int i = 0; i <= 15; i++) { if (i > n) break; value *= pwr * cf_snoise(p) + 1.0; pwr *= rough; p *= lac; }
  float rmd = detail - floor(detail);
  if (rmd != 0.0) value *= rmd * pwr * cf_snoise(p) + 1.0;
  return value;
}
float cf_hetero_terrain(vec3 p, float detail, float rough, float lac, float offset) {
  detail = clamp(detail, 0.0, 15.0); int n = int(detail);
  float pwr = rough; float value = offset + cf_snoise(p); p *= lac;
  for (int i = 1; i <= 15; i++) { if (i > n) break; value += (cf_snoise(p) + offset) * pwr * value; pwr *= rough; p *= lac; }
  float rmd = detail - floor(detail);
  if (rmd != 0.0) value += rmd * ((cf_snoise(p) + offset) * pwr * value);
  return value;
}
float cf_hybrid_multi_fractal(vec3 p, float detail, float rough, float lac, float offset, float gain) {
  detail = clamp(detail, 0.0, 15.0); int n = int(detail);
  float pwr = 1.0, value = 0.0, weight = 1.0;
  for (int i = 0; i <= 15; i++) {
    if (i > n || weight <= 0.001) break;
    if (weight > 1.0) weight = 1.0;
    float signal = (cf_snoise(p) + offset) * pwr;
    pwr *= rough; value += weight * signal; weight *= gain * signal; p *= lac;
  }
  float rmd = detail - floor(detail);
  if (rmd != 0.0 && weight > 0.001) { if (weight > 1.0) weight = 1.0; value += rmd * weight * ((cf_snoise(p) + offset) * pwr); }
  return value;
}
float cf_ridged_multi_fractal(vec3 p, float detail, float rough, float lac, float offset, float gain) {
  detail = clamp(detail, 0.0, 15.0); int n = int(detail);
  float pwr = rough; float signal = offset - abs(cf_snoise(p)); signal *= signal; float value = signal; float weight = 1.0;
  for (int i = 1; i <= 15; i++) {
    if (i > n) break;
    p *= lac; weight = clamp(signal * gain, 0.0, 1.0);
    signal = offset - abs(cf_snoise(p)); signal *= signal; signal *= weight;
    value += signal * pwr; pwr *= rough;
  }
  return value;
}
float cf_noise_fractal(int type, vec3 p, float detail, float rough, float lac, float offset, float gain, bool normalize) {
  if (type == 0) return cf_multi_fractal(p, detail, rough, lac);
  if (type == 1) return cf_ridged_multi_fractal(p, detail, rough, lac, offset, gain);
  if (type == 2) return cf_hybrid_multi_fractal(p, detail, rough, lac, offset, gain);
  if (type == 4) return cf_hetero_terrain(p, detail, rough, lac, offset);
  return cf_fbm(p, detail, rough, lac, normalize);
}
void cf_tex_noise2(vec3 co, float w, float scale, float detail, float rough, float lac, float offset, float gain, float distortion, int type, bool normalize, out float fac, out vec3 color) {
  vec3 p = co * scale + vec3(0.0, 0.0, w * scale * 0.618);
  if (distortion != 0.0) {
    p += vec3(cf_snoise(p + cf_rand_vec3_offset(0.0)) * distortion, cf_snoise(p + cf_rand_vec3_offset(1.0)) * distortion, cf_snoise(p + cf_rand_vec3_offset(2.0)) * distortion);
  }
  fac = cf_noise_fractal(type, p, detail, rough, lac, offset, gain, normalize);
  color = vec3(fac, cf_noise_fractal(type, p + cf_rand_vec3_offset(3.0), detail, rough, lac, offset, gain, normalize),
               cf_noise_fractal(type, p + cf_rand_vec3_offset(4.0), detail, rough, lac, offset, gain, normalize));
}

// ---------------------------------------------------------------- Voronoï fractal (Blender 4)
void cf_voronoi_base(vec3 coord, float smoothness, float exponent, float randomness, int feature, int metric, out float dist, out vec3 color, out vec3 pos) {
  vec3 cell = floor(coord); vec3 local = coord - cell;
  randomness = clamp(randomness, 0.0, 1.0);
  if (feature == 2) {
    float s = clamp(smoothness / 2.0, 0.0, 0.5);
    float sd = 8.0; vec3 sc = vec3(0.0); vec3 sp = vec3(0.0);
    for (int k = -2; k <= 2; k++) for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
      vec3 off = vec3(i, j, k); vec3 h = cf_hash_vec3_to_vec3(cell + off);
      vec3 pp = off + h * randomness;
      float d = cf_vdist(pp, local, metric, exponent);
      float hh = smoothstep(0.0, 1.0, 0.5 + 0.5 * (sd - d) / max(s, 1e-6));
      float corr = s * hh * (1.0 - hh);
      sd = mix(sd, d, hh) - corr; corr /= 1.0 + 3.0 * s;
      sc = mix(sc, h, hh) - corr; sp = mix(sp, pp, hh) - corr;
    }
    dist = sd; color = sc; pos = cell + sp; return;
  }
  float d1 = 8.0, d2 = 8.0; vec3 o1 = vec3(0.0), o2 = vec3(0.0), p1 = vec3(0.0), p2 = vec3(0.0);
  for (int k = -1; k <= 1; k++) for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec3 off = vec3(i, j, k); vec3 pp = off + cf_hash_vec3_to_vec3(cell + off) * randomness;
    float d = cf_vdist(pp, local, metric, exponent);
    if (d < d1) { d2 = d1; o2 = o1; p2 = p1; d1 = d; o1 = off; p1 = pp; } else if (d < d2) { d2 = d; o2 = off; p2 = pp; }
  }
  if (feature == 1) { dist = d2; color = cf_hash_vec3_to_vec3(cell + o2); pos = p2 + cell; }
  else { dist = d1; color = cf_hash_vec3_to_vec3(cell + o1); pos = p1 + cell; }
}
float cf_voronoi_edge(vec3 coord, float randomness) {
  vec3 cell = floor(coord); vec3 local = coord - cell; randomness = clamp(randomness, 0.0, 1.0);
  vec3 toClosest = vec3(0.0); float minDist = 8.0;
  for (int k = -1; k <= 1; k++) for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec3 off = vec3(i, j, k); vec3 vp = off + cf_hash_vec3_to_vec3(cell + off) * randomness - local;
    float d = dot(vp, vp); if (d < minDist) { minDist = d; toClosest = vp; }
  }
  minDist = 8.0;
  for (int k = -1; k <= 1; k++) for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec3 off = vec3(i, j, k); vec3 vp = off + cf_hash_vec3_to_vec3(cell + off) * randomness - local;
    vec3 p2c = toClosest - vp;
    if (dot(p2c, p2c) > 0.0001) minDist = min(minDist, dot((toClosest + vp) / 2.0, normalize(p2c)));
  }
  return minDist;
}
float cf_voronoi_nsphere(vec3 coord, float randomness) {
  vec3 cell = floor(coord); vec3 local = coord - cell; randomness = clamp(randomness, 0.0, 1.0);
  vec3 closest = vec3(0.0), closestOff = vec3(0.0); float minD = 8.0;
  for (int k = -1; k <= 1; k++) for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec3 off = vec3(i, j, k); vec3 p = off + cf_hash_vec3_to_vec3(cell + off) * randomness;
    float d = distance(p, local); if (d < minD) { minD = d; closest = p; closestOff = off; }
  }
  minD = 8.0; vec3 toClosest = vec3(0.0);
  for (int k = -1; k <= 1; k++) for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    if (i == 0 && j == 0 && k == 0) continue;
    vec3 off = vec3(i, j, k) + closestOff; vec3 p = off + cf_hash_vec3_to_vec3(cell + off) * randomness;
    float d = distance(closest, p); if (d < minD) { minD = d; toClosest = p; }
  }
  return distance(toClosest, closest) / 2.0;
}
float cf_voronoi_max_distance(int metric, float exponent, float randomness, int feature) {
  float base = 0.5 + 0.5 * clamp(randomness, 0.0, 1.0);
  float m = metric == 1 ? 3.0 : metric == 2 ? 1.0 : metric == 3 ? pow(3.0, 1.0 / max(exponent, 1e-3)) : sqrt(3.0);
  return base * m * (feature == 1 ? 2.0 : 1.0);
}
void cf_tex_voronoi2(vec3 co, float scale, float detail, float rough, float lac, float smoothness, float exponent, float randomness, int feature, int metric, bool normalize,
                     out float dist, out vec3 color, out vec3 pos, out float radius) {
  vec3 coord = co * scale; dist = 0.0; color = vec3(0.0); pos = vec3(0.0); radius = 0.0;
  if (feature == 3) { dist = cf_voronoi_edge(coord, randomness); return; }
  if (feature == 4) { radius = cf_voronoi_nsphere(coord, randomness); return; }
  detail = clamp(detail, 0.0, 15.0); rough = clamp(rough, 0.0, 1.0);
  float amp = 1.0, maxAmp = 0.0, oscale = 1.0;
  bool zero = detail == 0.0 || rough == 0.0;
  int n = int(ceil(detail));
  for (int i = 0; i <= 15; i++) {
    if (i > n) break;
    float d; vec3 c; vec3 p;
    cf_voronoi_base(coord * oscale, smoothness, exponent, randomness, feature, metric, d, c, p);
    vec3 pp = p / oscale;
    if (zero) { maxAmp = 1.0; dist = d; color = c; pos = pp; break; }
    if (float(i) <= detail) {
      maxAmp += amp; dist += d * amp; color += c * amp; pos = mix(pos, pp, amp); oscale *= lac; amp *= rough;
    } else {
      float r = detail - floor(detail);
      if (r != 0.0) {
        maxAmp = mix(maxAmp, maxAmp + amp, r); dist = mix(dist, dist + d * amp, r);
        color = mix(color, color + c * amp, r); pos = mix(pos, mix(pos, pp, amp), r);
      }
    }
  }
  if (normalize) { dist /= maxAmp * cf_voronoi_max_distance(metric, exponent, randomness, feature); color /= maxAmp; }
  else if (!zero) color /= maxAmp;
  pos = scale != 0.0 ? pos / scale : vec3(0.0);
}

// ---------------------------------------------------------------- briques (svm_brick)
float cf_brick_noise(int n) {
  n = (n + 1013) & 0x7fffffff; n = (n >> 13) ^ n;
  int nn = (n * (n * n * 60493 + 19990303) + 1376312589) & 0x7fffffff;
  return 0.5 * float(nn) / 1073741824.0;
}
void cf_tex_brick(vec3 co, vec3 c1, vec3 c2, vec3 mortarCol, float scale, float mortarSize, float mortarSmooth, float bias, float bw, float rh,
                  float offsetAmount, int offsetFreq, float squashAmount, int squashFreq, out vec3 color, out float fac) {
  vec3 p = co * scale;
  int rownum = int(floor(p.y / rh));
  float offset = 0.0;
  if (offsetFreq != 0 && squashFreq != 0) {
    bw *= (abs(rownum) % squashFreq) != 0 ? 1.0 : squashAmount;
    offset = (abs(rownum) % offsetFreq) != 0 ? 0.0 : bw * offsetAmount;
  }
  int bricknum = int(floor((p.x + offset) / bw));
  float x = (p.x + offset) - bw * float(bricknum);
  float y = p.y - rh * float(rownum);
  float tint = clamp(cf_brick_noise((rownum << 16) + (bricknum & 0xFFFF)) + bias, 0.0, 1.0);
  float minDist = min(min(x, y), min(bw - x, rh - y));
  float mortar;
  if (minDist >= mortarSize) mortar = 0.0;
  else if (mortarSmooth == 0.0) mortar = 1.0;
  else { minDist = 1.0 - minDist / mortarSize; mortar = minDist < mortarSmooth ? smoothstep(0.0, 1.0, minDist / mortarSmooth) : 1.0; }
  vec3 col = c1;
  if (mortar != 1.0) col = (1.0 - tint) * c1 + tint * c2;
  color = mix(col, mortarCol, mortar); fac = mortar;
}

// ---------------------------------------------------------------- Gabor (même principe que Blender)
void cf_tex_gabor(vec3 co, float scale, float frequency, float anisotropy, float orient2d, vec3 orient3d, bool is3d, out float value, out float phase, out float intensity) {
  vec3 p = co * scale;
  vec3 cell = vec3(floor(p.x), floor(p.y), is3d ? floor(p.z) : 0.0);
  vec3 local = vec3(p.x - cell.x, p.y - cell.y, is3d ? p.z - cell.z : 0.0);
  vec3 base3 = length(orient3d) > 0.0 ? normalize(orient3d) : vec3(1.0, 0.0, 0.0);
  int kz = is3d ? 1 : 0;
  float re = 0.0, im = 0.0;
  for (int k = -1; k <= 1; k++) {
    if (k < -kz || k > kz) continue;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec3 c = cell + vec3(i, j, k);
      for (int n = 0; n < 8; n++) {
        float fn = float(n);
        vec3 h = vec3(cf_hash_vec4_to_float(vec4(c, fn + 16.0)), cf_hash_vec4_to_float(vec4(c, fn + 24.0)), cf_hash_vec4_to_float(vec4(c, fn + 32.0)));
        vec3 center = vec3(float(i) + h.x, float(j) + h.y, float(k * kz) + (is3d ? h.z : 0.0));
        vec3 d = local - center; float d2 = dot(d, d);
        if (d2 >= 1.0) continue;
        float rnd = (cf_hash_vec4_to_float(vec4(c, fn)) - 0.5) * 6.28318531 * (1.0 - clamp(anisotropy, 0.0, 1.0));
        vec3 dir = is3d ? base3 : vec3(cos(orient2d + rnd), sin(orient2d + rnd), 0.0);
        float weight = cf_hash_vec4_to_float(vec4(c, fn + 8.0)) < 0.5 ? -1.0 : 1.0;
        float env = (0.5 + 0.5 * cos(3.14159265 * d2)) * exp(-3.14159265 * d2);
        float ph = 6.28318531 * frequency * dot(d, dir);
        re += weight * env * cos(ph); im += weight * env * sin(ph);
      }
    }
  }
  float sd = sqrt(2.0) * 0.35 * (is3d ? 1.6 : 1.0);
  value = clamp(im / (6.0 * sd) * 0.5 + 0.5, 0.0, 1.0);
  phase = (atan(im, re) + 3.14159265) / 6.28318531;
  intensity = clamp(length(vec2(re, im)) / (6.0 * sd), 0.0, 1.0);
}

// ---------------------------------------------------------------- images
vec4 cf_img_fetch(sampler2D s, vec2 uv, int ext, bool closest) {
  vec2 w = uv;
  if (ext == 0) w = fract(uv);
  else if (ext == 1) w = clamp(uv, 0.0, 1.0);
  else if (ext == 2) { if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec4(0.0); }
  else w = 1.0 - abs(mod(uv, 2.0) - 1.0);
  w.y = 1.0 - w.y;
  if (closest) { ivec2 sz = textureSize(s, 0); return texelFetch(s, clamp(ivec2(floor(w * vec2(sz))), ivec2(0), sz - 1), 0); }
  vec2 gx = dFdx(uv), gy = dFdy(uv);
  return textureGrad(s, w, vec2(gx.x, -gx.y), vec2(gy.x, -gy.y));
}
vec2 cf_map_to_sphere(vec3 d) {
  float l = length(d);
  if (l <= 0.0) return vec2(0.0);
  float u = (d.x == 0.0 && d.y == 0.0) ? 0.0 : (1.0 - atan(d.x, d.y) / 3.14159265) * 0.5;
  return vec2(u, 1.0 - acos(clamp(d.z / l, -1.0, 1.0)) / 3.14159265);
}
vec2 cf_map_to_tube(vec3 d) {
  float l = length(d.xy);
  if (l <= 0.0) return vec2(0.0);
  return vec2((1.0 - atan(d.x / l, d.y / l) / 3.14159265) * 0.5, (d.z + 1.0) * 0.5);
}
vec4 cf_tex_image(sampler2D s, vec3 co, vec3 n, int proj, float blend, int ext, bool closest) {
  if (proj == 2) return cf_img_fetch(s, cf_map_to_sphere(co * 2.0 - 1.0), ext, closest);
  if (proj == 3) return cf_img_fetch(s, cf_map_to_tube(co * 2.0 - 1.0), ext, closest);
  if (proj != 1) return cf_img_fetch(s, co.xy, ext, closest);
  vec3 N = abs(n); N /= max(N.x + N.y + N.z, 1e-6);
  vec3 w = vec3(0.0);
  float limit = 0.5 * (1.0 + blend);
  if (N.x > limit * (N.x + N.y) && N.x > limit * (N.x + N.z)) w.x = 1.0;
  else if (N.y > limit * (N.x + N.y) && N.y > limit * (N.y + N.z)) w.y = 1.0;
  else if (N.z > limit * (N.x + N.z) && N.z > limit * (N.y + N.z)) w.z = 1.0;
  else if (blend > 0.0) {
    if (N.z < (1.0 - limit) * (N.y + N.x)) { w.x = clamp((N.x / (N.x + N.y) - 0.5 * (1.0 - blend)) / blend, 0.0, 1.0); w.y = 1.0 - w.x; }
    else if (N.x < (1.0 - limit) * (N.y + N.z)) { w.y = clamp((N.y / (N.y + N.z) - 0.5 * (1.0 - blend)) / blend, 0.0, 1.0); w.z = 1.0 - w.y; }
    else if (N.y < (1.0 - limit) * (N.x + N.z)) { w.x = clamp((N.x / (N.x + N.z) - 0.5 * (1.0 - blend)) / blend, 0.0, 1.0); w.z = 1.0 - w.x; }
    else w = ((2.0 - limit) * N + (limit - 1.0)) / (2.0 * limit - 1.0);
  } else w.x = 1.0;
  vec4 r = vec4(0.0);
  if (w.x > 0.0) r += w.x * cf_img_fetch(s, co.yz, ext, closest);
  if (w.y > 0.0) r += w.y * cf_img_fetch(s, co.xz, ext, closest);
  if (w.z > 0.0) r += w.z * cf_img_fetch(s, co.xy, ext, closest);
  return r;
}
vec2 cf_equirect(vec3 d) {
  d = length(d) > 0.0 ? normalize(d) : vec3(1.0, 0.0, 0.0);
  return vec2(-atan(d.y, d.x) / 6.28318531 + 0.5, atan(d.z, length(d.xy)) / 3.14159265 + 0.5);
}
vec2 cf_mirror_ball(vec3 d) {
  d = length(d) > 0.0 ? normalize(d) : vec3(0.0, 1.0, 0.0);
  d.y -= 1.0; float div = 2.0 * sqrt(max(-0.5 * d.y, 0.0)); if (div > 0.0) d /= div;
  return vec2(0.5 * (d.x + 1.0), 0.5 * (d.z + 1.0));
}

// ---------------------------------------------------------------- ciel, corps noir, longueur d'onde
vec3 cf_sky(vec3 d, float elevation, float rotation, bool disc, float sunSize, float sunIntensity) {
  float l = max(length(d), 1e-6); float z = d.z / l;
  vec3 sun = vec3(cos(elevation) * sin(rotation), -cos(elevation) * cos(rotation), sin(elevation));
  float day = clamp(sin(elevation) * 3.0 + 0.3, 0.02, 1.0);
  vec3 zenith = vec3(0.12, 0.25, 0.6) * day, horizon = vec3(0.55, 0.6, 0.7) * day;
  vec3 base = z < 0.0 ? vec3(0.08 * day) : mix(horizon, zenith, pow(clamp(z, 0.0, 1.0), 0.45));
  float cosA = dot(d, sun) / l;
  float halo = pow(clamp(cosA, 0.0, 1.0), 16.0) * 0.4 * day;
  float sd = (disc && cosA > cos(max(sunSize, 1e-4) / 2.0)) ? 50.0 * sunIntensity : 0.0;
  return base + vec3(halo + sd, halo * 0.9 + sd, halo * 0.7 + sd * 0.9);
}
vec3 cf_blackbody(float t) {
  float k = clamp(t, 800.0, 40000.0) / 100.0; vec3 c;
  if (k <= 66.0) { c = vec3(255.0, 99.4708025861 * log(k) - 161.1195681661, k <= 19.0 ? 0.0 : 138.5177312231 * log(k - 10.0) - 305.0447927307); }
  else { c = vec3(329.698727446 * pow(k - 60.0, -0.1332047592), 288.1221695283 * pow(k - 60.0, -0.0755148492), 255.0); }
  c = cf_srgb2lin(clamp(c, 0.0, 255.0) / 255.0);
  return c / max(max(c.r, max(c.g, c.b)), 1e-6);
}
float cf_wl_g(float x, float mu, float s1, float s2) { float t = (x - mu) / (x < mu ? s1 : s2); return exp(-0.5 * t * t); }
vec3 cf_wavelength(float nm) {
  float X = 1.056 * cf_wl_g(nm, 599.8, 37.9, 31.0) + 0.362 * cf_wl_g(nm, 442.0, 16.0, 26.7) - 0.065 * cf_wl_g(nm, 501.1, 20.4, 26.2);
  float Y = 0.821 * cf_wl_g(nm, 568.8, 46.9, 40.5) + 0.286 * cf_wl_g(nm, 530.9, 16.3, 31.1);
  float Z = 1.217 * cf_wl_g(nm, 437.0, 11.8, 36.0) + 0.681 * cf_wl_g(nm, 459.0, 26.0, 13.8);
  return max(vec3(3.2406 * X - 1.5372 * Y - 0.4986 * Z, -0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0.0557 * X - 0.204 * Y + 1.057 * Z), vec3(0.0));
}

// ---------------------------------------------------------------- vecteurs
/** Tangente (repère objet) → repère monde, orthogonalisée par rapport à la normale. */
vec3 cf_orthotangent(vec3 t, vec3 N) {
  vec3 w = mat3(cfModel) * t;
  vec3 o = w - N * dot(N, w);
  return length(o) > 1e-8 ? normalize(o) : normalize(cross(N, vec3(0.0, 0.0, 1.0)) + vec3(1e-4, 0.0, 0.0));
}
vec3 cf_rotate_axis(vec3 p, vec3 axis, float angle) {
  float c = cos(angle), s = sin(angle);
  return p * c + cross(axis, p) * s + axis * dot(axis, p) * (1.0 - c);
}
vec3 cf_vector_rotate(vec3 v, vec3 center, vec3 axis, float angle, vec3 rot, int type, bool invert) {
  vec3 p = v - center;
  if (type == 4) { mat3 m = cf_euler_to_mat3(rot); return (invert ? transpose(m) : m) * p + center; }
  vec3 a = type == 1 ? vec3(1.0, 0.0, 0.0) : type == 2 ? vec3(0.0, 1.0, 0.0) : type == 3 ? vec3(0.0, 0.0, 1.0) : axis;
  if (length(a) == 0.0) return v;
  return cf_rotate_axis(p, normalize(a), invert ? -angle : angle) + center;
}
/** Carte de normales en espace tangent : repère tangent déduit des coordonnées générées (sans UV). */
vec3 cf_normal_map_tangent(vec3 color, float strength, vec3 N, vec3 P, vec3 uvw) {
  vec3 dp1 = dFdx(P), dp2 = dFdy(P); vec2 du1 = dFdx(uvw.xy), du2 = dFdy(uvw.xy);
  vec3 dp2perp = cross(dp2, N), dp1perp = cross(N, dp1);
  vec3 T = dp2perp * du1.x + dp1perp * du2.x; vec3 B = dp2perp * du1.y + dp1perp * du2.y;
  float invmax = inversesqrt(max(max(dot(T, T), dot(B, B)), 1e-20));
  vec3 n = color * 2.0 - 1.0;
  vec3 r = normalize(T * invmax * n.x + B * invmax * n.y + N * n.z);
  return normalize(N + (r - N) * max(strength, 0.0));
}
vec3 cf_normal_strength(vec3 n, float strength, vec3 N) { return normalize(N + (normalize(n) - N) * max(strength, 0.0)); }

// ---------------------------------------------------------------- courbes (tables de 32 valeurs dans cf_u)
float cf_curve_lut(int base, float lo, float hi, float t) {
  float u = clamp((t - lo) / max(hi - lo, 1e-6), 0.0, 1.0) * 31.0;
  int i = int(floor(u)); float f = u - float(i);
  return mix(cf_uf(base + i), cf_uf(base + min(i + 1, 31)), f);
}
`;
