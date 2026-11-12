import type { ComponentType } from 'react';

/**
 * CONTRAT : éditeurs affichés dans la zone du bas (sous le viewport 3D) : éditeur de nœuds,
 * éditeur de texte / console Python… Chaque zone d'équipe enregistre le sien avec
 * `registerBottomEditor` ; `store.bottomEditor` (identifiant ou null) choisit celui affiché, et
 * `WorkspaceLayout` le monte. Le composant est chargé à la demande (`lazy`) par son propriétaire
 * s'il est lourd.
 */
export interface BottomEditorDef {
  id: string;
  label: string;
  component: ComponentType;
}

const editors = new Map<string, BottomEditorDef>();
const listeners = new Set<() => void>();

export function registerBottomEditor(def: BottomEditorDef): void {
  editors.set(def.id, def);
  listeners.forEach((l) => l());
}

export function bottomEditor(id: string | null): BottomEditorDef | null {
  return id ? (editors.get(id) ?? null) : null;
}

export function bottomEditors(): BottomEditorDef[] {
  return [...editors.values()];
}

export function onBottomEditorsChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
