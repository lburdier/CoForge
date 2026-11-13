import type { Camera, Scene, Texture, WebGLRenderer } from 'three';
import { PathBloom } from './bloom';
import { AtrousDenoiser, GuideBuffers } from './denoise';
import { planPostPasses, type AtrousParams, type BloomParams, type DenoiserKind } from './settings';
import { Upscaler, denoiseStrength } from './upscale';

export interface PostArgs {
  scene: Scene;
  camera: Camera;
  /** Accumulation HDR linéaire du path tracer. */
  source: Texture;
  srcW: number;
  srcH: number;
  outW: number;
  outH: number;
  samples: number;
  denoiser: DenoiserKind;
  atrous: AtrousParams;
  bloom: BloomParams | null;
  /** Les passes guides doivent être rastérisées à nouveau (scène, caméra ou taille changées). */
  guidesStale: boolean;
}

/**
 * Traitement de l'image tracée avant le tone mapping, commun au viewport et au rendu final :
 *
 *   accumulation → débruitage (Rapide : bilatéral ; Haute qualité : à-trous guidé)
 *                → remise à l'échelle (affichage instantané)
 *                → bloom
 *                → [présentation : tone mapping + exposition + sRGB]
 *
 * Chaque étape n'est instanciée qu'à sa première utilisation : sans option active, l'image
 * est présentée telle quelle, sans aucune passe supplémentaire.
 */
export class PathPost {
  private upscaler: Upscaler | null = null;
  private atrous: AtrousDenoiser | null = null;
  private guides: GuideBuffers | null = null;
  private guidesReady = false;
  private bloom: PathBloom | null = null;

  constructor(private readonly renderer: WebGLRenderer) {}

  /** Oublie les passes guides (la prochaine image en débruitage haute qualité les refera). */
  invalidateGuides(): void {
    this.guidesReady = false;
  }

  process(a: PostArgs): Texture {
    const scaled = a.srcW < a.outW || a.srcH < a.outH;
    const passes = planPostPasses({
      denoiser: a.denoiser,
      fastActive: denoiseStrength(a.samples) !== null,
      scaled,
      bloom: a.bloom !== null,
    });
    if (passes.length === 0) return a.source;
    const r = this.renderer;
    let image = a.source;
    let w = a.srcW;
    let h = a.srcH;
    const fast = passes.includes('denoise-fast');
    if (passes.includes('denoise-hq')) {
      if (!this.guides) this.guides = new GuideBuffers();
      if (!this.atrous) this.atrous = new AtrousDenoiser(r);
      if (a.guidesStale || !this.guidesReady || this.guides.albedo.width !== w || this.guides.albedo.height !== h) {
        this.guides.render(r, a.scene, a.camera, w, h);
        this.guidesReady = true;
      }
      image = this.atrous.process(image, this.guides, w, h, a.samples, a.atrous);
    }
    if (fast || passes.includes('upscale')) {
      if (!this.upscaler) this.upscaler = new Upscaler(r);
      image = this.upscaler.process(image, w, h, a.outW, a.outH, a.samples, fast);
      if (scaled) {
        w = a.outW;
        h = a.outH;
      }
    }
    if (passes.includes('bloom') && a.bloom) {
      if (!this.bloom) this.bloom = new PathBloom(r);
      image = this.bloom.process(image, w, h, a.bloom);
    }
    return image;
  }

  dispose(): void {
    this.upscaler?.dispose();
    this.atrous?.dispose();
    this.guides?.dispose();
    this.bloom?.dispose();
    this.upscaler = null;
    this.atrous = null;
    this.guides = null;
    this.bloom = null;
    this.guidesReady = false;
  }
}
