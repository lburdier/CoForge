import type { ArrayParams, BevelParams, BooleanParams, MeshData, MirrorParams, ModifierData, SolidifyParams, SubsurfParams } from '../../doc/schema';
import type { ModifierContext } from '../types';
import { arrayModifier } from './array';
import { bevelModifier } from './bevel';
import { booleanModifier } from './boolean';
import { mirrorModifier } from './mirror';
import { solidifyModifier } from './solidify';
import { subsurfModifier } from './subsurf';

export { arrayModifier, bevelModifier, booleanModifier, mirrorModifier, solidifyModifier, subsurfModifier };

/**
 * Applique UN modificateur (sans tenir compte de `enabled`). `salt` sert à dériver les identifiants
 * créés ; il doit être stable pour un même modificateur. Peut lever une exception sur entrée aberrante.
 */
export function applyModifier(mesh: MeshData, mod: ModifierData, ctx: ModifierContext, salt: string): MeshData {
  // Les paramètres viennent d'un document partagé : on complète par un objet vide si absents.
  const params = (mod.params ?? {}) as unknown;
  switch (mod.type) {
    case 'mirror':
      return mirrorModifier(mesh, params as MirrorParams, salt);
    case 'array':
      return arrayModifier(mesh, params as ArrayParams, salt);
    case 'bevel':
      return bevelModifier(mesh, params as BevelParams, salt);
    case 'subsurf':
      return subsurfModifier(mesh, params as SubsurfParams, salt);
    case 'solidify':
      return solidifyModifier(mesh, params as SolidifyParams, salt);
    case 'boolean':
      return booleanModifier(mesh, params as BooleanParams, ctx, salt);
    default:
      return mesh;
  }
}

/**
 * Maillage structurellement sain : positions finies, faces d'au moins 3 sommets distincts existants.
 * Renvoie le maillage lui-même s'il l'est déjà, sinon une copie nettoyée, ou null s'il est inutilisable.
 */
function sanitize(mesh: MeshData): MeshData | null {
  if (!(mesh?.verts instanceof Map) || !(mesh.faces instanceof Map)) return null;
  const badVerts = new Set<string>();
  for (const [id, p] of mesh.verts) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) badVerts.add(id);
  }
  const badFaces: string[] = [];
  for (const [fid, loop] of mesh.faces) {
    let ok = Array.isArray(loop) && loop.length >= 3 && new Set(loop).size === loop.length;
    if (ok) for (const v of loop) if (!mesh.verts.has(v) || badVerts.has(v)) ok = false;
    if (!ok) badFaces.push(fid);
  }
  if (badVerts.size === 0 && badFaces.length === 0) return mesh;
  const verts = new Map(mesh.verts);
  const faces = new Map(mesh.faces);
  for (const v of badVerts) verts.delete(v);
  for (const f of badFaces) faces.delete(f);
  return { verts, faces };
}

/**
 * CONTRAT — applique la pile de modificateurs activés, dans l'ordre. Renvoie le maillage d'entrée
 * lui-même si aucun modificateur actif ne le change. Ne lève jamais : un modificateur qui échoue
 * est ignoré ; les éléments invalides d'un résultat (position non finie, face dégénérée) sont écartés.
 * Les identifiants créés dérivent de l'identifiant du modificateur, de son rang dans la pile et des
 * identifiants d'entrée : ils sont déterministes.
 */
export function evaluateModifiers(mesh: MeshData, modifiers: ModifierData[], ctx: ModifierContext): MeshData {
  let cur = mesh;
  if (!Array.isArray(modifiers)) return cur;
  for (let i = 0; i < modifiers.length; i++) {
    const mod = modifiers[i];
    if (!mod || mod.enabled === false) continue;
    try {
      const next = applyModifier(cur, mod, ctx, `${mod.id}#${i}`);
      if (next === cur) continue;
      const clean = sanitize(next);
      if (clean) cur = clean;
    } catch {
      // modificateur ignoré : le maillage précédent est conservé
    }
  }
  return cur;
}
