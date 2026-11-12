import { HalfFloatType, LinearFilter, NoBlending, RGBAFormat, ShaderMaterial, Vector2, WebGLRenderTarget, type Texture, type WebGLRenderer } from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import type { RenderSettings } from '../../core/doc/schema';

/**
 * Affichage instantané du path tracing : rendu à résolution interne réduite, débruitage, puis
 * remise à l'échelle avec renforcement de la netteté.
 *
 * Ce n'est PAS le DLSS de NVIDIA : DLSS est une bibliothèque native propriétaire (NGX), réservée
 * aux cartes RTX et inaccessible depuis WebGL. C'est le même principe (tracer moins de pixels,
 * reconstruire l'image), réalisé par des passes GLSL qui tournent sur n'importe quel GPU.
 */

export type UpscaleMode = RenderSettings['upscale'];

/** Échelle linéaire de la résolution interne (mêmes paliers que les modes de DLSS). */
export const UPSCALE_SCALES: Record<UpscaleMode, number> = {
  off: 1,
  quality: 0.667,
  balanced: 0.58,
  performance: 0.5,
  ultra: 0.333,
};

export function upscaleScale(mode: UpscaleMode | undefined): number {
  return UPSCALE_SCALES[mode ?? 'off'] ?? 1;
}

/**
 * Échantillons tracés par image : à résolution réduite un échantillon coûte `scale²` fois moins,
 * on en trace donc plusieurs pour converger plus vite à coût comparable.
 */
export function samplesPerFrame(scale: number): number {
  return Math.max(1, Math.min(4, Math.round(0.6 / (scale * scale))));
}

/**
 * Force du débruitage selon le nombre d'échantillons accumulés : fort sur la première image,
 * puis de plus en plus discret, et nul une fois l'image convergée (elle n'est alors plus altérée).
 * Renvoie null quand il n'y a plus rien à débruiter.
 */
export function denoiseStrength(samples: number): { sigma: number; threshold: number } | null {
  if (samples >= 1024) return null;
  const t = Math.min(1, Math.log2(Math.max(1, samples)) / Math.log2(1024));
  return { sigma: 4 - 2.4 * t, threshold: 0.3 * (1 - t) * (1 - t) + 0.02 };
}

/**
 * Débruitage bilatéral (noyau gaussien circulaire pondéré par la ressemblance des couleurs,
 * d'après glslSmartDeNoise de Michele Morrone, licence BSD 2 clauses). La ressemblance est
 * mesurée sur des couleurs compressées c / (1 + c) : en HDR linéaire le bruit des zones très
 * éclairées dépasserait tout seuil fixe et ne serait jamais lissé.
 */
const DENOISE_FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  uniform vec2 texel;
  uniform float sigma;
  uniform float threshold;
  varying vec2 vUv;
  vec3 squash( vec3 c ) { return c / ( 1.0 + c ); }
  void main() {
    float radius = floor( sigma * 1.5 + 0.5 );
    float radQ = radius * radius;
    float invSigma = 0.5 / ( sigma * sigma );
    float invThreshold = 0.5 / ( threshold * threshold );
    vec4 centre = texture2D( map, vUv );
    vec3 centreS = squash( max( centre.rgb, 0.0 ) );
    float total = 0.0;
    vec4 sum = vec4( 0.0 );
    for ( float x = - radius; x <= radius; x ++ ) {
      float span = floor( sqrt( radQ - x * x ) );
      for ( float y = - span; y <= span; y ++ ) {
        vec2 d = vec2( x, y );
        vec4 px = texture2D( map, vUv + d * texel );
        vec3 dc = squash( max( px.rgb, 0.0 ) ) - centreS;
        float w = exp( - dot( d, d ) * invSigma - dot( dc, dc ) * invThreshold );
        total += w;
        sum += w * px;
      }
    }
    gl_FragColor = total > 0.0 ? sum / total : centre;
  }
`;

const VERTEX = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }';

const UPSCALE_FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  uniform vec2 texel;
  uniform float sharpness;
  varying vec2 vUv;
  void main() {
    // Filtrage bilinéaire matériel + netteté adaptative bornée au voisinage (pas de halos).
    vec4 c = texture2D( map, vUv );
    vec3 n = texture2D( map, vUv + vec2( 0.0, texel.y ) ).rgb;
    vec3 s = texture2D( map, vUv - vec2( 0.0, texel.y ) ).rgb;
    vec3 e = texture2D( map, vUv + vec2( texel.x, 0.0 ) ).rgb;
    vec3 w = texture2D( map, vUv - vec2( texel.x, 0.0 ) ).rgb;
    vec3 lo = min( c.rgb, min( min( n, s ), min( e, w ) ) );
    vec3 hi = max( c.rgb, max( max( n, s ), max( e, w ) ) );
    vec3 sharp = c.rgb + sharpness * ( c.rgb - 0.25 * ( n + s + e + w ) );
    gl_FragColor = vec4( clamp( sharp, lo, hi ), c.a );
  }
`;

function makeTarget(): WebGLRenderTarget {
  const rt = new WebGLRenderTarget(1, 1, { type: HalfFloatType, format: RGBAFormat, depthBuffer: false, stencilBuffer: false });
  rt.texture.minFilter = LinearFilter;
  rt.texture.magFilter = LinearFilter;
  rt.texture.generateMipmaps = false;
  return rt;
}

/** Passes de reconstruction de l'image tracée (débruitage puis remise à l'échelle). */
export class Upscaler {
  private denoiseRT: WebGLRenderTarget | null = null;
  private preRT: WebGLRenderTarget | null = null;
  private outRT: WebGLRenderTarget | null = null;
  private denoiseQuad: FullScreenQuad | null = null;
  private upscaleQuad: FullScreenQuad | null = null;
  constructor(private readonly renderer: WebGLRenderer) {}

  /**
   * Reconstruit l'image : `source` est l'accumulation HDR linéaire (taille `srcW × srcH`),
   * le résultat est une texture HDR linéaire à présenter. Renvoie `source` s'il n'y a rien à faire.
   */
  process(source: Texture, srcW: number, srcH: number, outW: number, outH: number, samples: number, denoise: boolean): Texture {
    const r = this.renderer;
    const strength = denoise ? denoiseStrength(samples) : null;
    const scaled = srcW < outW || srcH < outH;
    if (!strength && !scaled) return source;

    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.autoClear = false;
    let current = source;
    try {
      if (strength) {
        if (!this.denoiseRT) this.denoiseRT = makeTarget();
        if (this.denoiseRT.width !== srcW || this.denoiseRT.height !== srcH) this.denoiseRT.setSize(srcW, srcH);
        if (!this.denoiseQuad) {
          this.denoiseQuad = new FullScreenQuad(
            new ShaderMaterial({
              uniforms: { map: { value: null }, texel: { value: new Vector2() }, sigma: { value: 3 }, threshold: { value: 0.1 } },
              vertexShader: VERTEX,
              fragmentShader: DENOISE_FRAGMENT,
              blending: NoBlending,
              depthTest: false,
              depthWrite: false,
              toneMapped: false,
            }),
          );
        }
        const mat = this.denoiseQuad.material as ShaderMaterial;
        (mat.uniforms.texel.value as Vector2).set(1 / srcW, 1 / srcH);
        // Premières passes : chaque pixel vaut « tout ou rien », un filtre bilatéral n'y reconnaît
        // aucun voisin. Un léger flou gaussien préalable (sans seuil) lui donne de quoi comparer.
        const pre = samples < 24 ? 1.7 * (1 - samples / 24) : 0;
        if (pre > 0.45) {
          if (!this.preRT) this.preRT = makeTarget();
          if (this.preRT.width !== srcW || this.preRT.height !== srcH) this.preRT.setSize(srcW, srcH);
          mat.uniforms.map.value = current;
          mat.uniforms.sigma.value = pre;
          mat.uniforms.threshold.value = 1000;
          r.setRenderTarget(this.preRT);
          this.denoiseQuad.render(r);
          current = this.preRT.texture;
        }
        mat.uniforms.map.value = current;
        mat.uniforms.sigma.value = strength.sigma;
        mat.uniforms.threshold.value = strength.threshold;
        r.setRenderTarget(this.denoiseRT);
        this.denoiseQuad.render(r);
        current = this.denoiseRT.texture;
      }
      if (scaled) {
        if (!this.outRT) this.outRT = makeTarget();
        if (this.outRT.width !== outW || this.outRT.height !== outH) this.outRT.setSize(outW, outH);
        if (!this.upscaleQuad) {
          this.upscaleQuad = new FullScreenQuad(
            new ShaderMaterial({
              uniforms: { map: { value: null }, texel: { value: new Vector2() }, sharpness: { value: 0.5 } },
              vertexShader: VERTEX,
              fragmentShader: UPSCALE_FRAGMENT,
              blending: NoBlending,
              depthTest: false,
              depthWrite: false,
              toneMapped: false,
            }),
          );
        }
        const mat = this.upscaleQuad.material as ShaderMaterial;
        mat.uniforms.map.value = current;
        (mat.uniforms.texel.value as Vector2).set(1 / srcW, 1 / srcH);
        // Tant que l'image est bruitée on n'accentue pas (cela amplifierait le grain).
        mat.uniforms.sharpness.value = 0.1 + 0.4 * Math.min(1, samples / 512);
        r.setRenderTarget(this.outRT);
        this.upscaleQuad.render(r);
        current = this.outRT.texture;
      }
    } finally {
      r.setRenderTarget(prevTarget);
      r.autoClear = prevAutoClear;
    }
    return current;
  }

  dispose(): void {
    this.denoiseRT?.dispose();
    this.preRT?.dispose();
    this.preRT = null;
    this.outRT?.dispose();
    this.denoiseQuad?.material.dispose();
    this.denoiseQuad?.dispose();
    this.upscaleQuad?.material.dispose();
    this.upscaleQuad?.dispose();
    this.denoiseRT = this.outRT = null;
    this.denoiseQuad = this.upscaleQuad = null;
  }
}
