import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Points,
  Scene,
  ShaderMaterial,
  Vector3,
  type Camera,
  type PerspectiveCamera,
} from 'three';
import type { AppState } from '../app/store';
import { createPointsMaterial, createVertexColorLineMaterial, ORDER } from './overlayMaterials';
import type { SceneSync } from './sceneSync';
import { COLOR_ACTIVE, COLOR_SELECTED } from './util';

/** Taille d'un pixel écran (en mètres) à la position monde `p` pour la caméra donnée. */
export function worldPerPixelAt(camera: Camera, p: Vector3, viewportHeight: number): number {
  const h = Math.max(1, viewportHeight);
  if ((camera as any).isOrthographicCamera) {
    const o = camera as OrthographicCamera;
    return (o.top - o.bottom) / Math.max(1e-6, o.zoom) / h;
  }
  const c = camera as PerspectiveCamera;
  const camPos = new Vector3().setFromMatrixPosition(c.matrixWorld);
  const fwd = new Vector3(0, 0, -1).transformDirection(c.matrixWorld);
  const depth = Math.max(1e-4, new Vector3().subVectors(p, camPos).dot(fwd));
  return (2 * depth * Math.tan(((c.fov ?? 40) * Math.PI) / 360)) / Math.max(1e-6, c.zoom ?? 1) / h;
}

// ====================================================================== grille

const AXIS_COLORS = { x: new Color('#ff3352'), y: new Color('#8bdc00'), z: new Color('#2890ff') };

/**
 * Grille « infinie » à la Blender : un grand quadrilatère dont le shader trace
 * lignes mineures/majeures (pas adapté à la distance, fondu entre niveaux),
 * axes colorés (X rouge, Y vert, Z bleu) et fondu avec la distance.
 * Sol XY en perspective ; plan de la vue dans les vues axiales orthographiques.
 */
export class Grid {
  readonly mesh: Mesh;
  private mat: ShaderMaterial;

  constructor() {
    this.mat = new ShaderMaterial({
      name: 'grille',
      uniforms: {
        uPlane: { value: 0 },
        uStep: { value: 1 },
        uBlend: { value: 1 },
        uCamPos: { value: new Vector3() },
        uFadeFar: { value: 300 },
        uShowGrid: { value: 1 },
        uShowAxes: { value: 1 },
        uColU: { value: AXIS_COLORS.x.clone() },
        uColV: { value: AXIS_COLORS.y.clone() },
        uLine: { value: new Color(0.33, 0.33, 0.33) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform int uPlane;
        uniform float uStep;
        uniform float uBlend;
        uniform vec3 uCamPos;
        uniform float uFadeFar;
        uniform float uShowGrid;
        uniform float uShowAxes;
        uniform vec3 uColU;
        uniform vec3 uColV;
        uniform vec3 uLine;
        varying vec3 vWorld;

        float lines(vec2 coord, float step) {
          vec2 c = coord / step;
          vec2 fw = max(fwidth(c), vec2(1e-6));
          vec2 g = abs(fract(c - 0.5) - 0.5) / fw;
          return 1.0 - min(min(g.x, g.y), 1.0);
        }

        void main() {
          vec2 uv = uPlane == 0 ? vWorld.xy : (uPlane == 1 ? vWorld.xz : vWorld.yz);
          float minor = lines(uv, uStep) * uBlend;
          float major = lines(uv, uStep * 10.0);
          float a = max(minor * 0.28, major * 0.5) * uShowGrid;
          vec3 col = uLine;
          // axes : la ligne v = 0 porte l'axe U, la ligne u = 0 porte l'axe V
          vec2 fw = max(fwidth(uv), vec2(1e-6));
          float onU = 1.0 - min(abs(uv.y) / (fw.y * 1.2), 1.0);
          float onV = 1.0 - min(abs(uv.x) / (fw.x * 1.2), 1.0);
          if (uShowAxes > 0.5) {
            if (onU > 0.0 && onU >= onV) { col = mix(col, uColU, onU); a = max(a, onU * 0.9); }
            else if (onV > 0.0) { col = mix(col, uColV, onV); a = max(a, onV * 0.9); }
          }
          float d = distance(uCamPos, vWorld);
          a *= 1.0 - smoothstep(uFadeFar * 0.25, uFadeFar, d);
          if (a <= 0.003) discard;
          gl_FragColor = vec4(col, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: DoubleSide,
    });
    this.mat.toneMapped = false;
    this.mesh = new Mesh(new PlaneGeometry(1, 1), this.mat);
    this.mesh.name = 'Grille';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = ORDER.grid;
  }

  /**
   * @param axis axe regardé en vue axiale orthographique (null : sol XY)
   * @param dist distance de la caméra au point d'orbite
   */
  update(st: AppState, camera: Camera, target: Vector3, dist: number, axis: 'x' | 'y' | 'z' | null, ortho: boolean, xray: boolean): void {
    const show = st.overlays.grid || st.overlays.axes;
    this.mesh.visible = show;
    if (!show) return;
    const u = this.mat.uniforms;
    u.uShowGrid.value = st.overlays.grid ? 1 : 0;
    u.uShowAxes.value = st.overlays.axes ? 1 : 0;
    const plane = ortho && axis === 'y' ? 1 : ortho && axis === 'x' ? 2 : 0;
    u.uPlane.value = plane;
    if (plane === 0) {
      u.uColU.value.copy(AXIS_COLORS.x);
      u.uColV.value.copy(AXIS_COLORS.y);
    } else if (plane === 1) {
      u.uColU.value.copy(AXIS_COLORS.x);
      u.uColV.value.copy(AXIS_COLORS.z);
    } else {
      u.uColU.value.copy(AXIS_COLORS.y);
      u.uColV.value.copy(AXIS_COLORS.z);
    }
    const camPos = new Vector3().setFromMatrixPosition(camera.matrixWorld);
    // pas de la grille : puissance de 10 selon la distance (hauteur de la caméra au-dessus du sol en perspective)
    const height = plane === 0 && !ortho ? Math.max(Math.abs(camPos.z), dist * 0.25) : dist;
    const lv = Math.log10(Math.max(1e-3, height / 8));
    const level = Math.floor(lv);
    u.uStep.value = Math.pow(10, level);
    u.uBlend.value = 1 - (lv - level);
    u.uCamPos.value.copy(camPos);
    u.uFadeFar.value = ortho ? 1e9 : Math.max(50, height * 60);
    const size = ortho ? Math.max(200, dist * 400) : Math.max(200, height * 160);
    this.mesh.scale.set(size, size, 1);
    if (plane === 0) {
      this.mesh.rotation.set(0, 0, 0, 'XYZ');
      this.mesh.position.set(Math.round(target.x), Math.round(target.y), 0);
    } else if (plane === 1) {
      this.mesh.rotation.set(Math.PI / 2, 0, 0, 'XYZ');
      this.mesh.position.set(Math.round(target.x), 0, Math.round(target.z));
    } else {
      // (x, y, 0) → (0, x, y) : rotation autour de X puis autour de Z
      this.mesh.rotation.set(Math.PI / 2, 0, Math.PI / 2, 'ZYX');
      this.mesh.position.set(0, Math.round(target.y), Math.round(target.z));
    }
    this.mesh.updateMatrixWorld(true);
    // en perspective, une caméra sous le sol voit la grille par-dessous : rien à changer (DoubleSide)
    this.mesh.renderOrder = xray ? ORDER.gridXray : ORDER.grid;
    this.mat.depthTest = !xray;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}

// ====================================================================== curseur 3D

/** Curseur 3D de Blender : anneau pointillé rouge/blanc et réticule, taille constante à l'écran. */
export class Cursor3D {
  readonly group = new Group();
  private lines: LineSegments;
  private mat = createVertexColorLineMaterial();

  constructor() {
    const pos: number[] = [];
    const col: number[] = [];
    const seg = 32;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      pos.push(Math.cos(a0), Math.sin(a0), 0, Math.cos(a1), Math.sin(a1), 0);
      const c = Math.floor(i / 2) % 2 === 0 ? [1, 0.15, 0.15, 1] : [1, 1, 1, 1];
      col.push(...c, ...c);
    }
    // réticule : quatre branches noires de part et d'autre de l'anneau
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      pos.push(dx * 0.35, dy * 0.35, 0, dx * 0.8, dy * 0.8, 0);
      pos.push(dx * 1.2, dy * 1.2, 0, dx * 1.65, dy * 1.65, 0);
      for (let k = 0; k < 4; k++) col.push(0, 0, 0, 1);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('aColor', new BufferAttribute(new Float32Array(col), 4));
    this.mat.depthTest = false;
    this.lines = new LineSegments(g, this.mat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = ORDER.cursor;
    this.group.add(this.lines);
    this.group.name = 'Curseur 3D';
  }

  update(st: AppState, camera: Camera, viewportHeight: number): void {
    const c = st.cursor3d;
    const ok = Array.isArray(c) && c.length === 3 && c.every((v) => Number.isFinite(v));
    this.group.visible = ok;
    if (!ok) return;
    this.group.position.set(c[0], c[1], c[2]);
    this.group.quaternion.setFromRotationMatrix(camera.matrixWorld);
    const s = 11 * worldPerPixelAt(camera, this.group.position, viewportHeight);
    this.group.scale.setScalar(s);
    this.group.updateMatrixWorld(true);
  }

  dispose(): void {
    this.lines.geometry.dispose();
    this.mat.dispose();
  }
}

// ====================================================================== origines

/** Origines des objets sélectionnés (point orange, actif plus clair). */
export class Origins {
  readonly points: Points;
  private mat = createPointsMaterial(7, true);
  private key = '';

  constructor() {
    this.mat.depthTest = false;
    this.points = new Points(new BufferGeometry(), this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = ORDER.origins;
    this.points.name = 'Origines';
  }

  setPixelRatio(pr: number): void {
    this.mat.uniforms.uPixelRatio.value = pr;
  }

  update(st: AppState, sync: SceneSync): void {
    const pos: number[] = [];
    const col: number[] = [];
    const act = new Color(COLOR_ACTIVE);
    const sel = new Color(COLOR_SELECTED);
    if (st.mode === 'object') {
      for (const id of st.selection) {
        const n = sync.nodes.get(id);
        if (!n || !n.visible) continue;
        const e = n.root.matrix.elements;
        pos.push(e[12], e[13], e[14]);
        const c = id === st.activeId ? act : sel;
        col.push(c.r, c.g, c.b, 1);
      }
    }
    const key = pos.join(',') + '|' + col.join(',');
    this.points.visible = pos.length > 0;
    if (key === this.key) return;
    this.key = key;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('aColor', new BufferAttribute(new Float32Array(col), 4));
    this.points.geometry.dispose();
    this.points.geometry = g;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.mat.dispose();
  }
}

// ====================================================================== cadre de la vue caméra

/**
 * Passe « HUD » en pixels écran : cadre assombri autour de l'image de la
 * caméra active en vue caméra (passe-partout de Blender).
 */
export class Hud {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(0, 1, 0, -1, -10, 10);
  private shade = new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false });
  private quads: Mesh[] = [];
  private border: LineSegments;
  private borderMat = new LineBasicMaterial({ color: 0x9a9a9a, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false });

  constructor() {
    this.shade.toneMapped = false;
    this.borderMat.toneMapped = false;
    for (let i = 0; i < 4; i++) {
      const q = new Mesh(new PlaneGeometry(1, 1), this.shade);
      q.frustumCulled = false;
      this.quads.push(q);
      this.scene.add(q);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(24), 3));
    this.border = new LineSegments(g, this.borderMat);
    this.border.frustumCulled = false;
    this.scene.add(this.border);
    this.scene.visible = false;
  }

  /** `frame` : rectangle de l'image en pixels CSS (x, y depuis le haut-gauche), ou null. */
  update(width: number, height: number, frame: { x: number; y: number; w: number; h: number } | null): boolean {
    this.scene.visible = !!frame;
    if (!frame) return false;
    const c = this.camera;
    c.left = 0;
    c.right = width;
    c.top = 0;
    c.bottom = -height;
    c.updateProjectionMatrix();
    // y vers le bas → on travaille en y négatif
    const fx0 = frame.x;
    const fx1 = frame.x + frame.w;
    const fy0 = -frame.y;
    const fy1 = -(frame.y + frame.h);
    const set = (q: Mesh, x0: number, x1: number, y0: number, y1: number) => {
      const w = Math.max(0, x1 - x0);
      const h = Math.max(0, y0 - y1);
      q.visible = w > 0 && h > 0;
      q.position.set((x0 + x1) / 2, (y0 + y1) / 2, 0);
      q.scale.set(Math.max(w, 1e-3), Math.max(h, 1e-3), 1);
      q.updateMatrixWorld(true);
    };
    set(this.quads[0], 0, width, 0, fy0); // haut
    set(this.quads[1], 0, width, fy1, -height); // bas
    set(this.quads[2], 0, fx0, fy0, fy1); // gauche
    set(this.quads[3], fx1, width, fy0, fy1); // droite
    const p = this.border.geometry.getAttribute('position') as BufferAttribute;
    const pts = [fx0, fy0, fx1, fy0, fx1, fy0, fx1, fy1, fx1, fy1, fx0, fy1, fx0, fy1, fx0, fy0];
    for (let i = 0; i < 8; i++) p.setXYZ(i, pts[i * 2], pts[i * 2 + 1], 0);
    p.needsUpdate = true;
    this.border.updateMatrixWorld(true);
    return true;
  }

  dispose(): void {
    for (const q of this.quads) q.geometry.dispose();
    this.border.geometry.dispose();
    this.shade.dispose();
    this.borderMat.dispose();
  }
}
