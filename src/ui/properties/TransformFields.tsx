import { getApp } from '../../app/context';
import type { Vec3 } from '../../core/doc/schema';
import { DEG2RAD, RAD2DEG, tidy } from '../lib/util';
import { AnimField } from '../timeline/AnimField';
import { VectorField } from '../widgets/NumberField';
import { useObject } from './docHooks';

/**
 * Position / rotation (degrés) / échelle d'un objet. Se vide sans erreur si l'objet disparaît.
 * Champs animables : couleur d'état et clic droit Insérer / Supprimer l'image clé (AnimField).
 */
export function TransformFields({ id }: { id: string }) {
  // Relu seulement quand CET objet change (pas à chaque mouvement d'un autre objet).
  const obj = useObject(id);
  if (!obj) return null;
  const deg: Vec3 = [tidy(obj.rot[0] * RAD2DEG), tidy(obj.rot[1] * RAD2DEG), tidy(obj.rot[2] * RAD2DEG)];
  return (
    <div className="cf-transform">
      <div className="cf-group-label">Position</div>
      <AnimField owner={id} path="location">
        <VectorField value={obj.pos} unit="m" step={0.01} onChange={(pos) => getApp().doc.updateObject(id, { pos })} />
      </AnimField>
      <div className="cf-group-label">Rotation</div>
      <AnimField owner={id} path="rotation_euler">
        <VectorField
          value={deg}
          unit="°"
          step={0.5}
          precision={2}
          onChange={(next) => {
            // Seule la composante modifiée est reconvertie : les autres gardent leur valeur exacte en radians.
            const cur = getApp().doc.getObject(id);
            if (!cur) return;
            const rot: Vec3 = [cur.rot[0], cur.rot[1], cur.rot[2]];
            for (let i = 0; i < 3; i++) {
              if (next[i] !== tidy(cur.rot[i] * RAD2DEG)) rot[i] = next[i] * DEG2RAD;
            }
            getApp().doc.updateObject(id, { rot });
          }}
        />
      </AnimField>
      <div className="cf-group-label">Échelle</div>
      <AnimField owner={id} path="scale">
        <VectorField value={obj.scl} step={0.01} onChange={(scl) => getApp().doc.updateObject(id, { scl })} />
      </AnimField>
    </div>
  );
}
