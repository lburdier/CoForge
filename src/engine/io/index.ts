/**
 * Import / export de CoForge (zone « engine-render ») :
 *  - `exportGLB`  : glTF binaire, Y vers le haut, matériaux PBR ;
 *  - `exportOBJ`  : Wavefront OBJ, polygones conservés ;
 *  - `importFile` : .glb / .gltf / .obj → objets, maillages soudés et matériaux du document.
 */
export type { BlendConverter, BlendEvalMesh, BlendEvalRequest, BlendEvalResult, BlendEvaluator, ExportItem } from './types';
export type { ApplyOptions, ImportResult, ImportedCollection, ImportedMesh, ImportedModifier, ImportedObject, ImportedScene } from './scene';
export { applyImportedScene, meshDataExact } from './scene';
export { exportGLB } from './gltf';
export { exportOBJ, parseOBJ } from './obj';
export { IMPORT_EXTENSIONS, detectFormat, importFile, importScene, readScene } from './importFile';
export type { ImportFormat, ImportOptions } from './importFile';
export { Y_UP_TO_Z_UP, Z_UP_TO_Y_UP, buildMeshData, convertTransform } from './convert';
