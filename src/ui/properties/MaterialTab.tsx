import { Copy, Plus, Trash, Unlink } from 'lucide-react';
import { getApp } from '../../app/context';
import type { MaterialData, ObjectData } from '../../core/doc/schema';
import type { SceneDoc } from '../../core/doc/SceneDoc';
import { withOp } from '../lib/util';
import { ColorField, Hint, IconButton, Panel, Row, TextField } from '../widgets/basic';
import { NumberField, Slider } from '../widgets/NumberField';
import { useDocWhen } from './docHooks';
import { MaterialNodeFields } from './MaterialNodes';
import { createNodeMaterial, toggleUseNodes } from '../nodes/commit';

/** Nom de matériau unique (« Métal », « Métal.001 »…), en ignorant le matériau `selfId`. */
function uniqueMaterialName(doc: SceneDoc, selfId: string, wanted: string): string {
  const names = new Set(doc.listMaterials().filter((m) => m.id !== selfId).map((m) => m.name));
  if (!names.has(wanted)) return wanted;
  const stem = wanted.replace(/\.\d{3}$/, '');
  for (let i = 1; i < 10000; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
  return wanted;
}

/** Nombre d'objets utilisant chaque matériau. */
function useMaterialUsers(): Map<string, number> {
  return useDocWhen(
    (doc) => {
      const m = new Map<string, number>();
      for (const o of doc.listObjects()) if (o.material) m.set(o.material, (m.get(o.material) ?? 0) + 1);
      return m;
    },
    {
      objects: (e) => e.added.length > 0 || e.removed.length > 0 || e.changed.some((c) => c.keys.includes('material')),
      data: (e) => e.table === 'materials' && (e.added.length > 0 || e.removed.length > 0),
    },
  );
}

/** Onglet « Matériau » de l'objet actif (maillages). */
export function MaterialTab({ obj }: { obj: ObjectData }) {
  const id = obj.id;
  const materials = useDocWhen((doc) => doc.listMaterials(), { data: (e) => e.table === 'materials' });
  const users = useMaterialUsers();
  const mat = obj.material ? (materials.find((m) => m.id === obj.material) ?? null) : null;

  const assign = (materialId: string | null) => {
    const doc = getApp().doc;
    if (!doc.getObject(id)) return;
    if (materialId && !doc.getMaterial(materialId)) return;
    doc.updateObject(id, { material: materialId });
  };

  // Comme dans Blender : un nouveau matériau utilise les nœuds (Principled BSDF → Sortie).
  const createNew = () => {
    if (getApp().doc.getObject(id)) createNodeMaterial(id);
  };

  const duplicate = () => {
    if (!mat) return;
    const source = mat.id;
    withOp((doc) => {
      const cur = doc.getMaterial(source);
      if (!cur || !doc.getObject(id)) return;
      const { id: _old, ...rest } = cur;
      // L'arbre de nœuds est copié : deux matériaux ne partagent jamais le même arbre.
      const tree = cur.nodeTree ? doc.getNodeTree(cur.nodeTree) : null;
      if (tree) {
        const { id: _t, ...treeRest } = tree;
        rest.nodeTree = doc.addNodeTree(treeRest);
      }
      const mid = doc.addMaterial(rest);
      doc.updateObject(id, { material: mid });
    });
  };

  const remove = () => {
    if (!mat) return;
    const n = users.get(mat.id) ?? 0;
    if (n > 1 && !window.confirm(`Le matériau « ${mat.name} » est utilisé par ${n} objets. Le supprimer de la scène ?`)) return;
    const mid = mat.id;
    withOp((doc) => doc.removeMaterial(mid));
  };

  return (
    <>
      <Panel id="material.slots" title="Matériaux de la scène">
        <div className="cf-mat-list" role="listbox" aria-label="Matériaux de la scène">
          {materials.length === 0 && <div className="cf-mat-empty">Aucun matériau dans la scène.</div>}
          {materials.map((m) => {
            const n = users.get(m.id) ?? 0;
            const current = m.id === obj.material;
            return (
              <div
                key={m.id}
                role="option"
                aria-selected={current}
                className={`cf-mat-item${current ? ' is-current' : ''}`}
                data-tip={current ? 'Matériau de l’objet actif' : 'Affecter ce matériau à l’objet actif'}
                onClick={() => assign(m.id)}
              >
                <span className="cf-mat-swatch" style={{ background: m.baseColor }} />
                <span className="cf-mat-name">{m.name}</span>
                <span className="cf-mat-users" data-tip={`Utilisé par ${n} objet${n > 1 ? 's' : ''}`}>
                  {n}
                </span>
              </div>
            );
          })}
        </div>
        <div className="cf-mat-buttons">
          <button type="button" className="cf-btn" onClick={createNew} data-tip="Crée un matériau et l’affecte à l’objet actif">
            <Plus size={13} />
            <span>Nouveau</span>
          </button>
          <IconButton icon={Copy} tip="Dupliquer le matériau (copie affectée à l’objet actif)" disabled={!mat} onClick={duplicate} />
          <IconButton icon={Unlink} tip="Retirer le matériau de l’objet (le matériau reste dans la scène)" disabled={!mat} onClick={() => assign(null)} />
          <IconButton icon={Trash} tip="Supprimer le matériau de la scène" className="cf-danger" disabled={!mat} onClick={remove} />
        </div>
      </Panel>

      {mat ? <MaterialFields mat={mat} users={users.get(mat.id) ?? 0} /> : <Hint className="cf-props-empty">Aucun matériau affecté : l’objet est rendu avec le matériau par défaut.</Hint>}
    </>
  );
}

function MaterialFields({ mat, users }: { mat: MaterialData; users: number }) {
  const mid = mat.id;
  const set = (patch: Partial<Omit<MaterialData, 'id'>>) => getApp().doc.updateMaterial(mid, patch);
  const useNodes = !!mat.nodeTree && mat.useNodes !== false;
  return (
    <>
      <div className="cf-props-name">
        <TextField
          value={mat.name}
          maxLength={63}
          onCommit={(t) => {
            const name = t.trim();
            if (!name) return;
            const doc = getApp().doc;
            if (doc.getMaterial(mid)) set({ name: uniqueMaterialName(doc, mid, name) });
          }}
        />
        <span className="cf-props-users" data-tip="Nombre d’objets qui utilisent ce matériau">
          {users} utilisateur{users > 1 ? 's' : ''}
        </span>
      </div>
      <div className="cf-props-usenodes">
        <button
          type="button"
          className={`cf-btn${useNodes ? ' is-on' : ''}`}
          onClick={() => toggleUseNodes(mid)}
          data-tip="Nœuds de shader : Principled BSDF complet (vernis, lustre, film mince…), textures procédurales, mélanges"
        >
          Utiliser les nœuds
        </button>
      </div>
      {useNodes ? <MaterialNodeFields mat={mat} /> : <SimpleFields mat={mat} />}
    </>
  );
}

function SimpleFields({ mat }: { mat: MaterialData }) {
  const mid = mat.id;
  const set = (patch: Partial<Omit<MaterialData, 'id'>>) => getApp().doc.updateMaterial(mid, patch);
  return (
    <>
      <Panel id="material.surface" title="Surface">
        <Row label="Couleur de base">
          <ColorField value={mat.baseColor} onChange={(baseColor) => set({ baseColor })} />
        </Row>
        <Row label="Métallique">
          <Slider value={mat.metallic} onChange={(metallic) => set({ metallic })} />
        </Row>
        <Row label="Rugosité">
          <Slider value={mat.roughness} onChange={(roughness) => set({ roughness })} />
        </Row>
      </Panel>
      <Panel id="material.emission" title="Émission">
        <Row label="Couleur">
          <ColorField value={mat.emission} onChange={(emission) => set({ emission })} />
        </Row>
        <Row label="Intensité">
          <NumberField value={mat.emissionStrength} min={0} max={1000} step={0.01} onChange={(emissionStrength) => set({ emissionStrength })} />
        </Row>
      </Panel>
      <Panel id="material.transparency" title="Transparence et transmission">
        <Row label="Alpha" tip="Opacité (1 : opaque)">
          <Slider value={mat.alpha} onChange={(alpha) => set({ alpha })} />
        </Row>
        <Row label="Transmission" tip="Part de lumière transmise à travers la surface (verre, liquides)">
          <Slider value={mat.transmission} onChange={(transmission) => set({ transmission })} />
        </Row>
        <Row label="IOR" tip="Indice de réfraction (eau 1,33 ; verre 1,45 à 1,5 ; diamant 2,42)">
          <NumberField value={mat.ior} min={1} max={4} step={0.001} precision={3} onChange={(ior) => set({ ior })} />
        </Row>
      </Panel>
    </>
  );
}
