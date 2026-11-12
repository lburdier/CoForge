/**
 * Arbres de nœuds de shaders (matériaux, monde, lumières) : lecture tolérante de toutes les
 * versions de Blender, de 2.5x (types numériques, valeurs dans `ns.vec`) à 5.x (`idname`,
 * valeurs par défaut dans `default_value`, groupes de nœuds).
 *
 * Toutes les boucles sont bornées : un fichier corrompu (liens qui bouclent, groupes qui
 * s'incluent eux-mêmes) ne peut ni figer la lecture ni épuiser la mémoire.
 */
import { recAt, type Rec } from './reader';
import { finite, type RGB } from './util';

/** Nombre maximal de nœuds / liens / sockets lus par arbre. */
const MAX_NODES = 4096;
const MAX_LINKS = 16384;
const MAX_SOCKETS = 256;
/** Profondeur maximale d'imbrication des groupes de nœuds. */
const MAX_GROUP_DEPTH = 16;
/** Longueur maximale d'une chaîne de nœuds « transparents » (reroute, entrées de groupe…). */
const MAX_HOPS = 256;

// Drapeaux (DNA_node_types.h, stables de 2.5x à 5.x).
const NODE_DO_OUTPUT = 1 << 6;
const NODE_MUTED = 1 << 9;
const NODE_LINK_MUTED = 1 << 4;

// Types de sockets (eNodeSocketDatatype).
const SOCK_FLOAT = 0;
const SOCK_VECTOR = 1;
const SOCK_RGBA = 2;
const SOCK_SHADER = 3;
const SOCK_BOOLEAN = 4;
const SOCK_INT = 6;

/**
 * Anciens fichiers (avant 2.67) : pas d'`idname`, seulement le type numérique du nœud.
 * Les numéros n'ont jamais changé (vérifiés sur des fichiers 2.79 et 5.1).
 */
const LEGACY_IDNAME: Record<number, string> = {
  2: 'ShaderNodeGroup', // NODE_GROUP
  6: 'NodeReroute',
  7: 'NodeGroupInput',
  8: 'NodeGroupOutput',
  102: 'ShaderNodeRGB',
  122: 'ShaderNodeHueSaturation',
  124: 'ShaderNodeOutputMaterial',
  125: 'ShaderNodeOutputWorld',
  126: 'ShaderNodeOutputLamp',
  128: 'ShaderNodeMixShader',
  129: 'ShaderNodeAttribute',
  130: 'ShaderNodeBackground',
  131: 'ShaderNodeBsdfAnisotropic',
  132: 'ShaderNodeBsdfDiffuse',
  133: 'ShaderNodeBsdfGlossy',
  134: 'ShaderNodeBsdfGlass',
  135: 'ShaderNodeHoldout',
  136: 'ShaderNodeBsdfTranslucent',
  137: 'ShaderNodeBsdfTransparent',
  138: 'ShaderNodeBsdfTransparent',
  139: 'ShaderNodeBsdfVelvet',
  140: 'ShaderNodeEmission',
  143: 'ShaderNodeTexImage',
  144: 'ShaderNodeTexEnvironment',
  145: 'ShaderNodeTexSky',
  155: 'ShaderNodeAddShader',
  193: 'ShaderNodeBsdfPrincipled',
};

export type SocketKind = 'float' | 'vector' | 'rgba' | 'shader' | 'bool' | 'int' | 'other';

export interface SSocket {
  rec: Rec;
  block: number;
  name: string;
  identifier: string;
  kind: SocketKind;
  /** Rang parmi les entrées (ou sorties) du nœud. */
  index: number;
  node: SNode;
}

export interface SNode {
  rec: Rec;
  block: number;
  /** Identifiant de type (« ShaderNodeBsdfPrincipled »…), déduit du type numérique au besoin. */
  idname: string;
  name: string;
  flag: number;
  inputs: SSocket[];
  outputs: SSocket[];
  tree: STree;
}

export interface STree {
  rec: Rec;
  nodes: SNode[];
  /** Lien entrant de chaque socket d'entrée (clé : bloc du socket). */
  incoming: Map<number, SSocket>;
}

/** Position dans un arbre, avec la pile des nœuds de groupe traversés pour y arriver. */
export interface Cursor {
  tree: STree;
  /** Nœuds de groupe englobants, du plus extérieur au plus intérieur. */
  stack: SNode[];
}

/** Lien résolu : la sortie qui alimente une entrée, dans son propre contexte de groupe. */
export interface Source {
  socket: SSocket;
  cursor: Cursor;
}

function socketKind(s: Rec): SocketKind {
  switch (s.num('type', -1)) {
    case SOCK_FLOAT:
      return 'float';
    case SOCK_VECTOR:
      return 'vector';
    case SOCK_RGBA:
      return 'rgba';
    case SOCK_SHADER:
      return 'shader';
    case SOCK_BOOLEAN:
      return 'bool';
    case SOCK_INT:
      return 'int';
    default: {
      const id = s.str('idname');
      if (id.startsWith('NodeSocketFloat')) return 'float';
      if (id.startsWith('NodeSocketColor')) return 'rgba';
      if (id.startsWith('NodeSocketVector')) return 'vector';
      if (id.startsWith('NodeSocketShader')) return 'shader';
      return 'other';
    }
  }
}

function readSockets(node: SNode, field: 'inputs' | 'outputs'): SSocket[] {
  const out: SSocket[] = [];
  for (const s of node.rec.list(field)) {
    if (out.length >= MAX_SOCKETS) break;
    const name = s.str('name');
    out.push({ rec: s, block: s.block, name, identifier: s.str('identifier') || name, kind: socketKind(s), index: out.length, node });
  }
  return out;
}

/** Cache par bloc d'arbre : un même groupe peut être visité de nombreuses fois. */
const treeCache = new WeakMap<object, Map<number, STree | null>>();

/** Lit un arbre de nœuds (embarqué dans un matériau / monde / lumière, ou groupe `NT`). */
export function readTree(tree: Rec | null): STree | null {
  if (!tree) return null;
  let cache = treeCache.get(tree.file);
  if (!cache) treeCache.set(tree.file, (cache = new Map()));
  const hit = cache.get(tree.block);
  if (hit !== undefined) return hit;
  const t: STree = { rec: tree, nodes: [], incoming: new Map() };
  cache.set(tree.block, t);
  const byBlock = new Map<number, SNode>();
  for (const n of tree.list('nodes')) {
    if (t.nodes.length >= MAX_NODES) break;
    let idname = n.str('idname');
    if (!idname) idname = LEGACY_IDNAME[n.num(['type', 'type_legacy'], -1)] ?? '';
    const node: SNode = { rec: n, block: n.block, idname, name: n.str('name'), flag: n.num('flag'), inputs: [], outputs: [], tree: t };
    node.inputs = readSockets(node, 'inputs');
    node.outputs = readSockets(node, 'outputs');
    t.nodes.push(node);
    byBlock.set(n.block, node);
  }
  const sockets = new Map<number, SSocket>();
  for (const node of t.nodes) {
    for (const s of node.inputs) sockets.set(s.block, s);
    for (const s of node.outputs) sockets.set(s.block, s);
  }
  let count = 0;
  for (const l of tree.list('links')) {
    if (++count > MAX_LINKS) break;
    if (l.num('flag') & NODE_LINK_MUTED) continue;
    const from = sockets.get(l.target('fromsock'));
    const to = sockets.get(l.target('tosock'));
    if (!from || !to || !byBlock.has(from.node.block) || !byBlock.has(to.node.block)) continue;
    // Un seul lien par entrée (les entrées multiples n'existent pas dans les shaders) : le premier gagne.
    if (!t.incoming.has(to.block)) t.incoming.set(to.block, from);
  }
  return t;
}

/** Nœud de sortie actif d'un type donné (« ShaderNodeOutputMaterial »…), null s'il n'y en a pas. */
export function findOutput(tree: STree, idnames: readonly string[]): SNode | null {
  let best: SNode | null = null;
  let bestScore = -1;
  for (const n of tree.nodes) {
    if (!idnames.includes(n.idname)) continue;
    // custom1 = cible (0 tous moteurs, 1 EEVEE, 2 Cycles) ; la sortie active (NODE_DO_OUTPUT) prime.
    const target = n.rec.num('custom1');
    const score = (n.flag & NODE_DO_OUTPUT ? 2 : 0) + (target === 0 || target === 2 ? 1 : 0);
    if (score > bestScore) {
      best = n;
      bestScore = score;
    }
  }
  return best;
}

/** Entrée d'un nœud par nom (premier nom présent), en tolérant les renommages entre versions. */
export function input(node: SNode, names: readonly string[], kind?: SocketKind): SSocket | null {
  for (const name of names) {
    for (const s of node.inputs) if ((s.name === name || s.identifier === name) && (!kind || s.kind === kind)) return s;
  }
  return null;
}

export function isMuted(node: SNode): boolean {
  return (node.flag & NODE_MUTED) !== 0;
}

/** Arbre d'un groupe de nœuds (nœud « ShaderNodeGroup »), null s'il est absent ou lié à une bibliothèque vide. */
function groupTree(node: SNode): STree | null {
  return readTree(node.rec.id('id'));
}

/**
 * Sortie qui alimente réellement l'entrée `socket` : traverse les reroutes, les nœuds coupés
 * (mute), les entrées et sorties de groupes. null si l'entrée n'est pas branchée, sa valeur est
 * alors celle du socket où la remontée s'est arrêtée (voir `resolveValue`).
 */
export function follow(socket: SSocket, cursor: Cursor): Source | null {
  let sock = socket;
  let cx = cursor;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const from = cx.tree.incoming.get(sock.block);
    if (!from) return null;
    const node = from.node;
    if (node.idname === 'NodeReroute' || isMuted(node)) {
      const pass = node.idname === 'NodeReroute' ? node.inputs[0] : node.inputs.find((s) => s.kind === from.kind) ?? null;
      if (!pass) return null;
      sock = pass;
      continue;
    }
    if (node.idname === 'NodeGroupInput') {
      // Remonte dans l'arbre parent, vers l'entrée correspondante du nœud de groupe.
      const group = cx.stack[cx.stack.length - 1];
      if (!group) return null;
      const outer = group.inputs.find((s) => s.identifier === from.identifier) ?? group.inputs[from.index] ?? null;
      if (!outer) return null;
      sock = outer;
      cx = { tree: group.tree, stack: cx.stack.slice(0, -1) };
      continue;
    }
    if (node.idname.endsWith('NodeGroup') || node.idname === 'NodeGroup' || node.idname === 'NodeCustomGroup') {
      // Descend dans le groupe, jusqu'à l'entrée correspondante de sa sortie de groupe.
      const inner = cx.stack.length < MAX_GROUP_DEPTH ? groupTree(node) : null;
      const out = inner ? findOutput(inner, ['NodeGroupOutput']) : null;
      if (!inner || !out || cx.stack.includes(node)) return { socket: from, cursor: cx };
      const target = out.inputs.find((s) => s.identifier === from.identifier) ?? out.inputs[from.index] ?? null;
      if (!target) return { socket: from, cursor: cx };
      sock = target;
      cx = { tree: inner, stack: [...cx.stack, node] };
      continue;
    }
    return { socket: from, cursor: cx };
  }
  return null;
}

/**
 * Socket qui porte la valeur effective d'une entrée NON branchée, en tenant compte des groupes :
 * une entrée reliée à l'entrée d'un groupe prend la valeur du nœud de groupe englobant.
 * Renvoie le socket d'origine si rien n'y est relié.
 */
export function valueSocket(socket: SSocket, cursor: Cursor): SSocket {
  let sock = socket;
  let cx = cursor;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const from = cx.tree.incoming.get(sock.block);
    if (!from) return sock;
    const node = from.node;
    if (node.idname === 'NodeReroute') {
      sock = node.inputs[0] ?? sock;
      if (!node.inputs[0]) return sock;
      continue;
    }
    if (node.idname === 'NodeGroupInput') {
      const group = cx.stack[cx.stack.length - 1];
      const outer = group ? (group.inputs.find((s) => s.identifier === from.identifier) ?? group.inputs[from.index]) : undefined;
      if (!group || !outer) return sock;
      sock = outer;
      cx = { tree: group.tree, stack: cx.stack.slice(0, -1) };
      continue;
    }
    return sock;
  }
  return sock;
}

// ------------------------------------------------------------------ valeurs par défaut des sockets

const VALUE_STRUCT: Partial<Record<SocketKind, string>> = {
  float: 'bNodeSocketValueFloat',
  vector: 'bNodeSocketValueVector',
  rgba: 'bNodeSocketValueRGBA',
  bool: 'bNodeSocketValueBoolean',
  int: 'bNodeSocketValueInt',
};

/** Composantes de la valeur par défaut d'un socket (1 à 4 nombres), null si illisible. */
export function socketValues(s: SSocket): number[] | null {
  const hint = VALUE_STRUCT[s.kind];
  const v = hint ? recAt(s.rec.file, s.rec.target('default_value'), 0, hint) : null;
  if (v && v.has('value')) {
    const n = v.field('value')!.count;
    const vals = v.nums('value', Math.min(4, n));
    if (vals && vals.length) return vals.map((x) => finite(x, 0));
  }
  // Avant 2.64 : valeur dans la pile d'exécution sérialisée (`ns.vec`).
  const ns = s.rec.sub('ns');
  const vec = ns ? ns.nums('vec', 4) : null;
  if (vec) return vec.map((x) => finite(x, 0));
  return null;
}

export function socketFloat(s: SSocket | null, def: number): number {
  if (!s) return def;
  const v = socketValues(s);
  return v && v.length ? v[0] : def;
}

export function socketColor(s: SSocket | null, def: RGB): RGB {
  if (!s) return def;
  const v = socketValues(s);
  if (!v) return def;
  if (v.length >= 3) return [v[0], v[1], v[2]];
  return [v[0], v[0], v[0]];
}

// ------------------------------------------------------------------ recherches en amont

/**
 * Parcourt (en largeur, borné) tous les nœuds situés en amont d'une entrée, à travers les groupes,
 * et renvoie le premier qui satisfait `pred`.
 */
export function findUpstream(socket: SSocket, cursor: Cursor, pred: (n: SNode) => boolean, limit = 512): SNode | null {
  const queue: Source[] = [];
  const seen = new Set<string>();
  const push = (s: SSocket, cx: Cursor): void => {
    const src = follow(s, cx);
    if (!src) return;
    const key = `${src.socket.node.block}|${src.cursor.stack.map((g) => g.block).join(',')}`;
    if (seen.has(key)) return;
    seen.add(key);
    queue.push(src);
  };
  push(socket, cursor);
  for (let i = 0; i < queue.length && i < limit; i++) {
    const { socket: out, cursor: cx } = queue[i];
    const node = out.node;
    if (pred(node)) return node;
    for (const s of node.inputs) push(s, cx);
  }
  return null;
}

/** Vrai si une texture image (avec image) alimente cette entrée, même indirectement. */
export function fedByImage(socket: SSocket, cursor: Cursor): boolean {
  return !!findUpstream(socket, cursor, (n) => (n.idname === 'ShaderNodeTexImage' || n.idname === 'ShaderNodeTexEnvironment') && n.rec.ptr('id') !== 0);
}

/** Libellé court d'un type de nœud pour les avertissements (« ShaderNodeTexNoise » → « TexNoise »). */
export function nodeLabel(n: SNode): string {
  return n.idname.replace(/^(ShaderNode|GeometryNode|FunctionNode|Node)/, '') || n.name || '?';
}

/** Raccourci : curseur à la racine d'un arbre. */
export function rootCursor(tree: STree): Cursor {
  return { tree, stack: [] };
}
