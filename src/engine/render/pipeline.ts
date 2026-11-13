import { BoxGeometry, Mesh, MeshPhysicalMaterial, NoToneMapping, Scene, Vector2, type Camera, type WebGLRenderer } from 'three';
import type { RenderSettings } from '../../core/doc/schema';
import { DepthPrepass, RealtimeChain, applyShadowQuality } from './realtime';
import { CameraWatch, PathTracerHost, environmentKey, hasTraceableMesh } from './pathtracer';
import { samplesPerFrame, upscaleScale } from './upscale';
import { PathPost } from './post';
import { readAtrousParams, readBloomParams, readTracerParams, readViewportSamples, resolveDenoiser } from './settings';
import { applyColorManagement, applyShadowSettings, clampNum, finiteOr } from './state';

export type FrameMode = 'plain' | 'realtime' | 'pathtrace';
export type DirtyKind = 'geometry' | 'materials' | 'lights' | 'environment' | 'camera';

/** Délai sans modification de géométrie avant de reconstruire la BVH (édition continue = temps réel). */
const GEOMETRY_SETTLE_MS = 150;

/**
 * Pipeline de rendu du viewport.
 *
 *  - `plain`     : rendu direct dans le canvas (fil de fer / solide / matériau), sans post-traitement ;
 *                  le tone mapping et l'exposition du renderer s'appliquent aux matériaux `toneMapped`.
 *  - `realtime`  : chaîne HDR (ombres PCF, GTAO, bloom, MSAA) puis tone mapping + sRGB.
 *  - `pathtrace` : three-gpu-pathtracer, un échantillon par image jusqu'à `viewportSamples`
 *                  (affiché à partir de `viewportMinSamples`), puis débruitage, remise à
 *                  l'échelle et bloom selon les réglages (voir `PathPost`).
 *                  Tant que la BVH n'est pas prête (édition en cours, compilation du shader)
 *                  ou si le GPU ne le permet pas, l'image temps réel est affichée à la place.
 *
 * L'overlay est toujours dessiné en dernier, dans le canvas, sans tone mapping ni effets,
 * avec la profondeur de la scène (les gizmos sont occultés par les surfaces).
 */
export class RenderPipeline {
  private chain: RealtimeChain;
  private prepass = new DepthPrepass();
  private host: PathTracerHost | null = null;
  private post: PathPost | null = null;
  /** Les passes guides du débruiteur haute qualité sont à refaire (scène, caméra, taille). */
  private guidesStale = true;
  private readonly ptSize = new Vector2();
  private ptFailed = false;
  private ptScene: Scene | null = null;
  private ptCamera: Camera | null = null;
  private camWatch = new CameraWatch();
  private envKey = '';
  private dirty = new Set<DirtyKind>();
  private geometryChangedAt = 0;
  private _samples = 0;
  private disposed = false;
  private bufferSize = new Vector2();

  constructor(private renderer: WebGLRenderer) {
    this.chain = new RealtimeChain(renderer, 4);
  }

  /** Échantillons accumulés (path tracing), 0 sinon. */
  get samples(): number {
    return this._samples;
  }

  /** Le shader de path tracing est-il en cours de compilation (peut durer ~1 min sous ANGLE/D3D11) ? */
  get compiling(): boolean {
    return this.host?.compiling ?? false;
  }

  /** Path tracing définitivement indisponible sur ce GPU (repli temps réel). */
  get pathTracingUnavailable(): boolean {
    return this.ptFailed;
  }

  /**
   * Précompile le shader de path tracing en tâche de fond (sans rien dessiner à l'écran), pour
   * que le passage en mode Path tracing soit immédiat. La compilation est asynchrone
   * (KHR_parallel_shader_compile) et ne bloque pas l'interface. Sans effet si déjà fait.
   */
  prewarm(camera: Camera, settings: RenderSettings): void {
    if (this.disposed || this.ptFailed || this.host) return;
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    // Mini-scène dédiée : la scène du viewport peut porter des matériaux d'affichage (mode Solide)
    // que le path tracer ne sait pas lire. Le shader compilé est le même pour la vraie scène.
    const warm = new Scene();
    const box = new Mesh(new BoxGeometry(1, 1, 1), new MeshPhysicalMaterial());
    warm.add(box);
    try {
      const host = this.ensureHost();
      if (!host) return;
      host.setTracerParams(readTracerParams(settings));
      host.setScene(warm, camera);
      // ptScene reste nul : au passage réel en path tracing, la vraie scène est reconstruite.
      this.ptScene = null;
      this.ptCamera = null;
      this.camWatch.clear();
      // Déclenche la compilation (le premier appel ne trace rien tant que le shader n'est pas prêt).
      host.renderSample();
    } catch (err) {
      console.warn('Path tracing : précompilation impossible', err);
      this.ptScene = null;
    } finally {
      r.setRenderTarget(prevTarget);
      box.geometry.dispose();
      (box.material as MeshPhysicalMaterial).dispose();
    }
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    const r = this.renderer;
    const w = Math.max(1, Math.floor(finiteOr(width, 1)));
    const h = Math.max(1, Math.floor(finiteOr(height, 1)));
    const pr = clampNum(finiteOr(pixelRatio, 1), 0.25, 4);
    const canvas = r.domElement;
    // Le canvas remplit son conteneur ; seule la taille du tampon de dessin est pilotée ici
    // (styles en pixels évités : ils empêcheraient le conteneur de rétrécir).
    if (canvas.style && !canvas.style.width && !canvas.style.height) {
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.display = 'block';
    }
    if (r.getPixelRatio() !== pr) r.setPixelRatio(pr);
    const cur = r.getSize(new Vector2());
    if (cur.x !== w || cur.y !== h) r.setSize(w, h, false);
    r.getDrawingBufferSize(this.bufferSize);
    this.chain.setSize(this.bufferSize.x, this.bufferSize.y);
    // L'accumulation du path tracer suit la taille du tampon de dessin et se relance d'elle-même.
  }

  /**
   * Les shadow maps ne dépendent pas de la caméra : on ne les recalcule que si la géométrie,
   * les lumières ou les matériaux ont changé (une lumière ponctuelle coûte 6 rendus de la scène).
   */
  private shadowsDirty = true;
  private lastShadowQuality = '';

  markDirty(kind: DirtyKind): void {
    if (kind !== 'camera') this.shadowsDirty = true;
    this.dirty.add(kind);
    if (kind === 'geometry') this.geometryChangedAt = performance.now();
  }

  render(f: { scene: Scene; camera: Camera; overlay: Scene | null; mode: FrameMode; settings: RenderSettings }): boolean {
    if (this.disposed) return false;
    const { scene, camera, overlay, mode, settings } = f;
    const r = this.renderer;
    const prevAutoClear = r.autoClear;
    let again = false;
    let needsPrepass = mode !== 'plain';
    this._samples = 0;
    applyColorManagement(r, settings);
    try {
      if (mode === 'pathtrace') again = this.renderPathTraced(scene, camera, settings);
      else if (mode === 'realtime') this.renderRealtime(scene, camera, settings);
      else this.renderPlain(scene, camera);
    } catch (err) {
      // Une image ratée ne doit jamais interrompre la boucle du viewport.
      console.error('Rendu du viewport : échec, repli sur le rendu direct', err);
      try {
        this.renderPlain(scene, camera);
        needsPrepass = false;
      } catch {
        /* contexte perdu : rien à afficher */
      }
    } finally {
      r.autoClear = prevAutoClear;
    }
    if (overlay) this.renderOverlay(scene, camera, overlay, needsPrepass);
    return again;
  }

  dispose(): void {
    this.disposed = true;
    this.chain.dispose();
    this.prepass.dispose();
    this.host?.dispose();
    this.host = null;
    this.post?.dispose();
    this.post = null;
    this.ptScene = null;
    this.ptCamera = null;
  }

  // ------------------------------------------------------------------ modes

  private renderPlain(scene: Scene, camera: Camera): void {
    const r = this.renderer;
    applyShadowSettings(r, 'none');
    r.setRenderTarget(null);
    r.autoClear = true;
    r.render(scene, camera);
  }

  private renderRealtime(scene: Scene, camera: Camera, settings: RenderSettings): void {
    const r = this.renderer;
    applyShadowSettings(r, settings.shadows);
    applyShadowQuality(scene, settings.shadows);
    if (settings.shadows !== this.lastShadowQuality) {
      this.lastShadowQuality = settings.shadows;
      this.shadowsDirty = true;
    }
    r.getDrawingBufferSize(this.bufferSize);
    this.chain.setSize(this.bufferSize.x, this.bufferSize.y);
    const prevAuto = r.shadowMap.autoUpdate;
    // Ombres en cache : recalculées seulement si quelque chose d'autre que la caméra a bougé.
    r.shadowMap.autoUpdate = this.shadowsDirty;
    this.shadowsDirty = false;
    try {
      const hdr = this.chain.renderHDR(scene, camera, settings);
      this.chain.present(hdr, null);
    } finally {
      r.shadowMap.autoUpdate = prevAuto;
    }
  }

  /** Renvoie true tant que l'accumulation (ou la préparation) n'est pas terminée. */
  private renderPathTraced(scene: Scene, camera: Camera, settings: RenderSettings): boolean {
    if (this.ptFailed || !hasTraceableMesh(scene)) {
      // Rien à tracer (ou GPU incapable) : l'image temps réel fait foi.
      this.ptScene = null;
      this.renderRealtime(scene, camera, settings);
      return false;
    }
    const host = this.ensureHost();
    if (!host) {
      this.renderRealtime(scene, camera, settings);
      return false;
    }

    const now = performance.now();
    if (this.ptScene !== scene) this.dirty.add('geometry');
    if (this.dirty.has('geometry') || this.dirty.has('materials')) {
      // Pendant une édition continue, on attend que la géométrie se stabilise.
      const settling = this.dirty.has('geometry') && this.ptScene === scene && now - this.geometryChangedAt < GEOMETRY_SETTLE_MS;
      if (settling) {
        this.renderRealtime(scene, camera, settings);
        return true;
      }
      try {
        host.setScene(scene, camera);
        this.guidesStale = true;
        this.ptScene = scene;
        this.ptCamera = camera;
        this.camWatch.record(camera);
        this.envKey = environmentKey(scene);
        this.dirty.clear();
      } catch (err) {
        // Échec de construction (géométrie invalide…) : on retentera au prochain signalement.
        console.warn('Path tracing : construction de la scène impossible, rendu temps réel', err);
        this.ptScene = null;
        this.dirty.clear();
        this.renderRealtime(scene, camera, settings);
        return false;
      }
    }

    const key = environmentKey(scene);
    if (this.dirty.has('environment') || key !== this.envKey) {
      host.updateEnvironment(scene);
      this.envKey = key;
    }
    if (this.dirty.has('lights')) host.updateLights();
    if (camera !== this.ptCamera) {
      host.setCamera(camera);
      this.ptCamera = camera;
      this.camWatch.record(camera);
      this.guidesStale = true;
    } else if (this.camWatch.changed(camera) || this.dirty.has('camera')) {
      host.updateCamera();
      this.guidesStale = true;
    }
    this.dirty.clear();
    host.setTracerParams(readTracerParams(settings));

    const scale = upscaleScale(settings.upscale);
    host.setScale(scale);

    const { min: minSamples, max: target } = readViewportSamples(settings);
    // À résolution réduite un échantillon coûte moins : on en trace plusieurs par image.
    for (let i = samplesPerFrame(scale); i > 0 && host.samples < target; i--) host.renderSample();

    // Délai large : la première compilation du shader peut dépasser la minute sous ANGLE/D3D11.
    if (host.failed || host.compileTime(now) > 300000) {
      console.warn('Path tracing : le shader ne fonctionne pas sur ce GPU, repli définitif sur le temps réel');
      this.disableHost();
      this.renderRealtime(scene, camera, settings);
      return false;
    }

    const samples = Math.floor(host.samples);
    if (samples >= 1 && samples >= minSamples) {
      if (!this.post) this.post = new PathPost(this.renderer);
      const src = host.getSize(this.ptSize);
      this.renderer.getDrawingBufferSize(this.bufferSize);
      const image = this.post.process({
        scene,
        camera,
        source: host.texture,
        srcW: src.x,
        srcH: src.y,
        outW: this.bufferSize.x,
        outH: this.bufferSize.y,
        samples,
        denoiser: resolveDenoiser(settings, 'viewport'),
        atrous: readAtrousParams(settings),
        bloom: readBloomParams(settings),
        guidesStale: this.guidesStale,
      });
      this.guidesStale = false;
      this.chain.present(image, null);
      this._samples = samples;
    } else {
      // Shader en compilation, ou pas encore assez d'échantillons pour afficher l'image tracée.
      this.renderRealtime(scene, camera, settings);
    }
    return host.compiling || host.samples < target;
  }

  private ensureHost(): PathTracerHost | null {
    if (this.host) return this.host;
    if (this.ptFailed) return null;
    try {
      this.host = new PathTracerHost(this.renderer, 1);
      this.ptScene = null;
      this.ptCamera = null;
      this.camWatch.clear();
      return this.host;
    } catch (err) {
      console.warn('Path tracing indisponible, rendu temps réel à la place', err);
      this.ptFailed = true;
      return null;
    }
  }

  private disableHost(): void {
    this.ptFailed = true;
    this.host?.dispose();
    this.host = null;
    this.ptScene = null;
    this.ptCamera = null;
  }

  // ------------------------------------------------------------------ overlay

  private renderOverlay(scene: Scene, camera: Camera, overlay: Scene, needsPrepass: boolean): void {
    if (overlay.children.length === 0) return;
    const r = this.renderer;
    const prevTone = r.toneMapping;
    const prevAutoClear = r.autoClear;
    const prevAutoUpdate = r.shadowMap.autoUpdate;
    try {
      if (needsPrepass) this.prepass.render(r, scene, camera);
      r.setRenderTarget(null);
      r.autoClear = false;
      r.shadowMap.autoUpdate = false;
      r.toneMapping = NoToneMapping;
      r.render(overlay, camera);
    } catch (err) {
      console.error("Rendu de l'overlay : échec", err);
    } finally {
      r.toneMapping = prevTone;
      r.autoClear = prevAutoClear;
      r.shadowMap.autoUpdate = prevAutoUpdate;
    }
  }
}
