import { lazy, Suspense } from 'react';
import { registerBottomEditor } from '../lib/areas';
import './nodeWrangler';
// Styles chargés dès le démarrage : l'onglet Matériau (panneau Surface) en utilise aussi.
import './nodes.css';

/**
 * Enregistre l'éditeur de shaders dans la zone du bas (espace de travail « Shading »). Le code
 * de l'éditeur (et le compilateur de nœuds) n'est chargé qu'à la première ouverture.
 */
const LazyShaderEditor = lazy(() => import('./NodeEditor').then((m) => ({ default: m.ShaderEditor })));

function ShaderEditorArea() {
  return (
    <Suspense fallback={<div className="cf-ne-loading">Chargement de l’éditeur de nœuds…</div>}>
      <LazyShaderEditor />
    </Suspense>
  );
}

registerBottomEditor({ id: 'shader_nodes', label: 'Éditeur de shaders', component: ShaderEditorArea });
