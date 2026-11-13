import {
  Color,
  DoubleSide,
  FloatType,
  HalfFloatType,
  LinearFilter,
  MeshBasicMaterial,
  NearestFilter,
  NoBlending,
  RGBAFormat,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type Camera,
  type Material,
  type Mesh,
  type Object3D,
  type Scene,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import type { AtrousParams } from './settings';

/**
 * Débruiteur « Haute qualité » du path tracing : filtre à-trous en ondelettes guidé par les
 * tampons d'ALBÉDO et de NORMALES (+ profondeur), d'après « Edge-Avoiding À-Trous Wavelet
 * Transform for fast Global Illumination Filtering » (Dammertz et al., 2010), dans l'esprit
 * de SVGF.
 *
 * C'est le même PRINCIPE que les débruiteurs OptiX (NVIDIA) et OpenImageDenoise (Intel), qui
 * reçoivent eux aussi ces passes guides : le filtre lisse le bruit sans franchir les arêtes
 * géométriques (normales, profondeur) ni les changements de matière (albédo). Ce n'est PAS
 * l'un d'eux : ils reposent sur des réseaux de neurones natifs, inaccessibles depuis WebGL ;
 * ici le filtre est analytique, en GLSL, et tourne sur tout GPU.
 *
 * Les passes guides sont rastérisées (rapides) une seule fois par accumulation : elles ne
 * changent que si la scène, la caméra ou la taille changent, ce qui relance de toute façon
 * l'accumulation du path tracer.
 */

// ------------------------------------------------------------------ logique pure (testée)

/** Noyau B3-spline 1D de l'à-trous (somme = 1), indices −2..2. */
export const ATROUS_KERNEL: readonly number[] = [1 / 16, 1 / 4, 3 / 8, 1 / 4, 1 / 16];

/** Poids 2D du noyau pour un décalage (dx, dy) ∈ [−2, 2]². La somme des 25 poids vaut 1. */
export function atrousKernelWeight(dx: number, dy: number): number {
  const a = ATROUS_KERNEL[dx + 2];
  const b = ATROUS_KERNEL[dy + 2];
  return a === undefined || b === undefined ? 0 : a * b;
}

/** Écart entre deux échantillons à l'itération `i` (0, 1, 2…) : 1, 2, 4… pixels (les « trous »). */
export function atrousStep(iteration: number): number {
  return 1 << Math.max(0, Math.min(10, Math.floor(iteration)));
}

/**
 * Tolérance de couleur (sur des couleurs compressées c / (1 + c), donc entre 0 et 1) à
 * l'itération `i` : proportionnelle au bruit attendu, qui décroît en 1/√échantillons, et
 * divisée par deux à chaque itération (les échelles grossières ne lissent que le bruit
 * résiduel). Renvoie 0 quand il n'y a plus rien à lisser.
 */
export function atrousColorSigma(samples: number, strength: number, iteration: number): number {
  const s = Math.max(1, Number.isFinite(samples) ? samples : 1);
  const k = Math.max(0, Number.isFinite(strength) ? strength : 1);
  if (k === 0) return 0;
  const base = Math.min(1.2, Math.max(0.008, 0.8 / Math.sqrt(s)));
  return k * base * Math.pow(0.5, Math.max(0, iteration));
}

/** Exposant du poids de normale : pow(max(0, n·n'), e). 0 = guide de normales ignoré. */
export function normalExponent(weight: number): number {
  return Math.max(0, Number.isFinite(weight) ? weight : 1) * 32;
}

/** Facteur du poids d'albédo : exp(−|Δa|² · f). 0 = guide d'albédo ignoré. */
export function albedoFactor(weight: number): number {
  return Math.max(0, Number.isFinite(weight) ? weight : 1) * 50;
}

// ------------------------------------------------------------------ passes guides

const NORMAL_DEPTH_VERTEX = /* glsl */ `
  varying vec3 vWorldNormal;
  varying float vViewZ;
  void main() {
    vec4 mv = modelViewMatrix * vec4( position, 1.0 );
    vViewZ = - mv.z;
    // Normale monde : normale vue (matrice normale) ramenée dans le repère monde.
    vWorldNormal = normalize( ( vec4( normalMatrix * normal, 0.0 ) * viewMatrix ).xyz );
    gl_Position = projectionMatrix * mv;
  }
`;

const NORMAL_DEPTH_FRAGMENT = /* glsl */ `
  varying vec3 vWorldNormal;
  varying float vViewZ;
  void main() {
    vec3 n = normalize( vWorldNormal );
    if ( ! gl_FrontFacing ) n = - n;
    // alpha = profondeur de vue (> 0) ; 0 marque le fond.
    gl_FragColor = vec4( n, max( vViewZ, 1e-4 ) );
  }
`;

function guideTarget(): WebGLRenderTarget {
  const rt = new WebGLRenderTarget(1, 1, { type: HalfFloatType, format: RGBAFormat, depthBuffer: true, stencilBuffer: false });
  rt.texture.minFilter = NearestFilter;
  rt.texture.magFilter = NearestFilter;
  rt.texture.generateMipmaps = false;
  return rt;
}

/** Couleur de base (albédo) d'un matériau quelconque, en linéaire. */
function albedoOf(m: Material, out: Color): Color {
  const any = m as any;
  if (any.color && any.color.isColor) out.copy(any.color);
  else out.setRGB(0.8, 0.8, 0.8);
  return out;
}

/**
 * Rastérise les passes guides (albédo ; normale monde + profondeur de vue) à la taille de
 * l'accumulation. Les lignes, points et sprites (aides du viewport) sont masqués.
 */
export class GuideBuffers {
  readonly albedo = guideTarget();
  readonly normalDepth = guideTarget();
  private normalMat = new ShaderMaterial({
    vertexShader: NORMAL_DEPTH_VERTEX,
    fragmentShader: NORMAL_DEPTH_FRAGMENT,
    side: DoubleSide,
    toneMapped: false,
  });
  private albedoMats = new WeakMap<Material, MeshBasicMaterial>();
  private owned: MeshBasicMaterial[] = [];
  private tmp = new Color();

  private albedoMaterialFor(src: Material): MeshBasicMaterial {
    let m = this.albedoMats.get(src);
    if (!m) {
      m = new MeshBasicMaterial({ toneMapped: false, fog: false });
      this.albedoMats.set(src, m);
      this.owned.push(m);
    }
    m.color.copy(albedoOf(src, this.tmp));
    m.side = src.side;
    m.visible = src.visible;
    return m;
  }

  render(renderer: WebGLRenderer, scene: Scene, camera: Camera, width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (this.albedo.width !== w || this.albedo.height !== h) {
      this.albedo.setSize(w, h);
      this.normalDepth.setSize(w, h);
    }
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevClear = renderer.getClearColor(new Color());
    const prevAlpha = renderer.getClearAlpha();
    const prevAutoUpdate = renderer.shadowMap.autoUpdate;
    const prevShadows = renderer.shadowMap.enabled;
    const prevBackground = scene.background;
    const prevOverride = scene.overrideMaterial;
    const hidden: Object3D[] = [];
    const swapped: { mesh: Mesh; material: Material | Material[] }[] = [];
    scene.traverse((o) => {
      const any = o as any;
      if ((any.isLine || any.isPoints || any.isSprite) && o.visible) {
        o.visible = false;
        hidden.push(o);
      }
    });
    try {
      renderer.autoClear = true;
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.enabled = false;
      renderer.setClearColor(0x000000, 0);
      scene.background = null;

      // Normales + profondeur : matériau unique.
      scene.overrideMaterial = this.normalMat;
      renderer.setRenderTarget(this.normalDepth);
      renderer.render(scene, camera);
      scene.overrideMaterial = null;

      // Albédo : un matériau uni par matériau source (couleur de base).
      scene.traverse((o) => {
        const mesh = o as Mesh;
        if (!(mesh as any).isMesh || !mesh.material) return;
        swapped.push({ mesh, material: mesh.material });
        mesh.material = Array.isArray(mesh.material)
          ? mesh.material.map((m) => this.albedoMaterialFor(m))
          : this.albedoMaterialFor(mesh.material);
      });
      renderer.setRenderTarget(this.albedo);
      renderer.render(scene, camera);
    } finally {
      for (const s of swapped) s.mesh.material = s.material;
      for (const o of hidden) o.visible = true;
      scene.overrideMaterial = prevOverride;
      scene.background = prevBackground;
      renderer.setClearColor(prevClear, prevAlpha);
      renderer.shadowMap.autoUpdate = prevAutoUpdate;
      renderer.shadowMap.enabled = prevShadows;
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    }
  }

  dispose(): void {
    this.albedo.dispose();
    this.normalDepth.dispose();
    this.normalMat.dispose();
    for (const m of this.owned) m.dispose();
    this.owned = [];
    this.albedoMats = new WeakMap();
  }
}

// ------------------------------------------------------------------ filtre à-trous

const VERTEX = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }';

/**
 * Une itération de l'à-trous. Première itération : la couleur est « démodulée » (divisée par
 * l'albédo) pour ne filtrer que l'éclairage ; dernière itération : elle est remodulée, ce qui
 * garde nettes les couleurs des matières.
 */
const ATROUS_FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  uniform sampler2D albedoMap;
  uniform sampler2D normalDepthMap;
  uniform vec2 texel;
  uniform float stepWidth;
  uniform float sigmaColor;
  uniform float normalExp;
  uniform float albedoK;
  uniform float demodIn;
  uniform float remodOut;
  varying vec2 vUv;

  const float K[ 5 ] = float[ 5 ]( 0.0625, 0.25, 0.375, 0.25, 0.0625 );

  vec3 squash( vec3 c ) { return c / ( 1.0 + c ); }
  vec3 albedoAt( vec4 a ) { return a.a > 0.0 ? max( a.rgb, vec3( 0.02 ) ) : vec3( 1.0 ); }

  void main() {
    vec4 cP = texture2D( map, vUv );
    vec4 gP = texture2D( normalDepthMap, vUv );
    vec4 aP = texture2D( albedoMap, vUv );
    vec3 albP = albedoAt( aP );
    vec3 colP = demodIn > 0.5 ? cP.rgb / albP : cP.rgb;
    vec3 sP = squash( max( colP, 0.0 ) );
    bool bgP = gP.a <= 0.0;
    float invSigma = 1.0 / max( sigmaColor * sigmaColor, 1e-8 );

    vec4 sum = vec4( 0.0 );
    float wSum = 0.0;
    for ( int y = - 2; y <= 2; y ++ ) {
      for ( int x = - 2; x <= 2; x ++ ) {
        vec2 uv = vUv + vec2( float( x ), float( y ) ) * stepWidth * texel;
        vec4 c = texture2D( map, uv );
        vec4 g = texture2D( normalDepthMap, uv );
        vec4 a = texture2D( albedoMap, uv );
        bool bg = g.a <= 0.0;
        if ( bg != bgP ) continue;
        vec3 col = demodIn > 0.5 ? c.rgb / albedoAt( a ) : c.rgb;
        vec3 dc = squash( max( col, 0.0 ) ) - sP;
        float w = K[ x + 2 ] * K[ y + 2 ] * exp( - dot( dc, dc ) * invSigma );
        if ( ! bgP ) {
          if ( normalExp > 0.0 ) w *= pow( max( dot( gP.xyz, g.xyz ), 0.0 ), normalExp );
          // Profondeur : écart relatif toléré croissant avec la distance au pixel.
          float dz = abs( gP.a - g.a ) / ( gP.a * 0.02 * stepWidth + 1e-4 );
          w *= exp( - dz );
          if ( albedoK > 0.0 ) {
            vec3 da = a.rgb - aP.rgb;
            w *= exp( - dot( da, da ) * albedoK );
          }
        }
        sum += w * vec4( col, c.a );
        wSum += w;
      }
    }
    vec4 outC = wSum > 1e-8 ? sum / wSum : vec4( colP, cP.a );
    if ( remodOut > 0.5 ) outC.rgb *= albP;
    gl_FragColor = outC;
  }
`;

function floatTarget(linear: boolean): WebGLRenderTarget {
  // Intermédiaires en flottant 32 bits (la démodulation peut dépasser la plage du demi-flottant) ;
  // sortie en demi-flottant filtrable (la remise à l'échelle utilise le filtrage bilinéaire).
  const rt = new WebGLRenderTarget(1, 1, {
    type: linear ? HalfFloatType : FloatType,
    format: RGBAFormat,
    depthBuffer: false,
    stencilBuffer: false,
  });
  rt.texture.minFilter = linear ? LinearFilter : NearestFilter;
  rt.texture.magFilter = linear ? LinearFilter : NearestFilter;
  rt.texture.generateMipmaps = false;
  return rt;
}

export class AtrousDenoiser {
  private ping = floatTarget(false);
  private pong = floatTarget(false);
  private out = floatTarget(true);
  private quad = new FullScreenQuad(
    new ShaderMaterial({
      uniforms: {
        map: { value: null },
        albedoMap: { value: null },
        normalDepthMap: { value: null },
        texel: { value: new Vector2() },
        stepWidth: { value: 1 },
        sigmaColor: { value: 0.1 },
        normalExp: { value: 32 },
        albedoK: { value: 50 },
        demodIn: { value: 0 },
        remodOut: { value: 0 },
      },
      vertexShader: VERTEX,
      fragmentShader: ATROUS_FRAGMENT,
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
  );

  constructor(private readonly renderer: WebGLRenderer) {}

  /**
   * Débruite `source` (HDR linéaire, `width × height`) avec les guides fournis. Renvoie une
   * texture HDR linéaire filtrable, ou `source` si la force est nulle.
   */
  process(source: Texture, guides: GuideBuffers, width: number, height: number, samples: number, p: AtrousParams): Texture {
    if (atrousColorSigma(samples, p.strength, 0) <= 0) return source;
    const r = this.renderer;
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    for (const rt of [this.ping, this.pong, this.out]) if (rt.width !== w || rt.height !== h) rt.setSize(w, h);
    const mat = this.quad.material as ShaderMaterial;
    const u = mat.uniforms;
    u.albedoMap.value = guides.albedo.texture;
    u.normalDepthMap.value = guides.normalDepth.texture;
    (u.texel.value as Vector2).set(1 / w, 1 / h);
    u.normalExp.value = normalExponent(p.normalWeight);
    u.albedoK.value = albedoFactor(p.albedoWeight);

    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.autoClear = false;
    let current: Texture = source;
    try {
      const n = Math.max(1, Math.min(6, Math.round(p.iterations)));
      for (let i = 0; i < n; i++) {
        const last = i === n - 1;
        const dest = last ? this.out : i % 2 === 0 ? this.ping : this.pong;
        u.map.value = current;
        u.stepWidth.value = atrousStep(i);
        u.sigmaColor.value = atrousColorSigma(samples, p.strength, i);
        u.demodIn.value = i === 0 ? 1 : 0;
        u.remodOut.value = last ? 1 : 0;
        r.setRenderTarget(dest);
        this.quad.render(r);
        current = dest.texture;
      }
    } finally {
      r.setRenderTarget(prevTarget);
      r.autoClear = prevAutoClear;
    }
    return current;
  }

  dispose(): void {
    this.ping.dispose();
    this.pong.dispose();
    this.out.dispose();
    this.quad.material.dispose();
    this.quad.dispose();
  }
}
