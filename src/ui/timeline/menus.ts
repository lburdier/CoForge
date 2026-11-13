import type { UiMenuItem } from '../widgets/Menu';

/** Menus des éditeurs d'animation (T, Ctrl+E, V, clic droit). */

const sep: UiMenuItem = { separator: true };

const ipo = (type: string, label: string): UiMenuItem => ({ op: 'anim.keys_interpolation', args: { type }, label });

export function interpolationMenu(): UiMenuItem[] {
  return [
    ipo('CONSTANT', 'Constante'),
    ipo('LINEAR', 'Linéaire'),
    ipo('BEZIER', 'Bézier'),
    sep,
    {
      label: 'Atténuation (Penner)',
      children: [
        ipo('SINE', 'Sinusoïdale'),
        ipo('QUAD', 'Quadratique'),
        ipo('CUBIC', 'Cubique'),
        ipo('QUART', 'Quartique'),
        ipo('QUINT', 'Quintique'),
        ipo('EXPO', 'Exponentielle'),
        ipo('CIRC', 'Circulaire'),
      ],
    },
    {
      label: 'Dynamique',
      children: [ipo('BACK', 'Retour (Back)'), ipo('BOUNCE', 'Rebond'), ipo('ELASTIC', 'Élastique')],
    },
  ];
}

export function easingMenu(): UiMenuItem[] {
  const e = (easing: string, label: string): UiMenuItem => ({ op: 'anim.keys_easing', args: { easing }, label });
  return [e('AUTO', 'Automatique'), e('EASE_IN', 'Entrée'), e('EASE_OUT', 'Sortie'), e('EASE_IN_OUT', 'Entrée et sortie')];
}

export function handleTypeMenu(): UiMenuItem[] {
  const h = (type: string, label: string): UiMenuItem => ({ op: 'anim.keys_handle_type', args: { type }, label });
  return [h('FREE', 'Libre'), h('VECTOR', 'Vecteur'), h('ALIGNED', 'Alignée'), h('AUTO', 'Automatique'), h('AUTO_CLAMPED', 'Automatique bornée')];
}

export function keyContextMenu(graph: boolean): UiMenuItem[] {
  return [
    { label: "Mode d'interpolation", shortcut: 'T', children: interpolationMenu() },
    { label: 'Atténuation', shortcut: 'Ctrl+E', children: easingMenu() },
    ...(graph ? [{ label: 'Type de poignée', shortcut: 'V', children: handleTypeMenu() }] : []),
    sep,
    { op: 'anim.keys_duplicate', label: 'Dupliquer (+1 image)', shortcut: 'Maj+D' },
    { op: 'anim.keys_jump', label: 'Aller aux clés sélectionnées' },
    { op: 'anim.keys_select_column', label: "Sélectionner les clés de l'image courante", shortcut: 'K' },
    sep,
    { op: 'anim.keys_delete', label: 'Supprimer les images clés', shortcut: 'X' },
    { op: 'anim.channels_clear', label: 'Effacer les canaux' },
  ];
}
