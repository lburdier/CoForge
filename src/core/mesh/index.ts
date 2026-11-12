/**
 * Noyau de modélisation de CoForge — point d'entrée unique.
 * Fonctions pures : aucune ne modifie ses entrées, aucune ne dépend du DOM ni de Yjs.
 *
 * CONTRAT (src/core/mesh/types.ts) : `triangulate`, `evaluateModifiers`, `meshBounds`.
 */
export type * from './types';
export * from './topology';
export * from './triangulate';
export * from './select';
export * from './primitives';
export * from './ops';
export { evaluateModifiers, applyModifier, mirrorModifier, arrayModifier, bevelModifier, subsurfModifier, solidifyModifier, booleanModifier } from './modifiers';
