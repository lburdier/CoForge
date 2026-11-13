import { describe, expect, it } from 'vitest';
import { GeometryPool } from '../src/engine/geometryPool';
import type { RenderMesh } from '../src/core/mesh/types';

/** Un triangle (positions décalées de `dx`) : assez pour exercer le remplacement sur place. */
function tri(dx: number): RenderMesh {
  return {
    positions: new Float32Array([dx, 0, 0, dx + 1, 0, 0, dx, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    triFace: ['f'],
    edgePositions: new Float32Array([dx, 0, 0, dx + 1, 0, 0]),
    edgeKeys: ['e'],
  };
}

describe('contour de sélection : coque partagée avec la surface', () => {
  it('ne libère jamais la coque lors d’un déplacement de sommets (sinon la surface reste figée sur le GPU)', () => {
    const pool = new GeometryPool();
    const entry = pool.acquire(tri(0));
    const hull = pool.hull(entry);
    // La coque partage le tampon de positions de la surface.
    expect(hull.getAttribute('position')).toBe(entry.surface.getAttribute('position'));
    let disposed = 0;
    hull.addEventListener('dispose', () => disposed++);
    entry.surface.addEventListener('dispose', () => disposed++);

    const moved = pool.replaceInPlace(entry, tri(5));
    expect(moved).toBe(entry);
    expect(disposed).toBe(0);
    // Même coque, positions et volumes à jour.
    const again = pool.hull(entry);
    expect(again).toBe(hull);
    expect(again.getAttribute('position').getX(0)).toBe(5);
    expect(again.boundingBox?.min.x).toBe(5);
  });

  it('libère la coque avec la surface quand la géométrie disparaît', () => {
    const pool = new GeometryPool();
    const entry = pool.acquire(tri(0));
    const hull = pool.hull(entry);
    let disposed = 0;
    hull.addEventListener('dispose', () => disposed++);
    pool.release(entry);
    expect(disposed).toBe(1);
  });
});
