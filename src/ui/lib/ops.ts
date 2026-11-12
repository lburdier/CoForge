import { getApp } from '../../app/context';

/**
 * Lance un opérateur du registre. Si l'opérateur n'est pas (encore) enregistré,
 * `fallback` réalise l'équivalent purement local (bascule d'affichage,
 * changement d'outil…) pour que l'interface reste utilisable.
 * Renvoie true si quelque chose a été fait.
 */
export function runOp(id: string, args: Record<string, any> = {}, fallback?: () => void): boolean {
  const ops = getApp().ops;
  if (ops.get(id)) return ops.run(id, args);
  if (fallback) {
    fallback();
    return true;
  }
  return false;
}

/** L'opérateur est-il utilisable maintenant ? (true si absent mais doté d'un repli local) */
export function canRunOp(id: string, hasFallback = false): boolean {
  const ops = getApp().ops;
  if (ops.get(id)) return ops.canRun(id);
  return hasFallback;
}

/** Libellé d'un opérateur (ou son identifiant s'il n'est pas enregistré). */
export function opLabel(id: string): string {
  return getApp().ops.get(id)?.label ?? id;
}
