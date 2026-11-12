import { getApp } from '../../app/context';
import { toast } from '../../app/store';
import { ROOT_COLLECTION, type ObjectData } from '../../core/doc/schema';
import type { SceneDoc } from '../../core/doc/SceneDoc';
import { objectIcon } from '../lib/icons';
import { renameObject, withOp } from '../lib/util';
import { Checkbox, Panel, Row, Select, TextField, type SelectOption } from '../widgets/basic';
import { NumberField } from '../widgets/NumberField';
import { isSelfOrDescendant, reparentKeepWorld } from './actions';
import { useDocWhen } from './docHooks';
import { TransformFields } from './TransformFields';

const NONE = '__none__';

const DISPLAY_OPTIONS: SelectOption<ObjectData['displayAs']>[] = [
  { value: 'solid', label: 'Solide' },
  { value: 'wire', label: 'Fil de fer' },
  { value: 'bounds', label: 'Boîte englobante' },
];

/** Chemin lisible d'une collection (« Décor / Murs »), protégé contre les cycles. */
export function collectionPath(doc: SceneDoc, id: string): string {
  if (id === ROOT_COLLECTION) return 'Collection de scène';
  const parts: string[] = [];
  const seen = new Set<string>();
  let cur: string = id;
  while (cur !== ROOT_COLLECTION && !seen.has(cur) && parts.length < 32) {
    seen.add(cur);
    const c = doc.getCollection(cur);
    if (!c) break;
    parts.unshift(c.name);
    cur = c.parent;
  }
  return parts.join(' / ');
}

/** Options « collection » : racine puis toutes les collections, triées par chemin. */
export function collectionOptions(doc: SceneDoc): SelectOption<string>[] {
  const list = doc
    .listCollections()
    .map((c) => ({ value: c.id, label: collectionPath(doc, c.id) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'fr', { numeric: true }));
  return [{ value: ROOT_COLLECTION, label: 'Collection de scène' }, ...list];
}

const STRUCT_KEYS = new Set(['name', 'parent', 'type']);

/** Onglet « Objet » de l'objet actif. */
export function ObjectTab({ obj }: { obj: ObjectData }) {
  const id = obj.id;
  const parentOptions = useDocWhen(
    (doc) => {
      const opts: SelectOption<string>[] = [];
      for (const o of doc.listObjects()) {
        if (isSelfOrDescendant(doc, o.id, id)) continue;
        opts.push({ value: o.id, label: o.name, icon: objectIcon(o.type) });
      }
      opts.sort((a, b) => a.label.localeCompare(b.label, 'fr', { numeric: true }));
      return [{ value: NONE, label: '(aucun parent)' }, ...opts];
    },
    { objects: (e) => e.added.length > 0 || e.removed.length > 0 || e.changed.some((c) => c.keys.some((k) => STRUCT_KEYS.has(k))) },
    [id],
  );
  const colOptions = useDocWhen((doc) => collectionOptions(doc), { data: (e) => e.table === 'collections' });
  const parent = getApp().doc.effectiveParent(id);

  return (
    <>
      <div className="cf-props-name">
        <TextField value={obj.name} onCommit={(t) => renameObject(id, t)} maxLength={63} />
      </div>

      <Panel id="object.transform" title="Transformation">
        <TransformFields id={id} />
      </Panel>

      <Panel id="object.relations" title="Relations">
        <Row label="Parent">
          <Select
            value={parent ?? NONE}
            options={parentOptions}
            onChange={(v) => {
              const target = v === NONE ? null : v;
              let ok = true;
              withOp((doc) => {
                if (!doc.getObject(id)) return;
                ok = reparentKeepWorld(doc, [id], target).refused === 0;
              });
              if (!ok) toast('Parentage impossible : il créerait une boucle (ou le parent a disparu)', 'error');
            }}
          />
        </Row>
        <Row label="Collection">
          <Select value={obj.collection} options={colOptions} onChange={(collection) => getApp().doc.updateObject(id, { collection })} />
        </Row>
      </Panel>

      <Panel id="object.visibility" title="Visibilité">
        <Row>
          <Checkbox checked={obj.visible} onChange={(visible) => getApp().doc.updateObject(id, { visible })} label="Visible dans le viewport" />
        </Row>
        <Row>
          <Checkbox checked={obj.renderable} onChange={(renderable) => getApp().doc.updateObject(id, { renderable })} label="Visible au rendu" />
        </Row>
      </Panel>

      <Panel id="object.display" title="Affichage">
        <Row label="Afficher comme">
          <Select value={obj.displayAs} options={DISPLAY_OPTIONS} onChange={(displayAs) => getApp().doc.updateObject(id, { displayAs })} />
        </Row>
      </Panel>

      {obj.type === 'mesh' && (
        <Panel id="object.shading" title="Ombrage">
          <Row>
            <Checkbox checked={obj.shadeSmooth} onChange={(shadeSmooth) => getApp().doc.updateObject(id, { shadeSmooth })} label="Ombrage lisse" />
          </Row>
          <Row label="Angle d’auto-lissage" tip="Les arêtes dont l’angle entre faces dépasse cette valeur restent vives">
            <NumberField
              value={obj.autoSmoothAngle}
              min={0}
              max={180}
              step={0.5}
              precision={1}
              unit="°"
              disabled={!obj.shadeSmooth}
              onChange={(autoSmoothAngle) => getApp().doc.updateObject(id, { autoSmoothAngle })}
            />
          </Row>
        </Panel>
      )}
    </>
  );
}
