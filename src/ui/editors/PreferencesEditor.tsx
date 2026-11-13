import { Settings } from 'lucide-react';
import { PreferencesPanel } from '../dialogs/MiscDialogs';
import { EditorHeader, EditorShell } from './common';

/** Préférences dans une zone (mêmes réglages que le dialogue Édition › Préférences). */
export function PreferencesEditor() {
  return (
    <EditorShell className="cf-prefs">
      <EditorHeader title="Préférences" icon={Settings} />
      <div className="cf-ed-body cf-ed-pad">
        <PreferencesPanel />
      </div>
    </EditorShell>
  );
}
