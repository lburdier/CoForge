import { describe, expect, it } from 'vitest';
import {
  canConnect, cloneTree, connect, copyNodes, createNode, disconnectInput, dissolveNodes, duplicateNodes, hasCycle, pasteNodes, removeNodes, sanitizeTree, topoSort, wouldCycle,
  type GraphTree,
} from '../src/core/nodes/graph';
import '../src/core/nodes/shaderNodes';

function chain(): { t: GraphTree; a: string; b: string; c: string; out: string } {
  const t: GraphTree = { nodes: {}, links: [] };
  const a = createNode('shader', 'ShaderNodeTexNoise', 0, 0);
  const b = createNode('shader', 'ShaderNodeMath', 200, 0);
  const c = createNode('shader', 'ShaderNodeBsdfPrincipled', 400, 0);
  const out = createNode('shader', 'ShaderNodeOutputMaterial', 600, 0);
  for (const n of [a, b, c, out]) t.nodes[n.id] = n;
  expect(connect('shader', t, a.id, 'Fac', b.id, 'Value')).toBeTruthy();
  expect(connect('shader', t, b.id, 'Value', c.id, 'Roughness')).toBeTruthy();
  expect(connect('shader', t, c.id, 'BSDF', out.id, 'Surface')).toBeTruthy();
  return { t, a: a.id, b: b.id, c: c.id, out: out.id };
}

describe('graphe de nœuds (utilitaires purs)', () => {
  it('createNode : valeurs par défaut du catalogue', () => {
    const n = createNode('shader', 'ShaderNodeMath', 10.4, 20.6);
    expect(n.inputs.Value).toBe(0.5);
    expect(n.props.operation).toBe('ADD');
    expect([n.x, n.y]).toEqual([10, 21]);
  });

  it('tri topologique : sources d’abord', () => {
    const { t, a, b, c, out } = chain();
    const { order, cyclic } = topoSort(t);
    expect(cyclic).toEqual([]);
    expect(order.indexOf(a)).toBeLessThan(order.indexOf(b));
    expect(order.indexOf(b)).toBeLessThan(order.indexOf(c));
    expect(order.indexOf(c)).toBeLessThan(order.indexOf(out));
  });

  it('cycles refusés, types incompatibles refusés, une entrée = un lien', () => {
    const { t, a, b, c } = chain();
    expect(wouldCycle(t, b, a)).toBe(true);
    expect(connect('shader', t, b.toString(), 'Value', a, 'Scale')).toBeNull();
    expect(canConnect('shader', t, b, 'Value', a, 'Scale')).toMatch(/boucle/);
    expect(canConnect('shader', t, c, 'BSDF', b, 'Value')).toMatch(/incompatibles/);
    const n2 = createNode('shader', 'ShaderNodeValue');
    t.nodes[n2.id] = n2;
    connect('shader', t, n2.id, 'Value', b, 'Value');
    expect(t.links.filter((l) => l.toNode === b && l.toSocket === 'Value').map((l) => l.fromNode)).toEqual([n2.id]);
    expect(hasCycle(t)).toBe(false);
    t.links.push({ id: 'x', fromNode: c, fromSocket: 'BSDF', toNode: b, toSocket: 'Value_001' });
    expect(hasCycle(t)).toBe(true);
    expect(topoSort(t).cyclic.length).toBeGreaterThan(0);
  });

  it('suppression simple et suppression avec reconnexion (Ctrl+X)', () => {
    const { t, a, b, c } = chain();
    const t2 = cloneTree(t);
    dissolveNodes('shader', t2, [b]);
    expect(t2.nodes[b]).toBeUndefined();
    expect(t2.links.some((l) => l.fromNode === a && l.fromSocket === 'Fac' && l.toNode === c && l.toSocket === 'Roughness')).toBe(true);
    removeNodes(t, [b]);
    expect(t.links.some((l) => l.fromNode === b || l.toNode === b)).toBe(false);
    expect(t.links.some((l) => l.toNode === c && l.toSocket === 'Roughness')).toBe(false);
  });

  it('copier / coller et dupliquer : nouveaux identifiants, liens internes conservés', () => {
    const { t, a, b } = chain();
    const clip = copyNodes(t, [a, b]);
    expect(clip.links.length).toBe(1);
    const ids = pasteNodes(t, clip, 50, 50);
    expect(ids.length).toBe(2);
    for (const id of ids) expect([a, b]).not.toContain(id);
    const internal = t.links.filter((l) => ids.includes(l.fromNode) && ids.includes(l.toNode));
    expect(internal.length).toBe(1);
    expect(t.nodes[ids[0]].x).toBe(t.nodes[a].x + 50);
    const dup = duplicateNodes(t, [a]);
    expect(dup.length).toBe(1);
    expect(new Set(t.links.map((l) => l.id)).size).toBe(t.links.length);
  });

  it('disconnectInput et arbre mal formé (venu d’un autre client)', () => {
    const { t, b } = chain();
    expect(disconnectInput(t, b, 'Value')).toBeTruthy();
    expect(disconnectInput(t, b, 'Value')).toBeNull();
    const bad = { nodes: { x: { id: 'x', type: 'ShaderNodeMath', x: NaN, y: 0 }, y: null }, links: [null, { id: 'l', fromNode: 'x', fromSocket: 'Value', toNode: 'zz', toSocket: 'Value' }] } as unknown as GraphTree;
    const s = sanitizeTree(bad);
    expect(Object.keys(s.nodes)).toEqual(['x']);
    expect(s.nodes.x.x).toBe(0);
    expect(s.links).toEqual([]);
    expect(topoSort(bad).order).toContain('x');
  });
});
