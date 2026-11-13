import { Download, File, FilePlus, FolderOpen, Image as ImageIcon, Save, Upload } from 'lucide-react';
import { exportScene, importModel, newScene, openScene, saveRenderImage, saveScene, type ImportGroup } from '../../app/files';
import { useApp } from '../../app/store';
import { EditorHeader, EditorShell } from './common';
import { openImageFile, useDocImages } from './imageHooks';

const IMPORTS: { group: ImportGroup; label: string }[] = [
  { group: 'all', label: 'Tous les formats' },
  { group: 'blend', label: 'Blender (.blend)' },
  { group: 'gltf', label: 'glTF (.glb, .gltf)' },
  { group: 'fbx', label: 'FBX (.fbx)' },
  { group: 'obj', label: 'Wavefront (.obj)' },
  { group: 'misc', label: 'STL, PLY, Collada' },
];

/**
 * Explorateur de fichiers : la scène courante et les échanges avec le disque (ouvrir, enregistrer,
 * importer, exporter). Les fenêtres de choix de fichier du système servent à parcourir le disque.
 */
export function FileBrowserEditor() {
  const filePath = useApp((s) => s.filePath);
  const dirty = useApp((s) => s.dirty);
  const images = useDocImages();

  return (
    <EditorShell className="cf-files">
      <EditorHeader title="Explorateur de fichiers" icon={FolderOpen}>
        <div className="cf-spacer" />
        <span className="cf-ed-dim" title={filePath ?? undefined}>
          {filePath ?? 'Scène non enregistrée'}
          {dirty ? ' · modifiée' : ''}
        </span>
      </EditorHeader>
      <div className="cf-ed-body cf-ed-pad cf-files-grid">
        <section>
          <div className="cf-group-label">Scène</div>
          <button type="button" className="cf-files-item" onClick={() => void newScene()}>
            <FilePlus size={14} /> Nouvelle scène
          </button>
          <button type="button" className="cf-files-item" onClick={() => void openScene()}>
            <FolderOpen size={14} /> Ouvrir…
          </button>
          <button type="button" className="cf-files-item" onClick={() => void saveScene()}>
            <Save size={14} /> Enregistrer
          </button>
          <button type="button" className="cf-files-item" onClick={() => void saveScene(true)}>
            <Save size={14} /> Enregistrer sous…
          </button>
        </section>
        <section>
          <div className="cf-group-label">Importer</div>
          {IMPORTS.map((i) => (
            <button key={i.group} type="button" className="cf-files-item" onClick={() => void importModel(i.group)}>
              <Download size={14} /> {i.label}
            </button>
          ))}
        </section>
        <section>
          <div className="cf-group-label">Exporter</div>
          <button type="button" className="cf-files-item" onClick={() => void exportScene('glb')}>
            <Upload size={14} /> glTF binaire (.glb)
          </button>
          <button type="button" className="cf-files-item" onClick={() => void exportScene('obj')}>
            <Upload size={14} /> Wavefront (.obj)
          </button>
          <button type="button" className="cf-files-item" onClick={() => void saveRenderImage()}>
            <ImageIcon size={14} /> Image du dernier rendu
          </button>
        </section>
        <section>
          <div className="cf-group-label">Images de la scène ({images.length})</div>
          {images.map((i) => (
            <div key={i.id} className="cf-files-item is-static">
              <File size={14} /> {i.name} <span className="cf-ed-dim">{i.width} × {i.height}</span>
            </div>
          ))}
          <button type="button" className="cf-files-item" onClick={() => void openImageFile()}>
            <FolderOpen size={14} /> Ajouter une image…
          </button>
        </section>
      </div>
    </EditorShell>
  );
}
