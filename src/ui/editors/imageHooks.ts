import { useEffect, useMemo, useState } from 'react';
import { getApp } from '../../app/context';
import { toast } from '../../app/store';
import { platform } from '../../app/platform';
import { IMAGE_FILE_FILTER, imageMimeFromName, importImage, listImages, onImagesChanged, type DocImage } from '../../core/nodes/shader/images';

/** Images du document, relues à chaque ajout / suppression (local ou distant) et au changement de document. */
export function useDocImages(): DocImage[] {
  const [version, setVersion] = useState(0);
  useEffect(() => getApp().onDocChange((doc) => {
    setVersion((v) => v + 1);
    return onImagesChanged(doc, () => setVersion((v) => v + 1));
  }), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => listImages(getApp().doc), [version]);
}

/** URL affichable d'une image (révoquée quand l'image change ou que le composant disparaît). */
export function useImageUrl(img: DocImage | null): string | null {
  const url = useMemo(() => (img ? URL.createObjectURL(new Blob([img.bytes as BlobPart], { type: img.mime })) : null), [img?.id, img?.bytes]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  return url;
}

/** Ouvre une image du disque et l'ajoute à la scène partagée ; renvoie son identifiant. */
export async function openImageFile(): Promise<string | null> {
  const f = await platform.openFile([IMAGE_FILE_FILTER], 'Ouvrir une image');
  if (!f) return null;
  try {
    return await importImage(getApp().doc, f.name, f.data, imageMimeFromName(f.name) ?? undefined);
  } catch (err) {
    toast((err as Error).message, 'error');
    return null;
  }
}
