import { registerBottomEditor } from '../lib/areas';
import { DopeSheet } from '../dopesheet/DopeSheet';
import { GraphEditor } from '../graph/GraphEditor';

/** Enregistre les éditeurs d'animation de la zone du bas (espace de travail « Animation »). */
registerBottomEditor({ id: 'dope_sheet', label: "Feuille d'exposition", component: DopeSheet });
registerBottomEditor({ id: 'graph_editor', label: 'Éditeur de courbes', component: GraphEditor });

export { AnimArea, KeyframeMenu } from './AnimArea';
