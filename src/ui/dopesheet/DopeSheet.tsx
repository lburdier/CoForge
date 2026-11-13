import { store, type AnimEditorId } from '../../app/store';
import { AnimEditorArea } from '../timeline/AnimEditors';

/** Identifiant de zone du bas d'un éditeur d'animation (la frise reste dans le bandeau). */
export function bottomIdOf(mode: AnimEditorId): string | null {
  return mode === 'graph' ? 'graph_editor' : mode === 'dopesheet' ? 'dope_sheet' : null;
}

/**
 * Feuille d'exposition (zone du bas, espace « Animation ») : une ligne de losanges par canal,
 * déplacement (G / glisser), échelle (S), suppression (X), duplication (Maj+D), interpolation (T).
 */
export function DopeSheet() {
  return <AnimEditorArea mode="dopesheet" onMode={(m) => store.setState({ bottomEditor: bottomIdOf(m) })} viewKey="bottom" transport={false} />;
}
