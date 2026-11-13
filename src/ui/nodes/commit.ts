import { getApp } from '../../app/context';
import type { SceneDoc } from '../../core/doc/SceneDoc';
import type { MaterialData, NodeTreeData } from '../../core/doc/schema';
import { defaultShaderTree, materialFallback } from '../../core/nodes/shaderCompile';
import { cloneTree, type Tree } from './treeOps';

/**
 * Écritures des arbres de nœuds dans le document, partagées par l'éditeur de nœuds et l'onglet
 * Matériau des propriétés : une modification = une étape d'annulation, et les champs simples du
 * matériau (repli du path tracer, de l'export, de la liste des matériaux) suivent l'arbre.
 */

/** Recalcule les champs simples du matériau quand son arbre change. */
export function syncFallback(doc: SceneDoc, materialId: string | null, tree: NodeTreeData): void {
  if (!materialId) return;
  const mat = doc.getMaterial(materialId);
  if (!mat) return;
  const fb = materialFallback(tree);
  const patch: Partial<MaterialData> = {};
  for (const [k, v] of Object.entries(fb) as [keyof typeof fb, number | string][]) {
    const cur = mat[k];
    if (typeof v === 'number' ? Math.abs((cur as number) - v) > 1e-6 : cur !== v) (patch as Record<string, unknown>)[k] = v;
  }
  if (Object.keys(patch).length) doc.updateMaterial(materialId, patch);
}

/** Modifie un arbre (sur une copie) puis l'écrit en une étape d'annulation ; `fn` renvoie false pour renoncer. */
export function commitTree(treeId: string, materialId: string | null, fn: (t: Tree) => boolean | void): boolean {
  const doc = getApp().doc;
  const cur = doc.getNodeTree(treeId);
  if (!cur) return false;
  const t = cloneTree(cur);
  if (fn(t) === false) return false;
  doc.beginOp();
  try {
    doc.transact(() => {
      doc.updateNodeTree(treeId, { nodes: t.nodes, links: t.links });
      syncFallback(doc, materialId, { ...cur, nodes: t.nodes, links: t.links });
    });
  } finally {
    doc.endOp();
  }
  return true;
}

/** « Utiliser les nœuds » : crée l'arbre (Principled → Sortie, repris des champs simples) ou bascule l'état. */
export function toggleUseNodes(materialId: string): void {
  const doc = getApp().doc;
  const mat = doc.getMaterial(materialId);
  if (!mat) return;
  doc.beginOp();
  try {
    doc.transact(() => {
      if (mat.nodeTree && doc.getNodeTree(mat.nodeTree)) {
        doc.updateMaterial(mat.id, { useNodes: mat.useNodes === false });
      } else {
        const t = defaultShaderTree(mat);
        const tid = doc.addNodeTree({ kind: 'shader', name: mat.name, ...t });
        doc.updateMaterial(mat.id, { nodeTree: tid, useNodes: true });
      }
    });
  } finally {
    doc.endOp();
  }
}

/** Nouveau matériau à nœuds affecté à un objet. */
export function createNodeMaterial(objectId: string): void {
  const doc = getApp().doc;
  doc.beginOp();
  try {
    doc.transact(() => {
      const t = defaultShaderTree();
      const tid = doc.addNodeTree({ kind: 'shader', name: 'Matériau', ...t });
      const mid = doc.addMaterial({ name: 'Matériau', nodeTree: tid, useNodes: true, ...materialFallback({ id: tid, name: '', kind: 'shader', ...t }) });
      doc.updateObject(objectId, { material: mid });
    });
  } finally {
    doc.endOp();
  }
}
