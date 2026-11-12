import { BufferAttribute, BufferGeometry, Color, Group, LineSegments, Mesh, Points, type ShaderMaterial } from 'three';
import type { AppState, EditSelection, SelectMode } from '../app/store';
import type { SceneDoc } from '../core/doc/SceneDoc';
import type { MeshData } from '../core/doc/schema';
import { createPointsMaterial, createVertexColorFaceMaterial, createVertexColorLineMaterial, ORDER } from './overlayMaterials';
import { faceCentroid, meshEdges } from './picking';
import type { SceneSync } from './sceneSync';

/**
 * Cage du mode édition : sommets, arêtes et faces du maillage de BASE de
 * l'objet actif, dessinés par-dessus le résultat des modificateurs, avec la
 * sélection d'éléments en surbrillance (comme Blender).
 *  - sommets : affichés en mode sommet ;
 *  - arêtes : toujours ; en mode sommet, dégradé vers les sommets sélectionnés ;
 *  - faces sélectionnées : voile orange ; points de face en mode face + rayons X.
 */

const C_VERT = new Color('#000000');
const C_SEL = new Color('#ff8a00');
const C_EDGE = new Color('#000000');
const C_EDGE_SEL = new Color('#ffa020');
const FACE_ALPHA = 0.22;

/** Données de la cage (PUR, testable) : tableaux prêts pour BufferGeometry. */
export interface CageArrays {
  vertPos: Float32Array;
  vertCol: Float32Array;
  edgePos: Float32Array;
  edgeCol: Float32Array;
  facePos: Float32Array;
  faceCol: Float32Array;
  dotPos: Float32Array;
  dotCol: Float32Array;
}

export function buildCageArrays(
  mesh: MeshData,
  sel: EditSelection,
  mode: SelectMode,
  tris: { positions: Float32Array; triFace: string[] },
): CageArrays {
  const vertSel = (id: string) => sel.verts.has(id);
  const faceSel = (fid: string, loop: readonly string[]) => sel.faces.has(fid) || (mode === 'vert' && loop.length > 0 && loop.every(vertSel));

  // sommets
  const nv = mesh.verts.size;
  const vertPos = new Float32Array(nv * 3);
  const vertCol = new Float32Array(nv * 4);
  let i = 0;
  for (const [id, p] of mesh.verts) {
    vertPos.set(p, i * 3);
    const c = vertSel(id) ? C_SEL : C_VERT;
    vertCol.set([c.r, c.g, c.b, 1], i * 4);
    i++;
  }

  // arêtes sélectionnées via les faces sélectionnées (mode face)
  const edgesOfSelFaces = new Set<string>();
  if (mode === 'face') {
    for (const [fid, loop] of mesh.faces) {
      if (!sel.faces.has(fid)) continue;
      for (let k = 0; k < loop.length; k++) {
        const a = loop[k];
        const b = loop[(k + 1) % loop.length];
        edgesOfSelFaces.add(a < b ? `${a}|${b}` : `${b}|${a}`);
      }
    }
  }
  const edges = meshEdges(mesh);
  const edgePos = new Float32Array(edges.size * 6);
  const edgeCol = new Float32Array(edges.size * 8);
  i = 0;
  for (const [key, [a, b]] of edges) {
    edgePos.set(mesh.verts.get(a)!, i * 6);
    edgePos.set(mesh.verts.get(b)!, i * 6 + 3);
    let ca = C_EDGE;
    let cb = C_EDGE;
    if (sel.edges.has(key) || edgesOfSelFaces.has(key)) ca = cb = C_EDGE_SEL;
    else if (mode === 'vert') {
      if (vertSel(a)) ca = C_EDGE_SEL;
      if (vertSel(b)) cb = C_EDGE_SEL;
    }
    edgeCol.set([ca.r, ca.g, ca.b, 0.95, cb.r, cb.g, cb.b, 0.95], i * 8);
    i++;
  }

  // voile des faces sélectionnées
  const facePos = tris.positions;
  const ntri = tris.triFace.length;
  const faceCol = new Float32Array(ntri * 12);
  const selCache = new Map<string, boolean>();
  for (let t = 0; t < ntri; t++) {
    const fid = tris.triFace[t];
    let s = selCache.get(fid);
    if (s === undefined) {
      const loop = mesh.faces.get(fid);
      s = !!loop && faceSel(fid, loop);
      selCache.set(fid, s);
    }
    if (!s) continue;
    for (let k = 0; k < 3; k++) faceCol.set([C_SEL.r, C_SEL.g, C_SEL.b, FACE_ALPHA], t * 12 + k * 4);
  }

  // points de face
  const dots: number[] = [];
  const dotCols: number[] = [];
  if (mode === 'face') {
    for (const [fid, loop] of mesh.faces) {
      const c = faceCentroid(mesh, loop);
      if (!c) continue;
      dots.push(c[0], c[1], c[2]);
      const col = sel.faces.has(fid) ? C_SEL : C_VERT;
      dotCols.push(col.r, col.g, col.b, 1);
    }
  }
  return { vertPos, vertCol, edgePos, edgeCol, facePos, faceCol, dotPos: new Float32Array(dots), dotCol: new Float32Array(dotCols) };
}

/**
 * Correspondances d'indices d'une cage : ordre des sommets, arêtes (indices de sommets, même
 * ordre que `buildCageArrays`) et faces porteuses d'un point de face (mode face).
 */
interface CageLayout {
  vIds: string[];
  edgeA: Int32Array;
  edgeB: Int32Array;
  dotLoopStart: Int32Array;
  dotCorners: Int32Array;
}

function cageLayout(mesh: MeshData, mode: SelectMode): CageLayout {
  const vIds: string[] = [];
  const index = new Map<string, number>();
  for (const id of mesh.verts.keys()) {
    index.set(id, vIds.length);
    vIds.push(id);
  }
  const edges = meshEdges(mesh);
  const edgeA = new Int32Array(edges.size);
  const edgeB = new Int32Array(edges.size);
  let i = 0;
  for (const [a, b] of edges.values()) {
    edgeA[i] = index.get(a)!;
    edgeB[i] = index.get(b)!;
    i++;
  }
  const starts = [0];
  const corners: number[] = [];
  if (mode === 'face') {
    for (const loop of mesh.faces.values()) {
      if (!loop.every((v) => index.has(v))) continue; // même filtre que faceCentroid
      for (const v of loop) corners.push(index.get(v)!);
      starts.push(corners.length);
    }
  }
  return { vIds, edgeA, edgeB, dotLoopStart: Int32Array.from(starts), dotCorners: Int32Array.from(corners) };
}

function geom(pos: Float32Array, col: Float32Array): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('aColor', new BufferAttribute(col, 4));
  g.computeBoundingSphere();
  return g;
}

export class EditCage {
  readonly group = new Group();
  private vertMat: ShaderMaterial = createPointsMaterial(6, false);
  private dotMat: ShaderMaterial = createPointsMaterial(5, false);
  private lineMat: ShaderMaterial = createVertexColorLineMaterial();
  private faceMat: ShaderMaterial = createVertexColorFaceMaterial();
  private verts: Points;
  private edges: LineSegments;
  private faces: Mesh;
  private dots: Points;
  private key: { id: string; mesh: MeshData; sel: EditSelection; mode: SelectMode; xray: boolean } | null = null;

  constructor() {
    this.group.name = 'Cage du mode édition';
    this.group.matrixAutoUpdate = false;
    this.verts = new Points(new BufferGeometry(), this.vertMat);
    this.edges = new LineSegments(new BufferGeometry(), this.lineMat);
    this.faces = new Mesh(new BufferGeometry(), this.faceMat);
    this.dots = new Points(new BufferGeometry(), this.dotMat);
    this.verts.renderOrder = ORDER.cageVerts;
    this.dots.renderOrder = ORDER.cageVerts;
    this.edges.renderOrder = ORDER.cageEdges;
    this.faces.renderOrder = ORDER.faces;
    for (const o of [this.faces, this.edges, this.verts, this.dots]) {
      o.frustumCulled = false;
      this.group.add(o);
    }
    this.group.visible = false;
  }

  setPixelRatio(pr: number): void {
    this.vertMat.uniforms.uPixelRatio.value = pr;
    this.dotMat.uniforms.uPixelRatio.value = pr;
  }

  /** Met à jour la cage ; renvoie true si son contenu a changé. */
  update(doc: SceneDoc, st: AppState, sync: SceneSync, xray: boolean): boolean {
    const id = st.mode === 'edit' ? st.activeId : null;
    const node = id ? sync.nodes.get(id) : undefined;
    const mesh = node && node.type === 'mesh' && node.obj.data ? doc.getMesh(node.obj.data) : null;
    if (!id || !node || !mesh || !node.visible) {
      const changed = this.group.visible;
      this.group.visible = false;
      this.key = null;
      return changed;
    }
    this.group.matrix.copy(node.root.matrix);
    this.group.matrixWorld.copy(node.root.matrix);
    this.group.updateMatrixWorld(true);
    this.group.visible = true;
    const k = this.key;
    if (k && k.id === id && k.mesh === mesh && k.sel === st.editSelection && k.mode === st.selectMode && k.xray === xray) return false;
    const sameLayout =
      !!k && k.id === id && k.mesh.faces === mesh.faces && k.sel === st.editSelection && k.mode === st.selectMode && k.xray === xray;
    this.key = { id, mesh, sel: st.editSelection, mode: st.selectMode, xray };

    // Les positions des triangles ne dépendent pas de l'ombrage : on demande la même variante que
    // la surface affichée (sans modificateur, c'est le même maillage → résultat déjà en cache).
    const angle = Number.isFinite(node.obj.autoSmoothAngle) ? node.obj.autoSmoothAngle : 30;
    const tris = sync.evaluator.renderMeshOf(mesh, !!node.obj.shadeSmooth, angle);
    // Chemin rapide : même topologie, même sélection, même mode → seules les positions changent
    // (déplacement de sommets). Les couleurs et l'ordre des éléments sont conservés.
    if (sameLayout && this.updatePositions(mesh, tris.positions)) return true;

    const a = buildCageArrays(mesh, st.editSelection, st.selectMode, tris);
    this.replace(this.verts, geom(a.vertPos, a.vertCol));
    this.replace(this.edges, geom(a.edgePos, a.edgeCol));
    this.replace(this.faces, geom(a.facePos, a.faceCol));
    this.replace(this.dots, geom(a.dotPos, a.dotCol));
    this.layout = cageLayout(mesh, st.selectMode);
    this.verts.visible = st.selectMode === 'vert';
    this.dots.visible = st.selectMode === 'face' && xray;
    for (const m of [this.vertMat, this.dotMat, this.lineMat, this.faceMat]) m.depthTest = !xray;
    return true;
  }

  /** Correspondances d'indices de la dernière cage construite (pour le chemin rapide). */
  private layout: CageLayout | null = null;

  private updatePositions(mesh: MeshData, facePos: Float32Array): boolean {
    const L = this.layout;
    if (!L || mesh.verts.size !== L.vIds.length) return false;
    const vAttr = this.verts.geometry.getAttribute('position') as BufferAttribute | undefined;
    const eAttr = this.edges.geometry.getAttribute('position') as BufferAttribute | undefined;
    const fAttr = this.faces.geometry.getAttribute('position') as BufferAttribute | undefined;
    const dAttr = this.dots.geometry.getAttribute('position') as BufferAttribute | undefined;
    if (!vAttr || !eAttr || !fAttr || !dAttr) return false;
    if (vAttr.array.length !== L.vIds.length * 3 || eAttr.array.length !== L.edgeA.length * 6) return false;
    if (fAttr.array.length !== facePos.length || dAttr.array.length !== L.dotLoopStart.length * 3 - 3) return false;
    const P = vAttr.array as Float32Array;
    let i = 0;
    for (const [vid, p] of mesh.verts) {
      if (L.vIds[i] !== vid) return false;
      P[i * 3] = p[0];
      P[i * 3 + 1] = p[1];
      P[i * 3 + 2] = p[2];
      i++;
    }
    const E = eAttr.array as Float32Array;
    for (let e = 0; e < L.edgeA.length; e++) {
      const a = L.edgeA[e] * 3;
      const b = L.edgeB[e] * 3;
      const o = e * 6;
      E[o] = P[a];
      E[o + 1] = P[a + 1];
      E[o + 2] = P[a + 2];
      E[o + 3] = P[b];
      E[o + 4] = P[b + 1];
      E[o + 5] = P[b + 2];
    }
    (fAttr.array as Float32Array).set(facePos);
    const D = dAttr.array as Float32Array;
    const nd = L.dotLoopStart.length - 1;
    for (let d = 0; d < nd; d++) {
      const s = L.dotLoopStart[d];
      const e = L.dotLoopStart[d + 1];
      let x = 0;
      let y = 0;
      let z = 0;
      for (let c = s; c < e; c++) {
        const v = L.dotCorners[c] * 3;
        x += P[v];
        y += P[v + 1];
        z += P[v + 2];
      }
      const n = e - s || 1;
      D[d * 3] = x / n;
      D[d * 3 + 1] = y / n;
      D[d * 3 + 2] = z / n;
    }
    for (const attr of [vAttr, eAttr, fAttr, dAttr]) attr.needsUpdate = true;
    return true;
  }

  private replace(o: Points | LineSegments | Mesh, g: BufferGeometry): void {
    o.geometry.dispose();
    o.geometry = g;
  }

  dispose(): void {
    for (const o of [this.verts, this.edges, this.faces, this.dots]) o.geometry.dispose();
    for (const m of [this.vertMat, this.dotMat, this.lineMat, this.faceMat]) m.dispose();
    this.group.removeFromParent();
  }
}
