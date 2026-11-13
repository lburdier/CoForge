import type { NodeData } from '../../core/doc/schema';
import type { NodeTreeKind } from '../../core/nodes/types';
import { connect, createNode, defOf, dissolveNodes, duplicateNodes, inputsOf, mergeNodes, outputNode, outputsOf, type Tree } from './treeOps';

/**
 * Outils PURS de l'extension Node Wrangler de Blender qui complètent ceux de treeOps.ts
 * (fusion, aperçu, échange, connexion paresseuse…) : changement rapide de mode, facteur,
 * sélection par type, copie de libellé, détacher les sorties, lier à la sortie, Lazy Mix.
 */

/** Propriétés « mode » que Alt+haut / bas fait défiler, par ordre de préférence. */
const MODE_PROPS = ['blend_type', 'operation'];

/**
 * Alt+haut / Alt+bas : passe au mode de fusion ou à l'opération précédent(e) / suivant(e) des
 * nœuds sélectionnés (Mélanger, Calcul, Calcul vectoriel…). Renvoie le nombre de nœuds changés.
 */
export function cycleMode(kind: NodeTreeKind, t: Tree, ids: Iterable<string>, dir: 1 | -1): number {
  let n = 0;
  for (const id of ids) {
    const node = t.nodes[id];
    const def = defOf(kind, node);
    if (!node || !def?.props) continue;
    const props = node.props ?? {};
    const p = MODE_PROPS.map((pid) => def.props!.find((x) => x.id === pid && x.kind === 'enum' && (!x.visible || x.visible(props)))).find((x) => x && x.options?.length);
    if (!p?.options) continue;
    const cur = p.options.findIndex((o) => o.value === String(props[p.id] ?? p.default));
    const next = p.options[(((cur < 0 ? 0 : cur) + dir) % p.options.length + p.options.length) % p.options.length];
    node.props = { ...props, [p.id]: next.value };
    n++;
  }
  return n;
}

/** Entrée « facteur » d'un nœud (Fac, Factor…), ou null. */
function factorInput(kind: NodeTreeKind, node: NodeData) {
  const ins = inputsOf(kind, node);
  return ins.find((s) => s.type === 'float' && /^fac/i.test(s.id)) ?? ins.find((s) => s.type === 'float' && s.subtype === 'factor') ?? null;
}

/**
 * Alt+gauche / Alt+droite : diminue / augmente le facteur des nœuds sélectionnés (pas de 0,1,
 * borné à 0..1), comme Node Wrangler. Les facteurs branchés ne changent pas.
 */
export function changeFactor(kind: NodeTreeKind, t: Tree, ids: Iterable<string>, delta: number): number {
  let n = 0;
  for (const id of ids) {
    const node = t.nodes[id];
    if (!node) continue;
    const s = factorInput(kind, node);
    if (!s || t.links.some((l) => l.toNode === id && l.toSocket === s.id)) continue;
    const cur = Number(node.inputs?.[s.id] ?? s.default);
    const v = Math.max(s.min ?? 0, Math.min(s.max ?? 1, Math.round(((Number.isFinite(cur) ? cur : 0) + delta) * 1000) / 1000));
    node.inputs = { ...node.inputs, [s.id]: v };
    n++;
  }
  return n;
}

/** Maj+G : tous les nœuds du même type que la sélection. */
export function selectSameType(t: Tree, ids: Iterable<string>): Set<string> {
  const types = new Set([...ids].map((id) => t.nodes[id]?.type).filter((x): x is string => !!x));
  return new Set(Object.values(t.nodes).filter((n) => types.has(n.type)).map((n) => n.id));
}

/**
 * Copier le libellé (Node Wrangler) : `active` copie le libellé du nœud actif sur les autres ;
 * `node` / `socket` donnent à chaque nœud le nom du nœud / de la sortie qui alimente sa première
 * entrée branchée. Renvoie le nombre de nœuds renommés.
 */
export function copyLabel(kind: NodeTreeKind, t: Tree, ids: Iterable<string>, from: 'active' | 'node' | 'socket', active: string | null): number {
  let n = 0;
  if (from === 'active') {
    const a = active ? t.nodes[active] : undefined;
    if (!a) return 0;
    const label = a.label || defOf(kind, a)?.label || a.type;
    for (const id of ids) {
      if (id === active || !t.nodes[id]) continue;
      t.nodes[id].label = label;
      n++;
    }
    return n;
  }
  for (const id of ids) {
    const node = t.nodes[id];
    if (!node) continue;
    const order = inputsOf(kind, node).map((s) => s.id);
    const link = t.links.filter((l) => l.toNode === id).sort((a, b) => order.indexOf(a.toSocket) - order.indexOf(b.toSocket))[0];
    const src = link ? t.nodes[link.fromNode] : undefined;
    if (!link || !src) continue;
    const sd = defOf(kind, src);
    const label = from === 'node' ? src.label || sd?.label || src.type : (sd?.outputs.find((o) => o.id === link.fromSocket)?.label ?? link.fromSocket);
    node.label = label;
    n++;
  }
  return n;
}

/**
 * Maj+Alt+D (Node Wrangler, détacher les sorties) : copie les nœuds en gardant leurs entrées,
 * supprime les originaux en reconnectant l'aval à l'amont. Renvoie les copies (à déplacer).
 */
export function detachOutputs(kind: NodeTreeKind, t: Tree, ids: Iterable<string>): string[] {
  const list = [...ids].filter((id) => t.nodes[id] && !defOf(kind, t.nodes[id])?.layout);
  if (list.length === 0) return [];
  const set = new Set(list);
  const fresh = duplicateNodes(t, list, 0, 0);
  const map = new Map(list.map((id, i) => [id, fresh[i]]));
  // Les entrées venant de l'extérieur de la sélection sont recopiées sur les copies.
  for (const l of [...t.links]) {
    if (set.has(l.toNode) && !set.has(l.fromNode)) t.links.push({ ...l, id: `${l.id}_d${map.get(l.toNode)}`, toNode: map.get(l.toNode)! });
  }
  dissolveNodes(kind, t, list);
  return fresh;
}

/**
 * O (Node Wrangler) : relie la sortie shader du nœud actif à la surface de la Sortie du
 * matériau (une sortie « Déplacement » va sur le déplacement). La sortie est créée s'il n'y en a pas.
 */
export function linkToOutput(kind: NodeTreeKind, t: Tree, id: string): boolean {
  const n = t.nodes[id];
  if (!n || n.type.startsWith('ShaderNodeOutput')) return false;
  const outs = outputsOf(kind, n);
  const shader = outs.find((s) => s.type === 'shader');
  const disp = outs.find((s) => s.id === 'Displacement');
  if (!shader && !disp) return false;
  let out = outputNode(t);
  if (!out) {
    out = createNode(kind, 'ShaderNodeOutputMaterial', n.x + 260, n.y);
    t.nodes[out.id] = out;
  }
  return shader ? connect(kind, t, id, shader.id, out.id, 'Surface') : connect(kind, t, id, disp!.id, out.id, 'Displacement');
}

/** Ctrl+Maj+clic droit glissé (Lazy Mix) : un nœud Mélanger entre deux nœuds. */
export function lazyMix(kind: NodeTreeKind, t: Tree, a: string, b: string): string | null {
  if (a === b) return null;
  return mergeNodes(kind, t, [a, b], 'MIX');
}
