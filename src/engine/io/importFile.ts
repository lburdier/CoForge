import type { SceneDoc } from '../../core/doc/SceneDoc';
import { applyImportedScene, type ApplyOptions, type ImportResult, type ImportedScene } from './scene';
import type { BlendConverter, BlendEvalResult, BlendEvaluator } from './types';
import type { BlendScene } from './blend';

export type ImportFormat = 'blend' | 'glb' | 'gltf' | 'fbx' | 'obj' | 'stl' | 'ply' | 'dae';

/** Extensions proposées dans la boîte « Importer ». */
export const IMPORT_EXTENSIONS: readonly string[] = ['blend', 'glb', 'gltf', 'fbx', 'obj', 'stl', 'ply', 'dae'];

export interface ImportOptions extends ApplyOptions {
  /**
   * Évaluation par un Blender installé (application Windows uniquement) des objets d'un .blend
   * que le lecteur natif ne sait pas reconstruire. Absent : ces objets sont importés au mieux
   * (ou comme vides) et signalés dans `warnings`.
   */
  evaluateBlend?: BlendEvaluator;
  /**
   * Repli quand le lecteur natif échoue sur un .blend (format trop récent, fichier atypique) :
   * conversion complète en .glb par un Blender installé. La scène est alors lue comme un glTF.
   */
  convertBlend?: BlendConverter;
}

export function detectFormat(name: string, data: ArrayBuffer): ImportFormat | null {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (/^blend\d*$/.test(ext)) return 'blend';
  if ((IMPORT_EXTENSIONS as string[]).includes(ext)) return ext as ImportFormat;
  // Sans extension reconnue : signatures binaires, puis JSON glTF ou texte OBJ.
  const head = new Uint8Array(data, 0, Math.min(16, data.byteLength));
  const ascii = String.fromCharCode(...head);
  if (ascii.startsWith('BLENDER')) return 'blend';
  if (head.length >= 4 && head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd) return 'blend'; // zstd
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'blend'; // gzip
  if (ascii.startsWith('glTF')) return 'glb';
  if (ascii.startsWith('Kaydara FBX')) return 'fbx';
  if (ascii.startsWith('ply')) return 'ply';
  const text = new TextDecoder().decode(new Uint8Array(data, 0, Math.min(512, data.byteLength))).trimStart();
  if (text.startsWith('{')) return 'gltf';
  if (text.startsWith('<?xml') || text.startsWith('<COLLADA')) return 'dae';
  if (/^solid\b/.test(text)) return 'stl';
  if (/^(#|v |o |g |mtllib )/m.test(text)) return 'obj';
  return null;
}

const text = (data: ArrayBuffer): string => new TextDecoder().decode(new Uint8Array(data));

/**
 * Lit un fichier et renvoie la scène au format neutre, sans rien écrire dans le document.
 * Formats : .blend (Blender 2.5 → 5.x, lecteur natif), .glb/.gltf, .fbx, .obj, .stl, .ply, .dae.
 */
export async function readScene(name: string, data: ArrayBuffer, options: ImportOptions = {}): Promise<ImportedScene> {
  const format = detectFormat(name, data);
  if (!format) throw new Error(`Format de fichier non pris en charge : ${name}`);
  try {
    switch (format) {
      case 'blend': {
        let scene: BlendScene;
        try {
          const { readBlendScene } = await import('./blend');
          scene = await readBlendScene(data);
        } catch (err) {
          // Lecteur natif en échec : si un Blender est installé, il convertit tout le fichier.
          const glb = options.convertBlend ? await options.convertBlend().catch(() => null) : null;
          if (!glb) throw err;
          const converted = await (await import('./gltfScene')).readGLTFScene(glb, name);
          const why = err instanceof Error ? err.message : String(err);
          converted.warnings.unshift(
            `Lecture directe impossible (${why}) : scène convertie par Blender. Modificateurs appliqués, collections non reprises.`,
          );
          return converted;
        }
        await resolvePending(scene, options.evaluateBlend);
        return scene;
      }
      case 'glb':
        return await (await import('./gltfScene')).readGLTFScene(data, name);
      case 'gltf':
        return await (await import('./gltfScene')).readGLTFScene(text(data), name);
      case 'obj':
        return await (await import('./objScene')).readOBJScene(text(data), name);
      default:
        return await (await import('./fbx')).readFBXScene(data, name);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(msg.includes(name) ? msg : `Lecture de « ${name} » impossible : ${msg}`);
  }
}

/**
 * Remplace, quand un Blender est disponible, les objets « en attente » d'un .blend par leur
 * maillage évalué (modificateurs appliqués). Ce qui reste en attente est signalé.
 */
async function resolvePending(scene: BlendScene, evaluate: BlendEvaluator | undefined): Promise<void> {
  const textured = scene.texturedMaterials ?? [];
  if (scene.pending.length === 0 && textured.length === 0) return;
  let result: BlendEvalResult | null = null;
  if (evaluate) {
    try {
      result = await evaluate({
        objects: [...new Set(scene.pending.map((p) => p.name))],
        materials: [...new Set(textured.map((t) => t.name))],
      });
    } catch {
      result = null;
    }
  }
  // Textures : CoForge n'en a pas ; la couleur moyenne de l'image remplace la couleur de base.
  if (textured.length > 0) {
    let averaged = 0;
    for (const t of textured) {
      const color = result?.materialColors?.[t.name];
      const mat = scene.materials[t.material];
      if (mat && typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) {
        mat.baseColor = color.toLowerCase();
        averaged++;
      }
    }
    const rest = textured.length - averaged;
    scene.warnings.push(
      `${textured.length} matériau(x) texturé(s) : CoForge n'affiche pas les textures image` +
        (averaged > 0 ? ` ; ${averaged} repris avec la couleur moyenne de leur texture` : '') +
        (rest > 0 ? ` ; ${rest} gardent la couleur de base du nœud` : '') +
        '.',
    );
    scene.texturedMaterials = [];
  }
  if (scene.pending.length === 0) return;
  const matByName = new Map<string, number>();
  scene.materials.forEach((m, i) => {
    if (!matByName.has(m.name)) matByName.set(m.name, i);
  });
  const meshByName = new Map<string, number>();
  const left = new Map<string, number>();
  const empty = new Map<string, number>();
  let done = 0;
  for (const p of scene.pending) {
    const ev = result?.meshes[p.name];
    const obj = scene.objects[p.object];
    if (obj && (result?.empty?.includes(p.name) || (ev && ev.polygons.length === 0))) {
      // Blender l'a bien évalué, mais sans aucune face (volume, nuage de points, nœuds vides…).
      empty.set(p.reason, (empty.get(p.reason) ?? 0) + 1);
      continue;
    }
    if (!ev || !obj) {
      left.set(p.reason, (left.get(p.reason) ?? 0) + 1);
      continue;
    }
    let mi = meshByName.get(p.name);
    if (mi === undefined) {
      mi = scene.meshes.length;
      scene.meshes.push({ name: p.name, positions: ev.positions, polygons: ev.polygons, polygonSlots: ev.slots, weld: false });
      meshByName.set(p.name, mi);
    }
    obj.type = 'mesh';
    obj.mesh = mi;
    obj.modifiers = [];
    obj.shadeSmooth = !!ev.smooth;
    if (ev.materials) obj.materials = ev.materials.map((n) => (n !== null && matByName.has(n) ? matByName.get(n)! : null));
    done++;
  }
  if (done > 0) {
    const v = result?.blenderVersion ? ` ${result.blenderVersion}` : '';
    scene.warnings.push(`${done} objet(s) évalué(s) par Blender${v} (géométrie finale, modificateurs appliqués).`);
  }
  if (empty.size > 0) {
    const detail = [...empty.entries()].map(([reason, n]) => `${n} × ${reason}`).join(', ');
    scene.warnings.push(`Sans aucune face, même évalué par Blender (repris comme vide) : ${detail}.`);
  }
  if (left.size > 0) {
    const detail = [...left.entries()].map(([reason, n]) => `${n} × ${reason}`).join(', ');
    scene.warnings.push(
      evaluate
        ? `Non évalué par Blender : ${detail}.`
        : `Importé sans évaluation (aucun Blender disponible) : ${detail}. Dans l'application Windows avec Blender installé, ces objets sont repris avec leur géométrie finale.`,
    );
  }
  scene.pending = [];
}

/**
 * Importe un fichier dans le document : objets (hiérarchie, transformations), maillages,
 * lumières, caméras, matériaux, collections et modificateurs pris en charge. Une seule
 * transaction. Voir `ImportOptions` pour le mode « ouvrir » et l'évaluation par Blender.
 */
export async function importScene(doc: SceneDoc, name: string, data: ArrayBuffer, options: ImportOptions = {}): Promise<ImportResult> {
  const scene = await readScene(name, data, options);
  if (scene.objects.length === 0) throw new Error(`Le fichier ${name} ne contient aucun objet`);
  doc.beginOp();
  try {
    return applyImportedScene(doc, scene, options);
  } finally {
    doc.endOp();
  }
}

/** Forme historique : importe et renvoie seulement les objets créés. */
export async function importFile(doc: SceneDoc, name: string, data: ArrayBuffer): Promise<string[]> {
  return (await importScene(doc, name, data)).objectIds;
}
