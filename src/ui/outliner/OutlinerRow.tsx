import { memo, type DragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import {
  Camera,
  CameraOff,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Eye,
  EyeOff,
  Folder,
  Layers,
  Link,
  MousePointer2,
  MousePointer2Off,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { objectIcon } from '../lib/icons';
import { TextField } from '../widgets/basic';
import { ROOT_KEY, type TreeNode } from './tree';

/** Hauteur d'une ligne (px) : doit rester égale à `--row-h`. */
export const ROW_H = 22;
/** Retrait par niveau (px). */
export const INDENT = 14;

export interface PeerMark {
  clientId: number;
  name: string;
  color: string;
}

export type DropState = 'ok' | 'invalid' | null;

/** Colonne de restriction (bascule d'un drapeau d'objet ou de collection). */
export type RestrictField = 'selectable' | 'visible' | 'renderable';

/** Colonnes de restriction affichées (filtre « Commandes de restriction »). */
export interface RowColumns {
  selectable: boolean;
  visible: boolean;
  renderable: boolean;
}

/** Gestionnaires partagés par toutes les lignes (référence stable). */
export interface RowController {
  click(e: ReactMouseEvent, key: string): void;
  doubleClick(key: string): void;
  contextMenu(e: ReactMouseEvent, key: string): void;
  toggleExpand(key: string, recursive: boolean): void;
  /** Appui sur une bascule de restriction : bascule (Ctrl : isole) et commence un glisser sur la colonne. */
  restrictDown(e: ReactPointerEvent, key: string, field: RestrictField): void;
  /** Le pointeur entre sur la bascule d'une autre ligne pendant ce glisser. */
  restrictEnter(key: string, field: RestrictField): void;
  commitRename(key: string, name: string): void;
  endRename(): void;
  dragStart(e: DragEvent, key: string): void;
  dragOver(e: DragEvent, key: string): void;
  drop(e: DragEvent, key: string): void;
  dragEnd(): void;
}

export interface OutlinerRowProps {
  node: TreeNode;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  index: number;
  selected: boolean;
  active: boolean;
  /** Collection mise en évidence localement (cible de « Nouvelle collection »). */
  current: boolean;
  renaming: boolean;
  drop: DropState;
  peers: PeerMark[] | undefined;
  cols: RowColumns;
  ctl: RowController;
}

const MAX_DOTS = 4;

function contentIcon(n: TreeNode): LucideIcon {
  switch (n.content) {
    case 'material':
      return CircleDot;
    case 'modifiers':
    case 'modifier':
      return Wrench;
    case 'constraints':
    case 'constraint':
      return Link;
    default:
      return objectIcon(n.objType ?? 'empty', n.lightKind);
  }
}

const TIPS: Record<RestrictField, [string, string]> = {
  selectable: ['Désactiver la sélection dans le viewport', 'Activer la sélection dans le viewport'],
  visible: ['Masquer dans le viewport', 'Afficher dans le viewport'],
  renderable: ['Exclure du rendu', 'Inclure dans le rendu'],
};
const DRAG_TIP = ' (Ctrl+clic : isoler ; glisser sur la colonne : appliquer à plusieurs lignes)';

export const OutlinerRow = memo(function OutlinerRow(p: OutlinerRowProps) {
  const { node, depth, hasChildren, expanded, index, selected, active, current, renaming, drop, peers, cols, ctl } = p;
  const isRoot = node.key === ROOT_KEY;
  const isCol = node.kind === 'collection';
  const isContent = node.kind === 'content';
  const Icon = isCol ? (isRoot ? Layers : Folder) : isContent ? contentIcon(node) : objectIcon(node.objType ?? 'empty', node.lightKind);
  const hidden = !node.visible || node.parentHidden;

  const cls = [
    'cf-ol-row',
    index % 2 === 1 ? 'is-alt' : '',
    isCol ? 'is-collection' : isContent ? `is-content content-${node.content}` : `is-object type-${node.objType}`,
    isRoot ? 'is-root' : '',
    selected ? 'is-selected' : '',
    active ? 'is-active' : '',
    current ? 'is-current' : '',
    hidden ? 'is-hidden' : '',
    !isCol && !isContent && !node.selectable ? 'is-unselectable' : '',
    drop === 'ok' ? 'is-drop' : drop === 'invalid' ? 'is-drop-invalid' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const shown = peers ? peers.slice(0, MAX_DOTS) : [];
  const extra = peers ? peers.length - shown.length : 0;

  const toggle = (field: RestrictField, on: boolean, IconOn: LucideIcon, IconOff: LucideIcon, tip: string, inherited = false) => (
    <button
      type="button"
      tabIndex={-1}
      className={`cf-ol-toggle${on ? '' : ' is-off'}${inherited ? ' is-inherited' : ''}`}
      data-tip={tip + (isCol ? '' : DRAG_TIP)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        ctl.restrictDown(e, node.key, field);
      }}
      onPointerEnter={() => ctl.restrictEnter(node.key, field)}
      onClick={(e) => e.stopPropagation()}
    >
      {on ? <IconOn size={13} /> : <IconOff size={13} />}
    </button>
  );
  const spacer = (k: string) => <span key={k} className="cf-ol-toggle-spacer" />;

  return (
    <div
      className={cls}
      style={{ top: index * ROW_H, height: ROW_H }}
      draggable={!isRoot && !isContent && !renaming}
      onClick={(e) => ctl.click(e, node.key)}
      onDoubleClick={(e) => {
        if ((e.target as Element).closest('.cf-ol-cols, .cf-ol-twisty')) return;
        ctl.doubleClick(node.key);
      }}
      onContextMenu={(e) => ctl.contextMenu(e, node.key)}
      onDragStart={(e) => ctl.dragStart(e, node.key)}
      onDragOver={(e) => ctl.dragOver(e, node.key)}
      onDrop={(e) => ctl.drop(e, node.key)}
      onDragEnd={() => ctl.dragEnd()}
    >
      <span className="cf-ol-indent" style={{ width: depth * INDENT }} />
      <span
        className={`cf-ol-twisty${hasChildren ? '' : ' is-empty'}`}
        onClick={(e) => {
          e.stopPropagation();
          if (hasChildren) ctl.toggleExpand(node.key, e.shiftKey);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        data-tip={hasChildren ? 'Déplier / replier (Maj : récursif)' : undefined}
      >
        {hasChildren && (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
      </span>
      <Icon size={13} className={`cf-ol-icon${isCol ? ' is-col' : isContent ? ` is-content is-${node.content}` : ` is-${node.objType}`}`} />
      {renaming ? (
        <span className="cf-ol-rename" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <TextField
            value={node.name}
            autoFocus
            maxLength={63}
            onCommit={(t) => ctl.commitRename(node.key, t)}
            onDone={() => ctl.endRename()}
          />
        </span>
      ) : (
        <span className="cf-ol-name">{node.name}</span>
      )}
      {shown.length > 0 && (
        <span className="cf-ol-peers">
          {shown.map((m) => (
            <span key={m.clientId} className="cf-ol-peer" style={{ background: m.color }} data-tip={`Sélectionné par ${m.name}`} />
          ))}
          {extra > 0 && (
            <span className="cf-ol-peer-more" data-tip={peers!.slice(MAX_DOTS).map((m) => m.name).join(', ')}>
              +{extra}
            </span>
          )}
        </span>
      )}
      {!isRoot && !isContent && (cols.selectable || cols.visible || cols.renderable) && (
        <span className="cf-ol-cols" onDoubleClick={(e) => e.stopPropagation()}>
          {cols.selectable &&
            (isCol ? spacer('s') : toggle('selectable', node.selectable, MousePointer2, MousePointer2Off, TIPS.selectable[node.selectable ? 0 : 1]))}
          {cols.visible &&
            toggle(
              'visible',
              node.visible,
              Eye,
              EyeOff,
              isCol
                ? node.visible
                  ? 'Masquer la collection dans le viewport'
                  : 'Afficher la collection dans le viewport'
                : TIPS.visible[node.visible ? 0 : 1],
              node.parentHidden,
            )}
          {cols.renderable && (isCol ? spacer('r') : toggle('renderable', node.renderable, Camera, CameraOff, TIPS.renderable[node.renderable ? 0 : 1]))}
        </span>
      )}
    </div>
  );
});
