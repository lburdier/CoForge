import type { AppContext } from '../app/context';
import type { IViewport } from './api';
import { Viewport } from './Viewport';

export type { ElementHit, FinalRenderOptions, IViewport, SurfaceHit, ViewDirection } from './api';

/**
 * Fabrique du viewport 3D.
 *
 * Peut être appelée avant que `app.collab` et `app.ops` n'existent (c'est le
 * cas dans src/app/main.tsx) : le viewport ne s'y réfère qu'au montage.
 */
export function createViewport(app: AppContext): IViewport {
  return new Viewport(app);
}
