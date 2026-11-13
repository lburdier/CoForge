import type { NodeData, NodeLink, NodeTreeData } from '../doc/schema';
import { nodeDefaults, nodeType, socketsCompatible, visibleSockets, type NodeTreeKind, type SocketDef, type SocketType } from './types';

/**
 * Utilitaires PURS sur les arbres de nœuds (`NodeTreeData`), sans document ni interface.
 *
 * Convention : les fonctions qui modifient prennent un `GraphTree` et le MODIFIENT EN PLACE
 * (travailler sur `cloneTree(arbre)` puis écrire le résultat en une étape d'annulation) ; les
 * fonctions de lecture ne modifient rien. Toutes tolèrent un arbre mal formé (venu d'un autre
 * client) : nœuds absents, liens orphelins, champs manquants.
 *
 * API (signatures stables, utilisées par la zone « noeuds-editeur ») :
 *   newId(prefix?)                                  identifiant unique de nœud ou de lien
 *   cloneTree(t)                                    copie profonde { nodes, links }
 *   sanitizeTree(t)                                 copie nettoyée (liens orphelins / doublons d'entrée retirés)
 *   createNode(kind, type, x, y)                    nœud neuf aux valeurs par défaut du catalogue
 *   addNode(t, node) / removeNodes(t, ids)
 *   findLink(t, node, socket)                       lien arrivant sur une entrée
 *   canConnect(kind, t, from, fromSocket, to, toSocket) → raison du refus ou null
 *   connect(kind, t, from, fromSocket, to, toSocket) → lien créé ou null (remplace l'ancien lien de l'entrée)
 *   disconnectInput(t, node, socket) / removeLinks(t, linkIds)
 *   upstream(t, ids) / downstream(t, ids)           ensembles de nœuds (ids compris)
 *   wouldCycle(t, from, to) / hasCycle(t)
 *   topoSort(t) → { order, cyclic }                 ordre d'évaluation (sources d'abord)
 *   copyNodes(t, ids) → GraphTree                   extrait (liens internes compris)
 *   pasteNodes(t, clip, dx, dy) → nouveaux ids      colle avec de NOUVEAUX identifiants
 *   duplicateNodes(t, ids, dx, dy) → nouveaux ids
 *   dissolveNodes(kind, t, ids)                     supprime en reconnectant (Ctrl+X)
 */

export type GraphTree = Pick<NodeTreeData, 'nodes' | 'links'>;

let seq = 0;
/** Identifiant unique de nœud ('n…') ou de lien ('l…'). */
export function newId(prefix = 'n'): string {
  seq = (seq + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function linkList(t: GraphTree): NodeLink[] {
  return Array.isArray(t.links) ? t.links.filter((l) => isObj(l)) : [];
}

export function cloneTree(t: GraphTree): GraphTree {
  return { nodes: isObj(t.nodes) ? structuredClone(t.nodes) : {}, links: linkList(t).map((l) => ({ ...l })) };
}

/** Copie nettoyée : nœuds valides, liens vers des nœuds existants, un seul lien par entrée (le dernier). */
export function sanitizeTree(t: GraphTree): GraphTree {
  const nodes: Record<string, NodeData> = {};
  if (isObj(t.nodes)) {
    for (const [id, n] of Object.entries(t.nodes)) {
      if (!isObj(n) || typeof n.type !== 'string') continue;
      const node = structuredClone(n) as NodeData;
      node.id = id;
      node.x = Number.isFinite(node.x) ? node.x : 0;
      node.y = Number.isFinite(node.y) ? node.y : 0;
      node.inputs = isObj(node.inputs) ? node.inputs : {};
      node.props = isObj(node.props) ? node.props : {};
      nodes[id] = node;
    }
  }
  const byInput = new Map<string, NodeLink>();
  for (const l of linkList(t)) {
    if (typeof l.fromNode !== 'string' || typeof l.toNode !== 'string' || !nodes[l.fromNode] || !nodes[l.toNode]) continue;
    if (typeof l.fromSocket !== 'string' || typeof l.toSocket !== 'string' || l.fromNode === l.toNode) continue;
    byInput.set(`${l.toNode}\u0000${l.toSocket}`, { id: typeof l.id === 'string' ? l.id : newId('l'), fromNode: l.fromNode, fromSocket: l.fromSocket, toNode: l.toNode, toSocket: l.toSocket });
  }
  return { nodes, links: [...byInput.values()] };
}

/** Nouveau nœud avec les valeurs par défaut de son type (cadre : taille et libellé initiaux). */
export function createNode(kind: NodeTreeKind, type: string, x = 0, y = 0): NodeData {
  const def = nodeType(kind, type);
  const d = def ? nodeDefaults(def) : { inputs: {}, props: {} };
  const node: NodeData = { id: newId(), type, x: Math.round(x), y: Math.round(y), inputs: d.inputs, props: d.props };
  if (def?.layout === 'frame') {
    node.width = 300;
    node.height = 200;
    node.label = 'Cadre';
  }
  return node;
}

export function addNode(t: GraphTree, n: NodeData): void {
  t.nodes[n.id] = n;
}

/** Supprime des nœuds et leurs liens ; les enfants d'un cadre supprimé sont libérés. */
export function removeNodes(t: GraphTree, ids: Iterable<string>): void {
  const set = new Set(ids);
  for (const id of set) delete t.nodes[id];
  for (const n of Object.values(t.nodes)) if (n.parent && set.has(n.parent)) n.parent = null;
  t.links = linkList(t).filter((l) => !set.has(l.fromNode) && !set.has(l.toNode));
}

export function findLink(t: GraphTree, node: string, socket: string): NodeLink | null {
  return linkList(t).find((l) => l.toNode === node && l.toSocket === socket) ?? null;
}

function socketOf(kind: NodeTreeKind, n: NodeData | undefined, dir: 'in' | 'out', id: string): SocketDef | null {
  if (!n) return null;
  const def = nodeType(kind, n.type);
  if (!def) return null;
  // Redirection : un seul socket de chaque côté, de type libre.
  if (def.layout === 'reroute') return { id, label: '', type: 'any' };
  const list = visibleSockets(dir === 'in' ? def.inputs : def.outputs, isObj(n.props) ? n.props : {});
  return list.find((s) => s.id === id) ?? null;
}

/** Type d'un socket (null si le nœud ou le socket est inconnu). */
export function socketType(kind: NodeTreeKind, n: NodeData | undefined, dir: 'in' | 'out', id: string): SocketType | null {
  return socketOf(kind, n, dir, id)?.type ?? null;
}

/** Nœuds en amont (qui alimentent) de `ids`, ids compris. */
export function upstream(t: GraphTree, ids: Iterable<string>): Set<string> {
  const seen = new Set<string>(ids);
  const stack = [...seen];
  const links = linkList(t);
  while (stack.length) {
    const id = stack.pop()!;
    for (const l of links) if (l.toNode === id && !seen.has(l.fromNode)) seen.add(l.fromNode), stack.push(l.fromNode);
  }
  return seen;
}

/** Nœuds en aval (alimentés par) de `ids`, ids compris. */
export function downstream(t: GraphTree, ids: Iterable<string>): Set<string> {
  const seen = new Set<string>(ids);
  const stack = [...seen];
  const links = linkList(t);
  while (stack.length) {
    const id = stack.pop()!;
    for (const l of links) if (l.fromNode === id && !seen.has(l.toNode)) seen.add(l.toNode), stack.push(l.toNode);
  }
  return seen;
}

/** Un lien from → to fermerait-il une boucle ? */
export function wouldCycle(t: GraphTree, from: string, to: string): boolean {
  return from === to || downstream(t, [to]).has(from);
}

/**
 * Tri topologique (Kahn) : sources d'abord. `cyclic` liste les nœuds pris dans une boucle (ils
 * sont absents de `order`).
 */
export function topoSort(t: GraphTree): { order: string[]; cyclic: string[] } {
  const ids = Object.keys(isObj(t.nodes) ? t.nodes : {});
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  const out = new Map<string, string[]>();
  for (const l of linkList(t)) {
    if (!indeg.has(l.fromNode) || !indeg.has(l.toNode)) continue;
    indeg.set(l.toNode, indeg.get(l.toNode)! + 1);
    (out.get(l.fromNode) ?? out.set(l.fromNode, []).get(l.fromNode)!).push(l.toNode);
  }
  const queue = ids.filter((id) => indeg.get(id) === 0);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const to of out.get(id) ?? []) {
      const d = indeg.get(to)! - 1;
      indeg.set(to, d);
      if (d === 0) queue.push(to);
    }
  }
  const done = new Set(order);
  return { order, cyclic: ids.filter((id) => !done.has(id)) };
}

export function hasCycle(t: GraphTree): boolean {
  return topoSort(t).cyclic.length > 0;
}

/** Pourquoi un lien serait refusé (texte français), ou null s'il est admis. */
export function canConnect(kind: NodeTreeKind, t: GraphTree, from: string, fromSocket: string, to: string, toSocket: string): string | null {
  const a = socketOf(kind, t.nodes[from], 'out', fromSocket);
  const b = socketOf(kind, t.nodes[to], 'in', toSocket);
  if (!a || !b) return 'Socket introuvable';
  if (!socketsCompatible(a.type, b.type)) return 'Types de sockets incompatibles';
  if (wouldCycle(t, from, to)) return 'Ce lien créerait une boucle';
  return null;
}

/**
 * Relie une sortie à une entrée. Une entrée n'a qu'un lien : l'ancien est remplacé. Renvoie le
 * lien créé, ou null (types incompatibles, boucle, socket inconnu).
 */
export function connect(kind: NodeTreeKind, t: GraphTree, from: string, fromSocket: string, to: string, toSocket: string): NodeLink | null {
  if (canConnect(kind, t, from, fromSocket, to, toSocket)) return null;
  const link: NodeLink = { id: newId('l'), fromNode: from, fromSocket, toNode: to, toSocket };
  t.links = linkList(t).filter((l) => !(l.toNode === to && l.toSocket === toSocket));
  t.links.push(link);
  return link;
}

/** Détache le lien d'une entrée ; renvoie le lien retiré. */
export function disconnectInput(t: GraphTree, node: string, socket: string): NodeLink | null {
  const l = findLink(t, node, socket);
  if (l) t.links = linkList(t).filter((x) => x !== l);
  return l;
}

export function removeLinks(t: GraphTree, linkIds: Iterable<string>): void {
  const set = new Set(linkIds);
  t.links = linkList(t).filter((l) => !set.has(l.id));
}

/** Extrait des nœuds (copie) avec les liens entre eux ; un parent hors sélection est oublié. */
export function copyNodes(t: GraphTree, ids: Iterable<string>): GraphTree {
  const set = new Set([...ids].filter((id) => t.nodes[id]));
  const nodes: Record<string, NodeData> = {};
  for (const id of set) nodes[id] = structuredClone(t.nodes[id]);
  for (const n of Object.values(nodes)) if (n.parent && !set.has(n.parent)) n.parent = null;
  return { nodes, links: linkList(t).filter((l) => set.has(l.fromNode) && set.has(l.toNode)).map((l) => ({ ...l })) };
}

/**
 * Colle un extrait avec de NOUVEAUX identifiants (nœuds et liens), décalé de (dx, dy). Renvoie
 * les nouveaux identifiants dans l'ordre de l'extrait.
 */
export function pasteNodes(t: GraphTree, clip: GraphTree, dx = 0, dy = 0): string[] {
  const map = new Map<string, string>();
  const src = isObj(clip.nodes) ? Object.values(clip.nodes).filter((n) => isObj(n)) : [];
  for (const n of src) map.set(n.id, newId());
  for (const n of src) {
    const copy = structuredClone(n);
    copy.id = map.get(n.id)!;
    copy.x = (Number.isFinite(copy.x) ? copy.x : 0) + dx;
    copy.y = (Number.isFinite(copy.y) ? copy.y : 0) + dy;
    copy.parent = copy.parent && map.has(copy.parent) ? map.get(copy.parent)! : null;
    t.nodes[copy.id] = copy;
  }
  for (const l of linkList(clip)) {
    const a = map.get(l.fromNode);
    const b = map.get(l.toNode);
    if (a && b) t.links.push({ id: newId('l'), fromNode: a, fromSocket: l.fromSocket, toNode: b, toSocket: l.toSocket });
  }
  return src.map((n) => map.get(n.id)!);
}

/** Duplique des nœuds (et les liens entre eux) ; un parent dupliqué suit, sinon le parent est gardé. */
export function duplicateNodes(t: GraphTree, ids: Iterable<string>, dx = 30, dy = 30): string[] {
  const list = [...ids].filter((id) => t.nodes[id]);
  const clip = copyNodes(t, list);
  const parents = new Map(list.map((id) => [id, t.nodes[id].parent ?? null]));
  const fresh = pasteNodes(t, clip, dx, dy);
  list.forEach((id, i) => {
    const n = t.nodes[fresh[i]];
    if (!n.parent) n.parent = parents.get(id) ?? null;
  });
  return fresh;
}

/**
 * Supprime en reconnectant (Ctrl+X de Blender) : chaque lien sortant d'un nœud supprimé reprend
 * la source de la première entrée connectée de type compatible (à travers une chaîne de nœuds supprimés).
 */
export function dissolveNodes(kind: NodeTreeKind, t: GraphTree, ids: Iterable<string>): void {
  const set = new Set(ids);
  const links = linkList(t);
  const sourceOf = (id: string, type: SocketType, depth = 0): NodeLink | null => {
    const n = t.nodes[id];
    const def = n ? nodeType(kind, n.type) : null;
    if (!n || depth > 64) return null;
    const inputs = def?.layout === 'reroute' ? [{ id: 'Input', type: 'any' as SocketType }] : def ? visibleSockets(def.inputs, n.props ?? {}) : [];
    for (const s of inputs) {
      if (!socketsCompatible(s.type, type)) continue;
      const l = links.find((x) => x.toNode === id && x.toSocket === s.id);
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
  const bridges: [string, string, string, string][] = [];
  for (const l of links) {
    if (!set.has(l.fromNode) || set.has(l.toNode)) continue;
    const type = socketType(kind, t.nodes[l.fromNode], 'out', l.fromSocket) ?? 'any';
    const src = sourceOf(l.fromNode, type);
    if (src) bridges.push([src.fromNode, src.fromSocket, l.toNode, l.toSocket]);
  }
  removeNodes(t, set);
  for (const [a, as, b, bs] of bridges) connect(kind, t, a, as, b, bs);
}
