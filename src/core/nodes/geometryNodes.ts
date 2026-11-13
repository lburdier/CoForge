import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { MeshData, NodeData, NodeTreeData, Vec3 } from '../doc/schema';
import { booleanModifier } from '../mesh/modifiers/boolean';
import { hashId } from '../mesh/modifiers/common';
import { subsurfModifier } from '../mesh/modifiers/subsurf';
import { createPrimitive } from '../mesh/primitives';
import { meshBounds, transformMesh } from '../mesh/topology';
import type { ModifierContext } from '../mesh/types';
import { en, f, fo, v, vo } from './shader/factories';
import { registerNodeTypes, type NodeTypeDef, type SocketDef } from './types';

/**
 * Nœuds de géométrie : catalogue (identifiants de Blender) et évaluateur.
 *
 * Portée : les valeurs circulent comme des constantes (pas de champs évalués par élément comme
 * dans Blender) ; une géométrie est un maillage `MeshData`. Les instances sont réalisées tout de
 * suite. L'évaluateur est PUR et DÉTERMINISTE : mêmes entrées → mêmes identifiants.
 */

const geo = (id: string, label: string, extra: Partial<SocketDef> = {}): SocketDef => ({ id, label, type: 'geometry', hideValue: true, ...extra });
const count = (id: string, label: string, def: number, min = 1, max = 512): SocketDef => f(id, label, def, { min, max, step: 1 });

const MATH_OPS: [string, string][] = [
  ['ADD', 'Ajouter'],
  ['SUBTRACT', 'Soustraire'],
  ['MULTIPLY', 'Multiplier'],
  ['DIVIDE', 'Diviser'],
  ['POWER', 'Puissance'],
  ['MINIMUM', 'Minimum'],
  ['MAXIMUM', 'Maximum'],
  ['MODULO', 'Modulo'],
  ['SINE', 'Sinus'],
  ['COSINE', 'Cosinus'],
  ['ABSOLUTE', 'Valeur absolue'],
];
const MATH_UNARY = new Set(['SINE', 'COSINE', 'ABSOLUTE']);
const VMATH_OPS: [string, string][] = [
  ['ADD', 'Ajouter'],
  ['SUBTRACT', 'Soustraire'],
  ['MULTIPLY', 'Multiplier'],
  ['SCALE', 'Échelle'],
  ['CROSS_PRODUCT', 'Produit vectoriel'],
  ['NORMALIZE', 'Normaliser'],
];

export const GEOMETRY_NODE_TYPES: NodeTypeDef[] = [
  // ------------------------------------------------------------ entrée / sortie
  {
    id: 'GeometryNodeGroupInput',
    label: 'Entrée du groupe',
    category: 'Entrée',
    description: 'Maillage de l’objet, avant ce modificateur',
    inputs: [],
    outputs: [geo('Geometry', 'Géométrie')],
  },
  {
    id: 'GeometryNodeObjectInfo',
    label: 'Infos d’objet',
    category: 'Entrée',
    description: 'Géométrie et position d’un autre objet maillage',
    inputs: [],
    outputs: [vo('Location', 'Position'), vo('Scale', 'Échelle'), geo('Geometry', 'Géométrie')],
    props: [
      { id: 'object', label: 'Objet', kind: 'object', default: null },
      en('transform_space', 'Espace', 'ORIGINAL', [
        ['ORIGINAL', 'Original'],
        ['RELATIVE', 'Relatif'],
      ]),
    ],
    width: 170,
  },
  {
    id: 'ShaderNodeValue',
    label: 'Valeur',
    category: 'Entrée',
    inputs: [],
    outputs: [fo('Value', 'Valeur')],
    props: [{ id: 'value', label: 'Valeur', kind: 'float', default: 0.5 }],
    width: 140,
  },
  {
    id: 'FunctionNodeInputInt',
    label: 'Entier',
    category: 'Entrée',
    inputs: [],
    outputs: [fo('Integer', 'Entier')],
    props: [{ id: 'integer', label: 'Entier', kind: 'int', default: 1 }],
    width: 140,
  },
  {
    id: 'GeometryNodeGroupOutput',
    label: 'Sortie du groupe',
    category: 'Sortie',
    description: 'Résultat du modificateur',
    inputs: [geo('Geometry', 'Géométrie')],
    outputs: [],
  },

  // ------------------------------------------------------------ primitives
  {
    id: 'GeometryNodeMeshCube',
    label: 'Cube',
    category: 'Primitive de maillage',
    inputs: [v('Size', 'Taille', [1, 1, 1])],
    outputs: [geo('Mesh', 'Maillage')],
  },
  {
    id: 'GeometryNodeMeshGrid',
    label: 'Grille',
    category: 'Primitive de maillage',
    inputs: [f('Size X', 'Taille X', 1, { min: 0 }), f('Size Y', 'Taille Y', 1, { min: 0 }), count('Vertices X', 'Sommets X', 3, 2, 1000), count('Vertices Y', 'Sommets Y', 3, 2, 1000)],
    outputs: [geo('Mesh', 'Maillage')],
  },
  {
    id: 'GeometryNodeMeshUVSphere',
    label: 'Sphère UV',
    category: 'Primitive de maillage',
    inputs: [count('Segments', 'Segments', 32, 3, 256), count('Rings', 'Anneaux', 16, 2, 128), f('Radius', 'Rayon', 1, { min: 0 })],
    outputs: [geo('Mesh', 'Maillage')],
  },
  {
    id: 'GeometryNodeMeshIcoSphere',
    label: 'Icosphère',
    category: 'Primitive de maillage',
    inputs: [f('Radius', 'Rayon', 1, { min: 0 }), count('Subdivisions', 'Subdivisions', 1, 1, 6)],
    outputs: [geo('Mesh', 'Maillage')],
  },
  {
    id: 'GeometryNodeMeshCylinder',
    label: 'Cylindre',
    category: 'Primitive de maillage',
    inputs: [count('Vertices', 'Sommets', 32, 3, 512), f('Radius', 'Rayon', 1, { min: 0 }), f('Depth', 'Profondeur', 2, { min: 0 })],
    outputs: [geo('Mesh', 'Maillage')],
  },
  {
    id: 'GeometryNodeMeshCone',
    label: 'Cône',
    category: 'Primitive de maillage',
    inputs: [count('Vertices', 'Sommets', 32, 3, 512), f('Radius Top', 'Rayon du haut', 0, { min: 0 }), f('Radius Bottom', 'Rayon du bas', 1, { min: 0 }), f('Depth', 'Profondeur', 2, { min: 0 })],
    outputs: [geo('Mesh', 'Maillage')],
  },
  {
    id: 'GeometryNodeMeshCircle',
    label: 'Cercle',
    category: 'Primitive de maillage',
    inputs: [count('Vertices', 'Sommets', 32, 3, 512), f('Radius', 'Rayon', 1, { min: 0 })],
    outputs: [geo('Mesh', 'Maillage')],
  },
  {
    id: 'GeometryNodeMeshLine',
    label: 'Ligne de points',
    category: 'Primitive de maillage',
    description: 'Points alignés (à utiliser avec « Instancier sur les points »)',
    inputs: [count('Count', 'Nombre', 10, 1, 10000), v('Offset', 'Décalage', [0, 0, 1])],
    outputs: [geo('Mesh', 'Maillage')],
  },

  // ------------------------------------------------------------ géométrie
  {
    id: 'GeometryNodeTransform',
    label: 'Transformer la géométrie',
    category: 'Géométrie',
    inputs: [geo('Geometry', 'Géométrie'), v('Translation', 'Translation'), v('Rotation', 'Rotation', [0, 0, 0], { subtype: 'angle' }), v('Scale', 'Échelle', [1, 1, 1])],
    outputs: [geo('Geometry', 'Géométrie')],
    width: 170,
  },
  {
    id: 'GeometryNodeJoinGeometry',
    label: 'Joindre la géométrie',
    category: 'Géométrie',
    inputs: [geo('Geometry', 'Géométrie'), geo('Geometry_001', 'Géométrie'), geo('Geometry_002', 'Géométrie'), geo('Geometry_003', 'Géométrie')],
    outputs: [geo('Geometry', 'Géométrie')],
  },
  {
    id: 'GeometryNodeSetPosition',
    label: 'Définir la position',
    category: 'Géométrie',
    description: 'Décale tous les points (valeur constante)',
    inputs: [geo('Geometry', 'Géométrie'), v('Offset', 'Décalage')],
    outputs: [geo('Geometry', 'Géométrie')],
  },
  {
    id: 'GeometryNodeBoundBox',
    label: 'Boîte englobante',
    category: 'Géométrie',
    inputs: [geo('Geometry', 'Géométrie')],
    outputs: [geo('Bounding Box', 'Boîte englobante'), vo('Min', 'Min'), vo('Max', 'Max')],
  },

  // ------------------------------------------------------------ maillage
  {
    id: 'GeometryNodeSubdivisionSurface',
    label: 'Surface de subdivision',
    category: 'Maillage',
    inputs: [geo('Mesh', 'Maillage'), count('Level', 'Niveau', 1, 0, 4)],
    outputs: [geo('Mesh', 'Maillage')],
  },
  {
    id: 'GeometryNodeMeshBoolean',
    label: 'Booléen de maillage',
    category: 'Maillage',
    inputs: [geo('Mesh 1', 'Maillage 1'), geo('Mesh 2', 'Maillage 2')],
    outputs: [geo('Mesh', 'Maillage')],
    props: [
      en('operation', 'Opération', 'DIFFERENCE', [
        ['INTERSECT', 'Intersection'],
        ['UNION', 'Union'],
        ['DIFFERENCE', 'Différence'],
      ]),
    ],
  },
  {
    id: 'GeometryNodeFlipFaces',
    label: 'Retourner les faces',
    category: 'Maillage',
    inputs: [geo('Mesh', 'Maillage')],
    outputs: [geo('Mesh', 'Maillage')],
  },

  // ------------------------------------------------------------ instances
  {
    id: 'GeometryNodeInstanceOnPoints',
    label: 'Instancier sur les points',
    category: 'Instances',
    description: 'Copie une géométrie sur chaque point (instances réalisées)',
    inputs: [geo('Points', 'Points'), geo('Instance', 'Instance'), v('Rotation', 'Rotation', [0, 0, 0], { subtype: 'angle' }), v('Scale', 'Échelle', [1, 1, 1])],
    outputs: [geo('Instances', 'Instances')],
    width: 170,
  },

  // ------------------------------------------------------------ utilitaires
  {
    id: 'ShaderNodeMath',
    label: 'Calcul',
    category: 'Convertisseur',
    inputs: [f('Value', 'Valeur', 0.5), f('Value_001', 'Valeur', 0.5, { visible: (p) => !MATH_UNARY.has(String(p.operation)) })],
    outputs: [fo('Value', 'Valeur')],
    props: [en('operation', 'Opération', 'ADD', MATH_OPS)],
    width: 150,
  },
  {
    id: 'ShaderNodeVectorMath',
    label: 'Calcul vectoriel',
    category: 'Convertisseur',
    inputs: [v('Vector', 'Vecteur'), v('Vector_001', 'Vecteur', [0, 0, 0], { visible: (p) => !['SCALE', 'NORMALIZE'].includes(String(p.operation)) }), f('Scale', 'Échelle', 1, { visible: (p) => p.operation === 'SCALE' })],
    outputs: [vo('Vector', 'Vecteur')],
    props: [en('operation', 'Opération', 'ADD', VMATH_OPS)],
    width: 160,
  },
  {
    id: 'ShaderNodeCombineXYZ',
    label: 'Combiner XYZ',
    category: 'Convertisseur',
    inputs: [f('X', 'X', 0), f('Y', 'Y', 0), f('Z', 'Z', 0)],
    outputs: [vo('Vector', 'Vecteur')],
  },
  {
    id: 'ShaderNodeSeparateXYZ',
    label: 'Séparer XYZ',
    category: 'Convertisseur',
    inputs: [v('Vector', 'Vecteur')],
    outputs: [fo('X', 'X'), fo('Y', 'Y'), fo('Z', 'Z')],
  },

  // ------------------------------------------------------------ disposition
  {
    id: 'NodeFrame',
    label: 'Cadre',
    category: 'Disposition',
    description: 'Regroupe visuellement des nœuds (Ctrl+J)',
    inputs: [],
    outputs: [],
    props: [{ id: 'shrink', label: 'Ajuster', kind: 'bool', default: true }, { id: 'label_size', label: 'Taille du titre', kind: 'int', default: 20, min: 8, max: 64 }],
    layout: 'frame',
  },
  {
    id: 'NodeReroute',
    label: 'Redirection',
    category: 'Disposition',
    description: 'Point de passage pour organiser les liens',
    inputs: [{ id: 'Input', label: '', type: 'any', hideValue: true }],
    outputs: [{ id: 'Output', label: '', type: 'any' }],
    layout: 'reroute',
  },
];

registerNodeTypes('geometry', GEOMETRY_NODE_TYPES);

const DEFS = new Map(GEOMETRY_NODE_TYPES.map((d) => [d.id, d]));

// ------------------------------------------------------------------ arbre par défaut

/** Arbre neuf : Entrée du groupe → Sortie du groupe (comme « Nouveau » dans Blender). */
export function defaultGeometryTree(): Pick<NodeTreeData, 'nodes' | 'links'> {
  return {
    nodes: {
      gin: { id: 'gin', type: 'GeometryNodeGroupInput', x: -260, y: 0, inputs: {}, props: {} },
      gout: { id: 'gout', type: 'GeometryNodeGroupOutput', x: 120, y: 0, inputs: {}, props: {} },
    },
    links: [{ id: 'l0', fromNode: 'gin', fromSocket: 'Geometry', toNode: 'gout', toSocket: 'Geometry' }],
  };
}

// ------------------------------------------------------------------ évaluation

/** Limite de sécurité : au-delà, l'évaluation échoue (le modificateur est ignoré). */
export const GEOMETRY_MAX_VERTS = 1_000_000;

type Value = number | Vec3 | MeshData | null;

const EMPTY_MESH: MeshData = { verts: new Map(), faces: new Map() };

function isMesh(x: unknown): x is MeshData {
  return !!x && typeof x === 'object' && (x as MeshData).verts instanceof Map;
}
function toNum(x: Value | undefined, fb = 0): number {
  if (typeof x === 'number') return Number.isFinite(x) ? x : fb;
  if (Array.isArray(x)) return (x[0] + x[1] + x[2]) / 3;
  return fb;
}
function toVec(x: Value | undefined, fb: Vec3 = [0, 0, 0]): Vec3 {
  if (Array.isArray(x)) return [toNum(x[0]), toNum(x[1]), toNum(x[2])];
  if (typeof x === 'number' && Number.isFinite(x)) return [x, x, x];
  return fb;
}
function toMesh(x: Value | undefined): MeshData {
  return isMesh(x) ? x : EMPTY_MESH;
}

/** Copie d'un maillage aux identifiants préfixés (unicité après une jonction). */
function prefixed(mesh: MeshData, prefix: string): MeshData {
  const verts = new Map<string, Vec3>();
  const faces = new Map<string, string[]>();
  for (const [id, p] of mesh.verts) verts.set(prefix + id, p);
  for (const [id, loop] of mesh.faces) faces.set(prefix + id, loop.map((x) => prefix + x));
  return { verts, faces };
}

/** Renumérote un maillage (identifiants aléatoires des primitives → identifiants déterministes). */
function renumbered(mesh: MeshData, tag: string): MeshData {
  const map = new Map<string, string>();
  const verts = new Map<string, Vec3>();
  const faces = new Map<string, string[]>();
  let i = 0;
  for (const [id, p] of mesh.verts) {
    const nid = `${tag}v${i++}`;
    map.set(id, nid);
    verts.set(nid, p);
  }
  i = 0;
  for (const loop of mesh.faces.values()) faces.set(`${tag}f${i++}`, loop.map((x) => map.get(x) ?? x));
  return { verts, faces };
}

function joinMeshes(list: MeshData[]): MeshData {
  const parts = list.filter((m) => m.verts.size > 0);
  if (parts.length === 0) return EMPTY_MESH;
  if (parts.length === 1) return parts[0];
  const verts = new Map<string, Vec3>();
  const faces = new Map<string, string[]>();
  parts.forEach((m, k) => {
    const p = prefixed(m, `${k}~`);
    for (const [id, pos] of p.verts) verts.set(id, pos);
    for (const [id, loop] of p.faces) faces.set(id, loop);
  });
  checkSize(verts.size);
  return { verts, faces };
}

function checkSize(n: number): void {
  if (n > GEOMETRY_MAX_VERTS) throw new Error(`Nœuds de géométrie : plus de ${GEOMETRY_MAX_VERTS} sommets`);
}

function trs(t: Vec3, r: Vec3, s: Vec3): Matrix4 {
  return new Matrix4().compose(new Vector3(...t), new Quaternion().setFromEuler(new Euler(r[0], r[1], r[2], 'XYZ')), new Vector3(...s));
}

function scaledPrimitive(mesh: MeshData, s: Vec3): MeshData {
  return s[0] === 1 && s[1] === 1 && s[2] === 1 ? mesh : transformMesh(mesh, new Matrix4().makeScale(s[0], s[1], s[2]));
}

function grid(sx: number, sy: number, nx: number, ny: number, tag: string): MeshData {
  const verts = new Map<string, Vec3>();
  const faces = new Map<string, string[]>();
  const id = (i: number, j: number) => `${tag}v${i}_${j}`;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) verts.set(id(i, j), [(i / (nx - 1) - 0.5) * sx, (j / (ny - 1) - 0.5) * sy, 0]);
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) faces.set(`${tag}f${i}_${j}`, [id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)]);
  return { verts, faces };
}

export interface GeometryEvalResult {
  mesh: MeshData;
  /** Problèmes rencontrés (cycle, objet introuvable…), en français. */
  notes: string[];
}

/**
 * Évalue un arbre de nœuds de géométrie sur le maillage `input`. Sans nœud « Sortie du groupe »,
 * le maillage d'entrée est renvoyé tel quel. Peut lever une exception si le résultat dépasse
 * GEOMETRY_MAX_VERTS (le modificateur est alors ignoré par l'appelant).
 */
export function evaluateGeometryTree(tree: Pick<NodeTreeData, 'nodes' | 'links'>, input: MeshData, ctx: ModifierContext, salt: string): GeometryEvalResult {
  const nodes = tree?.nodes && typeof tree.nodes === 'object' ? tree.nodes : {};
  const links = Array.isArray(tree?.links) ? tree.links.filter((l) => l && nodes[l.fromNode] && nodes[l.toNode]) : [];
  const notes = new Set<string>();
  const memo = new Map<string, Value>();
  const visiting = new Set<string>();
  const ops = { evaluated: 0 };

  const linkInto = (nodeId: string, socket: string) => links.find((l) => l.toNode === nodeId && l.toSocket === socket);

  const input_ = (node: NodeData, s: SocketDef): Value => {
    const l = linkInto(node.id, s.id);
    if (l) return output(l.fromNode, l.fromSocket);
    if (s.type === 'geometry') return null;
    const raw = node.inputs?.[s.id] ?? s.default;
    if (s.type === 'vector') return toVec(raw as Value, (s.default as Vec3) ?? [0, 0, 0]);
    return toNum(raw as Value, Number(s.default) || 0);
  };

  const output = (nodeId: string, socket: string): Value => {
    const key = `${nodeId}\u0000${socket}`;
    if (memo.has(key)) return memo.get(key)!;
    if (visiting.has(nodeId)) {
      notes.add('Boucle dans l’arbre de nœuds : lien ignoré.');
      return null;
    }
    const node = nodes[nodeId];
    if (!node) return null;
    if (++ops.evaluated > 20000) throw new Error('Nœuds de géométrie : arbre trop grand');
    visiting.add(nodeId);
    let out: Value = null;
    try {
      out = compute(node, socket);
    } finally {
      visiting.delete(nodeId);
    }
    memo.set(key, out);
    return out;
  };

  const compute = (node: NodeData, socket: string): Value => {
    const def = DEFS.get(node.type);
    if (!def) {
      notes.add(`Nœud inconnu ignoré : ${node.type}`);
      return null;
    }
    const inp = (id: string): Value => {
      const s = def.inputs.find((x) => x.id === id);
      return s ? input_(node, s) : null;
    };
    const tag = hashId(salt, node.id).slice(0, 6);
    if (node.muted) {
      // Nœud muet : la première entrée du même genre traverse.
      const outDef = def.outputs.find((o) => o.id === socket);
      const same = def.inputs.find((s) => s.type === outDef?.type || (outDef?.type !== 'geometry' && s.type !== 'geometry'));
      return same ? input_(node, same) : null;
    }
    const P = node.props ?? {};
    switch (node.type) {
      case 'NodeReroute':
        return inp('Input');
      case 'GeometryNodeGroupInput':
        return input;
      case 'GeometryNodeObjectInfo': {
        const target = typeof P.object === 'string' ? P.object : null;
        if (!target) return socket === 'Geometry' ? null : [0, 0, 0];
        const op = ctx.getOperand(target);
        if (!op) {
          notes.add('Infos d’objet : objet introuvable ou non maillage.');
          return socket === 'Geometry' ? null : [0, 0, 0];
        }
        const pos = new Vector3();
        const quat = new Quaternion();
        const scl = new Vector3();
        op.toLocal.decompose(pos, quat, scl);
        if (socket === 'Location') return [pos.x, pos.y, pos.z];
        if (socket === 'Scale') return [scl.x, scl.y, scl.z];
        return P.transform_space === 'RELATIVE' ? transformMesh(op.mesh, op.toLocal) : op.mesh;
      }
      case 'ShaderNodeValue':
        return toNum(P.value as Value, 0.5);
      case 'FunctionNodeInputInt':
        return Math.round(toNum(P.integer as Value, 1));
      case 'GeometryNodeMeshCube':
        return renumbered(scaledPrimitive(createPrimitive('cube', { size: 1 }), toVec(inp('Size'), [1, 1, 1])), tag);
      case 'GeometryNodeMeshGrid': {
        const nx = Math.max(2, Math.min(1000, Math.round(toNum(inp('Vertices X'), 3))));
        const ny = Math.max(2, Math.min(1000, Math.round(toNum(inp('Vertices Y'), 3))));
        checkSize(nx * ny);
        return grid(toNum(inp('Size X'), 1), toNum(inp('Size Y'), 1), nx, ny, tag);
      }
      case 'GeometryNodeMeshUVSphere':
        return renumbered(createPrimitive('uvsphere', { segments: toNum(inp('Segments'), 32), rings: toNum(inp('Rings'), 16), radius: Math.max(0.001, toNum(inp('Radius'), 1)) }), tag);
      case 'GeometryNodeMeshIcoSphere':
        return renumbered(createPrimitive('icosphere', { radius: Math.max(0.001, toNum(inp('Radius'), 1)), subdivisions: toNum(inp('Subdivisions'), 1) }), tag);
      case 'GeometryNodeMeshCylinder':
        return renumbered(createPrimitive('cylinder', { vertices: toNum(inp('Vertices'), 32), radius: Math.max(0.001, toNum(inp('Radius'), 1)), depth: Math.max(0.001, toNum(inp('Depth'), 2)) }), tag);
      case 'GeometryNodeMeshCone':
        return renumbered(
          createPrimitive('cone', {
            vertices: toNum(inp('Vertices'), 32),
            radius1: toNum(inp('Radius Bottom'), 1),
            radius2: toNum(inp('Radius Top'), 0),
            depth: Math.max(0.001, toNum(inp('Depth'), 2)),
          }),
          tag,
        );
      case 'GeometryNodeMeshCircle':
        return renumbered(createPrimitive('circle', { vertices: toNum(inp('Vertices'), 32), radius: Math.max(0.001, toNum(inp('Radius'), 1)) }), tag);
      case 'GeometryNodeMeshLine': {
        const n = Math.max(1, Math.min(10000, Math.round(toNum(inp('Count'), 10))));
        const off = toVec(inp('Offset'), [0, 0, 1]);
        const verts = new Map<string, Vec3>();
        for (let i = 0; i < n; i++) verts.set(`${tag}v${i}`, [off[0] * i, off[1] * i, off[2] * i]);
        return { verts, faces: new Map() };
      }
      case 'GeometryNodeTransform': {
        const g = toMesh(inp('Geometry'));
        if (g.verts.size === 0) return g;
        return transformMesh(g, trs(toVec(inp('Translation')), toVec(inp('Rotation')), toVec(inp('Scale'), [1, 1, 1])));
      }
      case 'GeometryNodeJoinGeometry':
        return joinMeshes(['Geometry', 'Geometry_001', 'Geometry_002', 'Geometry_003'].map((id) => toMesh(inp(id))));
      case 'GeometryNodeSetPosition': {
        const g = toMesh(inp('Geometry'));
        const o = toVec(inp('Offset'));
        if (g.verts.size === 0 || (o[0] === 0 && o[1] === 0 && o[2] === 0)) return g;
        return transformMesh(g, new Matrix4().makeTranslation(o[0], o[1], o[2]));
      }
      case 'GeometryNodeBoundBox': {
        const g = toMesh(inp('Geometry'));
        const b = meshBounds(g);
        if (socket === 'Min') return b ? b.min : [0, 0, 0];
        if (socket === 'Max') return b ? b.max : [0, 0, 0];
        if (!b) return EMPTY_MESH;
        const size: Vec3 = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
        const cube = renumbered(scaledPrimitive(createPrimitive('cube', { size: 1 }), size.map((x) => Math.max(x, 1e-6)) as Vec3), tag);
        return transformMesh(cube, new Matrix4().makeTranslation((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2));
      }
      case 'GeometryNodeSubdivisionSurface': {
        const g = toMesh(inp('Mesh'));
        const level = Math.max(0, Math.min(4, Math.round(toNum(inp('Level'), 1))));
        if (level === 0 || g.faces.size === 0) return g;
        checkSize(g.verts.size * Math.pow(4, level));
        return subsurfModifier(g, { levels: level }, `${salt}/${node.id}`);
      }
      case 'GeometryNodeMeshBoolean': {
        const a = toMesh(inp('Mesh 1'));
        const b = toMesh(inp('Mesh 2'));
        const op = P.operation === 'UNION' ? 'union' : P.operation === 'INTERSECT' ? 'intersect' : 'difference';
        if (b.faces.size === 0) return op === 'intersect' ? EMPTY_MESH : a;
        if (a.faces.size === 0) return op === 'union' ? b : EMPTY_MESH;
        const bctx: ModifierContext = { getOperand: () => ({ mesh: b, toLocal: new Matrix4() }) };
        return booleanModifier(a, { operation: op, target: '__b' }, bctx, `${salt}/${node.id}`);
      }
      case 'GeometryNodeFlipFaces': {
        const g = toMesh(inp('Mesh'));
        const faces = new Map<string, string[]>();
        for (const [id, loop] of g.faces) faces.set(id, [loop[0], ...loop.slice(1).reverse()]);
        return { verts: g.verts, faces };
      }
      case 'GeometryNodeInstanceOnPoints': {
        const pts = toMesh(inp('Points'));
        const inst = toMesh(inp('Instance'));
        if (pts.verts.size === 0 || inst.verts.size === 0) return EMPTY_MESH;
        checkSize(pts.verts.size * inst.verts.size);
        const rs = trs([0, 0, 0], toVec(inp('Rotation')), toVec(inp('Scale'), [1, 1, 1]));
        const base = transformMesh(inst, rs);
        const verts = new Map<string, Vec3>();
        const faces = new Map<string, string[]>();
        let k = 0;
        for (const p of pts.verts.values()) {
          const pre = `${k++}~`;
          for (const [id, q] of base.verts) verts.set(pre + id, [q[0] + p[0], q[1] + p[1], q[2] + p[2]]);
          for (const [id, loop] of base.faces) faces.set(pre + id, loop.map((x) => pre + x));
        }
        return { verts, faces };
      }
      case 'ShaderNodeMath': {
        const a = toNum(inp('Value'));
        const b = toNum(inp('Value_001'));
        switch (P.operation) {
          case 'SUBTRACT':
            return a - b;
          case 'MULTIPLY':
            return a * b;
          case 'DIVIDE':
            return b === 0 ? 0 : a / b;
          case 'POWER':
            return Math.pow(a, b);
          case 'MINIMUM':
            return Math.min(a, b);
          case 'MAXIMUM':
            return Math.max(a, b);
          case 'MODULO':
            return b === 0 ? 0 : a % b;
          case 'SINE':
            return Math.sin(a);
          case 'COSINE':
            return Math.cos(a);
          case 'ABSOLUTE':
            return Math.abs(a);
          default:
            return a + b;
        }
      }
      case 'ShaderNodeVectorMath': {
        const a = toVec(inp('Vector'));
        const b = toVec(inp('Vector_001'));
        switch (P.operation) {
          case 'SUBTRACT':
            return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
          case 'MULTIPLY':
            return [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
          case 'SCALE': {
            const s = toNum(inp('Scale'), 1);
            return [a[0] * s, a[1] * s, a[2] * s];
          }
          case 'CROSS_PRODUCT':
            return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
          case 'NORMALIZE': {
            const l = Math.hypot(a[0], a[1], a[2]) || 1;
            return [a[0] / l, a[1] / l, a[2] / l];
          }
          default:
            return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
        }
      }
      case 'ShaderNodeCombineXYZ':
        return [toNum(inp('X')), toNum(inp('Y')), toNum(inp('Z'))];
      case 'ShaderNodeSeparateXYZ': {
        const a = toVec(inp('Vector'));
        return socket === 'Y' ? a[1] : socket === 'Z' ? a[2] : a[0];
      }
      default:
        return null;
    }
  };

  const outNode = Object.values(nodes).find((n) => n && n.type === 'GeometryNodeGroupOutput' && !n.muted);
  if (!outNode) {
    notes.add('Aucun nœud « Sortie du groupe » : le maillage passe sans changement.');
    return { mesh: input, notes: [...notes] };
  }
  const l = linkInto(outNode.id, 'Geometry');
  const mesh = l ? toMesh(output(l.fromNode, l.fromSocket)) : EMPTY_MESH;
  return { mesh, notes: [...notes] };
}
