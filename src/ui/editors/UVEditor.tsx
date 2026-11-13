import { useMemo, useState } from 'react';
import { Grid3x3 } from 'lucide-react';
import { useApp } from '../../app/store';
import type { MeshData } from '../../core/doc/schema';
import { meshBounds } from '../../core/mesh/topology';
import { useDocWhen, useObject } from '../properties/docHooks';
import { Select } from '../widgets/basic';
import { EditorHeader, EditorShell } from './common';
import { useDocImages, useImageUrl } from './imageHooks';
import { PanZoom } from './ImageView';

type Projection = 'xy' | 'xz' | 'yz';
const SIZE = 512;
const MAX_FACES = 20000;
const NONE = '__none__';

/**
 * Éditeur UV. CoForge n'a pas (encore) de cartes UV : les textures utilisent les coordonnées
 * « Générées » (position dans la boîte englobante de l'objet). L'éditeur montre donc où tombe
 * chaque face dans cet espace, sur l'image choisie, selon la projection (XY par défaut, celle
 * des nœuds Texture d'image).
 */
export function UVEditor() {
  const activeId = useApp((s) => s.activeId);
  const mode = useApp((s) => s.mode);
  const editSel = useApp((s) => s.editSelection);
  const obj = useObject(activeId);
  const dataId = obj?.type === 'mesh' ? obj.data : null;
  const mesh = useDocWhen<MeshData | null>((doc) => (dataId ? doc.getMesh(dataId) : null), { mesh: (e) => e.id === dataId }, [dataId]);
  const [proj, setProj] = useState<Projection>('xy');
  const images = useDocImages();
  const [imgId, setImgId] = useState<string>(NONE);
  const img = images.find((i) => i.id === imgId) ?? null;
  const url = useImageUrl(img);

  const polys = useMemo(() => {
    if (!mesh) return [];
    const b = meshBounds(mesh);
    if (!b) return [];
    const [a, c] = proj === 'xy' ? [0, 1] : proj === 'xz' ? [0, 2] : [1, 2];
    const sa = b.max[a] - b.min[a] || 1;
    const sc = b.max[c] - b.min[c] || 1;
    const out: { id: string; pts: string }[] = [];
    for (const [id, loop] of mesh.faces) {
      if (out.length >= MAX_FACES) break;
      const pts: string[] = [];
      for (const v of loop) {
        const p = mesh.verts.get(v);
        if (!p) continue;
        pts.push(`${(((p[a] - b.min[a]) / sa) * SIZE).toFixed(1)},${((1 - (p[c] - b.min[c]) / sc) * SIZE).toFixed(1)}`);
      }
      if (pts.length >= 3) out.push({ id, pts: pts.join(' ') });
    }
    return out;
  }, [mesh, proj]);

  const showSel = mode === 'edit' && editSel.faces.size > 0;

  return (
    <EditorShell className="cf-uved">
      <EditorHeader title="Éditeur UV" icon={Grid3x3}>
        <Select<Projection>
          value={proj}
          options={[
            { value: 'xy', label: 'Générées X / Y (textures)' },
            { value: 'xz', label: 'Générées X / Z' },
            { value: 'yz', label: 'Générées Y / Z' },
          ]}
          onChange={setProj}
          tip="Projection affichée"
        />
        <Select value={img ? img.id : NONE} options={[{ value: NONE, label: 'Sans image' }, ...images.map((i) => ({ value: i.id, label: i.name }))]} onChange={setImgId} tip="Image de fond" />
        <div className="cf-spacer" />
        <span className="cf-ed-dim" data-tip="CoForge n’a pas encore de cartes UV : les textures utilisent les coordonnées générées (boîte englobante de l’objet).">
          Coordonnées générées · {polys.length} face(s)
        </span>
      </EditorHeader>
      {!mesh ? (
        <div className="cf-ed-empty">{obj ? 'L’objet actif n’est pas un maillage.' : 'Sélectionnez un maillage pour voir son dépliage.'}</div>
      ) : (
        <PanZoom contentW={SIZE} contentH={SIZE} fitKey={`${dataId}`} className="cf-uved-canvas">
          {url ? <img src={url} alt="" draggable={false} className="cf-uved-img" /> : <div className="cf-uved-grid" />}
          <svg className="cf-uved-svg" width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
            <rect x={0} y={0} width={SIZE} height={SIZE} className="cf-uved-bounds" />
            {polys.map((p) => (
              <polygon key={p.id} points={p.pts} className={showSel && editSel.faces.has(p.id) ? 'is-selected' : ''} />
            ))}
          </svg>
        </PanZoom>
      )}
    </EditorShell>
  );
}
