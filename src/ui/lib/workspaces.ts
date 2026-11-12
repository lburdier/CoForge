import { getApp } from '../../app/context';
import { store, type AppState, type Workspace } from '../../app/store';
import { runOp } from './ops';

/**
 * Espaces de travail (onglets de la barre supérieure) : chacun ajuste le mode
 * d'ombrage, l'onglet de propriétés et la disposition des zones, comme les
 * espaces de travail de Blender.
 */

export interface AreaLayout {
  /** Largeur de la colonne de droite (outliner + propriétés), px. */
  rightW: number;
  /** Hauteur de l'outliner dans la colonne de droite, px. */
  outlinerH: number;
  /** Hauteur de l'éditeur du bas (nœuds, texte…), px. */
  bottomH?: number;
}

export interface WorkspacePreset {
  id: Workspace;
  label: string;
  tip: string;
  apply: Partial<AppState>;
  layout: AreaLayout;
}

/** Hauteur par défaut de l'éditeur du bas (px). */
export const DEFAULT_BOTTOM_H = 300;

export const WORKSPACES: WorkspacePreset[] = [
  {
    id: 'layout',
    label: 'Disposition',
    tip: 'Disposition générale : mise en place de la scène',
    apply: { shading: 'solid', showToolbar: true, bottomEditor: null },
    layout: { rightW: 320, outlinerH: 240 },
  },
  {
    id: 'modeling',
    label: 'Modélisation',
    tip: 'Modélisation : mode édition, viewport élargi',
    apply: { shading: 'solid', showToolbar: true, bottomEditor: null },
    layout: { rightW: 280, outlinerH: 200 },
  },
  {
    id: 'shading',
    label: 'Shading',
    tip: 'Shading : aperçu des matériaux et réglage de l’éclairage',
    apply: { shading: 'material', propertiesTab: 'material', bottomEditor: 'shader_nodes' },
    layout: { rightW: 360, outlinerH: 180 },
  },
  {
    id: 'rendering',
    label: 'Rendu',
    tip: 'Rendu : aperçu final et réglages du moteur de rendu',
    apply: { shading: 'rendered', propertiesTab: 'render', bottomEditor: null },
    layout: { rightW: 380, outlinerH: 160 },
  },
  {
    id: 'geometry',
    label: 'Nœuds de géométrie',
    tip: 'Nœuds de géométrie : modélisation procédurale par graphe de nœuds',
    apply: { shading: 'solid', propertiesTab: 'modifiers', bottomEditor: 'geometry_nodes' },
    layout: { rightW: 320, outlinerH: 200 },
  },
  {
    id: 'scripting',
    label: 'Script',
    tip: 'Script : éditeur de texte et console Python',
    apply: { shading: 'solid', bottomEditor: 'python' },
    layout: { rightW: 320, outlinerH: 200 },
  },
];

export function workspacePreset(id: Workspace): WorkspacePreset {
  return WORKSPACES.find((w) => w.id === id) ?? WORKSPACES[0];
}

/** Active un espace de travail. */
export function applyWorkspace(id: Workspace): void {
  const preset = workspacePreset(id);
  const s = store.getState();
  // L'ombrage passe par l'opérateur s'il existe (il peut prévenir le moteur), sinon directement.
  const { shading, ...rest } = preset.apply;
  store.setState({ workspace: id, ...rest });
  if (shading && shading !== s.shading) runOp('view.shading', { mode: shading }, () => store.setState({ shading }));
  // Modélisation : on entre en mode édition sur l'objet actif s'il s'agit d'un maillage.
  if (id === 'modeling' && s.mode === 'object' && s.activeId) {
    const obj = getApp().doc.getObject(s.activeId);
    if (obj?.type === 'mesh') runOp('object.mode_toggle');
  }
}
