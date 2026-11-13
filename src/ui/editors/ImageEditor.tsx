import { useState } from 'react';
import { FolderOpen, Image as ImageIcon, Trash2 } from 'lucide-react';
import { getApp } from '../../app/context';
import { removeImage } from '../../core/nodes/shader/images';
import { IconButton, Select } from '../widgets/basic';
import { EditorHeader, EditorShell } from './common';
import { openImageFile, useDocImages, useImageUrl } from './imageHooks';
import { PanZoom } from './ImageView';

const currentByArea = new Map<string, string>();

/** Éditeur d'images : images de la scène (textures des matériaux), zoom et déplacement. */
export function ImageEditor({ areaId }: { areaId: string }) {
  const images = useDocImages();
  const [cur, setCurState] = useState<string | null>(() => currentByArea.get(areaId) ?? null);
  const setCur = (id: string | null) => {
    if (id) currentByArea.set(areaId, id);
    setCurState(id);
  };
  const img = images.find((i) => i.id === cur) ?? images[0] ?? null;
  const url = useImageUrl(img);
  const [busy, setBusy] = useState(false);

  const open = async () => {
    setBusy(true);
    const id = await openImageFile();
    setBusy(false);
    if (id) setCur(id);
  };
  const remove = () => {
    if (!img) return;
    if (!window.confirm(`Retirer l’image « ${img.name} » de la scène ? Les nœuds Texture d’image qui l’utilisent n’auront plus d’image.`)) return;
    removeImage(getApp().doc, img.id);
    setCur(null);
  };

  return (
    <EditorShell className="cf-imged">
      <EditorHeader title="Éditeur d’images" icon={ImageIcon}>
        <Select value={img?.id ?? ''} placeholder="Aucune image" options={images.map((i) => ({ value: i.id, label: i.name }))} onChange={setCur} tip="Image affichée" />
        <button type="button" className="cf-btn" onClick={() => void open()} disabled={busy} data-tip="Ouvrir une image (PNG, JPEG, WebP) : elle est ajoutée à la scène partagée">
          <FolderOpen size={12} /> {busy ? 'Chargement…' : 'Ouvrir'}
        </button>
        {img && <IconButton icon={Trash2} tip="Retirer l’image de la scène" onClick={remove} />}
        <div className="cf-spacer" />
        {img && (
          <span className="cf-ed-dim">
            {img.width} × {img.height} px · {img.mime.replace('image/', '').toUpperCase()} · {Math.round(img.bytes.length / 1024)} Kio
          </span>
        )}
      </EditorHeader>
      {!img || !url ? (
        <div className="cf-ed-empty">
          <span>Aucune image dans la scène.</span>
          <button type="button" className="cf-btn" onClick={() => void open()}>
            <FolderOpen size={13} /> Ouvrir une image
          </button>
        </div>
      ) : (
        <PanZoom contentW={img.width || 256} contentH={img.height || 256} fitKey={img.id} className="cf-checker">
          <img src={url} alt={img.name} draggable={false} className="cf-imged-img" />
        </PanZoom>
      )}
    </EditorShell>
  );
}
