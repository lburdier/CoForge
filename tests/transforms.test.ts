import { describe, expect, it } from 'vitest';
import { SceneDoc } from '../src/core/doc/SceneDoc';
import { setParent, worldMatrix } from '../src/core/doc/transforms';
import { Vector3 } from 'three';

function worldPos(doc: SceneDoc, id: string): number[] {
  const p = new Vector3().setFromMatrixPosition(worldMatrix(doc, id));
  return [p.x, p.y, p.z];
}

describe('transforms.setParent', () => {
  it('conserve la position monde en changeant de parent', () => {
    const doc = SceneDoc.createEmpty();
    const parent = doc.addObject({ type: 'empty', pos: [2, -1, 3], rot: [0.4, 0.9, -0.3], scl: [1.5, 0.5, 2] });
    const child = doc.addObject({ type: 'empty', pos: [0, 5, 0] });
    expect(setParent(doc, child, parent)).toBe(true);
    expect(doc.getObject(child)!.parent).toBe(parent);
    worldPos(doc, child).forEach((v, i) => expect(v).toBeCloseTo([0, 5, 0][i], 5));
    expect(setParent(doc, child, null)).toBe(true);
    worldPos(doc, child).forEach((v, i) => expect(v).toBeCloseTo([0, 5, 0][i], 5));
    expect(setParent(doc, parent, child)).toBe(true);
    expect(setParent(doc, child, parent)).toBe(false); // cycle refusé
  });
});