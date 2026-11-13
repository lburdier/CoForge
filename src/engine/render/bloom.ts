import { HalfFloatType, LinearFilter, NoBlending, RGBAFormat, ShaderMaterial, Vector2, WebGLRenderTarget, type Texture, type WebGLRenderer } from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { BloomParams } from './settings';

/**
 * Bloom du path tracing, appliqué sur l'image HDR linéaire (après le débruitage, avant le tone
 * mapping), dans l'esprit du Bloom d'EEVEE Legacy / du nœud Glare (« Bloom ») du compositeur :
 *
 *   préfiltre à seuil doux (genou) + écrêtage → flou multi-échelle (5 niveaux, UnrealBloomPass
 *   de three) → ajout à l'image.
 *
 * Le préfiltre de UnrealBloomPass (seuil dur, sans écrêtage) est remplacé par celui d'EEVEE :
 * en HDR, une source lumineuse vue directement vaut des centaines, et ferait un halo démesuré.
 * Désactivé, le module n'est même pas instancié (aucun coût).
 */

/** Écrêtage interne de la lumière qui alimente le halo (valeur linéaire). */
const BLOOM_CLAMP = 64;

const VERTEX = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }';

const PREFILTER_FRAGMENT = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform float luminosityThreshold;
  uniform float clampMax;
  varying vec2 vUv;
  void main() {
    vec3 c = min( max( texture2D( tDiffuse, vUv ).rgb, 0.0 ), vec3( clampMax ) );
    float br = max( c.r, max( c.g, c.b ) );
    // Genou d'EEVEE : transition douce sur une demi-largeur de seuil.
    float knee = max( luminosityThreshold * 0.5, 1e-4 );
    float rq = clamp( br - luminosityThreshold + knee, 0.0, 2.0 * knee );
    rq = rq * rq / ( 4.0 * knee );
    float w = max( rq, br - luminosityThreshold ) / max( br, 1e-4 );
    gl_FragColor = vec4( c * w, 1.0 );
  }
`;

const COPY_FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  varying vec2 vUv;
  void main() { gl_FragColor = texture2D( map, vUv ); }
`;

export class PathBloom {
  private rt: WebGLRenderTarget;
  private pass: UnrealBloomPass;
  private copy: FullScreenQuad;
  private width = 0;
  private height = 0;

  constructor(private readonly renderer: WebGLRenderer) {
    this.rt = new WebGLRenderTarget(1, 1, { type: HalfFloatType, format: RGBAFormat, depthBuffer: false, stencilBuffer: false });
    this.rt.texture.minFilter = LinearFilter;
    this.rt.texture.magFilter = LinearFilter;
    this.rt.texture.generateMipmaps = false;
    this.pass = new UnrealBloomPass(new Vector2(1, 1), 0.3, 0.5, 1);
    const prefilter = new ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, luminosityThreshold: { value: 1 }, clampMax: { value: BLOOM_CLAMP } },
      vertexShader: VERTEX,
      fragmentShader: PREFILTER_FRAGMENT,
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    // UnrealBloomPass lit `highPassUniforms` et `materialHighPassFilter` à chaque rendu.
    const anyPass = this.pass as any;
    anyPass.materialHighPassFilter?.dispose?.();
    anyPass.materialHighPassFilter = prefilter;
    anyPass.highPassUniforms = prefilter.uniforms;
    this.copy = new FullScreenQuad(
      new ShaderMaterial({
        uniforms: { map: { value: null } },
        vertexShader: VERTEX,
        fragmentShader: COPY_FRAGMENT,
        blending: NoBlending,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
  }

  /** Renvoie une texture HDR linéaire : `source` (taille `width × height`) plus son halo. */
  process(source: Texture, width: number, height: number, p: BloomParams): Texture {
    const r = this.renderer;
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w !== this.width || h !== this.height) {
      this.width = w;
      this.height = h;
      this.rt.setSize(w, h);
      this.pass.setSize(w, h);
    }
    // Rayon (0 à 1) : poids des niveaux de flou grossiers de UnrealBloomPass (0 = halo serré, 1 = large).
    this.pass.strength = p.intensity;
    this.pass.radius = p.radius;
    this.pass.threshold = p.threshold;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    try {
      r.autoClear = false;
      // Copie : l'accumulation du path tracer ne doit jamais être modifiée (le halo s'y ajouterait à chaque image).
      (this.copy.material as ShaderMaterial).uniforms.map.value = source;
      r.setRenderTarget(this.rt);
      this.copy.render(r);
      this.pass.renderToScreen = false;
      this.pass.render(r, this.rt, this.rt, 0, false);
    } finally {
      r.setRenderTarget(prevTarget);
      r.autoClear = prevAutoClear;
    }
    return this.rt.texture;
  }

  dispose(): void {
    this.rt.dispose();
    this.pass.dispose();
    this.copy.material.dispose();
    this.copy.dispose();
  }
}
