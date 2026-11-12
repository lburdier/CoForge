/**
 * Matériaux Blender → `MaterialData` (Principled simplifié de CoForge).
 *
 * Avec nœuds : on part de la sortie « Material Output » active et on décompose la surface en
 * « fermetures » pondérées (Mix Shader → poids 1−f / f, Add Shader → somme), comme le fait le
 * moteur de Blender, puis on les condense :
 *  - Principled : lu tel quel (noms de sockets de 2.79 à 5.x) ;
 *  - Diffuse, Translucent, Sheen/Velvet, Toon, Subsurface : diélectrique mat (rugosité 1) ;
 *  - Glossy / Anisotropic / Metallic : métal teinté par la couleur ;
 *  - Glass / Refraction : transmission 1 ;
 *  - Emission (et Background) : émission ; Transparent (et Holdout) : opacité.
 * Couleur de base, métal, rugosité, IOR, transmission : moyennes pondérées des fermetures de
 * surface ; opacité = 1 − poids transparent ; émission = somme des émissions.
 *
 * Sans nœuds : champs du matériau (couleur d'affichage, métal, rugosité, alpha) ; anciens
 * matériaux « Blender Internal » (≤ 2.79) convertis au mieux (voir `readInternal`).
 */
import { MATERIAL_DEFAULTS, type MaterialData } from '../../../core/doc/schema';
import {
  fedByImage,
  findOutput,
  follow,
  input,
  nodeLabel,
  readTree,
  rootCursor,
  socketColor,
  socketFloat,
  valueSocket,
  type Cursor,
  type SNode,
  type SSocket,
} from './nodes';
import { recAt, type Rec } from './reader';
import { clamp, finite, linearToHex, type Ctx, type RGB } from './util';

export interface BlendMaterial {
  material: Omit<MaterialData, 'id'>;
  /** Base Color alimentée (même indirectement) par une texture image. */
  textured: boolean;
}

/** Profondeur maximale de Mix/Add Shader imbriqués. */
const MAX_DEPTH = 64;
/** Nombre maximal de fermetures retenues par matériau. */
const MAX_CLOSURES = 256;

interface Surface {
  kind: 'surface';
  w: number;
  base: RGB;
  metallic: number;
  roughness: number;
  /** IOR, NaN si la fermeture n'en a pas. */
  ior: number;
  transmission: number;
  alpha: number;
}
interface Emission {
  kind: 'emission';
  w: number;
  color: RGB;
  strength: number;
}
interface Transparent {
  kind: 'transparent';
  w: number;
}
type Closure = Surface | Emission | Transparent;

/** État d'évaluation d'un matériau : fermetures collectées et causes de perte. */
interface Eval {
  ctx: Ctx;
  name: string;
  closures: Closure[];
  textured: boolean;
}

function note(ev: Eval, key: string, text: (count: number, names: string) => string): void {
  ev.ctx.notes.add(key, text, ev.name);
}

const plural = (n: number, one: string, many: string): string => (n > 1 ? many : one);
const matCount = (n: number): string => `${n} ${plural(n, 'matériau', 'matériaux')}`;

/** Couleur d'une entrée : valeur fixe, nœud RGB, ou valeur par défaut si calculée par des nœuds. */
function colorIn(ev: Eval, sock: SSocket | null, cx: Cursor, def: RGB, isBase: boolean): RGB {
  if (!sock) return def;
  const src = follow(sock, cx);
  if (!src) return socketColor(valueSocket(sock, cx), def);
  const node = src.socket.node;
  if (node.idname === 'ShaderNodeRGB') return socketColor(node.outputs[0] ?? null, def);
  if (isBase && fedByImage(sock, cx)) {
    ev.textured = true;
  } else {
    note(ev, 'mat-color-nodes', (n, names) => `Couleurs calculées par des nœuds (textures procédurales, attributs…) non reprises, couleur fixe du socket retenue (${matCount(n)} : ${names}).`);
  }
  return socketColor(sock, def);
}

/** Valeur numérique d'une entrée : valeur fixe, nœud Value, ou valeur par défaut si pilotée. */
function floatIn(ev: Eval, sock: SSocket | null, cx: Cursor, def: number): number {
  if (!sock) return def;
  const src = follow(sock, cx);
  if (!src) return socketFloat(valueSocket(sock, cx), def);
  const node = src.socket.node;
  if (node.idname === 'ShaderNodeValue') return socketFloat(node.outputs[0] ?? null, def);
  if (fedByImage(sock, cx)) {
    note(ev, 'mat-value-texture', (n, names) => `Textures image sur la rugosité, le métal ou l'opacité non reprises, valeur fixe du socket retenue (${matCount(n)} : ${names}).`);
  } else {
    note(ev, 'mat-value-nodes', (n, names) => `Valeurs de matériau calculées par des nœuds non reprises, valeur fixe du socket retenue (${matCount(n)} : ${names}).`);
  }
  return socketFloat(sock, def);
}

function surface(w: number, base: RGB, metallic: number, roughness: number, ior = NaN, transmission = 0, alpha = 1): Surface {
  return { kind: 'surface', w, base, metallic, roughness, ior, transmission, alpha };
}

const GREY: RGB = [0.8, 0.8, 0.8];

/** Décompose le shader produit par `node` avec le poids `w`. */
function evalShader(ev: Eval, node: SNode, cx: Cursor, w: number, depth: number): void {
  if (w <= 1e-6 || ev.closures.length >= MAX_CLOSURES) return;
  const push = (c: Closure): void => {
    ev.closures.push(c);
  };
  const color = (names: readonly string[], def: RGB = GREY, isBase = true): RGB => colorIn(ev, input(node, names, 'rgba') ?? input(node, names), cx, def, isBase);
  const num = (names: readonly string[], def: number): number => floatIn(ev, input(node, names), cx, def);

  switch (node.idname) {
    case 'ShaderNodeMixShader': {
      const facSock = node.inputs.find((s) => s.kind === 'float') ?? null;
      if (facSock && follow(facSock, cx)) {
        note(ev, 'mat-mix-fac', (n, names) => `Mélanges de shaders pilotés par des nœuds (masque, Fresnel…) : facteur fixe du socket retenu (${matCount(n)} : ${names}).`);
      }
      const f = clamp(socketFloat(facSock ? valueSocket(facSock, cx) : null, 0.5), 0, 1);
      const shaders = node.inputs.filter((s) => s.kind === 'shader');
      if (shaders[0]) shaderIn(ev, shaders[0], cx, w * (1 - f), depth + 1);
      if (shaders[1]) shaderIn(ev, shaders[1], cx, w * f, depth + 1);
      return;
    }
    case 'ShaderNodeAddShader': {
      for (const s of node.inputs) if (s.kind === 'shader') shaderIn(ev, s, cx, w, depth + 1);
      return;
    }
    case 'ShaderNodeBsdfPrincipled': {
      const base = color(['Base Color']);
      const metallic = clamp(num(['Metallic'], 0), 0, 1);
      const roughness = clamp(num(['Roughness'], 0.5), 0, 1);
      const ior = num(['IOR'], 1.45);
      const transmission = clamp(num(['Transmission Weight', 'Transmission'], 0), 0, 1);
      const alpha = clamp(num(['Alpha'], 1), 0, 1);
      push(surface(w, base, metallic, roughness, ior, transmission, alpha));
      const eSock = input(node, ['Emission Color', 'Emission'], 'rgba');
      if (eSock) {
        const strength = num(['Emission Strength'], 1);
        const ec = colorIn(ev, eSock, cx, [0, 0, 0], false);
        if (strength > 0 && Math.max(ec[0], ec[1], ec[2]) > 0) push({ kind: 'emission', w, color: ec, strength });
      }
      for (const extra of ['Subsurface Weight', 'Subsurface', 'Coat Weight', 'Clearcoat', 'Sheen Weight', 'Sheen', 'Anisotropic']) {
        const s = input(node, [extra]);
        if (s && (follow(s, cx) || socketFloat(valueSocket(s, cx), 0) > 1e-4)) {
          note(ev, 'mat-principled-extra', (n, names) => `Effets du Principled BSDF sans équivalent (subsurface, vernis, sheen, anisotropie) ignorés (${matCount(n)} : ${names}).`);
          break;
        }
      }
      return;
    }
    case 'ShaderNodeBsdfDiffuse':
    case 'ShaderNodeBsdfTranslucent':
    case 'ShaderNodeSubsurfaceScattering':
    case 'ShaderNodeBsdfVelvet':
    case 'ShaderNodeBsdfSheen':
    case 'ShaderNodeBsdfToon':
    case 'ShaderNodeBsdfHair':
    case 'ShaderNodeBsdfHairPrincipled': {
      if (node.idname !== 'ShaderNodeBsdfDiffuse') {
        note(ev, `mat-approx-${node.idname}`, (n, names) => `Shader « ${nodeLabel(node)} » approché par une surface diffuse (${matCount(n)} : ${names}).`);
      }
      push(surface(w, color(['Color', 'Base Color']), 0, 1));
      return;
    }
    case 'ShaderNodeBsdfGlossy':
    case 'ShaderNodeBsdfAnisotropic':
    case 'ShaderNodeBsdfMetallic': {
      push(surface(w, color(['Color', 'Base Color']), 1, clamp(num(['Roughness'], 0.5), 0, 1)));
      return;
    }
    case 'ShaderNodeBsdfGlass':
    case 'ShaderNodeBsdfRefraction': {
      push(surface(w, color(['Color']), 0, clamp(num(['Roughness'], 0), 0, 1), num(['IOR'], 1.45), 1));
      return;
    }
    case 'ShaderNodeEeveeSpecular': {
      const base = color(['Base Color']);
      const roughness = clamp(num(['Roughness'], 0.2), 0, 1);
      const transparency = clamp(num(['Transparency'], 0), 0, 1);
      push(surface(w, base, 0, roughness, NaN, 0, 1 - transparency));
      const ec = colorIn(ev, input(node, ['Emissive Color'], 'rgba'), cx, [0, 0, 0], false);
      if (Math.max(ec[0], ec[1], ec[2]) > 0) push({ kind: 'emission', w, color: ec, strength: 1 });
      return;
    }
    case 'ShaderNodeEmission':
    case 'ShaderNodeBackground': {
      const ec = color(['Color'], [1, 1, 1], false);
      const strength = num(['Strength'], 1);
      if (strength > 0) push({ kind: 'emission', w, color: ec, strength });
      return;
    }
    case 'ShaderNodeBsdfTransparent':
      push({ kind: 'transparent', w });
      return;
    case 'ShaderNodeHoldout':
    case 'ShaderNodeBsdfRayPortal':
      note(ev, `mat-approx-${node.idname}`, (n, names) => `Shader « ${nodeLabel(node)} » rendu comme une surface transparente (${matCount(n)} : ${names}).`);
      push({ kind: 'transparent', w });
      return;
    default:
      note(ev, `mat-node-${node.idname}`, (n, names) => `Nœud de shader « ${nodeLabel(node)} » non converti (${matCount(n)} : ${names}).`);
  }
}

/** Décompose ce qui alimente une entrée de type shader. */
function shaderIn(ev: Eval, sock: SSocket, cx: Cursor, w: number, depth: number): void {
  if (depth > MAX_DEPTH) return;
  const src = follow(sock, cx);
  if (!src) return; // entrée vide : aucune fermeture (noir)
  evalShader(ev, src.socket.node, src.cursor, w, depth);
}

/** Condense les fermetures en un matériau Principled simplifié. */
function condense(closures: Closure[]): Omit<MaterialData, 'id' | 'name'> {
  let sw = 0;
  const base: RGB = [0, 0, 0];
  let metallic = 0;
  let roughness = 0;
  let transmission = 0;
  let ior = 0;
  let iorW = 0;
  let alphaLoss = 0;
  let eStrength = 0;
  const eSum: RGB = [0, 0, 0];
  for (const c of closures) {
    if (c.kind === 'surface') {
      sw += c.w;
      for (let i = 0; i < 3; i++) base[i] += c.w * c.base[i];
      metallic += c.w * c.metallic;
      roughness += c.w * c.roughness;
      transmission += c.w * c.transmission;
      if (Number.isFinite(c.ior)) {
        ior += c.w * c.ior;
        iorW += c.w;
      }
      alphaLoss += c.w * (1 - c.alpha);
    } else if (c.kind === 'emission') {
      eStrength += c.w * c.strength;
      for (let i = 0; i < 3; i++) eSum[i] += c.w * c.strength * c.color[i];
    } else {
      alphaLoss += c.w;
    }
  }
  const out: Omit<MaterialData, 'id' | 'name'> = { ...MATERIAL_DEFAULTS };
  if (sw > 1e-9) {
    out.baseColor = linearToHex(base.map((v) => v / sw));
    out.metallic = clamp(metallic / sw, 0, 1);
    out.roughness = clamp(roughness / sw, 0, 1);
    out.transmission = clamp(transmission / sw, 0, 1);
  } else {
    // Ni diffusion ni reflet : seule l'émission (ou rien) est visible.
    out.baseColor = '#000000';
    out.roughness = 1;
  }
  if (iorW > 1e-9) out.ior = clamp(ior / iorW, 1, 4);
  out.alpha = clamp(1 - alphaLoss, 0, 1);
  if (eStrength > 1e-9) {
    const color = eSum.map((v) => v / eStrength) as RGB;
    let strength = eStrength;
    // Couleur hors gamut (composante > 1) : on reporte l'excès sur la force.
    const peak = Math.max(color[0], color[1], color[2]);
    if (peak > 1) {
      strength *= peak;
      for (let i = 0; i < 3; i++) color[i] /= peak;
    }
    out.emission = linearToHex(color);
    out.emissionStrength = strength;
  }
  return out;
}

// ------------------------------------------------------------------ matériaux sans nœuds

const MA_TRANSP = 1 << 16;
const MA_RAYMIRROR = 1 << 18;
const MAP_COL = 1;
const TEX_IMAGE = 8;

/** Textures « Blender Internal » (pile `mtex`) appliquées à la couleur : image → texturé. */
function internalTextures(ctx: Ctx, mat: Rec, name: string): boolean {
  const f = mat.field('mtex');
  if (!f || !f.pointer) return false;
  const septex = mat.num('septex');
  let textured = false;
  for (let i = 0; i < f.count && i < 32; i++) {
    if (septex & (1 << i)) continue;
    const m = recAt(mat.file, mat.target('mtex', i), 0, 'MTex');
    const tex = m ? m.id('tex') : null;
    if (!m || !tex || !(m.num('mapto') & MAP_COL)) continue;
    if (tex.num('type') === TEX_IMAGE && tex.ptr('ima') !== 0) textured = true;
    else ctx.notes.add('mat-bi-tex', (n, names) => `Textures procédurales Blender Internal non reprises (${matCount(n)} : ${names}).`, name);
  }
  return textured;
}

/**
 * Matériau sans nœuds. Blender 2.8+ : couleur d'affichage, métal, rugosité, alpha (comme EEVEE).
 * Blender Internal (≤ 2.79), conversion documentée :
 *  - couleur diffuse (r, g, b) telle quelle, comme Blender ≥ 2.80 qui ouvre le fichier ;
 *  - alpha si « Transparency » est actif ;
 *  - dureté spéculaire (Blinn-Phong, 1..511) → rugosité ≈ √(2 / (dureté + 2)) ;
 *  - miroir (raytrace) → métal = facteur de réflexion ;
 *  - emit (multiple de la couleur diffuse) → émission de la couleur diffuse, force = emit.
 */
function readNoNodes(ctx: Ctx, mat: Rec, name: string, internal: boolean): BlendMaterial {
  const out: Omit<MaterialData, 'id' | 'name'> = { ...MATERIAL_DEFAULTS };
  const rgb: RGB = [finite(mat.num('r', 0.8), 0.8), finite(mat.num('g', 0.8), 0.8), finite(mat.num('b', 0.8), 0.8)];
  out.baseColor = linearToHex(rgb);
  let textured = false;
  if (!internal) {
    out.metallic = clamp(finite(mat.num('metallic', 0), 0), 0, 1);
    out.roughness = clamp(finite(mat.num('roughness', 0.4), 0.4), 0, 1);
    out.alpha = clamp(finite(mat.num('a', 1), 1), 0, 1);
  } else {
    const mode = mat.num('mode');
    if (mode & MA_TRANSP) out.alpha = clamp(finite(mat.num('alpha', 1), 1), 0, 1);
    const har = finite(mat.num('har', 50), 50);
    out.roughness = clamp(Math.sqrt(2 / (Math.max(1, har) + 2)), 0.02, 1);
    out.metallic = mode & MA_RAYMIRROR ? clamp(finite(mat.num('ray_mirror', 0), 0), 0, 1) : 0;
    const emit = finite(mat.num('emit', 0), 0);
    if (emit > 0) {
      out.emission = out.baseColor;
      out.emissionStrength = emit;
    }
    textured = internalTextures(ctx, mat, name);
    ctx.notes.add('mat-bi', (n, names) => `Anciens matériaux Blender Internal convertis au mieux (dureté → rugosité, miroir → métal, emit → émission) (${matCount(n)} : ${names}).`, name);
  }
  return { material: { name, ...out }, textured };
}

// ------------------------------------------------------------------ point d'entrée

export function readMaterial(ctx: Ctx, mat: Rec): BlendMaterial {
  const name = mat.idName || 'Matériau';
  try {
    if (mat.isLinked) {
      ctx.notes.add('mat-linked', (n, names) => `Matériaux liés à une bibliothèque externe : valeurs par défaut (${matCount(n)} : ${names}).`, name);
      return { material: { name, ...MATERIAL_DEFAULTS }, textured: false };
    }
    // Blender Internal : le Material d'avant 2.8 a un champ `har` (dureté) et pas de `metallic`.
    const internal = !mat.has('metallic') && mat.has('har');
    const useNodes = mat.has('use_nodes') ? mat.num('use_nodes') !== 0 : true;
    const tree = useNodes ? readTree(mat.get('nodetree', 'bNodeTree')) : null;
    const output = tree ? findOutput(tree, ['ShaderNodeOutputMaterial']) : null;
    if (!tree || !output) {
      if (tree && tree.nodes.length > 0) {
        ctx.notes.add('mat-no-output', (n, names) => `Matériaux à nœuds sans sortie « Material Output » (nœuds Blender Internal…) : couleur du matériau retenue (${matCount(n)} : ${names}).`, name);
      }
      return readNoNodes(ctx, mat, name, internal);
    }
    const ev: Eval = { ctx, name, closures: [], textured: false };
    const cx = rootCursor(tree);
    const surf = input(output, ['Surface']) ?? output.inputs.find((s) => s.kind === 'shader') ?? null;
    if (surf) shaderIn(ev, surf, cx, 1, 0);
    const vol = input(output, ['Volume']);
    if (vol && follow(vol, cx)) ctx.notes.add('mat-volume', (n, names) => `Volumes de matériau ignorés (${matCount(n)} : ${names}).`, name);
    const disp = input(output, ['Displacement']);
    if (disp && follow(disp, cx)) ctx.notes.add('mat-displacement', (n, names) => `Déplacement / relief de matériau ignoré (${matCount(n)} : ${names}).`, name);
    return { material: { name, ...condense(ev.closures) }, textured: ev.textured };
  } catch {
    // Données incohérentes : on garde un matériau neutre plutôt que d'interrompre l'import.
    ctx.notes.add('mat-error', (n, names) => `Matériaux illisibles remplacés par un matériau neutre (${matCount(n)} : ${names}).`, name);
    return { material: { name, ...MATERIAL_DEFAULTS }, textured: false };
  }
}
