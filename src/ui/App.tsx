import './styles/theme.css';
import { Dialogs } from './dialogs/Dialogs';
import { ImportOverlays } from './dialogs/ImportDialogs';
import { WorkspaceLayout } from './layout/WorkspaceLayout';
import { useFollowCamera } from './lib/follow';
import { Popups } from './popups/Popups';
import { RenderWindow } from './render/RenderWindow';
import { StatusBar } from './statusbar/StatusBar';
import { TopBar } from './topbar/TopBar';
import { ErrorBoundary, TooltipLayer } from './widgets/basic';

/**
 * Coquille de l'application, à la Blender : barre supérieure (menus, espaces
 * de travail, session), zones d'éditeurs redimensionnables (viewport 3D,
 * outliner, propriétés), barre d'état ; puis les couches flottantes (menus,
 * dialogues, fenêtre de rendu, infobulles).
 */
export function App() {
  useFollowCamera();
  return (
    <div
      className="cf-app"
      onContextMenu={(e) => {
        // Pas de menu natif du navigateur, sauf dans les champs de saisie (copier / coller).
        if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) e.preventDefault();
      }}
    >
      <ErrorBoundary name="Barre supérieure">
        <TopBar />
      </ErrorBoundary>
      <main className="cf-main">
        <WorkspaceLayout />
      </main>
      <ErrorBoundary name="Barre d'état">
        <StatusBar />
      </ErrorBoundary>
      <ErrorBoundary name="Menus">
        <Popups />
      </ErrorBoundary>
      <Dialogs />
      <ErrorBoundary name="Rendu">
        <RenderWindow />
      </ErrorBoundary>
      <ErrorBoundary name="Import">
        <ImportOverlays />
      </ErrorBoundary>
      <TooltipLayer />
    </div>
  );
}
