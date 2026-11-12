import type { ImportedCollection } from '../scene';
import type { Ptr } from './file';
import { recAt, type Rec } from './reader';
import type { Ctx } from './util';

/**
 * Collections et visibilité.
 *  - Blender 2.8+ : arbre `Scene.master_collection` → `Collection.children`, objets dans `gobject` ;
 *    visibilité : collection masquée (`flag`), exclusion et œil du calque de vue (`LayerCollection.flag`),
 *    œil de l'objet (`Base.flag` du calque de vue), objet masqué (`restrictflag`).
 *  - Avant 2.8 : liste `Scene.base`, 20 calques (`lay`) ; un objet dont le calque n'est pas affiché
 *    est caché. Les calques utilisés deviennent des collections « Calque N » quand il y en a plusieurs.
 */

const COLLECTION_HIDE_VIEWPORT = 1;
const COLLECTION_HIDE_RENDER = 8;
const LAYER_COLLECTION_EXCLUDE = 16;
const LAYER_COLLECTION_HIDE = 128;
const BASE_HIDDEN = 256;

export const OB_RESTRICT_VIEWPORT = 1;
export const OB_RESTRICT_RENDER = 4;

/** Garde-fous : profondeur d'arbre et nombre d'éléments parcourus. */
const MAX_DEPTH = 64;
const MAX_ITEMS = 2_000_000;

export interface SceneEntry {
  ob: Rec;
  /** Indice de collection (dans `collections`), null = racine. */
  collection: number | null;
  /** Caché dans le viewport par le calque de vue (œil) ou par un calque 2.7x masqué. */
  hidden: boolean;
  /** Exclu du rendu par sa collection (collection non rendue ou exclue du calque de vue). */
  noRender: boolean;
}

export interface SceneLayout {
  entries: SceneEntry[];
  collections: ImportedCollection[];
  /** Les objets ne sont pas tous sur des calques affichés (2.7x). */
  hiddenLayers: boolean;
}

/** Calque de vue actif : celui de la fenêtre qui affiche la scène, sinon le premier. */
function activeViewLayer(ctx: Ctx, scene: Rec): Rec | null {
  const layers = scene.list('view_layers');
  if (layers.length === 0) return null;
  const file = ctx.file;
  for (const wmBlock of file.blocksOf('WM')) {
    const wm = recAt(file, wmBlock);
    if (!wm) continue;
    for (const win of wm.list('windows')) {
      if (file.resolveId(win.ptr('scene')) !== scene.block) continue;
      const name = win.str('view_layer_name');
      const found = layers.find((l) => l.str('name') === name);
      if (found) return found;
    }
  }
  return layers[0];
}

function ptrEq(a: Ptr, b: Ptr): boolean {
  return a !== 0 && a === b;
}

/** Répartition des objets de la scène dans ses collections. */
export function sceneLayout(ctx: Ctx, scene: Rec): SceneLayout {
  const master = scene.ptr('master_collection') !== 0 ? scene.get('master_collection', 'Collection') : null;
  return master ? layout28(ctx, scene, master) : layoutLegacy(ctx, scene);
}

function layout28(ctx: Ctx, scene: Rec, master: Rec): SceneLayout {
  const file = ctx.file;
  const entries: SceneEntry[] = [];
  const collections: ImportedCollection[] = [];
  const seenObjects = new Set<number>();
  const seenCollections = new Set<number>();

  // Drapeaux de base (œil) du calque de vue, par adresse d'objet.
  const viewLayer = activeViewLayer(ctx, scene);
  const baseHidden = new Set<number>();
  if (viewLayer) {
    for (const base of viewLayer.list('object_bases')) {
      if (base.num('flag') & BASE_HIDDEN) {
        const ob = file.resolveId(base.ptr('object'));
        if (ob >= 0) baseHidden.add(ob);
      }
    }
  }
  const rootLc = viewLayer ? viewLayer.list('layer_collections')[0] ?? null : null;

  const walk = (col: Rec, lc: Rec | null, index: number | null, hidden: boolean, noRender: boolean, depth: number): void => {
    for (const co of col.list('gobject')) {
      if (entries.length >= MAX_ITEMS) return;
      const ob = co.id('ob');
      if (!ob || seenObjects.has(ob.block)) continue;
      seenObjects.add(ob.block);
      entries.push({ ob, collection: index, hidden: hidden || baseHidden.has(ob.block), noRender });
    }
    if (depth >= MAX_DEPTH) {
      ctx.notes.add('collections-profondes', () => 'Collections trop imbriquées : les niveaux au-delà de 64 sont ignorés.');
      return;
    }
    const lcChildren = lc ? lc.list('layer_collections') : [];
    for (const child of col.list('children')) {
      const ptr = child.ptr('collection');
      const sub = child.id('collection');
      if (!sub || sub.st.name === 'ID' || seenCollections.has(sub.block) || collections.length >= MAX_ITEMS) continue;
      seenCollections.add(sub.block);
      const subLc = lcChildren.find((l) => ptrEq(l.ptr('collection'), ptr)) ?? null;
      const flag = sub.num('flag');
      const lcFlag = subLc ? subLc.num('flag') : 0;
      const excluded = (lcFlag & LAYER_COLLECTION_EXCLUDE) !== 0;
      const visible = !(flag & COLLECTION_HIDE_VIEWPORT) && !excluded && !(lcFlag & LAYER_COLLECTION_HIDE);
      const ci = collections.length;
      collections.push({ name: sub.idName || 'Collection', parent: index, visible });
      if (excluded) ctx.notes.add('collection-exclue', (n) => `${n} collection(s) exclue(s) du calque de vue : importée(s) masquée(s) et hors rendu.`);
      walk(sub, subLc, ci, false, noRender || excluded || (flag & COLLECTION_HIDE_RENDER) !== 0, depth + 1);
    }
  };
  walk(master, rootLc, null, false, (master.num('flag') & COLLECTION_HIDE_RENDER) !== 0, 0);
  return { entries, collections, hiddenLayers: false };
}

function lowestLayer(lay: number): number {
  for (let i = 0; i < 20; i++) if (lay & (1 << i)) return i;
  return -1;
}

function layoutLegacy(ctx: Ctx, scene: Rec): SceneLayout {
  const file = ctx.file;
  const sceneLay = scene.num('lay', 1);
  const raw: { ob: Rec; layer: number; visible: boolean }[] = [];
  const seen = new Set<number>();
  for (const base of scene.list('base')) {
    if (raw.length >= MAX_ITEMS) break;
    const ob = recAt(file, file.resolveId(base.ptr('object')));
    if (!ob || seen.has(ob.block)) continue;
    seen.add(ob.block);
    const lay = base.num('lay') || ob.num('lay');
    raw.push({ ob, layer: lowestLayer(lay), visible: lay === 0 || (lay & sceneLay) !== 0 });
  }
  const used = [...new Set(raw.map((r) => r.layer).filter((l) => l >= 0))].sort((a, b) => a - b);
  const hiddenLayers = raw.some((r) => !r.visible);
  const collections: ImportedCollection[] = [];
  const colOf = new Map<number, number>();
  if (used.length > 1 || hiddenLayers) {
    for (const l of used) {
      colOf.set(l, collections.length);
      collections.push({ name: `Calque ${l + 1}`, parent: null, visible: (sceneLay & (1 << l)) !== 0 });
    }
  }
  const entries = raw.map((r) => ({ ob: r.ob, collection: colOf.get(r.layer) ?? null, hidden: !r.visible && colOf.size === 0, noRender: false }));
  return { entries, collections, hiddenLayers };
}

/**
 * Objets instanciés par une collection (2.8+, enfants compris) ou un groupe (avant 2.8, limité aux
 * calques du groupe), dans l'ordre, sans doublon.
 */
export function collectionObjects(col: Rec): Rec[] {
  const out: Rec[] = [];
  const seen = new Set<number>();
  const visited = new Set<number>();
  const groupLayer = col.has('children') ? 0 : col.num('layer');
  const walk = (c: Rec, depth: number): void => {
    if (visited.has(c.block) || depth > MAX_DEPTH) return;
    visited.add(c.block);
    for (const go of c.list('gobject')) {
      if (out.length >= MAX_ITEMS) return;
      const ob = go.id('ob');
      if (!ob || seen.has(ob.block)) continue;
      if (groupLayer && ob.has('lay') && !(ob.num('lay') & groupLayer)) continue;
      seen.add(ob.block);
      out.push(ob);
    }
    for (const child of c.list('children')) {
      const sub = child.id('collection');
      if (sub && sub.st.name !== 'ID') walk(sub, depth + 1);
    }
  };
  walk(col, 0);
  return out;
}

/** Décalage d'instance de la collection (`instance_offset`, ex-`dupli_ofs`). */
export function instanceOffset(col: Rec): [number, number, number] {
  const v = col.nums(['instance_offset', 'dupli_ofs'], 3);
  if (!v || v.length < 3 || !v.every(Number.isFinite)) return [0, 0, 0];
  return [v[0], v[1], v[2]];
}
