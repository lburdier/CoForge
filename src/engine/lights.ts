import {
  DirectionalLight,
  Object3D,
  PointLight,
  RectAreaLight,
  SpotLight,
  Vector3,
  type BufferGeometry,
  type Light,
} from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import type { CameraData, LightData, LightKind, RenderSettings } from '../core/doc/schema';
import { clamp, finite, lineGeometry, parseColor, pushCircle } from './util';

/**
 * CONVERSION DES PUISSANCES (convention Blender/Cycles → unités de three.js)
 *
 * three.js (depuis r155) et Cycles utilisent la même BRDF diffuse (albédo/π) :
 * il suffit donc de convertir le flux en intensité, sans facteur d'efficacité lumineuse.
 *
 *  - point  : P watts rayonnés dans toutes les directions → intensité I = P / (4π)   [PointLight.intensity]
 *  - spot   : comme Blender, la puissance n'est PAS concentrée dans le cône : I = P / (4π)
 *  - soleil : la « puissance » est un éclairement en W/m² → DirectionalLight.intensity = P
 *  - area   : Cycles applique un facteur historique 1/4 : luminance L = P / (4π · aire)   [RectAreaLight.intensity]
 *
 * Repère : la lumière par défaut (point, 1000 W, à ~6,5 m du cube) donne un
 * éclairement d'environ 1,4 sur la face supérieure, soit une luminance ≈ 0,37
 * pour un albédo de 0,8 : un gris moyen-clair avec une exposition de 0.
 */
export function lightIntensity(data: LightData): number {
  const p = Math.max(0, finite(data.power, 0));
  switch (data.kind) {
    case 'sun':
      return p;
    case 'area': {
      const area = Math.max(1e-4, finite(data.sizeX, 1) * finite(data.sizeY, 1));
      return p / (4 * Math.PI * area);
    }
    default:
      return p / (4 * Math.PI);
  }
}

export type SceneLight = PointLight | SpotLight | DirectionalLight | RectAreaLight;

let ltcReady = false;

/**
 * Crée la lumière three.js d'un type donné. Les lumières émettent vers −Z local
 * (comme dans Blender) : la cible des spots est un enfant placé en (0, 0, −1).
 * Le soleil (DirectionalLight) est géré à part : voir `placeSun`.
 */
export function createLight(kind: LightKind): SceneLight {
  switch (kind) {
    case 'sun': {
      const l = new DirectionalLight();
      l.add(l.target);
      return l;
    }
    case 'spot': {
      const l = new SpotLight();
      l.decay = 2;
      l.distance = 0;
      l.add(l.target);
      l.target.position.set(0, 0, -1);
      return l;
    }
    case 'area': {
      if (!ltcReady) {
        RectAreaLightUniformsLib.init();
        ltcReady = true;
      }
      return new RectAreaLight();
    }
    default: {
      const l = new PointLight();
      l.decay = 2;
      l.distance = 0;
      return l;
    }
  }
}

export function lightKindOf(light: Light): LightKind {
  const any = light as any;
  if (any.isDirectionalLight) return 'sun';
  if (any.isSpotLight) return 'spot';
  if (any.isRectAreaLight) return 'area';
  return 'point';
}

/** Applique couleur, intensité, cône et réglages d'ombre. */
export function applyLightData(light: SceneLight, data: LightData, shadows: RenderSettings['shadows']): void {
  parseColor(data.color, light.color, '#ffffff');
  light.intensity = lightIntensity(data);
  const any = light as any;
  if (any.isSpotLight) {
    const spot = light as SpotLight;
    spot.angle = clamp((finite(data.spotAngle, 45) * Math.PI) / 360, 0.01, Math.PI / 2 - 0.01);
    spot.penumbra = clamp(finite(data.spotBlend, 0.15), 0, 1);
    // rayon de la source : ombres douces du path tracer (PhysicalSpotLight)
    (spot as any).radius = Math.max(0, finite(data.radius, 0));
  }
  if (any.isRectAreaLight) {
    const rect = light as RectAreaLight;
    rect.width = Math.max(0.001, finite(data.sizeX, 1));
    rect.height = Math.max(0.001, finite(data.sizeY, 1));
    return; // pas d'ombres temps réel pour les lumières surfaciques
  }
  const l = light as PointLight | SpotLight | DirectionalLight;
  const cast = shadows !== 'off' && data.castShadow !== false;
  l.castShadow = cast;
  // Taille des shadow maps : 1024 (bas) / 4096 (haut). Les lumières ponctuelles
  // rendent six faces : on les limite à 512 / 2048 pour rester raisonnable sur un GPU modeste.
  const isPoint = any.isPointLight === true;
  const size = shadows === 'high' ? (isPoint ? 2048 : 4096) : isPoint ? 512 : 1024;
  if (l.shadow.mapSize.x !== size) {
    l.shadow.mapSize.set(size, size);
    if (l.shadow.map) {
      l.shadow.map.dispose();
      (l.shadow as any).map = null;
    }
  }
  l.shadow.radius = shadows === 'high' ? 3 : 2;
  if (isPoint) {
    l.shadow.camera.near = 0.05;
    l.shadow.camera.far = 500;
    l.shadow.bias = -0.002;
    l.shadow.normalBias = 0.03;
  } else if (any.isSpotLight) {
    l.shadow.camera.near = 0.05;
    l.shadow.camera.far = 500;
    l.shadow.bias = -0.0005;
    l.shadow.normalBias = 0.02;
  }
}

const _dir = new Vector3();

/**
 * Place un soleil pour que sa caméra d'ombre couvre la sphère englobante de la
 * scène. `travel` = direction de propagation de la lumière (monde, normalisée).
 */
export function placeSun(light: DirectionalLight, travel: Vector3, center: Vector3, radius: number): void {
  const r = Math.max(1, radius);
  _dir.copy(travel).normalize();
  light.position.copy(center).addScaledVector(_dir, -r * 2);
  light.quaternion.identity();
  light.scale.set(1, 1, 1);
  light.target.position.copy(_dir).multiplyScalar(r * 2);
  const cam = light.shadow.camera;
  if (cam.right !== r || cam.far !== r * 4) {
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = 0.05;
    cam.far = r * 4;
    cam.updateProjectionMatrix();
  }
  const texel = (2 * r) / Math.max(1, light.shadow.mapSize.x);
  light.shadow.bias = -0.0002;
  light.shadow.normalBias = Math.max(0.01, texel * 1.5);
  light.updateMatrix();
  light.target.updateMatrix();
}

export function disposeLight(light: Light): void {
  const any = light as any;
  if (any.shadow?.map) any.shadow.map.dispose();
  light.dispose?.();
  light.removeFromParent();
}

// ------------------------------------------------------------------ gizmos filaires

/** Gizmo filaire d'une lumière (coordonnées locales de l'objet, émission vers −Z). */
export function lightGizmoGeometry(data: Pick<LightData, 'kind' | 'spotAngle' | 'sizeX' | 'sizeY' | 'radius'>): BufferGeometry {
  const p: number[] = [];
  const X: [number, number, number] = [1, 0, 0];
  const Y: [number, number, number] = [0, 1, 0];
  const Z: [number, number, number] = [0, 0, 1];
  switch (data.kind) {
    case 'sun': {
      pushCircle(p, 0.18, X, Y, [0, 0, 0], 24);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        p.push(Math.cos(a) * 0.26, Math.sin(a) * 0.26, 0, Math.cos(a) * 0.42, Math.sin(a) * 0.42, 0);
      }
      p.push(0, 0, 0, 0, 0, -1.5);
      break;
    }
    case 'spot': {
      const half = clamp((finite(data.spotAngle, 45) * Math.PI) / 360, 0.01, Math.PI / 2 - 0.05);
      const d = 1.5;
      const r = Math.tan(half) * d;
      pushCircle(p, r, X, Y, [0, 0, -d], 32);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        p.push(0, 0, 0, Math.cos(a) * r, Math.sin(a) * r, -d);
      }
      pushCircle(p, 0.08, X, Y, [0, 0, 0], 12);
      break;
    }
    case 'area': {
      const hx = Math.max(0.001, finite(data.sizeX, 1)) / 2;
      const hy = Math.max(0.001, finite(data.sizeY, 1)) / 2;
      p.push(-hx, -hy, 0, hx, -hy, 0, hx, -hy, 0, hx, hy, 0, hx, hy, 0, -hx, hy, 0, -hx, hy, 0, -hx, -hy, 0);
      p.push(-hx, -hy, 0, hx, hy, 0);
      p.push(0, 0, 0, 0, 0, -0.75);
      break;
    }
    default: {
      pushCircle(p, 0.16, X, Y, [0, 0, 0], 24);
      pushCircle(p, 0.16, X, Z, [0, 0, 0], 24);
      pushCircle(p, 0.16, Y, Z, [0, 0, 0], 24);
      pushCircle(p, 0.3, X, Y, [0, 0, 0], 32);
      break;
    }
  }
  return lineGeometry(p);
}

/** Gizmo filaire d'une caméra : pyramide (ou boîte en ortho) de champ + triangle « haut ». */
export function cameraGizmoGeometry(data: Pick<CameraData, 'kind' | 'fov' | 'orthoScale'>, aspect: number): BufferGeometry {
  const p: number[] = [];
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  let hw: number;
  let hh: number;
  const d = 1;
  if (data.kind === 'ortho') {
    hh = Math.max(0.01, finite(data.orthoScale, 6)) / 2;
    hw = hh * a;
    const c: [number, number][] = [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ];
    for (let i = 0; i < 4; i++) {
      const [x0, y0] = c[i];
      const [x1, y1] = c[(i + 1) % 4];
      p.push(x0, y0, 0, x1, y1, 0, x0, y0, -d, x1, y1, -d, x0, y0, 0, x0, y0, -d);
    }
  } else {
    const half = clamp((finite(data.fov, 40) * Math.PI) / 360, 0.01, Math.PI / 2 - 0.05);
    hh = Math.tan(half) * d;
    hw = hh * a;
    // limite la taille du gizmo pour les très grands angles
    const k = Math.min(1, 0.6 / Math.max(hw, hh));
    hh *= k;
    hw *= k;
    const dz = d * k;
    const c: [number, number][] = [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ];
    for (let i = 0; i < 4; i++) {
      const [x0, y0] = c[i];
      const [x1, y1] = c[(i + 1) % 4];
      p.push(0, 0, 0, x0, y0, -dz, x0, y0, -dz, x1, y1, -dz);
    }
    // triangle « haut »
    p.push(-hw * 0.6, hh * 1.1, -dz, hw * 0.6, hh * 1.1, -dz);
    p.push(hw * 0.6, hh * 1.1, -dz, 0, hh * 1.1 + hw * 0.55, -dz);
    p.push(0, hh * 1.1 + hw * 0.55, -dz, -hw * 0.6, hh * 1.1, -dz);
    return lineGeometry(p);
  }
  p.push(-hw * 0.6, hh * 1.1, -d, hw * 0.6, hh * 1.1, -d);
  p.push(hw * 0.6, hh * 1.1, -d, 0, hh * 1.1 + hw * 0.55, -d);
  p.push(0, hh * 1.1 + hw * 0.55, -d, -hw * 0.6, hh * 1.1, -d);
  return lineGeometry(p);
}

/** Gizmo d'un objet vide : trois axes. */
export function emptyGizmoGeometry(): BufferGeometry {
  const s = 0.5;
  return lineGeometry([-s, 0, 0, s, 0, 0, 0, -s, 0, 0, s, 0, 0, 0, -s, 0, 0, s]);
}

/** Boîte englobante filaire (12 arêtes). */
export function boxGizmoGeometry(min: [number, number, number], max: [number, number, number]): BufferGeometry {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const c = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y1, z0],
    [x0, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1],
  ];
  const e = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
  const p: number[] = [];
  for (const i of e) p.push(c[i][0], c[i][1], c[i][2]);
  return lineGeometry(p);
}

/** Direction de propagation (−Z local) d'un Object3D dont la matrice monde est à jour. */
export function travelDirection(obj: Object3D, out = new Vector3()): Vector3 {
  const e = obj.matrixWorld.elements;
  return out.set(-e[8], -e[9], -e[10]).normalize();
}
