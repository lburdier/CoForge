import {
  Box3,
  Group,
  MathUtils,
  Matrix4,
  OrthographicCamera,
  PerspectiveCamera,
  Quaternion,
  Sphere,
  Vector3,
  WebGLRenderer,
  type Camera,
  type Object3D,
} from 'three';
import type { AppContext } from '../app/context';
import { patchRender, toast, type AppState } from '../app/store';
import type { SceneDoc } from '../core/doc/SceneDoc';
import { edgeVerts, type CameraData, type MeshData, type Vec3 } from '../core/doc/schema';
import type { ICollab, Peer, PresenceCamera } from '../net/api';
import type { ElementHit, FinalRenderOptions, IViewport, SurfaceHit, ViewDirection } from './api';
import { EditCage } from './editOverlay';
// GLTF (exporteur + chargeur three, ~100 Ko) chargé à la demande : seul l'OBJ, synchrone par contrat, est importé d'office.
import { exportOBJ as ioExportOBJ } from './io/obj';
import type { ExportItem } from './io/types';
import type { ImportOptions } from './io/importFile';
import type { ImportResult } from './io/scene';
import { lookQuaternion, makeSceneCamera, Navigation, type NavigationHost } from './navigation';
import { NavGizmo } from './navGizmo';
import { ORDER } from './overlayMaterials';
import { Cursor3D, Grid, Hud, Origins } from './overlays';
import { normRect, Picker, type PickEnv } from './picking';
import { PresenceLayer } from './presence';
import { RenderPipeline, renderFinalImage, type FrameMode } from './render';
import { SceneSync, type DirtyKind } from './sceneSync';
import { clamp, finite, toVec3 } from './util';
import { WorldEnv } from './world';

/**
 * Viewport 3D de CoForge (implémentation de IViewport).
 *
 * Assemble : SceneSync (document → scène), Navigation (caméra), Picker,
 * overlays (grille, curseur, origines, cage d'édition, présence), gizmo
 * d'orientation, RenderPipeline (rendu temps réel / path tracing) et le rendu final.
 * La boucle de rendu est « à la demande » : rien n'est dessiné tant que rien ne change.
 */

/**
 * Vue 3D supplémentaire (« miroir ») : une autre zone Viewport 3D, avec sa propre caméra. Le moteur
 * n'a qu'un contexte WebGL : la zone active (sous le pointeur) reçoit le vrai canvas interactif ;
 * les autres sont dessinées dans le même contexte puis copiées dans leur canvas 2D.
 */
export interface ViewMirror {
  canvas: HTMLCanvasElement;
  /** Caméra de la vue (null : pas encore de vue mémorisée, la vue active est reprise). */
  getView(): PresenceCamera | null;
}

/** Cadence maximale des vues miroirs (ms entre deux rafraîchissements). */
const MIRROR_INTERVAL = 33;

interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class Viewport implements IViewport {
  readonly dom: HTMLCanvasElement;
  readonly overlayRoot = new Group();

  private renderer: WebGLRenderer | null = null;
  private pipeline: RenderPipeline | null = null;
  private worldEnv: WorldEnv | null = null;
  private sync: SceneSync;
  private nav: Navigation;
  private picker: Picker;
  private grid = new Grid();
  private cursor = new Cursor3D();
  private origins = new Origins();
  private hud = new Hud();
  private cage = new EditCage();
  private presence = new PresenceLayer();
  private gizmo: NavGizmo | null = null;

  private doc: SceneDoc;
  private container: HTMLElement | null = null;
  private resizeObs: ResizeObserver | null = null;
  private raf = 0;
  private disposed = false;
  private width = 1;
  private height = 1;
  private pixelRatio = 1;

  /** Caméra de scène utilisée en vue caméra (null hors vue caméra). */
  private viewCam: PerspectiveCamera | OrthographicCamera | null = null;
  private viewCamId: string | null = null;
  private camFrame: FrameRect | null = null;
  private frameScale = 0.9;

  private peers: Peer[] = [];
  private peersOff: (() => void) | null = null;
  private lastCamKey = '';
  private lastPointerSent = 0;
  private pointerTimer: ReturnType<typeof setTimeout> | null = null;
  private domOffs: (() => void)[] = [];
  private offs: (() => void)[] = [];

  private renderJob: AbortController | null = null;
  private mirrors = new Map<string, ViewMirror>();
  private mirrorsDirty = true;
  private lastMirrorDraw = 0;
  private mirrorTimer: ReturnType<typeof setTimeout> | null = null;
  private mirrorPersp = new PerspectiveCamera();

  private mirrorOrtho = new OrthographicCamera();

  constructor(private app: AppContext) {
    this.doc = app.doc;
    const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : ({} as HTMLCanvasElement);
    this.dom = canvas;
    if (typeof document !== 'undefined') {
      canvas.className = 'cf-viewport-gl';
      canvas.style.display = 'block';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.outline = 'none';
      canvas.style.touchAction = 'none';
      canvas.tabIndex = 0;
    }

    this.sync = new SceneSync({
      getDoc: () => this.doc,
      getState: () => this.app.store.getState(),
      requestRender: () => this.requestRender(),
      markDirty: (k) => this.markDirty(k),
      drawingSize: () => ({ width: this.width * this.pixelRatio, height: this.height * this.pixelRatio }),
    });
    this.picker = new Picker(this.sync);
    this.nav = new Navigation(this.navHost());
    this.nav.orthographic = app.store.getState().orthographic;
    this.nav.apply();

    try {
      if (typeof document === 'undefined') throw new Error('DOM indisponible');
      const r = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
      r.shadowMap.enabled = true;
      this.renderer = r;
      this.worldEnv = new WorldEnv(r);
      this.sync.setWorldEnv(this.worldEnv);
      try {
        this.pipeline = new RenderPipeline(r);
        this.sync.sceneDepthAvailable = true;
      } catch (err) {
        console.error('[engine] pipeline de rendu indisponible, rendu direct', err);
        this.pipeline = null;
      }
    } catch (err) {
      console.error('[engine] WebGL indisponible : le viewport ne pourra pas dessiner', err);
    }

    // scène d'overlay
    const ov = this.sync.overlay;
    this.overlayRoot.name = 'Outils';
    this.overlayRoot.renderOrder = ORDER.tools;
    ov.add(this.grid.mesh, this.cursor.group, this.origins.points, this.cage.group, this.presence.group, this.overlayRoot);

    if (typeof document !== 'undefined') {
      this.gizmo = new NavGizmo({
        viewQuaternion: () => this.currentQuaternion(),
        setView: (d) => this.setView(d),
        beginDrag: (mode, e, el) => this.nav.beginDrag(mode, e, el),
        dragMove: (e) => this.nav.dragMove(e),
        endDrag: (e) => this.nav.endDrag(e),
        toggleCameraView: () => this.toggleCameraView(),
        toggleOrtho: () => this.app.store.setState({ orthographic: !this.app.store.getState().orthographic }),
        isOrtho: () => this.nav.orthographic,
        inCameraView: () => this.viewCam !== null,
      });
    }

    // document : lecture toujours via app.doc, réabonnement à chaque remplacement
    this.sync.attach(this.doc);
    this.offs.push(app.onDocChange((d) => this.setDoc(d)));
    this.offs.push(app.store.subscribe((s, prev) => this.onStore(s, prev)));
    // Vues miroirs : à redessiner quand la scène ou l'état local changent (pas pour la seule navigation).
    this.offs.push(
      app.onDocChange((d) => {
        this.markMirrors();
        return d.on('change', () => this.markMirrors());
      }),
    );
    this.offs.push(
      app.store.subscribe((st, prev) => {
        if (
          st.selection !== prev.selection ||
          st.activeId !== prev.activeId ||
          st.mode !== prev.mode ||
          st.editSelection !== prev.editSelection ||
          st.shading !== prev.shading ||
          st.overlays !== prev.overlays ||
          st.frame !== prev.frame
        )
          this.markMirrors();
      }),
    );
  }

  // ================================================================== cycle de vie

  mount(container: HTMLElement): void {
    if (this.disposed) return;
    if (this.container === container) return;
    this.unmount();
    this.container = container;
    try {
      if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    } catch {
      /* ignore */
    }
    container.appendChild(this.dom);
    if (this.gizmo) container.appendChild(this.gizmo.dom);
    this.nav.attach(this.dom);
    this.bindPointerPresence();
    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => this.resize());
      this.resizeObs.observe(container);
    }
    this.subscribePeers();
    this.requestRender();
  }

  unmount(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.nav.detach();
    for (const off of this.domOffs) off();
    this.domOffs = [];
    this.peersOff?.();
    this.peersOff = null;
    if (this.container) {
      if (this.dom.parentElement === this.container) this.container.removeChild(this.dom);
      if (this.gizmo && this.gizmo.dom.parentElement === this.container) this.container.removeChild(this.gizmo.dom);
    }
    this.container = null;
  }

  setDoc(doc: SceneDoc): void {
    if (this.disposed || doc === this.doc) return;
    this.cancelRender();
    this.doc = doc;
    this.picker.dispose();
    this.sync.attach(doc);
    this.viewCam = null;
    this.viewCamId = null;
    this.markDirty('geometry');
    this.markDirty('materials');
    this.markDirty('lights');
    this.markDirty('environment');
    this.markDirty('camera');
    this.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancelRender();
    this.unmount();
    this.disposed = true;
    for (const off of this.offs) off();
    this.offs = [];
    if (this.pointerTimer) clearTimeout(this.pointerTimer);
    if (this.prewarmTimer) clearTimeout(this.prewarmTimer);
    if (this.mirrorTimer) clearTimeout(this.mirrorTimer);
    this.mirrors.clear();
    this.gizmo?.dispose();
    this.picker.dispose();
    this.cage.dispose();
    this.presence.dispose();
    this.grid.dispose();
    this.cursor.dispose();
    this.origins.dispose();
    this.hud.dispose();
    this.sync.dispose();
    try {
      this.pipeline?.dispose();
    } catch (err) {
      console.error('[engine] libération du pipeline', err);
    }
    this.worldEnv?.dispose();
    this.renderer?.dispose();
    this.pipeline = null;
    this.worldEnv = null;
    this.renderer = null;
  }

  private resize(): void {
    const c = this.container;
    if (!c) return;
    const w = Math.max(1, Math.floor(c.clientWidth));
    const h = Math.max(1, Math.floor(c.clientHeight));
    const pr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;
    if (w === this.width && h === this.height && pr === this.pixelRatio && this.renderer?.getPixelRatio() === pr) return;
    this.width = w;
    this.height = h;
    this.pixelRatio = pr;
    if (this.renderer) {
      this.renderer.setPixelRatio(pr);
      this.renderer.setSize(w, h, false);
    }
    try {
      this.pipeline?.setSize(w, h, pr);
    } catch (err) {
      console.error('[engine] redimensionnement du pipeline', err);
    }
    this.nav.setSize(w, h);
    this.sync.setResolution(w * pr, h * pr);
    this.cage.setPixelRatio(pr);
    this.origins.setPixelRatio(pr);
    this.presence.setPixelRatio(pr);
    this.gizmo?.setPixelRatio(pr);
    this.markDirty('camera');
    this.requestRender();
  }

  getSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  get camera(): Camera {
    return this.viewCam ?? this.nav.camera;
  }

  /**
   * Échantillons accumulés par le path tracing du viewport (0 hors path tracing).
   * Hors contrat IViewport : `(app.viewport as any).viewportSamples`.
   */
  get viewportSamples(): number {
    try {
      return this.pipeline?.samples ?? 0;
    } catch {
      return 0;
    }
  }

  // ================================================================== boucle de rendu

  requestRender(): void {
    if (this.disposed || this.raf || !this.container || this.renderJob) return;
    if (typeof requestAnimationFrame === 'undefined') return;
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private markDirty(kind: DirtyKind): void {
    try {
      this.pipeline?.markDirty(kind);
    } catch (err) {
      console.error('[engine] markDirty', err);
    }
  }

  /** Met la scène et les caméras à jour (sans dessiner). */
  private prepare(): void {
    this.sync.flush();
    this.updateCameraView();
  }

  private frame(now: number): void {
    this.raf = 0;
    if (this.disposed || !this.container || this.renderJob) return;
    let again = false;
    try {
      const st = this.app.store.getState();
      // présence (avant le flush : les sélections des autres sont appliquées dans la même image)
      this.updatePresence(st);
      again = this.nav.update(now) || again;
      this.prepare();
      this.updateOverlays(st);
      this.drawMirrors(now);
      again = this.draw() || again;
      this.gizmo?.draw();
      this.publishCamera();
    } catch (err) {
      console.error("[engine] erreur pendant l'image", err);
    }
    if (again || this.sync.pending) this.requestRender();
    this.schedulePrewarm();
  }

  private prewarmTimer: ReturnType<typeof setTimeout> | null = null;
  private prewarmDone = false;

  /**
   * Quelques secondes après le démarrage, précompile le shader de path tracing en tâche de fond
   * (sa première compilation peut prendre plus d'une minute sous ANGLE/D3D11) pour que le passage
   * en mode « Path tracing » ne fasse pas attendre l'utilisateur.
   */
  private schedulePrewarm(): void {
    if (this.prewarmDone || this.prewarmTimer || !this.pipeline) return;
    this.prewarmTimer = setTimeout(() => {
      this.prewarmTimer = null;
      if (this.disposed || !this.pipeline || this.renderJob || this.prewarmDone) return;
      this.prewarmDone = true;
      try {
        this.pipeline.prewarm(this.camera, this.sync.render);
      } catch (err) {
        console.warn('[engine] précompilation du path tracing', err);
      }
      // Suit la fin de la compilation pour rafraîchir l'affichage d'état.
      const poll = setInterval(() => {
        if (this.disposed || !this.pipeline?.compiling) {
          clearInterval(poll);
          this.requestRender();
        }
      }, 1000);
    }, 3000);
  }

  /** Hors contrat IViewport : état du path tracing du viewport, pour l'interface. */
  get pathTracingStatus(): { compiling: boolean; samples: number; unavailable: boolean } {
    const p = this.pipeline;
    return { compiling: p?.compiling ?? false, samples: p?.samples ?? 0, unavailable: p?.pathTracingUnavailable ?? true };
  }

  /** Dessine une image ; renvoie true s'il faut continuer (accumulation, animation). */
  private draw(): boolean {
    const r = this.renderer;
    if (!r) return false;
    const camera = this.camera;
    const settings = this.sync.render;
    const shading = this.sync.effectiveShading;
    const mode: FrameMode = shading === 'rendered' ? (settings.engine === 'pathtrace' ? 'pathtrace' : 'realtime') : 'plain';
    let more = false;
    if (this.pipeline) {
      more = this.pipeline.render({ scene: this.sync.scene, camera, overlay: this.sync.overlay, mode, settings });
    } else {
      r.setRenderTarget(null);
      r.autoClear = true;
      r.render(this.sync.scene, camera);
      r.autoClear = false;
      r.clearDepth();
      r.render(this.sync.overlay, camera);
      r.autoClear = true;
    }
    if (this.hud.update(this.width, this.height, this.viewCam ? this.camFrame : null)) {
      const prevAuto = r.autoClear;
      const prevTone = r.toneMapping;
      r.setRenderTarget(null);
      r.autoClear = false;
      r.clearDepth();
      r.render(this.hud.scene, this.hud.camera);
      r.autoClear = prevAuto;
      r.toneMapping = prevTone;
    }
    return more;
  }

  private updateOverlays(st: AppState): void {
    const camera = this.camera;
    const xray = this.sync.visibleXray;
    const ortho = this.viewCam ? (this.viewCam as any).isOrthographicCamera === true : this.nav.orthographic;
    this.grid.update(st, camera, this.nav.target, this.nav.dist, this.viewCam ? null : this.nav.alignedAxis(), ortho, xray);
    this.cursor.update(st, camera, this.height);
    this.origins.update(st, this.sync);
    this.cage.update(this.doc, st, this.sync, xray);
    this.presence.setDepthTest(!xray);
    // en vue caméra, le gizmo de la caméra traversée est masqué
    if (this.viewCamId) {
      const n = this.sync.nodes.get(this.viewCamId);
      if (n) n.ov.visible = false;
    }
  }

  // ================================================================== vues miroirs (plusieurs viewports 3D)

  /** Hors contrat IViewport : ajoute une vue miroir ; renvoie la fonction de retrait. */
  addMirror(id: string, mirror: ViewMirror): () => void {
    this.mirrors.set(id, mirror);
    this.markMirrors();
    return () => {
      if (this.mirrors.get(id) === mirror) this.mirrors.delete(id);
    };
  }

  /** Hors contrat IViewport : les vues miroirs doivent être redessinées (scène, sélection, taille…). */
  markMirrors(): void {
    if (this.mirrors.size === 0) return;
    this.mirrorsDirty = true;
    this.requestRender();
  }

  private mirrorCamera(view: PresenceCamera, aspect: number): PerspectiveCamera | OrthographicCamera {
    const eye = new Vector3(...view.pos);
    const target = new Vector3(...view.target);
    const dist = Math.max(1e-3, eye.distanceTo(target));
    const q = lookQuaternion(eye, target);
    const fov = clamp(finite(view.fov, 50), 1, 170);
    if (view.ortho) {
      const o = this.mirrorOrtho;
      const hh = dist * Math.tan(MathUtils.degToRad(fov) / 2);
      o.left = -hh * aspect;
      o.right = hh * aspect;
      o.top = hh;
      o.bottom = -hh;
      const range = Math.max(500, dist * 20);
      o.near = -range;
      o.far = range;
      o.position.copy(eye);
      o.quaternion.copy(q);
      o.updateProjectionMatrix();
      o.updateMatrixWorld(true);
      return o;
    }
    const p = this.mirrorPersp;
    p.fov = fov;
    p.aspect = aspect;
    p.near = clamp(dist * 0.002, 0.001, 0.5);
    p.far = Math.max(2000, dist * 200);
    p.position.copy(eye);
    p.quaternion.copy(q);
    p.updateProjectionMatrix();
    p.updateMatrixWorld(true);
    return p;
  }

  /**
   * Dessine les vues miroirs dans le contexte WebGL (coin haut-gauche du tampon) puis les copie
   * dans leur canvas 2D, AVANT l'image de la vue active qui recouvre tout le tampon ensuite.
   * Cadence limitée (MIRROR_INTERVAL) ; un rafraîchissement différé rattrape le dernier changement.
   */
  private drawMirrors(now: number): void {
    const r = this.renderer;
    if (!r || this.mirrors.size === 0 || !this.mirrorsDirty) return;
    if (now - this.lastMirrorDraw < MIRROR_INTERVAL) {
      if (!this.mirrorTimer) {
        this.mirrorTimer = setTimeout(() => {
          this.mirrorTimer = null;
          this.requestRender();
        }, MIRROR_INTERVAL);
      }
      return;
    }
    this.mirrorsDirty = false;
    this.lastMirrorDraw = now;
    const pr = this.pixelRatio;
    const bufW = Math.max(1, Math.floor(this.width * pr));
    const bufH = Math.max(1, Math.floor(this.height * pr));
    const fallback = this.getViewState();
    const prevAuto = r.autoClear;
    const list: { m: ViewMirror; cw: number; ch: number; pw: number; ph: number; ctx: CanvasRenderingContext2D }[] = [];
    let needW = bufW;
    let needH = bufH;
    for (const m of this.mirrors.values()) {
      const cw = m.canvas.clientWidth;
      const ch = m.canvas.clientHeight;
      if (cw < 2 || ch < 2 || !m.canvas.isConnected) continue;
      const pw = Math.max(1, Math.round(cw * pr));
      const ph = Math.max(1, Math.round(ch * pr));
      if (m.canvas.width !== pw || m.canvas.height !== ph) {
        m.canvas.width = pw;
        m.canvas.height = ph;
      }
      const ctx = m.canvas.getContext('2d');
      if (!ctx) continue;
      list.push({ m, cw, ch, pw, ph, ctx });
      needW = Math.max(needW, pw);
      needH = Math.max(needH, ph);
    }
    if (list.length === 0) return;
    // Une vue plus grande que la vue active : le tampon est agrandi le temps de la dessiner (même
    // chemin de rendu que l'écran : tone mapping et couleurs identiques), puis rendu à sa taille
    // avant l'image de la vue active. Rien n'est affiché entre-temps (même tâche).
    const grown = needW > bufW || needH > bufH;
    if (grown) r.setSize(needW / pr, needH / pr, false);
    const H = grown ? Math.floor((needH / pr) * pr) : bufH;
    try {
      for (const { m, cw, ch, pw, ph, ctx } of list) {
        const cam = this.mirrorCamera(m.getView() ?? fallback, cw / ch);
        r.setRenderTarget(null);
        // setViewport / setScissor attendent des pixels CSS (multipliés par le pixel ratio).
        r.setViewport(0, (H - ph) / pr, pw / pr, ph / pr);
        r.setScissor(0, (H - ph) / pr, pw / pr, ph / pr);
        r.setScissorTest(true);
        r.autoClear = false;
        r.clear();
        r.render(this.sync.scene, cam);
        r.clearDepth();
        r.render(this.sync.overlay, cam);
        ctx.drawImage(r.domElement, 0, 0, pw, ph, 0, 0, pw, ph);
      }
    } catch (err) {
      console.error('[engine] vue miroir', err);
    } finally {
      r.setScissorTest(false);
      if (grown) r.setSize(this.width, this.height, false);
      r.setViewport(0, 0, this.width, this.height);
      r.autoClear = prevAuto;
    }
  }

  // ================================================================== store

  private onStore(s: AppState, prev: AppState): void {
    let render = false;
    if (s.selection !== prev.selection || s.activeId !== prev.activeId || s.mode !== prev.mode) {
      this.sync.markSelection();
      render = true;
    }
    if (s.overlays !== prev.overlays) {
      this.sync.markOverlays();
      render = true;
    }
    if (s.editSelection !== prev.editSelection || s.selectMode !== prev.selectMode || s.cursor3d !== prev.cursor3d) render = true;
    if (s.shading !== prev.shading || s.xray !== prev.xray) render = true;
    if (s.orthographic !== prev.orthographic) {
      if (this.nav.orthographic !== s.orthographic) {
        this.nav.orthographic = s.orthographic;
        this.nav.autoOrtho = false;
        this.nav.apply();
      }
      this.markDirty('camera');
      render = true;
    }
    if (s.cameraView !== prev.cameraView) {
      if (s.cameraView) this.frameScale = 0.9;
      this.markDirty('camera');
      render = true;
    }
    if (s.followClientId !== prev.followClientId) render = true;
    if (s.session.status !== prev.session.status) {
      this.lastCamKey = '';
      if (s.session.status === 'connected') this.subscribePeers();
      render = true;
    }
    if (render) this.requestRender();
  }

  // ================================================================== vue caméra

  private navHost(): NavigationHost {
    return {
      onViewChanged: () => {
        this.markDirty('camera');
        this.requestRender();
      },
      isModal: () => this.app.store.getState().modal !== null,
      inCameraView: () => this.viewCam !== null,
      leaveCameraView: () => this.leaveCameraView(),
      zoomCameraFrame: (f) => {
        this.frameScale = clamp(this.frameScale * f, 0.05, 8);
        this.markDirty('camera');
        this.requestRender();
      },
      stopFollowing: () => {
        if (this.app.store.getState().followClientId !== null) this.app.store.setState({ followClientId: null });
      },
      setOrthographic: (o) => this.app.store.setState({ orthographic: o }),
    };
  }

  /** Caméra active de la scène : objet, données et matrice monde, ou null. */
  private activeCamera(): { id: string; data: CameraData; world: Matrix4 } | null {
    const id = this.sync.settings.activeCamera;
    if (!id) return null;
    const n = this.sync.nodes.get(id);
    if (!n || n.type !== 'camera' || !n.obj.data) return null;
    const data = this.doc.getCamera(n.obj.data);
    if (!data) return null;
    return { id, data, world: n.root.matrix };
  }

  /** Configure une caméra three.js depuis une caméra du document pour un cadre donné. */
  private configureSceneCamera(
    cam: PerspectiveCamera | OrthographicCamera,
    data: CameraData,
    world: Matrix4,
    aspect: number,
    /** facteur d'agrandissement du champ (vue caméra : marge autour du cadre). */
    widen: number,
  ): void {
    const pos = new Vector3();
    const quat = new Quaternion();
    const scl = new Vector3();
    world.decompose(pos, quat, scl);
    cam.position.copy(pos);
    cam.quaternion.copy(quat);
    cam.scale.set(1, 1, 1);
    const near = Math.max(1e-4, finite(data.near, 0.1));
    const far = Math.max(near * 1.01, finite(data.far, 1000));
    if ((cam as any).isPerspectiveCamera) {
      const p = cam as PerspectiveCamera;
      const tanV = Math.tan(MathUtils.degToRad(clamp(finite(data.fov, 40), 1, 170)) / 2) * widen;
      p.fov = MathUtils.radToDeg(2 * Math.atan(tanV));
      p.aspect = aspect;
      p.near = near;
      p.far = far;
    } else {
      const o = cam as OrthographicCamera;
      const half = (Math.max(1e-3, finite(data.orthoScale, 6)) / 2) * widen;
      o.left = -half * aspect;
      o.right = half * aspect;
      o.top = half;
      o.bottom = -half;
      o.near = near;
      o.far = far;
    }
    cam.userData.dof = { enabled: !!data.dofEnabled, focusDistance: finite(data.focusDistance, 10), fstop: finite(data.fstop, 2.8) };
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
  }

  private updateCameraView(): void {
    const st = this.app.store.getState();
    const prevId = this.viewCamId;
    const ac = st.cameraView ? this.activeCamera() : null;
    if (st.cameraView && !ac) {
      // plus de caméra active (supprimée, éventuellement par un autre utilisateur)
      this.app.store.setState({ cameraView: false });
    }
    if (!ac) {
      this.viewCam = null;
      this.viewCamId = null;
      this.camFrame = null;
      if (prevId) this.sync.invalidateNode(prevId);
      return;
    }
    const kind = ac.data.kind === 'ortho' ? 'ortho' : 'persp';
    const isOrtho = this.viewCam && (this.viewCam as any).isOrthographicCamera === true;
    if (!this.viewCam || (kind === 'ortho') !== !!isOrtho) this.viewCam = makeSceneCamera(kind);
    if (prevId && prevId !== ac.id) this.sync.invalidateNode(prevId);
    this.viewCamId = ac.id;
    const r = this.sync.render;
    const A = finite(r.resX, 1920) / Math.max(1, finite(r.resY, 1080));
    const a = this.width / Math.max(1, this.height);
    const s = this.frameScale;
    let fw: number;
    let fh: number;
    if (a > A) {
      fh = s * this.height;
      fw = fh * A;
    } else {
      fw = s * this.width;
      fh = fw / A;
    }
    this.camFrame = { x: (this.width - fw) / 2, y: (this.height - fh) / 2, w: fw, h: fh };
    this.configureSceneCamera(this.viewCam, ac.data, ac.world, a, this.height / Math.max(1, fh));
  }

  private leaveCameraView(): void {
    const cam = this.viewCam;
    if (cam) {
      const fwd = new Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
      const dist = this.nav.dist;
      this.nav.setPose({ target: cam.position.clone().addScaledVector(fwd, dist), quat: cam.quaternion.clone(), dist }, false);
    }
    this.viewCam = null;
    if (this.viewCamId) this.sync.invalidateNode(this.viewCamId);
    this.viewCamId = null;
    if (this.app.store.getState().cameraView) this.app.store.setState({ cameraView: false });
  }

  private toggleCameraView(): void {
    const st = this.app.store.getState();
    if (!st.cameraView && !this.activeCamera()) {
      toast('Aucune caméra active dans la scène', 'error');
      return;
    }
    this.app.store.setState({ cameraView: !st.cameraView });
  }

  private currentQuaternion(): Quaternion {
    return this.viewCam ? this.viewCam.quaternion : this.nav.quat;
  }

  // ================================================================== navigation (API)

  setView(dir: ViewDirection): void {
    if (this.viewCam) this.leaveCameraView();
    const st = this.app.store.getState();
    // « perspective automatique » : les vues axiales passent en orthographique
    if (!st.orthographic) {
      this.nav.orthographic = true;
      this.nav.autoOrtho = true;
      this.app.store.setState({ orthographic: true });
    }
    this.nav.setView(dir, true);
  }

  frameSelection(): void {
    this.prepare();
    const st = this.app.store.getState();
    const sphere = st.mode === 'edit' ? this.editSelectionSphere(st) : this.objectsSphere([...st.selection]);
    if (!sphere) return;
    if (this.viewCam) this.leaveCameraView();
    this.nav.frameSphere(sphere.center, sphere.radius, true);
  }

  frameAll(): void {
    this.prepare();
    const ids = [...this.sync.nodes.values()].filter((n) => n.visible).map((n) => n.id);
    const sphere = this.objectsSphere(ids) ?? new Sphere(new Vector3(), 5);
    if (this.viewCam) this.leaveCameraView();
    this.nav.frameSphere(sphere.center, sphere.radius, true);
  }

  private objectsSphere(ids: string[]): Sphere | null {
    const box = new Box3();
    const tmp = new Box3();
    const p = new Vector3();
    for (const id of ids) {
      const n = this.sync.nodes.get(id);
      if (!n) continue;
      if (n.type === 'mesh' && n.geo && !n.geo.bounds.isEmpty()) {
        tmp.copy(n.geo.bounds).applyMatrix4(n.root.matrix);
        box.union(tmp);
      } else {
        p.setFromMatrixPosition(n.root.matrix);
        box.expandByPoint(p.clone().addScalar(0.5));
        box.expandByPoint(p.clone().addScalar(-0.5));
      }
    }
    return box.isEmpty() ? null : box.getBoundingSphere(new Sphere());
  }

  private editSelectionSphere(st: AppState): Sphere | null {
    const id = st.activeId;
    const n = id ? this.sync.nodes.get(id) : undefined;
    const mesh: MeshData | null = n && n.type === 'mesh' && n.obj.data ? this.doc.getMesh(n.obj.data) : null;
    if (!n || !mesh) return id ? this.objectsSphere([id]) : null;
    const vids = new Set<string>(st.editSelection.verts);
    for (const k of st.editSelection.edges) for (const v of edgeVerts(k)) vids.add(v);
    for (const f of st.editSelection.faces) for (const v of mesh.faces.get(f) ?? []) vids.add(v);
    const box = new Box3();
    const v = new Vector3();
    for (const vid of vids) {
      const p = mesh.verts.get(vid);
      if (p) box.expandByPoint(v.set(p[0], p[1], p[2]).applyMatrix4(n.root.matrix));
    }
    if (box.isEmpty()) return this.objectsSphere([n.id]);
    return box.getBoundingSphere(new Sphere());
  }

  getViewState(): PresenceCamera {
    if (this.viewCam) {
      const c = this.viewCam;
      const fwd = new Vector3(0, 0, -1).applyQuaternion(c.quaternion);
      const ac = this.activeCamera();
      return {
        pos: toVec3(c.position),
        target: toVec3(c.position.clone().addScaledVector(fwd, this.nav.dist)),
        fov: ac ? finite(ac.data.fov, 40) : this.nav.fov,
        ortho: (c as any).isOrthographicCamera === true,
        aspect: this.width / Math.max(1, this.height),
      };
    }
    return this.nav.viewState();
  }

  setViewState(view: PresenceCamera, animate = false): void {
    const pose = this.nav.poseFromState(view);
    if (!pose) return;
    const dest = this.nav.destination();
    const same =
      dest.target.distanceToSquared(pose.target) < 1e-10 && Math.abs(dest.dist - pose.dist) < 1e-6 && Math.abs(dest.quat.dot(pose.quat)) > 1 - 1e-9;
    const st = this.app.store.getState();
    if (st.cameraView) this.leaveCameraView();
    if (typeof view.fov === 'number' && Number.isFinite(view.fov)) this.nav.fov = clamp(view.fov, 5, 150);
    if (typeof view.ortho === 'boolean' && view.ortho !== this.nav.orthographic) {
      this.nav.orthographic = view.ortho;
      this.nav.autoOrtho = false;
      this.app.store.setState({ orthographic: view.ortho });
    }
    if (same) {
      this.nav.apply();
      this.requestRender();
      return;
    }
    this.nav.setPose(pose, animate);
  }

  getOrbitTarget(): Vec3 {
    if (this.viewCam) return this.getViewState().target;
    return toVec3(this.nav.target);
  }

  // ================================================================== conversions

  screenToRay(x: number, y: number): { origin: Vector3; dir: Vector3 } {
    const env = this.env();
    const ray = this.picker.ray(env, x, y);
    return { origin: ray.origin.clone(), dir: ray.direction.clone() };
  }

  worldToScreen(p: Vec3 | Vector3): { x: number; y: number; depth: number } | null {
    this.updateCameraView();
    const cam = this.camera;
    const v = Array.isArray(p) ? new Vector3(p[0], p[1], p[2]) : (p as Vector3).clone();
    if (![v.x, v.y, v.z].every(Number.isFinite)) return null;
    const camPos = new Vector3().setFromMatrixPosition(cam.matrixWorld);
    const fwd = new Vector3(0, 0, -1).transformDirection(cam.matrixWorld);
    const ahead = new Vector3().subVectors(v, camPos).dot(fwd);
    const ortho = (cam as any).isOrthographicCamera === true;
    if (!ortho && ahead <= 1e-6) return null;
    if (ortho && ahead < (cam as OrthographicCamera).near) return null;
    const ndc = v.clone().project(cam);
    return {
      x: (ndc.x * 0.5 + 0.5) * this.width,
      y: (0.5 - ndc.y * 0.5) * this.height,
      depth: ortho ? ahead : v.distanceTo(camPos),
    };
  }

  // ================================================================== picking

  private env(): PickEnv {
    this.prepare();
    return {
      doc: this.doc,
      state: this.app.store.getState(),
      camera: this.camera,
      width: this.width,
      height: this.height,
      sync: this.sync,
      xray: this.sync.visibleXray,
    };
  }

  pickObject(x: number, y: number): string | null {
    try {
      return this.picker.pickObject(this.env(), x, y);
    } catch (err) {
      console.error('[engine] pickObject', err);
      return null;
    }
  }

  pickObjectsInRect(x0: number, y0: number, x1: number, y1: number): string[] {
    try {
      return this.picker.pickObjectsInRect(this.env(), normRect(x0, y0, x1, y1));
    } catch (err) {
      console.error('[engine] pickObjectsInRect', err);
      return [];
    }
  }

  pickElement(x: number, y: number, mode: 'vert' | 'edge' | 'face'): ElementHit | null {
    try {
      return this.picker.pickElement(this.env(), x, y, mode);
    } catch (err) {
      console.error('[engine] pickElement', err);
      return null;
    }
  }

  pickElementsInRect(x0: number, y0: number, x1: number, y1: number, mode: 'vert' | 'edge' | 'face'): string[] {
    try {
      return this.picker.pickElementsInRect(this.env(), normRect(x0, y0, x1, y1), mode);
    } catch (err) {
      console.error('[engine] pickElementsInRect', err);
      return [];
    }
  }

  raycastSurface(x: number, y: number, opts?: { excludeSelection?: boolean }): SurfaceHit | null {
    try {
      return this.picker.raycastSurface(this.env(), x, y, !!opts?.excludeSelection);
    } catch (err) {
      console.error('[engine] raycastSurface', err);
      return null;
    }
  }

  // ================================================================== accès scène

  getObject3D(id: string): Object3D | null {
    this.sync.flush();
    return this.sync.nodes.get(id)?.root ?? null;
  }

  getEvaluatedMesh(id: string): MeshData | null {
    this.sync.flush();
    try {
      return this.sync.evaluator.evaluate(id);
    } catch (err) {
      console.error('[engine] getEvaluatedMesh', err);
      return null;
    }
  }

  // ================================================================== présence

  private collab(): ICollab | null {
    return ((this.app as any).collab as ICollab | undefined) ?? null;
  }

  private subscribePeers(): void {
    const collab = this.collab();
    if (!collab || this.peersOff || !this.container) return;
    try {
      this.peers = collab.getPeers();
      this.peersOff = collab.onPeers((peers) => {
        this.peers = peers;
        this.requestRender();
      });
    } catch (err) {
      console.error('[engine] abonnement à la présence', err);
    }
  }

  private updatePresence(st: AppState): void {
    const connected = st.session.status === 'connected';
    const peers = connected ? this.peers : [];
    const env: PickEnv = {
      doc: this.doc,
      state: st,
      camera: this.camera,
      width: this.width,
      height: this.height,
      sync: this.sync,
      xray: this.sync.visibleXray,
    };
    const map = this.presence.update(peers, st.overlays.presence && connected, st.followClientId, this.doc, this.sync, this.camera, this.height, (ray) =>
      this.picker.castRay(env, ray),
    );
    this.sync.setPeerSelection(map);
  }

  private publishCamera(): void {
    const collab = this.collab();
    if (!collab || this.app.store.getState().session.status !== 'connected') return;
    const v = this.getViewState();
    const key = [...v.pos, ...v.target, v.fov, v.aspect].map((x) => x.toFixed(4)).join(',') + (v.ortho ? 'o' : 'p');
    if (key === this.lastCamKey) return;
    this.lastCamKey = key;
    try {
      collab.setPresence({ camera: v });
    } catch (err) {
      console.error('[engine] diffusion de la caméra', err);
    }
  }

  /** Diffuse le rayon sous le pointeur (limité à ~20 envois/s, dernier état garanti). */
  private bindPointerPresence(): void {
    const dom = this.dom;
    let pending: { x: number; y: number } | null = null;
    const send = () => {
      this.pointerTimer = null;
      const collab = this.collab();
      if (!collab || this.app.store.getState().session.status !== 'connected') return;
      this.lastPointerSent = performance.now();
      try {
        if (!pending) collab.setPresence({ pointer: null });
        else {
          const r = this.screenToRay(pending.x, pending.y);
          collab.setPresence({ pointer: { origin: toVec3(r.origin), dir: toVec3(r.dir) } });
        }
      } catch (err) {
        console.error('[engine] diffusion du pointeur', err);
      }
    };
    const schedule = () => {
      if (this.pointerTimer) return;
      const wait = Math.max(0, 50 - (performance.now() - this.lastPointerSent));
      this.pointerTimer = setTimeout(send, wait);
    };
    const move = (e: PointerEvent) => {
      const rect = dom.getBoundingClientRect();
      pending = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      schedule();
    };
    const leave = () => {
      pending = null;
      schedule();
    };
    dom.addEventListener('pointermove', move, { passive: true });
    dom.addEventListener('pointerleave', leave);
    this.domOffs.push(() => {
      dom.removeEventListener('pointermove', move);
      dom.removeEventListener('pointerleave', leave);
      if (this.pointerTimer) clearTimeout(this.pointerTimer);
      this.pointerTimer = null;
    });
  }

  // ================================================================== rendu final

  async renderFinal(opts?: FinalRenderOptions): Promise<string> {
    if (this.disposed) throw new Error('Viewport libéré');
    if (this.renderJob) throw new Error('Un rendu est déjà en cours');
    const renderer = this.renderer;
    if (!renderer) throw new Error('WebGL indisponible');
    this.sync.flush();
    const ac = this.activeCamera();
    if (!ac) throw new Error('Aucune caméra active dans la scène');
    const settings = { ...this.sync.render };
    const width = Math.round(clamp(finite(opts?.width, settings.resX), 16, 16384));
    const height = Math.round(clamp(finite(opts?.height, settings.resY), 16, 16384));
    const samples = Math.round(clamp(finite(opts?.samples, settings.samples), 1, 1e5));
    const camera = makeSceneCamera(ac.data.kind === 'ortho' ? 'ortho' : 'persp');
    this.configureSceneCamera(camera, ac.data, ac.world, width / height, 1);

    const job = new AbortController();
    this.renderJob = job;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    patchRender({ running: true, progress: 0, samples: 0, imageUrl: null, open: true });
    // état « rendu final » : ombrage rendu, objets `renderable` seulement, aucun overlay
    this.sync.setFinalRender(true);
    try {
      this.sync.flush();
      const url = await renderFinalImage({
        renderer,
        scene: this.sync.scene,
        camera,
        settings,
        width,
        height,
        samples,
        signal: job.signal,
        onProgress: (progress: number, s: number, previewUrl: string | null) => {
          if (job.signal.aborted) return;
          patchRender(previewUrl ? { progress, samples: s, imageUrl: previewUrl } : { progress, samples: s });
        },
      });
      patchRender({ running: false, progress: 1, imageUrl: url });
      return url;
    } catch (err) {
      patchRender({ running: false });
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      this.renderJob = null;
      this.sync.setFinalRender(false);
      this.markDirty('geometry');
      this.markDirty('materials');
      this.markDirty('lights');
      this.markDirty('environment');
      this.markDirty('camera');
      this.requestRender();
    }
  }

  cancelRender(): void {
    this.renderJob?.abort();
  }

  // ================================================================== import / export

  private exportItems(selectionOnly: boolean): ExportItem[] {
    this.sync.flush();
    const sel = this.app.store.getState().selection;
    const items: ExportItem[] = [];
    for (const n of this.sync.nodes.values()) {
      if (n.type !== 'mesh') continue;
      if (selectionOnly && !sel.has(n.id)) continue;
      const mesh = this.sync.evaluator.evaluate(n.id);
      if (!mesh || mesh.faces.size === 0) continue;
      items.push({
        name: n.obj.name,
        mesh,
        matrixWorld: n.root.matrix.clone(),
        material: n.obj.material ? this.doc.getMaterial(n.obj.material) : null,
        smooth: !!n.obj.shadeSmooth,
        autoSmoothAngle: finite(n.obj.autoSmoothAngle, 30),
      });
    }
    return items;
  }

  exportGLB(opts?: { selectionOnly?: boolean }): Promise<ArrayBuffer> {
    const items = this.exportItems(!!opts?.selectionOnly);
    return import('./io/gltf').then((m) => m.exportGLB(items));
  }

  exportOBJ(opts?: { selectionOnly?: boolean }): string {
    return ioExportOBJ(this.exportItems(!!opts?.selectionOnly));
  }

  importFile(name: string, data: ArrayBuffer): Promise<string[]> {
    const doc = this.doc;
    return import('./io/importFile').then((m) => m.importFile(doc, name, data));
  }

  importScene(name: string, data: ArrayBuffer, options?: ImportOptions): Promise<ImportResult> {
    const doc = this.doc;
    return import('./io/importFile').then((m) => m.importScene(doc, name, data, options));
  }
}
