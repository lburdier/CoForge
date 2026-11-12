import { LoadingManager, Matrix4, Mesh, Texture, type BufferGeometry, type Object3D } from 'three';
import { LIGHT_DEFAULTS, type LightKind } from '../../core/doc/schema';
import { Y_UP_TO_Z_UP, baseName, hasSmoothNormals } from './convert';
import type { ImportedScene } from './scene';
import { sceneFromThree } from './threeScene';

/**
 * Lecteurs FBX, STL, PLY et Collada (.dae) vers le format neutre `ImportedScene`.
 *
 * FBX (binaire et ASCII 7.x), STL (binaire et ASCII) et Collada passent par les chargeurs de
 * three.js, importés à la demande, puis par le convertisseur commun `sceneFromThree`. Le PLY est
 * lu ici directement : PLYLoader triangule les quads et écarte sans le dire les faces de plus de
 * quatre côtés, alors que l'export PLY de Blender écrit des n-gones.
 *
 * FBX : ce que fait déjà FBXLoader (three 0.187) et ce qui est fait ici, sans double conversion :
 *  - axe vertical : le chargeur ramène un fichier Z-up (UpAxis = 2) en Y-up par une rotation de
 *    la racine ; son résultat est donc toujours Y-up, et une seule rotation Y-up → Z-up est
 *    appliquée ici aux matrices monde (les sommets locaux restent ceux du fichier, comme le fait
 *    l'import FBX de Blender) ;
 *  - unités : le chargeur ne convertit rien et expose `UnitScaleFactor` (centimètres par unité)
 *    dans `userData` ; l'échelle UnitScaleFactor / 100 (→ mètres) est appliquée ici à la racine ;
 *  - lumières et caméras : en FBX une lumière vise −Y local et une caméra +X local ; le chargeur
 *    ne corrige pas. Rotations appliquées ici (celles de Blender) pour retrouver la visée −Z ;
 *  - position des spots et des soleils : `SpotLight` et `DirectionalLight` naissent en (0, 1, 0)
 *    et le chargeur applique la transformation du fichier par-dessus, ce qui les décale d'une
 *    unité le long de leur +Y local ; ce décalage est retiré ici ;
 *  - puissance des lumières : watts = Intensity / 100 (règle de Blender ; le chargeur a déjà
 *    divisé par 100) ; cône d'un spot : OuterAngle est l'angle complet (le chargeur le range
 *    dans un demi-angle), adoucissement = 1 − InnerAngle / OuterAngle ;
 *  - couleurs : le chargeur les lit comme du sRGB (usage de la plupart des logiciels). Blender,
 *    lui, écrit et relit des valeurs linéaires : pour un fichier dont l'en-tête nomme Blender
 *    comme créateur, les valeurs brutes sont reprises comme linéaires (aller-retour exact) ;
 *  - plans de coupe des caméras : le chargeur divise NearPlane / FarPlane par 1000 ; la valeur du
 *    fichier (en unités du fichier) est rétablie puis convertie en mètres ;
 *  - champ de vision : calculé par le chargeur depuis la focale avec une pellicule de 35 mm, sans
 *    lire FilmWidth / FilmHeight : approché à quelques pour cent près (capteur de 36 mm : −3 %) ;
 *  - caméras orthographiques : non gérées par le chargeur, importées comme vides (signalé).
 *
 * SOUS NODE (tests, sans DOM) : FBX, STL et PLY fonctionnent. FBXLoader lit `window.innerWidth`
 * pour chaque caméra et crée des URL d'objet pour les images intégrées : un `window` minimal et un
 * `URL.createObjectURL` inerte sont posés le temps de l'analyse (synchrone) puis retirés. Les
 * textures ne sont jamais chargées (gestionnaire de chargement inerte), dans le navigateur non plus.
 * Collada exige `DOMParser` : hors navigateur / Electron, l'import .dae échoue avec un message clair.
 */

type Format = 'fbx' | 'stl' | 'ply' | 'dae';

function plural(n: number, one: string, many: string): string {
  return `${n} ${n > 1 ? many : one}`;
}

function toBuffer(data: ArrayBuffer | string): ArrayBuffer {
  if (typeof data !== 'string') return data;
  const u = new TextEncoder().encode(data);
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

function toText(data: ArrayBuffer | string): string {
  return typeof data === 'string' ? data : new TextDecoder().decode(new Uint8Array(data));
}

function headText(data: ArrayBuffer | string, length: number): string {
  if (typeof data === 'string') return data.slice(0, length);
  // latin1 : un octet = un caractère, quel que soit le contenu.
  return String.fromCharCode(...new Uint8Array(data, 0, Math.min(length, data.byteLength)));
}

/** Format d'après l'extension de `name`, sinon d'après la signature du contenu. */
function sniffFormat(data: ArrayBuffer | string, name: string): Format {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (ext === 'fbx' || ext === 'stl' || ext === 'ply' || ext === 'dae') return ext;
  const head = headText(data, 512).replace(/^﻿/, '');
  const trimmed = head.trimStart();
  if (head.startsWith('Kaydara FBX') || /^;\s*FBX/.test(trimmed)) return 'fbx';
  if (/^ply\r?\n/.test(head)) return 'ply';
  if (trimmed.startsWith('<?xml') || trimmed.startsWith('<COLLADA')) return 'dae';
  if (/^solid\b/.test(trimmed)) return 'stl';
  if (typeof data !== 'string' && data.byteLength >= 84) {
    // STL binaire : 80 octets d'en-tête, nombre de triangles, 50 octets par triangle.
    const count = new DataView(data).getUint32(80, true);
    if (84 + count * 50 === data.byteLength) return 'stl';
  }
  return 'fbx';
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Chargeur de textures inerte : CoForge n'affiche pas les textures, on ne déclenche donc ni
 * requête réseau ni décodage d'image (et rien qui exige le DOM).
 */
function inertManager(): LoadingManager {
  const manager = new LoadingManager();
  const loader = {
    path: '',
    setPath(): unknown {
      return loader;
    },
    load(): Texture {
      return new Texture();
    },
  };
  manager.addHandler(/^/, loader as any);
  // Pour les chargeurs qui n'interrogent pas les gestionnaires (Collada) : image d'un pixel, sans réseau.
  manager.setURLModifier(() => 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==');
  return manager;
}

/**
 * Exécute l'analyse (synchrone) d'un chargeur de three.js dans un environnement neutre :
 *  - `window` minimal s'il est absent (FBXLoader lit window.innerWidth pour toute caméra) ;
 *  - `URL.createObjectURL` inerte (FBXLoader crée une URL par image intégrée, jamais libérée) ;
 *  - avertissements du chargeur interceptés : renvoyés à l'appelant plutôt qu'en console.
 * Tout est rétabli à la sortie, même en cas d'exception.
 */
function withLoaderEnvironment<T>(run: () => T): { result: T; messages: string[] } {
  const g = globalThis as any;
  const messages: string[] = [];
  const hadWindow = typeof g.window !== 'undefined';
  const originalWarn = console.warn;
  const originalCreate: unknown = typeof URL !== 'undefined' ? URL.createObjectURL : undefined;
  if (!hadWindow) g.window = { innerWidth: 16, innerHeight: 9 };
  console.warn = (...args: unknown[]) => {
    messages.push(args.map((a) => String(a)).join(' '));
  };
  if (typeof URL !== 'undefined') (URL as any).createObjectURL = () => 'blob:coforge-inerte';
  try {
    return { result: run(), messages };
  } finally {
    console.warn = originalWarn;
    if (typeof URL !== 'undefined') (URL as any).createObjectURL = originalCreate;
    if (!hadWindow) delete g.window;
  }
}

// ------------------------------------------------------------------ FBX

/** Lumière : Blender −Z, FBX −Y. Caméra : Blender −Z, FBX +X (voir fbx_utils.py de Blender). */
const FBX_LIGHT_FIX = new Matrix4().makeRotationX(-Math.PI / 2);
const FBX_CAMERA_FIX = new Matrix4().makeRotationY(-Math.PI / 2);
/** Spots et soleils : retrait du décalage (0, 1, 0) hérité du constructeur de three.js, puis visée. */
const FBX_AIMED_LIGHT_FIX = new Matrix4().makeTranslation(0, -1, 0).multiply(FBX_LIGHT_FIX);

async function readFBX(data: ArrayBuffer | string, name: string): Promise<ImportedScene> {
  const buffer = toBuffer(data);
  if (buffer.byteLength === 0) throw new Error('Fichier FBX vide.');
  const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
  let root: Object3D;
  let messages: string[];
  try {
    const loader = new FBXLoader(inertManager());
    ({ result: root, messages } = withLoaderEnvironment(() => loader.parse(buffer, '') as Object3D));
  } catch (err) {
    const msg = messageOf(err);
    const version = msg.match(/FileVersion:\s*(\d+)/);
    if (version) {
      throw new Error(
        `FBX ASCII version ${version[1]} non pris en charge (antérieur à 7.0) : réexportez le fichier en FBX 2011 (7.1) ou plus récent, ou en binaire.`,
      );
    }
    if (/Unknown format|Cannot find the version/i.test(msg)) throw new Error("Ce fichier n'est pas un FBX reconnu (ni binaire, ni ASCII 7.x).");
    throw new Error(`Fichier FBX illisible (tronqué ou corrompu) : ${msg}`);
  }
  if (!root || !(root as any).isObject3D) throw new Error('Fichier FBX illisible : aucune scène produite.');

  // Centimètres par unité du fichier (1 par défaut : le centimètre est l'unité native du FBX).
  const declared = (root.userData as any)?.unitScaleFactor;
  const unitScaleFactor = typeof declared === 'number' && Number.isFinite(declared) && declared > 0 ? declared : 1;
  const metersPerUnit = unitScaleFactor / 100;
  const rootTransform = new Matrix4().makeScale(metersPerUnit, metersPerUnit, metersPerUnit).premultiply(Y_UP_TO_Z_UP);

  const scene = sceneFromThree(root, {
    name: baseName(name, 'FBX'),
    rootTransform,
    // La racine synthétique du chargeur n'a pas de nom ; s'il l'a remplacée par l'unique modèle
    // racine du fichier, c'est un objet à part entière.
    includeRoot: typeof root.name === 'string' && root.name.trim() !== '',
    lightFix: (light) => ((light as any).isSpotLight || (light as any).isDirectionalLight ? FBX_AIMED_LIGHT_FIX : FBX_LIGHT_FIX),
    cameraFix: () => FBX_CAMERA_FIX,
    spotFullAngle: true,
    // Le créateur figure en clair au début du fichier (FBXHeaderExtension), binaire comme ASCII.
    rawColorsLinear: /Blender/.test(headText(buffer, 4096)),
    lightPower: (intensity) => intensity,
    cameraRange: (near, far) => [near * 1000 * metersPerUnit, far * 1000 * metersPerUnit],
    lengthScale: metersPerUnit,
  });

  const ortho = messages.filter((m) => /Orthographic cameras not supported/i.test(m)).length;
  if (ortho > 0) {
    scene.warnings.push(
      `${plural(ortho, 'caméra orthographique importée comme vide', 'caméras orthographiques importées comme vides')} (non gérées par le lecteur FBX).`,
    );
  }
  if (scene.objects.some((o) => o.type === 'camera')) {
    scene.warnings.push('Caméras FBX : champ de vision recalculé depuis la focale pour une pellicule de 35 mm (approché à quelques pour cent).');
  }
  if (scene.meshes.length > 0) scene.warnings.push('FBX : polygones importés triangulés (quads et n-gones non reconstitués).');
  return scene;
}

// ------------------------------------------------------------------ STL

const NO_AXIS_WARNING = (format: string): string =>
  `${format} : le format ne déclare ni unité ni axe vertical ; coordonnées reprises telles quelles (Z vers le haut, mètres).`;

async function readSTL(data: ArrayBuffer | string, name: string): Promise<ImportedScene> {
  const buffer = toBuffer(data);
  if (buffer.byteLength === 0) throw new Error('Fichier STL vide.');
  const ascii = /^\s*solid\b/.test(headText(buffer, 256).replace(/^﻿/, ''));
  if (!ascii && buffer.byteLength < 84) throw new Error('Fichier STL tronqué (en-tête incomplet).');
  // STLLoader lit l'en-tête binaire même pour un ASCII très court : un solide sans facette s'arrête ici.
  if (ascii && !/\bfacet\b/.test(new TextDecoder().decode(new Uint8Array(buffer)))) {
    throw new Error('Le fichier STL ne contient aucun triangle exploitable.');
  }
  const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
  let geometry: BufferGeometry;
  try {
    geometry = new STLLoader().parse(buffer);
  } catch (err) {
    throw new Error(`Fichier STL illisible (tronqué ou corrompu) : ${messageOf(err)}`);
  }
  const label = baseName(name, 'STL');
  // Un STL ASCII à plusieurs solides arrive avec un groupe par solide : ce ne sont pas des matériaux.
  geometry.clearGroups();
  geometry.name = label;
  const mesh = new Mesh(geometry);
  mesh.name = label;
  const scene = sceneFromThree(mesh, { name: label, includeRoot: true, materials: false });
  geometry.dispose();
  if (scene.meshes.length === 0) throw new Error('Le fichier STL ne contient aucun triangle exploitable.');
  // Le STL ne porte que des normales de facettes : ombrage plat.
  for (const o of scene.objects) o.shadeSmooth = false;
  scene.warnings.push(NO_AXIS_WARNING('STL'));
  return scene;
}

// ------------------------------------------------------------------ PLY

const PLY_TYPES: Record<string, { size: number; read: (dv: DataView, at: number, le: boolean) => number }> = {};
{
  const def = (names: string[], size: number, read: (dv: DataView, at: number, le: boolean) => number): void => {
    for (const n of names) PLY_TYPES[n] = { size, read };
  };
  def(['char', 'int8'], 1, (dv, at) => dv.getInt8(at));
  def(['uchar', 'uint8'], 1, (dv, at) => dv.getUint8(at));
  def(['short', 'int16'], 2, (dv, at, le) => dv.getInt16(at, le));
  def(['ushort', 'uint16'], 2, (dv, at, le) => dv.getUint16(at, le));
  def(['int', 'int32'], 4, (dv, at, le) => dv.getInt32(at, le));
  def(['uint', 'uint32'], 4, (dv, at, le) => dv.getUint32(at, le));
  def(['float', 'float32'], 4, (dv, at, le) => dv.getFloat32(at, le));
  def(['double', 'float64'], 8, (dv, at, le) => dv.getFloat64(at, le));
}

interface PlyProperty {
  name: string;
  type: string;
  /** Type du compteur pour une propriété liste, sinon null. */
  countType: string | null;
}

interface PlyElement {
  name: string;
  count: number;
  properties: PlyProperty[];
}

/**
 * Lecture d'un PLY (ASCII, binaire petit ou gros boutiste) : sommets x, y, z, normales nx, ny, nz
 * si présentes, faces `vertex_indices` / `vertex_index` avec leurs polygones d'origine.
 */
async function readPLY(data: ArrayBuffer | string, name: string): Promise<ImportedScene> {
  const buffer = toBuffer(data);
  const bytes = new Uint8Array(buffer);
  if (bytes.length === 0) throw new Error('Fichier PLY vide.');

  if (!(bytes[0] === 0x70 && bytes[1] === 0x6c && bytes[2] === 0x79)) throw new Error("Ce fichier n'est pas un PLY (signature « ply » absente).");

  // En-tête : texte jusqu'à la ligne « end_header ».
  let headerEnd = -1;
  let lineStart = 0;
  const lines: string[] = [];
  const limit = Math.min(bytes.length, 1 << 20);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] !== 0x0a) continue;
    if (i - lineStart > 4096) break; // pas une ligne d'en-tête
    const line = String.fromCharCode(...bytes.subarray(lineStart, i)).replace(/\r$/, '').trim();
    lineStart = i + 1;
    lines.push(line);
    if (line === 'end_header') {
      headerEnd = i + 1;
      break;
    }
  }
  if (lines[0] !== 'ply') throw new Error("Ce fichier n'est pas un PLY (signature « ply » absente).");
  if (headerEnd < 0) throw new Error('Fichier PLY tronqué (en-tête incomplet).');

  let format = '';
  const elements: PlyElement[] = [];
  for (const line of lines) {
    const t = line.split(/\s+/);
    if (t[0] === 'format') format = t[1] ?? '';
    else if (t[0] === 'element') elements.push({ name: t[1] ?? '', count: Math.max(0, parseInt(t[2] ?? '0', 10) || 0), properties: [] });
    else if (t[0] === 'property' && elements.length > 0) {
      const el = elements[elements.length - 1];
      if (t[1] === 'list') el.properties.push({ name: t[4] ?? '', type: t[3] ?? '', countType: t[2] ?? '' });
      else el.properties.push({ name: t[2] ?? '', type: t[1] ?? '', countType: null });
    }
  }
  const binary = format === 'binary_little_endian' || format === 'binary_big_endian';
  if (!binary && format !== 'ascii') throw new Error(`Format PLY inconnu : « ${format || '?'} ».`);
  for (const el of elements) {
    for (const p of el.properties) {
      if (!PLY_TYPES[p.type] || (p.countType !== null && !PLY_TYPES[p.countType])) throw new Error(`Type de donnée PLY inconnu : « ${p.type} ».`);
    }
  }

  const vertexElement = elements.find((e) => e.name === 'vertex');
  if (!vertexElement) throw new Error('Le fichier PLY ne contient aucun sommet.');
  const positions = new Float64Array(vertexElement.count * 3);
  const hasNormals = ['nx', 'ny', 'nz'].every((n) => vertexElement.properties.some((p) => p.name === n));
  const normals = hasNormals ? new Float64Array(vertexElement.count * 3) : null;
  const polygons: number[][] = [];
  let strips = false;

  // Rangement d'une valeur lue, selon l'élément et la propriété.
  const store = (el: PlyElement, row: number, prop: PlyProperty, value: number | number[]): void => {
    if (el === vertexElement && typeof value === 'number') {
      const axis = prop.name === 'x' ? 0 : prop.name === 'y' ? 1 : prop.name === 'z' ? 2 : -1;
      if (axis >= 0) positions[row * 3 + axis] = value;
      else if (normals) {
        const n = prop.name === 'nx' ? 0 : prop.name === 'ny' ? 1 : prop.name === 'nz' ? 2 : -1;
        if (n >= 0) normals[row * 3 + n] = value;
      }
    } else if (el.name === 'face' && Array.isArray(value) && (prop.name === 'vertex_indices' || prop.name === 'vertex_index')) {
      if (value.length >= 3) polygons.push(value);
    } else if (el.name === 'tristrips') strips = true;
  };

  const truncated = (): never => {
    throw new Error('Fichier PLY tronqué (données incomplètes).');
  };

  if (binary) {
    const le = format === 'binary_little_endian';
    const dv = new DataView(buffer, 0, bytes.length);
    let at = headerEnd;
    for (const el of elements) {
      for (let row = 0; row < el.count; row++) {
        for (const prop of el.properties) {
          const type = PLY_TYPES[prop.type];
          if (prop.countType === null) {
            if (at + type.size > bytes.length) truncated();
            store(el, row, prop, type.read(dv, at, le));
            at += type.size;
          } else {
            const countType = PLY_TYPES[prop.countType];
            if (at + countType.size > bytes.length) truncated();
            const n = countType.read(dv, at, le);
            at += countType.size;
            if (!(n >= 0) || at + n * type.size > bytes.length) truncated();
            const list = new Array<number>(n);
            for (let k = 0; k < n; k++) list[k] = type.read(dv, at + k * type.size, le);
            at += n * type.size;
            store(el, row, prop, list);
          }
        }
      }
    }
  } else {
    // ASCII : flux de jetons séparés par des blancs.
    const body = new TextDecoder().decode(bytes.subarray(headerEnd));
    const tokens = /\S+/g;
    const next = (): number => {
      const m = tokens.exec(body);
      if (!m) truncated();
      return parseFloat(m![0]);
    };
    for (const el of elements) {
      for (let row = 0; row < el.count; row++) {
        for (const prop of el.properties) {
          if (prop.countType === null) store(el, row, prop, next());
          else {
            const n = next();
            if (!(n >= 0) || n > 1e7) truncated();
            const list = new Array<number>(n);
            for (let k = 0; k < n; k++) list[k] = next();
            store(el, row, prop, list);
          }
        }
      }
    }
  }

  const label = baseName(name, 'PLY');
  const warnings: string[] = [];
  if (strips) warnings.push('Bandes de triangles PLY (tristrips) non reprises.');
  if (polygons.length === 0) {
    throw new Error(
      vertexElement.count > 0 ? 'Le fichier PLY est un nuage de points (aucune face) : rien à importer.' : 'Le fichier PLY ne contient aucune géométrie.',
    );
  }
  warnings.push(NO_AXIS_WARNING('PLY'));
  return {
    name: label,
    objects: [
      {
        name: label,
        type: 'mesh',
        parent: null,
        matrixWorld: new Matrix4(),
        collection: null,
        mesh: 0,
        shadeSmooth: normals ? hasSmoothNormals(positions, normals, polygons) : false,
      },
    ],
    meshes: [{ name: label, positions, polygons, weld: true }],
    materials: [],
    collections: [],
    warnings,
  };
}

// ------------------------------------------------------------------ Collada

/**
 * Puissance d'une lumière Collada. Le format ne porte pas d'unité photométrique ; Blender (qui a
 * écrit l'essentiel des .dae) y multiplie la couleur par l'énergie en watts : une intensité
 * totale supérieure à 1 est donc reprise telle quelle en watts. Sinon (simple couleur 0..1) la
 * lumière reçoit la puissance par défaut de CoForge, pondérée par cette intensité.
 */
function colladaLightPower(intensity: number, kind: LightKind): number {
  if (intensity > 1 || kind === 'sun') return intensity;
  return intensity * LIGHT_DEFAULTS.power;
}

/**
 * Un nœud Collada qui porte une géométrie ET des nœuds enfants devient, dans ColladaLoader, un
 * groupe contenant un maillage anonyme (transformation identité) à côté des enfants. On remet le
 * maillage à la place du groupe pour retrouver la hiérarchie du fichier (« Plan » maillage parent
 * d'« Enfant », et non un vide « Plan » avec un maillage « Objet »).
 */
function foldColladaGroups(root: Object3D): void {
  const groups: Object3D[] = [];
  root.traverse((o) => {
    if (o !== root && (o as { isGroup?: boolean }).isGroup) groups.push(o);
  });
  for (const group of groups) {
    const meshes = group.children.filter((c) => (c as Mesh).isMesh && c.children.length === 0 && c.name === '' && isIdentity(c));
    if (meshes.length !== 1 || !group.parent) continue;
    const mesh = meshes[0] as Mesh;
    group.remove(mesh);
    mesh.name = group.name;
    mesh.position.copy(group.position);
    mesh.quaternion.copy(group.quaternion);
    mesh.scale.copy(group.scale);
    mesh.matrix.copy(group.matrix);
    for (const child of [...group.children]) mesh.add(child);
    const parent = group.parent;
    const index = parent.children.indexOf(group);
    parent.children[index] = mesh;
    mesh.parent = parent;
    group.parent = null;
  }
}

function isIdentity(o: Object3D): boolean {
  o.updateMatrix();
  const e = o.matrix.elements;
  for (let i = 0; i < 16; i++) if (Math.abs(e[i] - (i % 5 === 0 ? 1 : 0)) > 1e-9) return false;
  return true;
}

async function readDAE(data: ArrayBuffer | string, name: string): Promise<ImportedScene> {
  const text = toText(data);
  if (!text.trim()) throw new Error('Fichier Collada vide.');
  if (typeof DOMParser === 'undefined') {
    throw new Error(
      "La lecture des fichiers Collada (.dae) demande l'analyseur XML du navigateur (DOMParser), absent de cet environnement : importez le fichier depuis l'application.",
    );
  }
  const { ColladaLoader } = await import('three/examples/jsm/loaders/ColladaLoader.js');
  let root: Object3D | null = null;
  try {
    const loader = new ColladaLoader(inertManager());
    const { result } = withLoaderEnvironment(() => loader.parse(text, ''));
    root = (result as { scene?: Object3D } | null)?.scene ?? null;
  } catch (err) {
    throw new Error(`Fichier Collada illisible (XML invalide ou tronqué) : ${messageOf(err)}`);
  }
  if (!root) throw new Error('Fichier Collada illisible (XML invalide ou tronqué).');
  // ColladaLoader ramène lui-même la scène en Y-up (rotation de la racine si Z_UP) et en mètres
  // (échelle de la racine = unité déclarée) : il ne reste que Y-up → Z-up. Les lumières et les
  // caméras Collada visent −Z local, comme dans CoForge.
  const unit = Number.isFinite(root.scale.x) && root.scale.x > 0 ? root.scale.x : 1;
  foldColladaGroups(root);
  return sceneFromThree(root, {
    name: baseName(name, 'Collada'),
    rootTransform: Y_UP_TO_Z_UP.clone(),
    lightPower: colladaLightPower,
    // Les couleurs Collada (exporteurs Blender, Maya…) sont des valeurs linéaires brutes.
    rawColorsLinear: true,
    cameraRange: (near, far) => [near * unit, far * unit],
    lengthScale: unit,
  });
}

// ------------------------------------------------------------------ entrée commune

/**
 * Lit un fichier FBX, STL, PLY ou Collada. Le format est déduit de l'extension de `name`, sinon
 * de la signature du contenu. `data` : octets du fichier (ou son texte pour les formats ASCII).
 */
export async function readFBXScene(data: ArrayBuffer | string, name = ''): Promise<ImportedScene> {
  switch (sniffFormat(data, name)) {
    case 'stl':
      return readSTL(data, name);
    case 'ply':
      return readPLY(data, name);
    case 'dae':
      return readDAE(data, name);
    default:
      return readFBX(data, name);
  }
}
