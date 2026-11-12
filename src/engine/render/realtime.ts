import {
  CustomBlending,
  DoubleSide,
  HalfFloatType,
  NoBlending,
  OneFactor,
  ZeroFactor,
  MeshBasicMaterial,
  Vector2,
  WebGLRenderTarget,
  type Camera,
  type DirectionalLight,
  type Light,
  type PointLight,
  type Scene,
  type SpotLight,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { CopyShader } from 'three/examples/jsm/shaders/CopyShader.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { RenderSettings } from '../../core/doc/schema';

/**
 * Chaîne de rendu temps réel (dans l'esprit d'EEVEE) :
 *
 *   scène → cible HDR linéaire multiéchantillonnée (MSAA ×4, ombres PCF)
 *         → occlusion ambiante GTAO (si `ao`)
 *         → bloom (si `bloom`)
 *         → OutputPass : tone mapping + exposition + conversion sRGB → écran ou cible finale.
 *
 * Les cibles sont propres à la chaîne : elle peut donc tourner à n'importe quelle
 * résolution sans toucher à la taille du canvas (rendu final hors écran).
 */
export class RealtimeChain {
  private sceneRT: WebGLRenderTarget;
  private pingRT: WebGLRenderTarget;
  private gtao: GTAOPass | null = null;
  private gtaoPerspective = true;
  private bloom: UnrealBloomPass | null = null;
  private copy: ShaderPass | null = null;
  readonly output = new OutputPass();
  private width = 1;
  private height = 1;

  constructor(private renderer: WebGLRenderer, msaa = 4) {
    const maxSamples = renderer.capabilities.maxSamples ?? 0;
    const samples = Math.max(0, Math.min(msaa, maxSamples));
    this.sceneRT = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples, depthBuffer: true });
    this.pingRT = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.sceneRT.setSize(w, h);
    this.pingRT.setSize(w, h);
    this.gtao?.setSize(w, h);
    this.bloom?.setSize(w, h);
  }

  getSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  private ensureGtao(scene: Scene, camera: Camera): GTAOPass {
    const perspective = (camera as any).isPerspectiveCamera === true;
    if (this.gtao && this.gtaoPerspective !== perspective) {
      // Le type de projection est figé dans les defines des shaders : on recrée la passe.
      this.gtao.dispose();
      this.gtao = null;
    }
    if (!this.gtao) {
      this.gtao = new GTAOPass(scene, camera, this.width, this.height);
      // Unités en mètres : rayon d'occlusion d'un demi-mètre, adoucissement Poisson.
      this.gtao.updateGtaoMaterial({ radius: 0.5, distanceExponent: 1, thickness: 1, scale: 1, samples: 16 });
      this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
      this.gtao.blendIntensity = 1;
      this.gtaoPerspective = perspective;
    }
    this.gtao.scene = scene;
    this.gtao.camera = camera;
    return this.gtao;
  }

  private ensureBloom(): UnrealBloomPass {
    if (!this.bloom) {
      // Seuil en luminance linéaire HDR : seules les zones plus claires que le blanc diffus « bavent ».
      this.bloom = new UnrealBloomPass(new Vector2(this.width, this.height), 0.35, 0.5, 1.0);
    }
    return this.bloom;
  }

  /**
   * Rend la scène dans la cible HDR puis applique les effets. Renvoie la texture HDR
   * linéaire résultante (avant tone mapping), à présenter avec `present`.
   */
  renderHDR(scene: Scene, camera: Camera, settings: RenderSettings, opts: { clearAlpha?: number } = {}): Texture {
    const r = this.renderer;
    const prevAutoClear = r.autoClear;
    const prevAutoUpdate = r.shadowMap.autoUpdate;
    const prevClearAlpha = r.getClearAlpha();
    try {
      r.autoClear = true;
      if (opts.clearAlpha !== undefined) r.setClearAlpha(opts.clearAlpha);
      r.setRenderTarget(this.sceneRT);
      r.render(scene, camera);
      // Les ombres sont déjà à jour pour cette image : les passes suivantes (GBuffer de l'AO) ne les recalculent pas.
      r.shadowMap.autoUpdate = false;
      if (opts.clearAlpha !== undefined) r.setClearAlpha(prevClearAlpha);

      let read: WebGLRenderTarget = this.sceneRT;
      let write: WebGLRenderTarget = this.pingRT;
      if (settings.ao) {
        const gtao = this.ensureGtao(scene, camera);
        gtao.renderToScreen = false;
        gtao.render(r, write, read, 0, false);
        [read, write] = [write, read];
      }
      if (settings.bloom) {
        if (read === this.sceneRT) {
          // Le bloom se compose EN PLACE dans la cible lue : on n'écrit jamais dans la cible
          // multiéchantillonnée (son contenu est invalidé après résolution), on la recopie d'abord.
          if (!this.copy) this.copy = new ShaderPass(CopyShader);
          this.copy.renderToScreen = false;
          this.copy.render(r, this.pingRT, this.sceneRT, 0, false);
          read = this.pingRT;
        }
        const bloom = this.ensureBloom();
        bloom.renderToScreen = false;
        bloom.render(r, write, read, 0, false);
      }
      return read.texture;
    } finally {
      r.shadowMap.autoUpdate = prevAutoUpdate;
      r.autoClear = prevAutoClear;
    }
  }

  /** Présente une texture HDR linéaire : tone mapping + exposition (réglages du renderer) + sRGB. */
  present(texture: Texture, dest: WebGLRenderTarget | null): void {
    presentTexture(this.renderer, this.output, texture, dest);
  }

  dispose(): void {
    this.sceneRT.dispose();
    this.pingRT.dispose();
    this.gtao?.dispose();
    this.bloom?.dispose();
    this.copy?.dispose();
    this.output.dispose();
    this.gtao = null;
    this.bloom = null;
    this.copy = null;
  }
}

/**
 * Dessine une texture HDR linéaire vers l'écran (`dest` null) ou vers une cible, à travers
 * l'OutputPass (tone mapping, exposition et espace de couleur lus sur le renderer).
 * À l'écran, l'image est toujours opaque (alpha du canvas maintenu à 1) ; dans une cible,
 * l'alpha de la texture est recopié tel quel (fond transparent du rendu final).
 */
export function presentTexture(renderer: WebGLRenderer, output: OutputPass, texture: Texture, dest: WebGLRenderTarget | null): void {
  const prevAutoClear = renderer.autoClear;
  const prevClearAlpha = renderer.getClearAlpha();
  const mat = output.material;
  renderer.autoClear = false;
  mat.depthTest = false;
  mat.depthWrite = false;
  try {
    if (dest === null) {
      // L'écran peut contenir la profondeur de l'image précédente : on repart d'un tampon propre,
      // alpha à 1, puis on écrit la couleur sans toucher à l'alpha.
      renderer.setRenderTarget(null);
      renderer.setClearAlpha(1);
      renderer.clear(true, true, true);
      mat.blending = CustomBlending;
      mat.blendSrc = OneFactor;
      mat.blendDst = ZeroFactor;
      mat.blendSrcAlpha = ZeroFactor;
      mat.blendDstAlpha = OneFactor;
    } else {
      mat.blending = NoBlending;
    }
    output.renderToScreen = dest === null;
    output.clear = dest !== null;
    // OutputPass ne lit que `readBuffer.texture`.
    output.render(renderer, dest as WebGLRenderTarget, { texture } as WebGLRenderTarget, 0, false);
  } finally {
    renderer.autoClear = prevAutoClear;
    renderer.setClearAlpha(prevClearAlpha);
  }
}

// ------------------------------------------------------------------ ombres

const shadowQuality = new WeakMap<Light, string>();

/**
 * Taille des shadow maps et douceur du filtrage PCF selon la qualité :
 * 1024 (bas) / 4096 (haut) ; les lumières ponctuelles (six faces) sont limitées à 512 / 1024.
 * Appliqué une seule fois par lumière et par changement de qualité, pour ne pas lutter
 * contre d'éventuels réglages du moteur de scène.
 */
export function applyShadowQuality(scene: Scene, quality: RenderSettings['shadows']): void {
  if (quality === 'off') return;
  scene.traverse((o) => {
    const any = o as any;
    if (!any.isLight || !any.shadow || any.isRectAreaLight) return;
    const light = o as PointLight | SpotLight | DirectionalLight;
    if (shadowQuality.get(light) === quality) return;
    shadowQuality.set(light, quality);
    const isPoint = any.isPointLight === true;
    // Ponctuelles : three alloue un atlas de (4 × taille) × (2 × taille) ; 1024 → 4096 × 2048 (32 Mo)
    // au lieu de 8192 × 4096 (128 Mo) à 2048, pour une différence peu visible avec le filtrage PCF.
    const size = quality === 'high' ? (isPoint ? 1024 : 4096) : isPoint ? 512 : 1024;
    if (light.shadow.mapSize.x !== size || light.shadow.mapSize.y !== size) {
      light.shadow.mapSize.set(size, size);
      if (light.shadow.map) {
        light.shadow.map.dispose();
        (light.shadow as any).map = null;
      }
    }
    light.shadow.radius = quality === 'high' ? 3 : 2;
    light.shadow.blurSamples = quality === 'high' ? 16 : 8;
  });
}

// ------------------------------------------------------------------ prépasse de profondeur (overlay)

/**
 * Remplit le tampon de profondeur de l'écran avec la scène, sans toucher aux couleurs,
 * pour que l'overlay (gizmos, aides) dessiné ensuite soit correctement occulté par les
 * surfaces quand l'image a été composée hors écran (temps réel, path tracing).
 */
export class DepthPrepass {
  private material = new MeshBasicMaterial({ colorWrite: false, side: DoubleSide });

  constructor() {
    // Même recul que les matériaux de surface du viewport : les arêtes dessinées par-dessus ne scintillent pas.
    this.material.polygonOffset = true;
    this.material.polygonOffsetFactor = 1;
    this.material.polygonOffsetUnits = 1;
  }

  render(renderer: WebGLRenderer, scene: Scene, camera: Camera): void {
    const prevOverride = scene.overrideMaterial;
    const prevBackground = scene.background;
    const prevAutoClear = renderer.autoClear;
    const prevAutoUpdate = renderer.shadowMap.autoUpdate;
    // Les lignes et points de la scène (fil de fer…) n'occultent pas l'overlay.
    const hidden: { visible: boolean }[] = [];
    scene.traverse((o) => {
      const any = o as any;
      if ((any.isLine || any.isPoints || any.isSprite) && o.visible) {
        o.visible = false;
        hidden.push(o);
      }
    });
    try {
      renderer.setRenderTarget(null);
      renderer.clearDepth();
      renderer.autoClear = false;
      renderer.shadowMap.autoUpdate = false;
      scene.background = null;
      scene.overrideMaterial = this.material;
      renderer.render(scene, camera);
    } finally {
      for (const o of hidden) o.visible = true;
      scene.overrideMaterial = prevOverride;
      scene.background = prevBackground;
      renderer.autoClear = prevAutoClear;
      renderer.shadowMap.autoUpdate = prevAutoUpdate;
    }
  }

  dispose(): void {
    this.material.dispose();
  }
}

// ------------------------------------------------------------------ masque d'opacité (fond transparent)

/**
 * Masque de couverture de la scène (alpha = 1 sur les objets, 0 sur le fond, bords
 * anticrénelés par le MSAA) : sert au fond transparent du rendu final temps réel,
 * dont les passes AO/bloom ne préservent pas l'alpha.
 */
export function renderCoverageMask(renderer: WebGLRenderer, scene: Scene, camera: Camera, width: number, height: number): Uint8Array {
  const maxSamples = renderer.capabilities.maxSamples ?? 0;
  const rt = new WebGLRenderTarget(width, height, { samples: Math.min(4, maxSamples), depthBuffer: true });
  const mat = new MeshBasicMaterial({ color: 0xffffff, side: DoubleSide });
  const prevOverride = scene.overrideMaterial;
  const prevBackground = scene.background;
  const prevAutoClear = renderer.autoClear;
  const prevAutoUpdate = renderer.shadowMap.autoUpdate;
  const prevAlpha = renderer.getClearAlpha();
  const hidden: { visible: boolean }[] = [];
  scene.traverse((o) => {
    const any = o as any;
    if ((any.isLine || any.isPoints || any.isSprite) && o.visible) {
      o.visible = false;
      hidden.push(o);
    }
  });
  try {
    scene.overrideMaterial = mat;
    scene.background = null;
    renderer.autoClear = true;
    renderer.shadowMap.autoUpdate = false;
    renderer.setClearAlpha(0);
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    const px = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, width, height, px);
    return px;
  } finally {
    for (const o of hidden) o.visible = true;
    scene.overrideMaterial = prevOverride;
    scene.background = prevBackground;
    renderer.autoClear = prevAutoClear;
    renderer.shadowMap.autoUpdate = prevAutoUpdate;
    renderer.setClearAlpha(prevAlpha);
    mat.dispose();
    rt.dispose();
  }
}
