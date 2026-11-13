import { useMemo, useState } from 'react';
import { AlertTriangle, PanelRight, Plus, Shapes } from 'lucide-react';
import { getApp } from '../../app/context';
import { useApp } from '../../app/store';
import type { NodesModifierParams } from '../../core/doc/schema';
import { evaluateGeometryTree } from '../../core/nodes/geometryNodes';
import { EditorTypeButton, useArea } from '../layout/editorTypes';
import { newGeometryNodes, setModifierParam } from '../properties/actions';
import { useDocWhen, useObject } from '../properties/docHooks';
import { Hint, IconButton, Select } from '../widgets/basic';
import { NodeCanvas } from './NodeEditor';
import './nodes.css';

/**
 * Éditeur de nœuds de géométrie : arbre du modificateur « Nœuds de géométrie » de l'objet actif
 * (le premier de la pile, comme l'éditeur de Blender épinglé sur le modificateur actif).
 */
export function GeometryNodeEditor() {
  const area = useArea();
  const activeId = useApp((s) => s.activeId);
  const obj = useObject(activeId);
  const trees = useDocWhen((doc) => doc.listNodeTrees('geometry'), { data: (e) => e.table === 'nodeTrees' });
  const mods = obj?.type === 'mesh' ? obj.modifiers.filter((m) => m.type === 'nodes') : [];
  const [modPick, setModPick] = useState<string | null>(null);
  const mod = mods.find((m) => m.id === modPick) ?? mods[0] ?? null;
  const treeId = mod ? ((mod.params as NodesModifierParams).tree ?? null) : null;
  const tree = useDocWhen((doc) => (treeId ? doc.getNodeTree(treeId) : null), { data: (e) => e.table === 'nodeTrees' }, [treeId]);
  const [sidebar, setSidebar] = useState(true);
  const [menuSlot, setMenuSlot] = useState<HTMLDivElement | null>(null);

  const notes = useMemo(() => {
    if (!tree || tree.kind !== 'geometry' || !obj?.data) return [];
    const mesh = getApp().doc.getMesh(obj.data);
    if (!mesh) return [];
    try {
      return evaluateGeometryTree(tree, mesh, { getOperand: () => null, getNodeTree: () => null }, 'ui').notes.filter((n) => !n.startsWith('Infos d’objet'));
    } catch (err) {
      return [String((err as Error)?.message ?? err)];
    }
  }, [tree, obj?.data]);

  const create = () => {
    if (obj) newGeometryNodes(obj.id, mod?.id ?? null);
  };

  return (
    <div className="cf-ne">
      <div className="cf-ne-header">
        {area ? <EditorTypeButton /> : <Shapes size={14} className="cf-ne-icon" />}
        <span className="cf-ne-title">Nœuds de géométrie</span>
        <div ref={setMenuSlot} className="cf-ne-menus" />
        {obj?.type === 'mesh' && mods.length > 1 && (
          <Select value={mod?.id ?? ''} options={mods.map((m) => ({ value: m.id, label: m.name }))} onChange={setModPick} tip="Modificateur affiché" />
        )}
        {obj?.type === 'mesh' && mod && (
          <>
            <Select
              value={treeId ?? ''}
              placeholder="Aucun arbre"
              options={trees.map((t) => ({ value: t.id, label: t.name }))}
              onChange={(id) => setModifierParam(obj.id, mod.id, 'tree', id)}
              tip="Arbre de nœuds du modificateur"
            />
            <IconButton icon={Plus} tip="Nouvel arbre de nœuds de géométrie" onClick={create} />
          </>
        )}
        <div className="cf-spacer" />
        {notes.length > 0 && (
          <span className="cf-ne-notes" data-tip={notes.join('\n')}>
            <AlertTriangle size={13} /> {notes.length} remarque{notes.length > 1 ? 's' : ''}
          </span>
        )}
        <IconButton icon={PanelRight} tip="Barre latérale (N)" active={sidebar} onClick={() => setSidebar((v) => !v)} />
      </div>
      {!obj && <Hint className="cf-ne-empty">Sélectionnez un maillage pour lui ajouter des nœuds de géométrie.</Hint>}
      {obj && obj.type !== 'mesh' && <Hint className="cf-ne-empty">Les nœuds de géométrie s’appliquent aux maillages.</Hint>}
      {obj?.type === 'mesh' && (!mod || !treeId || !tree) && (
        <div className="cf-ne-empty">
          <button type="button" className="cf-btn" onClick={create}>
            <Plus size={13} /> Nouveau
          </button>
          <Hint>
            {mod
              ? `Le modificateur « ${mod.name} » n’a pas d’arbre : créez-en un ou choisissez-en un dans la liste.`
              : 'Ajoute un modificateur « Nœuds de géométrie » à l’objet actif, avec un arbre Entrée → Sortie du groupe.'}
          </Hint>
        </div>
      )}
      {obj?.type === 'mesh' && tree && treeId && tree.kind === 'geometry' && (
        <NodeCanvas kind="geometry" key={treeId} tree={tree} treeId={treeId} materialId={null} sidebar={sidebar} setSidebar={setSidebar} notes={notes} menuSlot={menuSlot} />
      )}
    </div>
  );
}
