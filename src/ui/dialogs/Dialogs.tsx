import { useApp } from '../../app/store';
import { ErrorBoundary } from '../widgets/basic';
import { ChatPanel } from './ChatPanel';
import { ImportReportDialog } from './ImportDialogs';
import { AboutDialog, PreferencesDialog, RenameDialog, ShortcutsDialog } from './MiscDialogs';
import { HostDialog, JoinDialog, SessionOverlays } from './SessionDialogs';

/** Affiche la boîte de dialogue désignée par `store.dialog`, plus celles des sessions (invitation, lien reçu). */
export function Dialogs() {
  return (
    <>
      <StoreDialog />
      <ErrorBoundary name="Session">
        <SessionOverlays />
      </ErrorBoundary>
    </>
  );
}

function StoreDialog() {
  const dialog = useApp((s) => s.dialog);
  const epoch = useApp((s) => s.docEpoch);
  if (!dialog) return null;
  let content;
  switch (dialog) {
    case 'host':
      content = <HostDialog />;
      break;
    case 'join':
      content = <JoinDialog />;
      break;
    case 'rename':
      // Le document peut être remplacé pendant que la fenêtre est ouverte : on la réinitialise.
      content = <RenameDialog key={epoch} />;
      break;
    case 'shortcuts':
      content = <ShortcutsDialog />;
      break;
    case 'preferences':
      content = <PreferencesDialog />;
      break;
    case 'about':
      content = <AboutDialog />;
      break;
    case 'chat':
      content = <ChatPanel key={epoch} />;
      break;
    case 'import_report':
      content = <ImportReportDialog />;
      break;
    default:
      return null;
  }
  return <ErrorBoundary name="Boîte de dialogue">{content}</ErrorBoundary>;
}
