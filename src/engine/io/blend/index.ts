import { Matrix4 } from 'three';
import { MATERIAL_DEFAULTS, type MaterialData } from '../../../core/doc/schema';
import type { ImportedObject, ImportedScene } from '../scene';
import { readCamera } from './cameras';
import { collectionObjects, instanceOffset, OB_RESTRICT_RENDER, OB_RESTRICT_VIEWPORT, sceneLayout, type SceneLayout } from './collections';
import { decompressBlendAsync } from './decompress';
import { BlendFile } from './file';
import { readLight } from './lights';
import { readMaterial } from './materials';
import { readMesh, type BlendMeshRead } from './mesh';
import { readModifiers } from './modifiers';
import { hasConstraints, objectKind, specialParent, WorldMatrices } from './objects';
import { idPointerArray, recAt, type Rec } from './reader';
import { makePause, Notes, type Ctx } from './util';
import { readRender, readWorld, renderAspect } from './world';

/** Objet que seul Blender peut évaluer (courbe, texte, modificateur non pris en charge…). */
export interface BlendPending {
  /** Indice dans `scene.objects`. */
  object: number;
  /** Nom de l'objet dans Blender. */
  name: string;
  /** Raison, en français (« courbe », « modificateur Armature »…). */
  reason: string;
}

export interface BlendScene extends ImportedScene {
  /** Version de Blender qui a écrit le fichier, ex. « 4.3 ». */
  blenderVersion: string;
  pending: BlendPending[];
  /**
   * Matériaux dont la couleur de base vient d'une texture image (`material` = indice dans
   * `scene.materials`, `name` = nom dans Blender) : leur couleur moyenne est demandée à Blender.
   */
  texturedMaterials: { material: number; name: string }[];
}

// Object.transflag
const OB_DUPLIVERTS = 1 << 4;
const OB_DUPLICOLLECTION = 1 << 8;
const OB_DUPLIFACES = 1 << 9;
// Object.dt (type d'affichage)
const OB_BOUNDBOX = 1;
const OB_WIRE = 2;

/** Profondeur maximale d'instances de collections imbriquées. */
const MAX_INSTANCE_DEPTH = 8;
/** Garde-fou sur le nombre total d'objets produits (instances comprises). */
const MAX_OBJECTS = 1_000_000;

const plural = (n: number, one: string, many: string): string => (n > 1 ? many : one);

/** « 279 » → « 2.79 », « 403 » → « 4.3 », « 501 » → « 5.1 ». */
function versionString(v: number): string {
  return `${Math.floor(v / 100)}.${v % 100}`;
}

/** Scène active à l'enregistrement (bloc GLOB), sinon la première du fichier. */
function activeScene(file: BlendFile): Rec | null {
  const glob = recAt(file, file.globalBlock);
  if (glob) {
    const sc = recAt(file, file.resolveId(glob.ptr('curscene')));
    if (sc && file.codeOf(sc.block) === 'SC') return sc;
  }
  for (const b of file.blocksOf('SC')) {
    const sc = recAt(file, b);
    if (sc) return sc;
  }
  return null;
}

/** Vrai si l'objet (ou son bloc de données) est animé ou piloté. */
function animation(ob: Rec): { animated: boolean; drivers: boolean } {
  const adt = ob.ptr('adt') !== 0 ? ob.get('adt', 'AnimData') : null;
  if (!adt) return { animated: ob.ptr('ipo') !== 0 || ob.ptr('action') !== 0, drivers: false };
  return { animated: adt.ptr('action') !== 0 || adt.list('nla_tracks').length > 0, drivers: adt.list('drivers').length > 0 };
}

/**
 * Lit un fichier .blend (Blender 2.5x → 5.x) sans Blender : scène active, objets, maillages,
 * matériaux, lumières, caméras, collections, modificateurs traduisibles, monde et rendu.
 * Lève une erreur en français si le fichier est illisible.
 */
export async function readBlendScene(data: ArrayBuffer): Promise<BlendScene> {
  const pause = makePause();
  const file = await BlendFile.open(await decompressBlendAsync(new Uint8Array(data), pause), pause);
  const notes = new Notes();
  const ctx: Ctx = { file, version: file.version, notes, pause };
  const scene = activeScene(file);
  // Fichier sans scène (bibliothèque d'assets, fichier écrit par `bpy.data.libraries.write`) :
  // tous les objets locaux du fichier sont repris, à la racine.
  const looseObjects = scene ? [] : file.blocksOf('OB').map((b) => recAt(file, b)).filter((r): r is Rec => !!r && r.st.name === 'Object' && !r.isLinked);
  if (!scene && looseObjects.length === 0) throw new Error('Fichier .blend sans scène ni objet : rien à importer.');
  const sceneName = scene ? scene.idName : '';

  const out: BlendScene = {
    name: sceneName || undefined,
    objects: [],
    meshes: [],
    materials: [],
    collections: [],
    warnings: [],
    activeCamera: null,
    blenderVersion: versionString(file.version),
    pending: [],
    texturedMaterials: [],
  };

  const others = file
    .blocksOf('SC')
    .filter((b) => b !== scene?.block)
    .map((b) => recAt(file, b)?.idName ?? '')
    .filter((n) => n !== '');
  if (others.length > 0) {
    const list = others.slice(0, 4).map((n) => `« ${n} »`).join(', ') + (others.length > 4 ? '…' : '');
    out.warnings.push(`Le fichier contient ${others.length} autre(s) scène(s) (${list}) : seule la scène active « ${sceneName} » est importée.`);
  }

  const layout: SceneLayout = scene
    ? sceneLayout(ctx, scene)
    : { entries: looseObjects.map((ob) => ({ ob, collection: null, hidden: false, noRender: false })), collections: [], hiddenLayers: false };
  if (!scene) {
    out.warnings.push(`Fichier sans scène (bibliothèque d'assets) : ses ${looseObjects.length} objet(s) sont importés à la racine ; monde, rendu et caméra active non définis.`);
  }
  out.collections = layout.collections;
  if (layout.hiddenLayers) notes.add('calques', () => 'Calques Blender 2.7x repris comme collections « Calque N » (masquées si le calque l\'était).');

  const worlds = new WorldMatrices();
  let aspect = 1;
  try {
    aspect = scene ? renderAspect(scene) : 1;
  } catch {
    aspect = 1;
  }
  if (!(aspect > 0) || !Number.isFinite(aspect)) aspect = 1;

  // ---------------------------------------------------------------- matériaux (à la demande)
  const matIndex = new Map<number, number>();
  const materialOf = (mat: Rec | null): number | null => {
    if (!mat) return null;
    const known = matIndex.get(mat.block);
    if (known !== undefined) return known;
    const i = out.materials.length;
    let m: Omit<MaterialData, 'id'>;
    if (mat.st.name === 'ID' || mat.isLinked) {
      m = { ...MATERIAL_DEFAULTS, name: mat.idName || 'Matériau' };
      notes.add('materiau-lie', (n, names) => `${n} matériau(x) lié(s) depuis une bibliothèque externe (${names}) : réglages par défaut.`, mat.idName);
    } else {
      try {
        const r = readMaterial(ctx, mat);
        m = { ...r.material, name: r.material.name || mat.idName || 'Matériau' };
        if (r.textured) out.texturedMaterials.push({ material: i, name: mat.idName });
      } catch {
        m = { ...MATERIAL_DEFAULTS, name: mat.idName || 'Matériau' };
        notes.add('materiau-illisible', (n, names) => `${n} matériau(x) illisible(s) (${names}) : réglages par défaut.`, mat.idName);
      }
    }
    out.materials.push(m);
    matIndex.set(mat.block, i);
    return i;
  };

  /** Emplacements de matériaux d'un objet : `matbits` choisit entre l'objet et ses données. */
  const slotsOf = (ob: Rec, data: Rec | null): (number | null)[] => {
    const obCount = Math.max(0, Math.min(ob.num('totcol'), 32767));
    const dataCount = data && data.st.name !== 'ID' ? Math.max(0, Math.min(data.num('totcol'), 32767)) : 0;
    const n = Math.max(obCount, dataCount);
    if (n === 0) return [];
    const obMats = idPointerArray(ob, 'mat', obCount);
    const dataMats = data && dataCount > 0 ? idPointerArray(data, 'mat', dataCount) : [];
    const bitsBlock = ob.target('matbits');
    const slots: (number | null)[] = [];
    for (let i = 0; i < n; i++) {
      const fromObject = bitsBlock >= 0 && i < file.len[bitsBlock] && file.bytes[file.pos[bitsBlock] + i] !== 0;
      const ptr = fromObject ? obMats[i] : dataMats[i];
      slots.push(ptr ? materialOf(recAt(file, file.resolveId(ptr))) : null);
    }
    return slots;
  };

  // ---------------------------------------------------------------- maillages (partagés)
  const meshCache = new Map<number, { index: number; read: BlendMeshRead } | null>();
  const meshOf = async (me: Rec): Promise<{ index: number; read: BlendMeshRead } | null> => {
    if (meshCache.has(me.block)) return meshCache.get(me.block)!;
    let entry: { index: number; read: BlendMeshRead } | null = null;
    try {
      const read = await readMesh(ctx, me);
      entry = { index: out.meshes.length, read };
      out.meshes.push(read.mesh);
      if (read.looseVerts > 0) notes.add('isoles', (n, names) => `Sommets et arêtes isolés non repris (${n} ${plural(n, 'maillage', 'maillages')} : ${names}).`, me.idName);
    } catch {
      notes.add('maillage-illisible', (n, names) => `${n} maillage(s) illisible(s) (${names}) : objets repris comme vides.`, me.idName);
    }
    meshCache.set(me.block, entry);
    return entry;
  };

  // ---------------------------------------------------------------- objets
  const pendingOf = new Map<number, string>();

  /** Construit l'objet importé d'un bloc d'objet Blender (sans parent : fixé ensuite). */
  const buildObject = async (ob: Rec, world: Matrix4, collection: number | null, hidden: boolean, noRender: boolean, resolve: (block: number) => number | null): Promise<{ obj: ImportedObject; pending: string | null }> => {
    const name = ob.idName || 'Objet';
    if (ob.st.name === 'ID' || ob.isLinked) {
      notes.add('objet-lie', (n, names) => `${n} objet(s) lié(s) depuis une bibliothèque externe (${names}) : leur contenu n'est pas dans ce fichier.`, name);
      return { obj: { name, type: 'empty', parent: null, matrixWorld: world, collection, visible: !hidden, renderable: !noRender }, pending: 'bibliothèque' };
    }
    const restrict = ob.num('restrictflag');
    const dt = ob.num('dt');
    const obj: ImportedObject = {
      name,
      type: 'empty',
      parent: null,
      matrixWorld: world,
      collection,
      visible: !hidden && !(restrict & OB_RESTRICT_VIEWPORT),
      renderable: !noRender && !(restrict & OB_RESTRICT_RENDER),
      displayAs: dt === OB_BOUNDBOX ? 'bounds' : dt === OB_WIRE ? 'wire' : 'solid',
    };
    let pending: string | null = null;

    // Ce qui n'est pas recalculé : regroupé par cause.
    const anim = animation(ob);
    if (anim.animated) notes.add('animation', (n, names) => `Animation non reprise : pose de l'enregistrement conservée (${n} ${plural(n, 'objet', 'objets')} : ${names}).`, name);
    if (anim.drivers) notes.add('pilotes', (n, names) => `Pilotes (drivers) non évalués (${n} ${plural(n, 'objet', 'objets')} : ${names}).`, name);
    const stored = ob.has('obmat') || ob.has('object_to_world');
    if (hasConstraints(ob)) {
      notes.add('contraintes', (n, names) => `Contraintes non recalculées${stored ? " (position de l'enregistrement conservée)" : ''} (${n} ${plural(n, 'objet', 'objets')} : ${names}).`, name);
    }
    const special = specialParent(ob);
    if (special) {
      notes.add(`parent-${special}`, (n, names) => `Parentage à un ${special} non recalculé${stored ? " (position de l'enregistrement conservée)" : ', repris comme parentage simple'} (${n} ${plural(n, 'objet', 'objets')} : ${names}).`, name);
    }
    if (ob.list('particlesystem').length > 0) notes.add('particules', (n, names) => `Systèmes de particules non repris (${n} ${plural(n, 'objet', 'objets')} : ${names}).`, name);
    const transflag = ob.num('transflag');
    if (transflag & (OB_DUPLIVERTS | OB_DUPLIFACES)) notes.add('dupli', (n, names) => `Instances sur sommets ou faces non reprises (${n} ${plural(n, 'objet', 'objets')} : ${names}).`, name);

    const kind = objectKind(ob);
    const data = ob.ptr('data') !== 0 ? recAt(file, file.resolveId(ob.ptr('data'))) : null;
    if (kind.emptyOf) {
      notes.add(`vide-${kind.emptyOf}`, (n, names) => `${n} objet(s) de type ${kind.emptyOf} repris comme vide(s) (${names}).`, name);
      return { obj, pending: null };
    }
    if (kind.pending) {
      pending = kind.pending;
      obj.materials = slotsOf(ob, data);
      return { obj, pending };
    }
    if (data && (data.st.name === 'ID' || data.isLinked)) {
      notes.add('donnees-liees', (n, names) => `${n} objet(s) dont les données viennent d'une bibliothèque externe (${names}).`, name);
      return { obj, pending: 'bibliothèque' };
    }

    if (kind.type === 'light') {
      obj.type = 'light';
      if (data) {
        try {
          obj.light = readLight(ctx, data);
        } catch {
          notes.add('lumiere-illisible', (n, names) => `${n} lumière(s) illisible(s) (${names}) : réglages par défaut.`, name);
        }
      }
      return { obj, pending: null };
    }
    if (kind.type === 'camera') {
      obj.type = 'camera';
      if (data) {
        try {
          obj.camera = readCamera(ctx, data, aspect);
        } catch {
          notes.add('camera-illisible', (n, names) => `${n} caméra(s) illisible(s) (${names}) : réglages par défaut.`, name);
        }
      }
      return { obj, pending: null };
    }
    if (kind.type !== 'mesh' || !data || data.st.name !== 'Mesh') return { obj, pending: null };

    const mesh = await meshOf(data);
    if (!mesh) return { obj, pending: null };
    obj.type = 'mesh';
    obj.mesh = mesh.index;
    obj.materials = slotsOf(ob, data);
    const stack = readModifiers(ctx, ob, resolve);
    obj.modifiers = stack.modifiers;
    const { smoothFaces, faces, autoSmooth } = mesh.read;
    if (stack.smoothByAngle !== null) {
      obj.shadeSmooth = true;
      obj.autoSmoothAngle = stack.smoothByAngle;
    } else {
      obj.shadeSmooth = faces > 0 && smoothFaces * 2 >= faces;
      if (obj.shadeSmooth) obj.autoSmoothAngle = autoSmooth ?? 180;
      if (smoothFaces > 0 && smoothFaces < faces) {
        notes.add('ombrage-mixte', (n, names) => `Ombrage lisse/plat mélangé dans un même maillage : un seul ombrage par objet dans CoForge (${n} ${plural(n, 'objet', 'objets')} : ${names}).`, name);
      }
    }
    if (stack.unsupported.length > 0) pending = `modificateur ${[...new Set(stack.unsupported)].join(', ')}`;
    else if (mesh.read.activeShapeKeys) pending = 'clés de forme';
    return { obj, pending };
  };

  // Premier passage : indices réservés (booléens et parents se référencent librement).
  const entries = layout.entries;
  const indexOf = new Map<number, number>();
  entries.forEach((e, i) => indexOf.set(e.ob.block, i));
  const resolveScene = (block: number): number | null => indexOf.get(block) ?? null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const world = e.ob.st.name === 'Object' ? worlds.get(e.ob) : new Matrix4();
    const { obj, pending } = await buildObject(e.ob, world, e.collection, e.hidden, e.noRender, resolveScene);
    out.objects.push(obj);
    if (pending) pendingOf.set(i, pending);
    await ctx.pause();
  }
  for (let i = 0; i < entries.length; i++) {
    const ob = entries[i].ob;
    if (ob.st.name !== 'Object' || ob.ptr('parent') === 0) continue;
    const p = resolveScene(file.resolveId(ob.ptr('parent')));
    out.objects[i].parent = p !== null && p !== i ? p : null;
  }

  // ---------------------------------------------------------------- instances de collections
  let instanceCount = 0;
  const instanceOf = (ob: Rec): Rec | null => {
    if (ob.st.name !== 'Object' || !(ob.num('transflag') & OB_DUPLICOLLECTION)) return null;
    const col = ob.id(['instance_collection', 'dup_group']);
    return col && col.st.name !== 'ID' ? col : null;
  };
  const expand = async (instancer: number, col: Rec, depth: number, chain: Set<number>): Promise<void> => {
    if (depth >= MAX_INSTANCE_DEPTH || chain.has(col.block)) {
      notes.add('instance-recursive', () => `Instance de collection récursive ou trop imbriquée : arrêtée après ${MAX_INSTANCE_DEPTH} niveaux au plus.`);
      return;
    }
    const members = collectionObjects(col);
    if (out.objects.length + members.length > MAX_OBJECTS) {
      notes.add('instances-trop', () => 'Trop d\'instances de collections : les dernières ne sont pas développées.');
      return;
    }
    chain.add(col.block);
    const host = out.objects[instancer];
    const off = instanceOffset(col);
    const base = host.matrixWorld.clone().multiply(new Matrix4().makeTranslation(-off[0], -off[1], -off[2]));
    const copies = new Map<number, number>();
    members.forEach((m, k) => copies.set(m.block, out.objects.length + k));
    const resolveCopy = (block: number): number | null => copies.get(block) ?? resolveScene(block);
    const start = out.objects.length;
    for (const m of members) {
      const world = m.st.name === 'Object' ? base.clone().multiply(worlds.get(m)) : base.clone();
      const { obj, pending } = await buildObject(m, world, host.collection, host.visible === false, host.renderable === false, resolveCopy);
      const idx = out.objects.length;
      out.objects.push(obj);
      if (pending) pendingOf.set(idx, pending);
      instanceCount++;
    }
    members.forEach((m, k) => {
      const p = m.st.name === 'Object' && m.ptr('parent') !== 0 ? copies.get(file.resolveId(m.ptr('parent'))) : undefined;
      out.objects[start + k].parent = p ?? instancer;
    });
    for (let k = 0; k < members.length; k++) {
      const sub = instanceOf(members[k]);
      if (sub) await expand(start + k, sub, depth + 1, chain);
    }
    chain.delete(col.block);
    await ctx.pause();
  };
  const sceneCount = out.objects.length;
  for (let i = 0; i < sceneCount; i++) {
    const col = instanceOf(entries[i].ob);
    if (col) await expand(i, col, 0, new Set());
  }
  if (instanceCount > 0) {
    out.warnings.push(`Instances de collections développées en ${instanceCount} copie(s) indépendante(s) (maillages partagés).`);
  }

  // ---------------------------------------------------------------- en attente
  for (const [object, reason] of [...pendingOf.entries()].sort((a, b) => a[0] - b[0])) {
    out.pending.push({ object, name: out.objects[object].name, reason });
  }

  // ---------------------------------------------------------------- caméra active, monde, rendu
  if (scene) {
    const cam = scene.ptr('camera') !== 0 ? resolveScene(file.resolveId(scene.ptr('camera'))) : null;
    out.activeCamera = cam !== null && out.objects[cam]?.type === 'camera' ? cam : null;
    try {
      const world = readWorld(ctx, scene);
      if (world) out.world = world;
    } catch {
      notes.add('monde-illisible', () => 'Monde illisible : réglages par défaut.');
    }
    try {
      out.render = readRender(ctx, scene);
    } catch {
      notes.add('rendu-illisible', () => 'Réglages de rendu illisibles : valeurs par défaut.');
    }
  }

  out.warnings.push(...notes.list());
  return out;
}

