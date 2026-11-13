import { useState, type ReactNode } from 'react';
import { getApp } from '../../app/context';
import { useApp } from '../../app/store';
import { animProp } from '../../core/anim/props';
import type { AnimPath } from '../../core/doc/schema';
import { Menu, type UiMenuItem } from '../widgets/Menu';
import { useAnimVersion } from './model';
import './anim.css';

/**
 * Enveloppe d'un champ animable (panneau Propriétés) : couleur par composante comme Blender
 * (jaune : clé à l'image courante, vert : animé, orange : valeur temporaire modifiée sans
 * auto-key) et menu clic droit Insérer / Supprimer l'image clé / Effacer les images clés.
 */

export type AnimFieldState = '' | 'keyed' | 'animated' | 'changed';

export function useAnimFieldStates(owner: string, path: AnimPath): AnimFieldState[] {
  useAnimVersion();
  useApp((s) => s.frame);
  const doc = getApp().doc;
  const size = animProp(path)?.size ?? 1;
  const temp = doc.hasTempValue(owner, path);
  const out: AnimFieldState[] = [];
  for (let i = 0; i < size; i++) {
    if (!doc.isAnimated(owner, path, i)) out.push('');
    else if (temp) out.push('changed');
    else out.push(doc.keyframeAt(owner, path, i) ? 'keyed' : 'animated');
  }
  return out;
}

export function AnimField({ owner, path, children }: { owner: string; path: AnimPath; children: ReactNode }) {
  const states = useAnimFieldStates(owner, path);
  const [menu, setMenu] = useState<{ x: number; y: number; index: number | null } | null>(null);
  const data: Record<string, string> = {};
  states.forEach((s, i) => s && (data[`data-k${i}`] = s));

  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const num = (e.target as Element).closest('.cf-num');
    const nums = num?.parentElement ? [...num.parentElement.children].filter((c) => c.classList.contains('cf-num')) : [];
    const i = num ? nums.indexOf(num) : -1;
    setMenu({ x: e.clientX, y: e.clientY, index: i >= 0 && states.length > 1 ? i : null });
  };

  const items = (): UiMenuItem[] => {
    if (!menu) return [];
    const doc = getApp().doc;
    const def = animProp(path);
    const comp = menu.index !== null ? def?.components[menu.index] : undefined;
    const keyedAll = states.some((s) => s === 'keyed' || s === 'changed');
    const keyedOne = menu.index !== null && (states[menu.index] === 'keyed' || states[menu.index] === 'changed') && !!doc.keyframeAt(owner, path, menu.index);
    const list: UiMenuItem[] = [{ op: 'anim.property_keyframe_insert', args: { owner, path }, label: 'Insérer des images clés' }];
    if (comp !== undefined) list.push({ op: 'anim.property_keyframe_insert', args: { owner, path, index: menu.index }, label: `Insérer une image clé (${comp})` });
    list.push({ separator: true });
    list.push({ op: 'anim.property_keyframe_delete', args: { owner, path }, label: 'Supprimer les images clés', disabled: !keyedAll });
    if (comp !== undefined) list.push({ op: 'anim.property_keyframe_delete', args: { owner, path, index: menu.index }, label: `Supprimer l'image clé (${comp})`, disabled: !keyedOne });
    list.push({ op: 'anim.property_clear', args: { owner, path }, label: 'Effacer les images clés', disabled: !states.some(Boolean) });
    return list;
  };

  return (
    <div className="cf-anim-field" {...data} onContextMenu={onContextMenu}>
      {children}
      {menu && <Menu items={items()} x={menu.x} y={menu.y} title={animProp(path)?.label} onClose={() => setMenu(null)} />}
    </div>
  );
}
