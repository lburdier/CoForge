import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { SceneDoc } from './SceneDoc';
import type { ObjectData, Vec3 } from './schema';

/** Matrice locale (TRS, Euler XYZ) d'un objet. */
export function localMatrix(obj: Pick<ObjectData, 'pos' | 'rot' | 'scl'>, out = new Matrix4()): Matrix4 {
  const q = new Quaternion().setFromEuler(new Euler(obj.rot[0], obj.rot[1], obj.rot[2], 'XYZ'));
  return out.compose(new Vector3(...obj.pos), q, new Vector3(...obj.scl));
}

/** Matrice monde d'un objet, en remontant la hiérarchie (sans cycle grâce à effectiveParent). */
export function worldMatrix(doc: SceneDoc, id: string, out = new Matrix4()): Matrix4 {
  out.identity();
  const chain: ObjectData[] = [];
  let cur: string | null = id;
  for (let depth = 0; cur && depth < 256; depth++) {
    const o = doc.getObject(cur);
    if (!o) break;
    chain.push(o);
    cur = doc.effectiveParent(cur);
  }
  const tmp = new Matrix4();
  for (let i = chain.length - 1; i >= 0; i--) out.multiply(localMatrix(chain[i], tmp));
  return out;
}

/** Décompose une matrice en pos/rot/scl au format du document. */
export function decompose(m: Matrix4): { pos: Vec3; rot: Vec3; scl: Vec3 } {
  const p = new Vector3();
  const q = new Quaternion();
  const s = new Vector3();
  m.decompose(p, q, s);
  const e = new Euler().setFromQuaternion(q, 'XYZ');
  return { pos: [p.x, p.y, p.z], rot: [e.x, e.y, e.z], scl: [s.x, s.y, s.z] };
}

/** Écrit la transformation locale d'un objet de sorte que sa matrice MONDE soit `world`. */
export function setWorldMatrix(doc: SceneDoc, id: string, world: Matrix4): void {
  const parent = doc.effectiveParent(id);
  const local = parent ? worldMatrix(doc, parent).invert().multiply(world) : world.clone();
  doc.updateObject(id, decompose(local));
}

/** Change le parent d'un objet ; `keepWorld` conserve sa position/rotation/échelle monde. Refuse de créer un cycle. */
export function setParent(doc: SceneDoc, id: string, parent: string | null, keepWorld = true): boolean {
  if (parent === id) return false;
  // refuse si `id` est un ancêtre de `parent`
  let cur: string | null = parent;
  for (let depth = 0; cur && depth < 256; depth++) {
    if (cur === id) return false;
    cur = doc.effectiveParent(cur);
  }
  // Toutes les matrices sont calculées AVANT d'écrire : dans une transaction, le cache de lecture
  // de SceneDoc n'est vidé qu'à la fin, relire l'objet donnerait encore l'ancien parent.
  let patch: Partial<ObjectData> = { parent };
  if (keepWorld) {
    const world = worldMatrix(doc, id);
    const local = parent ? worldMatrix(doc, parent).invert().multiply(world) : world;
    patch = { parent, ...decompose(local) };
  }
  doc.transact(() => doc.updateObject(id, patch));
  return true;
}
