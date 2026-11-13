import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Maximize, Network, PanelRight, Plus, Search } from 'lucide-react';
import { getApp } from '../../app/context';
import { toast, useApp } from '../../app/store';
import type { NodeData, NodeLink, NodeTreeData } from '../../core/doc/schema';
import { compileShaderTree } from '../../core/nodes/shaderCompile';
import { categoryColor } from '../../core/nodes/shaderNodes';
import { nodeType, nodeTypes, socketsCompatible, type NodeTreeKind, type NodeTypeDef, type SocketType } from '../../core/nodes/types';
import { useDocWhen, useObject } from '../properties/docHooks';
import { Menu, MenuBar, type MenuBarEntry, type UiMenuItem } from '../widgets/Menu';
import { ColorField, Hint, IconButton, Select, TextField } from '../widgets/basic';
import { NumberField } from '../widgets/NumberField';
import { FRAME_HEADER, linkedInputs, linkPath, linkPoints, nodeLayout, nodeRects, segmentsIntersect, SOCKET_COLORS, socketPosition, type Rect } from './layout';
import { NodeView, type NodeEdit } from './NodeView';
import * as ops from './treeOps';
import * as nw from './wrangler';
import { commitTree, createNodeMaterial, toggleUseNodes } from './commit';
import { addMenuTypes, applyBox, boxHits, englishName, frameView, orderedCategories, screenToTree, searchNodeTypes, supportNote, treeToScreen, zoomAt, type View } from './editorLogic';
import { useNodeWrangler } from './nodeWrangler';
import './nodes.css';
import { EditorTypeButton, useArea } from '../layout/editorTypes';
import { isEditableElement } from '../../tools/util';

const EMPTY = new Set<string>();

// ------------------------------------------------------------------ état mémorisé par arbre

const views = new Map<string, View>();
const selections = new Map<string, { sel: Set<string>; active: string | null }>();
let clipboard: ops.Tree | null = null;

// ------------------------------------------------------------------ éditeur (en-tête + canevas)

/** Éditeur de shaders : arbre de nœuds du matériau de l'objet actif. */
export function ShaderEditor() {
  const area = useArea();
  const activeId = useApp((s) => s.activeId);
  const obj = useObject(activeId);
  const materials = useDocWhen((doc) => doc.listMaterials(), { data: (e) => e.table === 'materials' });
  const mat = obj?.material ? (materials.find((m) => m.id === obj.material) ?? null) : null;
  const treeId = mat && mat.useNodes !== false ? (mat.nodeTree ?? null) : null;
  const tree = useDocWhen((doc) => (treeId ? doc.getNodeTree(treeId) : null), { data: (e) => e.table === 'nodeTrees' }, [treeId]);
  const [sidebar, setSidebar] = useState(true);
  const [menuSlot, setMenuSlot] = useState<HTMLDivElement | null>(null);

  const canHaveMaterial = obj?.type === 'mesh';

  const assign = (id: string) => {
    if (!obj) return;
    getApp().doc.updateObject(obj.id, { material: id });
  };
  const createMaterial = () => {
    if (obj) createNodeMaterial(obj.id);
  };
  const toggleNodes = () => {
    if (mat) toggleUseNodes(mat.id);
  };

  const notes = useMemo(() => (tree ? compileShaderTree(tree).notes : []), [tree]);

  return (
    <div className="cf-ne">
      <div className="cf-ne-header">
        {area ? <EditorTypeButton /> : <Network size={14} className="cf-ne-icon" />}
        <span className="cf-ne-title">Éditeur de shaders</span>
        <div ref={setMenuSlot} className="cf-ne-menus" />
        {canHaveMaterial && (
          <>
            <Select
              value={mat?.id ?? ''}
              placeholder="Aucun matériau"
              options={materials.map((m) => ({ value: m.id, label: m.name }))}
              onChange={assign}
              tip="Matériau de l’objet actif"
            />
            <IconButton icon={Plus} tip="Nouveau matériau à nœuds pour l’objet actif" onClick={createMaterial} />
            {mat && (
              <button type="button" className={`cf-btn cf-ne-usenodes${treeId ? ' is-on' : ''}`} onClick={toggleNodes} data-tip="Utiliser les nœuds pour ce matériau">
                Utiliser les nœuds
              </button>
            )}
          </>
        )}
        <div className="cf-spacer" />
        {notes.length > 0 && (
          <span className="cf-ne-notes" data-tip={notes.join('\n')}>
            <AlertTriangle size={13} /> {notes.length} approximation{notes.length > 1 ? 's' : ''}
          </span>
        )}
        <IconButton icon={PanelRight} tip="Barre latérale (N)" active={sidebar} onClick={() => setSidebar((v) => !v)} />
      </div>
      {!obj && <Hint className="cf-ne-empty">Sélectionnez un objet pour éditer son matériau.</Hint>}
      {obj && !canHaveMaterial && <Hint className="cf-ne-empty">Seuls les maillages ont un matériau.</Hint>}
      {canHaveMaterial && !mat && (
        <div className="cf-ne-empty">
          <button type="button" className="cf-btn" onClick={createMaterial}>
            <Plus size={13} /> Nouveau matériau
          </button>
        </div>
      )}
      {mat && !treeId && (
        <div className="cf-ne-empty">
          <button type="button" className="cf-btn" onClick={toggleNodes}>
            Utiliser les nœuds
          </button>
          <Hint>Le matériau « {mat.name} » est en mode simple : passez aux nœuds pour le Principled BSDF complet et les textures procédurales.</Hint>
        </div>
      )}
      {tree && treeId && <NodeCanvas kind="shader" key={treeId} tree={tree} treeId={treeId} materialId={mat?.id ?? null} sidebar={sidebar} setSidebar={setSidebar} notes={notes} menuSlot={menuSlot} />}
    </div>
  );
}

// ------------------------------------------------------------------ canevas

type Drag =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | { kind: 'press'; sx: number; sy: number; node: string | null; shift: boolean; ctrl: boolean }
  | { kind: 'move'; ids: Set<string>; ox: number; oy: number; dx: number; dy: number; modal: boolean; pending: ops.TreePatch | null; added: boolean }
  | { kind: 'box'; x0: number; y0: number; x1: number; y1: number; mode: 'set' | 'add' | 'sub' }
  | { kind: 'link'; node: string; socket: string; fromOutput: boolean; type: SocketType; x: number; y: number; detached: NodeLink | null }
  | { kind: 'cut'; pts: [number, number][]; reroute: boolean }
  | { kind: 'lazy'; from: string; x: number; y: number; menu: boolean; mix: boolean }
  | { kind: 'rmb'; sx: number; sy: number };

interface AddMenuState {
  x: number;
  y: number;
  /** Position dans l'arbre où poser le nœud. */
  tx: number;
  ty: number;
  /** Lien en attente (lâché dans le vide) : le nouveau nœud s'y branche. */
  link?: { node: string; socket: string; fromOutput: boolean; type: SocketType };
}

interface CanvasProps {
  /** Système nodal : shader (matériau) ou géométrie (modificateur). */
  kind: NodeTreeKind;
  tree: NodeTreeData;
  treeId: string;
  materialId: string | null;
  sidebar: boolean;
  setSidebar(v: boolean | ((p: boolean) => boolean)): void;
  notes: string[];
  /** Emplacement des menus Vue / Sélection / Ajouter / Nœud dans l'en-tête. */
  menuSlot: HTMLDivElement | null;
}

export function NodeCanvas({ kind, tree, treeId, materialId, sidebar, setSidebar, notes, menuSlot }: CanvasProps) {
  const KIND = kind;
  const rootRef = useRef<HTMLDivElement>(null);
  const [view, setViewState] = useState<View>(() => views.get(treeId) ?? { x: 0, y: 0, z: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const setView = useCallback(
    (v: View) => {
      views.set(treeId, v);
      setViewState(v);
    },
    [treeId],
  );
  const initialSel = selections.get(treeId) ?? { sel: new Set<string>(), active: null };
  const [sel, setSelState] = useState<Set<string>>(initialSel.sel);
  const [active, setActiveState] = useState<string | null>(initialSel.active);
  const setSel = (s: Set<string>, a: string | null = active) => {
    selections.set(treeId, { sel: s, active: a });
    setSelState(s);
    setActiveState(a);
  };
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const [menu, setMenu] = useState<{ x: number; y: number; items: UiMenuItem[]; title?: string } | null>(null);
  const [addMenu, setAddMenu] = useState<AddMenuState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const mouse = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
  const previewCycle = useRef(new Map<string, number>());
  const wrangler = useNodeWrangler();

  const commit = useCallback((fn: (t: ops.Tree) => boolean | void) => commitTree(treeId, materialId, fn), [treeId, materialId]);

  // ---------------------------------------------------------------- arbre affiché (aperçu des glissements)

  const shown: ops.Tree = useMemo(() => {
    if (drag?.kind === 'move') {
      // Le geste en cours (nœud ajouté, dupliqué…) est rejoué sur l'arbre ACTUEL : une
      // modification d'un autre utilisateur pendant le glissé reste visible et n'est pas écrasée.
      let base: ops.Tree = tree;
      if (drag.pending) {
        base = ops.cloneTree(tree);
        ops.applyPatch(base, drag.pending);
      }
      const nodes = { ...base.nodes };
      for (const id of drag.ids) if (nodes[id]) nodes[id] = { ...nodes[id], x: nodes[id].x + drag.dx, y: nodes[id].y + drag.dy };
      return { nodes, links: base.links };
    }
    if (drag?.kind === 'link' && drag.detached) return { nodes: tree.nodes, links: tree.links.filter((l) => l.id !== drag.detached!.id) };
    return tree;
  }, [tree, drag]);

  const linked = useMemo(() => linkedInputs(shown), [shown]);
  const rects = useMemo(() => nodeRects(KIND, shown, linked), [shown, linked]);

  // Cadrage initial : tout l'arbre visible.
  const frameRects = useCallback(
    (only?: Set<string>) => {
      const el = rootRef.current;
      if (!el) return;
      const list = [...rects.entries()].filter(([id]) => !only || only.has(id)).map(([, r]) => r);
      const v = frameView(list, el.clientWidth - (sidebar ? 240 : 0), el.clientHeight);
      if (v) setView(v);
    },
    [rects, setView, sidebar],
  );
  const framed = useRef(views.has(treeId));
  useLayoutEffect(() => {
    if (framed.current || !rootRef.current?.clientWidth) return;
    framed.current = true;
    frameRects();
  });

  // ---------------------------------------------------------------- coordonnées

  const toTree = (clientX: number, clientY: number) => {
    const r = rootRef.current!.getBoundingClientRect();
    return screenToTree(viewRef.current, clientX - r.left, clientY - r.top);
  };

  const socketAt = (x: number, y: number): { node: string; socket: string; dir: 'in' | 'out'; type: SocketType } | null => {
    const radius = Math.max(8, 11 / viewRef.current.z);
    let best: { node: string; socket: string; dir: 'in' | 'out'; type: SocketType; d: number } | null = null;
    for (const n of Object.values(shown.nodes)) {
      const r = rects.get(n.id);
      if (!r || x < r.x - radius || x > r.x + r.w + radius || y < r.y - radius || y > r.y + r.h + radius) continue;
      const l = nodeLayout(KIND, n, linked.get(n.id) ?? EMPTY);
      const ox = nodeType(KIND, n.type)?.layout === 'reroute' ? r.x : n.x;
      const oy = nodeType(KIND, n.type)?.layout === 'reroute' ? r.y : n.y;
      for (const [key, s] of l.sockets) {
        const d = Math.hypot(ox + s.x - x, oy + s.y - y) + (s.folded ? 4 : 0);
        if (d <= radius && (!best || d < best.d)) {
          const dir = key.startsWith('in:') ? 'in' : 'out';
          best = { node: n.id, socket: key.slice(dir === 'in' ? 3 : 4), dir, type: s.type, d };
        }
      }
    }
    return best;
  };

  const nodeAt = (x: number, y: number): string | null => {
    let frameHit: string | null = null;
    const list = Object.values(shown.nodes);
    for (let i = list.length - 1; i >= 0; i--) {
      const n = list[i];
      const r = rects.get(n.id);
      if (!r || x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) continue;
      if (nodeType(KIND, n.type)?.layout === 'frame') {
        if (!frameHit) frameHit = n.id;
        continue;
      }
      return n.id;
    }
    return frameHit;
  };

  /** Lien sous un point (pour y intercaler un nœud). */
  const linkNear = (x: number, y: number, exclude: Set<string>): NodeLink | null => {
    const tol = 10 / viewRef.current.z;
    for (const l of tree.links) {
      if (exclude.has(l.fromNode) || exclude.has(l.toNode)) continue;
      const a = shown.nodes[l.fromNode];
      const b = shown.nodes[l.toNode];
      if (!a || !b) continue;
      const p1 = socketPosition(KIND, a, 'out', l.fromSocket, linked.get(a.id) ?? EMPTY);
      const p2 = socketPosition(KIND, b, 'in', l.toSocket, linked.get(b.id) ?? EMPTY);
      if (!p1 || !p2) continue;
      if (linkPoints(p1.x, p1.y, p2.x, p2.y, 32).some(([px, py]) => Math.hypot(px - x, py - y) < tol)) return l;
    }
    return null;
  };

  // ---------------------------------------------------------------- édition des valeurs

  const edit: NodeEdit = useMemo(
    () => ({
      input: (id, socket, value) =>
        commit((t) => {
          if (!t.nodes[id]) return false;
          t.nodes[id].inputs = { ...t.nodes[id].inputs, [socket]: value };
        }),
      prop: (id, prop, value) =>
        commit((t) => {
          if (!t.nodes[id]) return false;
          t.nodes[id].props = { ...t.nodes[id].props, [prop]: value };
        }),
      togglePanel: (id, panel) =>
        commit((t) => {
          const n = t.nodes[id];
          if (!n) return false;
          const open = new Set(Array.isArray(n.props?._panels) ? (n.props._panels as string[]) : []);
          if (open.has(panel)) open.delete(panel);
          else open.add(panel);
          n.props = { ...n.props, _panels: [...open] };
        }),
      toggleCollapse: (id) =>
        commit((t) => {
          if (!t.nodes[id]) return false;
          t.nodes[id].collapsed = !t.nodes[id].collapsed;
        }),
    }),
    [commit],
  );

  // ---------------------------------------------------------------- actions

  const selected = () => [...sel].filter((id) => tree.nodes[id]);

  const startGrab = (ids: Iterable<string>, pending: ops.TreePatch | null, added: boolean) => {
    let base: ops.Tree = tree;
    if (pending) {
      base = ops.cloneTree(tree);
      ops.applyPatch(base, pending);
    }
    const moving = ops.withFrameChildren(base, ids);
    if (moving.size === 0) return;
    setDrag({ kind: 'move', ids: moving, ox: mouse.current.tx, oy: mouse.current.ty, dx: 0, dy: 0, modal: true, pending, added });
  };

  const finishMove = (d: Extract<Drag, { kind: 'move' }>) => {
    const dx = Math.round(d.dx);
    const dy = Math.round(d.dy);
    if (!d.pending && dx === 0 && dy === 0) return;
    commit((t) => {
      if (d.pending) ops.applyPatch(t, d.pending);
      for (const id of d.ids) if (t.nodes[id]) (t.nodes[id].x += dx), (t.nodes[id].y += dy);
      // Un seul nœud lâché sur un lien : il s'y intercale (comme dans Blender).
      const single = [...d.ids].filter((id) => !nodeType(KIND, t.nodes[id]?.type ?? '')?.layout);
      if (single.length === 1 && !t.links.some((l) => l.fromNode === single[0] || l.toNode === single[0])) {
        const r = nodeRects(KIND, t).get(single[0]);
        if (r) {
          const l = linkNear(r.x + r.w / 2, r.y + FRAME_HEADER / 2, d.ids) ?? linkNear(r.x + r.w / 2, r.y + r.h / 2, d.ids);
          if (l) ops.insertOnLink(KIND, t, single[0], l.id);
        }
      }
    });
  };

  const addNodeAt = (type: string, x: number, y: number, link?: AddMenuState['link']) => {
    const t = ops.cloneTree(tree);
    const n = ops.createNode(KIND, type, x - 20, y - 12);
    ops.addNode(t, n);
    if (link) {
      if (link.fromOutput) {
        const inp = ops.firstFreeInput(KIND, t, n, link.type);
        if (inp) ops.connect(KIND, t, link.node, link.socket, n.id, inp.id);
      } else {
        const out = ops.outputsOf(KIND, n).find((o) => socketsCompatible(o.type, link.type));
        if (out) ops.connect(KIND, t, n.id, out.id, link.node, link.socket);
      }
    }
    setSel(new Set([n.id]), n.id);
    mouse.current.tx = x;
    mouse.current.ty = y;
    startGrab([n.id], ops.diffTrees(tree, t), true);
  };

  const deleteSelected = (dissolve: boolean) => {
    const ids = selected();
    if (!ids.length) return;
    commit((t) => (dissolve ? ops.dissolveNodes(KIND, t, ids) : ops.removeNodes(t, ids)));
    setSel(new Set(), null);
  };

  const duplicate = () => {
    const ids = selected();
    if (!ids.length) return;
    const t = ops.cloneTree(tree);
    const fresh = ops.duplicateNodes(t, ids, 0, 0);
    setSel(new Set(fresh), fresh[ids.indexOf(active ?? '')] ?? fresh[0]);
    startGrab(fresh, ops.diffTrees(tree, t), true);
  };

  const copy = () => {
    const ids = selected();
    if (!ids.length) return;
    clipboard = ops.extractNodes(tree, ids);
    toast(`${ids.length} nœud${ids.length > 1 ? 's' : ''} copié${ids.length > 1 ? 's' : ''}.`);
  };
  const paste = () => {
    if (!clipboard) return;
    let fresh: string[] = [];
    commit((t) => {
      fresh = ops.pasteNodes(t, clipboard!, mouse.current.tx, mouse.current.ty);
    });
    setSel(new Set(fresh), fresh[0] ?? null);
  };

  const toggleFlag = (flag: 'collapsed' | 'muted') => {
    const ids = selected();
    if (!ids.length) return;
    const on = !ids.every((id) => tree.nodes[id][flag]);
    commit((t) => {
      for (const id of ids) if (t.nodes[id] && !nodeType(KIND, t.nodes[id].type)?.layout) t.nodes[id][flag] = on;
    });
  };

  const preview = (id: string) => {
    const c = previewCycle.current.get(id) ?? 0;
    let shownSock: string | null = null;
    commit((t) => {
      shownSock = ops.previewNode(KIND, t, id, c);
      return shownSock !== null;
    });
    previewCycle.current.set(id, c + 1);
    if (!shownSock) toast('Aperçu impossible : ce nœud n’a pas de sortie (ou l’aperçu fermerait une boucle).', 'error');
  };

  const merge = (mode: ops.MergeMode) => {
    const ids = selected();
    if (ids.length < 2) return toast('Sélectionnez au moins deux nœuds à fusionner.', 'error');
    let last: string | null = null;
    commit((t) => {
      last = ops.mergeNodes(KIND, t, ids, mode);
      return last !== null;
    });
    if (last) setSel(new Set([last]), last);
  };

  const viewAll = () => frameRects();
  const viewSelected = () => frameRects(new Set(selected()));

  // ---------------------------------------------------------------- menus

  const openAddMenu = (link?: AddMenuState['link']) => {
    const r = rootRef.current!.getBoundingClientRect();
    const sp = treeToScreen(viewRef.current, mouse.current.tx, mouse.current.ty);
    setAddMenu({ x: r.left + sp.x, y: r.top + sp.y, tx: mouse.current.tx, ty: mouse.current.ty, link });
  };

  const switchMenu = (x: number, y: number) => {
    const ids = selected();
    if (!ids.length) return;
    const cat = nodeType(KIND, tree.nodes[active ?? ids[0]]?.type ?? '')?.category;
    const defs = nodeTypes(KIND).filter((d) => !d.layout && !d.id.startsWith('ShaderNodeOutput') && d.id !== 'GeometryNodeGroupOutput');
    const items: UiMenuItem[] = orderedCategories(defs).map((c) => ({
      label: c,
      children: defs
        .filter((d) => d.category === c)
        .map((d) => ({ label: d.label, action: () => commit((t) => ops.switchType(KIND, t, ids, d.id) > 0) })),
    }));
    // Catégorie du nœud actif en premier.
    items.sort((a, b) => (a.label === cat ? -1 : b.label === cat ? 1 : 0));
    setMenu({ x, y, items, title: 'Changer le type (Maj+S)' });
  };

  const contextMenu = (x: number, y: number, node: string | null) => {
    const has = sel.size > 0;
    const items: UiMenuItem[] = [
      { label: 'Ajouter un nœud…', shortcut: 'Maj+A', action: () => openAddMenu() },
      { separator: true },
      { label: 'Déplacer', shortcut: 'G', disabled: !has, action: () => startGrab(selected(), null, false) },
      { label: 'Dupliquer', shortcut: 'Maj+D', disabled: !has, action: duplicate },
      { label: 'Copier', shortcut: 'Ctrl+C', disabled: !has, action: copy },
      { label: 'Coller', shortcut: 'Ctrl+V', disabled: !clipboard, action: paste },
      { label: 'Supprimer', shortcut: 'X', disabled: !has, action: () => deleteSelected(false) },
      { label: 'Supprimer en reconnectant', shortcut: 'Ctrl+X', disabled: !has, action: () => deleteSelected(true) },
      { separator: true },
      { label: 'Relier les sélectionnés', shortcut: 'F', disabled: sel.size < 2, action: () => commit((t) => ops.makeLinks(KIND, t, selected()) > 0) },
      { label: 'Réduire / déplier', shortcut: 'H', disabled: !has, action: () => toggleFlag('collapsed') },
      { label: 'Rendre muet', shortcut: 'M', disabled: !has, action: () => toggleFlag('muted') },
      { label: 'Renommer', shortcut: 'F2', disabled: !has, action: startRename },
      { label: 'Encadrer', shortcut: 'Ctrl+J', disabled: !has, action: () => commit((t) => ops.makeFrame(KIND, t, selected()) !== null) },
      { label: 'Retirer du cadre', shortcut: 'Alt+P', disabled: !has, action: () => commit((t) => ops.unparent(t, selected())) },
      { separator: true },
      ...(wrangler ? [{ label: 'Node Wrangler', children: wranglerItems(node, x, y) }] : []),
      { separator: true },
      { label: 'Tout afficher', shortcut: 'Origine', action: viewAll },
      { label: 'Cadrer la sélection', shortcut: 'Pavé .', disabled: !has, action: viewSelected },
    ];
    setMenu({ x, y, items });
  };

  const removeUnused = () => {
    let count = 0;
    commit((t) => {
      count = ops.deleteUnused(KIND, t);
      return count > 0;
    });
    toast(count > 0 ? `${count} nœud${count > 1 ? 's' : ''} inutilisé${count > 1 ? 's' : ''} supprimé${count > 1 ? 's' : ''}.` : 'Aucun nœud inutilisé.');
  };

  const detach = () => {
    const ids = selected();
    if (!ids.length) return;
    const t = ops.cloneTree(tree);
    const fresh = nw.detachOutputs(KIND, t, ids);
    if (!fresh.length) return;
    setSel(new Set(fresh), fresh[0]);
    // Le résultat (copies + reconnexion) est écrit au relâchement du déplacement.
    startGrab(fresh, ops.diffTrees(tree, t), true);
  };

  const linkActiveToOutput = () => {
    if (!active) return;
    if (!commit((t) => nw.linkToOutput(KIND, t, active))) toast('Le nœud actif n’a pas de sortie shader à relier à la Sortie du matériau.', 'error');
  };

  const invertSelection = () => {
    const all = Object.keys(tree.nodes).filter((id) => !sel.has(id));
    setSel(new Set(all), all[0] ?? null);
  };

  const selectSameType = () => {
    const ids = selected();
    if (ids.length) setSel(nw.selectSameType(tree, ids), active);
  };

  const selectLinked = (dir: 'up' | 'down') => setSel(dir === 'up' ? ops.upstream(tree, selected()) : ops.downstream(tree, selected()), active);

  const copyLabel = (from: 'active' | 'node' | 'socket') => commit((t) => nw.copyLabel(KIND, t, selected(), from, active) > 0);

  const startRename = () => {
    const id = active && tree.nodes[active] ? active : selected()[0];
    if (id) setRenaming(id);
  };

  /** Entrées de Node Wrangler (menu Maj+W, menu contextuel et menu de l'en-tête). */
  const wranglerItems = (node: string | null, x: number, y: number): UiMenuItem[] => {
    const has = sel.size > 0;
    const two = sel.size >= 2;
    const target = node ?? active;
    return [
      { label: 'Aperçu du nœud', shortcut: 'Ctrl+Maj+clic', disabled: !target, action: () => target && preview(target) },
      { label: 'Retirer l’aperçu', action: () => commit((t) => ops.clearPreview(t)) },
      { separator: true },
      {
        label: 'Fusionner la sélection',
        disabled: !two,
        children: [
          { label: 'Mélanger', shortcut: 'Ctrl+0', action: () => merge('MIX') },
          { label: 'Additionner', shortcut: 'Ctrl++', action: () => merge('ADD') },
          { label: 'Soustraire', shortcut: 'Ctrl+−', action: () => merge('SUBTRACT') },
          { label: 'Multiplier', shortcut: 'Ctrl+*', action: () => merge('MULTIPLY') },
          { label: 'Diviser', shortcut: 'Ctrl+/', action: () => merge('DIVIDE') },
          { label: 'Plus petit que', shortcut: 'Ctrl+<', action: () => merge('LESS_THAN') },
          { label: 'Plus grand que', shortcut: 'Ctrl+>', action: () => merge('GREATER_THAN') },
        ],
      },
      { label: 'Mode / opération suivant', shortcut: 'Alt+Bas', disabled: !has, action: () => commit((t) => nw.cycleMode(KIND, t, selected(), 1) > 0) },
      { label: 'Mode / opération précédent', shortcut: 'Alt+Haut', disabled: !has, action: () => commit((t) => nw.cycleMode(KIND, t, selected(), -1) > 0) },
      { label: 'Augmenter le facteur', shortcut: 'Alt+Droite', disabled: !has, action: () => commit((t) => nw.changeFactor(KIND, t, selected(), 0.1) > 0) },
      { label: 'Diminuer le facteur', shortcut: 'Alt+Gauche', disabled: !has, action: () => commit((t) => nw.changeFactor(KIND, t, selected(), -0.1) > 0) },
      { separator: true },
      { label: 'Coordonnées de texture', shortcut: 'Ctrl+T', disabled: !has, action: () => commit((t) => ops.textureSetup(KIND, t, selected()).length > 0) },
      { label: 'Échanger les liens', shortcut: 'Alt+S', disabled: !has, action: () => commit((t) => ops.swapLinks(KIND, t, selected())) },
      { label: 'Relier l’actif aux sélectionnés (nom)', shortcut: 'K', disabled: !active || !two, action: () => commit((t) => ops.linkActiveToSelected(KIND, t, active!, selected(), true) > 0) },
      { label: 'Relier l’actif aux sélectionnés (type)', shortcut: 'Maj+K', disabled: !active || !two, action: () => commit((t) => ops.linkActiveToSelected(KIND, t, active!, selected(), false) > 0) },
      { label: 'Relier l’actif à la sortie', shortcut: 'O', disabled: !active, action: linkActiveToOutput },
      { label: 'Détacher les sorties', shortcut: 'Maj+Alt+D', disabled: !has, action: detach },
      { label: 'Ajouter des redirections', shortcut: '/', disabled: !has, action: () => commit((t) => ops.addReroutes(KIND, t, selected()) > 0) },
      { separator: true },
      { label: 'Encadrer la sélection', shortcut: 'Maj+P', disabled: !has, action: () => commit((t) => ops.makeFrame(KIND, t, selected()) !== null) },
      { label: 'Aligner les nœuds', shortcut: 'Maj+=', disabled: !two, action: () => commit((t) => ops.alignNodes(KIND, t, selected())) },
      { label: 'Changer le type…', shortcut: 'Maj+S', disabled: !has, action: () => switchMenu(x, y) },
      { label: 'Copier les réglages de l’actif', shortcut: 'Maj+C', disabled: !active || !two, action: () => commit((t) => ops.copySettings(t, active!, selected()) > 0) },
      {
        label: 'Copier le libellé',
        disabled: !has,
        children: [
          { label: 'Du nœud actif', disabled: !active || !two, action: () => copyLabel('active') },
          { label: 'Du nœud relié', action: () => copyLabel('node') },
          { label: 'De la sortie reliée', action: () => copyLabel('socket') },
        ],
      },
      { label: 'Réinitialiser les nœuds', shortcut: 'Retour arr.', disabled: !has, action: () => commit((t) => ops.resetNodes(KIND, t, selected())) },
      { label: 'Supprimer les nœuds inutilisés', shortcut: 'Alt+X', action: removeUnused },
    ];
  };

  const wranglerMenu = (x: number, y: number) => {
    const node = nodeAt(mouse.current.tx, mouse.current.ty);
    setMenu({ x, y, items: wranglerItems(node, x, y), title: 'Node Wrangler' });
  };

  // ---------------------------------------------------------------- menus de l'en-tête

  const zoomCenter = (deltaY: number) => {
    const el = rootRef.current;
    if (el) setView(zoomAt(viewRef.current, el.clientWidth / 2, el.clientHeight / 2, deltaY));
  };

  /** Centre de la zone visible, en coordonnées de l'arbre. */
  const viewCenter = () => {
    const el = rootRef.current;
    return el ? screenToTree(viewRef.current, (el.clientWidth - (sidebar ? 240 : 0)) / 2, el.clientHeight / 2) : { x: 0, y: 0 };
  };

  const openAddMenuCentered = () => {
    const c = viewCenter();
    mouse.current.tx = c.x;
    mouse.current.ty = c.y;
    openAddMenu();
  };

  const headerMenus = (): MenuBarEntry[] => {
    const has = sel.size > 0;
    const defs = nodeTypes(KIND);
    const addItems: UiMenuItem[] = orderedCategories(defs).map((cat) => ({
      label: cat,
      children: defs
        .filter((d) => d.category === cat)
        .map((d) => ({
          label: d.label,
          action: () => {
            const c = viewCenter();
            addNodeAt(d.id, c.x, c.y);
          },
        })),
    }));
    const menus: MenuBarEntry[] = [
      {
        label: 'Vue',
        items: [
          { label: 'Barre latérale', shortcut: 'N', checked: sidebar, action: () => setSidebar((v) => !v) },
          { separator: true },
          { label: 'Zoom avant', action: () => zoomCenter(-300) },
          { label: 'Zoom arrière', action: () => zoomCenter(300) },
          { separator: true },
          { label: 'Cadrer la sélection', shortcut: 'Pavé .', disabled: !has, action: viewSelected },
          { label: 'Tout cadrer', shortcut: 'Origine', action: viewAll },
        ],
      },
      {
        label: 'Sélection',
        items: [
          { label: 'Tout', shortcut: 'A', action: () => setSel(new Set(Object.keys(tree.nodes)), active) },
          { label: 'Aucun', shortcut: 'Alt+A', action: () => setSel(new Set(), null) },
          { label: 'Inverser', shortcut: 'Ctrl+I', action: invertSelection },
          { separator: true },
          { label: 'Reliés en amont', shortcut: '[', disabled: !has, action: () => selectLinked('up') },
          { label: 'Reliés en aval', shortcut: ']', disabled: !has, action: () => selectLinked('down') },
          { label: 'Même type', shortcut: 'Maj+G', disabled: !has, action: selectSameType },
        ],
      },
      { label: 'Ajouter', items: [{ label: 'Rechercher…', shortcut: 'Maj+A', action: openAddMenuCentered }, { separator: true }, ...addItems] },
      {
        label: 'Nœud',
        items: [
          { label: 'Déplacer', shortcut: 'G', disabled: !has, action: () => startGrab(selected(), null, false) },
          { label: 'Dupliquer', shortcut: 'Maj+D', disabled: !has, action: duplicate },
          { label: 'Copier', shortcut: 'Ctrl+C', disabled: !has, action: copy },
          { label: 'Coller', shortcut: 'Ctrl+V', disabled: !clipboard, action: paste },
          { label: 'Supprimer', shortcut: 'X', disabled: !has, action: () => deleteSelected(false) },
          { label: 'Supprimer en reconnectant', shortcut: 'Ctrl+X', disabled: !has, action: () => deleteSelected(true) },
          { separator: true },
          { label: 'Relier les sélectionnés', shortcut: 'F', disabled: sel.size < 2, action: () => commit((t) => ops.makeLinks(KIND, t, selected()) > 0) },
          { label: 'Renommer', shortcut: 'F2', disabled: !has, action: startRename },
          { label: 'Réduire / déplier', shortcut: 'H', disabled: !has, action: () => toggleFlag('collapsed') },
          { label: 'Rendre muet', shortcut: 'M', disabled: !has, action: () => toggleFlag('muted') },
          { separator: true },
          { label: 'Encadrer', shortcut: 'Ctrl+J', disabled: !has, action: () => commit((t) => ops.makeFrame(KIND, t, selected()) !== null) },
          { label: 'Retirer du cadre', shortcut: 'Alt+P', disabled: !has, action: () => commit((t) => ops.unparent(t, selected())) },
        ],
      },
    ];
    if (wrangler) {
      const r = rootRef.current?.getBoundingClientRect();
      menus.push({ label: 'Node Wrangler', items: wranglerItems(null, (r?.left ?? 0) + 40, (r?.top ?? 0) + 40) });
    }
    return menus;
  };

  // ---------------------------------------------------------------- souris

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('.cf-ne-sidebar, .cf-ne-rename')) return;
    rootRef.current?.focus({ preventScroll: true });
    const p = toTree(e.clientX, e.clientY);
    mouse.current = { x: e.clientX, y: e.clientY, tx: p.x, ty: p.y };
    const d = dragRef.current;
    if (d?.kind === 'move' && d.modal) {
      e.preventDefault();
      if (e.button === 0) finishMove(d);
      setDrag(null);
      return;
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (e.button === 1 || (e.button === 0 && e.altKey && !e.ctrlKey && !e.shiftKey && !nodeAt(p.x, p.y))) {
      e.preventDefault();
      setDrag({ kind: 'pan', sx: e.clientX, sy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y });
      return;
    }
    if (e.button === 2) {
      e.preventDefault();
      const from = wrangler && (e.altKey || (e.ctrlKey && e.shiftKey)) ? nodeAt(p.x, p.y) : null;
      if (from && e.ctrlKey && e.shiftKey) setDrag({ kind: 'lazy', from, x: p.x, y: p.y, menu: false, mix: true });
      else if (from && e.altKey) setDrag({ kind: 'lazy', from, x: p.x, y: p.y, menu: e.shiftKey, mix: false });
      else if (e.ctrlKey) setDrag({ kind: 'cut', pts: [[p.x, p.y]], reroute: false });
      else if (e.shiftKey) setDrag({ kind: 'cut', pts: [[p.x, p.y]], reroute: true });
      else setDrag({ kind: 'rmb', sx: e.clientX, sy: e.clientY });
      return;
    }
    if (e.button !== 0) return;
    const sock = socketAt(p.x, p.y);
    if (sock) {
      if (sock.dir === 'out') {
        setDrag({ kind: 'link', node: sock.node, socket: sock.socket, fromOutput: true, type: sock.type, x: p.x, y: p.y, detached: null });
      } else {
        const existing = tree.links.find((l) => l.toNode === sock.node && l.toSocket === sock.socket);
        if (existing) {
          const srcType = ops.socketType(KIND, tree.nodes[existing.fromNode], 'out', existing.fromSocket) ?? 'any';
          setDrag({ kind: 'link', node: existing.fromNode, socket: existing.fromSocket, fromOutput: true, type: srcType, x: p.x, y: p.y, detached: existing });
        } else {
          setDrag({ kind: 'link', node: sock.node, socket: sock.socket, fromOutput: false, type: sock.type, x: p.x, y: p.y, detached: null });
        }
      }
      return;
    }
    const hit = nodeAt(p.x, p.y);
    if (hit && e.ctrlKey && e.shiftKey && wrangler) {
      preview(hit);
      return;
    }
    if (hit) {
      if (e.shiftKey) {
        const next = new Set(sel);
        if (next.has(hit) && active === hit) {
          next.delete(hit);
          setSel(next, null);
        } else {
          next.add(hit);
          setSel(next, hit);
        }
      } else if (!sel.has(hit)) setSel(new Set([hit]), hit);
      else setSel(sel, hit);
    }
    setDrag({ kind: 'press', sx: e.clientX, sy: e.clientY, node: hit, shift: e.shiftKey, ctrl: e.ctrlKey });
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = toTree(e.clientX, e.clientY);
    mouse.current = { x: e.clientX, y: e.clientY, tx: p.x, ty: p.y };
    const d = dragRef.current;
    if (!d) return;
    switch (d.kind) {
      case 'pan':
        setView({ ...viewRef.current, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy });
        break;
      case 'press':
        if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4) {
          const start = toTree(d.sx, d.sy);
          if (d.node) {
            const ids = sel.has(d.node) ? selected() : [d.node];
            setDrag({ kind: 'move', ids: ops.withFrameChildren(tree, ids), ox: start.x, oy: start.y, dx: p.x - start.x, dy: p.y - start.y, modal: false, pending: null, added: false });
          } else {
            setDrag({ kind: 'box', x0: start.x, y0: start.y, x1: p.x, y1: p.y, mode: d.ctrl ? 'sub' : d.shift ? 'add' : 'set' });
          }
        }
        break;
      case 'move':
        setDrag({ ...d, dx: p.x - d.ox, dy: p.y - d.oy });
        break;
      case 'box':
        setDrag({ ...d, x1: p.x, y1: p.y });
        break;
      case 'link':
      case 'lazy':
        setDrag({ ...d, x: p.x, y: p.y });
        break;
      case 'cut':
        setDrag({ ...d, pts: [...d.pts, [p.x, p.y]] });
        break;
      default:
        break;
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d0 = dragRef.current;
    if (!d0) return;
    const p = toTree(e.clientX, e.clientY);
    if (d0.kind === 'move' && d0.modal) return;
    // Les mouvements de pointeur peuvent être regroupés (geste rapide, machine chargée) : la
    // position du relâchement complète toujours le geste.
    let d: Drag = d0;
    if (d.kind === 'cut') d = { ...d, pts: [...d.pts, [p.x, p.y]] };
    else if (d.kind === 'box') d = { ...d, x1: p.x, y1: p.y };
    else if (d.kind === 'move') d = { ...d, dx: p.x - d.ox, dy: p.y - d.oy };
    else if (d.kind === 'press' && d.node && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4) {
      const start = toTree(d.sx, d.sy);
      const ids = sel.has(d.node) ? selected() : [d.node];
      d = { kind: 'move', ids: ops.withFrameChildren(tree, ids), ox: start.x, oy: start.y, dx: p.x - start.x, dy: p.y - start.y, modal: false, pending: null, added: false };
    } else if (d.kind === 'press' && !d.node && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4) {
      const start = toTree(d.sx, d.sy);
      d = { kind: 'box', x0: start.x, y0: start.y, x1: p.x, y1: p.y, mode: d.ctrl ? 'sub' : d.shift ? 'add' : 'set' };
    }
    setDrag(null);
    switch (d.kind) {
      case 'press':
        if (!d.node && !d.shift) setSel(new Set(), null);
        break;
      case 'move':
        finishMove(d);
        break;
      case 'box': {
        const hits = boxHits(rects, (id) => nodeType(KIND, shown.nodes[id]?.type ?? '')?.layout === 'frame', d.x0, d.y0, d.x1, d.y1);
        const r = applyBox(sel, active, hits, d.mode);
        setSel(r.sel, r.active);
        break;
      }
      case 'link': {
        const target = socketAt(p.x, p.y);
        if (target && target.node !== d.node) {
          const ok = commit((t) => {
            if (d.detached) t.links = t.links.filter((l) => l.id !== d.detached!.id);
            if (d.fromOutput && target.dir === 'in') return ops.connect(KIND, t, d.node, d.socket, target.node, target.socket);
            if (!d.fromOutput && target.dir === 'out') return ops.connect(KIND, t, target.node, target.socket, d.node, d.socket);
            return false;
          });
          if (!ok) {
            if (d.detached) commit((t) => void (t.links = t.links.filter((l) => l.id !== d.detached!.id)));
            toast('Liaison impossible : types incompatibles ou boucle.', 'error');
          }
        } else if (d.detached) {
          // Lien décroché puis lâché dans le vide : supprimé.
          commit((t) => void (t.links = t.links.filter((l) => l.id !== d.detached!.id)));
        } else if (!target) {
          // Lâché dans le vide : menu Ajouter, le nouveau nœud se branchera sur ce socket.
          mouse.current.tx = p.x;
          mouse.current.ty = p.y;
          openAddMenu({ node: d.node, socket: d.socket, fromOutput: d.fromOutput, type: d.type });
        }
        break;
      }
      case 'cut': {
        const pts = d.pts;
        if (pts.length < 2) break;
        const hits: { id: string; at: [number, number] }[] = [];
        for (const l of tree.links) {
          const a = tree.nodes[l.fromNode];
          const b = tree.nodes[l.toNode];
          if (!a || !b) continue;
          const p1 = socketPosition(KIND, a, 'out', l.fromSocket, linked.get(a.id) ?? EMPTY);
          const p2 = socketPosition(KIND, b, 'in', l.toSocket, linked.get(b.id) ?? EMPTY);
          if (!p1 || !p2) continue;
          const lp = linkPoints(p1.x, p1.y, p2.x, p2.y);
          let at: [number, number] | null = null;
          for (let i = 1; i < pts.length && !at; i++) for (let j = 1; j < lp.length && !at; j++) at = segmentsIntersect(pts[i - 1], pts[i], lp[j - 1], lp[j]);
          if (at) hits.push({ id: l.id, at });
        }
        if (!hits.length) break;
        if (d.reroute) {
          commit((t) => {
            for (const h of hits) {
              const l = t.links.find((x) => x.id === h.id);
              if (!l) continue;
              const rr = ops.createNode(KIND, 'NodeReroute', h.at[0], h.at[1]);
              rr.x = Math.round(h.at[0]);
              rr.y = Math.round(h.at[1]);
              t.nodes[rr.id] = rr;
              const to = { node: l.toNode, socket: l.toSocket };
              l.toNode = rr.id;
              l.toSocket = 'Input';
              t.links.push({ id: `${l.id}r`, fromNode: rr.id, fromSocket: 'Output', toNode: to.node, toSocket: to.socket });
            }
          });
        } else commit((t) => ops.removeLinks(t, hits.map((h) => h.id)));
        break;
      }
      case 'lazy': {
        const to = nodeAt(p.x, p.y);
        if (!to || to === d.from) break;
        if (d.mix) {
          let mixId: string | null = null;
          commit((t) => {
            mixId = nw.lazyMix(KIND, t, d.from, to);
            return mixId !== null;
          });
          if (mixId) setSel(new Set([mixId]), mixId);
          else toast('Mélange impossible entre ces deux nœuds.', 'error');
        } else if (d.menu) {
          const pairs = ops.lazyPairs(KIND, tree, d.from, to);
          if (!pairs.length) return toast('Aucune liaison possible entre ces deux nœuds.', 'error');
          setMenu({
            x: e.clientX,
            y: e.clientY,
            title: 'Relier',
            items: pairs.slice(0, 24).map((pr) => ({ label: `${pr.out.label} → ${pr.inp.label}`, action: () => commit((t) => ops.connect(KIND, t, d.from, pr.out.id, to, pr.inp.id)) })),
          });
        } else if (!commit((t) => ops.lazyConnect(KIND, t, d.from, to))) toast('Aucune liaison possible entre ces deux nœuds.', 'error');
        break;
      }
      case 'rmb':
        if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 5) {
          const hit = nodeAt(p.x, p.y);
          if (hit && !sel.has(hit)) setSel(new Set([hit]), hit);
          contextMenu(e.clientX, e.clientY, hit);
        }
        break;
      default:
        break;
    }
  };

  // Molette : zoom autour du pointeur (Ctrl / Maj : défilement).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as Element | null)?.closest?.('.cf-ne-sidebar')) return;
      e.preventDefault();
      const v = viewRef.current;
      if (e.ctrlKey) return setView({ ...v, x: v.x - e.deltaY });
      if (e.shiftKey) return setView({ ...v, y: v.y - e.deltaY });
      const r = el.getBoundingClientRect();
      setView(zoomAt(v, e.clientX - r.left, e.clientY - r.top, e.deltaY));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setView]);

  // ---------------------------------------------------------------- clavier

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, [contenteditable="true"]')) return;
    const key = e.key;
    const k = key.length === 1 ? key.toLowerCase() : key;
    const ctrl = e.ctrlKey || e.metaKey;
    const d = dragRef.current;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (d?.kind === 'move' && d.modal) {
      if (key === 'Escape') {
        setDrag(null);
        return handled();
      }
      if (key === 'Enter') {
        finishMove(d);
        setDrag(null);
        return handled();
      }
      return handled();
    }
    if (key === 'Escape' && d) {
      setDrag(null);
      return handled();
    }
    // ---- Node Wrangler (raccourcis actifs seulement si le module est activé)
    if (wrangler) {
      if (ctrl && !e.altKey) {
        const mergeKeys: Record<string, ops.MergeMode> = { '0': 'MIX', '+': 'ADD', '=': 'ADD', '-': 'SUBTRACT', '*': 'MULTIPLY', '/': 'DIVIDE', '<': 'LESS_THAN', '>': 'GREATER_THAN' };
        const code = e.code;
        const mm =
          code === 'Numpad0' ? 'MIX' : code === 'NumpadAdd' ? 'ADD' : code === 'NumpadSubtract' ? 'SUBTRACT' : code === 'NumpadMultiply' ? 'MULTIPLY' : code === 'NumpadDivide' ? 'DIVIDE' : (mergeKeys[key] ?? null);
        if (mm && (!e.shiftKey || key === '+' || key === '*' || key === '<' || key === '>')) {
          merge(mm);
          return handled();
        }
        if (k === 't' && e.shiftKey) {
          toast('Principled à partir de textures (Ctrl+Maj+T) : non disponible (pas d’ouverture de plusieurs fichiers à la fois). Ajoutez des nœuds Texture image un par un.', 'error');
          return handled();
        }
        if (k === 't') {
          commit((tt) => ops.textureSetup(KIND, tt, selected()).length > 0);
          return handled();
        }
      }
      if (e.altKey && !ctrl) {
        if (e.shiftKey && k === 'd') return detach(), handled();
        if (key === 'ArrowUp' || key === 'ArrowDown') return commit((tt) => nw.cycleMode(KIND, tt, selected(), key === 'ArrowDown' ? 1 : -1) > 0), handled();
        if (key === 'ArrowLeft' || key === 'ArrowRight') return commit((tt) => nw.changeFactor(KIND, tt, selected(), key === 'ArrowRight' ? 0.1 : -0.1) > 0), handled();
        if (k === 'x') return removeUnused(), handled();
        if (k === 's') return commit((tt) => ops.swapLinks(KIND, tt, selected())), handled();
      }
      if (e.shiftKey && !ctrl && !e.altKey) {
        if (k === 'w') return wranglerMenu(mouse.current.x, mouse.current.y), handled();
        if (k === 'k' && active) return commit((tt) => ops.linkActiveToSelected(KIND, tt, active, selected(), false) > 0), handled();
        if (k === 'c' && active) return commit((tt) => ops.copySettings(tt, active, selected()) > 0), handled();
        if (k === 's') return switchMenu(mouse.current.x, mouse.current.y), handled();
        if (k === 'p') return commit((tt) => ops.makeFrame(KIND, tt, selected()) !== null), handled();
        if (key === '+' || key === '=') return commit((tt) => ops.alignNodes(KIND, tt, selected())), handled();
      }
      if (!ctrl && !e.altKey && !e.shiftKey) {
        if (k === 'k' && active) return commit((tt) => ops.linkActiveToSelected(KIND, tt, active, selected(), true) > 0), handled();
        if (k === '/') return commit((tt) => ops.addReroutes(KIND, tt, selected()) > 0), handled();
        if (k === 'Backspace') return commit((tt) => ops.resetNodes(KIND, tt, selected())), handled();
        if (k === 'o' && active) return linkActiveToOutput(), handled();
      }
    }
    // ---- éditeur de nœuds (Blender)
    if (ctrl) {
      if (e.altKey || e.shiftKey) return;
      if (k === 'x') return deleteSelected(true), handled();
      if (k === 'c') return copy(), handled();
      if (k === 'v') return paste(), handled();
      if (k === 'j') return commit((tt) => ops.makeFrame(KIND, tt, selected()) !== null), handled();
      if (k === 'i') return invertSelection(), handled();
      return;
    }
    if (e.altKey) {
      if (k === 'a') return setSel(new Set(), null), handled();
      if (k === 'p') return commit((tt) => ops.unparent(tt, selected())), handled();
      return;
    }
    if (e.shiftKey) {
      if (k === 'a') return openAddMenu(), handled();
      if (k === 'd') return duplicate(), handled();
      if (k === 'g') return selectSameType(), handled();
      return;
    }
    switch (k) {
      case 'g':
        startGrab(selected(), null, false);
        return handled();
      case 'x':
      case 'Delete':
        deleteSelected(false);
        return handled();
      case 'a':
        setSel(new Set(Object.keys(tree.nodes)), active);
        return handled();
      case 'h':
        toggleFlag('collapsed');
        return handled();
      case 'm':
        toggleFlag('muted');
        return handled();
      case 'f':
        commit((tt) => ops.makeLinks(KIND, tt, selected()) > 0);
        return handled();
      case 'F2':
        startRename();
        return handled();
      case 'n':
        setSidebar((v) => !v);
        return handled();
      case 'Home':
        viewAll();
        return handled();
      case '.':
      case 'Decimal':
        viewSelected();
        return handled();
      case '[':
        selectLinked('up');
        return handled();
      case ']':
        selectLinked('down');
        return handled();
      default:
        return;
    }
  };

  // ---------------------------------------------------------------- rendu

  const nodesList = Object.values(shown.nodes);
  // Déplacement modal : un clic hors du canevas (en-tête, autre zone) le valide aussi, comme dans Blender.
  const modalMove = drag?.kind === 'move' && drag.modal;
  useEffect(() => {
    if (!modalMove) return;
    const onDown = (e: PointerEvent) => {
      const root = rootRef.current;
      if (!root || root.contains(e.target as Node)) return;
      const d = dragRef.current;
      if (d?.kind !== 'move' || !d.modal) return;
      if (e.button === 0) finishMove(d);
      setDrag(null);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalMove]);

  /**
   * Le canevas prend le focus clavier dès que le pointeur le survole (sauf pendant une saisie) :
   * Maj+A, X, G… vont alors à l'éditeur de nœuds et non au viewport, comme dans Blender.
   */
  const grabFocus = () => {
    const root = rootRef.current;
    const ae = document.activeElement as HTMLElement | null;
    if (!root || ae === root || root.contains(ae)) return;
    if (ae && (isEditableElement(ae) || ae.closest?.('.cf-ne-add, .cf-menu, .cf-dialog'))) return;
    root.focus({ preventScroll: true });
  };

  const frames = nodesList.filter((n) => nodeType(KIND, n.type)?.layout === 'frame');
  const regular = nodesList.filter((n) => nodeType(KIND, n.type)?.layout !== 'frame');
  const activeNode = active ? tree.nodes[active] : null;

  const linkEls = shown.links.map((l) => {
    const a = shown.nodes[l.fromNode];
    const b = shown.nodes[l.toNode];
    if (!a || !b) return null;
    const p1 = socketPosition(KIND, a, 'out', l.fromSocket, linked.get(a.id) ?? EMPTY);
    const p2 = socketPosition(KIND, b, 'in', l.toSocket, linked.get(b.id) ?? EMPTY);
    if (!p1 || !p2) return null;
    const hot = sel.has(a.id) || sel.has(b.id);
    const valid = socketsCompatible(p1.type, p2.type);
    return (
      <path
        key={l.id}
        d={linkPath(p1.x, p1.y, p2.x, p2.y)}
        className={`cf-ne-link${hot ? ' is-hot' : ''}${valid ? '' : ' is-invalid'}${a.muted || b.muted ? ' is-muted' : ''}`}
        style={{ stroke: valid ? (hot ? undefined : SOCKET_COLORS[p1.type]) : undefined }}
      />
    );
  });

  let ghost: ReactElement | null = null;
  if (drag?.kind === 'link') {
    const n = shown.nodes[drag.node];
    const s = n ? socketPosition(KIND, n, drag.fromOutput ? 'out' : 'in', drag.socket, linked.get(n.id) ?? EMPTY) : null;
    if (s) ghost = <path className="cf-ne-link is-ghost" d={drag.fromOutput ? linkPath(s.x, s.y, drag.x, drag.y) : linkPath(drag.x, drag.y, s.x, s.y)} />;
  } else if (drag?.kind === 'lazy') {
    const r = rects.get(drag.from);
    if (r) ghost = <path className="cf-ne-link is-lazy" d={`M${r.x + r.w / 2},${r.y + r.h / 2} L${drag.x},${drag.y}`} />;
  } else if (drag?.kind === 'cut') {
    ghost = <polyline className={`cf-ne-cut${drag.reroute ? ' is-reroute' : ''}`} points={drag.pts.map((p) => p.join(',')).join(' ')} />;
  }

  return (
    <div
      ref={rootRef}
      className={`cf-ne-canvas${drag?.kind === 'pan' ? ' is-panning' : ''}${drag?.kind === 'move' ? ' is-moving' : ''}`}
      tabIndex={0}
      onPointerDownCapture={(e) => {
        // Déplacement modal (nœud qui vient d'être ajouté, G) : le clic valide où qu'il tombe, même
        // sur un champ du nœud (qui, sinon, garderait le clic pour lui et bloquerait l'éditeur).
        const d = dragRef.current;
        if (d?.kind !== 'move' || !d.modal) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.button === 0) finishMove(d);
        setDrag(null);
      }}
      onPointerDown={onPointerDown}
      onPointerMove={(e) => {
        grabFocus();
        onPointerMove(e);
      }}
      onPointerUp={onPointerUp}
      onPointerEnter={grabFocus}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${20 * view.z}px ${20 * view.z}px` }}
    >
      <div className="cf-ne-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
        {frames.map((f) => {
          const r = rects.get(f.id) as Rect;
          return (
            <div
              key={f.id}
              className={`cf-ne-frame${sel.has(f.id) ? ' is-selected' : ''}`}
              style={{ left: r.x, top: r.y, width: r.w, height: r.h, background: f.color ? `${f.color}55` : undefined }}
            >
              <span style={{ fontSize: Number(f.props?.label_size ?? 20) * 0.7 }}>{f.label || 'Cadre'}</span>
            </div>
          );
        })}
        <svg className="cf-ne-links" width="1" height="1">
          {linkEls}
          {ghost}
        </svg>
        {regular.map((n) => {
          const def = nodeType(KIND, n.type);
          const lk = linked.get(n.id) ?? EMPTY;
          return <NodeView key={n.id} node={n} def={def} layout={nodeLayout(KIND, n, lk)} x={n.x} y={n.y} selected={sel.has(n.id)} active={active === n.id} linked={lk} edit={edit} />;
        })}
      </div>
      {drag?.kind === 'box' && (
        <div
          className="cf-ne-box"
          style={{
            left: Math.min(drag.x0, drag.x1) * view.z + view.x,
            top: Math.min(drag.y0, drag.y1) * view.z + view.y,
            width: Math.abs(drag.x1 - drag.x0) * view.z,
            height: Math.abs(drag.y1 - drag.y0) * view.z,
          }}
        />
      )}
      <div className="cf-ne-overlay">
        <IconButton icon={Maximize} tip="Tout afficher (Origine)" onClick={viewAll} />
        {drag?.kind === 'move' && drag.modal && <span className="cf-ne-status">Déplacement : clic pour valider, Échap pour annuler</span>}
        {drag?.kind === 'cut' && <span className="cf-ne-status">{drag.reroute ? 'Ajouter des redirections sur les liens croisés' : 'Couper les liens croisés'}</span>}
        {drag?.kind === 'lazy' && <span className="cf-ne-status">{drag.mix ? 'Lazy Mix (Node Wrangler) : relâchez sur le second nœud' : 'Connexion paresseuse (Node Wrangler) : relâchez sur le nœud cible'}</span>}
      </div>
      {sidebar && <Sidebar kind={KIND} node={activeNode} edit={edit} commit={commit} notes={notes} />}
      {renaming && tree.nodes[renaming] && rects.get(renaming) && (
        <RenameField
          key={renaming}
          initial={tree.nodes[renaming].label ?? ''}
          placeholder={nodeType(KIND, tree.nodes[renaming].type)?.label ?? ''}
          rect={rects.get(renaming)!}
          view={view}
          onDone={(value) => {
            const id = renaming;
            setRenaming(null);
            rootRef.current?.focus({ preventScroll: true });
            if (value === null) return;
            commit((t) => {
              const n = t.nodes[id];
              if (!n || (n.label ?? '') === value.trim()) return false;
              n.label = value.trim() || undefined;
            });
          }}
        />
      )}
      {menuSlot && createPortal(<MenuBar menus={headerMenus()} className="cf-ne-menubar" />, menuSlot)}
      {menu && <Menu items={menu.items} x={menu.x} y={menu.y} title={menu.title} onClose={() => setMenu(null)} />}
      {addMenu && (
        <AddMenu
          kind={KIND}
          state={addMenu}
          onClose={() => setAddMenu(null)}
          onPick={(type) => {
            setAddMenu(null);
            addNodeAt(type, addMenu.tx, addMenu.ty, addMenu.link);
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ renommage (F2)

function RenameField({ initial, placeholder, rect, view, onDone }: { initial: string; placeholder: string; rect: Rect; view: View; onDone(v: string | null): void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  const p = treeToScreen(view, rect.x, rect.y);
  return (
    <input
      ref={ref}
      className="cf-ne-rename"
      style={{ left: p.x, top: p.y, width: Math.max(120, rect.w * view.z) }}
      value={value}
      placeholder={placeholder}
      maxLength={63}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(value);
        else if (e.key === 'Escape') finish(null);
      }}
      onBlur={() => finish(value)}
    />
  );
}

// ------------------------------------------------------------------ menu Ajouter (Maj+A)

function AddMenu({ kind: KIND, state, onClose, onPick }: { kind: NodeTreeKind; state: AddMenuState; onClose(): void; onPick(type: string): void }) {
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.('.cf-ne-add')) onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [onClose]);

  const all = addMenuTypes(nodeTypes(KIND), state.link ?? null);
  const cats = orderedCategories(all);
  const results = query.trim() ? searchNodeTypes(all, query) : cat ? all.filter((d) => d.category === cat) : [];
  const pickIndex = Math.min(index, Math.max(0, results.length - 1));

  const left = Math.min(state.x, window.innerWidth - 420);
  const top = Math.min(state.y, window.innerHeight - 380);
  return createPortal(
    <div className="cf-ne-add" style={{ left, top }} onKeyDown={(e) => e.stopPropagation()}>
      <div className="cf-ne-add-search">
        <Search size={13} />
        <input
          ref={inputRef}
          value={query}
          placeholder={state.link ? 'Nœud à brancher…' : 'Rechercher un nœud…'}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') setIndex((i) => i + 1);
            else if (e.key === 'ArrowUp') setIndex((i) => Math.max(0, i - 1));
            else if (e.key === 'Enter' && results[pickIndex]) onPick(results[pickIndex].id);
          }}
        />
      </div>
      <div className="cf-ne-add-body">
        <div className="cf-ne-add-cats">
          {cats.map((c) => (
            <button
              key={c}
              type="button"
              className={`cf-ne-add-cat${cat === c && !query ? ' is-active' : ''}`}
              onPointerEnter={() => {
                setQuery('');
                setCat(c);
                setIndex(0);
              }}
              onClick={() => setCat(c)}
            >
              <span className="cf-ne-add-dot" style={{ background: categoryColor(c) }} />
              {c}
            </button>
          ))}
        </div>
        <div className="cf-ne-add-items">
          {results.length === 0 && <div className="cf-ne-add-hint">{query ? 'Aucun nœud.' : 'Survolez une catégorie ou tapez un nom.'}</div>}
          {results.map((d, i) => (
            <button
              key={d.id}
              type="button"
              className={`cf-ne-add-item${i === pickIndex && query ? ' is-active' : ''}`}
              data-tip={`${englishName(d)} (${d.id})${d.description ? `
${d.description}` : ''}${supportNote(d) ? `
${supportNote(d)!.text}` : ''}`}
              onClick={() => onPick(d.id)}
            >
              {d.label}
              {supportNote(d) && <AlertTriangle size={11} className={`cf-ne-add-warn is-${supportNote(d)!.level}`} />}
              {query && <span className="cf-ne-add-sub">{d.category}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------ barre latérale (N)

function Sidebar({ kind: KIND, node, edit, commit, notes }: { kind: NodeTreeKind; node: NodeData | null; edit: NodeEdit; commit(fn: (t: ops.Tree) => boolean | void): boolean; notes: string[] }) {
  const def = node ? nodeType(KIND, node.type) : null;
  return (
    <div className="cf-ne-sidebar" onKeyDown={(e) => e.stopPropagation()}>
      <div className="cf-ne-side-title">Nœud</div>
      {!node && <Hint>Aucun nœud actif.</Hint>}
      {node && (
        <>
          <div className="cf-ne-side-row">
            <span>Type</span>
            <b>{def?.label ?? node.type}</b>
          </div>
          <div className="cf-ne-side-row">
            <span>Étiquette</span>
            <TextField
              value={node.label ?? ''}
              placeholder={def?.label}
              onCommit={(v) =>
                commit((t) => {
                  if (!t.nodes[node.id]) return false;
                  t.nodes[node.id].label = v.trim() || undefined;
                })
              }
            />
          </div>
          <div className="cf-ne-side-row">
            <span>Couleur</span>
            <ColorField
              value={node.color ?? (def ? categoryColor(def.category) : '#5b5b5b')}
              onChange={(c) =>
                commit((t) => {
                  if (!t.nodes[node.id]) return false;
                  t.nodes[node.id].color = c;
                })
              }
            />
          </div>
          {node.color && (
            <button
              type="button"
              className="cf-btn"
              onClick={() =>
                commit((t) => {
                  if (!t.nodes[node.id]) return false;
                  t.nodes[node.id].color = null;
                })
              }
            >
              Couleur par défaut
            </button>
          )}
          {def && !def.layout && (
            <div className="cf-ne-side-row">
              <span>Largeur</span>
              <NumberField
                value={node.width ?? def.width ?? 150}
                min={80}
                max={600}
                step={1}
                integer
                onChange={(w) =>
                  commit((t) => {
                    if (!t.nodes[node.id]) return false;
                    t.nodes[node.id].width = w;
                  })
                }
              />
            </div>
          )}
          {def?.layout === 'frame' && (
            <div className="cf-ne-side-row">
              <span>Taille du titre</span>
              <NumberField value={Number(node.props?.label_size ?? 20)} min={8} max={64} integer step={1} onChange={(v) => edit.prop(node.id, 'label_size', v)} />
            </div>
          )}
          {def?.description && <Hint>{def.description}</Hint>}
          {supportNote(def) && <Hint className={`cf-ne-side-support is-${supportNote(def)!.level}`}>{supportNote(def)!.text}</Hint>}
        </>
      )}
      {notes.length > 0 && (
        <>
          <div className="cf-ne-side-title">Rendu du matériau</div>
          <ul className="cf-ne-side-notes">
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </>
      )}
      <div className="cf-ne-side-title">Raccourcis</div>
      <ul className="cf-ne-side-keys">
        <li>
          <b>Maj+A</b> ajouter · <b>G</b> déplacer · <b>X</b> supprimer · <b>Maj+D</b> dupliquer
        </li>
        <li>
          <b>Ctrl+clic droit</b> couper · <b>Maj+clic droit</b> redirection · <b>F</b> relier
        </li>
        <li>
          <b>Ctrl+Maj+clic</b> aperçu · <b>Alt+clic droit</b> connexion paresseuse
        </li>
        <li>
          <b>Ctrl+T</b> coordonnées · <b>Ctrl+0 / + / − / *</b> fusionner · <b>Alt+S</b> échanger
        </li>
        <li>
          <b>Alt+X</b> nettoyer · <b>Maj+S</b> changer le type · <b>Ctrl+J</b> cadre · <b>H</b> réduire · <b>M</b> muet
        </li>
        <li>
          <b>Ctrl+Maj+clic droit</b> Lazy Mix · <b>Alt+flèches</b> mode / facteur · <b>Maj+W</b> menu Node Wrangler · <b>F2</b> renommer
        </li>
      </ul>
    </div>
  );
}
