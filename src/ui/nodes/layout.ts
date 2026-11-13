import type { NodeData, NodeTreeData } from '../../core/doc/schema';
import { PRINCIPLED_PANELS } from '../../core/nodes/shaderNodes';
import { nodeType, visibleSockets, type NodePropDef, type NodeTreeKind, type SocketDef, type SocketType } from '../../core/nodes/types';

/**
 * Mise en page DÉTERMINISTE des nœuds : la position de chaque socket se calcule depuis les
 * données, sans mesurer le DOM. Le rendu (NodeView) et les interactions (liens, coupes, tests
 * de survol) utilisent la même géométrie, à toute échelle.
 */

export const HEADER_H = 26;
export const ROW_H = 22;
export const PANEL_H = 20;
export const PAD_B = 6;
export const RAMP_H = 64;
/** Éditeur de courbes (Courbes RVB / vectorielles / flottante). */
export const CURVE_H = 150;
/** Nœud Texture image : bouton Ouvrir, liste des images et vignette. */
export const IMAGE_H = 118;
export const REROUTE_R = 7;
export const DEFAULT_W = 150;
export const FRAME_PAD = 24;
export const FRAME_HEADER = 30;

export type RowKind = 'output' | 'prop' | 'input' | 'input-vector' | 'panel' | 'vector-component';

export interface LayoutRow {
  kind: RowKind;
  y: number;
  h: number;
  socket?: SocketDef;
  prop?: NodePropDef;
  panel?: string;
  open?: boolean;
  /** Composante (0, 1, 2) d'un vecteur déplié. */
  component?: number;
  linked?: boolean;
}

export interface SocketPos {
  x: number;
  y: number;
  type: SocketType;
  /** Socket replié dans un panneau fermé ou un nœud réduit : dessiné plus petit. */
  folded?: boolean;
}

export interface NodeLayout {
  w: number;
  h: number;
  rows: LayoutRow[];
  /** Positions RELATIVES au coin du nœud. Clé : `in:<id>` ou `out:<id>`. */
  sockets: Map<string, SocketPos>;
}

export const socketKey = (dir: 'in' | 'out', id: string) => `${dir}:${id}`;

/** Panneaux ouverts d'un nœud (propriété d'interface `_panels`, non utilisée par le calcul). */
export function openPanels(node: NodeData): Set<string> {
  const v = node.props?._panels;
  return new Set(Array.isArray(v) ? (v as string[]) : []);
}

const layoutCache = new WeakMap<NodeData, { linkedKey: string; layout: NodeLayout }>();

/** Géométrie d'un nœud ; `linked` : identifiants des entrées branchées (un vecteur branché se replie). */
export function nodeLayout(kind: NodeTreeKind, node: NodeData, linked: ReadonlySet<string>): NodeLayout {
  const linkedKey = [...linked].sort().join('|');
  const hit = layoutCache.get(node);
  if (hit && hit.linkedKey === linkedKey) return hit.layout;
  const layout = computeLayout(kind, node, linked);
  layoutCache.set(node, { linkedKey, layout });
  return layout;
}

function computeLayout(kind: NodeTreeKind, node: NodeData, linked: ReadonlySet<string>): NodeLayout {
  const def = nodeType(kind, node.type);
  const sockets = new Map<string, SocketPos>();
  if (def?.layout === 'reroute') {
    const s = REROUTE_R * 2;
    sockets.set(socketKey('in', 'Input'), { x: REROUTE_R, y: REROUTE_R, type: 'any' });
    sockets.set(socketKey('out', 'Output'), { x: REROUTE_R, y: REROUTE_R, type: 'any' });
    return { w: s, h: s, rows: [], sockets };
  }
  if (def?.layout === 'frame') {
    return { w: node.width ?? 300, h: node.height ?? 200, rows: [], sockets };
  }
  const w = node.width ?? def?.width ?? DEFAULT_W;
  const props = node.props ?? {};
  if (!def) {
    return { w, h: HEADER_H + PAD_B, rows: [], sockets };
  }
  const outs = visibleSockets(def.outputs, props);
  const ins = visibleSockets(def.inputs, props);

  if (node.collapsed) {
    const cy = HEADER_H / 2;
    outs.forEach((s) => sockets.set(socketKey('out', s.id), { x: w, y: cy, type: s.type, folded: true }));
    ins.forEach((s) => sockets.set(socketKey('in', s.id), { x: 0, y: cy, type: s.type, folded: true }));
    return { w, h: HEADER_H, rows: [], sockets };
  }

  const rows: LayoutRow[] = [];
  let y = HEADER_H;
  for (const s of outs) {
    rows.push({ kind: 'output', y, h: ROW_H, socket: s });
    sockets.set(socketKey('out', s.id), { x: w, y: y + ROW_H / 2, type: s.type });
    y += ROW_H;
  }
  for (const p of def.props ?? []) {
    if (p.visible && !p.visible(props)) continue;
    const h = p.kind === 'ramp' ? RAMP_H : p.kind === 'curve' ? CURVE_H : p.kind === 'image' ? IMAGE_H : ROW_H;
    rows.push({ kind: 'prop', y, h, prop: p });
    y += h;
  }
  const open = openPanels(node);
  const panelOrder = def.id === 'ShaderNodeBsdfPrincipled' ? PRINCIPLED_PANELS : [];
  const placeInput = (s: SocketDef) => {
    const isLinked = linked.has(s.id);
    if (s.type === 'vector' && !s.hideValue && !isLinked) {
      rows.push({ kind: 'input-vector', y, h: ROW_H, socket: s });
      sockets.set(socketKey('in', s.id), { x: 0, y: y + ROW_H / 2, type: s.type });
      y += ROW_H;
      for (let i = 0; i < 3; i++) {
        rows.push({ kind: 'vector-component', y, h: ROW_H, socket: s, component: i });
        y += ROW_H;
      }
      return;
    }
    rows.push({ kind: 'input', y, h: ROW_H, socket: s, linked: isLinked });
    sockets.set(socketKey('in', s.id), { x: 0, y: y + ROW_H / 2, type: s.type });
    y += ROW_H;
  };
  // Entrées hors panneau, puis chaque panneau.
  for (const s of ins) if (!s.panel) placeInput(s);
  const panels = [...new Set([...panelOrder, ...ins.filter((s) => s.panel).map((s) => s.panel!)])];
  for (const panel of panels) {
    const members = ins.filter((s) => s.panel === panel);
    if (members.length === 0) continue;
    const isOpen = open.has(panel);
    rows.push({ kind: 'panel', y, h: PANEL_H, panel, open: isOpen });
    const headerY = y + PANEL_H / 2;
    y += PANEL_H;
    if (isOpen) members.forEach(placeInput);
    else members.forEach((s) => sockets.set(socketKey('in', s.id), { x: 0, y: headerY, type: s.type, folded: true }));
  }
  return { w, h: y + PAD_B, rows, sockets };
}

/** Rectangle absolu d'un nœud (cadres : bornes de leurs enfants s'ils s'ajustent). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Ensemble des entrées branchées, par nœud. */
export function linkedInputs(tree: Pick<NodeTreeData, 'links'>): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const l of tree.links) {
    let s = m.get(l.toNode);
    if (!s) m.set(l.toNode, (s = new Set()));
    s.add(l.toSocket);
  }
  return m;
}

const EMPTY = new Set<string>();

/** Rectangles de tous les nœuds (cadres recalculés depuis leurs enfants s'ils s'ajustent). */
export function nodeRects(kind: NodeTreeKind, tree: Pick<NodeTreeData, 'nodes' | 'links'>, linked = linkedInputs(tree)): Map<string, Rect> {
  const rects = new Map<string, Rect>();
  const frames: NodeData[] = [];
  for (const n of Object.values(tree.nodes)) {
    const def = nodeType(kind, n.type);
    if (def?.layout === 'frame') {
      frames.push(n);
      continue;
    }
    const l = nodeLayout(kind, n, linked.get(n.id) ?? EMPTY);
    if (def?.layout === 'reroute') rects.set(n.id, { x: n.x - REROUTE_R, y: n.y - REROUTE_R, w: l.w, h: l.h });
    else rects.set(n.id, { x: n.x, y: n.y, w: l.w, h: l.h });
  }
  // Cadres imbriqués : les plus profonds d'abord.
  const depth = (f: NodeData) => {
    let d = 0;
    let p = f.parent ? tree.nodes[f.parent] : undefined;
    while (p && d < 32) {
      d++;
      p = p.parent ? tree.nodes[p.parent] : undefined;
    }
    return d;
  };
  frames.sort((a, b) => depth(b) - depth(a));
  for (const f of frames) {
    const shrink = f.props?.shrink !== false;
    const children = Object.values(tree.nodes).filter((n) => n.parent === f.id);
    if (shrink && children.length > 0) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const c of children) {
        const r = rects.get(c.id);
        if (!r) continue;
        x0 = Math.min(x0, r.x);
        y0 = Math.min(y0, r.y);
        x1 = Math.max(x1, r.x + r.w);
        y1 = Math.max(y1, r.y + r.h);
      }
      if (Number.isFinite(x0)) {
        rects.set(f.id, { x: x0 - FRAME_PAD, y: y0 - FRAME_HEADER, w: x1 - x0 + FRAME_PAD * 2, h: y1 - y0 + FRAME_HEADER + FRAME_PAD });
        continue;
      }
    }
    rects.set(f.id, { x: f.x, y: f.y, w: f.width ?? 300, h: f.height ?? 200 });
  }
  return rects;
}

/** Position ABSOLUE d'un socket, null s'il n'est pas affiché. */
export function socketPosition(kind: NodeTreeKind, node: NodeData, dir: 'in' | 'out', id: string, linked: ReadonlySet<string>): SocketPos | null {
  const l = nodeLayout(kind, node, linked);
  const s = l.sockets.get(socketKey(dir, id));
  if (!s) return null;
  const def = nodeType(kind, node.type);
  const ox = def?.layout === 'reroute' ? node.x - REROUTE_R : node.x;
  const oy = def?.layout === 'reroute' ? node.y - REROUTE_R : node.y;
  return { ...s, x: ox + s.x, y: oy + s.y };
}

export const SOCKET_COLORS: Record<SocketType, string> = {
  float: '#a1a1a1',
  int: '#598c5c',
  bool: '#cca6d6',
  vector: '#6363c7',
  color: '#c7c729',
  shader: '#63c763',
  geometry: '#00d6a3',
  string: '#70b2ff',
  object: '#ed9e5c',
  material: '#eb7582',
  any: '#cccccc',
};

/** Courbe de Bézier d'un lien (chemin SVG). */
export function linkPath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(30, Math.abs(x2 - x1) * 0.5);
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}

/** Points d'un lien échantillonné (coupe de liens, insertion d'un nœud sur un lien). */
export function linkPoints(x1: number, y1: number, x2: number, y2: number, steps = 24): [number, number][] {
  const dx = Math.max(30, Math.abs(x2 - x1) * 0.5);
  const c1x = x1 + dx;
  const c2x = x2 - dx;
  const pts: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    pts.push([u * u * u * x1 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x2, u * u * u * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y2]);
  }
  return pts;
}

/** Les segments [a, b] et [c, d] se coupent-ils ? */
export function segmentsIntersect(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): [number, number] | null {
  const r = [b[0] - a[0], b[1] - a[1]];
  const s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [a[0] + t * r[0], a[1] + t * r[1]];
}
