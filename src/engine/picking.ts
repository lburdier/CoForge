import { DoubleSide, Matrix3, Matrix4, Ray, Sphere, Vector3, type Camera } from 'three';
import type { ElementHit, SurfaceHit } from './api';
import type { AppState, SelectMode } from '../app/store';
import type { SceneDoc } from '../core/doc/SceneDoc';
import { edgeKey, type MeshData } from '../core/doc/schema';
import type { GeoEntry } from './geometryPool';
import type { ObjNode, SceneSync } from './sceneSync';
import { toVec3 } from './util';

// ====================================================================== géométrie écran PURE

/** Point projeté : coordonnées écran (px CSS) et w de clip (> 0 devant la caméra). */
export interface Projected {
  x: number;
  y: number;
  w: number;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function normRect(x0: number, y0: number, x1: number, y1: number): Rect {
  return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
}

const W_EPS = 1e-6;

/**
 * Projecteur rapide : `m` = projection × vue × monde (éléments column-major de three).
 * Écrit dans `out` et renvoie false si le point est derrière la caméra.
 */
export function makeProjector(m: ArrayLike<number>, width: number, height: number) {
  const e = m;
  return (x: number, y: number, z: number, out: Projected): boolean => {
    const cx = e[0] * x + e[4] * y + e[8] * z + e[12];
    const cy = e[1] * x + e[5] * y + e[9] * z + e[13];
    const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
    out.w = cw;
    if (cw <= W_EPS) return false;
    out.x = ((cx / cw) * 0.5 + 0.5) * width;
    out.y = (0.5 - (cy / cw) * 0.5) * height;
    return true;
  };
}

/** Coordonnées de clip (x, y, w) d'un point, sans division. */
export function clipOf(m: ArrayLike<number>, x: number, y: number, z: number): [number, number, number] {
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[3] * x + m[7] * y + m[11] * z + m[15]];
}

/**
 * Projette un segment en le découpant au plan w = ε (la partie derrière la
 * caméra est retirée). Renvoie [ax, ay, bx, by, t0, t1] (t = paramètres
 * conservés sur le segment d'origine) ou null si tout est derrière.
 */
export function projectSegment(
  m: ArrayLike<number>,
  width: number,
  height: number,
  a: ArrayLike<number>,
  b: ArrayLike<number>,
): [number, number, number, number, number, number] | null {
  const ca = clipOf(m, a[0], a[1], a[2]);
  const cb = clipOf(m, b[0], b[1], b[2]);
  let t0 = 0;
  let t1 = 1;
  const eps = 1e-5;
  if (ca[2] <= eps && cb[2] <= eps) return null;
  if (ca[2] <= eps) t0 = (eps - ca[2]) / (cb[2] - ca[2]);
  else if (cb[2] <= eps) t1 = (eps - ca[2]) / (cb[2] - ca[2]);
  const lerp = (t: number) => {
    const x = ca[0] + (cb[0] - ca[0]) * t;
    const y = ca[1] + (cb[1] - ca[1]) * t;
    const w = ca[2] + (cb[2] - ca[2]) * t;
    return [((x / w) * 0.5 + 0.5) * width, (0.5 - (y / w) * 0.5) * height];
  };
  const [ax, ay] = lerp(t0);
  const [bx, by] = lerp(t1);
  return [ax, ay, bx, by, t0, t1];
}

/** Distance d'un point à un segment 2D, et paramètre t du point le plus proche. */
export function distToSegment2D(px: number, py: number, ax: number, ay: number, bx: number, by: number): { d: number; t: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 1e-12 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + dx * t - px;
  const cy = ay + dy * t - py;
  return { d: Math.sqrt(cx * cx + cy * cy), t };
}

export function pointInRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
}

/** Le segment [a, b] touche-t-il le rectangle ? (Liang–Barsky) */
export function segmentIntersectsRect(ax: number, ay: number, bx: number, by: number, r: Rect): boolean {
  if (pointInRect(ax, ay, r) || pointInRect(bx, by, r)) return true;
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [ax - r.x0, r.x1 - ax, ay - r.y0, r.y1 - ay];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-12) {
      if (q[i] < 0) return false;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }
  return t0 <= t1;
}

export function pointInTriangle2D(px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** Arêtes uniques d'un maillage polygonal (clé edgeKey → [a, b]). */
export function meshEdges(mesh: MeshData): Map<string, [string, string]> {
  const out = new Map<string, [string, string]>();
  for (const loop of mesh.faces.values()) {
    const n = loop.length;
    for (let i = 0; i < n; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % n];
      if (a === b || !mesh.verts.has(a) || !mesh.verts.has(b)) continue;
      const k = edgeKey(a, b);
      if (!out.has(k)) out.set(k, a < b ? [a, b] : [b, a]);
    }
  }
  return out;
}

/** Centre (moyenne des sommets) d'une face, null si un sommet manque. */
export function faceCentroid(mesh: MeshData, loop: readonly string[]): [number, number, number] | null {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const v of loop) {
    const p = mesh.verts.get(v);
    if (!p) return null;
    x += p[0];
    y += p[1];
    z += p[2];
  }
  const n = loop.length || 1;
  return [x / n, y / n, z / n];
}

/**
 * Élément le plus proche du pointeur parmi des candidats projetés :
 * renvoie l'indice du candidat le plus proche sous la tolérance, en testant la
 * visibilité (`visible`) dans l'ordre de distance croissante.
 */
export function nearestVisible<T extends { d: number }>(cands: T[], tolerance: number, visible: (c: T) => boolean): T | null {
  const list = cands.filter((c) => c.d <= tolerance).sort((a, b) => a.d - b.d);
  for (const c of list) if (visible(c)) return c;
  return null;
}

// ====================================================================== picking dans la scène

export interface PickEnv {
  doc: SceneDoc;
  state: AppState;
  camera: Camera;
  width: number;
  height: number;
  sync: SceneSync;
  xray: boolean;
}

interface RayHit {
  id: string;
  distance: number;
  point: Vector3;
  /** Normale monde (orientée vers le rayon). */
  normal: Vector3;
  /** Triangle d'origine (index dans RenderMesh). */
  tri: number;
}

const VERT_TOL = 12;
const EDGE_TOL = 10;
const GIZMO_TOL = 8;

export class Picker {
  /** Géométrie du maillage de BASE de l'objet édité (picking des faces), conservée entre deux clics. */
  private cage: { mesh: MeshData; smooth: boolean; angle: number; entry: GeoEntry } | null = null;

  constructor(private sync: SceneSync) {}

  dispose(): void {
    if (this.cage) this.sync.pool.release(this.cage.entry);
    this.cage = null;
  }

  // ------------------------------------------------------------------ rayons

  ray(env: PickEnv, x: number, y: number): Ray {
    const cam = env.camera;
    const nx = (x / Math.max(1, env.width)) * 2 - 1;
    const ny = -((y / Math.max(1, env.height)) * 2 - 1);
    const ray = new Ray();
    if ((cam as any).isOrthographicCamera) {
      ray.origin.set(nx, ny, -1).unproject(cam);
      ray.direction.set(0, 0, -1).transformDirection(cam.matrixWorld);
    } else {
      ray.origin.setFromMatrixPosition(cam.matrixWorld);
      ray.direction.set(nx, ny, 0.5).unproject(cam).sub(ray.origin).normalize();
    }
    return ray;
  }

  viewProj(env: PickEnv, world?: Matrix4): Matrix4 {
    const m = new Matrix4().multiplyMatrices(env.camera.projectionMatrix, env.camera.matrixWorldInverse);
    if (world) m.multiply(world);
    return m;
  }

  /** Intersection d'un rayon monde avec la surface d'un nœud (BVH en espace local). */
  private raycastNode(n: ObjNode, ray: Ray, entry?: GeoEntry | null): RayHit | null {
    const g = entry ?? n.geo;
    if (!g) return null;
    const m = n.root.matrix;
    if (!entry) {
      const s = new Sphere().copy(g.sphere).applyMatrix4(m);
      if (!ray.intersectsSphere(s)) return null;
    }
    const bvh = this.sync.pool.bvh(g);
    if (!bvh) return null;
    const inv = new Matrix4().copy(m).invert();
    const local = ray.clone().applyMatrix4(inv);
    local.direction.normalize();
    const hit = bvh.raycastFirst(local, DoubleSide);
    if (!hit) return null;
    const point = hit.point.clone().applyMatrix4(m);
    const distance = point.distanceTo(ray.origin);
    const nm = new Matrix3().getNormalMatrix(m);
    const normal = (hit.face?.normal ?? new Vector3(0, 0, 1)).clone().applyMatrix3(nm).normalize();
    if (normal.dot(ray.direction) > 0) normal.negate();
    const a = hit.face ? hit.face.a : 0;
    return { id: n.id, distance, point, normal, tri: Math.floor(a / 3) };
  }

  /** Surfaces pleines visibles (pour le picking et l'occultation). */
  private solidNodes(env: PickEnv): ObjNode[] {
    const out: ObjNode[] = [];
    for (const n of this.sync.nodes.values()) {
      if (n.type !== 'mesh' || !n.visible || !n.geo || !n.surface) continue;
      if (n.obj.displayAs !== 'solid') continue;
      out.push(n);
    }
    return out;
  }

  /** Premier impact sur les surfaces visibles (`skip` : objets ignorés). */
  private firstHit(env: PickEnv, ray: Ray, skip?: (id: string) => boolean): RayHit | null {
    let best: RayHit | null = null;
    for (const n of this.solidNodes(env)) {
      if (skip?.(n.id)) continue;
      const h = this.raycastNode(n, ray);
      if (h && (!best || h.distance < best.distance)) best = h;
    }
    return best;
  }

  // ------------------------------------------------------------------ objets

  pickObject(env: PickEnv, x: number, y: number): string | null {
    const ray = this.ray(env, x, y);
    let best: { id: string; dist: number } | null = null;
    const consider = (id: string, dist: number) => {
      if (!best || dist < best.dist) best = { id, dist };
    };
    const vp = this.viewProj(env);
    for (const n of this.sync.nodes.values()) {
      if (!n.visible) continue;
      if (n.type === 'mesh') {
        if (!n.geo) continue;
        const display = n.obj.displayAs;
        if (display === 'bounds') {
          const box = n.geo.bounds;
          if (box.isEmpty()) continue;
          const inv = new Matrix4().copy(n.root.matrix).invert();
          const local = ray.clone().applyMatrix4(inv);
          const p = local.intersectBox(box, new Vector3());
          if (p) consider(n.id, p.applyMatrix4(n.root.matrix).distanceTo(ray.origin));
          continue;
        }
        const h = this.raycastNode(n, ray);
        if (h) consider(n.id, h.distance);
        else if (display === 'wire' || env.sync.effectiveShading === 'wireframe') {
          const d = this.segmentsHit(env, n.geo.edges.getAttribute('position').array as ArrayLike<number>, n.root.matrix, x, y, GIZMO_TOL, ray);
          if (d !== null) consider(n.id, d);
        }
        continue;
      }
      if (!this.sync.gizmoPickable(n)) continue;
      const pos = this.gizmoPositions(n);
      const d = pos ? this.segmentsHit(env, pos, n.root.matrix, x, y, GIZMO_TOL, ray) : null;
      if (d !== null) consider(n.id, d);
      else {
        // origine de l'objet
        const o = new Vector3().setFromMatrixPosition(n.root.matrix);
        const pr = { x: 0, y: 0, w: 0 };
        if (makeProjector(vp.elements, env.width, env.height)(o.x, o.y, o.z, pr) && Math.hypot(pr.x - x, pr.y - y) <= 10) {
          consider(n.id, o.distanceTo(ray.origin));
        }
      }
    }
    return (best as { id: string; dist: number } | null)?.id ?? null;
  }

  private gizmoPositions(n: ObjNode): ArrayLike<number> | null {
    const attr = n.gizmo?.geometry.getAttribute('position');
    return attr ? (attr.array as ArrayLike<number>) : null;
  }

  /** Distance (monde, le long du rayon) du segment le plus proche du pointeur sous la tolérance, ou null. */
  private segmentsHit(env: PickEnv, pos: ArrayLike<number>, world: Matrix4, x: number, y: number, tol: number, ray: Ray): number | null {
    const m = this.viewProj(env, world).elements;
    let bestD = Infinity;
    let bestPoint: Vector3 | null = null;
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    for (let i = 0; i + 5 < pos.length; i += 6) {
      a[0] = pos[i];
      a[1] = pos[i + 1];
      a[2] = pos[i + 2];
      b[0] = pos[i + 3];
      b[1] = pos[i + 4];
      b[2] = pos[i + 5];
      const s = projectSegment(m, env.width, env.height, a, b);
      if (!s) continue;
      const r = distToSegment2D(x, y, s[0], s[1], s[2], s[3]);
      if (r.d <= tol && r.d < bestD) {
        bestD = r.d;
        const t = s[4] + (s[5] - s[4]) * r.t;
        bestPoint = new Vector3(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t).applyMatrix4(world);
      }
    }
    return bestPoint ? bestPoint.distanceTo(ray.origin) : null;
  }

  pickObjectsInRect(env: PickEnv, r: Rect): string[] {
    const out: string[] = [];
    const pr: Projected = { x: 0, y: 0, w: 0 };
    const cx = (r.x0 + r.x1) / 2;
    const cy = (r.y0 + r.y1) / 2;
    for (const n of this.sync.nodes.values()) {
      if (!n.visible) continue;
      const world = n.root.matrix;
      const m = this.viewProj(env, world).elements;
      const proj = makeProjector(m, env.width, env.height);
      if (n.type === 'mesh') {
        const g = n.geo;
        if (!g || g.bounds.isEmpty()) continue;
        // rejet rapide par la boîte projetée
        const bb = g.bounds;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        let behind = false;
        for (let i = 0; i < 8; i++) {
          const px = i & 1 ? bb.max.x : bb.min.x;
          const py = i & 2 ? bb.max.y : bb.min.y;
          const pz = i & 4 ? bb.max.z : bb.min.z;
          if (!proj(px, py, pz, pr)) {
            behind = true;
            continue;
          }
          minX = Math.min(minX, pr.x);
          minY = Math.min(minY, pr.y);
          maxX = Math.max(maxX, pr.x);
          maxY = Math.max(maxY, pr.y);
        }
        if (!behind && (maxX < r.x0 || minX > r.x1 || maxY < r.y0 || minY > r.y1)) continue;
        if (!behind && minX >= r.x0 && maxX <= r.x1 && minY >= r.y0 && maxY <= r.y1) {
          out.push(n.id);
          continue;
        }
        if (n.obj.displayAs === 'bounds') {
          if (this.anySegmentInRect(env, boxSegments(bb), world, r)) out.push(n.id);
          continue;
        }
        const edges = g.edges.getAttribute('position').array as ArrayLike<number>;
        if (this.anySegmentInRect(env, edges, world, r)) {
          out.push(n.id);
          continue;
        }
        // rectangle entièrement à l'intérieur d'un triangle projeté
        const pos = g.rm.positions;
        const pa: Projected = { x: 0, y: 0, w: 0 };
        const pb: Projected = { x: 0, y: 0, w: 0 };
        const pc: Projected = { x: 0, y: 0, w: 0 };
        for (let i = 0; i + 8 < pos.length; i += 9) {
          if (!proj(pos[i], pos[i + 1], pos[i + 2], pa)) continue;
          if (!proj(pos[i + 3], pos[i + 4], pos[i + 5], pb)) continue;
          if (!proj(pos[i + 6], pos[i + 7], pos[i + 8], pc)) continue;
          if (pointInTriangle2D(cx, cy, pa.x, pa.y, pb.x, pb.y, pc.x, pc.y)) {
            out.push(n.id);
            break;
          }
        }
        continue;
      }
      if (!this.sync.gizmoPickable(n)) continue;
      if (proj(0, 0, 0, pr) && pointInRect(pr.x, pr.y, r)) {
        out.push(n.id);
        continue;
      }
      const pos = this.gizmoPositions(n);
      if (pos && this.anySegmentInRect(env, pos, world, r)) out.push(n.id);
    }
    return out;
  }

  private anySegmentInRect(env: PickEnv, pos: ArrayLike<number>, world: Matrix4, r: Rect): boolean {
    const m = this.viewProj(env, world).elements;
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    for (let i = 0; i + 5 < pos.length; i += 6) {
      a[0] = pos[i];
      a[1] = pos[i + 1];
      a[2] = pos[i + 2];
      b[0] = pos[i + 3];
      b[1] = pos[i + 4];
      b[2] = pos[i + 5];
      const s = projectSegment(m, env.width, env.height, a, b);
      if (s && segmentIntersectsRect(s[0], s[1], s[2], s[3], r)) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ surfaces

  /** Premier point d'impact d'un rayon monde quelconque sur les surfaces visibles. */
  castRay(env: PickEnv, ray: Ray): Vector3 | null {
    return this.firstHit(env, ray)?.point ?? null;
  }

  raycastSurface(env: PickEnv, x: number, y: number, excludeSelection: boolean): SurfaceHit | null {
    const ray = this.ray(env, x, y);
    const sel = env.state.selection;
    const hit = this.firstHit(env, ray, excludeSelection ? (id) => sel.has(id) : undefined);
    if (!hit) return null;
    return { objectId: hit.id, point: toVec3(hit.point), normal: toVec3(hit.normal) };
  }

  /** Le point monde `p` est-il visible depuis la caméra (non masqué par une surface) ? */
  private visibleAt(env: PickEnv, p: Vector3, skip?: (id: string) => boolean): boolean {
    if (env.xray) return true;
    const cam = env.camera;
    const ray = new Ray();
    let eps: number;
    if ((cam as any).isOrthographicCamera) {
      const dir = new Vector3(0, 0, -1).transformDirection(cam.matrixWorld);
      ray.direction.copy(dir);
      // origine en amont du point, au-delà de toute la scène, du côté de la caméra
      const b = this.sync.bounds;
      const back = b.radius * 2 + p.distanceTo(b.center) + 1;
      ray.origin.copy(p).addScaledVector(dir, -back);
      eps = Math.max(1e-4, back * 5e-4);
    } else {
      ray.origin.setFromMatrixPosition(cam.matrixWorld);
      ray.direction.subVectors(p, ray.origin).normalize();
      eps = Math.max(1e-4, p.distanceTo(ray.origin) * 2e-3);
    }
    const d = p.distanceTo(ray.origin);
    for (const n of this.solidNodes(env)) {
      if (skip?.(n.id)) continue;
      const h = this.raycastNode(n, ray);
      if (h && h.distance < d - eps) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ éléments (mode édition)

  /** Objet édité : maillage de base et matrice monde, ou null. */
  private editTarget(env: PickEnv): { node: ObjNode; mesh: MeshData; world: Matrix4 } | null {
    const st = env.state;
    if (!st.activeId) return null;
    const node = this.sync.nodes.get(st.activeId);
    if (!node || node.type !== 'mesh' || !node.obj.data) return null;
    const mesh = env.doc.getMesh(node.obj.data);
    if (!mesh) return null;
    return { node, mesh, world: node.root.matrix };
  }

  /** Géométrie du maillage de base (faces de la cage), conservée tant que le maillage ne change pas. */
  private cageEntry(mesh: MeshData, smooth: boolean, angle: number): GeoEntry {
    const c = this.cage;
    if (c && c.mesh === mesh && c.smooth === smooth && c.angle === angle) return c.entry;
    const rm = this.sync.evaluator.renderMeshOf(mesh, smooth, angle);
    const entry = this.sync.pool.acquire(rm);
    if (c) this.sync.pool.release(c.entry);
    this.cage = { mesh, smooth, angle, entry };
    return entry;
  }

  pickElement(env: PickEnv, x: number, y: number, mode: SelectMode): ElementHit | null {
    const t = this.editTarget(env);
    if (!t) return null;
    const { mesh, world, node } = t;
    const m = this.viewProj(env, world).elements;
    const pr: Projected = { x: 0, y: 0, w: 0 };
    const proj = makeProjector(m, env.width, env.height);
    const tmp = new Vector3();

    if (mode === 'vert') {
      const cands: { id: string; d: number; p: [number, number, number] }[] = [];
      for (const [id, p] of mesh.verts) {
        if (!proj(p[0], p[1], p[2], pr)) continue;
        const d = Math.hypot(pr.x - x, pr.y - y);
        if (d <= VERT_TOL) cands.push({ id, d, p });
      }
      const best = nearestVisible(cands, VERT_TOL, (c) => this.visibleAt(env, tmp.set(c.p[0], c.p[1], c.p[2]).applyMatrix4(world)));
      if (!best) return null;
      const wp = new Vector3(best.p[0], best.p[1], best.p[2]).applyMatrix4(world);
      return { type: 'vert', id: best.id, point: toVec3(wp) };
    }

    if (mode === 'edge') {
      const cands: { id: string; d: number; p: Vector3 }[] = [];
      for (const [k, [a, b]] of meshEdges(mesh)) {
        const pa = mesh.verts.get(a)!;
        const pb = mesh.verts.get(b)!;
        const s = projectSegment(m, env.width, env.height, pa, pb);
        if (!s) continue;
        const r = distToSegment2D(x, y, s[0], s[1], s[2], s[3]);
        if (r.d > EDGE_TOL) continue;
        const tt = s[4] + (s[5] - s[4]) * r.t;
        const p = new Vector3(pa[0] + (pb[0] - pa[0]) * tt, pa[1] + (pb[1] - pa[1]) * tt, pa[2] + (pb[2] - pa[2]) * tt).applyMatrix4(world);
        cands.push({ id: k, d: r.d, p });
      }
      const best = nearestVisible(cands, EDGE_TOL, (c) => this.visibleAt(env, c.p));
      return best ? { type: 'edge', id: best.id, point: toVec3(best.p) } : null;
    }

    // faces : rayon contre le maillage de base
    const ray = this.ray(env, x, y);
    const angle = Number.isFinite(node.obj.autoSmoothAngle) ? node.obj.autoSmoothAngle : 30;
    const entry = this.cageEntry(mesh, !!node.obj.shadeSmooth, angle);
    const h = this.raycastNode(node, ray, entry);
    if (!h) return null;
    const fid = entry.rm.triFace[h.tri];
    if (!fid) return null;
    if (!env.xray) {
      // masquée par un AUTRE objet ?
      const other = this.firstHit(env, ray, (id) => id === node.id);
      if (other && other.distance < h.distance - Math.max(1e-4, h.distance * 2e-3)) return null;
    }
    return { type: 'face', id: fid, point: toVec3(h.point) };
  }

  pickElementsInRect(env: PickEnv, r: Rect, mode: SelectMode): string[] {
    const t = this.editTarget(env);
    if (!t) return [];
    const { mesh, world } = t;
    const m = this.viewProj(env, world).elements;
    const pr: Projected = { x: 0, y: 0, w: 0 };
    const proj = makeProjector(m, env.width, env.height);
    const tmp = new Vector3();
    const visible = (p: ArrayLike<number>) => this.visibleAt(env, tmp.set(p[0], p[1], p[2]).applyMatrix4(world));

    if (mode === 'vert') {
      const out: string[] = [];
      for (const [id, p] of mesh.verts) {
        if (!proj(p[0], p[1], p[2], pr) || !pointInRect(pr.x, pr.y, r)) continue;
        if (visible(p)) out.push(id);
      }
      return out;
    }

    if (mode === 'edge') {
      const inside: string[] = [];
      const crossing: string[] = [];
      const pa: Projected = { x: 0, y: 0, w: 0 };
      const pb: Projected = { x: 0, y: 0, w: 0 };
      for (const [k, [a, b]] of meshEdges(mesh)) {
        const va = mesh.verts.get(a)!;
        const vb = mesh.verts.get(b)!;
        const okA = proj(va[0], va[1], va[2], pa);
        const okB = proj(vb[0], vb[1], vb[2], pb);
        const mid = [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2];
        const isVisible = () => visible(mid) || visible(va) || visible(vb);
        if (okA && okB && pointInRect(pa.x, pa.y, r) && pointInRect(pb.x, pb.y, r)) {
          if (isVisible()) inside.push(k);
          continue;
        }
        const s = projectSegment(m, env.width, env.height, va, vb);
        if (s && segmentIntersectsRect(s[0], s[1], s[2], s[3], r) && isVisible()) crossing.push(k);
      }
      // comme Blender : les arêtes entièrement contenues, sinon celles qui traversent le rectangle
      return inside.length ? inside : crossing;
    }

    const out: string[] = [];
    for (const [fid, loop] of mesh.faces) {
      const c = faceCentroid(mesh, loop);
      if (!c || !proj(c[0], c[1], c[2], pr) || !pointInRect(pr.x, pr.y, r)) continue;
      if (visible(c)) out.push(fid);
    }
    return out;
  }
}

/** Segments (6 flottants chacun) des 12 arêtes d'une boîte. */
function boxSegments(b: { min: Vector3; max: Vector3 }): number[] {
  const c = [
    [b.min.x, b.min.y, b.min.z],
    [b.max.x, b.min.y, b.min.z],
    [b.max.x, b.max.y, b.min.z],
    [b.min.x, b.max.y, b.min.z],
    [b.min.x, b.min.y, b.max.z],
    [b.max.x, b.min.y, b.max.z],
    [b.max.x, b.max.y, b.max.z],
    [b.min.x, b.max.y, b.max.z],
  ];
  const e = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
  const out: number[] = [];
  for (const i of e) out.push(c[i][0], c[i][1], c[i][2]);
  return out;
}
