/**
 * Catalogue des opérateurs et structure des menus.
 *
 * Ce fichier est la référence commune :
 *  - l'interface (src/ui) construit ses menus, sa recherche F3 et ses infobulles à partir d'ici ;
 *  - les outils (src/tools) implémentent et enregistrent chaque identifiant listé ;
 *  - un identifiant non enregistré apparaît simplement grisé dans les menus.
 *
 * Les raccourcis indiqués ici sont ceux AFFICHÉS ; leur liaison effective est
 * faite dans src/tools/keymap.ts (qui doit rester cohérent avec ce fichier).
 */

export interface MenuItem {
  /** Identifiant d'opérateur. */
  op?: string;
  args?: Record<string, any>;
  /** Libellé (par défaut : le label de l'opérateur). */
  label?: string;
  /** Raccourci affiché. */
  shortcut?: string;
  /** Nom d'icône lucide-react (optionnel). */
  icon?: string;
  /** Sous-menu. */
  children?: MenuItem[];
  separator?: boolean;
}

const sep: MenuItem = { separator: true };

// ------------------------------------------------------------------ Ajouter (Maj+A)

export const ADD_MENU: MenuItem[] = [
  {
    label: 'Maillage',
    icon: 'Box',
    children: [
      { op: 'object.add', args: { kind: 'plane' }, label: 'Plan', icon: 'Square' },
      { op: 'object.add', args: { kind: 'cube' }, label: 'Cube', icon: 'Box' },
      { op: 'object.add', args: { kind: 'circle' }, label: 'Cercle', icon: 'Circle' },
      { op: 'object.add', args: { kind: 'uvsphere' }, label: 'Sphère UV', icon: 'Globe' },
      { op: 'object.add', args: { kind: 'icosphere' }, label: 'Icosphère', icon: 'Hexagon' },
      { op: 'object.add', args: { kind: 'cylinder' }, label: 'Cylindre', icon: 'Cylinder' },
      { op: 'object.add', args: { kind: 'cone' }, label: 'Cône', icon: 'Cone' },
      { op: 'object.add', args: { kind: 'torus' }, label: 'Tore', icon: 'Torus' },
    ],
  },
  {
    label: 'Lumière',
    icon: 'Lightbulb',
    children: [
      { op: 'object.add', args: { kind: 'light_point' }, label: 'Ponctuelle', icon: 'Lightbulb' },
      { op: 'object.add', args: { kind: 'light_sun' }, label: 'Soleil', icon: 'Sun' },
      { op: 'object.add', args: { kind: 'light_spot' }, label: 'Projecteur', icon: 'Flashlight' },
      { op: 'object.add', args: { kind: 'light_area' }, label: 'Surfacique', icon: 'RectangleHorizontal' },
    ],
  },
  { op: 'object.add', args: { kind: 'camera' }, label: 'Caméra', icon: 'Video' },
  { op: 'object.add', args: { kind: 'empty' }, label: 'Vide', icon: 'Move3d' },
];

/** Types de primitives acceptés par `object.add` (kind) ; en mode édition, `mesh.add_primitive` accepte les kinds de maillage. */
export const MESH_PRIMITIVE_KINDS = ['plane', 'cube', 'circle', 'uvsphere', 'icosphere', 'cylinder', 'cone', 'torus'] as const;
export type MeshPrimitiveKind = (typeof MESH_PRIMITIVE_KINDS)[number];

// ------------------------------------------------------------------ barre de menus principale (haut de fenêtre)

export const FILE_MENU: MenuItem[] = [
  { op: 'file.new', label: 'Nouveau', shortcut: 'Ctrl+N', icon: 'FilePlus' },
  { op: 'file.open', label: 'Ouvrir…', shortcut: 'Ctrl+O', icon: 'FolderOpen' },
  sep,
  { op: 'file.save', label: 'Enregistrer', shortcut: 'Ctrl+S', icon: 'Save' },
  { op: 'file.save_as', label: 'Enregistrer sous…', shortcut: 'Ctrl+Maj+S' },
  sep,
  { op: 'file.import', label: 'Importer…', icon: 'Download' },
  {
    label: 'Importer',
    children: [
      { op: 'file.import', args: { format: 'blend' }, label: 'Blender (.blend)' },
      { op: 'file.import', args: { format: 'gltf' }, label: 'glTF (.glb/.gltf)' },
      { op: 'file.import', args: { format: 'fbx' }, label: 'FBX' },
      { op: 'file.import', args: { format: 'obj' }, label: 'OBJ' },
      { op: 'file.import', args: { format: 'misc' }, label: 'STL / PLY / Collada' },
    ],
  },
  {
    label: 'Exporter',
    icon: 'Upload',
    children: [
      { op: 'file.export', args: { format: 'glb' }, label: 'glTF binaire (.glb)' },
      { op: 'file.export', args: { format: 'obj' }, label: 'Wavefront (.obj)' },
    ],
  },
];

export const EDIT_MENU: MenuItem[] = [
  { op: 'edit.undo', label: 'Annuler', shortcut: 'Ctrl+Z', icon: 'Undo2' },
  { op: 'edit.redo', label: 'Rétablir', shortcut: 'Ctrl+Maj+Z', icon: 'Redo2' },
  sep,
  { op: 'view.search', label: 'Rechercher un opérateur…', shortcut: 'F3', icon: 'Search' },
  sep,
  { op: 'ui.dialog', args: { dialog: 'preferences' }, label: 'Préférences…', icon: 'Settings' },
];

export const RENDER_MENU: MenuItem[] = [
  { op: 'render.render', label: "Rendre l'image", shortcut: 'F12', icon: 'Image' },
  { op: 'render.view', label: 'Voir le rendu', shortcut: 'F11' },
  sep,
  { op: 'object.set_active_camera', label: "Définir l'objet actif comme caméra", shortcut: 'Ctrl+Num 0' },
];

export const SESSION_MENU: MenuItem[] = [
  { op: 'ui.dialog', args: { dialog: 'host' }, label: 'Héberger une session…', icon: 'Server' },
  { op: 'ui.dialog', args: { dialog: 'join' }, label: 'Rejoindre une session…', icon: 'LogIn' },
  sep,
  { op: 'session.leave', label: 'Quitter la session', icon: 'LogOut' },
];

export const HELP_MENU: MenuItem[] = [
  { op: 'ui.dialog', args: { dialog: 'shortcuts' }, label: 'Raccourcis clavier', icon: 'Keyboard' },
  sep,
  { op: 'app.check_updates', label: 'Rechercher des mises à jour', icon: 'Download' },
  { op: 'app.install_update', label: 'Redémarrer et mettre à jour' },
  sep,
  { op: 'ui.dialog', args: { dialog: 'about' }, label: 'À propos de CoForge', icon: 'Info' },
];

export const TOP_MENUS: { label: string; items: MenuItem[] }[] = [
  { label: 'Fichier', items: FILE_MENU },
  { label: 'Édition', items: EDIT_MENU },
  { label: 'Rendu', items: RENDER_MENU },
  { label: 'Session', items: SESSION_MENU },
  { label: 'Aide', items: HELP_MENU },
];

// ------------------------------------------------------------------ en-tête du viewport

export const VIEW_MENU: MenuItem[] = [
  { op: 'view.toggle_toolbar', label: "Barre d'outils", shortcut: 'T' },
  { op: 'view.toggle_sidebar', label: 'Panneau latéral', shortcut: 'N' },
  sep,
  { op: 'view.frame_selected', label: 'Cadrer la sélection', shortcut: 'Num .' },
  { op: 'view.frame_all', label: 'Tout cadrer', shortcut: 'Origine' },
  sep,
  { op: 'view.camera', label: 'Vue caméra', shortcut: 'Num 0' },
  { op: 'view.toggle_ortho', label: 'Perspective / Orthographique', shortcut: 'Num 5' },
  {
    label: 'Point de vue',
    children: [
      { op: 'view.axis', args: { dir: 'front' }, label: 'Face', shortcut: 'Num 1' },
      { op: 'view.axis', args: { dir: 'back' }, label: 'Arrière', shortcut: 'Ctrl+Num 1' },
      { op: 'view.axis', args: { dir: 'right' }, label: 'Droite', shortcut: 'Num 3' },
      { op: 'view.axis', args: { dir: 'left' }, label: 'Gauche', shortcut: 'Ctrl+Num 3' },
      { op: 'view.axis', args: { dir: 'top' }, label: 'Dessus', shortcut: 'Num 7' },
      { op: 'view.axis', args: { dir: 'bottom' }, label: 'Dessous', shortcut: 'Ctrl+Num 7' },
    ],
  },
  sep,
  { op: 'view.toggle_xray', label: 'Rayons X', shortcut: 'Alt+Z' },
];

export const SELECT_MENU_OBJECT: MenuItem[] = [
  { op: 'object.select_all', args: { action: 'select' }, label: 'Tout', shortcut: 'A' },
  { op: 'object.select_all', args: { action: 'deselect' }, label: 'Aucun', shortcut: 'Alt+A' },
  { op: 'object.select_all', args: { action: 'invert' }, label: 'Inverser', shortcut: 'Ctrl+I' },
];

export const OBJECT_MENU: MenuItem[] = [
  {
    label: 'Transformer',
    children: [
      { op: 'transform.translate', label: 'Déplacer', shortcut: 'G' },
      { op: 'transform.rotate', label: 'Tourner', shortcut: 'R' },
      { op: 'transform.scale', label: 'Redimensionner', shortcut: 'S' },
    ],
  },
  {
    label: 'Appliquer',
    children: [
      { op: 'object.apply_transform', args: { location: true, rotation: true, scale: true }, label: 'Toutes les transformations', shortcut: 'Ctrl+A' },
      { op: 'object.apply_transform', args: { location: false, rotation: true, scale: true }, label: 'Rotation et échelle' },
      { op: 'object.apply_transform', args: { location: false, rotation: false, scale: true }, label: 'Échelle' },
    ],
  },
  {
    label: 'Effacer',
    children: [
      { op: 'object.clear_transform', args: { what: 'location' }, label: 'Position', shortcut: 'Alt+G' },
      { op: 'object.clear_transform', args: { what: 'rotation' }, label: 'Rotation', shortcut: 'Alt+R' },
      { op: 'object.clear_transform', args: { what: 'scale' }, label: 'Échelle', shortcut: 'Alt+S' },
    ],
  },
  {
    label: "Définir l'origine",
    children: [
      { op: 'object.origin_set', args: { type: 'geometry' }, label: 'Origine au centre de la géométrie' },
      { op: 'object.origin_set', args: { type: 'cursor' }, label: 'Origine au curseur 3D' },
    ],
  },
  {
    label: 'Aimanter',
    children: [
      { op: 'view.snap_cursor', args: { to: 'selected' }, label: 'Curseur → sélection' },
      { op: 'view.snap_cursor', args: { to: 'origin' }, label: 'Curseur → origine du monde', shortcut: 'Maj+C' },
      { op: 'object.snap_to_cursor', label: 'Sélection → curseur' },
    ],
  },
  sep,
  { op: 'object.duplicate', label: 'Dupliquer', shortcut: 'Maj+D' },
  { op: 'object.duplicate', args: { linked: true }, label: 'Dupliquer (lié)', shortcut: 'Alt+D' },
  { op: 'object.join', label: 'Joindre', shortcut: 'Ctrl+J' },
  sep,
  {
    label: 'Parent',
    children: [
      { op: 'object.parent_set', label: "Parenter à l'objet actif", shortcut: 'Ctrl+P' },
      { op: 'object.parent_clear', label: 'Libérer le parent', shortcut: 'Alt+P' },
    ],
  },
  { op: 'object.move_to_collection', label: 'Déplacer vers une nouvelle collection', shortcut: 'M' },
  sep,
  { op: 'object.shade', args: { smooth: true }, label: 'Ombrage lisse' },
  { op: 'object.shade', args: { smooth: false }, label: 'Ombrage plat' },
  sep,
  { op: 'object.hide', label: 'Masquer la sélection', shortcut: 'H' },
  { op: 'object.reveal', label: 'Tout réafficher', shortcut: 'Alt+H' },
  sep,
  { op: 'object.delete', label: 'Supprimer', shortcut: 'X' },
];

export const SELECT_MENU_EDIT: MenuItem[] = [
  { op: 'mesh.select_all', args: { action: 'select' }, label: 'Tout', shortcut: 'A' },
  { op: 'mesh.select_all', args: { action: 'deselect' }, label: 'Aucun', shortcut: 'Alt+A' },
  { op: 'mesh.select_all', args: { action: 'invert' }, label: 'Inverser', shortcut: 'Ctrl+I' },
  sep,
  { op: 'mesh.select_linked', label: 'Éléments liés', shortcut: 'Ctrl+L' },
  { op: 'mesh.select_more', label: 'Étendre', shortcut: 'Ctrl+Num +' },
  { op: 'mesh.select_less', label: 'Réduire', shortcut: 'Ctrl+Num -' },
];

export const MESH_MENU: MenuItem[] = [
  {
    label: 'Transformer',
    children: [
      { op: 'transform.translate', label: 'Déplacer', shortcut: 'G' },
      { op: 'transform.rotate', label: 'Tourner', shortcut: 'R' },
      { op: 'transform.scale', label: 'Redimensionner', shortcut: 'S' },
    ],
  },
  sep,
  { op: 'mesh.extrude', label: 'Extruder', shortcut: 'E' },
  { op: 'mesh.inset', label: 'Incruster les faces', shortcut: 'I' },
  { op: 'mesh.bevel', label: 'Biseauter', shortcut: 'Ctrl+B' },
  { op: 'mesh.loop_cut', label: 'Coupe en boucle', shortcut: 'Ctrl+R' },
  { op: 'mesh.subdivide', label: 'Subdiviser' },
  sep,
  { op: 'mesh.fill', label: 'Créer arête / face', shortcut: 'F' },
  { op: 'mesh.bridge', label: 'Relier deux boucles (pont)' },
  { op: 'mesh.triangulate', label: 'Trianguler', shortcut: 'Ctrl+T' },
  sep,
  { op: 'mesh.duplicate', label: 'Dupliquer', shortcut: 'Maj+D' },
  { op: 'mesh.separate', label: 'Séparer la sélection', shortcut: 'P' },
  {
    label: 'Fusionner',
    children: [
      { op: 'mesh.merge', args: { at: 'center' }, label: 'Au centre', shortcut: 'M' },
      { op: 'mesh.merge', args: { at: 'cursor' }, label: 'Au curseur 3D' },
      { op: 'mesh.merge', args: { at: 'distance' }, label: 'Par distance' },
    ],
  },
  {
    label: 'Normales',
    children: [
      { op: 'mesh.flip_normals', label: 'Inverser' },
      { op: 'mesh.recalc_normals', label: "Recalculer vers l'extérieur", shortcut: 'Maj+N' },
    ],
  },
  sep,
  { label: 'Supprimer', shortcut: 'X', children: [] /* rempli ci-dessous */ },
];

/** Menu « Supprimer » du mode édition (touche X). */
export const DELETE_MENU_EDIT: MenuItem[] = [
  { op: 'mesh.delete', args: { what: 'verts' }, label: 'Sommets' },
  { op: 'mesh.delete', args: { what: 'edges' }, label: 'Arêtes' },
  { op: 'mesh.delete', args: { what: 'faces' }, label: 'Faces' },
  { op: 'mesh.delete', args: { what: 'only_faces' }, label: 'Faces uniquement (garder les arêtes)' },
  sep,
  { op: 'mesh.dissolve', label: 'Dissoudre', shortcut: 'Ctrl+X' },
];
MESH_MENU[MESH_MENU.length - 1].children = DELETE_MENU_EDIT;

/** Menus contextuels (clic droit dans le viewport). */
export const CONTEXT_MENU_OBJECT: MenuItem[] = [
  { op: 'object.shade', args: { smooth: true }, label: 'Ombrage lisse' },
  { op: 'object.shade', args: { smooth: false }, label: 'Ombrage plat' },
  sep,
  { op: 'object.duplicate', label: 'Dupliquer', shortcut: 'Maj+D' },
  { op: 'object.join', label: 'Joindre', shortcut: 'Ctrl+J' },
  { op: 'object.origin_set', args: { type: 'geometry' }, label: 'Origine au centre de la géométrie' },
  { op: 'object.parent_set', label: "Parenter à l'objet actif", shortcut: 'Ctrl+P' },
  { op: 'object.parent_clear', label: 'Libérer le parent', shortcut: 'Alt+P' },
  sep,
  { op: 'object.rename', label: 'Renommer', shortcut: 'F2' },
  { op: 'object.hide', label: 'Masquer', shortcut: 'H' },
  { op: 'object.delete', label: 'Supprimer', shortcut: 'X' },
];

export const CONTEXT_MENU_EDIT: MenuItem[] = [
  { op: 'mesh.extrude', label: 'Extruder', shortcut: 'E' },
  { op: 'mesh.inset', label: 'Incruster les faces', shortcut: 'I' },
  { op: 'mesh.bevel', label: 'Biseauter', shortcut: 'Ctrl+B' },
  { op: 'mesh.loop_cut', label: 'Coupe en boucle', shortcut: 'Ctrl+R' },
  { op: 'mesh.subdivide', label: 'Subdiviser' },
  sep,
  { op: 'mesh.fill', label: 'Créer arête / face', shortcut: 'F' },
  { op: 'mesh.merge', args: { at: 'center' }, label: 'Fusionner au centre', shortcut: 'M' },
  { op: 'mesh.flip_normals', label: 'Inverser les normales' },
  sep,
  { op: 'mesh.delete', args: { what: 'faces' }, label: 'Supprimer les faces' },
  { op: 'mesh.delete', args: { what: 'verts' }, label: 'Supprimer les sommets' },
  { op: 'mesh.dissolve', label: 'Dissoudre', shortcut: 'Ctrl+X' },
];

/**
 * Autres opérateurs du catalogue (hors menus) :
 *
 *   object.mode_toggle            Tab       bascule mode objet / mode édition (objet actif de type maillage)
 *   object.rename                 F2        renomme l'objet actif, args { name? } ; sans `name` : store.setState({ dialog: 'rename' })
 *   object.modifier_add           args { type: ModifierType }
 *   object.modifier_remove        args { modifierId }
 *   object.modifier_move          args { modifierId, direction: -1 | 1 }
 *   object.modifier_apply         args { modifierId }   applique le modificateur au maillage (et ceux au-dessus de lui d'abord)
 *   mesh.select_mode              1 / 2 / 3   args { mode: 'vert' | 'edge' | 'face' }
 *   mesh.add_primitive            (Maj+A en mode édition) args { kind: MeshPrimitiveKind }
 *   mesh.extrude_normals          Alt+E     extrude les faces le long de leurs normales
 *   view.shading                  args { mode: ShadingMode }   (Z fait défiler les modes)
 *   view.tool                     args { tool: ToolId }        (W sélection, puis G/R/S restent des opérateurs)
 *   view.cursor_place             Maj+clic droit : place le curseur 3D sous le pointeur
 *   view.context_menu             clic droit : store.setState({ popup: { kind: 'context', x, y } })   (x, y = clientX, clientY)
 *   view.add_menu                 Maj+A : store.setState({ popup: { kind: 'add', x, y } })
 *   view.delete_menu              X : supprime (mode objet) ou ouvre le menu Supprimer (mode édition : popup kind 'delete')
 *
 * Opérateurs enregistrés par l'application (src/app/appOps.ts), pas par les outils :
 *   file.new, file.open (scène .coforge, ou fichier 3D ouvert comme nouvelle scène), file.save, file.save_as,
 *   file.import { format?: 'all' | 'blend' | 'gltf' | 'fbx' | 'obj' | 'misc' } (formats proposés d'abord dans la boîte),
 *   file.export { format },
 *   edit.undo, edit.redo, render.render, render.view, session.leave,
 *   ui.dialog { dialog }, view.search
 */
export const CATALOG_VERSION = 1;
