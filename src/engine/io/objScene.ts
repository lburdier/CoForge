import { Matrix4 } from 'three';
import { MATERIAL_DEFAULTS, type MaterialData } from '../../core/doc/schema';
import { baseName } from './convert';
import type { ImportedMesh, ImportedObject, ImportedScene } from './scene';

/**
 * Lecteur Wavefront OBJ vers le format neutre `ImportedScene`.
 *
 *  - `o` ouvre un objet, `g` un groupe à l'intérieur de l'objet courant. Un objet à un seul groupe
 *    devient un objet maillage ; un objet déclaré par `o` qui contient plusieurs groupes devient un
 *    vide portant un maillage par groupe ; sans `o`, chaque groupe est un objet de premier niveau.
 *  - `usemtl` → emplacements de matériaux (`polygonSlots`). Le fichier .mtl n'est pas accessible
 *    à l'import : chaque matériau est créé par son nom, avec les réglages par défaut.
 *  - Polygones conservés (n-gones compris), indices négatifs (relatifs au dernier sommet lu),
 *    formats v, v/vt, v/vt/vn, v//vn, lignes prolongées par « \ », lissage `s`.
 *  - Les sommets d'un OBJ sont en coordonnées monde, Y vers le haut : convertis en Z vers le haut
 *    (x, y, z) → (x, −z, y), objets à l'identité.
 *  - Non repris : lignes (`l`), points (`p`), courbes et surfaces libres, coordonnées de texture,
 *    normales et couleurs de sommets.
 */

interface Part {
  /** Numéro d'ordre de l'objet `o` (0 avant le premier). */
  object: number;
  group: string | null;
  faces: number[][];
  slots: number[];
  /** Matériau de chaque emplacement, dans l'ordre de première utilisation (null : aucun). */
  materials: (string | null)[];
  smooth: boolean;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n > 1 ? many : one}`;
}

export async function readOBJScene(data: ArrayBuffer | string, name = ''): Promise<ImportedScene> {
  const text = typeof data === 'string' ? data : new TextDecoder().decode(new Uint8Array(data));
  const fileName = baseName(name, 'Objet');
  const warnings: string[] = [];

  const positions: number[] = [];
  const parts = new Map<string, Part>();
  const objectNames: (string | null)[] = [null];
  let objectSeq = 0;
  let group: string | null = null;
  let material: string | null = null;
  let smooth = false;
  let current: Part | null = null;
  let currentSlot = -1;
  let invalidFaces = 0;
  let linesAndPoints = 0;
  let freeForm = false;
  const libraries: string[] = [];

  const partFor = (): Part => {
    if (!current) {
      const key = `${objectSeq}\u0000${group ?? ''}`;
      let p = parts.get(key);
      if (!p) parts.set(key, (p = { object: objectSeq, group, faces: [], slots: [], materials: [], smooth: false }));
      current = p;
      currentSlot = -1;
    }
    return current;
  };

  const handle = (line: string): void => {
    const hash = line.indexOf('#');
    const clean = (hash >= 0 ? line.slice(0, hash) : line).trim();
    if (!clean) return;
    const space = clean.search(/\s/);
    const tag = space < 0 ? clean : clean.slice(0, space);
    const rest = space < 0 ? '' : clean.slice(space + 1).trim();
    switch (tag) {
      case 'v': {
        const t = rest.split(/\s+/);
        // Une coordonnée illisible reste non finie : les faces qui l'utilisent sont écartées.
        positions.push(parseFloat(t[0]), parseFloat(t[1]), parseFloat(t[2]));
        break;
      }
      case 'f': {
        const nv = positions.length / 3;
        const t = rest.split(/\s+/);
        const poly: number[] = [];
        let ok = true;
        for (const token of t) {
          if (!token) continue;
          const k = parseInt(token, 10); // s'arrête au premier « / »
          const i = k > 0 ? k - 1 : k < 0 ? nv + k : -1;
          if (!Number.isFinite(k) || i < 0 || i >= nv) {
            ok = false;
            break;
          }
          poly.push(i);
        }
        if (!ok || poly.length < 3) {
          invalidFaces++;
          break;
        }
        const part = partFor();
        if (currentSlot < 0) {
          currentSlot = part.materials.indexOf(material);
          if (currentSlot < 0) {
            currentSlot = part.materials.length;
            part.materials.push(material);
          }
        }
        if (smooth) part.smooth = true;
        part.faces.push(poly);
        part.slots.push(currentSlot);
        break;
      }
      case 'o':
        objectSeq++;
        objectNames[objectSeq] = rest || null;
        group = null;
        current = null;
        break;
      case 'g':
        group = rest || null;
        current = null;
        break;
      case 'usemtl':
        material = rest || null;
        currentSlot = -1;
        break;
      case 's': {
        const v = rest.toLowerCase();
        smooth = !(v === '' || v === 'off' || v === '0');
        break;
      }
      case 'mtllib':
        if (rest) libraries.push(rest);
        break;
      case 'l':
      case 'p':
        linesAndPoints++;
        break;
      case 'curv':
      case 'curv2':
      case 'surf':
      case 'cstype':
        freeForm = true;
        break;
      default:
        break;
    }
  };

  // Lecture ligne à ligne sans découper tout le texte d'un coup ; « \ » en fin de ligne prolonge.
  let start = 0;
  let pending = '';
  const length = text.length;
  while (start <= length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = length;
    let line = text.slice(start, end);
    start = end + 1;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.endsWith('\\')) {
      pending += `${line.slice(0, -1)} `;
      continue;
    }
    handle(pending + line);
    pending = '';
  }
  if (pending) handle(pending);

  // ---------------------------------------------------------------- scène

  const identity = (): Matrix4 => new Matrix4();
  const objects: ImportedObject[] = [];
  const meshes: ImportedMesh[] = [];
  const materials: Omit<MaterialData, 'id'>[] = [];
  const materialByName = new Map<string, number>();
  const materialIndex = (n: string | null): number | null => {
    if (n === null) return null;
    let i = materialByName.get(n);
    if (i === undefined) {
      i = materials.length;
      materials.push({ name: n, ...MATERIAL_DEFAULTS });
      materialByName.set(n, i);
    }
    return i;
  };

  const byObject = new Map<number, Part[]>();
  for (const p of parts.values()) {
    if (p.faces.length === 0) continue;
    let list = byObject.get(p.object);
    if (!list) byObject.set(p.object, (list = []));
    list.push(p);
  }

  const addMesh = (part: Part, label: string, parent: number | null): void => {
    // Sommets propres à la partie (le tableau de sommets d'un OBJ est commun à tout le fichier).
    const remap = new Map<number, number>();
    const local: number[] = [];
    const polygons = part.faces.map((face) =>
      face.map((gi) => {
        let li = remap.get(gi);
        if (li === undefined) {
          li = remap.size;
          remap.set(gi, li);
          // Y vers le haut → Z vers le haut.
          local.push(positions[gi * 3], -positions[gi * 3 + 2], positions[gi * 3 + 1]);
        }
        return li;
      }),
    );
    meshes.push({
      name: label,
      positions: Float64Array.from(local),
      polygons,
      polygonSlots: part.materials.length > 1 ? part.slots : undefined,
      weld: true,
    });
    objects.push({
      name: label,
      type: 'mesh',
      parent,
      matrixWorld: identity(),
      collection: null,
      mesh: meshes.length - 1,
      materials: part.materials.map(materialIndex),
      shadeSmooth: part.smooth,
    });
  };

  for (const [seq, list] of [...byObject.entries()].sort((a, b) => a[0] - b[0])) {
    const objectName = objectNames[seq] ?? null;
    if (list.length === 1) {
      addMesh(list[0], objectName ?? list[0].group ?? fileName, null);
    } else if (objectName !== null) {
      objects.push({ name: objectName, type: 'empty', parent: null, matrixWorld: identity(), collection: null });
      const parent = objects.length - 1;
      for (const p of list) addMesh(p, p.group ?? objectName, parent);
    } else {
      for (const p of list) addMesh(p, p.group ?? fileName, null);
    }
  }

  if (objects.length === 0 && positions.length > 0) warnings.push('Le fichier OBJ contient des sommets mais aucune face.');
  if (libraries.length > 0 && materials.length > 0) {
    warnings.push(
      `Bibliothèque de matériaux (${libraries.join(', ')}) non lue : ` +
        `${plural(materials.length, 'matériau créé par son nom', 'matériaux créés par leur nom')} avec les réglages par défaut.`,
    );
  }
  if (invalidFaces > 0) warnings.push(`${plural(invalidFaces, 'face invalide ignorée', 'faces invalides ignorées')} (indice hors limites ou moins de 3 sommets).`);
  if (linesAndPoints > 0) warnings.push(`${plural(linesAndPoints, 'ligne ou point ignoré', 'lignes ou points ignorés')} (seules les faces sont reprises).`);
  if (freeForm) warnings.push('Courbes et surfaces libres ignorées.');

  return { name: fileName, objects, meshes, materials, collections: [], warnings };
}
