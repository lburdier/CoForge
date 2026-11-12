import {
  Color,
  CubeCamera,
  HalfFloatType,
  LinearFilter,
  PMREMGenerator,
  Scene,
  Vector3,
  WebGLCubeRenderTarget,
  type Texture,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { GradientEquirectTexture } from 'three-gpu-pathtracer';
import type { WorldSettings } from '../core/doc/schema';
import { clamp, finite, parseColor } from './util';

export interface WorldSun {
  /** Direction de propagation de la lumière du soleil (monde, normalisée). */
  travel: Vector3;
  intensity: number;
  color: Color;
}

export interface WorldState {
  background: Color | Texture | null;
  /** Environnement préfiltré (PMREM) pour la rastérisation. */
  environment: Texture | null;
  /** Environnement pour le path tracer (équirectangulaire ou cubemap, non préfiltré). */
  ptEnvironment: Texture | null;
  intensity: number;
  /** Soleil du ciel procédural (null en mode couleur). */
  sun: WorldSun | null;
}

/**
 * Direction VERS le soleil dans le repère Z-up.
 * Convention : azimut 0° = +Y (nord), sens horaire vers +X (est) ; élévation 0° = horizon, 90° = zénith.
 */
export function sunDirection(elevationDeg: number, azimuthDeg: number, out = new Vector3()): Vector3 {
  const el = (clamp(finite(elevationDeg, 40), -90, 90) * Math.PI) / 180;
  const az = (finite(azimuthDeg, 135) * Math.PI) / 180;
  return out.set(Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el));
}

/**
 * Fabrique les textures du « monde » pour UN renderer donné (les cibles de rendu
 * ne se partagent pas entre contextes WebGL) :
 *  - mode 'color' : fond uni + environnement uniforme (PMREM d'une scène unie) ;
 *  - mode 'sky'   : ciel procédural (addon Sky de three, modèle de Preetham) rendu
 *    dans un cubemap orienté Z-up, puis préfiltré en PMREM ;
 *  - environnement « studio » neutre du mode d'affichage Matériau.
 */
export class WorldEnv {
  private pmrem: PMREMGenerator;
  private envRT: WebGLRenderTarget | null = null;
  private studioRT: WebGLRenderTarget | null = null;
  private colorScene = new Scene();
  private colorTex: GradientEquirectTexture | null = null;
  private sky: Sky | null = null;
  private skyScene: Scene | null = null;
  private skyEnvCube: WebGLCubeRenderTarget | null = null;
  private skyBgCube: WebGLCubeRenderTarget | null = null;
  private key = '';
  private state: WorldState = { background: null, environment: null, ptEnvironment: null, intensity: 1, sun: null };

  constructor(private renderer: WebGLRenderer) {
    this.pmrem = new PMREMGenerator(renderer);
  }

  /** Environnement studio neutre (mode Matériau). */
  get studio(): Texture {
    if (!this.studioRT) {
      const room = new RoomEnvironment();
      this.studioRT = this.pmrem.fromScene(room, 0.04);
      room.traverse((o: any) => {
        o.geometry?.dispose?.();
        o.material?.dispose?.();
      });
    }
    return this.studioRT.texture;
  }

  /** Met à jour les textures si les réglages ont changé et renvoie l'état courant. */
  update(world: WorldSettings): WorldState {
    const strength = Math.max(0, finite(world.strength, 1));
    const key =
      world.mode === 'sky'
        ? `sky|${finite(world.sunElevation, 40)}|${finite(world.sunAzimuth, 135)}`
        : `color|${typeof world.color === 'string' ? world.color : ''}`;
    this.state.intensity = strength;
    if (key === this.key) {
      if (this.state.sun) this.state.sun.intensity = this.sunIntensity(world) * strength;
      return this.state;
    }
    this.key = key;
    const renderer = this.renderer;
    const prevTarget = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    renderer.xr.enabled = false;
    try {
      if (world.mode === 'sky') this.buildSky(world, strength);
      else this.buildColor(world);
    } finally {
      renderer.xr.enabled = prevXr;
      renderer.setRenderTarget(prevTarget);
    }
    return this.state;
  }

  private buildColor(world: WorldSettings): void {
    const color = parseColor(world.color, new Color(), '#3d3d3d');
    this.colorScene.background = color;
    const old = this.envRT;
    this.envRT = this.pmrem.fromScene(this.colorScene, 0, 0.1, 100, { size: 64 });
    old?.dispose();
    if (!this.colorTex) this.colorTex = new GradientEquirectTexture(16);
    this.colorTex.topColor.copy(color);
    this.colorTex.bottomColor.copy(color);
    this.colorTex.update();
    this.state.background = color;
    this.state.environment = this.envRT.texture;
    this.state.ptEnvironment = this.colorTex;
    this.state.sun = null;
  }

  private sunIntensity(world: WorldSettings): number {
    const el = clamp(finite(world.sunElevation, 40), -90, 90);
    // le soleil s'éteint progressivement en passant sous l'horizon
    const t = clamp((el + 2) / 12, 0, 1);
    return 3.2 * t * t * (3 - 2 * t);
  }

  private buildSky(world: WorldSettings, strength: number): void {
    if (!this.sky) {
      this.sky = new Sky();
      this.sky.scale.setScalar(1000);
      this.skyScene = new Scene();
      this.skyScene.add(this.sky);
      const u = this.sky.material.uniforms;
      u.turbidity.value = 2.5;
      u.rayleigh.value = 1.2;
      u.mieCoefficient.value = 0.005;
      u.mieDirectionalG.value = 0.8;
      if (u.cloudCoverage) u.cloudCoverage.value = 0;
      this.skyEnvCube = new WebGLCubeRenderTarget(128, { type: HalfFloatType, generateMipmaps: false, minFilter: LinearFilter, magFilter: LinearFilter });
      this.skyBgCube = new WebGLCubeRenderTarget(512, { type: HalfFloatType, generateMipmaps: false, minFilter: LinearFilter, magFilter: LinearFilter });
    }
    const toSun = sunDirection(world.sunElevation, world.sunAzimuth);
    const u = this.sky.material.uniforms;
    // Le shader du ciel est Y-up : on lui donne le soleil dans son repère (x, z, −y)
    // et on tourne la caméra cube de −90° autour de X pour produire un cubemap Z-up.
    u.sunPosition.value.set(toSun.x, toSun.z, -toSun.y);
    const render = (target: WebGLCubeRenderTarget, disc: boolean) => {
      if (u.showSunDisc) u.showSunDisc.value = disc ? 1 : 0;
      const cam = new CubeCamera(0.1, 5000, target);
      cam.rotation.x = -Math.PI / 2;
      cam.updateMatrixWorld(true);
      cam.update(this.renderer, this.skyScene!);
    };
    render(this.skyEnvCube!, false);
    render(this.skyBgCube!, true);
    const old = this.envRT;
    this.envRT = this.pmrem.fromCubemap(this.skyEnvCube!.texture);
    old?.dispose();

    const el = clamp(finite(world.sunElevation, 40), -90, 90);
    const warm = clamp(el / 35, 0, 1);
    const color = new Color(1, 0.62 + 0.34 * warm, 0.36 + 0.54 * warm);
    this.state.background = this.skyBgCube!.texture;
    this.state.environment = this.envRT.texture;
    this.state.ptEnvironment = this.skyEnvCube!.texture;
    this.state.sun = { travel: toSun.clone().negate(), intensity: this.sunIntensity(world) * strength, color };
  }

  dispose(): void {
    this.envRT?.dispose();
    this.studioRT?.dispose();
    this.colorTex?.dispose();
    this.skyEnvCube?.dispose();
    this.skyBgCube?.dispose();
    if (this.sky) {
      this.sky.geometry.dispose();
      this.sky.material.dispose();
    }
    this.pmrem.dispose();
    this.envRT = this.studioRT = null;
    this.key = '';
  }
}
