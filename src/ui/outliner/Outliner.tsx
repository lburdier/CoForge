import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { FolderPlus, Search, X } from 'lucide-react';
import { getApp } from '../../app/context';
import { setSelection, store, toast, useApp } from '../../app/store';
import { ROOT_COLLECTION } from '../../core/doc/schema';
import type { SceneDoc } from '../../core/doc/SceneDoc';
import type { Peer } from '../../net/api';
import { renameObject, usePersistent, withOp, useLatest } from '../lib/util';
import { IconButton } from '../widgets/basic';
import { Menu, type UiMenuItem } from '../widgets/Menu';
import { isSelfOrDescendant, reparentKeepWorld, runOp } from '../properties/actions';
import { useDocWhen } from '../properties/docHooks';
import { OutlinerRow, ROW_H, type DropState, type PeerMark, type RowController } from './OutlinerRow';
import { buildTree, colKey, descendantKeys, flattenTree, isUnder, objKey, ROOT_KEY, type Tree } from './tree';
import './outliner.css';

/** Propriétés d'objet qui modifient l'arbre (les autres — position, modificateurs… — sont ignorées). */
const TREE_KEYS = new Set(['name', 'parent', 'collection', 'type', 'visible', 'renderable', 'data']);
/** Lignes rendues au-delà de la zone visible, de chaque côté. */
const OVERSCAN = 8;
/** Nombre maximal de nœuds repliés mémorisés. */
const MAX_COLLAPSED = 2000;

type DragPayload = { kind: 'objects'; ids: string[] } | { kind: 'collection'; id: string };

interface MenuState {
  x: number;
  y: number;
  items: UiMenuItem[];
}

// ------------------------------------------------------------------ présence des autres utilisateurs

/** Objet → utilisateurs distants qui l'ont sélectionné. Mis à jour seulement si les sélections changent. */
function usePeerMarks(): Map<string, PeerMark[]> {
  const [marks, setMarks] = useState<Map<string, PeerMark[]>>(() => new Map());
  useEffect(() => {
    const collab = getApp().collab;
    let signature = '';
    const update = (peers: Peer[]) => {
      const list = [...peers].sort((a, b) => a.clientId - b.clientId);
      let sig = '';
      for (const p of list) {
        const sel = Array.isArray(p.state?.selection) ? p.state.selection : [];
        sig += `${p.clientId}|${p.state?.user?.color ?? ''}|${p.state?.user?.name ?? ''}|${sel.join(',')};`;
      }
      if (sig === signature) return;
      signature = sig;
      const next = new Map<string, PeerMark[]>();
      for (const p of list) {
        const sel = Array.isArray(p.state?.selection) ? p.state.selection : [];
        const mark: PeerMark = { clientId: p.clientId, name: p.state?.user?.name ?? 'Utilisateur', color: p.state?.user?.color ?? '#888888' };
        for (const id of sel) {
          let arr = next.get(id);
          if (!arr) next.set(id, (arr = []));
          arr.push(mark);
        }
      }
      setMarks(next);
    };
    update(collab.getPeers());
    return collab.onPeers(update);
  }, []);
  return marks;
}

// ------------------------------------------------------------------ actions sur la scène

function existingSelection(doc: SceneDoc): string[] {
  return [...store.getState().selection].filter((id) => doc.hasObject(id));
}

/** La sélection d'objets peut-elle être modifiée maintenant ? (pas en mode édition) */
function canSelect(): boolean {
  if (store.getState().mode === 'edit') {
    toast('Sélection d’objets indisponible en mode édition (Tab pour revenir au mode objet)', 'error');
    return false;
  }
  return true;
}

function duplicateSelection(): void {
  const doc = getApp().doc;
  const ids = existingSelection(doc);
  if (!ids.length) return;
  runOp('object.duplicate', {}, (d) => {
    const copies = ids.map((id) => d.duplicateObject(id)).filter((c): c is string => !!c);
    setSelection(copies);
  });
}

function deleteSelection(): void {
  const doc = getApp().doc;
  const ids = existingSelection(doc);
  if (!ids.length) return;
  runOp('object.delete', {}, (d) => {
    for (const id of ids) d.removeObject(id);
    setSelection([], null);
  });
}

function clearParentOfSelection(): void {
  const ids = existingSelection(getApp().doc);
  if (!ids.length) return;
  runOp('object.parent_clear', {}, (d) => {
    reparentKeepWorld(d, ids, null);
  });
}

/** Sélectionne les objets sélectionnés et tous leurs descendants (hiérarchie de parentage). */
function selectHierarchy(): void {
  const doc = getApp().doc;
  const roots = existingSelection(doc);
  if (!roots.length) return;
  const children = new Map<string, string[]>();
  for (const id of doc.objectIds()) {
    const p = doc.effectiveParent(id);
    if (!p) continue;
    let list = children.get(p);
    if (!list) children.set(p, (list = []));
    list.push(id);
  }
  const out = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  setSelection(out, store.getState().activeId);
}

/** Tous les objets d'une collection et de ses sous-collections (selon l'arbre affiché). */
function objectsUnder(tree: Tree, key: string): string[] {
  return descendantKeys(tree, key)
    .map((k) => tree.nodes.get(k))
    .filter((n) => n?.kind === 'object')
    .map((n) => n!.id);
}

function uniqueCollectionName(doc: SceneDoc, id: string, wanted: string): string {
  const names = new Set(doc.listCollections().filter((c) => c.id !== id).map((c) => c.name));
  if (!names.has(wanted)) return wanted;
  for (let i = 2; i < 10000; i++) {
    const n = `${wanted} ${i}`;
    if (!names.has(n)) return n;
  }
  return wanted;
}

// ------------------------------------------------------------------ composant

/** Outliner : arbre des collections et des objets de la scène, synchronisé avec la sélection. */
export function Outliner() {
  const treeRef = useRef<Tree | null>(null);
  const tree = useDocWhen((doc) => buildTree(doc), {
    objects: (e) => e.added.length > 0 || e.removed.length > 0 || e.changed.some((c) => c.keys.some((k) => TREE_KEYS.has(k))),
    data: (e) => {
      if (e.table === 'collections') return true;
      if (e.table !== 'lights') return false;
      const known = treeRef.current?.lightKinds;
      if (!known) return true;
      const doc = getApp().doc;
      return e.changed.some((id) => known.has(id) && known.get(id) !== (doc.getLight(id)?.kind ?? 'point'));
    },
  });
  treeRef.current = tree;

  const [collapsedList, setCollapsedList] = usePersistent<string[]>('outliner.collapsed', []);
  const collapsed = useMemo(() => new Set(collapsedList), [collapsedList]);
  const [query, setQuery] = useState('');
  const rows = useMemo(() => flattenTree(tree, collapsed, query), [tree, collapsed, query]);
  const keyIndex = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => m.set(r.node.key, i));
    return m;
  }, [rows]);

  const selection = useApp((s) => s.selection);
  const activeId = useApp((s) => s.activeId);
  const peers = usePeerMarks();

  const [renaming, setRenaming] = useState<string | null>(null);
  const [currentCol, setCurrentCol] = useState<string>(ROOT_KEY);
  const [drop, setDrop] = useState<{ key: string; state: DropState } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const [viewTop, setViewTop] = useState(0);
  const [viewH, setViewH] = useState(400);
  const dragRef = useRef<DragPayload | null>(null);
  const dropRef = useRef<{ key: string; state: DropState } | null>(null);
  const anchorRef = useRef<string | null>(null);

  // Taille de la zone visible (virtualisation).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Après reconstruction de l'arbre : la collection mise en évidence ou la ligne en cours de
  // renommage ont pu disparaître (suppression à distance). Ne dépend que de l'arbre : une
  // collection tout juste créée, pas encore dans l'arbre, n'est donc pas « oubliée ».
  useEffect(() => {
    setCurrentCol((c) => (tree.nodes.has(c) ? c : ROOT_KEY));
    setRenaming((r) => (r && !tree.nodes.has(r) ? null : r));
  }, [tree]);

  // ---------------------------------------------------------------- défilement vers l'objet actif
  const scrollToIndex = (i: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const top = i * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  };
  const pending = useRef<{ key: string; seen: Tree | null } | null>(null);
  const prevActive = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (activeId !== prevActive.current) {
      prevActive.current = activeId;
      pending.current = activeId ? { key: objKey(activeId), seen: null } : null;
    }
    const p = pending.current;
    if (!p) return;
    const i = keyIndex.get(p.key);
    if (i !== undefined) {
      pending.current = null;
      scrollToIndex(i);
    } else if (p.seen && p.seen !== tree) {
      // L'arbre a été reconstruit et la ligne reste invisible (repliée, filtrée) : on abandonne.
      pending.current = null;
    } else p.seen = tree;
  }, [activeId, keyIndex, tree]);

  // ---------------------------------------------------------------- repli
  const setCollapsed = (fn: (s: Set<string>) => void) =>
    setCollapsedList((prev) => {
      const s = new Set(prev);
      fn(s);
      const out = [...s];
      return out.length > MAX_COLLAPSED ? out.slice(out.length - MAX_COLLAPSED) : out;
    });

  const expand = (key: string) => {
    if (!collapsed.has(key)) return;
    setCollapsed((s) => s.delete(key));
  };

  const newCollection = (parentKey: string) => {
    const doc = getApp().doc;
    const parentNode = tree.nodes.get(parentKey);
    const parent = parentNode?.kind === 'collection' ? parentNode.id : (parentNode?.collection ?? ROOT_COLLECTION);
    let id = '';
    withOp((d) => {
      id = d.addCollection({ parent: parent !== ROOT_COLLECTION && d.getCollection(parent) ? parent : ROOT_COLLECTION });
    });
    if (!id || !doc.getCollection(id)) return;
    expand(colKey(parent));
    setCurrentCol(colKey(id));
    pending.current = { key: colKey(id), seen: null };
    if (!query.trim()) setRenaming(colKey(id));
  };

  const deleteCollection = (id: string) => {
    if (id === ROOT_COLLECTION) return;
    withOp((d) => d.removeCollection(id));
  };

  // ---------------------------------------------------------------- glisser-déposer
  /** Validité d'un dépôt de `payload` sur le nœud `key`. */
  const dropStateFor = (payload: DragPayload, key: string): DropState => {
    const doc = getApp().doc;
    const target = tree.nodes.get(key);
    if (!target) return 'invalid';
    if (payload.kind === 'collection') {
      if (target.kind !== 'collection') return 'invalid';
      if (!doc.getCollection(payload.id)) return 'invalid';
      return isUnder(tree, key, colKey(payload.id)) ? 'invalid' : 'ok';
    }
    if (target.kind === 'collection') return payload.ids.length ? 'ok' : 'invalid';
    // objet → objet : parentage, sans boucle
    if (payload.ids.includes(target.id)) return 'invalid';
    return payload.ids.some((id) => isSelfOrDescendant(doc, target.id, id)) ? 'invalid' : 'ok';
  };

  const performDrop = (payload: DragPayload, key: string) => {
    const target = tree.nodes.get(key);
    if (!target) return;
    if (payload.kind === 'collection') {
      withOp((d) => {
        if (d.getCollection(payload.id)) d.updateCollection(payload.id, { parent: target.id });
      });
      expand(key);
      return;
    }
    const doc = getApp().doc;
    const ids = payload.ids.filter((id) => doc.hasObject(id));
    if (!ids.length) return;
    if (target.kind === 'collection') {
      // Objet(s) → collection : changement de collection ; les enfants affichés sous eux suivent.
      // Un objet affiché sous son parent et sorti sans lui est libéré de son parent (transformation
      // monde conservée), comme le « déposer pour libérer le parent » de Blender. Un objet dont le
      // parent est dans une autre collection (affiché au premier niveau) garde son parent.
      const moved = new Set<string>();
      for (const id of ids) {
        moved.add(id);
        for (const k of descendantKeys(tree, objKey(id))) {
          const n = tree.nodes.get(k);
          if (n?.kind === 'object') moved.add(n.id);
        }
      }
      const unparent = ids.filter((id) => {
        const parentKey = tree.nodes.get(objKey(id))?.parentKey;
        const parentNode = parentKey ? tree.nodes.get(parentKey) : undefined;
        return parentNode?.kind === 'object' && !moved.has(parentNode.id);
      });
      withOp((d) => {
        if (unparent.length) reparentKeepWorld(d, unparent, null);
        for (const id of moved) d.updateObject(id, { collection: target.id });
      });
      expand(key);
      return;
    }
    // Objet(s) → objet : parentage en conservant la transformation monde, puis rangement dans la
    // collection du parent (avec les enfants affichés sous eux) pour que le résultat soit visible.
    const accepted = ids.filter((id) => !isSelfOrDescendant(doc, target.id, id));
    const follow = new Set<string>();
    for (const id of accepted) {
      follow.add(id);
      for (const k of descendantKeys(tree, objKey(id))) {
        const n = tree.nodes.get(k);
        if (n?.kind === 'object') follow.add(n.id);
      }
    }
    let refused = 0;
    withOp((d) => {
      refused = reparentKeepWorld(d, ids, target.id).refused;
      for (const id of follow) {
        if (d.getObject(id)?.collection !== target.collection) d.updateObject(id, { collection: target.collection });
      }
    });
    if (refused) toast(`${refused} objet(s) non parenté(s) : cela créerait une boucle`, 'error');
    expand(key);
  };

  const setDropTarget = (next: { key: string; state: DropState } | null) => {
    const cur = dropRef.current;
    if (cur?.key === next?.key && cur?.state === next?.state) return;
    dropRef.current = next;
    setDrop(next);
  };

  const clearDrag = () => {
    dragRef.current = null;
    setDropTarget(null);
  };

  // ---------------------------------------------------------------- contrôleur des lignes (référence stable)
  const handlers: RowController = {
    click(e, key) {
      rootRef.current?.focus({ preventScroll: true });
      const node = tree.nodes.get(key);
      if (!node) return;
      if (node.kind === 'collection') {
        setCurrentCol(key);
        return;
      }
      if (!canSelect()) return;
      const s = store.getState();
      const id = node.id;
      if (e.shiftKey) {
        const anchor = anchorRef.current && keyIndex.has(anchorRef.current) ? anchorRef.current : s.activeId ? objKey(s.activeId) : key;
        const a = keyIndex.get(anchor) ?? keyIndex.get(key)!;
        const b = keyIndex.get(key)!;
        const range: string[] = [];
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
          const n = rows[i]?.node;
          if (n?.kind === 'object') range.push(n.id);
        }
        const base = e.ctrlKey || e.metaKey ? [...s.selection] : [];
        setSelection([...base.filter((x) => !range.includes(x)), ...range.filter((x) => x !== id), id], id);
        if (!anchorRef.current) anchorRef.current = anchor;
      } else if (e.ctrlKey || e.metaKey) {
        const sel = new Set(s.selection);
        if (sel.has(id)) {
          sel.delete(id);
          setSelection(sel, s.activeId === id ? undefined : s.activeId);
        } else {
          sel.add(id);
          setSelection(sel, id);
        }
        anchorRef.current = key;
      } else {
        setSelection([id], id);
        anchorRef.current = key;
      }
    },
    doubleClick(key) {
      if (key !== ROOT_KEY && tree.nodes.has(key)) setRenaming(key);
    },
    contextMenu(e, key) {
      e.preventDefault();
      e.stopPropagation();
      const node = tree.nodes.get(key);
      if (!node) return;
      let items: UiMenuItem[];
      if (node.kind === 'object') {
        const s = store.getState();
        if (!s.selection.has(node.id) && s.mode !== 'edit') {
          setSelection([node.id], node.id);
          anchorRef.current = key;
        }
        const doc = getApp().doc;
        const hasParent = existingSelection(doc).some((id) => doc.effectiveParent(id));
        // En mode édition, les opérations sur la sélection d'objets sont indisponibles.
        const edit = s.mode === 'edit';
        items = [
          { label: 'Renommer', shortcut: 'F2', action: () => setRenaming(key) },
          { label: 'Dupliquer', shortcut: 'Maj+D', disabled: edit, action: duplicateSelection },
          { label: 'Supprimer', shortcut: 'X', disabled: edit, action: deleteSelection },
          { separator: true },
          { label: 'Sélectionner la hiérarchie', disabled: edit, action: selectHierarchy },
          { label: 'Libérer le parent', shortcut: 'Alt+P', disabled: edit || !hasParent, action: clearParentOfSelection },
          { separator: true },
          { label: 'Nouvelle collection', action: () => newCollection(colKey(node.collection)) },
        ];
      } else if (node.key === ROOT_KEY) {
        items = [
          { label: 'Nouvelle collection', action: () => newCollection(ROOT_KEY) },
          {
            label: 'Sélectionner tous les objets',
            disabled: tree.objectCount === 0,
            action: () => {
              if (canSelect()) setSelection(objectsUnder(tree, ROOT_KEY));
            },
          },
        ];
        setCurrentCol(ROOT_KEY);
      } else {
        setCurrentCol(key);
        const objs = objectsUnder(tree, key);
        items = [
          { label: 'Renommer', shortcut: 'F2', action: () => setRenaming(key) },
          { label: 'Nouvelle collection', action: () => newCollection(key) },
          {
            label: 'Sélectionner les objets',
            disabled: objs.length === 0,
            action: () => {
              if (canSelect()) setSelection(objs);
            },
          },
          {
            label: node.visible ? 'Masquer la collection' : 'Afficher la collection',
            action: () => getApp().doc.updateCollection(node.id, { visible: !node.visible }),
          },
          { separator: true },
          { label: 'Supprimer la collection', action: () => deleteCollection(node.id) },
        ];
      }
      setMenu({ x: e.clientX, y: e.clientY, items });
    },
    toggleExpand(key, recursive) {
      const opening = collapsed.has(key);
      const keys = recursive ? [key, ...descendantKeys(tree, key).filter((k) => (tree.nodes.get(k)?.children.length ?? 0) > 0)] : [key];
      setCollapsed((s) => {
        for (const k of keys) {
          if (opening) s.delete(k);
          else s.add(k);
        }
      });
    },
    toggleVisible(key) {
      const node = tree.nodes.get(key);
      if (!node) return;
      const doc = getApp().doc;
      if (node.kind === 'object') {
        const o = doc.getObject(node.id);
        if (o) doc.updateObject(node.id, { visible: !o.visible });
      } else {
        const c = doc.getCollection(node.id);
        if (c) doc.updateCollection(node.id, { visible: !c.visible });
      }
    },
    toggleRenderable(key) {
      const node = tree.nodes.get(key);
      if (node?.kind !== 'object') return;
      const doc = getApp().doc;
      const o = doc.getObject(node.id);
      if (o) doc.updateObject(node.id, { renderable: !o.renderable });
    },
    commitRename(key, name) {
      const node = tree.nodes.get(key);
      if (!node) return;
      const text = name.trim();
      if (!text) return;
      if (node.kind === 'object') renameObject(node.id, text);
      else if (node.key !== ROOT_KEY) {
        const doc = getApp().doc;
        const c = doc.getCollection(node.id);
        if (c && c.name !== text) doc.updateCollection(node.id, { name: uniqueCollectionName(doc, node.id, text) });
      }
    },
    endRename() {
      setRenaming(null);
      rootRef.current?.focus({ preventScroll: true });
    },
    dragStart(e, key) {
      const node = tree.nodes.get(key);
      if (!node || node.key === ROOT_KEY || renaming) {
        e.preventDefault();
        return;
      }
      let payload: DragPayload;
      let label: string;
      if (node.kind === 'collection') {
        payload = { kind: 'collection', id: node.id };
        label = node.name;
      } else {
        const sel = store.getState().selection;
        const doc = getApp().doc;
        const ids = sel.has(node.id) ? [...sel].filter((id) => doc.hasObject(id)) : [node.id];
        payload = { kind: 'objects', ids };
        label = ids.length > 1 ? `${ids.length} objets` : node.name;
      }
      dragRef.current = payload;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', label);
    },
    dragOver(e, key) {
      const payload = dragRef.current;
      if (!payload) return;
      e.stopPropagation();
      const state = dropStateFor(payload, key);
      if (state === 'ok') {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }
      setDropTarget({ key, state });
    },
    drop(e, key) {
      const payload = dragRef.current;
      e.preventDefault();
      e.stopPropagation();
      clearDrag();
      if (!payload || dropStateFor(payload, key) !== 'ok') return;
      performDrop(payload, key);
    },
    dragEnd() {
      clearDrag();
    },
  };
  const latest = useLatest(handlers);
  const ctl = useMemo<RowController>(() => {
    const out = {} as RowController;
    for (const k of Object.keys(handlers) as (keyof RowController)[]) {
      (out as any)[k] = (...args: any[]) => (latest.current[k] as (...a: any[]) => void)(...args);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------- clavier (outliner survolé et focalisé)
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, [contenteditable="true"]')) return;
    const s = store.getState();
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === 'F2') {
      handled();
      const k = s.activeId && tree.nodes.has(objKey(s.activeId)) ? objKey(s.activeId) : currentCol !== ROOT_KEY ? currentCol : null;
      if (k) setRenaming(k);
    } else if ((e.key === 'Delete' || e.key === 'x' || e.key === 'X') && !e.ctrlKey && !e.altKey && !e.metaKey) {
      handled();
      if (s.mode !== 'edit') deleteSelection();
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.altKey) {
      handled();
      if (!canSelect()) return;
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      const start = s.activeId ? (keyIndex.get(objKey(s.activeId)) ?? -1) : -1;
      for (let i = start + dir; i >= 0 && i < rows.length; i += dir) {
        const n = rows[i].node;
        if (n.kind !== 'object') continue;
        if (e.shiftKey) setSelection([...s.selection, n.id], n.id);
        else setSelection([n.id], n.id);
        anchorRef.current = n.key;
        break;
      }
    } else if (e.key === 'f' && (e.ctrlKey || e.metaKey)) {
      handled();
      filterRef.current?.focus();
      filterRef.current?.select();
    } else if (e.key === 'Escape' && query) {
      handled();
      setQuery('');
    }
  };

  // ---------------------------------------------------------------- rendu fenêtré
  const total = rows.length;
  const first = Math.max(0, Math.floor(viewTop / ROW_H) - OVERSCAN);
  const last = Math.min(total, Math.ceil((viewTop + viewH) / ROW_H) + OVERSCAN);
  const visible = rows.slice(first, last);

  return (
    <div ref={rootRef} className="cf-outliner" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="cf-ol-header">
        <div className="cf-ol-search">
          <Search size={12} className="cf-ol-search-icon" />
          <input
            ref={filterRef}
            className="cf-ol-search-input"
            value={query}
            placeholder="Filtrer par nom…"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') {
                setQuery('');
                rootRef.current?.focus({ preventScroll: true });
              } else if (e.key === 'Enter') rootRef.current?.focus({ preventScroll: true });
            }}
          />
          {query && (
            <button type="button" tabIndex={-1} className="cf-ol-search-clear" data-tip="Effacer le filtre" onClick={() => setQuery('')}>
              <X size={11} />
            </button>
          )}
        </div>
        <IconButton
          icon={FolderPlus}
          tip={
            currentCol === ROOT_KEY
              ? 'Nouvelle collection'
              : `Nouvelle collection dans « ${tree.nodes.get(currentCol)?.name ?? ''} »`
          }
          onClick={() => newCollection(currentCol)}
        />
      </div>
      <div
        ref={scrollRef}
        className="cf-ol-scroll"
        onScroll={(e) => setViewTop(e.currentTarget.scrollTop)}
        onClick={(e) => {
          // Clic dans le vide : tout désélectionner (comme Blender).
          if (e.target === e.currentTarget || (e.target as Element).classList.contains('cf-ol-canvas')) {
            if (store.getState().mode !== 'edit' && store.getState().selection.size) setSelection([], null);
            setCurrentCol(ROOT_KEY);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, items: [{ label: 'Nouvelle collection', action: () => newCollection(ROOT_KEY) }] });
        }}
        onDragOverCapture={(e) => {
          if (!dragRef.current) return;
          // Défilement automatique près des bords pendant un glisser.
          const el = e.currentTarget;
          const r = el.getBoundingClientRect();
          if (e.clientY < r.top + 24) el.scrollTop -= 10;
          else if (e.clientY > r.bottom - 24) el.scrollTop += 10;
        }}
        onDragOver={(e) => ctl.dragOver(e, ROOT_KEY)}
        onDrop={(e) => ctl.drop(e, ROOT_KEY)}
        onDragLeave={(e) => {
          const next = e.relatedTarget as Node | null;
          if (!next || !e.currentTarget.contains(next)) setDropTarget(null);
        }}
      >
        <div className="cf-ol-canvas" style={{ height: Math.max(total * ROW_H, 1) }}>
          {visible.map((r, i) => {
            const index = first + i;
            const n = r.node;
            const isObj = n.kind === 'object';
            return (
              <OutlinerRow
                key={n.key}
                node={n}
                depth={r.depth}
                hasChildren={r.hasChildren}
                expanded={r.expanded}
                index={index}
                selected={isObj && selection.has(n.id)}
                active={isObj && activeId === n.id}
                current={!isObj && currentCol === n.key}
                renaming={renaming === n.key}
                drop={drop?.key === n.key ? drop.state : null}
                peers={isObj ? peers.get(n.id) : undefined}
                ctl={ctl}
              />
            );
          })}
        </div>
        {tree.objectCount === 0 && !query && <div className="cf-ol-empty">Scène vide — Maj+A dans le viewport pour ajouter un objet.</div>}
        {query && total <= 1 && <div className="cf-ol-empty">Aucun élément ne correspond à « {query} ».</div>}
      </div>
      {menu && <Menu items={menu.items} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
    </div>
  );
}
