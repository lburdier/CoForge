import { useRef, useState } from 'react';
import { Axis3d, Camera, CameraOff, ChevronDown, Eye, EyeOff, Lightbulb, MousePointer2, MousePointer2Off, Shapes, Triangle, Video, type LucideIcon } from 'lucide-react';
import { objectTypeCategory, OBJECT_TYPE_CATEGORIES, setObjectTypeSelectable, useApp, type ObjectTypeCategory } from '../../app/store';
import { useDocWhen } from '../properties/docHooks';
import { Checkbox, IconButton, Select, type SelectOption } from '../widgets/basic';
import { Popover } from '../widgets/Menu';
import { DEFAULT_FILTERS, type ObjectStateFilter, type OutlinerFilters } from './tree';
import './outliner.css';

/**
 * Popovers des filtres : celui de l'outliner (colonnes de restriction, filtre d'état, contenu,
 * enfants, collections, types d'objets) et celui de l'en-tête du viewport (sélectionnabilité
 * par type). La sélectionnabilité par type est une préférence LOCALE du store, partagée par les
 * deux ; les autres filtres sont propres à l'outliner (mémorisés dans localStorage).
 */

export const TYPE_ROWS: { key: ObjectTypeCategory; label: string; icon: LucideIcon }[] = [
  { key: 'mesh', label: 'Maillages', icon: Triangle },
  { key: 'camera', label: 'Caméras', icon: Video },
  { key: 'light', label: 'Lumières', icon: Lightbulb },
  { key: 'empty', label: 'Vides', icon: Axis3d },
  { key: 'other', label: 'Autres', icon: Shapes },
];

const OTHER_TIP = 'Objets d’un type non reconnu (reçus d’une autre version de CoForge) ; aucun dans cette scène';

const STATE_OPTIONS: SelectOption<ObjectStateFilter>[] = [
  { value: 'all', label: 'Tous les objets' },
  { value: 'visible', label: 'Objets visibles' },
  { value: 'selected', label: 'Objets sélectionnés' },
  { value: 'active', label: 'Objet actif' },
];

/** Petite bascule à icône (œil, flèche…) du popover. */
function IconToggle({ on, onChange, iconOn: On, iconOff: Off, tip, disabled }: { on: boolean; onChange(v: boolean): void; iconOn: LucideIcon; iconOff: LucideIcon; tip: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      className={`cf-ol-ftoggle${on ? ' is-on' : ''}`}
      data-tip={tip}
      aria-pressed={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      {on ? <On size={13} /> : <Off size={13} />}
    </button>
  );
}

/** Ligne « type d'objet » : icône, nom, nombre, puis les bascules demandées. */
function TypeRow({
  row,
  count,
  shown,
  onShown,
}: {
  row: (typeof TYPE_ROWS)[number];
  count: number | null;
  shown?: boolean;
  onShown?(v: boolean): void;
}) {
  const selectable = useApp((s) => s.objectTypeSelectable[row.key] !== false);
  const Icon = row.icon;
  const empty = row.key === 'other' && count === 0;
  return (
    <div className={`cf-ol-ftype${empty ? ' is-empty' : ''}`} data-tip={row.key === 'other' ? OTHER_TIP : undefined}>
      <Icon size={13} className={`cf-ol-icon is-${row.key}`} />
      <span className="cf-ol-ftype-label">{row.label}</span>
      {count !== null && <span className="cf-ol-ftype-count">{count}</span>}
      {onShown && (
        <IconToggle
          on={shown !== false}
          onChange={onShown}
          iconOn={Eye}
          iconOff={EyeOff}
          disabled={empty}
          tip={shown !== false ? `Masquer les ${row.label.toLowerCase()} dans l’outliner` : `Afficher les ${row.label.toLowerCase()} dans l’outliner`}
        />
      )}
      <IconToggle
        on={selectable}
        onChange={(v) => setObjectTypeSelectable({ [row.key]: v })}
        iconOn={MousePointer2}
        iconOff={MousePointer2Off}
        disabled={empty}
        tip={selectable ? `Rendre les ${row.label.toLowerCase()} non sélectionnables dans le viewport` : `Rendre les ${row.label.toLowerCase()} sélectionnables dans le viewport`}
      />
    </div>
  );
}

export function OutlinerFilterPopover({
  anchorEl,
  onClose,
  filters,
  onChange,
  counts,
}: {
  anchorEl: Element | null;
  onClose(): void;
  filters: OutlinerFilters;
  onChange(patch: Partial<OutlinerFilters>): void;
  counts: Record<ObjectTypeCategory, number>;
}) {
  const typeSel = useApp((s) => s.objectTypeSelectable);
  const isDefault =
    JSON.stringify({ ...filters, followActive: true }) === JSON.stringify({ ...DEFAULT_FILTERS, followActive: true }) &&
    OBJECT_TYPE_CATEGORIES.every((k) => typeSel[k] !== false);
  return (
    <Popover anchorEl={anchorEl} onClose={onClose} align="right" className="cf-ol-filter-popover">
      <div className="cf-popover-title">Commandes de restriction</div>
      <div className="cf-ol-frestrict">
        <IconToggle
          on={filters.colSelectable}
          onChange={(v) => onChange({ colSelectable: v })}
          iconOn={MousePointer2}
          iconOff={MousePointer2}
          tip="Colonne « Sélectionnable » (sélection dans le viewport)"
        />
        <IconToggle on={filters.colViewport} onChange={(v) => onChange({ colViewport: v })} iconOn={Eye} iconOff={Eye} tip="Colonne « Masquer dans le viewport »" />
        <IconToggle
          on={filters.colRender}
          onChange={(v) => onChange({ colRender: v })}
          iconOn={Camera}
          iconOff={CameraOff}
          tip="Colonne « Désactiver dans les rendus »"
        />
      </div>

      <div className="cf-popover-title">Filtre</div>
      <div className="cf-ol-fsection">
        <Select value={filters.objects} options={STATE_OPTIONS} tip="Objets montrés dans l’outliner" onChange={(objects) => onChange({ objects })} />
        <Checkbox label="Contenu des objets" tip="Données, matériau, modificateurs et contraintes sous chaque objet" checked={filters.contents} onChange={(contents) => onChange({ contents })} />
        <Checkbox label="Enfants" tip="Ranger les objets enfants sous leur parent" checked={filters.children} onChange={(children) => onChange({ children })} />
        <Checkbox label="Collections" tip="Afficher les collections (sinon, tous les objets à plat)" checked={filters.collections} onChange={(collections) => onChange({ collections })} />
        <Checkbox
          label="Suivre l’objet actif"
          tip="Déplier et faire défiler l’outliner vers l’objet actif quand il change dans le viewport"
          checked={filters.followActive}
          onChange={(followActive) => onChange({ followActive })}
        />
      </div>

      <div className="cf-popover-title cf-ol-ftypes-title">
        <span>Types d’objets</span>
        <span className="cf-ol-ftypes-head" data-tip="Affiché dans l’outliner">
          <Eye size={11} />
        </span>
        <span className="cf-ol-ftypes-head" data-tip="Sélectionnable dans le viewport">
          <MousePointer2 size={11} />
        </span>
      </div>
      {TYPE_ROWS.map((r) => (
        <TypeRow
          key={r.key}
          row={r}
          count={counts[r.key]}
          shown={filters.types[r.key]}
          onShown={(v) => onChange({ types: { ...filters.types, [r.key]: v } })}
        />
      ))}
      <div className="cf-hint">La sélectionnabilité par type ne s’applique qu’au viewport (clic, rectangle, A) ; elle reste propre à ce poste.</div>
      <div className="cf-popover-actions">
        <button
          type="button"
          className="cf-btn"
          disabled={isDefault}
          onClick={() => {
            onChange({ ...DEFAULT_FILTERS, followActive: filters.followActive });
            setObjectTypeSelectable({ mesh: true, camera: true, light: true, empty: true, other: true });
          }}
        >
          Réinitialiser les filtres
        </button>
      </div>
    </Popover>
  );
}

/** Popover « Types d'objets » de l'en-tête du viewport : sélectionnabilité par type. */
export function ViewportTypesPopover({ anchorEl, onClose, counts }: { anchorEl: Element | null; onClose(): void; counts: Record<ObjectTypeCategory, number> }) {
  return (
    <Popover anchorEl={anchorEl} onClose={onClose} align="right" className="cf-ol-filter-popover">
      <div className="cf-popover-title cf-ol-ftypes-title">
        <span>Types d’objets</span>
        <span className="cf-ol-ftypes-head" data-tip="Sélectionnable dans le viewport">
          <MousePointer2 size={11} />
        </span>
      </div>
      {TYPE_ROWS.map((r) => (
        <TypeRow key={r.key} row={r} count={counts[r.key]} />
      ))}
      <div className="cf-hint">Préférence locale, aussi réglable dans les filtres de l’outliner. L’outliner peut toujours sélectionner ces objets.</div>
    </Popover>
  );
}

/** Nombre d'objets par catégorie de type (relu seulement quand des objets apparaissent, disparaissent ou changent de type). */
function useTypeCounts(): Record<ObjectTypeCategory, number> {
  return useDocWhen(
    (doc) => {
      const out = { mesh: 0, camera: 0, light: 0, empty: 0, other: 0 } as Record<ObjectTypeCategory, number>;
      for (const id of doc.objectIds()) out[objectTypeCategory(doc.getObject(id)?.type)]++;
      return out;
    },
    { objects: (e) => e.added.length > 0 || e.removed.length > 0 || e.changed.some((c) => c.keys.includes('type')) },
  );
}

/** Bouton « Types d'objets » de l'en-tête du viewport (flèche : sélectionnable par type). */
export function ViewportTypesButton() {
  const typeSel = useApp((s) => s.objectTypeSelectable);
  const restricted = OBJECT_TYPE_CATEGORIES.some((k) => typeSel[k] === false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <IconButton
        icon={restricted ? MousePointer2Off : MousePointer2}
        tip={restricted ? 'Types d’objets sélectionnables (certains types sont exclus)' : 'Types d’objets sélectionnables'}
        active={open || restricted}
        className={`has-chevron cf-ol-filter-btn${restricted ? ' is-filtering' : ''}`}
        buttonRef={(el) => {
          ref.current = el;
        }}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronDown size={10} />
      </IconButton>
      {open && <ViewportTypesPopoverWithCounts anchorEl={ref.current} onClose={() => setOpen(false)} />}
    </>
  );
}

function ViewportTypesPopoverWithCounts({ anchorEl, onClose }: { anchorEl: Element | null; onClose(): void }) {
  const counts = useTypeCounts();
  return <ViewportTypesPopover anchorEl={anchorEl} onClose={onClose} counts={counts} />;
}
