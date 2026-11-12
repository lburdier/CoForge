/**
 * Monde et réglages de rendu de la scène (bloc `SC`, structure `RenderData` dans `scene.r`).
 *
 * Monde : le nœud Background relié à « World Output » donne la couleur et la force ; un nœud
 * Sky Texture sur sa couleur donne le mode 'sky'. Orientation du soleil (vérifiée par rendu
 * Cycles dans Blender 4.3 et 5.1) : la rotation Nishita / diffusion simple ou multiple vaut
 * exactement l'azimut de CoForge (0° = +Y, sens horaire vers +X) ; Preetham et Hosek-Wilkie
 * stockent la direction VERS le soleil. Sans nœuds : couleur d'horizon du monde.
 */
import type { RenderSettings, WorldSettings } from '../../../core/doc/schema';
import { findOutput, follow, input, nodeLabel, readTree, rootCursor, socketColor, socketFloat, valueSocket, type Cursor, type SNode, type SSocket } from './nodes';
import { recAt, type Rec } from './reader';
import { RAD2DEG, clamp, finite, idPropNumber, idPropPath, linearToHex, type Ctx, type RGB } from './util';

const worlds = (n: number): string => `${n} ${n > 1 ? 'mondes' : 'monde'}`;

/** Rapport largeur / hauteur de l'image rendue (résolution × rapport des pixels). */
export function renderAspect(scene: Rec): number {
  const r = scene.sub('r');
  if (!r) return 16 / 9;
  const w = finite(r.num('xsch', 1920), 1920) * finite(r.num('xasp', 1), 1);
  const h = finite(r.num('ysch', 1080), 1080) * finite(r.num('yasp', 1), 1);
  const a = w / h;
  return Number.isFinite(a) && a > 0 ? a : 16 / 9;
}

// ------------------------------------------------------------------ monde

/** Modèles de ciel (`NodeTexSky.sky_model`) : 0 Preetham, 1 Hosek-Wilkie, ≥ 2 Nishita / diffusion. */
const SKY_PREETHAM = 0;
const SKY_HOSEK = 1;

interface Background {
  w: number;
  color: RGB;
  strength: number;
  sky: { elevation: number; azimuth: number } | null;
}

/** Fond(s) qui alimentent une entrée de shader du monde, avec leur poids (Mix/Add Shader). */
function collectBackgrounds(ctx: Ctx, name: string, sock: SSocket, cx: Cursor, w: number, out: Background[], depth: number): void {
  if (depth > 64 || w <= 1e-6 || out.length > 64) return;
  const src = follow(sock, cx);
  if (!src) return;
  const node = src.socket.node;
  const ncx = src.cursor;
  if (node.idname === 'ShaderNodeMixShader') {
    const fac = node.inputs.find((s) => s.kind === 'float') ?? null;
    if (fac && follow(fac, ncx)) {
      ctx.notes.add('world-mix', (n, names) => `Mélanges de fonds du monde pilotés par des nœuds (Light Path…) : facteur fixe retenu (${worlds(n)} : ${names}).`, name);
    }
    const f = clamp(socketFloat(fac ? valueSocket(fac, ncx) : null, 0.5), 0, 1);
    const shaders = node.inputs.filter((s) => s.kind === 'shader');
    if (shaders[0]) collectBackgrounds(ctx, name, shaders[0], ncx, w * (1 - f), out, depth + 1);
    if (shaders[1]) collectBackgrounds(ctx, name, shaders[1], ncx, w * f, out, depth + 1);
    return;
  }
  if (node.idname === 'ShaderNodeAddShader') {
    for (const s of node.inputs) if (s.kind === 'shader') collectBackgrounds(ctx, name, s, ncx, w, out, depth + 1);
    return;
  }
  if (node.idname === 'ShaderNodeBackground' || node.idname === 'ShaderNodeEmission') {
    out.push(background(ctx, name, node, ncx, w));
    return;
  }
  ctx.notes.add(`world-node-${node.idname}`, (n, names) => `Nœud « ${nodeLabel(node)} » du monde non converti (${worlds(n)} : ${names}).`, name);
}

function background(ctx: Ctx, name: string, node: SNode, cx: Cursor, w: number): Background {
  const colorSock = input(node, ['Color']);
  const strengthSock = input(node, ['Strength']);
  let strength = 1;
  if (strengthSock) {
    if (follow(strengthSock, cx)) {
      ctx.notes.add('world-strength-nodes', (n, names) => `Force du fond du monde calculée par des nœuds : valeur fixe retenue (${worlds(n)} : ${names}).`, name);
    }
    strength = socketFloat(valueSocket(strengthSock, cx), 1);
  }
  const bg: Background = { w, color: [0.05, 0.05, 0.05], strength: Math.max(0, finite(strength, 1)), sky: null };
  if (!colorSock) return bg;
  bg.color = socketColor(valueSocket(colorSock, cx), bg.color);
  const src = follow(colorSock, cx);
  if (!src) return bg;
  const up = src.socket.node;
  if (up.idname === 'ShaderNodeRGB') {
    bg.color = socketColor(up.outputs[0] ?? null, bg.color);
  } else if (up.idname === 'ShaderNodeTexSky') {
    bg.sky = readSky(up);
  } else if (up.idname === 'ShaderNodeTexEnvironment') {
    ctx.notes.add('world-hdri', (n, names) => `Images d'environnement (HDRI) du monde non reprises : couleur unie du fond retenue (${worlds(n)} : ${names}).`, name);
  } else {
    ctx.notes.add('world-color-nodes', (n, names) => `Couleur du monde calculée par des nœuds (dégradé, texture procédurale…) non reprise : couleur fixe retenue (${worlds(n)} : ${names}).`, name);
  }
  return bg;
}

/** Élévation et azimut du soleil (degrés, convention de CoForge) d'un nœud Sky Texture. */
function readSky(node: SNode): { elevation: number; azimuth: number } {
  const st = recAt(node.rec.file, node.rec.target('storage'), 0, 'NodeTexSky');
  if (!st) return { elevation: 40, azimuth: 135 };
  const model = st.num('sky_model', SKY_HOSEK);
  if ((model === SKY_PREETHAM || model === SKY_HOSEK || !st.has('sun_elevation')) && st.has('sun_direction')) {
    const d = st.nums('sun_direction', 3) ?? [0, 0, 1];
    const len = Math.hypot(d[0], d[1], d[2]);
    if (!(len > 1e-9)) return { elevation: 90, azimuth: 0 };
    const elevation = Math.asin(clamp(d[2] / len, -1, 1)) * RAD2DEG;
    let azimuth = Math.hypot(d[0], d[1]) > 1e-9 ? Math.atan2(d[0], d[1]) * RAD2DEG : 0;
    if (azimuth < 0) azimuth += 360;
    return { elevation, azimuth };
  }
  const elevation = clamp(finite(st.num('sun_elevation', 0.26), 0.26) * RAD2DEG, -90, 90);
  let azimuth = (finite(st.num('sun_rotation', 0), 0) * RAD2DEG) % 360;
  if (azimuth < 0) azimuth += 360;
  return { elevation, azimuth };
}

export function readWorld(ctx: Ctx, scene: Rec): Partial<WorldSettings> | undefined {
  const world = scene.id('world');
  if (!world) return undefined;
  const name = world.idName || 'Monde';
  const horizon: RGB = [world.num('horr', 0.05), world.num('horg', 0.05), world.num('horb', 0.05)];
  const out: Partial<WorldSettings> = { mode: 'color', color: linearToHex(horizon), strength: 1 };
  try {
    if (world.isLinked) {
      ctx.notes.add('world-linked', (n, names) => `Monde lié à une bibliothèque externe : couleur par défaut (${worlds(n)} : ${names}).`, name);
      return out;
    }
    const useNodes = world.has('use_nodes') ? world.num('use_nodes') !== 0 : true;
    const tree = useNodes ? readTree(world.get('nodetree', 'bNodeTree')) : null;
    const output = tree ? findOutput(tree, ['ShaderNodeOutputWorld']) : null;
    const surf = output ? (input(output, ['Surface']) ?? output.inputs.find((s) => s.kind === 'shader') ?? null) : null;
    if (!tree || !surf) {
      if (ctx.version < 280 && world.num('skytype') !== 0) {
        ctx.notes.add('world-bi-sky', (n, names) => `Dégradé de ciel Blender Internal non repris : couleur d'horizon retenue (${worlds(n)} : ${names}).`, name);
      }
      return out;
    }
    const bgs: Background[] = [];
    collectBackgrounds(ctx, name, surf, rootCursor(tree), 1, bgs, 0);
    if (bgs.length === 0) {
      // Sortie du monde vide : Blender rend un fond noir.
      out.color = '#000000';
      out.strength = 0;
      return out;
    }
    const sky = bgs.find((b) => b.sky);
    if (bgs.length > 1) {
      ctx.notes.add('world-several', (n, names) => `Plusieurs fonds mélangés dans le monde : combinés en un seul (${worlds(n)} : ${names}).`, name);
    }
    if (sky && sky.sky) {
      out.mode = 'sky';
      out.strength = sky.strength * Math.min(1, sky.w);
      out.sunElevation = sky.sky.elevation;
      out.sunAzimuth = sky.sky.azimuth;
      return out;
    }
    // Fonds unis : somme pondérée des couleurs × forces, ramenée à une couleur et une force.
    let total = 0;
    const sum: RGB = [0, 0, 0];
    for (const b of bgs) {
      total += b.w * b.strength;
      for (let i = 0; i < 3; i++) sum[i] += b.w * b.strength * b.color[i];
    }
    if (total > 1e-9) {
      const c = sum.map((v) => v / total) as RGB;
      const peak = Math.max(c[0], c[1], c[2]);
      if (peak > 1) {
        total *= peak;
        for (let i = 0; i < 3; i++) c[i] /= peak;
      }
      out.color = linearToHex(c);
      out.strength = total;
    } else {
      out.color = linearToHex(bgs[0].color);
      out.strength = 0;
    }
  } catch {
    ctx.notes.add('world-error', (n, names) => `Monde illisible : couleur d'horizon retenue (${worlds(n)} : ${names}).`, name);
  }
  return out;
}

// ------------------------------------------------------------------ rendu

/** `RenderData.alphamode` : R_ADDSKY = 0 (fond du monde), R_ALPHAPREMUL = 1 (transparent). */
const R_ADDSKY = 0;
/** `SceneEEVEE.flag` (EEVEE « Legacy », 2.80 → 4.1). */
const SCE_EEVEE_GTAO_ENABLED = 1 << 4;
const SCE_EEVEE_BLOOM_ENABLED = 1 << 7;

export function readRender(ctx: Ctx, scene: Rec): Partial<RenderSettings> {
  const out: Partial<RenderSettings> = {};
  const r = scene.sub('r');
  if (!r) return out;
  try {
    const pct = clamp(finite(r.num('size', 100), 100), 1, 10000);
    const xs = finite(r.num('xsch', 1920), 1920);
    const ys = finite(r.num('ysch', 1080), 1080);
    // Comme Blender : résolution × pourcentage, tronquée.
    out.resX = Math.max(1, Math.min(65536, Math.floor((xs * pct) / 100)));
    out.resY = Math.max(1, Math.min(65536, Math.floor((ys * pct) / 100)));

    const engine = r.str('engine') || 'BLENDER_RENDER';
    const cycles = engine === 'CYCLES';
    out.engine = cycles ? 'pathtrace' : 'realtime';
    if (!cycles && !engine.startsWith('BLENDER_EEVEE')) {
      const label = engine === 'BLENDER_RENDER' ? 'Blender Internal' : engine === 'BLENDER_WORKBENCH' ? 'Workbench' : engine;
      ctx.notes.add(`render-engine`, () => `Moteur de rendu « ${label} » remplacé par le rendu temps réel.`);
    }

    // Échantillons Cycles : IDProperties « cycles » de la scène, défaut du module Cycles sinon.
    const samples = idPropNumber(idPropPath(scene, ['cycles', 'samples']));
    out.samples = Math.max(1, Math.round(samples ?? (ctx.version >= 300 ? 4096 : 128)));
    const preview = idPropNumber(idPropPath(scene, ['cycles', 'preview_samples']));
    if (preview !== null && preview > 0) out.viewportSamples = Math.round(preview);
    const bounces = idPropNumber(idPropPath(scene, ['cycles', 'max_bounces']));
    if (bounces !== null && bounces >= 0) out.bounces = Math.round(bounces);

    // Fond transparent : `alphamode` depuis 2.80 ; avant, réglage propre à Cycles.
    if (ctx.version >= 280) {
      out.transparentBg = r.num('alphamode', R_ADDSKY) !== R_ADDSKY;
    } else if (cycles) {
      const ft = idPropNumber(idPropPath(scene, ['cycles', 'film_transparent']));
      out.transparentBg = ft !== null && ft !== 0;
    } else {
      out.transparentBg = r.num('alphamode', R_ADDSKY) !== R_ADDSKY;
    }

    // EEVEE d'avant 4.2 : occlusion ambiante et bloom.
    const eevee = scene.sub('eevee');
    if (eevee && engine === 'BLENDER_EEVEE' && ctx.version >= 280 && ctx.version < 402) {
      const flag = eevee.num('flag');
      out.ao = (flag & SCE_EEVEE_GTAO_ENABLED) !== 0;
      out.bloom = (flag & SCE_EEVEE_BLOOM_ENABLED) !== 0;
    }

    const view = scene.sub('view_settings');
    if (view) {
      const vt = view.str('view_transform');
      if (vt === 'AgX') out.toneMapping = 'agx';
      else if (vt.startsWith('Filmic')) out.toneMapping = 'filmic';
      else if (vt === 'Standard' || vt === 'Default' || vt === 'Raw' || vt === '') out.toneMapping = 'standard';
      else {
        out.toneMapping = 'standard';
        ctx.notes.add('render-view', () => `Transformation de vue « ${vt} » sans équivalent : « Standard » retenue.`);
      }
      const look = view.str('look');
      if (look && look !== 'None' && !look.endsWith(' - Base Contrast') && !look.endsWith('Medium Contrast')) {
        ctx.notes.add('render-look', () => `Look de gestion des couleurs « ${look} » non repris.`);
      }
      out.exposure = clamp(finite(view.num('exposure', 0), 0), -32, 32);
      const gamma = view.num('gamma', 1);
      if (Math.abs(gamma - 1) > 1e-4) ctx.notes.add('render-gamma', () => `Gamma de la gestion des couleurs (${gamma.toFixed(2)}) non repris.`);
    }
  } catch {
    ctx.notes.add('render-error', () => 'Réglages de rendu illisibles : valeurs par défaut de CoForge.');
  }
  return out;
}
