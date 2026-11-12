import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  Group,
  LineSegments,
  Points,
  Ray,
  Sprite,
  SpriteMaterial,
  Vector3,
  type Camera,
  type ShaderMaterial,
} from 'three';
import type { SceneDoc } from '../core/doc/SceneDoc';
import type { Peer, PresenceCamera } from '../net/api';
import { lookQuaternion } from './navigation';
import { createPointsMaterial, LineMaterialCache, ORDER } from './overlayMaterials';
import { worldPerPixelAt } from './overlays';
import type { SceneSync } from './sceneSync';
import { clamp, finite, lineGeometry, parseColor } from './util';

/**
 * Présence collaborative dans le viewport :
 *  - avatar de caméra de chaque autre utilisateur (petit frustum à sa couleur + étiquette de nom) ;
 *  - contour de ses objets sélectionnés (délégué à SceneSync.setPeerSelection) ;
 *  - ses sommets sélectionnés en mode édition ;
 *  - le point de la scène sous son pointeur.
 */

/** Géométrie locale d'un avatar de caméra (sommet à l'origine, visée selon −Z). */
export function avatarGeometry(cam: Pick<PresenceCamera, 'fov' | 'aspect' | 'ortho'>, size = 0.45): BufferGeometry {
  const a = clamp(finite(cam.aspect, 16 / 9), 0.2, 5);
  const half = (clamp(finite(cam.fov, 40), 5, 150) * Math.PI) / 360;
  const d = size;
  let hh = Math.tan(half) * d;
  let hw = hh * a;
  const k = Math.min(1, (size * 0.8) / Math.max(hw, hh));
  hh *= k;
  hw *= k;
  const p: number[] = [];
  const c: [number, number][] = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = c[i];
    const [x1, y1] = c[(i + 1) % 4];
    if (cam.ortho) p.push(x0, y0, 0, x0, y0, -d);
    else p.push(0, 0, 0, x0, y0, -d);
    p.push(x0, y0, -d, x1, y1, -d);
    if (cam.ortho) p.push(x0, y0, 0, x1, y1, 0);
  }
  // triangle « haut »
  p.push(-hw * 0.5, hh * 1.15, -d, hw * 0.5, hh * 1.15, -d);
  p.push(hw * 0.5, hh * 1.15, -d, 0, hh * 1.15 + hw * 0.5, -d);
  p.push(0, hh * 1.15 + hw * 0.5, -d, -hw * 0.5, hh * 1.15, -d);
  return lineGeometry(p);
}

function labelTexture(name: string, color: string): { tex: CanvasTexture; aspect: number } | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const font = '600 28px "Segoe UI", system-ui, sans-serif';
  ctx.font = font;
  const text = name.length > 32 ? `${name.slice(0, 31)}…` : name;
  const w = Math.ceil(ctx.measureText(text).width) + 28;
  const h = 44;
  canvas.width = w;
  canvas.height = h;
  ctx.font = font;
  const bg = parseColor(color, new Color(), '#f5a623');
  ctx.fillStyle = `#${bg.getHexString()}`;
  const r = 10;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(w, 0, w, h, r);
  ctx.arcTo(w, h, 0, h, r);
  ctx.arcTo(0, h, 0, 0, r);
  ctx.arcTo(0, 0, w, 0, r);
  ctx.closePath();
  ctx.fill();
  // texte sombre ou clair selon la luminance du fond
  const lum = 0.2126 * bg.r + 0.7152 * bg.g + 0.0722 * bg.b;
  ctx.fillStyle = lum > 0.45 ? '#111111' : '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 14, h / 2 + 1);
  const tex = new CanvasTexture(canvas);
  tex.needsUpdate = true;
  return { tex, aspect: w / h };
}

interface Avatar {
  group: Group;
  frustum: LineSegments;
  frustumKey: string;
  label: Sprite | null;
  labelKey: string;
  labelAspect: number;
  pointer: Points;
  editPts: Points;
  editKey: string;
  pointMat: ShaderMaterial;
  editMat: ShaderMaterial;
  color: string;
}

export class PresenceLayer {
  readonly group = new Group();
  private avatars = new Map<number, Avatar>();
  private lineMats = new LineMaterialCache();
  private pixelRatio = 1;

  constructor() {
    this.group.name = 'Présence';
  }

  setPixelRatio(pr: number): void {
    this.pixelRatio = pr;
    for (const a of this.avatars.values()) {
      a.pointMat.uniforms.uPixelRatio.value = pr;
      a.editMat.uniforms.uPixelRatio.value = pr;
    }
  }

  setDepthTest(on: boolean): void {
    this.lineMats.setDepthTest(on);
    for (const a of this.avatars.values()) a.editMat.depthTest = on;
  }

  /**
   * Met à jour les avatars. `castRay` : premier impact d'un rayon monde sur les surfaces (pointeurs).
   * Renvoie la carte objet → couleur des sélections des autres utilisateurs.
   */
  update(
    peers: Peer[],
    enabled: boolean,
    followed: number | null,
    doc: SceneDoc,
    sync: SceneSync,
    camera: Camera,
    viewportHeight: number,
    castRay: (ray: Ray) => Vector3 | null,
  ): Map<string, string> {
    const selection = new Map<string, string>();
    const alive = new Set<number>();
    this.group.visible = enabled;
    for (const peer of enabled ? peers : []) {
      const st = peer?.state;
      if (!st || !st.user) continue;
      alive.add(peer.clientId);
      const color = typeof st.user.color === 'string' ? st.user.color : '#f5a623';
      const av = this.avatar(peer.clientId, color);
      if (Array.isArray(st.selection)) for (const id of st.selection) if (typeof id === 'string' && !selection.has(id)) selection.set(id, color);

      // caméra
      const cam = st.camera;
      const camOk = !!cam && Array.isArray(cam.pos) && Array.isArray(cam.target) && cam.pos.every(Number.isFinite) && cam.target.every(Number.isFinite);
      av.group.visible = camOk && peer.clientId !== followed;
      if (camOk && cam) {
        const fkey = `${cam.fov}|${cam.aspect}|${cam.ortho}`;
        if (fkey !== av.frustumKey) {
          av.frustum.geometry.dispose();
          av.frustum.geometry = avatarGeometry(cam);
          av.frustumKey = fkey;
        }
        const eye = new Vector3(cam.pos[0], cam.pos[1], cam.pos[2]);
        const target = new Vector3(cam.target[0], cam.target[1], cam.target[2]);
        av.group.position.copy(eye);
        lookQuaternion(eye, target, undefined, av.group.quaternion);
        av.group.updateMatrixWorld(true);
        const name = typeof st.user.name === 'string' ? st.user.name : '?';
        const lkey = `${name}|${color}`;
        if (lkey !== av.labelKey) {
          if (av.label) {
            av.label.material.map?.dispose();
            av.label.material.dispose();
            av.label.removeFromParent();
            av.label = null;
          }
          const t = labelTexture(name, color);
          if (t) {
            const mat = new SpriteMaterial({ map: t.tex, depthTest: false, depthWrite: false, transparent: true });
            mat.toneMapped = false;
            av.label = new Sprite(mat);
            av.label.center.set(0.5, 0);
            av.label.renderOrder = ORDER.presence + 1;
            this.group.add(av.label);
            av.labelAspect = t.aspect;
          }
          av.labelKey = lkey;
        }
        if (av.label) {
          av.label.visible = av.group.visible;
          const up = new Vector3(0, 1, 0).applyQuaternion(av.group.quaternion);
          av.label.position.copy(eye).addScaledVector(up, 0.45);
          const px = worldPerPixelAt(camera, av.label.position, viewportHeight);
          av.label.scale.set(22 * av.labelAspect * px, 22 * px, 1);
          av.label.updateMatrixWorld(true);
        }
      } else if (av.label) av.label.visible = false;

      // pointeur
      const ptr = st.pointer;
      let hit: Vector3 | null = null;
      if (ptr && Array.isArray(ptr.origin) && Array.isArray(ptr.dir) && ptr.origin.every(Number.isFinite) && ptr.dir.every(Number.isFinite)) {
        const ray = new Ray(new Vector3(...ptr.origin), new Vector3(...ptr.dir).normalize());
        if (ray.direction.lengthSq() > 0.5) hit = castRay(ray);
      }
      av.pointer.visible = !!hit;
      if (hit) {
        const attr = av.pointer.geometry.getAttribute('position') as BufferAttribute;
        attr.setXYZ(0, hit.x, hit.y, hit.z);
        attr.needsUpdate = true;
        av.pointer.geometry.computeBoundingSphere();
      }

      // sommets sélectionnés en mode édition
      let editPos: number[] = [];
      let ekey = '';
      if (st.mode === 'edit' && st.activeId && Array.isArray(st.editVerts) && st.editVerts.length) {
        const node = sync.nodes.get(st.activeId);
        const mesh = node && node.type === 'mesh' && node.obj.data && node.visible ? doc.getMesh(node.obj.data) : null;
        if (node && mesh) {
          const v = new Vector3();
          for (const vid of st.editVerts) {
            const p = typeof vid === 'string' ? mesh.verts.get(vid) : undefined;
            if (!p) continue;
            v.set(p[0], p[1], p[2]).applyMatrix4(node.root.matrix);
            editPos.push(v.x, v.y, v.z);
          }
          ekey = editPos.join(',');
        }
      }
      if (ekey !== av.editKey) {
        av.editKey = ekey;
        const c = parseColor(color, new Color(), '#f5a623');
        const col = new Float32Array((editPos.length / 3) * 4);
        for (let i = 0; i < editPos.length / 3; i++) col.set([c.r, c.g, c.b, 1], i * 4);
        const g = new BufferGeometry();
        g.setAttribute('position', new BufferAttribute(new Float32Array(editPos), 3));
        g.setAttribute('aColor', new BufferAttribute(col, 4));
        av.editPts.geometry.dispose();
        av.editPts.geometry = g;
      }
      av.editPts.visible = editPos.length > 0;
      editPos = [];
    }
    for (const id of [...this.avatars.keys()]) if (!alive.has(id)) this.destroy(id);
    return selection;
  }

  private avatar(clientId: number, color: string): Avatar {
    let av = this.avatars.get(clientId);
    if (av && av.color !== color) {
      this.destroy(clientId);
      av = undefined;
    }
    if (av) return av;
    const group = new Group();
    const frustum = new LineSegments(new BufferGeometry(), this.lineMats.get(color, 1));
    frustum.renderOrder = ORDER.presence;
    frustum.frustumCulled = false;
    group.add(frustum);
    const c = parseColor(color, new Color(), '#f5a623');
    const pointMat = createPointsMaterial(10, true);
    pointMat.depthTest = false;
    pointMat.uniforms.uPixelRatio.value = this.pixelRatio;
    const pg = new BufferGeometry();
    pg.setAttribute('position', new BufferAttribute(new Float32Array(3), 3));
    pg.setAttribute('aColor', new BufferAttribute(new Float32Array([c.r, c.g, c.b, 1]), 4));
    const pointer = new Points(pg, pointMat);
    pointer.renderOrder = ORDER.presence;
    pointer.frustumCulled = false;
    pointer.visible = false;
    const editMat = createPointsMaterial(7, true);
    editMat.uniforms.uPixelRatio.value = this.pixelRatio;
    const editPts = new Points(new BufferGeometry(), editMat);
    editPts.renderOrder = ORDER.presence;
    editPts.frustumCulled = false;
    this.group.add(group, pointer, editPts);
    av = { group, frustum, frustumKey: '', label: null, labelKey: '', labelAspect: 1, pointer, editPts, editKey: '', pointMat, editMat, color };
    this.avatars.set(clientId, av);
    return av;
  }

  private destroy(clientId: number): void {
    const av = this.avatars.get(clientId);
    if (!av) return;
    this.avatars.delete(clientId);
    av.frustum.geometry.dispose();
    av.pointer.geometry.dispose();
    av.editPts.geometry.dispose();
    av.pointMat.dispose();
    av.editMat.dispose();
    if (av.label) {
      av.label.material.map?.dispose();
      av.label.material.dispose();
      av.label.removeFromParent();
    }
    av.group.removeFromParent();
    av.pointer.removeFromParent();
    av.editPts.removeFromParent();
  }

  dispose(): void {
    for (const id of [...this.avatars.keys()]) this.destroy(id);
    this.lineMats.dispose();
    this.group.removeFromParent();
  }
}
