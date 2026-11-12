/**
 * Moteurs de rendu de CoForge (zone « engine-render ») :
 *  - `RenderPipeline` : images du viewport (direct, temps réel façon EEVEE, path tracing façon Cycles) ;
 *  - `renderFinalImage` : image finale hors écran, en PNG.
 */
export { RenderPipeline, type DirtyKind, type FrameMode } from './pipeline';
export { renderFinalImage, type FinalImageArgs } from './finalImage';
export { exposureOf, toneMappingOf } from './state';
export { pathTracingSupported } from './pathtracer';
