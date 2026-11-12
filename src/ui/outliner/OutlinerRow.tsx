import { memo, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { Camera, CameraOff, ChevronDown, ChevronRight, Eye, EyeOff, Folder, Layers } from 'lucide-react';
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

/** Gestionnaires partagés par toutes les lignes (référence stable). */
export interface RowController {
  click(e: ReactMouseEvent, key: string): void;
  doubleClick(key: string): void;
  contextMenu(e: ReactMouseEvent, key: string): void;
  toggleExpand(key: string, recursive: boolean): void;
  toggleVisible(key: string): void;
  toggleRenderable(key: string): void;
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
  ctl: RowController;
}

const MAX_DOTS = 4;

export const OutlinerRow = memo(function OutlinerRow(p: OutlinerRowProps) {
  const { node, depth, hasChildren, expanded, index, selected, active, current, renaming, drop, peers, ctl } = p;
  const isRoot = node.key === ROOT_KEY;
  const isCol = node.kind === 'collection';
  const Icon = isCol ? (isRoot ? Layers : Folder) : objectIcon(node.objType ?? 'empty', node.lightKind);
  const hidden = !node.visible || node.parentHidden;

  const cls = [
    'cf-ol-row',
    index % 2 === 1 ? 'is-alt' : '',
    isCol ? 'is-collection' : `is-object type-${node.objType}`,
    isRoot ? 'is-root' : '',
    selected ? 'is-selected' : '',
    active ? 'is-active' : '',
    current ? 'is-current' : '',
    hidden ? 'is-hidden' : '',
    drop === 'ok' ? 'is-drop' : drop === 'invalid' ? 'is-drop-invalid' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const shown = peers ? peers.slice(0, MAX_DOTS) : [];
  const extra = peers ? peers.length - shown.length : 0;

  return (
    <div
      className={cls}
      style={{ top: index * ROW_H, height: ROW_H }}
      draggable={!isRoot && !renaming}
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
      <Icon size={13} className={`cf-ol-icon${isCol ? ' is-col' : ` is-${node.objType}`}`} />
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
      {!isRoot && (
        <span className="cf-ol-cols" onDoubleClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            tabIndex={-1}
            className={`cf-ol-toggle${node.visible ? '' : ' is-off'}${node.parentHidden ? ' is-inherited' : ''}`}
            data-tip={
              isCol
                ? node.visible
                  ? 'Masquer la collection dans le viewport'
                  : 'Afficher la collection dans le viewport'
                : node.visible
                  ? 'Masquer dans le viewport'
                  : 'Afficher dans le viewport'
            }
            onClick={(e) => {
              e.stopPropagation();
              ctl.toggleVisible(node.key);
            }}
          >
            {node.visible ? <Eye size={13} /> : <EyeOff size={13} />}
          </button>
          {!isCol ? (
            <button
              type="button"
              tabIndex={-1}
              className={`cf-ol-toggle${node.renderable ? '' : ' is-off'}`}
              data-tip={node.renderable ? 'Exclure du rendu' : 'Inclure dans le rendu'}
              onClick={(e) => {
                e.stopPropagation();
                ctl.toggleRenderable(node.key);
              }}
            >
              {node.renderable ? <Camera size={13} /> : <CameraOff size={13} />}
            </button>
          ) : (
            <span className="cf-ol-toggle-spacer" />
          )}
        </span>
      )}
    </div>
  );
});
