import { useState } from 'react';
import { CircleDot, ExternalLink } from 'lucide-react';
import type { MaterialData, NodeData } from '../../core/doc/schema';
import { activeOutput, compileShaderTree } from '../../core/nodes/shaderCompile';
import { PRINCIPLED_PANELS } from '../../core/nodes/shaderNodes';
import { nodeType, visibleSockets, type SocketDef } from '../../core/nodes/types';
import { applyWorkspace } from '../lib/workspaces';
import { commitTree } from '../nodes/commit';
import { disconnectInput, linkInputToNew, QUICK_LINK_TYPES } from '../nodes/treeOps';
import { Menu, type UiMenuItem } from '../widgets/Menu';
import { ColorField, Hint, Panel, Row } from '../widgets/basic';
import { NumberField, Slider, VectorField } from '../widgets/NumberField';
import { useDocWhen } from './docHooks';

/**
 * Onglet Matériau d'un matériau à nœuds, comme dans Blender : le shader branché sur la sortie
 * (Principled BSDF en général) avec toutes ses entrées, rangées par panneau. Une entrée branchée
 * affiche le nœud qui l'alimente ; le reste se règle ici ou dans l'éditeur de shaders.
 */
export function MaterialNodeFields({ mat }: { mat: MaterialData }) {
  const treeId = mat.nodeTree!;
  const tree = useDocWhen((doc) => doc.getNodeTree(treeId), { data: (e) => e.table === 'nodeTrees' }, [treeId]);
  const [linkMenu, setLinkMenu] = useState<{ x: number; y: number; items: UiMenuItem[] } | null>(null);
  if (!tree) return <Hint className="cf-props-empty">Arbre de nœuds introuvable.</Hint>;
  const out = activeOutput(tree);
  const link = out ? tree.links.find((l) => l.toNode === out.id && l.toSocket === 'Surface') : undefined;
  const shader = link ? tree.nodes[link.fromNode] : undefined;
  const def = shader ? nodeType('shader', shader.type) : null;
  const notes = compileShaderTree(tree).notes;

  const write = (nodeId: string, socket: string, value: unknown) =>
    commitTree(treeId, mat.id, (t) => {
      const n = t.nodes[nodeId];
      if (!n) return false;
      n.inputs = { ...n.inputs, [socket]: value };
    });

  const sourceLabel = (node: NodeData, socket: string): string | null => {
    const l = tree.links.find((x) => x.toNode === node.id && x.toSocket === socket);
    if (!l) return null;
    const src = tree.nodes[l.fromNode];
    const sd = src ? nodeType('shader', src.type) : null;
    const outLabel = sd?.outputs.find((o) => o.id === l.fromSocket)?.label;
    return `${src?.label || sd?.label || '?'}${outLabel && sd && sd.outputs.length > 1 ? ` › ${outLabel}` : ''}`;
  };

  /** Menu d'une entrée (comme le bouton rond de Blender) : la relier à un nœud courant ou la déconnecter. */
  const openLinkMenu = (el: HTMLElement, node: NodeData, s: SocketDef) => {
    const r = el.getBoundingClientRect();
    const linked = tree.links.some((l) => l.toNode === node.id && l.toSocket === s.id);
    const types = QUICK_LINK_TYPES.map((t) => nodeType('shader', t)).filter((d): d is NonNullable<typeof d> => !!d);
    const items: UiMenuItem[] = [
      {
        label: 'Déconnecter',
        disabled: !linked,
        action: () => commitTree(treeId, mat.id, (t) => disconnectInput(t, node.id, s.id) !== null),
      },
      { separator: true },
      ...types.map((d) => ({
        label: d.label,
        action: () => {
          commitTree(treeId, mat.id, (t) => linkInputToNew('shader', t, node.id, s.id, d.id) !== null);
        },
      })),
    ];
    setLinkMenu({ x: r.left, y: r.bottom, items });
  };

  const linkButton = (node: NodeData, s: SocketDef) =>
    s.type === 'shader' ? null : (
      <button
        type="button"
        className="cf-props-linkbtn"
        data-tip="Relier cette entrée à un nœud (texture, valeur…) ou la déconnecter"
        onClick={(e) => openLinkMenu(e.currentTarget, node, s)}
      >
        <CircleDot size={12} />
      </button>
    );

  const field = (node: NodeData, s: SocketDef) => {
    const src = sourceLabel(node, s.id);
    if (src) return <span className="cf-props-linked" data-tip="Entrée branchée : modifiez-la dans l’éditeur de shaders">← {src}</span>;
    if (s.hideValue || s.type === 'shader') return <span className="cf-props-linked is-dim">Non branché</span>;
    const raw = node.inputs?.[s.id] ?? s.default;
    if (s.type === 'color') return <ColorField value={String(raw)} onChange={(v) => write(node.id, s.id, v)} />;
    if (s.type === 'vector') {
      const v = (Array.isArray(raw) ? raw : [0, 0, 0]) as [number, number, number];
      return <VectorField value={v} onChange={(nv) => write(node.id, s.id, nv)} />;
    }
    const n = Number(raw);
    if (s.subtype === 'factor') return <Slider value={Number.isFinite(n) ? n : 0} min={s.min ?? 0} max={s.max ?? 1} onChange={(v) => write(node.id, s.id, v)} />;
    return <NumberField value={Number.isFinite(n) ? n : 0} min={s.min} max={s.max} step={s.step ?? 0.01} onChange={(v) => write(node.id, s.id, v)} />;
  };

  const inputs = shader && def ? visibleSockets(def.inputs, shader.props ?? {}) : [];
  const main = inputs.filter((s) => !s.panel);
  const panels = def?.id === 'ShaderNodeBsdfPrincipled' ? PRINCIPLED_PANELS : [...new Set(inputs.filter((s) => s.panel).map((s) => s.panel!))];

  return (
    <>
      <Panel
        id="material.nodes.surface"
        title={`Surface : ${shader ? shader.label || def?.label || shader.type : 'aucun shader'}`}
        extra={
          <button type="button" className="cf-btn cf-btn-small" data-tip="Ouvrir l’espace Shading (éditeur de nœuds)" onClick={() => applyWorkspace('shading')}>
            <ExternalLink size={12} />
            <span>Nœuds</span>
          </button>
        }
      >
        {!out && <Hint>Pas de « Sortie du matériau » : le matériau est rendu noir.</Hint>}
        {out && !shader && <Hint>Rien n’est branché sur la surface : le matériau est rendu noir.</Hint>}
        {shader && main.map((s) => (
          <Row key={s.id} label={s.label}>
            <div className="cf-props-nodefield">
              {linkButton(shader, s)}
              {field(shader, s)}
            </div>
          </Row>
        ))}
      </Panel>
      {shader &&
        panels.map((p) => {
          const members = inputs.filter((s) => s.panel === p);
          if (!members.length) return null;
          return (
            <Panel key={p} id={`material.nodes.${p}`} title={p} defaultOpen={false}>
              {members.map((s) => (
                <Row key={s.id} label={s.label}>
                  <div className="cf-props-nodefield">
                    {linkButton(shader, s)}
                    {field(shader, s)}
                  </div>
                </Row>
              ))}
            </Panel>
          );
        })}
      {linkMenu && <Menu items={linkMenu.items} x={linkMenu.x} y={linkMenu.y} title="Relier l’entrée" onClose={() => setLinkMenu(null)} />}
      {notes.length > 0 && (
        <Panel id="material.nodes.notes" title="Rendu dans CoForge" defaultOpen={false}>
          <ul className="cf-props-notes">
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}
