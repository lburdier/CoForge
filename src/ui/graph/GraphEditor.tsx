import { store } from '../../app/store';
import { bottomIdOf } from '../dopesheet/DopeSheet';
import { AnimEditorArea } from '../timeline/AnimEditors';

/**
 * Éditeur de courbes (zone du bas) : courbes F colorées (X rouge, Y vert, Z bleu), clés et
 * poignées sélectionnables, G / R / S, T (interpolation), V (type de poignée), Origine (cadrer),
 * normalisation facultative (menu Vue).
 */
export function GraphEditor() {
  return <AnimEditorArea mode="graph" onMode={(m) => store.setState({ bottomEditor: bottomIdOf(m) })} viewKey="bottom" transport={false} />;
}
