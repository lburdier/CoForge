import type { SceneDoc } from '../../core/doc/SceneDoc';
import { CONSTRAINT_LABELS, MODIFIER_LABELS, ROOT_COLLECTION, type LightKind, type ObjectData, type ObjectType } from '../../core/doc/schema';
import { objectTypeCategory, OBJECT_TYPE_CATEGORIES, type ObjectTypeCategory } from '../../app/store';
import { normalizeText } from '../lib/util';

/**
 * Arbre de l'outliner, calculé à partir du document (fonctions pures, sans React).
 *
 * Clés des nœuds : `c:<id collection>` (la racine est `c:root`), `o:<id objet>` et, pour le
 * contenu des objets (données, matériau, modificateurs, contraintes), `x:<id objet>:<élément>`.
 * Ordre à la Blender : sous-collections d'abord, puis objets, chacun trié par nom ; sous un objet,
 * son contenu d'abord, puis ses enfants. Un objet enfant est rangé sous son parent quand ils sont
 * dans la même collection ; sinon il apparaît au premier niveau de sa propre collection : chaque
 * objet figure ainsi exactement une fois.
 *
 * L'arbre est construit UNE fois par changement de structure du document ; les filtres de
 * l'outliner (types, visibilité, sélection, contenu, enfants, collections) et la recherche ne
 * s'appliquent qu'à l'aplatissement (`flattenTree`), sans reconstruction.
 */

export type NodeKind = 'collection' | 'object' | 'content';
/** Contenu d'un objet affiché sous lui (filtre « Contenu des objets »). */
export type ContentKind = 'data' | 'material' | 'modifiers' | 'modifier' | 'constraints' | 'constraint';

export interface TreeNode {
  key: string;
  kind: NodeKind;
  id: string;
  name: string;
  /** Objets uniquement (contenu : type de l'objet propriétaire). */
  objType: ObjectType | null;
  lightKind: LightKind | null;
  /** Drapeau propre (objet : visible viewport ; collection : visible ; contenu : activé). */
  visible: boolean;
  /** Objets : pris en compte au rendu. */
  renderable: boolean;
  /** Objets : sélectionnable dans le viewport (`ObjectData.selectable`). */
  selectable: boolean;
  /** Masqué par une collection ancêtre. */
  parentHidden: boolean;
  /** Collection contenante (objets, contenu) ou collection parente (collections ; racine : elle-même). */
  collection: string;
  parentKey: string | null;
  children: string[];
  /** Contenu uniquement : nature et objet propriétaire. */
  content: ContentKind | null;
  owner: string | null;
}

export interface Tree {
  nodes: Map<string, TreeNode>;
  /** Genre des lumières utilisées (pour ne reconstruire l'arbre que si une icône change). */
  lightKinds: Map<string, LightKind>;
  /** Nombre d'objets. */
  objectCount: number;
  /** Nombre d'objets par catégorie de type (popover des filtres). */
  typeCounts: Record<ObjectTypeCategory, number>;
  /** Blocs de données nommés affichés (matériaux, maillages) → nom affiché. */
  dataNames: Map<string, string>;
  /** Objet → signature de son contenu affiché (matériau, modificateurs, contraintes). */
  contentSigs: Map<string, string>;
  /** Objets au premier niveau d'une collection (pas sous un parent), triés par nom. */
  topObjects: string[];
  /** Tous les objets, triés par nom. */
  allObjects: string[];
  /** Collection → tous ses objets (enfants compris), triés par nom (filtre « Enfants » décoché). */
  objectsByCollection: Map<string, string[]>;
}

export const ROOT_KEY = `c:${ROOT_COLLECTION}`;
export const objKey = (id: string): string => `o:${id}`;
export const colKey = (id: string): string => `c:${id}`;

const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });

const LIGHT_LABELS: Record<string, string> = { point: 'Point', sun: 'Soleil', spot: 'Projecteur', area: 'Surface' };

/** Signature du contenu affiché d'un objet : l'arbre n'est reconstruit que si elle change. */
export function contentSignature(o: Pick<ObjectData, 'material' | 'modifiers' | 'constraints'>): string {
  let s = `${o.material ?? ''}|`;
  if (Array.isArray(o.modifiers)) for (const m of o.modifiers) s += `${m?.id}:${m?.type}:${m?.name}:${m?.enabled !== false ? 1 : 0},`;
  s += '|';
  if (Array.isArray(o.constraints)) for (const c of o.constraints) s += `${c?.id}:${c?.type}:${c?.name}:${c?.enabled !== false ? 1 : 0},`;
  return s;
}

function contentNode(owner: TreeNode, sub: string, content: ContentKind, name: string, enabled: boolean, parentKey: string): TreeNode {
  return {
    key: `x:${owner.id}:${sub}`,
    kind: 'content',
    id: sub,
    name,
    objType: owner.objType,
    lightKind: owner.lightKind,
    visible: enabled,
    renderable: true,
    selectable: true,
    parentHidden: owner.parentHidden,
    collection: owner.collection,
    parentKey,
    children: [],
    content,
    owner: owner.id,
  };
}

export function buildTree(doc: SceneDoc): Tree {
  const nodes = new Map<string, TreeNode>();
  const lightKinds = new Map<string, LightKind>();
  const dataNames = new Map<string, string>();
  const contentSigs = new Map<string, string>();
  const typeCounts = { mesh: 0, camera: 0, light: 0, empty: 0, other: 0 } as Record<ObjectTypeCategory, number>;
  const root: TreeNode = {
    key: ROOT_KEY,
    kind: 'collection',
    id: ROOT_COLLECTION,
    name: 'Collection de scène',
    objType: null,
    lightKind: null,
    visible: true,
    renderable: true,
    selectable: true,
    parentHidden: false,
    collection: ROOT_COLLECTION,
    parentKey: null,
    children: [],
    content: null,
    owner: null,
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
      selectable: true,
      parentHidden: false,
      collection: resolvedParent.get(c.id) ?? ROOT_COLLECTION,
      parentKey: colKey(resolvedParent.get(c.id) ?? ROOT_COLLECTION),
      children: [],
      content: null,
      owner: null,
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
    typeCounts[objectTypeCategory(o.type)]++;
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
      selectable: o.selectable !== false,
      parentHidden: isHidden(collection),
      collection,
      parentKey: colKey(collection),
      children: [],
      content: null,
      owner: null,
    });
  }
  for (const o of objs) {
    const parent = doc.effectiveParent(o.id);
    if (!parent) continue;
    const n = nodes.get(objKey(o.id))!;
    const p = nodes.get(objKey(parent));
    if (p && p.collection === n.collection) n.parentKey = p.key;
  }

  // --- contenu des objets (ajouté avant les enfants : il reste en tête après le tri)
  const contentOrder: TreeNode[] = [];
  for (const o of objs) {
    const owner = nodes.get(objKey(o.id))!;
    contentSigs.set(o.id, contentSignature(o));
    const add = (n: TreeNode) => {
      nodes.set(n.key, n);
      contentOrder.push(n);
    };
    if (o.data && o.type === 'mesh') {
      const name = doc.getMeshName(o.data);
      dataNames.set(o.data, name);
      add(contentNode(owner, 'data', 'data', name, true, owner.key));
    } else if (o.type === 'light' && o.data) {
      add(contentNode(owner, 'data', 'data', `Lumière ${LIGHT_LABELS[owner.lightKind ?? 'point'] ?? ''}`.trim(), true, owner.key));
    } else if (o.type === 'camera' && o.data) {
      add(contentNode(owner, 'data', 'data', 'Caméra', true, owner.key));
    }
    const mods = Array.isArray(o.modifiers) ? o.modifiers.filter((m) => m && typeof m === 'object') : [];
    if (mods.length) {
      const group = contentNode(owner, 'mods', 'modifiers', 'Modificateurs', true, owner.key);
      add(group);
      mods.forEach((m, i) => {
        const label = typeof m.name === 'string' && m.name ? m.name : (MODIFIER_LABELS[m.type] ?? 'Modificateur');
        add(contentNode(owner, `mod:${typeof m.id === 'string' ? m.id : i}`, 'modifier', label, m.enabled !== false, group.key));
      });
    }
    const cons = Array.isArray(o.constraints) ? o.constraints.filter((c) => c && typeof c === 'object') : [];
    if (cons.length) {
      const group = contentNode(owner, 'cons', 'constraints', 'Contraintes', true, owner.key);
      add(group);
      cons.forEach((c, i) => {
        const label = typeof c.name === 'string' && c.name ? c.name : (CONSTRAINT_LABELS[c.type] ?? 'Contrainte');
        add(contentNode(owner, `con:${typeof c.id === 'string' ? c.id : i}`, 'constraint', label, c.enabled !== false, group.key));
      });
    }
    if (o.type === 'mesh' && o.material) {
      const name = doc.getMaterial(o.material)?.name ?? 'Matériau';
      dataNames.set(o.material, name);
      add(contentNode(owner, 'mat', 'material', name, true, owner.key));
    }
  }

  // --- enfants : contenu (dans l'ordre d'ajout), sous-collections, puis objets par nom
  for (const n of contentOrder) nodes.get(n.parentKey!)?.children.push(n.key);
  for (const n of nodes.values()) {
    if (n.kind !== 'content' && n.parentKey) nodes.get(n.parentKey)?.children.push(n.key);
  }
  const rank = (k: NodeKind) => (k === 'content' ? 0 : k === 'collection' ? 1 : 2);
  const byName = (a: string, b: string) => {
    const na = nodes.get(a)!;
    const nb = nodes.get(b)!;
    if (na.kind !== nb.kind) return rank(na.kind) - rank(nb.kind);
    if (na.kind === 'content') return 0; // tri stable : l'ordre d'ajout est conservé
    return collator.compare(na.name, nb.name) || (na.id < nb.id ? -1 : 1);
  };
  for (const n of nodes.values()) {
    if (n.children.length >= 2) n.children.sort(byName);
  }

  // --- listes à plat pour les filtres « Enfants » et « Collections »
  const allObjects = objs.map((o) => objKey(o.id)).sort(byName);
  const topObjects = allObjects.filter((k) => nodes.get(nodes.get(k)!.parentKey!)?.kind === 'collection');
  const objectsByCollection = new Map<string, string[]>();
  for (const k of allObjects) {
    const c = nodes.get(k)!.collection;
    let list = objectsByCollection.get(c);
    if (!list) objectsByCollection.set(c, (list = []));
    list.push(k);
  }
  return { nodes, lightKinds, objectCount: objs.length, typeCounts, dataNames, contentSigs, topObjects, allObjects, objectsByCollection };
}

// ------------------------------------------------------------------ filtres (préférences locales de l'outliner)

export type ObjectStateFilter = 'all' | 'visible' | 'selected' | 'active';

export interface OutlinerFilters {
  /** Colonnes de restriction affichées. */
  colSelectable: boolean;
  colViewport: boolean;
  colRender: boolean;
  /** Filtre d'état des objets. */
  objects: ObjectStateFilter;
  /** Contenu des objets (données, matériau, modificateurs, contraintes). */
  contents: boolean;
  /** Enfants rangés sous leur parent (sinon : liste à plat dans la collection). */
  children: boolean;
  /** Collections affichées (sinon : tous les objets sous la collection de scène). */
  collections: boolean;
  /** Types d'objets affichés dans l'outliner. */
  types: Record<ObjectTypeCategory, boolean>;
  /** Déplier et faire défiler vers l'objet actif quand il change ailleurs que dans l'outliner. */
  followActive: boolean;
}

export const DEFAULT_FILTERS: OutlinerFilters = {
  colSelectable: false,
  colViewport: true,
  colRender: true,
  objects: 'all',
  contents: true,
  children: true,
  collections: true,
  types: { mesh: true, camera: true, light: true, empty: true, other: true },
  followActive: true,
};

/** Relit des filtres mémorisés (valeur éventuellement ancienne ou corrompue). */
export function normalizeFilters(raw: unknown): OutlinerFilters {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  const types = { ...DEFAULT_FILTERS.types };
  if (r.types && typeof r.types === 'object') for (const k of OBJECT_TYPE_CATEGORIES) types[k] = bool(r.types[k], true);
  return {
    colSelectable: bool(r.colSelectable, DEFAULT_FILTERS.colSelectable),
    colViewport: bool(r.colViewport, DEFAULT_FILTERS.colViewport),
    colRender: bool(r.colRender, DEFAULT_FILTERS.colRender),
    objects: r.objects === 'visible' || r.objects === 'selected' || r.objects === 'active' ? r.objects : 'all',
    contents: bool(r.contents, DEFAULT_FILTERS.contents),
    children: bool(r.children, DEFAULT_FILTERS.children),
    collections: bool(r.collections, DEFAULT_FILTERS.collections),
    types,
    followActive: bool(r.followActive, DEFAULT_FILTERS.followActive),
  };
}

/** Des filtres masquent-ils des éléments ? (indicateur sur le bouton ; les colonnes ne comptent pas) */
export function filtersActive(f: OutlinerFilters): boolean {
  return f.objects !== 'all' || !f.contents || !f.children || !f.collections || OBJECT_TYPE_CATEGORIES.some((k) => !f.types[k]);
}

/** Le résultat du filtrage dépend-il de la sélection ? (sinon l'outliner ne réaplatit pas à chaque clic) */
export function filtersUseSelection(f: OutlinerFilters): boolean {
  return f.objects === 'selected' || f.objects === 'active';
}

export interface SelectionContext {
  selection: ReadonlySet<string>;
  activeId: string | null;
}

const NO_SELECTION: SelectionContext = { selection: new Set(), activeId: null };

/** L'objet passe-t-il les filtres de type et d'état ? */
export function objectPasses(n: TreeNode, f: OutlinerFilters, ctx: SelectionContext = NO_SELECTION): boolean {
  if (n.kind !== 'object') return true;
  if (!f.types[objectTypeCategory(n.objType)]) return false;
  switch (f.objects) {
    case 'visible':
      return n.visible && !n.parentHidden;
    case 'selected':
      return ctx.selection.has(n.id);
    case 'active':
      return ctx.activeId === n.id;
    default:
      return true;
  }
}

export interface FlatRow {
  node: TreeNode;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

/**
 * Enfants affichés d'un nœud selon les filtres (calcul paresseux, mémorisé pour un aplatissement).
 * Un objet filtré n'apparaît pas, mais ses enfants qui passent les filtres remontent à sa place
 * (comme Blender) ; son contenu disparaît avec lui.
 */
function makeKidsFn(tree: Tree, f: OutlinerFilters, ctx: SelectionContext) {
  const memo = new Map<string, string[]>();
  const base = (n: TreeNode): string[] => {
    if (n.kind === 'collection') {
      if (n.key === ROOT_KEY && !f.collections) return f.children ? tree.topObjects : tree.allObjects;
      const out: string[] = [];
      for (const k of n.children) if (tree.nodes.get(k)?.kind === 'collection') out.push(k);
      if (f.children) {
        for (const k of n.children) if (tree.nodes.get(k)?.kind === 'object') out.push(k);
      } else out.push(...(tree.objectsByCollection.get(n.id) ?? []));
      return out;
    }
    if (n.kind === 'object') {
      if (f.contents && f.children) return n.children;
      return n.children.filter((k) => {
        const kind = tree.nodes.get(k)?.kind;
        return kind === 'content' ? f.contents : f.children;
      });
    }
    return f.contents ? n.children : [];
  };
  const kids = (key: string): string[] => {
    const cached = memo.get(key);
    if (cached) return cached;
    const node = tree.nodes.get(key);
    const out: string[] = [];
    if (node) {
      // Pile explicite : une longue chaîne d'objets filtrés ne fait pas déborder la pile d'appels.
      const stack = [...base(node)].reverse();
      while (stack.length) {
        const k = stack.pop()!;
        const n = tree.nodes.get(k);
        if (!n) continue;
        if (n.kind !== 'object' || objectPasses(n, f, ctx)) {
          out.push(k);
          continue;
        }
        if (!f.children) continue;
        const sub = n.children.filter((c) => tree.nodes.get(c)?.kind === 'object');
        for (let i = sub.length - 1; i >= 0; i--) stack.push(sub[i]);
      }
    }
    memo.set(key, out);
    return out;
  };
  return kids;
}

/**
 * Liste des lignes affichées. Les filtres s'appliquent d'abord ; avec une recherche, seuls les
 * nœuds dont le nom correspond (et leurs ancêtres affichés) sont montrés, tout déplié.
 */
export function flattenTree(
  tree: Tree,
  collapsed: ReadonlySet<string>,
  query: string,
  filters: OutlinerFilters = DEFAULT_FILTERS,
  ctx: SelectionContext = NO_SELECTION,
): FlatRow[] {
  const q = normalizeText(query.trim());
  const kids = makeKidsFn(tree, filters, ctx);
  let matches: ((key: string) => boolean) | null = null;
  if (q) {
    // Correspondance du nœud ou d'un descendant affiché, calculée de bas en haut sans récursion.
    const memo = new Map<string, boolean>();
    matches = (start: string): boolean => {
      const known = memo.get(start);
      if (known !== undefined) return known;
      const stack: [string, boolean][] = [[start, false]];
      while (stack.length) {
        const [key, done] = stack.pop()!;
        if (memo.has(key)) continue;
        const ks = kids(key);
        if (!done) {
          stack.push([key, true]);
          for (const k of ks) if (!memo.has(k)) stack.push([k, false]);
          continue;
        }
        const n = tree.nodes.get(key);
        memo.set(key, (!!n && key !== ROOT_KEY && normalizeText(n.name).includes(q)) || ks.some((k) => memo.get(k) === true));
      }
      return memo.get(start) === true;
    };
  }
  const out: FlatRow[] = [];
  const stack: [string, number][] = [[ROOT_KEY, 0]];
  while (stack.length) {
    const [key, depth] = stack.pop()!;
    const node = tree.nodes.get(key);
    if (!node) continue;
    let ks = kids(key);
    if (matches) ks = ks.filter(matches);
    const expanded = matches ? true : !collapsed.has(key);
    out.push({ node, depth, hasChildren: ks.length > 0, expanded });
    if (expanded) for (let i = ks.length - 1; i >= 0; i--) stack.push([ks[i], depth + 1]);
  }
  return out;
}

// ------------------------------------------------------------------ suivi de l'objet actif

/**
 * Nœuds repliés à déplier pour que la ligne `key` soit affichée, d'après la structure affichée
 * (objets parents si « Enfants », collections si « Collections », toujours la racine).
 */
export function keysToReveal(tree: Tree, key: string, collapsed: ReadonlySet<string>, f: OutlinerFilters = DEFAULT_FILTERS): string[] {
  const out: string[] = [];
  let cur = tree.nodes.get(key)?.parentKey ?? null;
  for (let depth = 0; cur && depth < 512; depth++) {
    const n = tree.nodes.get(cur);
    if (!n) break;
    const shown = n.key === ROOT_KEY || n.kind === 'content' || (n.kind === 'object' ? f.children : f.collections);
    if (shown && collapsed.has(cur)) out.push(cur);
    cur = n.parentKey;
  }
  return out.reverse();
}

/** Index de la ligne `key` dans les lignes affichées, ou -1. */
export function rowIndexOf(rows: readonly FlatRow[], key: string): number {
  for (let i = 0; i < rows.length; i++) if (rows[i].node.key === key) return i;
  return -1;
}

/** Défilement minimal (px) qui rend la ligne `index` entièrement visible ; null si elle l'est déjà. */
export function scrollToReveal(index: number, rowH: number, scrollTop: number, viewH: number): number | null {
  const top = index * rowH;
  if (top < scrollTop) return top;
  if (top + rowH > scrollTop + viewH) return Math.max(0, top + rowH - viewH);
  return null;
}

// ------------------------------------------------------------------ parcours

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
