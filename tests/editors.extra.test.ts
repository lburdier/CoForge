import { describe, expect, it } from 'vitest';
import { cameraForFrame, cameraShots } from '../src/app/cameraMarkers';
import { compositePixels } from '../src/app/composite';
import { SceneDoc } from '../src/core/doc/SceneDoc';
import { COMPOSITOR_DEFAULTS, type MeshData, type NodeTreeData } from '../src/core/doc/schema';
import { defaultGeometryTree, evaluateGeometryTree } from '../src/core/nodes/geometryNodes';
import { nodeType } from '../src/core/nodes/types';
import { MeshEvaluator } from '../src/engine/meshCache';
import { defaultAreaTree, EDITOR_TYPES, leaves, sanitizeAreaTree } from '../src/ui/lib/areaTree';
import { EDITOR_ENTRIES } from '../src/ui/layout/editorTypes';

const nullCtx = { getOperand: () => null, getNodeTree: () => null };

function tree(nodes: NodeTreeData['nodes'], links: NodeTreeData['links']): Pick<NodeTreeData, 'nodes' | 'links'> {
  return { nodes, links };
}
const node = (id: string, type: string, inputs: Record<string, unknown> = {}, props: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, inputs, props });
const link = (id: string, fromNode: string, fromSocket: string, toNode: string, toSocket: string) => ({ id, fromNode, fromSocket, toNode, toSocket });

const square: MeshData = {
  verts: new Map([
    ['a', [0, 0, 0]],
    ['b', [1, 0, 0]],
    ['c', [1, 1, 0]],
    ['d', [0, 1, 0]],
  ]),
  faces: new Map([['f', ['a', 'b', 'c', 'd']]]),
};

describe('nœuds de géométrie', () => {
  it('catalogue enregistré, arbre par défaut = entrée → sortie (maillage inchangé)', () => {
    expect(nodeType('geometry', 'GeometryNodeMeshCube')).toBeTruthy();
    expect(nodeType('geometry', 'NodeReroute')?.layout).toBe('reroute');
    const r = evaluateGeometryTree(defaultGeometryTree(), square, nullCtx, 's');
    expect(r.mesh).toBe(square);
  });

  it('cube transformé et joint à l’entrée, identifiants déterministes', () => {
    const t = tree(
      {
        gin: node('gin', 'GeometryNodeGroupInput'),
        cube: node('cube', 'GeometryNodeMeshCube', { Size: [2, 2, 2] }),
        tr: node('tr', 'GeometryNodeTransform', { Translation: [0, 0, 5] }),
        join: node('join', 'GeometryNodeJoinGeometry'),
        out: node('out', 'GeometryNodeGroupOutput'),
      },
      [
        link('l1', 'cube', 'Mesh', 'tr', 'Geometry'),
        link('l2', 'gin', 'Geometry', 'join', 'Geometry'),
        link('l3', 'tr', 'Geometry', 'join', 'Geometry_001'),
        link('l4', 'join', 'Geometry', 'out', 'Geometry'),
      ],
    );
    const a = evaluateGeometryTree(t, square, nullCtx, 's').mesh;
    const b = evaluateGeometryTree(t, square, nullCtx, 's').mesh;
    expect(a.verts.size).toBe(4 + 8);
    expect(a.faces.size).toBe(1 + 6);
    expect([...a.verts.keys()]).toEqual([...b.verts.keys()]);
    const zs = [...a.verts.values()].map((p) => p[2]);
    expect(Math.max(...zs)).toBeCloseTo(6);
    expect(Math.min(...zs.filter((z) => z > 1))).toBeCloseTo(4);
  });

  it('instances sur des points, calculs, boucles et sorties absentes', () => {
    const t = tree(
      {
        line: node('line', 'GeometryNodeMeshLine', { Count: 3, Offset: [0, 0, 1] }),
        math: node('math', 'ShaderNodeMath', { Value: 2, Value_001: 3 }, { operation: 'MULTIPLY' }),
        cube: node('cube', 'GeometryNodeMeshCube'),
        inst: node('inst', 'GeometryNodeInstanceOnPoints'),
        out: node('out', 'GeometryNodeGroupOutput'),
      },
      [
        link('l1', 'line', 'Mesh', 'inst', 'Points'),
        link('l2', 'cube', 'Mesh', 'inst', 'Instance'),
        link('l3', 'math', 'Value', 'inst', 'Scale'),
        link('l4', 'inst', 'Instances', 'out', 'Geometry'),
      ],
    );
    const m = evaluateGeometryTree(t, square, nullCtx, 's').mesh;
    expect(m.verts.size).toBe(24);
    const xs = [...m.verts.values()].map((p) => p[0]);
    expect(Math.max(...xs)).toBeCloseTo(3); // cube de 1 × 6
    // boucle : pas d'exception, remarque
    const loop = tree(
      { a: node('a', 'GeometryNodeTransform'), b: node('b', 'GeometryNodeTransform'), out: node('out', 'GeometryNodeGroupOutput') },
      [link('l1', 'a', 'Geometry', 'b', 'Geometry'), link('l2', 'b', 'Geometry', 'a', 'Geometry'), link('l3', 'b', 'Geometry', 'out', 'Geometry')],
    );
    expect(() => evaluateGeometryTree(loop, square, nullCtx, 's')).not.toThrow();
    expect(evaluateGeometryTree(tree({}, []), square, nullCtx, 's').mesh).toBe(square);
  });

  it('modificateur « Nœuds » dans le moteur : réévalué quand l’arbre change', () => {
    const doc = SceneDoc.createNew();
    const obj = doc.listObjects().find((o) => o.type === 'mesh')!;
    const tid = doc.addNodeTree({ kind: 'geometry', name: 'GN', ...defaultGeometryTree() });
    doc.updateObject(obj.id, { modifiers: [{ id: 'gn', type: 'nodes', name: 'GN', enabled: true, params: { tree: tid } }] });
    const ev = new MeshEvaluator(() => doc);
    const base = doc.getMesh(obj.data!)!;
    expect(ev.evaluate(obj.id)!.verts.size).toBe(base.verts.size);
    const t = doc.getNodeTree(tid)!;
    doc.updateNodeTree(tid, {
      nodes: { ...t.nodes, sub: node('sub', 'GeometryNodeSubdivisionSurface', { Level: 1 }) },
      links: [link('a', 'gin', 'Geometry', 'sub', 'Mesh'), link('b', 'sub', 'Mesh', 'gout', 'Geometry')],
    });
    expect(ev.evaluate(obj.id)!.verts.size).toBeGreaterThan(base.verts.size);
  });
});

describe('marqueurs et compositeur', () => {
  it('marqueurs liés aux caméras : caméra par image et plans', () => {
    const doc = SceneDoc.createNew();
    const cam = doc.listObjects().find((o) => o.type === 'camera')!.id;
    const cam2 = doc.duplicateObject(cam)!;
    const m1 = doc.addMarker({ frame: 1, camera: cam });
    doc.addMarker({ frame: 50, camera: cam2 });
    doc.addMarker({ frame: 70, camera: null, name: 'note' });
    const ms = doc.listMarkers();
    expect(ms).toHaveLength(3);
    expect(cameraForFrame(ms, 10)).toBe(cam);
    expect(cameraForFrame(ms, 60)).toBe(cam2);
    const shots = cameraShots(ms, 1, 100);
    expect(shots.map((s) => [s.start, s.end])).toEqual([
      [1, 50],
      [50, 101],
    ]);
    doc.updateMarker(m1, { frame: 5.4 });
    expect(doc.listMarkers()[0].frame).toBe(5);
    doc.setActiveCameraByMarker(cam2);
    expect(doc.getScene().activeCamera).toBe(cam2);
    expect(doc.canUndo()).toBe(true); // les marqueurs eux-mêmes sont annulables
  });

  it('compositing : neutre sans effet, exposition +1 éclaircit, vignettage assombrit les bords', () => {
    const px = () => new Uint8ClampedArray([128, 128, 128, 255, 128, 128, 128, 255, 128, 128, 128, 255, 128, 128, 128, 255]);
    const a = px();
    compositePixels(a, 2, 2, { ...COMPOSITOR_DEFAULTS, use: true });
    expect(Math.abs(a[0] - 128)).toBeLessThanOrEqual(1);
    const b = px();
    compositePixels(b, 2, 2, { ...COMPOSITOR_DEFAULTS, use: true, exposure: 1 });
    expect(b[0]).toBeGreaterThan(160);
    const c = new Uint8ClampedArray(9 * 9 * 4).fill(200);
    compositePixels(c, 9, 9, { ...COMPOSITOR_DEFAULTS, useVignette: true, vignette: 1 });
    expect(c[0]).toBeLessThan(c[(4 * 9 + 4) * 4]);
    const doc = SceneDoc.createNew();
    doc.updateCompositor({ exposure: 2, use: true });
    expect(doc.getCompositor()).toMatchObject({ exposure: 2, use: true, gamma: 1 });
  });
});

describe('catalogue des éditeurs', () => {
  it('tous les éditeurs du menu sont disponibles et connus des zones', () => {
    for (const e of EDITOR_ENTRIES) expect(e.id, e.label).toBeTruthy();
    expect(new Set(EDITOR_ENTRIES.map((e) => e.id))).toEqual(new Set(EDITOR_TYPES));
  });

  it('espaces Script et Nœuds de géométrie : éditeurs dédiés, arbres valides', () => {
    const sizes = { rightW: 320, outlinerH: 200 };
    const script = defaultAreaTree('scripting', sizes);
    expect(leaves(script).map((l) => l.editor)).toEqual(expect.arrayContaining(['view3d', 'text', 'console', 'info']));
    const geo = defaultAreaTree('geometry', sizes);
    expect(leaves(geo).map((l) => l.editor)).toEqual(expect.arrayContaining(['spreadsheet', 'view3d', 'geometry_nodes']));
    expect(sanitizeAreaTree(JSON.parse(JSON.stringify(script)))).toEqual(script);
  });
});

describe('notes d’équipe', () => {
  it('ajout, résolution, objet supprimé, suppression', () => {
    const doc = SceneDoc.createNew();
    const cube = doc.listObjects().find((o) => o.type === 'mesh')!.id;
    const a = doc.addNote({ text: 'Biseau trop fort', author: 'A', color: '#ff0000', pos: [0, 0, 1], objectId: cube, time: 2, done: false });
    doc.addNote({ text: 'x'.repeat(5000), author: 'B', color: 'pas une couleur', pos: [1, 2, 3], objectId: null, time: 1, done: false });
    let notes = doc.listNotes();
    expect(notes.map((n) => n.author)).toEqual(['B', 'A']);
    expect(notes[0].text.length).toBe(2000);
    expect(notes[0].color).toBe('#888888');
    doc.updateNote(a, { done: true });
    expect(doc.listNotes().find((n) => n.id === a)!.done).toBe(true);
    doc.removeObject(cube);
    expect(doc.listNotes().find((n) => n.id === a)!.objectId).toBeNull();
    doc.removeNote(a);
    notes = doc.listNotes();
    expect(notes).toHaveLength(1);
  });
});
