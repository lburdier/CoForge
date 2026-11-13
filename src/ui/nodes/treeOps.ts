import type { NodeData, NodeLink, NodeTreeData } from '../../core/doc/schema';
import { newId as nodeId, sanitizeTree } from '../../core/nodes/graph';
import { nodeDefaults, nodeType, socketsCompatible, visibleSockets, type NodeTreeKind, type NodeTypeDef, type SocketDef, type SocketType } from '../../core/nodes/types';
import { nodeRects } from './layout';

/**
 * Opérations PURES sur un arbre de nœuds (aucun accès au document, aucune interface) : l'éditeur
 * les applique à une copie, puis écrit le résultat en UNE étape d'annulation. Elles couvrent
 * l'édition de base de Blender et les outils de l'extension Node Wrangler.
 */

export type Tree = Pick<NodeTreeData, 'nodes' | 'links'>;

/**
 * Copie de travail d'un arbre lu dans le document, NETTOYÉE (src/core/nodes/graph.ts) : il peut
 * venir d'un autre client et être mal formé (nœud sans type, lien orphelin, entrée doublement liée).
 */
export function cloneTree(t: Tree): Tree {
  return sanitizeTree(t);
}

export function defOf(kind: NodeTreeKind, n: NodeData | undefined): NodeTypeDef | null {
  return n ? nodeType(kind, n.type) : null;
}

export function outputsOf(kind: NodeTreeKind, n: NodeData): SocketDef[] {
  const d = defOf(kind, n);
  return d ? visibleSockets(d.outputs, n.props ?? {}) : [];
}

export function inputsOf(kind: NodeTreeKind, n: NodeData): SocketDef[] {
  const d = defOf(kind, n);
  return d ? visibleSockets(d.inputs, n.props ?? {}) : [];
}

export function socketType(kind: NodeTreeKind, n: NodeData, dir: 'in' | 'out', id: string): SocketType | null {
  const d = defOf(kind, n);
  const s = (dir === 'in' ? d?.inputs : d?.outputs)?.find((x) => x.id === id);
  return s?.type ?? null;
}

/** Nouveau nœud avec les valeurs par défaut de son type. */
export function createNode(kind: NodeTreeKind, type: string, x: number, y: number): NodeData {
  const def = nodeType(kind, type);
  const d = def ? nodeDefaults(def) : { inputs: {}, props: {} };
  const node: NodeData = { id: nodeId(), type, x: Math.round(x), y: Math.round(y), inputs: d.inputs, props: d.props };
  if (def?.layout === 'frame') {
    node.width = 300;
    node.height = 200;
    node.label = 'Cadre';
  }
  return node;
}

// ------------------------------------------------------------------ parcours

/** Nœuds en amont (qui alimentent) de `ids`, ids compris. */
export function upstream(t: Tree, ids: Iterable<string>): Set<string> {
  const seen = new Set<string>(ids);
  const stack = [...seen];
  while (stack.length) {
    const id = stack.pop()!;
    for (const l of t.links) if (l.toNode === id && !seen.has(l.fromNode)) seen.add(l.fromNode), stack.push(l.fromNode);
  }
  return seen;
}

/** Nœuds en aval (alimentés par) de `ids`, ids compris. */
export function downstream(t: Tree, ids: Iterable<string>): Set<string> {
  const seen = new Set<string>(ids);
  const stack = [...seen];
  while (stack.length) {
    const id = stack.pop()!;
    for (const l of t.links) if (l.fromNode === id && !seen.has(l.toNode)) seen.add(l.toNode), stack.push(l.toNode);
  }
  return seen;
}

/** Un lien from → to fermerait-il une boucle ? */
export function wouldCycle(t: Tree, from: string, to: string): boolean {
  return from === to || downstream(t, [to]).has(from);
}

// ------------------------------------------------------------------ liens

/**
 * Relie une sortie à une entrée. Une entrée n'a qu'un lien : l'ancien est remplacé. Refusé
 * (false) si les types sont incompatibles ou si le lien fermerait une boucle.
 */
export function connect(kind: NodeTreeKind, t: Tree, from: string, fromSocket: string, to: string, toSocket: string): boolean {
  const a = t.nodes[from];
  const b = t.nodes[to];
  if (!a || !b) return false;
  const ta = socketType(kind, a, 'out', fromSocket);
  const tb = socketType(kind, b, 'in', toSocket);
  if (!ta || !tb || !socketsCompatible(ta, tb)) return false;
  if (wouldCycle(t, from, to)) return false;
  t.links = t.links.filter((l) => !(l.toNode === to && l.toSocket === toSocket));
  t.links.push({ id: nodeId('l'), fromNode: from, fromSocket, toNode: to, toSocket });
  return true;
}

export function disconnectInput(t: Tree, node: string, socket: string): NodeLink | null {
  const l = t.links.find((x) => x.toNode === node && x.toSocket === socket) ?? null;
  if (l) t.links = t.links.filter((x) => x !== l);
  return l;
}

export function removeLinks(t: Tree, ids: Iterable<string>): void {
  const set = new Set(ids);
  t.links = t.links.filter((l) => !set.has(l.id));
}

/** Première entrée libre (et compatible avec `type`) d'un nœud, en préférant le même type. */
export function firstFreeInput(kind: NodeTreeKind, t: Tree, n: NodeData, type: SocketType | null): SocketDef | null {
  const ins = inputsOf(kind, n);
  const linked = new Set(t.links.filter((l) => l.toNode === n.id).map((l) => l.toSocket));
  const free = ins.filter((s) => !linked.has(s.id));
  if (!type) return free[0] ?? null;
  return free.find((s) => s.type === type) ?? free.find((s) => socketsCompatible(type, s.type)) ?? null;
}

// ------------------------------------------------------------------ nœuds

export function addNode(t: Tree, n: NodeData): void {
  t.nodes[n.id] = n;
}

/** Supprime des nœuds et leurs liens ; les enfants d'un cadre supprimé sont libérés. */
export function removeNodes(t: Tree, ids: Iterable<string>): void {
  const set = new Set(ids);
  for (const id of set) delete t.nodes[id];
  for (const n of Object.values(t.nodes)) if (n.parent && set.has(n.parent)) n.parent = null;
  t.links = t.links.filter((l) => !set.has(l.fromNode) && !set.has(l.toNode));
}

/** Supprime en reconnectant (Ctrl+X) : chaque sortie reprend la source de la première entrée compatible. */
export function dissolveNodes(kind: NodeTreeKind, t: Tree, ids: Iterable<string>): void {
  const set = new Set(ids);
  const bridges: { from: string; fromSocket: string; to: string; toSocket: string }[] = [];
  const sourceOf = (nodeId2: string, type: SocketType, depth = 0): NodeLink | null => {
    const n = t.nodes[nodeId2];
    if (!n || depth > 64) return null;
    for (const s of inputsOf(kind, n)) {
      if (!socketsCompatible(s.type, type) && s.type !== 'any') continue;
      const l = t.links.find((x) => x.toNode === nodeId2 && x.toSocket === s.id);
      if (!l) continue;
      if (set.has(l.fromNode)) {
        const deeper = sourceOf(l.fromNode, type, depth + 1);
        if (deeper) return deeper;
        continue;
      }
      return l;
    }
    return null;
  };
  for (const l of t.links) {
    if (!set.has(l.fromNode) || set.has(l.toNode)) continue;
    const type = socketType(kind, t.nodes[l.fromNode], 'out', l.fromSocket) ?? 'any';
    const src = sourceOf(l.fromNode, type);
    if (src) bridges.push({ from: src.fromNode, fromSocket: src.fromSocket, to: l.toNode, toSocket: l.toSocket });
  }
  removeNodes(t, set);
  for (const b of bridges) connect(kind, t, b.from, b.fromSocket, b.to, b.toSocket);
}

/** Duplique des nœuds (et les liens entre eux) ; renvoie les nouveaux identifiants, dans l'ordre. */
export function duplicateNodes(t: Tree, ids: Iterable<string>, dx = 30, dy = 30): string[] {
  const map = new Map<string, string>();
  const list = [...ids].filter((id) => t.nodes[id]);
  for (const id of list) {
    const copy = structuredClone(t.nodes[id]);
    copy.id = nodeId();
    copy.x += dx;
    copy.y += dy;
    map.set(id, copy.id);
    t.nodes[copy.id] = copy;
  }
  for (const id of list) {
    const copy = t.nodes[map.get(id)!];
    copy.parent = copy.parent && map.has(copy.parent) ? map.get(copy.parent)! : (copy.parent ?? null);
  }
  for (const l of [...t.links]) {
    if (map.has(l.fromNode) && map.has(l.toNode)) t.links.push({ ...l, id: nodeId('l'), fromNode: map.get(l.fromNode)!, toNode: map.get(l.toNode)! });
  }
  return list.map((id) => map.get(id)!);
}

/** Copie de nœuds pour le presse-papiers (liens internes compris). */
export function extractNodes(t: Tree, ids: Iterable<string>): Tree {
  const set = new Set(ids);
  const nodes: Record<string, NodeData> = {};
  for (const id of set) if (t.nodes[id]) nodes[id] = structuredClone(t.nodes[id]);
  for (const n of Object.values(nodes)) if (n.parent && !set.has(n.parent)) n.parent = null;
  return { nodes, links: t.links.filter((l) => set.has(l.fromNode) && set.has(l.toNode)).map((l) => ({ ...l })) };
}

/** Colle un presse-papiers centré sur (x, y) ; renvoie les nouveaux identifiants. */
export function pasteNodes(t: Tree, clip: Tree, x: number, y: number): string[] {
  const list = Object.values(clip.nodes);
  if (list.length === 0) return [];
  const cx = list.reduce((s, n) => s + n.x, 0) / list.length;
  const cy = list.reduce((s, n) => s + n.y, 0) / list.length;
  const tmp: Tree = { nodes: { ...t.nodes, ...structuredClone(clip.nodes) }, links: [...t.links, ...clip.links.map((l) => ({ ...l }))] };
  const ids = duplicateNodes(tmp, list.map((n) => n.id), x - cx, y - cy);
  const fresh = new Set(ids);
  for (const id of ids) t.nodes[id] = tmp.nodes[id];
  t.links.push(...tmp.links.filter((l) => fresh.has(l.fromNode) && fresh.has(l.toNode)));
  return ids;
}

// ------------------------------------------------------------------ cadres

/** Ctrl+J : met les nœuds dans un nouveau cadre. */
export function makeFrame(kind: NodeTreeKind, t: Tree, ids: Iterable<string>): string | null {
  const list = [...ids].filter((id) => t.nodes[id]);
  if (list.length === 0) return null;
  const rects = nodeRects(kind, t);
  const frame = createNode(kind, 'NodeFrame', 0, 0);
  let x0 = Infinity;
  let y0 = Infinity;
  for (const id of list) {
    const r = rects.get(id);
    if (r) (x0 = Math.min(x0, r.x)), (y0 = Math.min(y0, r.y));
  }
  frame.x = Number.isFinite(x0) ? x0 - 30 : 0;
  frame.y = Number.isFinite(y0) ? y0 - 40 : 0;
  // Le nouveau cadre prend la place du parent commun éventuel.
  const parents = new Set(list.map((id) => t.nodes[id].parent ?? null));
  frame.parent = parents.size === 1 ? [...parents][0] : null;
  t.nodes[frame.id] = frame;
  for (const id of list) t.nodes[id].parent = frame.id;
  return frame.id;
}

/** Alt+P : retire les nœuds de leur cadre. */
export function unparent(t: Tree, ids: Iterable<string>): void {
  for (const id of ids) {
    const n = t.nodes[id];
    if (n?.parent) n.parent = t.nodes[n.parent]?.parent ?? null;
  }
}

/** Nœuds déplacés avec la sélection (enfants des cadres sélectionnés compris). */
export function withFrameChildren(t: Tree, ids: Iterable<string>): Set<string> {
  const out = new Set(ids);
  let grew = true;
  for (let guard = 0; grew && guard < 32; guard++) {
    grew = false;
    for (const n of Object.values(t.nodes)) if (n.parent && out.has(n.parent) && !out.has(n.id)) out.add(n.id), (grew = true);
  }
  return out;
}

// ------------------------------------------------------------------ outils de liaison

/** F : relie les nœuds sélectionnés deux à deux, de gauche à droite. */
export function makeLinks(kind: NodeTreeKind, t: Tree, ids: Iterable<string>): number {
  const list = [...ids].map((id) => t.nodes[id]).filter((n): n is NodeData => !!n && !defOf(kind, n)?.layout).sort((a, b) => a.x - b.x);
  let made = 0;
  for (let i = 0; i + 1 < list.length; i++) {
    const [a, b] = [list[i], list[i + 1]];
    for (const o of outputsOf(kind, a)) {
      const inp = firstFreeInput(kind, t, b, o.type);
      if (inp && connect(kind, t, a.id, o.id, b.id, inp.id)) {
        made++;
        break;
      }
    }
  }
  return made;
}

/** Paires (sortie de A → entrée de B) possibles, la plus naturelle d'abord (connexion paresseuse). */
export function lazyPairs(kind: NodeTreeKind, t: Tree, from: string, to: string): { out: SocketDef; inp: SocketDef }[] {
  const a = t.nodes[from];
  const b = t.nodes[to];
  if (!a || !b || from === to || wouldCycle(t, from, to)) return [];
  const linked = new Set(t.links.filter((l) => l.toNode === to).map((l) => l.toSocket));
  const pairs: { out: SocketDef; inp: SocketDef; score: number }[] = [];
  outputsOf(kind, a).forEach((o, oi) =>
    inputsOf(kind, b).forEach((i, ii) => {
      if (!socketsCompatible(o.type, i.type)) return;
      const score = (o.type === i.type ? 0 : 100) + (linked.has(i.id) ? 50 : 0) + oi * 10 + ii;
      pairs.push({ out: o, inp: i, score });
    }),
  );
  return pairs.sort((x, y) => x.score - y.score).map(({ out, inp }) => ({ out, inp }));
}

/** Alt+clic droit glissé (Node Wrangler) : relie A à B au mieux. */
export function lazyConnect(kind: NodeTreeKind, t: Tree, from: string, to: string): boolean {
  const best = lazyPairs(kind, t, from, to)[0];
  return !!best && connect(kind, t, from, best.out.id, to, best.inp.id);
}

/** K / Maj+K (Node Wrangler) : relie la sortie du nœud actif aux sélectionnés, par nom ou par type. */
export function linkActiveToSelected(kind: NodeTreeKind, t: Tree, active: string, ids: Iterable<string>, byName: boolean): number {
  const a = t.nodes[active];
  if (!a) return 0;
  const outs = outputsOf(kind, a);
  let made = 0;
  for (const id of ids) {
    if (id === active || !t.nodes[id]) continue;
    const b = t.nodes[id];
    let done = false;
    for (const o of outs) {
      const inp = byName ? inputsOf(kind, b).find((i) => i.id === o.id || i.label === o.label) : firstFreeInput(kind, t, b, o.type);
      if (inp && connect(kind, t, active, o.id, id, inp.id)) {
        made++;
        done = true;
        break;
      }
    }
    if (!done && byName && outs[0]) {
      const inp = firstFreeInput(kind, t, b, outs[0].type);
      if (inp && connect(kind, t, active, outs[0].id, id, inp.id)) made++;
    }
  }
  return made;
}

/** Alt+S (Node Wrangler) : échange les liens de deux entrées d'un nœud, ou les sorties de deux nœuds. */
export function swapLinks(kind: NodeTreeKind, t: Tree, ids: string[]): boolean {
  if (ids.length === 1) {
    const n = t.nodes[ids[0]];
    if (!n) return false;
    const ins = inputsOf(kind, n);
    const linked = ins.map((s) => t.links.find((l) => l.toNode === n.id && l.toSocket === s.id)).filter((l): l is NodeLink => !!l);
    if (linked.length === 2) {
      const [a, b] = linked;
      [a.toSocket, b.toSocket] = [b.toSocket, a.toSocket];
      return true;
    }
    if (linked.length === 1) {
      // Un seul lien : il passe sur l'entrée suivante de même type (A ↔ B d'un Mélanger…).
      const l = linked[0];
      const type = ins.find((s) => s.id === l.toSocket)?.type;
      const other = ins.find((s) => s.id !== l.toSocket && s.type === type);
      if (other) {
        l.toSocket = other.id;
        return true;
      }
    }
    return false;
  }
  if (ids.length === 2) {
    const [a, b] = ids;
    let changed = false;
    for (const l of t.links) {
      if (l.fromNode === a && !wouldCycle({ ...t, links: t.links.filter((x) => x !== l) }, b, l.toNode)) (l.fromNode = b), (changed = true);
      else if (l.fromNode === b && !wouldCycle({ ...t, links: t.links.filter((x) => x !== l) }, a, l.toNode)) (l.fromNode = a), (changed = true);
    }
    return changed;
  }
  return false;
}

// ------------------------------------------------------------------ Node Wrangler

const PREVIEW_LABEL = 'Aperçu (Node Wrangler)';

/** Nœud de sortie actif d'un arbre de shader. */
export function outputNode(t: Tree): NodeData | null {
  return Object.values(t.nodes).find((n) => n.type === 'ShaderNodeOutputMaterial' && !n.muted) ?? Object.values(t.nodes).find((n) => n.type === 'ShaderNodeOutputMaterial') ?? null;
}

/**
 * Ctrl+Maj+clic (Node Wrangler) : affiche une sortie du nœud dans la sortie du matériau. Une
 * valeur passe par un nœud Émission « Aperçu » ; un nouveau clic passe à la sortie suivante.
 * Renvoie la sortie affichée, ou null.
 */
export function previewNode(kind: NodeTreeKind, t: Tree, id: string, cycle: number): string | null {
  const n = t.nodes[id];
  const out = outputNode(t);
  if (!n || !out || n.id === out.id) return null;
  const outs = outputsOf(kind, n);
  if (outs.length === 0) return null;
  const sock = outs[((cycle % outs.length) + outs.length) % outs.length];
  if (sock.type === 'shader') {
    connect(kind, t, id, sock.id, out.id, 'Surface');
    return sock.id;
  }
  let viewer = Object.values(t.nodes).find((x) => x.type === 'ShaderNodeEmission' && x.label === PREVIEW_LABEL);
  if (!viewer) {
    viewer = createNode(kind, 'ShaderNodeEmission', out.x, out.y - 140);
    viewer.label = PREVIEW_LABEL;
    viewer.color = '#5a3d1a';
    t.nodes[viewer.id] = viewer;
  }
  if (wouldCycle(t, id, viewer.id)) return null;
  connect(kind, t, id, sock.id, viewer.id, 'Color');
  connect(kind, t, viewer.id, 'Emission', out.id, 'Surface');
  return sock.id;
}

/** Retire l'aperçu Node Wrangler (nœud Émission « Aperçu »). */
export function clearPreview(t: Tree): boolean {
  const viewer = Object.values(t.nodes).find((x) => x.type === 'ShaderNodeEmission' && x.label === PREVIEW_LABEL);
  if (!viewer) return false;
  removeNodes(t, [viewer.id]);
  return true;
}

/** Nœud de texture : catégorie « Texture » du catalogue, avec une entrée Vecteur. */
const isTexture = (kind: NodeTreeKind, n: NodeData) => nodeType(kind, n.type)?.category === 'Texture' && inputsOf(kind, n).some((s) => s.id === 'Vector');

/**
 * Ctrl+T (Node Wrangler) : coordonnées de texture + mappage devant chaque texture sélectionnée.
 * Sur un shader : une texture de bruit est ajoutée sur sa couleur (comme Node Wrangler, qui y
 * ajoute une texture image vide : CoForge préfère une texture qui produit déjà un résultat).
 */
export function textureSetup(kind: NodeTreeKind, t: Tree, ids: Iterable<string>): string[] {
  const created: string[] = [];
  for (const id of ids) {
    let tex = t.nodes[id];
    if (!tex) continue;
    if (!isTexture(kind, tex)) {
      const colorIn = inputsOf(kind, tex).find((s) => s.type === 'color');
      if (!colorIn || tex.type.startsWith('ShaderNodeOutput')) continue;
      const noise = createNode(kind, 'ShaderNodeTexNoise', tex.x - 220, tex.y);
      t.nodes[noise.id] = noise;
      connect(kind, t, noise.id, 'Color', tex.id, colorIn.id);
      created.push(noise.id);
      tex = noise;
    }
    if (t.links.some((l) => l.toNode === tex.id && l.toSocket === 'Vector')) continue;
    const mapping = createNode(kind, 'ShaderNodeMapping', tex.x - 200, tex.y);
    const coord = createNode(kind, 'ShaderNodeTexCoord', mapping.x - 180, tex.y);
    t.nodes[mapping.id] = mapping;
    t.nodes[coord.id] = coord;
    connect(kind, t, coord.id, 'Generated', mapping.id, 'Vector');
    connect(kind, t, mapping.id, 'Vector', tex.id, 'Vector');
    created.push(mapping.id, coord.id);
  }
  return created;
}

/** Alt+X (Node Wrangler) : supprime les nœuds qui n'alimentent pas la sortie. Renvoie leur nombre. */
export function deleteUnused(kind: NodeTreeKind, t: Tree): number {
  const outs = Object.values(t.nodes).filter((n) => n.type.startsWith('ShaderNodeOutput') || n.type.startsWith('GeometryNodeGroupOutput'));
  const used = upstream(t, outs.map((n) => n.id));
  const doomed = Object.values(t.nodes).filter((n) => !used.has(n.id) && defOf(kind, n)?.layout !== 'frame');
  removeNodes(t, doomed.map((n) => n.id));
  // Cadres devenus vides.
  const emptyFrames = Object.values(t.nodes).filter((n) => defOf(kind, n)?.layout === 'frame' && !Object.values(t.nodes).some((c) => c.parent === n.id));
  removeNodes(t, emptyFrames.map((n) => n.id));
  return doomed.length + emptyFrames.length;
}

export type MergeMode = 'MIX' | 'ADD' | 'SUBTRACT' | 'MULTIPLY' | 'DIVIDE' | 'LESS_THAN' | 'GREATER_THAN';

/**
 * Ctrl+0 / Ctrl++ / Ctrl+− / Ctrl+* / Ctrl+/ (Node Wrangler) : fusionne les sorties des nœuds
 * sélectionnés deux à deux (Mélanger les shaders, Mélanger la couleur ou Calcul selon le type).
 */
export function mergeNodes(kind: NodeTreeKind, t: Tree, ids: Iterable<string>, mode: MergeMode): string | null {
  const list = [...ids].map((id) => t.nodes[id]).filter((n): n is NodeData => !!n && outputsOf(kind, n).length > 0 && !n.type.startsWith('ShaderNodeOutput'));
  if (list.length < 2) return null;
  list.sort((a, b) => a.y - b.y);
  const first = outputsOf(kind, list[0])[0];
  const isShader = first.type === 'shader';
  const isColor = first.type === 'color' || first.type === 'vector';
  let prev: { node: string; socket: string } = { node: list[0].id, socket: first.id };
  let lastId: string | null = null;
  const maxX = Math.max(...list.map((n) => n.x));
  for (let i = 1; i < list.length; i++) {
    const n = list[i];
    const o = outputsOf(kind, n).find((s) => (isShader ? s.type === 'shader' : s.type !== 'shader')) ?? outputsOf(kind, n)[0];
    const y = (t.nodes[prev.node].y + n.y) / 2;
    let m: NodeData;
    let a: string;
    let b: string;
    let res: string;
    if (isShader) {
      m = createNode(kind, mode === 'ADD' ? 'ShaderNodeAddShader' : 'ShaderNodeMixShader', maxX + 220 + i * 40, y);
      a = 'Shader';
      b = 'Shader_001';
      res = 'Shader';
    } else if (isColor) {
      m = createNode(kind, 'ShaderNodeMix', maxX + 220 + i * 40, y);
      m.props.data_type = 'RGBA';
      m.props.blend_type = mode === 'LESS_THAN' ? 'DARKEN' : mode === 'GREATER_THAN' ? 'LIGHTEN' : mode === 'DIVIDE' ? 'DIVIDE' : mode;
      if (mode !== 'MIX') m.inputs.Factor_Float = 1;
      a = 'A_Color';
      b = 'B_Color';
      res = 'Result_Color';
    } else {
      m = createNode(kind, 'ShaderNodeMath', maxX + 220 + i * 40, y);
      m.props.operation = mode === 'MIX' ? 'ADD' : mode;
      a = 'Value';
      b = 'Value_001';
      res = 'Value';
    }
    t.nodes[m.id] = m;
    connect(kind, t, prev.node, prev.socket, m.id, a);
    connect(kind, t, n.id, o.id, m.id, b);
    prev = { node: m.id, socket: res };
    lastId = m.id;
  }
  return lastId;
}

/** Retour arrière (Node Wrangler) : valeurs et propriétés par défaut, liens conservés. */
export function resetNodes(kind: NodeTreeKind, t: Tree, ids: Iterable<string>): void {
  for (const id of ids) {
    const n = t.nodes[id];
    const def = defOf(kind, n);
    if (!n || !def || def.layout) continue;
    const d = nodeDefaults(def);
    n.inputs = d.inputs;
    n.props = { ...d.props, ...(n.props?._panels ? { _panels: n.props._panels } : {}) };
  }
}

/** Maj+C (Node Wrangler) : copie les réglages du nœud actif sur les sélectionnés du même type. */
export function copySettings(t: Tree, active: string, ids: Iterable<string>): number {
  const a = t.nodes[active];
  if (!a) return 0;
  let n = 0;
  for (const id of ids) {
    const b = t.nodes[id];
    if (!b || id === active || b.type !== a.type) continue;
    b.inputs = structuredClone(a.inputs);
    b.props = structuredClone(a.props);
    n++;
  }
  return n;
}

/** Maj+S (Node Wrangler) : change le type des nœuds en gardant les liens et valeurs de même nom. */
export function switchType(kind: NodeTreeKind, t: Tree, ids: Iterable<string>, type: string): number {
  let n = 0;
  for (const id of ids) {
    const old = t.nodes[id];
    if (!old || old.type === type || defOf(kind, old)?.layout) continue;
    const fresh = createNode(kind, type, old.x, old.y);
    fresh.id = old.id;
    fresh.parent = old.parent ?? null;
    fresh.label = old.label;
    fresh.color = old.color;
    const def = nodeType(kind, type)!;
    const oldDef = defOf(kind, old);
    const byLabel = (list: SocketDef[] | undefined, sid: string) => list?.find((s) => s.id === sid)?.label;
    for (const s of def.inputs) {
      if (s.id in (old.inputs ?? {}) && typeof old.inputs[s.id] === typeof s.default) fresh.inputs[s.id] = old.inputs[s.id];
    }
    t.nodes[id] = fresh;
    // Liens : même identifiant, sinon même libellé, sinon premier socket compatible.
    const remap = (dir: 'in' | 'out', sid: string, type2: SocketType | null): string | null => {
      const list = dir === 'in' ? def.inputs : def.outputs;
      if (list.some((s) => s.id === sid)) return sid;
      const label = byLabel(dir === 'in' ? oldDef?.inputs : oldDef?.outputs, sid);
      const same = list.find((s) => s.label === label);
      if (same) return same.id;
      return list.find((s) => type2 && socketsCompatible(type2, s.type))?.id ?? null;
    };
    for (const l of [...t.links]) {
      if (l.toNode === id) {
        const nid = remap('in', l.toSocket, socketType(kind, t.nodes[l.fromNode], 'out', l.fromSocket));
        if (nid) l.toSocket = nid;
        else t.links = t.links.filter((x) => x !== l);
      } else if (l.fromNode === id) {
        const nid = remap('out', l.fromSocket, socketType(kind, t.nodes[l.toNode], 'in', l.toSocket));
        if (nid) l.fromSocket = nid;
        else t.links = t.links.filter((x) => x !== l);
      }
    }
    // Un même socket ne garde qu'un lien entrant.
    const seen = new Set<string>();
    t.links = t.links.filter((l) => {
      const k = `${l.toNode}\u0000${l.toSocket}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    n++;
  }
  return n;
}

/** / (Node Wrangler) : intercale une redirection sur chaque sortie reliée des nœuds sélectionnés. */
export function addReroutes(kind: NodeTreeKind, t: Tree, ids: Iterable<string>): number {
  let made = 0;
  const rects = nodeRects(kind, t);
  for (const id of ids) {
    const n = t.nodes[id];
    if (!n || defOf(kind, n)?.layout) continue;
    const r = rects.get(id);
    const outs = outputsOf(kind, n);
    outs.forEach((o, i) => {
      const links = t.links.filter((l) => l.fromNode === id && l.fromSocket === o.id);
      if (links.length === 0) return;
      const rr = createNode(kind, 'NodeReroute', (r ? r.x + r.w : n.x) + 40, (r ? r.y : n.y) + 38 + i * 22);
      rr.parent = n.parent ?? null;
      t.nodes[rr.id] = rr;
      for (const l of links) {
        l.fromNode = rr.id;
        l.fromSocket = 'Output';
      }
      t.links.push({ id: nodeId('l'), fromNode: id, fromSocket: o.id, toNode: rr.id, toSocket: 'Input' });
      made++;
    });
  }
  return made;
}

/** Maj+= (Node Wrangler, aligner) : aligne les nœuds sur une ligne (ou une colonne si plus hauts que larges). */
export function alignNodes(kind: NodeTreeKind, t: Tree, ids: Iterable<string>): void {
  const list = [...ids].map((id) => t.nodes[id]).filter((n): n is NodeData => !!n && defOf(kind, n)?.layout !== 'frame');
  if (list.length < 2) return;
  const rects = nodeRects(kind, t);
  const xs = list.map((n) => n.x);
  const ys = list.map((n) => n.y);
  const horizontal = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);
  const gap = 40;
  if (horizontal) {
    list.sort((a, b) => a.x - b.x);
    const y = Math.round(ys.reduce((s, v) => s + v, 0) / ys.length);
    let x = list[0].x;
    for (const n of list) {
      n.x = x;
      n.y = y;
      x += (rects.get(n.id)?.w ?? 150) + gap;
    }
  } else {
    list.sort((a, b) => a.y - b.y);
    const x = Math.round(xs.reduce((s, v) => s + v, 0) / xs.length);
    let y = list[0].y;
    for (const n of list) {
      n.x = x;
      n.y = y;
      y += (rects.get(n.id)?.h ?? 100) + gap / 2;
    }
  }
}

/** Glisser un nœud sur un lien : il s'y intercale (entrée et sortie compatibles). */
export function insertOnLink(kind: NodeTreeKind, t: Tree, id: string, linkId: string): boolean {
  const n = t.nodes[id];
  const l = t.links.find((x) => x.id === linkId);
  if (!n || !l || l.fromNode === id || l.toNode === id) return false;
  const fromType = socketType(kind, t.nodes[l.fromNode], 'out', l.fromSocket);
  const toType = socketType(kind, t.nodes[l.toNode], 'in', l.toSocket);
  const inp = inputsOf(kind, n).find((s) => fromType && s.type === fromType) ?? inputsOf(kind, n).find((s) => fromType && socketsCompatible(fromType, s.type));
  const out = outputsOf(kind, n).find((s) => toType && s.type === toType) ?? outputsOf(kind, n).find((s) => toType && socketsCompatible(s.type, toType));
  if (!inp || !out) return false;
  const backup = t.links;
  t.links = t.links.filter((x) => x !== l);
  if (!connect(kind, t, l.fromNode, l.fromSocket, id, inp.id) || !connect(kind, t, id, out.id, l.toNode, l.toSocket)) {
    t.links = backup;
    return false;
  }
  return true;
}

// ------------------------------------------------------------------ panneau Surface (onglet Matériau)

/** Nœuds proposés par le menu d'une entrée du panneau Surface (comme le menu de Blender). */
export const QUICK_LINK_TYPES = [
  'ShaderNodeTexNoise',
  'ShaderNodeTexVoronoi',
  'ShaderNodeTexWave',
  'ShaderNodeTexMagic',
  'ShaderNodeTexChecker',
  'ShaderNodeTexBrick',
  'ShaderNodeTexGradient',
  'ShaderNodeTexWhiteNoise',
  'ShaderNodeTexImage',
  'ShaderNodeRGB',
  'ShaderNodeValue',
  'ShaderNodeValToRGB',
  'ShaderNodeFresnel',
  'ShaderNodeLayerWeight',
];

/**
 * Crée un nœud `type` à gauche de `nodeId` et branche sa sortie la plus adaptée sur l'entrée
 * `socket` (même type d'abord : Couleur sur une couleur, Facteur sur un flottant…). Le nœud
 * déjà branché sur cette entrée reste dans l'arbre, débranché. Renvoie le nouveau nœud ou null.
 */
export function linkInputToNew(kind: NodeTreeKind, t: Tree, nodeId: string, socket: string, type: string): string | null {
  const target = t.nodes[nodeId];
  if (!target || !nodeType(kind, type)) return null;
  const inType = socketType(kind, target, 'in', socket);
  if (!inType) return null;
  const n = createNode(kind, type, target.x - 240, target.y);
  const outs = outputsOf(kind, n);
  const out = outs.find((o) => o.type === inType) ?? outs.find((o) => socketsCompatible(o.type, inType));
  if (!out) return null;
  // Évite d'empiler les nouveaux nœuds au même endroit.
  const taken = (x: number, y: number) => Object.values(t.nodes).some((m) => Math.abs(m.x - x) < 40 && Math.abs(m.y - y) < 40);
  for (let i = 0; i < 40 && taken(n.x, n.y); i++) n.y += 60;
  t.nodes[n.id] = n;
  if (!connect(kind, t, n.id, out.id, nodeId, socket)) {
    delete t.nodes[n.id];
    return null;
  }
  return n.id;
}

// ------------------------------------------------------------------ correctifs (collaboration)

/** Différence entre deux états d'un arbre, réapplicable sur une version plus récente. */
export interface TreePatch {
  /** Nœuds ajoutés ou modifiés (valeur complète). */
  nodes: Record<string, NodeData>;
  removedNodes: string[];
  links: NodeLink[];
  removedLinks: string[];
}

/** Ce qui change de `before` à `after` (nœuds comparés en JSON, liens par identifiant). */
export function diffTrees(before: Tree, after: Tree): TreePatch {
  const nodes: Record<string, NodeData> = {};
  for (const [id, n] of Object.entries(after.nodes)) if (!before.nodes[id] || JSON.stringify(before.nodes[id]) !== JSON.stringify(n)) nodes[id] = structuredClone(n);
  const removedNodes = Object.keys(before.nodes).filter((id) => !after.nodes[id]);
  const beforeLinks = new Set(before.links.map((l) => l.id));
  const afterLinks = new Set(after.links.map((l) => l.id));
  return {
    nodes,
    removedNodes,
    links: after.links.filter((l) => !beforeLinks.has(l.id)).map((l) => ({ ...l })),
    removedLinks: before.links.filter((l) => !afterLinks.has(l.id)).map((l) => l.id),
  };
}

/**
 * Applique un correctif sur l'arbre ACTUEL (qui a pu être modifié par un autre utilisateur
 * pendant le geste) : seuls les nœuds et liens touchés par le geste changent. Un lien dont un
 * bout a disparu est ignoré ; un nouveau lien remplace celui qui occupait la même entrée.
 */
export function applyPatch(t: Tree, p: TreePatch): void {
  for (const id of p.removedNodes) removeNodes(t, [id]);
  for (const [id, n] of Object.entries(p.nodes)) t.nodes[id] = structuredClone(n);
  const gone = new Set(p.removedLinks);
  t.links = t.links.filter((l) => !gone.has(l.id));
  for (const l of p.links) {
    if (!t.nodes[l.fromNode] || !t.nodes[l.toNode]) continue;
    t.links = t.links.filter((x) => x.id !== l.id && !(x.toNode === l.toNode && x.toSocket === l.toSocket));
    t.links.push({ ...l });
  }
}
