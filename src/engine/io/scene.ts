import { Matrix4 } from 'three';
import type { SceneDoc } from '../../core/doc/SceneDoc';
import {
  MODIFIER_DEFAULTS,
  MODIFIER_LABELS,
  ROOT_COLLECTION,
  type CameraData,
  type LightData,
  type MaterialData,
  type MeshData,
  type ModifierData,
  type ModifierParamsMap,
  type ModifierType,
  type ObjectType,
  type RenderSettings,
  type Vec3,
  type WorldSettings,
} from '../../core/doc/schema';
import { newId } from '../../core/ids';
import { decompose } from '../../core/doc/transforms';
import { buildMeshData } from './convert';

/**
 * Scène importée, dans un format neutre commun à tous les lecteurs (.blend, glTF, FBX, OBJ).
 *
 * Chaque lecteur produit une `ImportedScene` ; `applyImportedScene` l'écrit ensuite dans le
 * document en UNE transaction. Conventions : repère Z vers le haut, mètres, matrices monde,
 * couleurs '#rrggbb', celles du document. Les références entre éléments sont des INDICES
 * dans les tableaux de la scène importée (jamais des identifiants du document).
 */
export interface ImportedScene {
  /** Nom de la scène d'origine (utilisé seulement en mode « ouvrir »). */
  name?: string;
  objects: ImportedObject[];
  meshes: ImportedMesh[];
  materials: Omit<MaterialData, 'id'>[];
  collections: ImportedCollection[];
  world?: Partial<WorldSettings>;
  render?: Partial<RenderSettings>;
  /** Indice (dans `objects`) de la caméra active. */
  activeCamera?: number | null;
  /** Ce qui n'a pas pu être repris tel quel, en français, une phrase par ligne. */
  warnings: string[];
}

export interface ImportedCollection {
  name: string;
  /** Indice de la collection parente, null = collection racine de la scène. */
  parent: number | null;
  visible: boolean;
}

export interface ImportedMesh {
  name: string;
  /** Positions à plat (x, y, z…), repère local de l'objet, Z vers le haut. */
  positions: ArrayLike<number>;
  /** Polygones : indices de sommets, sens antihoraire vu de l'extérieur. N-gones admis. */
  polygons: ArrayLike<number>[];
  /** Emplacement de matériau de chaque polygone (absent : tous à 0). */
  polygonSlots?: ArrayLike<number>;
  /**
   * true : les sommets confondus sont soudés (formats qui dédoublent les sommets par normale
   * ou par UV : glTF, FBX, OBJ). false : la topologie du fichier est reprise telle quelle (.blend).
   */
  weld: boolean;
}

/** Modificateur importé ; pour un booléen, `target` est l'indice de l'objet opérande. */
export type ImportedModifier = {
  [K in ModifierType]: {
    type: K;
    name?: string;
    enabled?: boolean;
    params: Partial<ModifierParamsMap[K]>;
    target?: number | null;
  };
}[ModifierType];

export interface ImportedObject {
  name: string;
  type: ObjectType;
  /** Indice de l'objet parent, ou null. */
  parent: number | null;
  /** Matrice MONDE, Z vers le haut. */
  matrixWorld: Matrix4;
  /** Indice de la collection, null = racine. */
  collection: number | null;
  visible?: boolean;
  renderable?: boolean;
  /** Indice du maillage (objets `mesh`). Plusieurs objets peuvent partager le même. */
  mesh?: number | null;
  /** Emplacements de matériaux de l'objet : indices dans `scene.materials`, null = vide. */
  materials?: (number | null)[];
  light?: Partial<Omit<LightData, 'id'>>;
  camera?: Partial<Omit<CameraData, 'id'>>;
  modifiers?: ImportedModifier[];
  displayAs?: 'solid' | 'wire' | 'bounds';
  shadeSmooth?: boolean;
  autoSmoothAngle?: number;
}

export interface ApplyOptions {
  /**
   * 'append' (défaut) : ajoute à la scène courante, sans toucher au monde ni au rendu.
   * 'open' : le fichier devient la scène ; nom, monde, rendu et caméra active sont repris.
   */
  mode?: 'append' | 'open';
}

export interface ImportResult {
  /** Objets créés, dans l'ordre de `scene.objects` (plus les parties créées par découpage). */
  objectIds: string[];
  counts: { objects: number; meshes: number; lights: number; cameras: number; empties: number; materials: number; collections: number };
  warnings: string[];
}

// ------------------------------------------------------------------ maillages

/** MeshData sans soudure : un sommet du fichier = un sommet du document (topologie conservée). */
export function meshDataExact(positions: ArrayLike<number>, polygons: Iterable<ArrayLike<number>>): MeshData {
  const count = Math.floor(positions.length / 3);
  const ids = new Array<string | undefined>(count);
  const verts = new Map<string, Vec3>();
  const faces = new Map<string, string[]>();
  for (const poly of polygons) {
    const n = poly.length;
    if (n < 3) continue;
    const loop: string[] = [];
    let ok = true;
    for (let k = 0; k < n; k++) {
      const i = poly[k];
      if (!(i >= 0 && i < count)) {
        ok = false;
        break;
      }
      let id = ids[i];
      if (id === undefined) {
        const x = positions[i * 3];
        const y = positions[i * 3 + 1];
        const z = positions[i * 3 + 2];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
          ok = false;
          break;
        }
        id = newId(8);
        ids[i] = id;
        verts.set(id, [x, y, z]);
      }
      if (loop.length === 0 || loop[loop.length - 1] !== id) loop.push(id);
    }
    if (!ok) continue;
    while (loop.length > 1 && loop[0] === loop[loop.length - 1]) loop.pop();
    if (loop.length < 3 || new Set(loop).size !== loop.length) continue;
    faces.set(newId(8), loop);
  }
  // Un sommet créé pour une face finalement rejetée ne doit pas rester orphelin.
  const used = new Set<string>();
  for (const loop of faces.values()) for (const v of loop) used.add(v);
  if (used.size !== verts.size) for (const id of [...verts.keys()]) if (!used.has(id)) verts.delete(id);
  return { verts, faces };
}

function buildMesh(mesh: ImportedMesh, polygons: ArrayLike<number>[]): MeshData {
  return mesh.weld ? buildMeshData(mesh.positions, polygons as unknown as Iterable<readonly number[]>) : meshDataExact(mesh.positions, polygons);
}

/** Polygones regroupés par emplacement de matériau (ordre croissant des emplacements utilisés). */
function polygonsBySlot(mesh: ImportedMesh): Map<number, ArrayLike<number>[]> {
  const out = new Map<number, ArrayLike<number>[]>();
  const slots = mesh.polygonSlots;
  if (!slots) {
    out.set(0, mesh.polygons);
    return out;
  }
  for (let i = 0; i < mesh.polygons.length; i++) {
    const s = Math.max(0, slots[i] | 0);
    let list = out.get(s);
    if (!list) out.set(s, (list = []));
    list.push(mesh.polygons[i]);
  }
  return new Map([...out.entries()].sort((a, b) => a[0] - b[0]));
}

// ------------------------------------------------------------------ écriture dans le document

function modifierData(m: ImportedModifier, target: string | null): ModifierData {
  const params = { ...(MODIFIER_DEFAULTS[m.type] as object), ...(m.params as object) } as ModifierParamsMap[ModifierType];
  if (m.type === 'boolean') (params as ModifierParamsMap['boolean']).target = target;
  return { id: newId(8), type: m.type, name: m.name || MODIFIER_LABELS[m.type], enabled: m.enabled !== false, params };
}

/**
 * Écrit une scène importée dans le document, en une transaction (une étape d'annulation si
 * l'appelant encadre l'appel par beginOp/endOp).
 *
 * Matériaux multiples : le document n'admet qu'un matériau par objet. Un maillage qui en
 * utilise plusieurs devient un objet vide (qui porte le nom, la transformation et les enfants)
 * et un objet maillage enfant par matériau, nommé « Objet · Matériau ».
 */
export function applyImportedScene(doc: SceneDoc, scene: ImportedScene, options: ApplyOptions = {}): ImportResult {
  const mode = options.mode ?? 'append';
  const warnings = [...scene.warnings];
  const counts = { objects: 0, meshes: 0, lights: 0, cameras: 0, empties: 0, materials: 0, collections: 0 };
  const objectIds: string[] = [];
  let splitObjects = 0;

  doc.transact(() => {
    // Collections : parents avant enfants, quel que soit l'ordre du fichier.
    const colIds = new Array<string | undefined>(scene.collections.length);
    const colId = (i: number | null, depth = 0): string => {
      if (i === null || i < 0 || i >= scene.collections.length || depth > 64) return ROOT_COLLECTION;
      const known = colIds[i];
      if (known) return known;
      const c = scene.collections[i];
      const parent = c.parent === i ? ROOT_COLLECTION : colId(c.parent, depth + 1);
      const id = doc.addCollection({ name: c.name || 'Collection', parent, visible: c.visible !== false });
      colIds[i] = id;
      counts.collections++;
      return id;
    };
    // Seules les collections utiles (qui contiennent un objet, directement ou non) sont créées.
    const usedCols = new Set<number>();
    for (const o of scene.objects) {
      let c = o.collection;
      for (let d = 0; c !== null && c >= 0 && c < scene.collections.length && !usedCols.has(c) && d < 64; d++) {
        usedCols.add(c);
        c = scene.collections[c].parent;
      }
    }
    for (let i = 0; i < scene.collections.length; i++) if (usedCols.has(i)) colId(i);

    // Matériaux : créés à la demande (un matériau inutilisé n'encombre pas la scène).
    const matIds = new Array<string | undefined>(scene.materials.length);
    const matId = (i: number | null | undefined): string | null => {
      if (i === null || i === undefined || i < 0 || i >= scene.materials.length) return null;
      let id = matIds[i];
      if (!id) {
        id = doc.addMaterial(scene.materials[i]);
        matIds[i] = id;
        counts.materials++;
      }
      return id;
    };

    // Maillages : créés à la demande, partagés entre objets (données liées), un par emplacement utilisé.
    const slotCache = new Map<number, Map<number, ArrayLike<number>[]>>();
    const slotsOf = (mi: number) => {
      let s = slotCache.get(mi);
      if (!s) slotCache.set(mi, (s = polygonsBySlot(scene.meshes[mi])));
      return s;
    };
    const meshIds = new Map<string, string | null>();
    const meshId = (mi: number, slot: number | null): string | null => {
      const key = `${mi}:${slot ?? 'all'}`;
      const known = meshIds.get(key);
      if (known !== undefined) return known;
      const m = scene.meshes[mi];
      const data = buildMesh(m, slot === null ? m.polygons : (slotsOf(mi).get(slot) ?? []));
      const id = data.faces.size > 0 ? doc.createMesh(data, m.name || 'Maillage') : null;
      meshIds.set(key, id);
      return id;
    };

    // Identifiants réservés d'avance : parents et cibles de booléens se référencent librement.
    const ids = scene.objects.map(() => newId());
    const inv = new Matrix4();
    const local = new Matrix4();

    scene.objects.forEach((o, index) => {
      const parentOk = o.parent !== null && o.parent >= 0 && o.parent < scene.objects.length && o.parent !== index;
      if (parentOk) local.copy(inv.copy(scene.objects[o.parent!].matrixWorld).invert()).multiply(o.matrixWorld);
      else local.copy(o.matrixWorld);
      const trs = decompose(local);
      const finite = [...trs.pos, ...trs.rot, ...trs.scl].every(Number.isFinite);
      const base = {
        id: ids[index],
        name: o.name || 'Objet',
        parent: parentOk ? ids[o.parent!] : null,
        collection: colId(o.collection),
        pos: finite ? trs.pos : ([0, 0, 0] as Vec3),
        rot: finite ? trs.rot : ([0, 0, 0] as Vec3),
        scl: finite ? trs.scl : ([1, 1, 1] as Vec3),
        visible: o.visible !== false,
        renderable: o.renderable !== false,
        displayAs: o.displayAs ?? ('solid' as const),
      };
      objectIds.push(ids[index]);
      counts.objects++;

      if (o.type === 'light') {
        doc.addObject({ ...base, type: 'light', data: doc.addLight(o.light ?? {}) });
        counts.lights++;
        return;
      }
      if (o.type === 'camera') {
        doc.addObject({ ...base, type: 'camera', data: doc.addCamera(o.camera ?? {}) });
        counts.cameras++;
        return;
      }
      const mi = o.type === 'mesh' && typeof o.mesh === 'number' && o.mesh >= 0 && o.mesh < scene.meshes.length ? o.mesh : null;
      if (mi === null) {
        doc.addObject({ ...base, type: 'empty' });
        counts.empties++;
        return;
      }

      const shading = {
        shadeSmooth: !!o.shadeSmooth,
        autoSmoothAngle: Number.isFinite(o.autoSmoothAngle) ? (o.autoSmoothAngle as number) : 30,
        modifiers: () =>
          (o.modifiers ?? []).map((m) => {
            const t = m.type === 'boolean' && typeof m.target === 'number' && m.target >= 0 && m.target < ids.length ? ids[m.target] : null;
            return modifierData(m, t);
          }),
      };
      const slots = [...slotsOf(mi).keys()];
      if (slots.length <= 1) {
        const slot = slots[0] ?? 0;
        const data = meshId(mi, null);
        if (!data) {
          doc.addObject({ ...base, type: 'empty' });
          counts.empties++;
          return;
        }
        doc.addObject({
          ...base,
          type: 'mesh',
          data,
          material: matId(o.materials?.[slot]),
          shadeSmooth: shading.shadeSmooth,
          autoSmoothAngle: shading.autoSmoothAngle,
          modifiers: shading.modifiers(),
        });
        counts.meshes++;
        return;
      }

      // Plusieurs matériaux : un vide porteur + une partie par matériau.
      doc.addObject({ ...base, type: 'empty' });
      counts.empties++;
      splitObjects++;
      for (const slot of slots) {
        const data = meshId(mi, slot);
        if (!data) continue;
        const mat = o.materials?.[slot];
        const matName = mat !== null && mat !== undefined && scene.materials[mat] ? scene.materials[mat].name : `Emplacement ${slot + 1}`;
        const partId = doc.addObject({
          type: 'mesh',
          name: `${base.name} · ${matName}`,
          parent: ids[index],
          collection: base.collection,
          visible: base.visible,
          renderable: base.renderable,
          displayAs: base.displayAs,
          data,
          material: matId(mat),
          shadeSmooth: shading.shadeSmooth,
          autoSmoothAngle: shading.autoSmoothAngle,
          modifiers: shading.modifiers(),
        });
        objectIds.push(partId);
        counts.objects++;
        counts.meshes++;
      }
    });

    if (mode === 'open') {
      if (scene.name) doc.setSceneName(scene.name);
      if (scene.world) doc.updateWorld(scene.world);
      if (scene.render) doc.updateRender(scene.render);
      const cam = scene.activeCamera;
      if (typeof cam === 'number' && cam >= 0 && cam < ids.length && scene.objects[cam].type === 'camera') doc.setActiveCamera(ids[cam]);
    }
  });

  if (splitObjects > 0) {
    warnings.push(
      `${splitObjects} objet(s) à plusieurs matériaux découpé(s) en une partie par matériau (CoForge affecte un seul matériau par objet).`,
    );
  }
  return { objectIds, counts, warnings };
}
