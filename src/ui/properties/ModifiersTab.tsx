import { memo, useRef, useState } from 'react';
import {
  Box,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Combine,
  Copy,
  Grid3x3,
  Layers,
  Monitor,
  MonitorOff,
  Plus,
  Spline,
  Trash,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { getApp } from '../../app/context';
import {
  MODIFIER_LABELS,
  type ArrayParams,
  type BevelParams,
  type BooleanParams,
  type MirrorParams,
  type ModifierData,
  type ModifierType,
  type ObjectData,
  type SolidifyParams,
  type SubsurfParams,
} from '../../core/doc/schema';
import { Checkbox, Hint, IconButton, Row, Select, TextField, type SelectOption } from '../widgets/basic';
import { Menu, type UiMenuItem } from '../widgets/Menu';
import { NumberField, VectorField } from '../widgets/NumberField';
import { addModifier, applyModifier, moveModifier, opAvailable, patchModifier, removeModifier, setModifierParam } from './actions';
import { useDocWhen } from './docHooks';

export const MODIFIER_ICONS: Partial<Record<ModifierType, LucideIcon>> = {
  mirror: Copy,
  array: Grid3x3,
  bevel: Spline,
  subsurf: Box,
  solidify: Layers,
  boolean: Combine,
};

const MODIFIER_ORDER: ModifierType[] = ['array', 'bevel', 'boolean', 'mirror', 'solidify', 'subsurf'];

/** Onglet « Modificateurs » de l'objet actif (maillages). */
export function ModifiersTab({ obj }: { obj: ObjectData }) {
  const [menu, setMenu] = useState<{ x: number; y: number; w: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const mods = obj.modifiers;

  const items: UiMenuItem[] = MODIFIER_ORDER.map((type) => ({
    label: MODIFIER_LABELS[type],
    icon: MODIFIER_ICONS[type],
    action: () => addModifier(obj, type),
  }));

  return (
    <div className="cf-mods">
      <div className="cf-props-actions">
        <button
          ref={btn}
          type="button"
          className="cf-btn cf-mods-add"
          onClick={() => {
            const r = btn.current?.getBoundingClientRect();
            if (r) setMenu(menu ? null : { x: r.left, y: r.bottom + 1, w: r.width });
          }}
        >
          <Plus size={13} />
          <span>Ajouter un modificateur</span>
          <ChevronDown size={11} />
        </button>
        {menu && <Menu items={items} x={menu.x} y={menu.y} minWidth={menu.w} anchorEl={btn.current} onClose={() => setMenu(null)} />}
      </div>
      {mods.length === 0 ? (
        <Hint className="cf-props-empty">
          <Wrench size={14} /> Aucun modificateur. Les modificateurs transforment le maillage de façon non destructive.
        </Hint>
      ) : (
        mods.map((m, i) => <ModifierCard key={m.id} obj={obj} mod={m} first={i === 0} last={i === mods.length - 1} />)
      )}
    </div>
  );
}

interface CardProps {
  obj: ObjectData;
  mod: ModifierData;
  first: boolean;
  last: boolean;
}

const ModifierCard = memo(function ModifierCard({ obj, mod, first, last }: CardProps) {
  const [open, setOpen] = useState(true);
  const Icon = MODIFIER_ICONS[mod.type] ?? Wrench;
  const canApply = opAvailable('object.modifier_apply', true) && mod.enabled;
  return (
    <section className={`cf-mod-card${open ? ' is-open' : ''}${mod.enabled ? '' : ' is-disabled'}`}>
      <header className="cf-mod-header">
        <button type="button" tabIndex={-1} className="cf-mod-toggle" onClick={() => setOpen(!open)} aria-label={open ? 'Replier' : 'Déplier'}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <Icon size={13} className="cf-mod-icon" />
        <TextField
          className="cf-mod-name"
          value={mod.name}
          maxLength={63}
          onCommit={(t) => {
            const name = t.trim();
            if (name) patchModifier(obj.id, mod.id, (m) => ({ ...m, name }));
          }}
        />
        <IconButton
          icon={mod.enabled ? Monitor : MonitorOff}
          active={mod.enabled}
          tip={mod.enabled ? 'Désactiver le modificateur' : 'Activer le modificateur'}
          onClick={() => patchModifier(obj.id, mod.id, (m) => ({ ...m, enabled: !m.enabled }))}
        />
        <IconButton icon={ChevronUp} tip="Monter" disabled={first} onClick={() => moveModifier(obj, mod.id, -1)} />
        <IconButton icon={ChevronDown} tip="Descendre" disabled={last} onClick={() => moveModifier(obj, mod.id, 1)} />
        <IconButton icon={Trash} tip="Supprimer le modificateur" className="cf-danger" onClick={() => removeModifier(obj, mod.id)} />
      </header>
      {open && (
        <div className="cf-mod-body">
          <ModifierParams obj={obj} mod={mod} />
          <div className="cf-mod-footer">
            <button
              type="button"
              className="cf-btn"
              disabled={!canApply}
              data-tip={
                canApply
                  ? 'Applique ce modificateur (et ceux situés au-dessus) au maillage, de façon définitive'
                  : mod.enabled
                    ? 'Application indisponible dans le contexte actuel (mode édition ?)'
                    : 'Activez le modificateur pour pouvoir l’appliquer'
              }
              onClick={() => applyModifier(obj, mod.id)}
            >
              Appliquer
            </button>
          </div>
        </div>
      )}
    </section>
  );
});

// ------------------------------------------------------------------ paramètres par type

function ModifierParams({ obj, mod }: { obj: ObjectData; mod: ModifierData }) {
  const set = (key: string) => (value: unknown) => setModifierParam(obj.id, mod.id, key, value);
  switch (mod.type) {
    case 'mirror':
      return <MirrorFields p={mod.params as MirrorParams} set={set} />;
    case 'array':
      return <ArrayFields p={mod.params as ArrayParams} set={set} />;
    case 'bevel':
      return <BevelFields p={mod.params as BevelParams} set={set} />;
    case 'subsurf':
      return <SubsurfFields p={mod.params as SubsurfParams} set={set} />;
    case 'solidify':
      return <SolidifyFields p={mod.params as SolidifyParams} set={set} />;
    case 'boolean':
      return <BooleanFields p={mod.params as BooleanParams} set={set} selfId={obj.id} />;
    default:
      return <Hint>Type de modificateur inconnu.</Hint>;
  }
}

type Setter = (key: string) => (value: any) => void;

function AxisToggle({ label, on, onClick }: { label: string; on: boolean; onClick(): void }) {
  return (
    <button type="button" tabIndex={-1} className={`cf-toggle${on ? ' is-on' : ''}`} aria-pressed={on} onClick={onClick}>
      {label}
    </button>
  );
}

function MirrorFields({ p, set }: { p: MirrorParams; set: Setter }) {
  return (
    <>
      <Row label="Axes">
        <div className="cf-toggle-group">
          <AxisToggle label="X" on={!!p.axisX} onClick={() => set('axisX')(!p.axisX)} />
          <AxisToggle label="Y" on={!!p.axisY} onClick={() => set('axisY')(!p.axisY)} />
          <AxisToggle label="Z" on={!!p.axisZ} onClick={() => set('axisZ')(!p.axisZ)} />
        </div>
      </Row>
      <Row>
        <Checkbox checked={!!p.merge} onChange={set('merge')} label="Souder" tip="Soude les sommets situés sur le plan de symétrie" />
      </Row>
      <Row label="Distance de soudure">
        <NumberField value={p.mergeDist ?? 0.001} min={0} max={10} step={0.0005} precision={4} unit="m" disabled={!p.merge} onChange={set('mergeDist')} />
      </Row>
    </>
  );
}

function ArrayFields({ p, set }: { p: ArrayParams; set: Setter }) {
  return (
    <>
      <Row label="Nombre">
        <NumberField value={p.count ?? 2} integer min={1} max={1000} step={1} onChange={set('count')} />
      </Row>
      <div className="cf-group-label">Décalage relatif</div>
      <VectorField value={p.relative ?? [1, 0, 0]} step={0.01} onChange={set('relative')} />
      <div className="cf-group-label">Décalage constant</div>
      <VectorField value={p.constant ?? [0, 0, 0]} step={0.01} unit="m" onChange={set('constant')} />
    </>
  );
}

function BevelFields({ p, set }: { p: BevelParams; set: Setter }) {
  return (
    <>
      <Row label="Largeur">
        <NumberField value={p.width ?? 0.02} min={0} max={100} step={0.001} precision={4} unit="m" onChange={set('width')} />
      </Row>
      <Row label="Segments">
        <NumberField value={p.segments ?? 1} integer min={1} max={32} step={1} onChange={set('segments')} />
      </Row>
      <Row label="Angle limite" tip="Seules les arêtes plus vives que cet angle sont biseautées">
        <NumberField value={p.angleLimit ?? 30} min={0} max={180} step={0.5} precision={1} unit="°" onChange={set('angleLimit')} />
      </Row>
    </>
  );
}

function SubsurfFields({ p, set }: { p: SubsurfParams; set: Setter }) {
  return (
    <Row label="Niveaux" tip="Chaque niveau multiplie environ par 4 le nombre de faces">
      <NumberField value={p.levels ?? 1} integer min={0} max={6} step={1} onChange={set('levels')} />
    </Row>
  );
}

function SolidifyFields({ p, set }: { p: SolidifyParams; set: Setter }) {
  return (
    <>
      <Row label="Épaisseur">
        <NumberField value={p.thickness ?? 0.05} min={-100} max={100} step={0.001} precision={4} unit="m" onChange={set('thickness')} />
      </Row>
      <Row label="Décalage" tip="-1 : vers l’intérieur, 0 : centré, 1 : vers l’extérieur">
        <NumberField value={p.offset ?? -1} min={-1} max={1} step={0.01} slider onChange={set('offset')} />
      </Row>
    </>
  );
}

const BOOL_OPS: SelectOption<BooleanParams['operation']>[] = [
  { value: 'difference', label: 'Différence' },
  { value: 'union', label: 'Union' },
  { value: 'intersect', label: 'Intersection' },
];

const NO_TARGET = '__none__';

function BooleanFields({ p, set, selfId }: { p: BooleanParams; set: Setter; selfId: string }) {
  const targets = useDocWhen(
    (doc) => {
      const opts: SelectOption<string>[] = doc
        .listObjects()
        .filter((o) => o.type === 'mesh' && o.id !== selfId)
        .map((o) => ({ value: o.id, label: o.name }))
        .sort((a, b) => a.label.localeCompare(b.label, 'fr', { numeric: true }));
      return opts;
    },
    { objects: (e) => e.added.length > 0 || e.removed.length > 0 || e.changed.some((c) => c.keys.includes('name') || c.keys.includes('type')) },
    [selfId],
  );
  const valid = !!p.target && targets.some((t) => t.value === p.target);
  return (
    <>
      <Row label="Opération">
        <Select value={p.operation ?? 'difference'} options={BOOL_OPS} onChange={set('operation')} />
      </Row>
      <Row label="Objet">
        <Select
          value={valid ? p.target! : NO_TARGET}
          options={[{ value: NO_TARGET, label: '(aucun)' }, ...targets]}
          onChange={(v) => set('target')(v === NO_TARGET ? null : v)}
        />
      </Row>
      {!valid && <Hint className="cf-props-warn">{p.target ? 'L’objet cible n’existe plus.' : 'Choisissez un objet maillage comme opérande.'}</Hint>}
      {valid && (
        <Hint>
          Astuce : masquez l’objet cible dans le viewport (œil de l’outliner) pour voir le résultat.{' '}
          <button type="button" className="cf-link" onClick={() => p.target && getApp().doc.updateObject(p.target, { visible: false })}>
            Masquer la cible
          </button>
        </Hint>
      )}
    </>
  );
}
