import type { SceneDoc } from '../../core/doc/SceneDoc';
import { ROOT_COLLECTION, type LightKind, type ObjectType } from '../../core/doc/schema';
import { normalizeText } from '../lib/util';

/**
 * Arbre de l'outliner, calculé à partir du document (fonctions pures, sans React).
 *
 * Clés des nœuds : `c:<id collection>` (la racine est `c:root`) et `o:<id objet>`.
 * Ordre à la Blender : sous-collections d'abord, puis objets, chacun trié par nom.
 * Un objet enfant est rangé sous son parent quand ils sont dans la même
 * collection ; sinon il apparaît au premier niveau de sa propre collection :
 * chaque objet figure ainsi exactement une fois.
 */

export type NodeKind = 'collection' | 'object';

export interface TreeNode {
  key: string;
  kind: NodeKind;
  id: string;
  name: string;
  /** Objets uniquement. */
  objType: ObjectType | null;
  lightKind: LightKind | null;
  /** Drapeau propre (objet : visible viewport ; collection : visible). */
  visible: boolean;
  /** Objets : pris en compte au rendu. */
  renderable: boolean;
  /** Masqué par une collection ancêtre. */
  parentHidden: boolean;
  /** Collection contenante (objets) ou collection parente (collections ; racine : elle-même). */
  collection: string;
  parentKey: string | null;
  children: string[];
}

export interface Tree {
  nodes: Map<string, TreeNode>;
  /** Genre des lumières utilisées (pour ne reconstruire l'arbre que si une icône change). */
  lightKinds: Map<string, LightKind>;
  /** Nombre d'objets. */
  objectCount: number;
}

export const ROOT_KEY = `c:${ROOT_COLLECTION}`;
export const objKey = (id: string): string => `o:${id}`;
export const colKey = (id: string): string => `c:${id}`;

const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });

export function buildTree(doc: SceneDoc): Tree {
  const nodes = new Map<string, TreeNode>();
  const lightKinds = new Map<string, LightKind>();
  const root: TreeNode = {
    key: ROOT_KEY,
    kind: 'collection',
    id: ROOT_COLLECTION,
    name: 'Collection de scène',
    objType: null,
    lightKind: null,
    visible: true,
    renderable: true,
    parentHidden: false,
    collection: ROOT_COLLECTION,
    parentKey: null,
    children: [],
  };
  nodes.set(ROOT_KEY, root);

  // --- collections : rattachement sans cycle (deux éditions concurrentes peuvent en créer un)
  const cols = doc.listCollections();
  const byParent = new Map<string, string[]>();
  for (const c of cols) {
    let list = byParent.get(c.parent);
    if (!list) byParent.set(c.parent, (list = []));
    list.push(c.id);
  }
  const colById = new Map(cols.map((c) => [c.id, c]));
  const resolvedParent = new Map<string, string>();
  const reach = (start: string, startParent: string) => {
    const stack: [string, string][] = [[start, startParent]];
    while (stack.length) {
      const [id, parent] = stack.pop()!;
      if (resolvedParent.has(id)) continue;
      resolvedParent.set(id, parent);
      for (const child of byParent.get(id) ?? []) if (!resolvedParent.has(child)) stack.push([child, id]);
    }
  };
  for (const child of byParent.get(ROOT_COLLECTION) ?? []) reach(child, ROOT_COLLECTION);
  // Collections prises dans une boucle : la plus petite (par identifiant) devient racine.
  const orphans = cols
    .map((c) => c.id)
    .filter((id) => !resolvedParent.has(id))
    .sort();
  for (const id of orphans) if (!resolvedParent.has(id)) reach(id, ROOT_COLLECTION);

  for (const c of cols) {
    nodes.set(colKey(c.id), {
      key: colKey(c.id),
      kind: 'collection',
      id: c.id,
      name: c.name,
      objType: null,
      lightKind: null,
      visible: c.visible,
      renderable: true,
      parentHidden: false,
      collection: resolvedParent.get(c.id) ?? ROOT_COLLECTION,
      parentKey: colKey(resolvedParent.get(c.id) ?? ROOT_COLLECTION),
      children: [],
    });
  }
  // Visibilité héritée, de haut en bas.
  const hiddenMemo = new Map<string, boolean>();
  const isHidden = (id: string): boolean => {
    if (id === ROOT_COLLECTION) return false;
    const memo = hiddenMemo.get(id);
    if (memo !== undefined) return memo;
    const chain: string[] = [];
    let cur = id;
    let hidden = false;
    for (let depth = 0; depth < 256 && cur !== ROOT_COLLECTION; depth++) {
      const m = hiddenMemo.get(cur);
      if (m !== undefined) {
        hidden = m;
        break;
      }
      chain.push(cur);
      cur = resolvedParent.get(cur) ?? ROOT_COLLECTION;
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      hidden = hidden || !(colById.get(chain[i])?.visible ?? true);
      hiddenMemo.set(chain[i], hidden);
    }
    return hiddenMemo.get(id) ?? hidden;
  };
  for (const c of cols) {
    const n = nodes.get(colKey(c.id))!;
    n.parentHidden = isHidden(n.collection);
  }

  // --- objets
  const objs = doc.listObjects();
  for (const o of objs) {
    let lightKind: LightKind | null = null;
    if (o.type === 'light' && o.data) {
      lightKind = doc.getLight(o.data)?.kind ?? 'point';
      lightKinds.set(o.data, lightKind);
    }
    const collection = nodes.has(colKey(o.collection)) ? o.collection : ROOT_COLLECTION;
    nodes.set(objKey(o.id), {
      key: objKey(o.id),
      kind: 'object',
      id: o.id,
      name: o.name,
      objType: o.type,
      lightKind,
      visible: o.visible,
      renderable: o.renderable,
      parentHidden: isHidden(collection),
      collection,
      parentKey: colKey(collection),
      children: [],
    });
  }
  for (const o of objs) {
    const parent = doc.effectiveParent(o.id);
    if (!parent) continue;
    const n = nodes.get(objKey(o.id))!;
    const p = nodes.get(objKey(parent));
    if (p && p.collection === n.collection) n.parentKey = p.key;
  }

  // --- enfants, triés
  for (const n of nodes.values()) {
    if (n.parentKey) nodes.get(n.parentKey)?.children.push(n.key);
  }
  for (const n of nodes.values()) {
    if (n.children.length < 2) continue;
    n.children.sort((a, b) => {
      const na = nodes.get(a)!;
      const nb = nodes.get(b)!;
      if (na.kind !== nb.kind) return na.kind === 'collection' ? -1 : 1;
      return collator.compare(na.name, nb.name) || (na.id < nb.id ? -1 : 1);
    });
  }
  return { nodes, lightKinds, objectCount: objs.length };
}

export interface FlatRow {
  node: TreeNode;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

/**
 * Liste des lignes visibles. Avec un filtre, seuls les nœuds dont le nom
 * correspond (et leurs ancêtres) sont montrés, tout déplié.
 */
export function flattenTree(tree: Tree, collapsed: ReadonlySet<string>, query: string): FlatRow[] {
  const q = normalizeText(query.trim());
  let include: Set<string> | null = null;
  if (q) {
    include = new Set([ROOT_KEY]);
    for (const n of tree.nodes.values()) {
      if (n.key === ROOT_KEY || !normalizeText(n.name).includes(q)) continue;
      let cur: string | null = n.key;
      for (let depth = 0; cur && depth < 512 && !include.has(cur); depth++) {
        include.add(cur);
        cur = tree.nodes.get(cur)?.parentKey ?? null;
      }
    }
  }
  const out: FlatRow[] = [];
  const stack: [string, number][] = [[ROOT_KEY, 0]];
  while (stack.length) {
    const [key, depth] = stack.pop()!;
    const node = tree.nodes.get(key);
    if (!node) continue;
    const kids = include ? node.children.filter((k) => include!.has(k)) : node.children;
    const expanded = include ? true : !collapsed.has(key);
    out.push({ node, depth, hasChildren: kids.length > 0, expanded });
    if (expanded) for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], depth + 1]);
  }
  return out;
}

/** `key` est-il `ancestorKey` ou l'un de ses descendants dans l'arbre ? */
export function isUnder(tree: Tree, key: string, ancestorKey: string): boolean {
  let cur: string | null = key;
  for (let depth = 0; cur && depth < 512; depth++) {
    if (cur === ancestorKey) return true;
    cur = tree.nodes.get(cur)?.parentKey ?? null;
  }
  return false;
}

/** Tous les descendants (clés) d'un nœud. */
export function descendantKeys(tree: Tree, key: string): string[] {
  const out: string[] = [];
  const stack = [...(tree.nodes.get(key)?.children ?? [])];
  while (stack.length) {
    const k = stack.pop()!;
    out.push(k);
    const n = tree.nodes.get(k);
    if (n) stack.push(...n.children);
  }
  return out;
}
