import { Vector3 } from 'three';
import { newId } from '../../core/ids';
import {
  CONSTRAINT_DEFAULTS,
  CONSTRAINT_LABELS,
  MODIFIER_DEFAULTS,
  MODIFIER_LABELS,
  type ConstraintData,
  type ConstraintType,
  type ModifierData,
  type ModifierType,
  type Vec3,
} from '../../core/doc/schema';
import type { SceneDoc } from '../../core/doc/SceneDoc';
import { worldMatrix } from '../../core/doc/transforms';

/**
 * Piles de modificateurs et de contraintes d'un objet : logique pure sur un `SceneDoc`
 * (aucun accès à l'application ni à React, donc testable telle quelle).
 *
 * Chaque fonction relit l'état COURANT du document avant d'écrire (la pile peut avoir été
 * modifiée par un autre utilisateur depuis le dernier rendu) et écrit la pile entière en une
 * transaction. Elles ne supposent jamais qu'une donnée lue est bien formée.
 */

export function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Nom unique dans une pile, à la Blender : « Miroir », « Miroir.001 »… */
export function uniqueStackName(items: readonly { name: string }[], base: string): string {
  const names = new Set(items.map((m) => m.name));
  if (!names.has(base)) return base;
  const stem = base.replace(/\.\d{3}$/, '');
  for (let i = 1; i < 1000; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
  return `${stem}.${newId(4)}`;
}

/** Échange l'élément `id` avec son voisin (-1 : vers le haut, 1 : vers le bas). Renvoie null si impossible. */
function moved<T extends { id: string }>(items: T[], id: string, direction: -1 | 1): T[] | null {
  const i = items.findIndex((m) => m.id === id);
  const j = i + direction;
  if (i < 0 || j < 0 || j >= items.length) return null;
  const next = items.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

// ------------------------------------------------------------------ modificateurs

export interface StackMenuGroup<T extends string> {
  label: string;
  types: T[];
}

/** Menu « Ajouter un modificateur », classé comme dans Blender. */
export const MODIFIER_MENU: StackMenuGroup<ModifierType>[] = [
  {
    label: 'Générer',
    types: [
      'array',
      'bevel',
      'boolean',
      'decimate',
      'edgesplit',
      'mirror',
      'remesh',
      'screw',
      'skin',
      'solidify',
      'subsurf',
      'triangulate',
      'weld',
      'wireframe',
      'nodes',
    ],
  },
  { label: 'Déformer', types: ['cast', 'displace', 'shrinkwrap', 'simpledeform', 'smooth', 'wave'] },
];

/** Pile de modificateurs d'un objet, débarrassée des entrées inutilisables (données d'un autre client). */
export function readModifiers(raw: unknown): ModifierData[] {
  if (!Array.isArray(raw)) return [];
  const out: ModifierData[] = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !(m.type in MODIFIER_DEFAULTS)) continue;
    const type = m.type as ModifierType;
    out.push({
      id: m.id,
      type,
      name: typeof m.name === 'string' && m.name ? m.name : MODIFIER_LABELS[type],
      enabled: m.enabled !== false,
      params: { ...cloneJson(MODIFIER_DEFAULTS[type]), ...(m.params && typeof m.params === 'object' ? cloneJson(m.params) : {}) },
    } as ModifierData);
  }
  return out;
}

export function makeModifier(type: ModifierType, existing: readonly { name: string }[]): ModifierData {
  return {
    id: newId(8),
    type,
    name: uniqueStackName(existing, MODIFIER_LABELS[type]),
    enabled: true,
    params: cloneJson(MODIFIER_DEFAULTS[type]),
  } as ModifierData;
}

/** Ajoute un modificateur en fin de pile. Renvoie son identifiant, ou null (objet absent ou non maillage). */
export function addModifierTo(doc: SceneDoc, objectId: string, type: ModifierType): string | null {
  const obj = doc.getObject(objectId);
  if (!obj || obj.type !== 'mesh' || !(type in MODIFIER_DEFAULTS)) return null;
  const mods = Array.isArray(obj.modifiers) ? obj.modifiers.map(cloneJson) : [];
  const mod = makeModifier(type, mods);
  doc.updateObject(objectId, { modifiers: [...mods, mod] });
  return mod.id;
}

export function removeModifierFrom(doc: SceneDoc, objectId: string, modifierId: string): boolean {
  const obj = doc.getObject(objectId);
  if (!obj || !Array.isArray(obj.modifiers) || !obj.modifiers.some((m) => m.id === modifierId)) return false;
  doc.updateObject(objectId, { modifiers: obj.modifiers.filter((m) => m.id !== modifierId).map(cloneJson) });
  return true;
}

export function moveModifierIn(doc: SceneDoc, objectId: string, modifierId: string, direction: -1 | 1): boolean {
  const obj = doc.getObject(objectId);
  if (!obj || !Array.isArray(obj.modifiers)) return false;
  const next = moved(obj.modifiers.map(cloneJson), modifierId, direction);
  if (!next) return false;
  doc.updateObject(objectId, { modifiers: next });
  return true;
}

/** Duplique un modificateur juste en dessous de l'original. Renvoie l'identifiant de la copie. */
export function duplicateModifierIn(doc: SceneDoc, objectId: string, modifierId: string): string | null {
  const obj = doc.getObject(objectId);
  if (!obj || !Array.isArray(obj.modifiers)) return null;
  const mods = obj.modifiers.map(cloneJson);
  const i = mods.findIndex((m) => m.id === modifierId);
  if (i < 0) return null;
  const copy = { ...cloneJson(mods[i]), id: newId(8), name: uniqueStackName(mods, mods[i].name) };
  mods.splice(i + 1, 0, copy);
  doc.updateObject(objectId, { modifiers: mods });
  return copy.id;
}

/** Remplace un modificateur par `fn(modificateur courant)`. */
export function patchModifierIn(doc: SceneDoc, objectId: string, modifierId: string, fn: (m: ModifierData) => ModifierData): boolean {
  const obj = doc.getObject(objectId);
  if (!obj || !Array.isArray(obj.modifiers)) return false;
  const idx = obj.modifiers.findIndex((m) => m.id === modifierId);
  if (idx < 0) return false;
  const next = obj.modifiers.map(cloneJson);
  next[idx] = fn(next[idx]);
  doc.updateObject(objectId, { modifiers: next });
  return true;
}

// ------------------------------------------------------------------ contraintes

/** Menu « Ajouter une contrainte », classé comme dans Blender. */
export const CONSTRAINT_MENU: StackMenuGroup<ConstraintType>[] = [
  { label: 'Suivi', types: ['track_to', 'damped_track', 'locked_track'] },
  {
    label: 'Transformation',
    types: ['copy_location', 'copy_rotation', 'copy_scale', 'copy_transforms', 'limit_location', 'limit_rotation', 'limit_scale', 'limit_distance'],
  },
  { label: 'Relation', types: ['child_of', 'floor'] },
];

/** Types de contraintes qui visent un objet cible. */
export function constraintUsesTarget(type: ConstraintType): boolean {
  return type !== 'limit_location' && type !== 'limit_rotation' && type !== 'limit_scale';
}

const TRACK_AXES = new Set(['x', 'y', 'z', '-x', '-y', '-z']);
const UP_AXES = new Set(['x', 'y', 'z']);
const LIMIT_MODES = new Set(['inside', 'outside', 'surface']);

function vec3(v: unknown, fallback: Vec3): Vec3 {
  if (!Array.isArray(v)) return [...fallback];
  return [0, 1, 2].map((i) => (typeof v[i] === 'number' && Number.isFinite(v[i]) ? v[i] : fallback[i])) as Vec3;
}

function bool3(v: unknown, fallback: [boolean, boolean, boolean]): [boolean, boolean, boolean] {
  if (!Array.isArray(v)) return [...fallback];
  return [0, 1, 2].map((i) => (typeof v[i] === 'boolean' ? v[i] : fallback[i])) as [boolean, boolean, boolean];
}

function finite(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Pile de contraintes d'un objet, complétée par les valeurs par défaut : une contrainte écrite
 * par un autre client (ou un ancien fichier) peut être partielle. Les entrées sans identifiant
 * ou de type inconnu sont ignorées.
 */
export function readConstraints(raw: unknown): ConstraintData[] {
  if (!Array.isArray(raw)) return [];
  const d = CONSTRAINT_DEFAULTS;
  const out: ConstraintData[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !(c.type in CONSTRAINT_LABELS)) continue;
    const type = c.type as ConstraintType;
    const inverse = Array.isArray(c.inverse) && c.inverse.length === 16 && c.inverse.every((n: unknown) => typeof n === 'number' && Number.isFinite(n));
    out.push({
      id: c.id,
      type,
      name: typeof c.name === 'string' && c.name ? c.name : CONSTRAINT_LABELS[type],
      enabled: c.enabled !== false,
      influence: Math.max(0, Math.min(1, finite(c.influence, d.influence))),
      target: typeof c.target === 'string' && c.target ? c.target : null,
      useX: typeof c.useX === 'boolean' ? c.useX : d.useX,
      useY: typeof c.useY === 'boolean' ? c.useY : d.useY,
      useZ: typeof c.useZ === 'boolean' ? c.useZ : d.useZ,
      invertX: c.invertX === true,
      invertY: c.invertY === true,
      invertZ: c.invertZ === true,
      offset: c.offset === true,
      min: vec3(c.min, d.min),
      max: vec3(c.max, d.max),
      useMin: bool3(c.useMin, d.useMin),
      useMax: bool3(c.useMax, d.useMax),
      distance: Math.max(0, finite(c.distance, d.distance)),
      limitMode: LIMIT_MODES.has(c.limitMode) ? c.limitMode : d.limitMode,
      trackAxis: TRACK_AXES.has(c.trackAxis) ? c.trackAxis : d.trackAxis,
      upAxis: UP_AXES.has(c.upAxis) ? c.upAxis : d.upAxis,
      inverse: inverse ? [...c.inverse] : null,
      floorOffset: finite(c.floorOffset, d.floorOffset),
    });
  }
  return out;
}

export function makeConstraint(type: ConstraintType, existing: readonly { name: string }[]): ConstraintData {
  const base = cloneJson(CONSTRAINT_DEFAULTS);
  // Une contrainte de limite d'échelle neuve doit être neutre : bornes à 1, pas à 0.
  if (type === 'limit_scale') {
    base.min = [1, 1, 1];
    base.max = [1, 1, 1];
  }
  return { ...base, id: newId(8), type, name: uniqueStackName(existing, CONSTRAINT_LABELS[type]) };
}

/** Ajoute une contrainte en fin de pile. Renvoie son identifiant, ou null si l'objet n'existe pas. */
export function addConstraintTo(doc: SceneDoc, objectId: string, type: ConstraintType): string | null {
  const obj = doc.getObject(objectId);
  if (!obj || !(type in CONSTRAINT_LABELS)) return null;
  const list = readConstraints(obj.constraints);
  const c = makeConstraint(type, list);
  doc.updateObject(objectId, { constraints: [...list, c] });
  return c.id;
}

export function removeConstraintFrom(doc: SceneDoc, objectId: string, constraintId: string): boolean {
  const obj = doc.getObject(objectId);
  if (!obj) return false;
  const list = readConstraints(obj.constraints);
  if (!list.some((c) => c.id === constraintId)) return false;
  doc.updateObject(objectId, { constraints: list.filter((c) => c.id !== constraintId) });
  return true;
}

export function moveConstraintIn(doc: SceneDoc, objectId: string, constraintId: string, direction: -1 | 1): boolean {
  const obj = doc.getObject(objectId);
  if (!obj) return false;
  const next = moved(readConstraints(obj.constraints), constraintId, direction);
  if (!next) return false;
  doc.updateObject(objectId, { constraints: next });
  return true;
}

/** Duplique une contrainte juste en dessous de l'originale. Renvoie l'identifiant de la copie. */
export function duplicateConstraintIn(doc: SceneDoc, objectId: string, constraintId: string): string | null {
  const obj = doc.getObject(objectId);
  if (!obj) return null;
  const list = readConstraints(obj.constraints);
  const i = list.findIndex((c) => c.id === constraintId);
  if (i < 0) return null;
  const copy: ConstraintData = { ...cloneJson(list[i]), id: newId(8), name: uniqueStackName(list, list[i].name) };
  list.splice(i + 1, 0, copy);
  doc.updateObject(objectId, { constraints: list });
  return copy.id;
}

export type ConstraintPatch = Partial<Omit<ConstraintData, 'id' | 'type'>>;

/** Modifie des champs d'une contrainte (le type et l'identifiant ne changent jamais). */
export function patchConstraintIn(doc: SceneDoc, objectId: string, constraintId: string, patch: ConstraintPatch): boolean {
  const obj = doc.getObject(objectId);
  if (!obj) return false;
  const list = readConstraints(obj.constraints);
  const i = list.findIndex((c) => c.id === constraintId);
  if (i < 0) return false;
  list[i] = { ...list[i], ...cloneJson(patch), id: list[i].id, type: list[i].type };
  doc.updateObject(objectId, { constraints: list });
  return true;
}

/**
 * « Définir l'inverse » d'une contrainte Enfant de : fige la matrice monde inverse de la cible
 * à cet instant (16 nombres, ordre colonne), de sorte que l'objet ne saute pas quand la
 * contrainte s'applique. Renvoie false s'il n'y a pas de cible valide.
 */
export function setChildOfInverse(doc: SceneDoc, objectId: string, constraintId: string): boolean {
  const obj = doc.getObject(objectId);
  if (!obj) return false;
  const c = readConstraints(obj.constraints).find((k) => k.id === constraintId);
  if (!c || c.type !== 'child_of' || !c.target || !doc.getObject(c.target)) return false;
  const inv = worldMatrix(doc, c.target).invert();
  const inverse = inv.toArray().map((n) => (Number.isFinite(n) ? n : 0));
  return patchConstraintIn(doc, objectId, constraintId, { inverse });
}

export function clearChildOfInverse(doc: SceneDoc, objectId: string, constraintId: string): boolean {
  return patchConstraintIn(doc, objectId, constraintId, { inverse: null });
}

/** Distance monde entre les origines de deux objets, ou null si l'un d'eux n'existe pas. */
export function distanceBetween(doc: SceneDoc, a: string, b: string): number | null {
  if (!doc.getObject(a) || !doc.getObject(b)) return null;
  const pa = new Vector3().setFromMatrixPosition(worldMatrix(doc, a));
  const pb = new Vector3().setFromMatrixPosition(worldMatrix(doc, b));
  const d = pa.distanceTo(pb);
  return Number.isFinite(d) ? d : null;
}

// ------------------------------------------------------------------ collections

/** `candidate` est-elle la collection `ancestor` ou l'une de ses descendantes ? (protégé contre les cycles) */
export function isCollectionSelfOrDescendant(doc: SceneDoc, candidate: string, ancestor: string): boolean {
  let cur: string | null = candidate;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    if (cur === ancestor) return true;
    seen.add(cur);
    cur = doc.getCollection(cur)?.parent ?? null;
  }
  return false;
}
