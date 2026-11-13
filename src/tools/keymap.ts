import type { InteractionMode } from '../app/store';

/**
 * Table des raccourcis clavier et souris (cohérente avec src/tools/menus.ts).
 *
 * Correspondance des touches :
 *  - `key` : lettre ou touche nommée comparée à `event.key` (en minuscules) : les lettres suivent
 *    donc la disposition du clavier (AZERTY : la touche marquée « A » donne bien `a`) ;
 *  - `code` : touche PHYSIQUE comparée à `event.code` : chiffres de la rangée du haut
 *    (Digit1… : AZERTY sans Maj), pavé numérique (Numpad0…, NumpadDecimal…) ;
 *  - `mouse` : bouton de souris (affichage dans la boîte « Raccourcis clavier » ; géré par input.ts).
 * Ctrl et Cmd sont équivalents. Les modificateurs doivent correspondre exactement.
 */

export type ShortcutSection = 'Général' | 'Vue' | 'Mode objet' | 'Mode édition' | 'Transformation' | 'Animation';

export interface KeyBinding {
  op: string;
  args?: Record<string, any>;
  key?: string;
  code?: string;
  /** Plusieurs codes physiques acceptés. */
  codes?: string[];
  mouse?: 'left' | 'right' | 'middle';
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** Modes où le raccourci est actif (tous si absent). */
  modes?: InteractionMode[];
  /** Raccourci affiché (ex. « Ctrl+Maj+S », « Num 1 »). */
  display: string;
  section: ShortcutSection;
  /** Libellé affiché si différent de celui de l'opérateur. */
  label?: string;
  /** Le raccourci se répète quand la touche reste enfoncée (annuler/rétablir). */
  repeat?: boolean;
}

const OBJ: InteractionMode[] = ['object'];
const EDIT: InteractionMode[] = ['edit'];

export const KEYMAP: readonly KeyBinding[] = [
  // ------------------------------------------------------------ général
  { op: 'file.new', key: 'n', ctrl: true, display: 'Ctrl+N', section: 'Général' },
  { op: 'file.open', key: 'o', ctrl: true, display: 'Ctrl+O', section: 'Général' },
  { op: 'file.save', key: 's', ctrl: true, display: 'Ctrl+S', section: 'Général' },
  { op: 'file.save_as', key: 's', ctrl: true, shift: true, display: 'Ctrl+Maj+S', section: 'Général' },
  { op: 'edit.undo', key: 'z', ctrl: true, display: 'Ctrl+Z', section: 'Général', repeat: true },
  { op: 'edit.redo', key: 'z', ctrl: true, shift: true, display: 'Ctrl+Maj+Z', section: 'Général', repeat: true },
  { op: 'edit.redo', key: 'y', ctrl: true, display: 'Ctrl+Y', section: 'Général', repeat: true },
  { op: 'view.search', key: 'f3', display: 'F3', section: 'Général' },
  { op: 'render.render', key: 'f12', display: 'F12', section: 'Général' },
  { op: 'render.view', key: 'f11', display: 'F11', section: 'Général' },
  { op: 'screen.workspace_cycle', args: { dir: -1 }, key: 'pageup', ctrl: true, display: 'Ctrl+Pg Préc', section: 'Général', label: 'Espace de travail précédent', repeat: true },
  { op: 'screen.workspace_cycle', args: { dir: 1 }, key: 'pagedown', ctrl: true, display: 'Ctrl+Pg Suiv', section: 'Général', label: 'Espace de travail suivant', repeat: true },
  { op: 'object.mode_toggle', key: 'tab', display: 'Tab', section: 'Vue', label: 'Basculer mode objet / mode édition' },

  // ------------------------------------------------------------ vue
  { op: 'view.toggle_toolbar', key: 't', display: 'T', section: 'Vue' },
  { op: 'view.toggle_sidebar', key: 'n', display: 'N', section: 'Vue' },
  { op: 'view.frame_selected', code: 'NumpadDecimal', display: 'Num .', section: 'Vue' },
  { op: 'view.frame_all', key: 'home', display: 'Origine', section: 'Vue' },
  { op: 'object.set_active_camera', code: 'Numpad0', ctrl: true, modes: OBJ, display: 'Ctrl+Num 0', section: 'Vue' },
  { op: 'view.camera', code: 'Numpad0', display: 'Num 0', section: 'Vue' },
  { op: 'view.toggle_ortho', code: 'Numpad5', display: 'Num 5', section: 'Vue' },
  { op: 'view.axis', args: { dir: 'front' }, code: 'Numpad1', display: 'Num 1', section: 'Vue', label: 'Vue de face' },
  { op: 'view.axis', args: { dir: 'back' }, code: 'Numpad1', ctrl: true, display: 'Ctrl+Num 1', section: 'Vue', label: 'Vue arrière' },
  { op: 'view.axis', args: { dir: 'right' }, code: 'Numpad3', display: 'Num 3', section: 'Vue', label: 'Vue de droite' },
  { op: 'view.axis', args: { dir: 'left' }, code: 'Numpad3', ctrl: true, display: 'Ctrl+Num 3', section: 'Vue', label: 'Vue de gauche' },
  { op: 'view.axis', args: { dir: 'top' }, code: 'Numpad7', display: 'Num 7', section: 'Vue', label: 'Vue de dessus' },
  { op: 'view.axis', args: { dir: 'bottom' }, code: 'Numpad7', ctrl: true, display: 'Ctrl+Num 7', section: 'Vue', label: 'Vue de dessous' },
  { op: 'view.toggle_xray', key: 'z', alt: true, display: 'Alt+Z', section: 'Vue' },
  { op: 'view.shading', key: 'z', display: 'Z', section: 'Vue', label: "Mode d'affichage suivant" },
  { op: 'view.tool', args: { tool: 'select' }, key: 'w', display: 'W', section: 'Vue', label: 'Outil sélection' },
  { op: 'view.snap_cursor', args: { to: 'origin' }, key: 'c', shift: true, display: 'Maj+C', section: 'Vue', label: 'Curseur → origine du monde' },
  { op: 'view.add_menu', key: 'a', shift: true, display: 'Maj+A', section: 'Vue', label: 'Menu Ajouter' },
  { op: 'view.delete_menu', key: 'x', display: 'X', section: 'Vue', label: 'Supprimer' },
  { op: 'view.delete_menu', key: 'delete', display: 'Suppr', section: 'Vue', label: 'Supprimer' },
  { op: 'view.context_menu', mouse: 'right', display: 'Clic droit', section: 'Vue', label: 'Menu contextuel' },
  { op: 'view.cursor_place', mouse: 'right', shift: true, display: 'Maj+Clic droit', section: 'Vue', label: 'Placer le curseur 3D' },

  // ------------------------------------------------------------ transformations
  { op: 'transform.translate', key: 'g', display: 'G', section: 'Transformation' },
  { op: 'transform.rotate', key: 'r', display: 'R', section: 'Transformation' },
  { op: 'transform.scale', key: 's', display: 'S', section: 'Transformation' },

  // ------------------------------------------------------------ mode objet
  { op: 'object.select_all', args: { action: 'select' }, key: 'a', modes: OBJ, display: 'A', section: 'Mode objet', label: 'Tout sélectionner' },
  { op: 'object.select_all', args: { action: 'deselect' }, key: 'a', alt: true, modes: OBJ, display: 'Alt+A', section: 'Mode objet', label: 'Tout désélectionner' },
  { op: 'object.select_all', args: { action: 'invert' }, key: 'i', ctrl: true, modes: OBJ, display: 'Ctrl+I', section: 'Mode objet', label: 'Inverser la sélection' },
  { op: 'object.apply_transform', args: { location: true, rotation: true, scale: true }, key: 'a', ctrl: true, modes: OBJ, display: 'Ctrl+A', section: 'Mode objet' },
  { op: 'object.clear_transform', args: { what: 'location' }, key: 'g', alt: true, modes: OBJ, display: 'Alt+G', section: 'Mode objet', label: 'Effacer la position' },
  { op: 'object.clear_transform', args: { what: 'rotation' }, key: 'r', alt: true, modes: OBJ, display: 'Alt+R', section: 'Mode objet', label: 'Effacer la rotation' },
  { op: 'object.clear_transform', args: { what: 'scale' }, key: 's', alt: true, modes: OBJ, display: 'Alt+S', section: 'Mode objet', label: "Effacer l'échelle" },
  { op: 'object.duplicate', key: 'd', shift: true, modes: OBJ, display: 'Maj+D', section: 'Mode objet' },
  { op: 'object.duplicate', args: { linked: true }, key: 'd', alt: true, modes: OBJ, display: 'Alt+D', section: 'Mode objet', label: 'Dupliquer (lié)' },
  { op: 'object.join', key: 'j', ctrl: true, modes: OBJ, display: 'Ctrl+J', section: 'Mode objet' },
  { op: 'object.parent_set', key: 'p', ctrl: true, modes: OBJ, display: 'Ctrl+P', section: 'Mode objet' },
  { op: 'object.parent_clear', key: 'p', alt: true, modes: OBJ, display: 'Alt+P', section: 'Mode objet' },
  { op: 'object.move_to_collection', key: 'm', modes: OBJ, display: 'M', section: 'Mode objet' },
  { op: 'object.hide', key: 'h', modes: OBJ, display: 'H', section: 'Mode objet' },
  { op: 'object.reveal', key: 'h', alt: true, modes: OBJ, display: 'Alt+H', section: 'Mode objet' },
  { op: 'object.rename', key: 'f2', display: 'F2', section: 'Mode objet' },

  // ------------------------------------------------------------ mode édition
  { op: 'mesh.select_mode', args: { mode: 'vert' }, code: 'Digit1', modes: EDIT, display: '1', section: 'Mode édition', label: 'Sélection de sommets' },
  { op: 'mesh.select_mode', args: { mode: 'edge' }, code: 'Digit2', modes: EDIT, display: '2', section: 'Mode édition', label: "Sélection d'arêtes" },
  { op: 'mesh.select_mode', args: { mode: 'face' }, code: 'Digit3', modes: EDIT, display: '3', section: 'Mode édition', label: 'Sélection de faces' },
  { op: 'mesh.select_all', args: { action: 'select' }, key: 'a', modes: EDIT, display: 'A', section: 'Mode édition', label: 'Tout sélectionner' },
  { op: 'mesh.select_all', args: { action: 'deselect' }, key: 'a', alt: true, modes: EDIT, display: 'Alt+A', section: 'Mode édition', label: 'Tout désélectionner' },
  { op: 'mesh.select_all', args: { action: 'invert' }, key: 'i', ctrl: true, modes: EDIT, display: 'Ctrl+I', section: 'Mode édition', label: 'Inverser la sélection' },
  { op: 'mesh.select_linked', key: 'l', ctrl: true, modes: EDIT, display: 'Ctrl+L', section: 'Mode édition' },
  { op: 'mesh.select_more', code: 'NumpadAdd', ctrl: true, modes: EDIT, display: 'Ctrl+Num +', section: 'Mode édition' },
  { op: 'mesh.select_less', code: 'NumpadSubtract', ctrl: true, modes: EDIT, display: 'Ctrl+Num -', section: 'Mode édition' },
  { op: 'mesh.extrude', key: 'e', modes: EDIT, display: 'E', section: 'Mode édition' },
  { op: 'mesh.extrude_normals', key: 'e', alt: true, modes: EDIT, display: 'Alt+E', section: 'Mode édition' },
  { op: 'mesh.inset', key: 'i', modes: EDIT, display: 'I', section: 'Mode édition' },
  { op: 'mesh.bevel', key: 'b', ctrl: true, modes: EDIT, display: 'Ctrl+B', section: 'Mode édition' },
  { op: 'mesh.loop_cut', key: 'r', ctrl: true, modes: EDIT, display: 'Ctrl+R', section: 'Mode édition' },
  { op: 'mesh.fill', key: 'f', modes: EDIT, display: 'F', section: 'Mode édition' },
  { op: 'mesh.triangulate', key: 't', ctrl: true, modes: EDIT, display: 'Ctrl+T', section: 'Mode édition' },
  { op: 'mesh.duplicate', key: 'd', shift: true, modes: EDIT, display: 'Maj+D', section: 'Mode édition' },
  { op: 'mesh.separate', key: 'p', modes: EDIT, display: 'P', section: 'Mode édition' },
  { op: 'mesh.merge', args: { at: 'center' }, key: 'm', modes: EDIT, display: 'M', section: 'Mode édition', label: 'Fusionner au centre' },
  { op: 'mesh.recalc_normals', key: 'n', shift: true, modes: EDIT, display: 'Maj+N', section: 'Mode édition' },
  { op: 'mesh.dissolve', key: 'x', ctrl: true, modes: EDIT, display: 'Ctrl+X', section: 'Mode édition' },

  // ------------------------------------------------------------ animation
  // Lecture : tête de lecture LOCALE (n'écrit rien dans le document), active partout hors champs de saisie.
  { op: 'anim.play', key: ' ', display: 'Espace', section: 'Général', label: 'Lire / arrêter' },
  { op: 'anim.play', args: { reverse: true }, key: ' ', ctrl: true, shift: true, display: 'Maj+Ctrl+Espace', section: 'Général', label: 'Lire à rebours' },
  { op: 'anim.frame_offset', args: { delta: 1 }, key: 'arrowright', display: '→', section: 'Général', label: 'Image suivante', repeat: true },
  { op: 'anim.frame_offset', args: { delta: -1 }, key: 'arrowleft', display: '←', section: 'Général', label: 'Image précédente', repeat: true },
  { op: 'anim.frame_jump', args: { end: true }, key: 'arrowright', shift: true, display: 'Maj+→', section: 'Général', label: 'Aller à la fin' },
  { op: 'anim.frame_jump', args: { end: false }, key: 'arrowleft', shift: true, display: 'Maj+←', section: 'Général', label: 'Aller au début' },
  { op: 'anim.keyframe_jump', args: { next: true }, key: 'arrowup', display: '↑', section: 'Général', label: 'Image clé suivante', repeat: true },
  { op: 'anim.keyframe_jump', args: { next: false }, key: 'arrowdown', display: '↓', section: 'Général', label: 'Image clé précédente', repeat: true },
  { op: 'render.render_animation', key: 'f12', ctrl: true, display: 'Ctrl+F12', section: 'Général' },
  { op: 'anim.keyframe_insert_menu', key: 'i', modes: OBJ, display: 'I', section: 'Animation' },
  { op: 'anim.keyframe_delete', key: 'i', alt: true, modes: OBJ, display: 'Alt+I', section: 'Animation' },
  { op: 'anim.keyframe_clear', key: 'i', alt: true, shift: true, modes: OBJ, display: 'Maj+Alt+I', section: 'Animation' },
];

/** Nom normalisé de la touche (`event.key` en minuscules ; « Delete », « Home »… en minuscules aussi). */
function keyName(e: KeyboardEvent): string {
  return (e.key ?? '').toLowerCase();
}

/** Le raccourci correspond-il à l'événement clavier, dans ce mode ? */
export function matchesKey(b: KeyBinding, e: KeyboardEvent, mode: InteractionMode): boolean {
  if (b.mouse) return false;
  if (b.modes && !b.modes.includes(mode)) return false;
  const ctrl = e.ctrlKey || e.metaKey;
  if (!!b.ctrl !== ctrl || !!b.shift !== e.shiftKey || !!b.alt !== e.altKey) return false;
  if (b.code) return e.code === b.code;
  if (b.codes) return b.codes.includes(e.code);
  if (!b.key) return false;
  const k = keyName(e);
  if (k === b.key) return true;
  // Lettres : repli sur la touche physique quand event.key n'est pas une lettre latine
  // (disposition non latine, ou Alt+lettre produisant un caractère spécial sur certains claviers).
  if (b.key.length === 1 && /^[a-z]$/.test(b.key) && !/^[a-z]$/.test(k)) return e.code === `Key${b.key.toUpperCase()}`;
  return false;
}

/** Raccourcis candidats pour un événement clavier, dans l'ordre de la table. */
export function findBindings(e: KeyboardEvent, mode: InteractionMode): KeyBinding[] {
  return KEYMAP.filter((b) => matchesKey(b, e, mode));
}

/** Raccourci souris pour un bouton et des modificateurs donnés. */
export function findMouseBinding(button: 'left' | 'right' | 'middle', e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey?: boolean }, mode: InteractionMode): KeyBinding | null {
  const ctrl = e.ctrlKey || !!e.metaKey;
  return (
    KEYMAP.find(
      (b) => b.mouse === button && (!b.modes || b.modes.includes(mode)) && !!b.ctrl === ctrl && !!b.shift === e.shiftKey && !!b.alt === e.altKey,
    ) ?? null
  );
}

/** Raccourci affiché pour un opérateur (et ses arguments), ou null. */
export function shortcutFor(op: string, args?: Record<string, any>, mode?: InteractionMode): string | null {
  const same = (a?: Record<string, any>, b?: Record<string, any>) => {
    const ka = Object.keys(a ?? {});
    const kb = Object.keys(b ?? {});
    if (ka.length !== kb.length) return false;
    return ka.every((k) => JSON.stringify(a![k]) === JSON.stringify(b?.[k]));
  };
  const b = KEYMAP.find((x) => x.op === op && same(x.args, args) && (!mode || !x.modes || x.modes.includes(mode)));
  return b ? b.display : null;
}
