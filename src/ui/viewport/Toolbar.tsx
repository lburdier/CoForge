import { ArrowUpFromLine, MousePointer2, Move, RotateCw, Scaling, Scissors, SquareDashed, SquareRoundCorner, type LucideIcon } from 'lucide-react';
import { getApp } from '../../app/context';
import { store, useApp, type ToolId } from '../../app/store';
import { runOp } from '../lib/ops';
import { IconButton } from '../widgets/basic';

const TOOLS: { tool: ToolId; icon: LucideIcon; tip: string; key: string }[] = [
  { tool: 'select', icon: MousePointer2, tip: 'Sélectionner (boîte)', key: 'W' },
  { tool: 'move', icon: Move, tip: 'Déplacer', key: 'G' },
  { tool: 'rotate', icon: RotateCw, tip: 'Tourner', key: 'R' },
  { tool: 'scale', icon: Scaling, tip: 'Redimensionner', key: 'S' },
];

const MESH_TOOLS: { op: string; icon: LucideIcon; tip: string; key: string }[] = [
  { op: 'mesh.extrude', icon: ArrowUpFromLine, tip: 'Extruder', key: 'E' },
  { op: 'mesh.inset', icon: SquareDashed, tip: 'Incruster les faces', key: 'I' },
  { op: 'mesh.bevel', icon: SquareRoundCorner, tip: 'Biseauter', key: 'Ctrl+B' },
  { op: 'mesh.loop_cut', icon: Scissors, tip: 'Coupe en boucle', key: 'Ctrl+R' },
];

function MeshTools() {
  // Ré-évalue la disponibilité quand la sélection d'éléments change.
  useApp((s) => s.editSelection);
  useApp((s) => s.selectMode);
  const ops = getApp().ops;
  return (
    <div className="cf-toolbar-group">
      {MESH_TOOLS.map((t) => (
        <IconButton
          key={t.op}
          icon={t.icon}
          size={16}
          tip={ops.get(t.op)?.label ?? t.tip}
          shortcut={t.key}
          disabled={!ops.canRun(t.op)}
          onClick={(e) => ops.run(t.op, {}, e.nativeEvent)}
        />
      ))}
    </div>
  );
}

/** Barre d'outils verticale à gauche du viewport (touche T). */
export function Toolbar() {
  const show = useApp((s) => s.showToolbar);
  const tool = useApp((s) => s.tool);
  const mode = useApp((s) => s.mode);
  if (!show) return null;
  return (
    <div className="cf-toolbar" onContextMenu={(e) => e.preventDefault()}>
      <div className="cf-toolbar-group">
        {TOOLS.map((t) => (
          <IconButton
            key={t.tool}
            icon={t.icon}
            size={16}
            tip={t.tip}
            shortcut={t.key}
            active={tool === t.tool}
            onClick={() => runOp('view.tool', { tool: t.tool }, () => store.setState({ tool: t.tool }))}
          />
        ))}
      </div>
      {mode === 'edit' && <MeshTools />}
    </div>
  );
}
