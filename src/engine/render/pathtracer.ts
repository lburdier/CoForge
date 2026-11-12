import {
  Color,
  Matrix4,
  type Camera,
  type Material,
  type Scene,
  type Texture,
  type Vector2,
  type WebGLRenderer,
} from 'three';
import { GradientEquirectTexture, WebGLPathTracer } from 'three-gpu-pathtracer';
import { clampNum, finiteOr } from './state';

/**
 * Accès aux membres internes de WebGLPathTracer (three-gpu-pathtracer 0.0.28) dont nous
 * avons besoin et que les typages n'exposent pas : taille de rendu arbitraire (rendu final
 * hors écran), état de compilation du shader, matériau de path tracing.
 */
interface PathTracerInternals {
  _pathTracer?: {
    setSize(w: number, h: number): void;
    getSize(out: Vector2): void;
    material: Material;
    dispose(): void;
  };
  _lowResPathTracer?: { dispose(): void };
  isCompiling?: boolean;
}

/** Le GPU/pilote permet-il le path tracing (WebGL2 + cibles flottantes) ? */
export function pathTracingSupported(renderer: WebGLRenderer): boolean {
  try {
    const gl = renderer.getContext();
    const isWebGL2 = typeof (gl as WebGL2RenderingContext).texImage3D === 'function';
    return isWebGL2 && renderer.extensions.has('EXT_color_buffer_float');
  } catch {
    return false;
  }
}

/** Texture d'environnement préfiltrée par PMREMGenerator (inutilisable par le path tracer). */
function isPrefiltered(t: Texture): boolean {
  const any = t as any;
  // 306 = CubeUVReflectionMapping (anciennes versions de three).
  return any.isPMREMTexture === true || any.mapping === 306;
}

/** La scène contient-elle au moins une surface visible à tracer ? */
export function hasTraceableMesh(scene: Scene): boolean {
  let found = false;
  scene.traverseVisible((o) => {
    if (found) return;
    const any = o as any;
    if (any.isMesh && any.geometry?.attributes?.position?.count > 0) found = true;
  });
  return found;
}

/**
 * Enveloppe de WebGLPathTracer pour CoForge :
 *  - pas de rendu direct dans le canvas (nous présentons nous-mêmes la cible, avec le même
 *    tone mapping que le temps réel) ;
 *  - environnement adapté : la scène porte un environnement PMREM préfiltré (rastérisation)
 *    que le path tracer ne sait pas échantillonner ; on lui substitue, le temps de ses mises à
 *    jour, `scene.userData.ptEnvironment` s'il est fourni, sinon une texture dérivée du fond ;
 *  - détection des échecs (compilation du shader, pilote) pour permettre un repli propre.
 */
export class PathTracerHost {
  readonly pt: WebGLPathTracer;
  private internals: PathTracerInternals;
  private gradient: GradientEquirectTexture | null = null;
  private compileStart = 0;

  constructor(private renderer: WebGLRenderer, tiles: number) {
    if (!pathTracingSupported(renderer)) {
      throw new Error('Path tracing non pris en charge par ce GPU (WebGL2 et EXT_color_buffer_float requis)');
    }
    this.pt = new WebGLPathTracer(renderer);
    this.internals = this.pt as unknown as PathTracerInternals;
    if (!this.internals._pathTracer || typeof this.internals._pathTracer.setSize !== 'function') {
      this.pt.dispose();
      throw new Error('Version de three-gpu-pathtracer incompatible');
    }
    const pt = this.pt;
    pt.renderToCanvas = false;
    pt.rasterizeScene = false;
    pt.renderDelay = 0;
    pt.minSamples = 1;
    pt.fadeDuration = 0;
    pt.dynamicLowRes = false;
    pt.renderScale = 1;
    pt.multipleImportanceSampling = true;
    pt.filterGlossyFactor = 0.5;
    const t = Math.max(1, Math.round(tiles));
    pt.tiles.set(t, t);
  }

  /** Échantillons accumulés (fractionnaires pendant le rendu par tuiles). */
  get samples(): number {
    return this.pt.samples;
  }

  /** Accumulation HDR linéaire courante. */
  get texture(): Texture {
    return this.pt.target.texture;
  }

  get compiling(): boolean {
    return this.internals.isCompiling === true;
  }

  /** Temps passé à compiler le shader (ms), 0 s'il n'est pas en compilation. */
  compileTime(now = performance.now()): number {
    if (!this.compiling) {
      this.compileStart = 0;
      return 0;
    }
    if (this.compileStart === 0) this.compileStart = now;
    return now - this.compileStart;
  }

  /** Le shader de path tracing a-t-il échoué à la compilation ou à l'édition de liens ? */
  get failed(): boolean {
    try {
      const mat = this.internals._pathTracer?.material;
      if (!mat) return true;
      const props = (this.renderer.properties as any).get(mat);
      const program = props?.currentProgram;
      const diag = program?.diagnostics;
      return !!diag && diag.runnable === false;
    } catch {
      return false;
    }
  }

  /** Taille explicite du rendu (désactive la synchronisation avec le canvas). */
  setSize(width: number, height: number): void {
    this.pt.synchronizeRenderSize = false;
    this.internals._pathTracer!.setSize(width, height);
  }

  /** Échelle de la résolution interne par rapport au tampon de dessin (1 = pleine résolution). */
  setScale(scale: number): void {
    const s = clampNum(finiteOr(scale, 1), 0.1, 1);
    if (this.pt.renderScale !== s) {
      this.pt.synchronizeRenderSize = true;
      this.pt.renderScale = s;
      this.pt.reset();
    }
  }

  /** Taille réelle de l'accumulation, en pixels. */
  getSize(out: Vector2): Vector2 {
    this.internals._pathTracer!.getSize(out);
    return out;
  }

  setBounces(bounces: number): void {
    const b = Math.round(clampNum(finiteOr(bounces, 5), 1, 64));
    if (this.pt.bounces !== b) {
      this.pt.bounces = b;
      // Le verre doit pouvoir être traversé même avec peu de rebonds.
      this.pt.transmissiveBounces = Math.max(b, 6);
      this.pt.reset();
    }
  }

  /**
   * Environnement à donner au path tracer : `scene.userData.ptEnvironment` (fourni par le
   * moteur de scène), sinon l'environnement de la scène s'il n'est pas préfiltré, sinon une
   * texture dérivée du fond (couleur unie → dégradé uniforme ; cubemap ou équirectangulaire → tel quel).
   */
  environmentFor(scene: Scene): Texture | null {
    const hint = (scene.userData as any)?.ptEnvironment;
    if (hint && hint.isTexture) return hint as Texture;
    const env = scene.environment;
    if (env && !isPrefiltered(env)) return env;
    const bg = scene.background as any;
    if (bg && bg.isColor) {
      if (!this.gradient) this.gradient = new GradientEquirectTexture(16);
      const c = bg as Color;
      if (!this.gradient.topColor.equals(c) || !this.gradient.bottomColor.equals(c)) {
        this.gradient.topColor.copy(c);
        this.gradient.bottomColor.copy(c);
        this.gradient.update();
      }
      return this.gradient;
    }
    if (bg && bg.isTexture && !isPrefiltered(bg)) return bg as Texture;
    return null;
  }

  /** Exécute `fn` avec l'environnement de path tracing substitué à celui de la scène. */
  private withEnvironment<T>(scene: Scene, env: Texture | null, fn: () => T): T {
    const prev = scene.environment;
    scene.environment = env;
    try {
      return fn();
    } finally {
      scene.environment = prev;
    }
  }

  /** (Re)construit la BVH et toutes les données : géométrie, matériaux, lumières, environnement, caméra. */
  setScene(scene: Scene, camera: Camera, env: Texture | null = this.environmentFor(scene)): void {
    this.withEnvironment(scene, env, () => {
      this.pt.setScene(scene, camera);
    });
  }

  updateEnvironment(scene: Scene, env: Texture | null = this.environmentFor(scene)): void {
    this.withEnvironment(scene, env, () => this.pt.updateEnvironment());
  }

  updateLights(): void {
    this.pt.updateLights();
  }

  updateMaterials(): void {
    this.pt.updateMaterials();
  }

  setCamera(camera: Camera): void {
    this.pt.setCamera(camera);
  }

  updateCamera(): void {
    this.pt.updateCamera();
  }

  reset(): void {
    this.pt.reset();
  }

  /** Un échantillon (ou une tuile d'échantillon) de plus. */
  renderSample(): void {
    this.pt.renderSample();
  }

  dispose(): void {
    try {
      this.pt.dispose();
      this.internals._lowResPathTracer?.dispose();
    } catch {
      /* contexte perdu : rien à libérer */
    }
    this.gradient?.dispose();
    this.gradient = null;
  }
}

/** Mémorise la pose et la projection d'une caméra pour détecter ses mouvements. */
export class CameraWatch {
  private world = new Matrix4();
  private proj = new Matrix4();
  private camera: Camera | null = null;

  /** Vrai si la caméra a changé (objet, pose ou projection) depuis le dernier appel. */
  changed(camera: Camera): boolean {
    camera.updateMatrixWorld();
    const same = this.camera === camera && this.world.equals(camera.matrixWorld) && this.proj.equals(camera.projectionMatrix);
    if (!same) this.record(camera);
    return !same;
  }

  record(camera: Camera): void {
    this.camera = camera;
    this.world.copy(camera.matrixWorld);
    this.proj.copy(camera.projectionMatrix);
  }

  clear(): void {
    this.camera = null;
  }
}

/**
 * Clé décrivant l'environnement d'une scène (références des textures, couleur du fond,
 * intensités) pour détecter un changement de « monde » sans signalement explicite.
 */
export function environmentKey(scene: Scene): string {
  const bg = scene.background as any;
  const env = scene.environment as any;
  const hint = (scene.userData as any)?.ptEnvironment;
  const bgKey = bg ? (bg.isColor ? `c${(bg as Color).getHexString()}` : `t${bg.uuid}:${bg.version ?? 0}`) : 'none';
  const envKey = env ? `${env.uuid}:${env.version ?? 0}` : 'none';
  const hintKey = hint && hint.isTexture ? `${hint.uuid}:${hint.version ?? 0}` : 'none';
  return `${bgKey}|${envKey}|${hintKey}|${scene.environmentIntensity}|${scene.backgroundIntensity}`;
}
