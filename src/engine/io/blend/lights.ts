/**
 * Lumières (bloc `LA` : structure `Lamp` dans toutes les versions) → `LightData`.
 *
 * Unités (vérifiées en ouvrant les fichiers dans Blender) :
 *  - Blender ≥ 2.80 : puissance en watts (soleil : éclairement en W/m²), reprise telle quelle.
 *    À partir de 4.x le fichier porte deux valeurs : `energy_new` (celle de l'interface) et
 *    `energy`, équivalent écrit pour les versions antérieures (différent pour les lumières
 *    surfaciques, dont la normalisation a changé). Le moteur de CoForge reproduit l'ancienne
 *    normalisation de Cycles (voir src/engine/lights.ts) : on lit donc `energy`, ce qui donne le
 *    même éclairage que Blender (une surfacique de 120 W en 4.x devient 152,8 W ici).
 *    L'exposition de la lumière (5.x, facteur 2^exposure) est appliquée à la puissance.
 *  - Blender ≤ 2.79 : énergie sans dimension. Conversion identique à celle de Blender 2.80 à
 *    l'ouverture d'un ancien fichier : × 100 (W) pour point, spot et surfacique, inchangée pour le
 *    soleil ; « Hemi » devient un soleil. La puissance des nœuds Emission des lampes Cycles est
 *    ignorée, comme dans Blender 2.80 (signalé).
 *  - Ombres : bit 0 de `mode` à toutes les versions (`LA_SHADOW`, ancien `LA_SHAD_BUF`), comme
 *    Blender 2.80+ à l'ouverture d'un ancien fichier (vérifié avec Blender 2.93 sur des fichiers
 *    écrits par 2.57, 2.62 et 2.79).
 *  - Cône des spots : `spotsize` est en degrés dans les fichiers anciens (2.57, 2.62 vérifiés),
 *    en radians ensuite (2.79 vérifié).
 */
import type { LightData, LightKind } from '../../../core/doc/schema';
import { findOutput, follow, input, readTree, rootCursor, socketColor, socketFloat } from './nodes';
import type { Rec } from './reader';
import { RAD2DEG, clamp, finite, linearToHex, type Ctx } from './util';

const LA_LOCAL = 0;
const LA_SUN = 1;
const LA_SPOT = 2;
const LA_HEMI = 3;
const LA_AREA = 4;

const LA_AREA_SQUARE = 0;
const LA_AREA_RECT = 1;
const LA_AREA_DISK = 4;
const LA_AREA_ELLIPSE = 5;

/** `mode & LA_SHADOW` = ombres actives (même bit que l'ancien `LA_SHAD_BUF`). */
const LA_SHADOW = 1 << 0;
/** Blender ≤ 2.79 : lumière négative. */
const LA_NEG = 1 << 4;

const lights = (n: number): string => `${n} ${n > 1 ? 'lumières' : 'lumière'}`;

export function readLight(ctx: Ctx, light: Rec): Partial<Omit<LightData, 'id'>> {
  const name = light.idName || 'Lumière';
  const out: Partial<Omit<LightData, 'id'>> = {};
  try {
    const legacy = ctx.version < 280;
    let type = light.num('type', LA_LOCAL);
    if (type === LA_HEMI) {
      ctx.notes.add('light-hemi', (n, names) => `Lampes « Hemi » converties en soleil, comme dans Blender 2.80 (${lights(n)} : ${names}).`, name);
      type = LA_SUN;
    }
    const kind: LightKind = type === LA_SUN ? 'sun' : type === LA_SPOT ? 'spot' : type === LA_AREA ? 'area' : 'point';
    if (![LA_LOCAL, LA_SUN, LA_SPOT, LA_AREA].includes(type)) {
      ctx.notes.add('light-type', (n, names) => `Types de lumière inconnus convertis en point (${lights(n)} : ${names}).`, name);
    }
    out.kind = kind;
    out.color = linearToHex([light.num('r', 1), light.num('g', 1), light.num('b', 1)]);

    // --- puissance
    let power: number;
    if (legacy) {
      const energy = finite(light.num('energy', 1), 1);
      power = kind === 'sun' ? energy : energy * 100;
      if (light.num('mode') & LA_NEG) {
        ctx.notes.add('light-negative', (n, names) => `Lampes négatives (Blender Internal) sans équivalent : rendues positives (${lights(n)} : ${names}).`, name);
      }
      if (light.num('use_nodes') !== 0 && lightEmission(light) !== null) {
        ctx.notes.add('light-legacy-nodes', (n, names) => `Puissance des nœuds Emission des lampes Cycles d'avant 2.80 ignorée, comme dans Blender 2.80 (énergie × 100 retenue) (${lights(n)} : ${names}).`, name);
      }
    } else {
      // `energy` est la valeur compatible avec l'ancienne normalisation (voir en-tête) ; `energy_new` à défaut.
      const compat = light.num('energy', NaN);
      const current = light.num('energy_new', NaN);
      power = Number.isFinite(compat) && (compat !== 0 || !Number.isFinite(current)) ? compat : finite(current, 10);
      const exposure = finite(light.num('exposure', 0), 0);
      if (exposure !== 0 && light.has('energy_new')) power *= Math.pow(2, clamp(exposure, -32, 32));
      if (light.num('use_nodes') !== 0) {
        const e = lightEmission(light);
        if (e !== null && (Math.abs(e.strength - 1) > 1e-6 || !e.white)) {
          ctx.notes.add('light-nodes', (n, names) => `Nœuds de lumière (Cycles) ignorés : seule la puissance de la lumière est reprise (${lights(n)} : ${names}).`, name);
        }
      }
    }
    out.power = Math.max(0, finite(power, 0));

    // --- taille de la source (« Radius » / shadow_soft_size) : `radius` depuis 3.x, `area_size` avant.
    if (kind !== 'area') {
      const r = light.has('radius') ? light.num('radius') : light.num('area_size', 0.1);
      out.radius = Math.max(0, finite(r, 0.1));
    }
    if (kind === 'sun' && light.has('sun_angle')) {
      // L'angle du soleil n'a pas d'équivalent : CoForge n'a qu'un rayon de source.
      const angle = light.num('sun_angle', 0);
      if (angle * RAD2DEG > 5) {
        ctx.notes.add('light-sun-angle', (n, names) => `Diamètre angulaire du soleil non repris (${lights(n)} : ${names}).`, name);
      }
    }
    if (kind === 'spot') {
      const size = finite(light.num('spotsize', Math.PI / 4), Math.PI / 4);
      // Fichiers anciens : degrés (1..180) ; un cône au-delà de π ne peut être qu'en degrés.
      const degrees = legacy && size > Math.PI + 1e-4;
      out.spotAngle = clamp(degrees ? size : size * RAD2DEG, 1, 180);
      out.spotBlend = clamp(finite(light.num('spotblend', 0.15), 0.15), 0, 1);
    }
    if (kind === 'area') {
      const shape = light.num('area_shape', LA_AREA_SQUARE);
      const sx = Math.max(0, finite(light.num('area_size', 1), 1));
      const sy = shape === LA_AREA_RECT || shape === LA_AREA_ELLIPSE ? Math.max(0, finite(light.num('area_sizey', 1), 1)) : sx;
      out.sizeX = sx;
      out.sizeY = sy;
      if (shape === LA_AREA_DISK || shape === LA_AREA_ELLIPSE) {
        ctx.notes.add('light-disk', (n, names) => `Lumières surfaciques en disque ou ellipse converties en rectangle de même taille (${lights(n)} : ${names}).`, name);
      }
      if (light.has('area_spread') && light.num('area_spread', Math.PI) < Math.PI - 1e-3) {
        ctx.notes.add('light-spread', (n, names) => `Ouverture (spread) des lumières surfaciques non reprise (${lights(n)} : ${names}).`, name);
      }
    }

    // --- ombres
    out.castShadow = (light.num('mode') & LA_SHADOW) !== 0;
    if (light.num('use_temperature' as string, 0) !== 0) {
      ctx.notes.add('light-temperature', (n, names) => `Température de couleur des lumières non reprise (${lights(n)} : ${names}).`, name);
    }
  } catch {
    ctx.notes.add('light-error', (n, names) => `Lumières illisibles remplacées par des valeurs par défaut (${lights(n)} : ${names}).`, name);
  }
  return out;
}

/** Nœud Emission relié à la sortie de la lampe (force, couleur blanche ou non), null s'il n'y en a pas. */
function lightEmission(light: Rec): { strength: number; white: boolean } | null {
  const tree = readTree(light.get('nodetree', 'bNodeTree'));
  const output = tree ? findOutput(tree, ['ShaderNodeOutputLight', 'ShaderNodeOutputLamp']) : null;
  const surf = output ? input(output, ['Surface']) : null;
  if (!tree || !surf) return null;
  const src = follow(surf, rootCursor(tree));
  if (!src || src.socket.node.idname !== 'ShaderNodeEmission') return null;
  const node = src.socket.node;
  const c = socketColor(input(node, ['Color']), [1, 1, 1]);
  return { strength: socketFloat(input(node, ['Strength']), 1), white: Math.abs(c[0] - 1) + Math.abs(c[1] - 1) + Math.abs(c[2] - 1) < 1e-4 };
}
