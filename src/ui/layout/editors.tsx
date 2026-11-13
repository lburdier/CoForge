import { lazy, Suspense, type ReactNode } from 'react';
import type { AnimEditorId } from '../../app/store';
import type { EditorType } from '../lib/areaTree';
import { Outliner } from '../outliner/Outliner';
import { PropertiesEditor } from '../properties/PropertiesEditor';
import { AnimEditorArea } from '../timeline/AnimEditors';
import { ViewportArea } from '../viewport/ViewportArea';

// ------------------------------------------------------------------ rendu d'un éditeur

const LazyShaderEditor = lazy(() => import('../nodes/NodeEditor').then((m) => ({ default: m.ShaderEditor })));
const LazyGeometryEditor = lazy(() => import('../nodes/GeometryNodeEditor').then((m) => ({ default: m.GeometryNodeEditor })));
const LazyImageEditor = lazy(() => import('../editors/ImageEditor').then((m) => ({ default: m.ImageEditor })));
const LazyUVEditor = lazy(() => import('../editors/UVEditor').then((m) => ({ default: m.UVEditor })));
const LazyCompositor = lazy(() => import('../editors/CompositorEditor').then((m) => ({ default: m.CompositorEditor })));
const LazySequencer = lazy(() => import('../editors/SequencerEditor').then((m) => ({ default: m.SequencerEditor })));
const LazyNLA = lazy(() => import('../editors/NLAEditor').then((m) => ({ default: m.NLAEditor })));
const LazyText = lazy(() => import('../editors/TextEditor').then((m) => ({ default: m.TextEditor })));
const LazyConsole = lazy(() => import('../editors/ConsoleEditor').then((m) => ({ default: m.ConsoleEditor })));
const LazyInfo = lazy(() => import('../editors/InfoEditor').then((m) => ({ default: m.InfoEditor })));
const LazyFiles = lazy(() => import('../editors/FileBrowserEditor').then((m) => ({ default: m.FileBrowserEditor })));
const LazySpreadsheet = lazy(() => import('../editors/SpreadsheetEditor').then((m) => ({ default: m.SpreadsheetEditor })));
const LazyPreferences = lazy(() => import('../editors/PreferencesEditor').then((m) => ({ default: m.PreferencesEditor })));

const ANIM_EDITORS: Record<AnimEditorId, EditorType> = { timeline: 'timeline', dopesheet: 'dopesheet', graph: 'graph' };

function Loading({ children, label = 'Chargement de l’éditeur…' }: { children: ReactNode; label?: string }) {
  return <Suspense fallback={<div className="cf-ne-loading">{label}</div>}>{children}</Suspense>;
}

/** Contenu d'une zone selon son éditeur. */
export function EditorContent({ editor, areaId, onEditor }: { editor: EditorType; areaId: string; onEditor(e: EditorType): void }): ReactNode {
  switch (editor) {
    case 'view3d':
      return <ViewportArea />;
    case 'outliner':
      return <Outliner />;
    case 'properties':
      return <PropertiesEditor />;
    case 'shader_nodes':
      return (
        <Loading label="Chargement de l’éditeur de nœuds…">
          <LazyShaderEditor />
        </Loading>
      );
    case 'geometry_nodes':
      return (
        <Loading label="Chargement de l’éditeur de nœuds…">
          <LazyGeometryEditor />
        </Loading>
      );
    case 'timeline':
    case 'dopesheet':
    case 'graph':
      return <AnimEditorArea mode={editor} onMode={(m) => onEditor(ANIM_EDITORS[m])} viewKey={`area:${areaId}`} transport={editor === 'timeline'} />;
    case 'image':
      return (
        <Loading>
          <LazyImageEditor areaId={areaId} />
        </Loading>
      );
    case 'uv':
      return (
        <Loading>
          <LazyUVEditor />
        </Loading>
      );
    case 'compositor':
      return (
        <Loading>
          <LazyCompositor />
        </Loading>
      );
    case 'sequencer':
      return (
        <Loading>
          <LazySequencer />
        </Loading>
      );
    case 'nla':
      return (
        <Loading>
          <LazyNLA />
        </Loading>
      );
    case 'text':
      return (
        <Loading>
          <LazyText areaId={areaId} />
        </Loading>
      );
    case 'console':
      return (
        <Loading>
          <LazyConsole />
        </Loading>
      );
    case 'info':
      return (
        <Loading>
          <LazyInfo />
        </Loading>
      );
    case 'files':
      return (
        <Loading>
          <LazyFiles />
        </Loading>
      );
    case 'spreadsheet':
      return (
        <Loading>
          <LazySpreadsheet />
        </Loading>
      );
    case 'preferences':
      return (
        <Loading>
          <LazyPreferences />
        </Loading>
      );
    default: {
      const never: never = editor;
      return never;
    }
  }
}
