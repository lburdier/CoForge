import { newId } from '../../ids';
import type { MeshData } from '../../doc/schema';
import type { MeshOpResult } from '../types';

/** Générateur d'identifiants : aléatoire pour les opérations d'édition, déterministe pour les modificateurs. */
export type IdGen = () => string;

export const randomId: IdGen = () => newId(8);

/** Résultat « rien à faire » (delta vide, sélection inchangée). */
export function emptyResult(): MeshOpResult {
  return { delta: {} };
}

/** Faces existantes parmi une liste d'identifiants (ordre conservé, doublons retirés). */
export function existingFaces(mesh: MeshData, faceIds: Iterable<string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of faceIds) {
    const loop = mesh.faces.get(f);
    if (loop && loop.length >= 3) out.set(f, loop);
  }
  return out;
}

/** Sommets d'un ensemble de faces qui ne sont utilisés par aucune face restante du maillage. */
export function orphanVertsAfterRemoving(mesh: MeshData, removed: ReadonlySet<string>): string[] {
  const candidates = new Set<string>();
  for (const f of removed) for (const v of mesh.faces.get(f) ?? []) candidates.add(v);
  if (candidates.size === 0) return [];
  for (const [f, loop] of mesh.faces) {
    if (removed.has(f)) continue;
    for (const v of loop) candidates.delete(v);
    if (candidates.size === 0) break;
  }
  return [...candidates];
}

/** Retire les répétitions consécutives (cycliques) d'une boucle. */
export function dedupeLoop(loop: readonly string[]): string[] {
  const out: string[] = [];
  for (const v of loop) if (out.length === 0 || out[out.length - 1] !== v) out.push(v);
  while (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
  return out;
}

/** Une boucle est une face valide : au moins 3 sommets, tous distincts. */
export function isValidLoop(loop: readonly string[]): boolean {
  return loop.length >= 3 && new Set(loop).size === loop.length;
}
