import {
  Color,
  Matrix4,
  type Camera,
  type PerspectiveCamera,
  type Material,
  type Scene,
  type Texture,
  type Vector2,
  type WebGLRenderer,
} from 'three';
import { GradientEquirectTexture, PhysicalCamera, WebGLPathTracer } from 'three-gpu-pathtracer';
import { clampNum, finiteOr } from './state';
import type { TracerParams } from './settings';

/**
 * Accès aux membres internes de WebGLPathTracer (three-gpu-pathtracer 0.0.28) dont nous
 * avons besoin et que les typages n'exposent pas : taille de rendu arbitraire (rendu final
 * hors écran), état de compilation du shader, matériau de path tracing.
 */
interface PathTracerInternals {
  _pathTracer?: {
    setSize(w: number, h: number): void;
    getSize(out: Vector2): void;
    material: Material & {
      fragmentShader: string;
      uniforms: Record<string, { value: unknown }>;
      seed: number;
      stratifiedTexture?: { generator?: { seed: number } };
    };
    reset(): void;
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
 * Ouverture (mm) donnée au path tracer quand la profondeur de champ est coupée : non nulle, pour
 * que la variante « profondeur de champ » du shader reste compilée (l'activer ensuite ne coûte
 * alors aucune recompilation, qui peut durer une minute sous ANGLE), mais si petite que le
 * décalage des rayons (≈ 5e-10 m) est sans effet visible.
 */
const DOF_OFF_APERTURE_MM = 1e-6;

/**
 * Injecte l'écrêtage des lucioles dans le shader du path tracer (uniform, donc réglable sans
 * recompilation) : chaque échantillon est ramené à `cfSampleClamp` sur sa composante la plus
 * forte avant d'être accumulé. Renvoie false si la version du shader n'a pas le point
 * d'insertion attendu (l'écrêtage est alors indisponible, le reste fonctionne).
 */
export function patchSampleClamp(material: { fragmentShader: string; uniforms: Record<string, { value: unknown }>; needsUpdate: boolean }): boolean {
  const src = material.fragmentShader;
  if (typeof src !== 'string') return false;
  if (src.includes('cfSampleClamp')) return true;
  const tail = 'gl_FragColor.a *= opacity;';
  const main = /void\s+main\s*\(\s*\)\s*\{/;
  if (src.split(tail).length !== 2 || !main.test(src)) return false;
  material.fragmentShader = src
    .replace(main, 'uniform float cfSampleClamp;\nvoid main() {')
    .replace(
      tail,
      'if ( cfSampleClamp > 0.0 ) { float cfMax = max( gl_FragColor.r, max( gl_FragColor.g, gl_FragColor.b ) ); ' +
        'if ( cfMax > cfSampleClamp ) gl_FragColor.rgb *= cfSampleClamp / cfMax; }\n' +
        tail,
    );
  material.uniforms.cfSampleClamp = { value: 0 };
  material.needsUpdate = true;
  return true;
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
  /** Caméra physique transmise au path tracer (profondeur de champ), copie de la caméra source. */
  private physCam = new PhysicalCamera();
  private sourceCamera: Camera | null = null;
  private seed = 0;
  private clampOk = false;
  private applied = { transmission: -1, glossy: -1, seed: -1, clamp: -1 };

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
    // Bruit reproductible (graine réglable, comme Cycles) : même image pour les mêmes réglages.
    (pt as unknown as { stableNoise: boolean }).stableNoise = true;
    const t = Math.max(1, Math.round(tiles));
    pt.tiles.set(t, t);
    const inner = this.internals._pathTracer!;
    this.clampOk = patchSampleClamp(inner.material as any);
    // La graine est réappliquée après chaque remise à zéro de l'accumulation (qui la remet à 0).
    const baseReset = inner.reset.bind(inner);
    inner.reset = () => {
      baseReset();
      this.applySeed();
    };
    this.physCam.filmGauge = 36;
    this.physCam.matrixAutoUpdate = false;
  }

  /** L'écrêtage des lucioles est-il disponible avec cette version du path tracer ? */
  get sampleClampSupported(): boolean {
    return this.clampOk;
  }

  private applySeed(): void {
    const mat = this.internals._pathTracer?.material;
    if (!mat) return;
    mat.seed = this.seed;
    const gen = mat.stratifiedTexture?.generator;
    if (gen) gen.seed = this.seed;
  }

  /**
   * Chemins de lumière et échantillonnage : tous des uniforms (aucune recompilation). Relance
   * l'accumulation seulement si quelque chose a changé.
   */
  setTracerParams(p: TracerParams): void {
    const pt = this.pt;
    let changed = false;
    if (pt.bounces !== p.bounces) {
      pt.bounces = p.bounces;
      changed = true;
    }
    if (this.applied.transmission !== p.transmissionBounces) {
      this.applied.transmission = p.transmissionBounces;
      pt.transmissiveBounces = p.transmissionBounces;
      changed = true;
    }
    if (this.applied.glossy !== p.filterGlossy) {
      this.applied.glossy = p.filterGlossy;
      pt.filterGlossyFactor = p.filterGlossy;
      changed = true;
    }
    if (this.applied.seed !== p.seed) {
      this.applied.seed = p.seed;
      this.seed = p.seed;
      changed = true;
    }
    const clamp = this.clampOk ? p.sampleClamp : 0;
    if (this.applied.clamp !== clamp) {
      this.applied.clamp = clamp;
      const u = this.internals._pathTracer?.material.uniforms.cfSampleClamp;
      if (u) u.value = clamp;
      changed = true;
    }
    if (changed) pt.reset();
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

  /**
   * Caméra effectivement donnée au path tracer. Perspective : une `PhysicalCamera` recopiée de
   * la caméra source (pose, projection) et réglée d'après `camera.userData.dof` (déposé par le
   * viewport depuis `CameraData.dofEnabled / focusDistance / fstop`). Orthographique : telle quelle.
   */
  private effectiveCamera(camera: Camera): Camera {
    this.sourceCamera = camera;
    const any = camera as any;
    if (!any.isPerspectiveCamera) return camera;
    const src = camera as PerspectiveCamera;
    const cam = this.physCam;
    src.updateMatrixWorld();
    cam.fov = src.fov;
    cam.aspect = src.aspect;
    cam.near = src.near;
    cam.far = src.far;
    cam.zoom = src.zoom;
    cam.matrix.copy(src.matrixWorld);
    cam.matrixWorld.copy(src.matrixWorld);
    cam.matrixWorldInverse.copy(src.matrixWorldInverse);
    cam.projectionMatrix.copy(src.projectionMatrix);
    cam.projectionMatrixInverse.copy(src.projectionMatrixInverse);
    const dof = readDof(src);
    if (dof) {
      cam.fStop = dof.fstop;
      cam.focusDistance = dof.focusDistance;
    } else {
      cam.fStop = cam.getFocalLength() / DOF_OFF_APERTURE_MM;
      cam.focusDistance = 10;
    }
    return cam;
  }

  /** (Re)construit la BVH et toutes les données : géométrie, matériaux, lumières, environnement, caméra. */
  setScene(scene: Scene, camera: Camera, env: Texture | null = this.environmentFor(scene)): void {
    this.withEnvironment(scene, env, () => {
      this.pt.setScene(scene, this.effectiveCamera(camera));
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
    this.pt.setCamera(this.effectiveCamera(camera));
  }

  /** La caméra source a bougé (ou ses réglages de profondeur de champ ont changé). */
  updateCamera(): void {
    if (this.sourceCamera) this.pt.setCamera(this.effectiveCamera(this.sourceCamera));
    else this.pt.updateCamera();
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

/** Profondeur de champ demandée pour une caméra (null si coupée ou invalide). */
export function readDof(camera: Camera): { fstop: number; focusDistance: number } | null {
  const d = (camera.userData as any)?.dof;
  if (!d || d.enabled !== true) return null;
  const fstop = finiteOr(d.fstop, 2.8);
  const focus = finiteOr(d.focusDistance, 10);
  if (fstop <= 0 || focus <= 0) return null;
  return { fstop: clampNum(fstop, 0.01, 1e4), focusDistance: clampNum(focus, 1e-3, 1e6) };
}

/** Clé des réglages de profondeur de champ d'une caméra (détection des changements). */
export function dofKey(camera: Camera): string {
  const d = readDof(camera);
  return d ? `${d.fstop}|${d.focusDistance}` : 'off';
}

/** Mémorise la pose et la projection d'une caméra pour détecter ses mouvements. */
export class CameraWatch {
  private world = new Matrix4();
  private proj = new Matrix4();
  private camera: Camera | null = null;

  /** Vrai si la caméra a changé (objet, pose ou projection) depuis le dernier appel. */
  changed(camera: Camera): boolean {
    camera.updateMatrixWorld();
    const same =
      this.camera === camera &&
      this.world.equals(camera.matrixWorld) &&
      this.proj.equals(camera.projectionMatrix) &&
      this.dof === dofKey(camera);
    if (!same) this.record(camera);
    return !same;
  }

  private dof = 'off';

  record(camera: Camera): void {
    this.camera = camera;
    this.dof = dofKey(camera);
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
