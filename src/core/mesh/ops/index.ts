/**
 * Opérations d'édition polygonale (fonctions pures) : point d'entrée unique.
 * Convention : `(mesh, ..., idGen = randomId) => MeshOpResult` (delta + sélection résultante).
 */
export * from './common';
export * from './extrude';
export * from './inset';
export * from './bevel';
export * from './loopcut';
export * from './subdivide';
export * from './fill';
export * from './basic';
export * from './merge';
export * from './delete';
