import type { PropertiesTab } from '../../app/store';
import type { ObjectType } from '../../core/doc/schema';

/**
 * Liste des onglets de l'éditeur de propriétés (logique pure, sans React), dans l'ordre de
 * Blender : Outil | Rendu, Sortie, Calque de vue, Scène, Monde | Collection | Objet,
 * Modificateurs, Contraintes, Données, Matériau.
 *
 * Les onglets `particles`, `physics` et `texture` de Blender ne sont PAS reproduits : CoForge
 * n'a ni particules, ni physique, ni textures image.
 */

/** Groupe d'onglets : un séparateur est dessiné à chaque changement de groupe. */
export type TabGroup = 'tool' | 'scene' | 'collection' | 'object';

export interface TabInfo {
  id: PropertiesTab;
  label: string;
  group: TabGroup;
  /** Onglet propre à l'objet actif (absent s'il n'y a pas d'objet actif). */
  objectTab: boolean;
}

/** Onglets de Blender volontairement absents de CoForge. */
export const HIDDEN_TABS: readonly PropertiesTab[] = ['particles', 'physics', 'texture'];

export const DATA_TAB_LABELS: Record<ObjectType, string> = {
  mesh: 'Données du maillage',
  light: 'Données de la lumière',
  camera: 'Données de la caméra',
  empty: 'Données',
};

const SCENE_TABS: TabInfo[] = [
  { id: 'tool', label: 'Outil', group: 'tool', objectTab: false },
  { id: 'render', label: 'Rendu', group: 'scene', objectTab: false },
  { id: 'output', label: 'Sortie', group: 'scene', objectTab: false },
  { id: 'viewlayer', label: 'Calque de vue', group: 'scene', objectTab: false },
  { id: 'scene', label: 'Scène', group: 'scene', objectTab: false },
  { id: 'world', label: 'Monde', group: 'scene', objectTab: false },
  { id: 'collection', label: 'Collection', group: 'collection', objectTab: false },
];

/**
 * Onglets affichés pour l'objet actif (`null` : aucun objet actif). Les onglets de scène sont
 * toujours présents ; les onglets d'objet dépendent du type :
 *  - tous : Objet, Contraintes ;
 *  - maillage : Modificateurs, Données, Matériau ;
 *  - lumière, caméra : Données ;
 *  - vide : pas d'onglet Données (ses réglages d'affichage sont dans l'onglet Objet).
 */
export function tabsFor(type: ObjectType | null | undefined): TabInfo[] {
  const tabs = SCENE_TABS.map((t) => ({ ...t }));
  if (!type) return tabs;
  const add = (id: PropertiesTab, label: string) => tabs.push({ id, label, group: 'object', objectTab: true });
  add('object', 'Objet');
  if (type === 'mesh') add('modifiers', 'Modificateurs');
  add('constraints', 'Contraintes d’objet');
  if (type === 'mesh' || type === 'light' || type === 'camera') add('data', DATA_TAB_LABELS[type]);
  if (type === 'mesh') add('material', 'Matériau');
  return tabs;
}

/**
 * Onglet réellement affiché : l'onglet demandé s'il existe pour l'objet actif, sinon un repli
 * (Objet s'il y a un objet actif, Scène sinon) — le choix mémorisé n'est pas modifié, il
 * redevient actif dès qu'il a de nouveau un sens.
 */
export function resolveTab(tabs: TabInfo[], wanted: PropertiesTab): TabInfo {
  return tabs.find((t) => t.id === wanted) ?? tabs.find((t) => t.id === 'object') ?? tabs.find((t) => t.id === 'scene') ?? tabs[0];
}

/** Un séparateur précède-t-il l'onglet d'indice `i` ? */
export function separatorBefore(tabs: TabInfo[], i: number): boolean {
  return i > 0 && tabs[i].group !== tabs[i - 1].group;
}
