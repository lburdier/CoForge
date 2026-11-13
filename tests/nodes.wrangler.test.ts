import { describe, expect, it } from 'vitest';
import '../src/core/nodes/shaderCompile';
import type { NodeData } from '../src/core/doc/schema';
import * as ops from '../src/ui/nodes/treeOps';
import * as nw from '../src/ui/nodes/wrangler';

const K = 'shader' as const;

function tree(...nodes: NodeData[]): ops.Tree {
  const t: ops.Tree = { nodes: {}, links: [] };
  for (const n of nodes) t.nodes[n.id] = n;
  return t;
}
const mk = (type: string, x = 0, y = 0) => ops.createNode(K, type, x, y);
const linkTo = (t: ops.Tree, node: string, socket: string) => t.links.find((l) => l.toNode === node && l.toSocket === socket);

describe('Node Wrangler : fusion', () => {
  it('deux couleurs → Mélanger (couleur) au mode demandé', () => {
    const a = mk('ShaderNodeRGB', 0, 0);
    const b = mk('ShaderNodeRGB', 0, 200);
    const t = tree(a, b);
    const m = ops.mergeNodes(K, t, [a.id, b.id], 'MULTIPLY')!;
    expect(t.nodes[m].type).toBe('ShaderNodeMix');
    expect(t.nodes[m].props.blend_type).toBe('MULTIPLY');
    expect(linkTo(t, m, 'A_Color')?.fromNode).toBe(a.id);
    expect(linkTo(t, m, 'B_Color')?.fromNode).toBe(b.id);
  });

  it('deux valeurs → Calcul ; deux shaders → Mélanger / Ajouter les shaders', () => {
    const v1 = mk('ShaderNodeValue', 0, 0);
    const v2 = mk('ShaderNodeValue', 0, 100);
    const t = tree(v1, v2);
    const m = ops.mergeNodes(K, t, [v1.id, v2.id], 'SUBTRACT')!;
    expect(t.nodes[m].type).toBe('ShaderNodeMath');
    expect(t.nodes[m].props.operation).toBe('SUBTRACT');

    const s1 = mk('ShaderNodeBsdfDiffuse', 0, 0);
    const s2 = mk('ShaderNodeEmission', 0, 100);
    const t2 = tree(s1, s2);
    expect(t2.nodes[ops.mergeNodes(K, t2, [s1.id, s2.id], 'MIX')!].type).toBe('ShaderNodeMixShader');
    const t3 = tree(structuredClone(s1), structuredClone(s2));
    expect(t3.nodes[ops.mergeNodes(K, t3, [s1.id, s2.id], 'ADD')!].type).toBe('ShaderNodeAddShader');
  });

  it('moins de deux nœuds : rien', () => {
    const a = mk('ShaderNodeRGB');
    expect(ops.mergeNodes(K, tree(a), [a.id], 'MIX')).toBeNull();
  });

  it('Lazy Mix : Mélanger entre deux nœuds', () => {
    const a = mk('ShaderNodeRGB', 0, 0);
    const b = mk('ShaderNodeRGB', 0, 100);
    const t = tree(a, b);
    const m = nw.lazyMix(K, t, a.id, b.id)!;
    expect(t.nodes[m].type).toBe('ShaderNodeMix');
    expect(nw.lazyMix(K, t, a.id, a.id)).toBeNull();
  });
});

describe('Node Wrangler : liaisons', () => {
  it('connexion paresseuse : premiers sockets de même type', () => {
    const noise = mk('ShaderNodeTexNoise');
    const bsdf = mk('ShaderNodeBsdfPrincipled', 300);
    const t = tree(noise, bsdf);
    expect(ops.lazyConnect(K, t, noise.id, bsdf.id)).toBe(true);
    const l = t.links[0];
    expect(l.fromNode).toBe(noise.id);
    expect(ops.socketType(K, noise, 'out', l.fromSocket)).toBe(ops.socketType(K, bsdf, 'in', l.toSocket));
  });

  it('connexion paresseuse refusée si elle fermait une boucle', () => {
    const a = mk('ShaderNodeMath');
    const b = mk('ShaderNodeMath', 200);
    const t = tree(a, b);
    expect(ops.connect(K, t, a.id, 'Value', b.id, 'Value')).toBe(true);
    expect(ops.lazyConnect(K, t, b.id, a.id)).toBe(false);
  });

  it('échange des deux entrées branchées d’un nœud (Alt+S)', () => {
    const a = mk('ShaderNodeValue');
    const b = mk('ShaderNodeValue', 0, 100);
    const m = mk('ShaderNodeMath', 200);
    const t = tree(a, b, m);
    ops.connect(K, t, a.id, 'Value', m.id, 'Value');
    ops.connect(K, t, b.id, 'Value', m.id, 'Value_001');
    expect(ops.swapLinks(K, t, [m.id])).toBe(true);
    expect(linkTo(t, m.id, 'Value')?.fromNode).toBe(b.id);
    expect(linkTo(t, m.id, 'Value_001')?.fromNode).toBe(a.id);
  });

  it('lier l’actif à la sortie (O), sortie créée au besoin', () => {
    const e = mk('ShaderNodeEmission');
    const t = tree(e);
    expect(nw.linkToOutput(K, t, e.id)).toBe(true);
    const out = ops.outputNode(t)!;
    expect(linkTo(t, out.id, 'Surface')?.fromNode).toBe(e.id);
    const rgb = mk('ShaderNodeRGB');
    t.nodes[rgb.id] = rgb;
    expect(nw.linkToOutput(K, t, rgb.id)).toBe(false);
  });

  it('aperçu Ctrl+Maj+clic : Émission « Aperçu » puis retrait', () => {
    const tex = mk('ShaderNodeTexNoise');
    const bsdf = mk('ShaderNodeBsdfPrincipled', 300);
    const out = mk('ShaderNodeOutputMaterial', 600);
    const t = tree(tex, bsdf, out);
    ops.connect(K, t, bsdf.id, 'BSDF', out.id, 'Surface');
    expect(ops.previewNode(K, t, tex.id, 0)).toBeTruthy();
    const viewer = t.nodes[linkTo(t, out.id, 'Surface')!.fromNode];
    expect(viewer.type).toBe('ShaderNodeEmission');
    expect(ops.clearPreview(t)).toBe(true);
    expect(Object.values(t.nodes).some((n) => n.type === 'ShaderNodeEmission')).toBe(false);
  });

  it('Ctrl+T : Coordonnées de texture → Mappage → texture', () => {
    const tex = mk('ShaderNodeTexNoise', 400);
    const t = tree(tex);
    const created = ops.textureSetup(K, t, [tex.id]);
    expect(created).toHaveLength(2);
    const map = t.nodes[linkTo(t, tex.id, 'Vector')!.fromNode];
    expect(map.type).toBe('ShaderNodeMapping');
    expect(t.nodes[linkTo(t, map.id, 'Vector')!.fromNode].type).toBe('ShaderNodeTexCoord');
  });
});

describe('Node Wrangler : modes, facteur, sélection, libellés', () => {
  it('Alt+haut / bas fait défiler l’opération (avec bouclage)', () => {
    const m = mk('ShaderNodeMath');
    const t = tree(m);
    const first = m.props.operation;
    expect(nw.cycleMode(K, t, [m.id], 1)).toBe(1);
    expect(t.nodes[m.id].props.operation).not.toBe(first);
    nw.cycleMode(K, t, [m.id], -1);
    expect(t.nodes[m.id].props.operation).toBe(first);
    nw.cycleMode(K, t, [m.id], -1);
    expect(t.nodes[m.id].props.operation).not.toBe(first);
  });

  it('Mélanger en couleur : le mode de fusion défile', () => {
    const m = mk('ShaderNodeMix');
    const t = tree(m);
    nw.cycleMode(K, t, [m.id], 1);
    expect(t.nodes[m.id].props.blend_type).not.toBe('MIX');
  });

  it('Alt+gauche / droite : facteur par pas de 0,1, borné', () => {
    const m = mk('ShaderNodeMixShader');
    const t = tree(m);
    nw.changeFactor(K, t, [m.id], 0.1);
    expect(t.nodes[m.id].inputs.Fac).toBeCloseTo(0.6);
    for (let i = 0; i < 10; i++) nw.changeFactor(K, t, [m.id], 0.1);
    expect(t.nodes[m.id].inputs.Fac).toBe(1);
  });

  it('Maj+G : même type', () => {
    const a = mk('ShaderNodeRGB');
    const b = mk('ShaderNodeRGB');
    const c = mk('ShaderNodeValue');
    expect([...nw.selectSameType(tree(a, b, c), [a.id])].sort()).toEqual([a.id, b.id].sort());
  });

  it('copier le libellé : de l’actif, du nœud relié', () => {
    const a = mk('ShaderNodeTexNoise');
    a.label = 'Grain';
    const b = mk('ShaderNodeValToRGB', 300);
    const t = tree(a, b);
    ops.connect(K, t, a.id, 'Fac', b.id, 'Fac');
    expect(nw.copyLabel(K, t, [b.id], 'node', null)).toBe(1);
    expect(t.nodes[b.id].label).toBe('Grain');
    t.nodes[b.id].label = undefined;
    expect(nw.copyLabel(K, t, [a.id, b.id], 'active', a.id)).toBe(1);
    expect(t.nodes[b.id].label).toBe('Grain');
  });

  it('détacher les sorties : copie qui garde ses entrées, aval reconnecté à l’amont', () => {
    const v = mk('ShaderNodeValue');
    const m = mk('ShaderNodeMath', 200);
    const out = mk('ShaderNodeMath', 400);
    const t = tree(v, m, out);
    ops.connect(K, t, v.id, 'Value', m.id, 'Value');
    ops.connect(K, t, m.id, 'Value', out.id, 'Value');
    const [copy] = nw.detachOutputs(K, t, [m.id]);
    expect(t.nodes[m.id]).toBeUndefined();
    expect(linkTo(t, copy, 'Value')?.fromNode).toBe(v.id);
    expect(t.links.some((l) => l.fromNode === copy)).toBe(false);
    expect(linkTo(t, out.id, 'Value')?.fromNode).toBe(v.id);
  });
});

describe('panneau Surface : relier une entrée à un nouveau nœud', () => {
  it('une texture sur la couleur de base, sortie Couleur', () => {
    const bsdf = mk('ShaderNodeBsdfPrincipled', 300);
    const t = tree(bsdf);
    const id = ops.linkInputToNew(K, t, bsdf.id, 'Base Color', 'ShaderNodeTexNoise')!;
    expect(t.nodes[id].type).toBe('ShaderNodeTexNoise');
    expect(linkTo(t, bsdf.id, 'Base Color')).toMatchObject({ fromNode: id, fromSocket: 'Color' });
  });

  it('sur une entrée flottante : sortie flottante (Facteur)', () => {
    const bsdf = mk('ShaderNodeBsdfPrincipled', 300);
    const t = tree(bsdf);
    const id = ops.linkInputToNew(K, t, bsdf.id, 'Roughness', 'ShaderNodeTexNoise')!;
    expect(linkTo(t, bsdf.id, 'Roughness')).toMatchObject({ fromNode: id, fromSocket: 'Fac' });
  });

  it('remplace le lien existant ; type inconnu refusé', () => {
    const bsdf = mk('ShaderNodeBsdfPrincipled', 300);
    const t = tree(bsdf);
    ops.linkInputToNew(K, t, bsdf.id, 'Base Color', 'ShaderNodeRGB');
    const second = ops.linkInputToNew(K, t, bsdf.id, 'Base Color', 'ShaderNodeTexChecker')!;
    expect(t.links.filter((l) => l.toNode === bsdf.id && l.toSocket === 'Base Color')).toHaveLength(1);
    expect(linkTo(t, bsdf.id, 'Base Color')?.fromNode).toBe(second);
    expect(ops.linkInputToNew(K, t, bsdf.id, 'Base Color', 'NodeInexistant')).toBeNull();
    expect(ops.disconnectInput(t, bsdf.id, 'Base Color')).not.toBeNull();
    expect(linkTo(t, bsdf.id, 'Base Color')).toBeUndefined();
  });
});
