import type { AppContext } from '../../app/context';
import type { OperatorDef } from '../api';
import { editOperators } from './editOps';
import { extrudeOperators } from './extrude';
import { modalOperators } from './modalOps';
import { selectOperators } from './selectOps';

/**
 * Opérateurs `mesh.*` du mode édition (objet actif de type maillage) : sélection, extrusion,
 * incrustation, biseau, coupe en boucle, subdivision, remplissage, pont, triangulation,
 * duplication, séparation, fusion, normales, suppression, dissolution, ajout de primitive.
 * `mesh.select_mode` et la sélection au clic / au rectangle sont enregistrés par les outils de base.
 */
export function meshOperators(): OperatorDef[] {
  return [...selectOperators(), ...extrudeOperators(), ...modalOperators(), ...editOperators()];
}

/** Enregistre tous les opérateurs `mesh.*` dans le registre de l'application. */
export function registerMeshOps(app: AppContext): void {
  app.ops.register(...meshOperators());
}
