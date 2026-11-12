import { Camera, ChevronRight, CircleDot, Globe, Square, Wrench, type LucideIcon } from 'lucide-react';
import { store, useApp, type PropertiesTab } from '../../app/store';
import type { ObjectData } from '../../core/doc/schema';
import { objectIcon } from '../lib/icons';
import { Hint } from '../widgets/basic';
import { DataTab } from './DataTab';
import { useActiveObject, useDocWhen } from './docHooks';
import { MaterialTab } from './MaterialTab';
import { ModifiersTab } from './ModifiersTab';
import { ObjectTab } from './ObjectTab';
import { RenderTab } from './RenderTab';
import { WorldTab } from './WorldTab';
import './properties.css';

interface TabDef {
  id: PropertiesTab;
  label: string;
  icon: LucideIcon;
  /** Onglets d'objet : séparés des onglets de scène dans la colonne. */
  objectTab: boolean;
}

const DATA_LABELS: Record<ObjectData['type'], string> = {
  mesh: 'Données du maillage',
  light: 'Données de la lumière',
  camera: 'Données de la caméra',
  empty: 'Données',
};

/** Onglets disponibles pour l'objet actif (masqués sinon, comme dans Blender). */
function tabsFor(obj: ObjectData | null): TabDef[] {
  const tabs: TabDef[] = [
    { id: 'render', label: 'Rendu', icon: Camera, objectTab: false },
    { id: 'world', label: 'Monde', icon: Globe, objectTab: false },
  ];
  if (!obj) return tabs;
  tabs.push({ id: 'object', label: 'Objet', icon: Square, objectTab: true });
  if (obj.type === 'mesh') tabs.push({ id: 'modifiers', label: 'Modificateurs', icon: Wrench, objectTab: true });
  if (obj.type !== 'empty') tabs.push({ id: 'data', label: DATA_LABELS[obj.type], icon: objectIcon(obj.type), objectTab: true });
  if (obj.type === 'mesh') tabs.push({ id: 'material', label: 'Matériau', icon: CircleDot, objectTab: true });
  return tabs;
}

/**
 * Éditeur de propriétés : colonne d'onglets à gauche, panneaux repliables à
 * droite. L'onglet choisi est mémorisé dans `store.propertiesTab` ; s'il n'a
 * pas de sens pour l'objet actif (ou s'il n'y a plus d'objet actif), un onglet
 * voisin est affiché sans perdre le choix.
 */
export function PropertiesEditor() {
  const obj = useActiveObject();
  const wanted = useApp((s) => s.propertiesTab);
  const sceneName = useDocWhen((doc) => doc.getScene().name, { scene: (e) => e.keys.includes('name') });
  const tabs = tabsFor(obj);
  const current = tabs.find((t) => t.id === wanted) ?? tabs.find((t) => t.id === 'object') ?? tabs[0];

  let content;
  if (current.id === 'render') content = <RenderTab />;
  else if (current.id === 'world') content = <WorldTab />;
  else if (!obj) content = <Hint className="cf-props-empty">Aucun objet actif.</Hint>;
  else if (current.id === 'object') content = <ObjectTab obj={obj} />;
  else if (current.id === 'modifiers') content = <ModifiersTab obj={obj} />;
  else if (current.id === 'data') content = <DataTab obj={obj} />;
  else content = <MaterialTab obj={obj} />;

  const CtxIcon = current.objectTab && obj ? objectIcon(obj.type) : Globe;

  return (
    <div className="cf-props">
      <nav className="cf-props-tabs" aria-label="Onglets des propriétés">
        {tabs.map((t, i) => {
          const Icon = t.icon;
          const sep = i > 0 && t.objectTab && !tabs[i - 1].objectTab;
          return (
            <span key={t.id} className="cf-props-tab-wrap">
              {sep && <span className="cf-props-tab-sep" />}
              <button
                type="button"
                tabIndex={-1}
                className={`cf-props-tab tab-${t.id}${t.id === current.id ? ' is-active' : ''}`}
                data-tip={t.label}
                aria-label={t.label}
                aria-pressed={t.id === current.id}
                onClick={() => store.setState({ propertiesTab: t.id })}
              >
                <Icon size={15} />
              </button>
            </span>
          );
        })}
      </nav>
      <div className="cf-props-main">
        <div className="cf-props-context">
          <CtxIcon size={12} />
          <span className="cf-props-context-name">{current.objectTab && obj ? obj.name : sceneName}</span>
          <ChevronRight size={11} className="cf-props-context-sep" />
          <span className="cf-props-context-tab">{current.label}</span>
        </div>
        <div className="cf-props-content" key={`${current.id}:${current.objectTab ? (obj?.id ?? '') : ''}`}>
          {content}
        </div>
      </div>
    </div>
  );
}
