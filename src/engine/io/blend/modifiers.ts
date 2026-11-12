import type { ImportedModifier } from '../scene';
import type { Rec } from './reader';
import { RAD2DEG, type Ctx } from './util';

/**
 * Pile de modificateurs d'un objet. Un modificateur n'est traduit que si CoForge a un équivalent
 * EXACT ; un seul modificateur actif (affiché dans le viewport) sans équivalent suffit à mettre
 * l'objet en attente : Blender évaluera la géométrie finale quand il est disponible. Le repli est
 * le maillage de base avec les seuls modificateurs traduisibles.
 */

export interface ModifierStack {
  /** Modificateurs traduits, dans l'ordre de la pile (`enabled: false` s'ils sont masqués dans le viewport). */
  modifiers: ImportedModifier[];
  /** Noms (en français) des modificateurs actifs sans équivalent exact. */
  unsupported: string[];
  /** « Smooth by Angle » (Blender 4.1+) : angle d'auto-lissage en degrés, sinon null. */
  smoothByAngle: number | null;
  /** Modificateurs masqués dans le viewport et sans équivalent : ignorés. */
  ignored: number;
}

const eModifierMode_Realtime = 1;

// Drapeaux (DNA_modifier_types.h), vérifiés sur des fichiers de 2.57 à 5.1.
const MOD_MIR_AXIS_X = 1 << 3;
const MOD_MIR_AXIS_Y = 1 << 4;
const MOD_MIR_AXIS_Z = 1 << 5;
const MOD_MIR_NO_MERGE = 1 << 7;
const MOD_MIR_BISECT_FLIP = 0b111111 << 8; // bissection et retournement sur les trois axes

const MOD_ARR_FIXEDCOUNT = 0;
const MOD_ARR_OFF_CONST = 1;
const MOD_ARR_OFF_RELATIVE = 2;
const MOD_ARR_OFF_OBJ = 4;
const MOD_ARR_MERGE = 1;

const MOD_BEVEL_VERT_LEGACY = 2;
const MOD_BEVEL_ANGLE = 8;
const MOD_BEVEL_WEIGHT = 16;
const MOD_BEVEL_VGROUP = 32;
const MOD_BEVEL_AFFECT_EDGES = 1;
const MOD_BEVEL_AMT_OFFSET = 0;

const MOD_SOLIDIFY_RIM = 1;
const MOD_SOLIDIFY_EVEN = 2;
const MOD_SOLIDIFY_FLIP = 32;
const MOD_SOLIDIFY_NOSHELL = 64;

const BOOLEAN_OPS = ['intersect', 'union', 'difference'] as const;
const eBooleanModifierFlag_Collection = 4;

/** Modificateurs sans effet sur la géométrie affichée : ignorés sans mise en attente. */
const NEUTRAL = new Set(['CollisionModifierData', 'SurfaceModifierData']);

/**
 * Modificateurs qui ne changent que les normales (pas la géométrie) : la forme est exacte sans
 * eux, et CoForge recalcule ses propres normales. Ignorés avec un avertissement regroupé, sans
 * mise en attente (inutile de faire évaluer ces objets par Blender).
 */
const NORMALS_ONLY = new Set(['WeightedNormalModifierData', 'NormalEditModifierData']);

/** Noms français des modificateurs courants (sinon le nom de structure, sans « ModifierData »). */
const LABELS: Record<string, string> = {
  ArmatureModifierData: 'Armature',
  NodesModifierData: 'nœuds de géométrie',
  DisplaceModifierData: 'Déplacement',
  DecimateModifierData: 'Décimation',
  CurveModifierData: 'Courbe',
  LatticeModifierData: 'Lattice',
  HookModifierData: 'Crochet',
  ShrinkwrapModifierData: 'Rétrécir-envelopper',
  SmoothModifierData: 'Lissage',
  LaplacianSmoothModifierData: 'Lissage laplacien',
  CorrectiveSmoothModifierData: 'Lissage correctif',
  SimpleDeformModifierData: 'Déformation simple',
  CastModifierData: 'Projection',
  WaveModifierData: 'Vague',
  ScrewModifierData: 'Vis',
  SkinModifierData: 'Peau',
  RemeshModifierData: 'Remaillage',
  TriangulateModifierData: 'Trianguler',
  WireframeModifierData: 'Fil de fer',
  WeldModifierData: 'Soudure',
  EdgeSplitModifierData: 'Séparation des arêtes',
  MultiresModifierData: 'Multirésolution',
  WeightedNormalModifierData: 'Normales pondérées',
  NormalEditModifierData: 'Modification des normales',
  MeshDeformModifierData: 'Déformation par maillage',
  SurfaceDeformModifierData: 'Déformation de surface',
  ClothModifierData: 'Tissu',
  SoftbodyModifierData: 'Corps mou',
  FluidModifierData: 'Fluide',
  ParticleSystemModifierData: 'Système de particules',
  ParticleInstanceModifierData: 'Instance de particules',
  ExplodeModifierData: 'Explosion',
  OceanModifierData: 'Océan',
  BuildModifierData: 'Construction',
  MaskModifierData: 'Masque',
  ArrayModifierData: 'Réseau',
  MirrorModifierData: 'Miroir',
  BevelModifierData: 'Biseau',
  SubsurfModifierData: 'Subdivision',
  SolidifyModifierData: 'Solidifier',
  BooleanModifierData: 'Booléen',
};

export function modifierLabel(st: string): string {
  return LABELS[st] ?? st.replace(/ModifierData$/, '');
}

/** Valeur d'un angle stocké en radians (flottant) ou en degrés (entier, très anciens fichiers). */
function angleDeg(r: Rec, name: string): number {
  const f = r.field(name);
  if (!f) return 30;
  return f.type === 'float' || f.type === 'double' ? r.num(name) * RAD2DEG : r.num(name);
}

function vec3(r: Rec, name: string): [number, number, number] {
  const v = r.nums(name, 3) ?? [0, 0, 0];
  return [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0].map((x) => (Number.isFinite(x) ? x : 0)) as [number, number, number];
}

/** Angle (degrés) d'un modificateur « Smooth by Angle » : premier flottant de ses réglages. */
function smoothAngle(md: Rec): number {
  const props = md.sub('settings')?.get('properties');
  const data = props?.sub('data');
  if (data) {
    for (const child of data.list('group')) {
      const type = child.num('type');
      if (type !== 2 && type !== 8) continue; // IDP_FLOAT, IDP_DOUBLE
      const val = child.sub('data');
      const f = val?.field('val');
      if (!val || !f) continue;
      const v = type === 2 ? child.file.view.getFloat32(val.pos + f.offset, child.file.littleEndian) : child.file.view.getFloat64(val.pos + f.offset, child.file.littleEndian);
      if (Number.isFinite(v)) return v * RAD2DEG;
    }
  }
  return 30;
}

/** Résultat de la traduction d'UN modificateur : équivalent CoForge, ou null si aucun équivalent exact. */
function translate(md: Rec, name: string, enabled: boolean, objectIndex: (block: number) => number | null): ImportedModifier | null | 'neutral' {
  const st = md.st.name;
  switch (st) {
    case 'MirrorModifierData': {
      const flag = md.num('flag');
      if (md.ptr('mirror_ob') !== 0 || flag & MOD_MIR_BISECT_FLIP) return null;
      return {
        type: 'mirror',
        name,
        enabled,
        params: {
          axisX: (flag & MOD_MIR_AXIS_X) !== 0,
          axisY: (flag & MOD_MIR_AXIS_Y) !== 0,
          axisZ: (flag & MOD_MIR_AXIS_Z) !== 0,
          merge: !(flag & MOD_MIR_NO_MERGE),
          mergeDist: md.num('tolerance', 0.001),
        },
      };
    }
    case 'ArrayModifierData': {
      const off = md.num('offset_type');
      if (md.num('fit_type') !== MOD_ARR_FIXEDCOUNT || off & MOD_ARR_OFF_OBJ || md.num('flags') & MOD_ARR_MERGE) return null;
      if (md.ptr('start_cap') !== 0 || md.ptr('end_cap') !== 0) return null;
      const count = md.num('count', 2);
      if (!(count >= 1)) return null;
      return {
        type: 'array',
        name,
        enabled,
        params: {
          count,
          relative: off & MOD_ARR_OFF_RELATIVE ? vec3(md, 'scale') : [0, 0, 0],
          constant: off & MOD_ARR_OFF_CONST ? vec3(md, 'offset') : [0, 0, 0],
        },
      };
    }
    case 'BevelModifierData': {
      const lim = md.num('lim_flags');
      const vertexOnly = md.has('affect_type') ? md.num('affect_type') !== MOD_BEVEL_AFFECT_EDGES : (md.num('flags') & MOD_BEVEL_VERT_LEGACY) !== 0;
      if (vertexOnly || !(lim & MOD_BEVEL_ANGLE) || lim & (MOD_BEVEL_WEIGHT | MOD_BEVEL_VGROUP)) return null;
      if (md.num('val_flags') !== MOD_BEVEL_AMT_OFFSET) return null;
      if (md.has('profile') && Math.abs(md.num('profile') - 0.5) > 1e-4) return null;
      if (md.num('profile_type') !== 0) return null;
      return {
        type: 'bevel',
        name,
        enabled,
        params: { width: md.num('value', 0.1), segments: Math.max(1, md.num('res', 1)), angleLimit: angleDeg(md, 'bevel_angle') },
      };
    }
    case 'SubsurfModifierData': {
      if (md.num('subdivType') !== 0) return null;
      const levels = md.num('levels', 1);
      if (levels <= 0) return 'neutral';
      return { type: 'subsurf', name, enabled, params: { levels } };
    }
    case 'SolidifyModifierData': {
      const flag = md.num('flag');
      if (md.num('mode') !== 0 || !(flag & MOD_SOLIDIFY_RIM) || flag & (MOD_SOLIDIFY_EVEN | MOD_SOLIDIFY_FLIP | MOD_SOLIDIFY_NOSHELL)) return null;
      if (md.str('defgrp_name') !== '') return null;
      return { type: 'solidify', name, enabled, params: { thickness: md.num('offset', 0.01), offset: md.num('offset_fac', -1) } };
    }
    case 'BooleanModifierData': {
      if (md.num('flag') & eBooleanModifierFlag_Collection) return null;
      const op = BOOLEAN_OPS[md.num('operation', 2)];
      if (!op) return null;
      if (md.ptr('object') === 0) return 'neutral'; // sans opérande, Blender ne fait rien
      const target = objectIndex(md.file.resolveId(md.ptr('object')));
      if (target === null) return null;
      return { type: 'boolean', name, enabled, params: { operation: op }, target };
    }
    default:
      return NEUTRAL.has(st) ? 'neutral' : null;
  }
}

/** Nom de groupe de nœuds « Smooth by Angle » (ou « Auto Smooth » des premières 4.1). */
function isSmoothByAngle(md: Rec): boolean {
  if (md.st.name !== 'NodesModifierData') return false;
  const group = md.id('node_group');
  const name = group ? group.idName : '';
  return /^(Smooth by Angle|Auto Smooth)(\.\d+)?$/.test(name);
}

/**
 * Lit la pile de modificateurs. `objectIndex` donne l'indice (dans la scène importée) de l'objet
 * d'un bloc, null s'il n'est pas importé (opérande d'un booléen).
 */
export function readModifiers(ctx: Ctx, ob: Rec, objectIndex: (block: number) => number | null): ModifierStack {
  const out: ModifierStack = { modifiers: [], unsupported: [], smoothByAngle: null, ignored: 0 };
  for (const md of ob.list('modifiers')) {
    const head = md.sub('modifier');
    if (!head) continue;
    const enabled = (head.num('mode') & eModifierMode_Realtime) !== 0;
    const name = head.str('name');
    if (isSmoothByAngle(md)) {
      if (enabled) out.smoothByAngle = smoothAngle(md);
      continue;
    }
    const t = translate(md, name, enabled, objectIndex);
    if (t === 'neutral') continue;
    if (!t && NORMALS_ONLY.has(md.st.name)) {
      if (enabled) {
        const label = modifierLabel(md.st.name);
        ctx.notes.add(`normales-${label}`, (n) => `Modificateur « ${label} » ignoré (${n} objet(s)) : il ne modifie que les normales, la géométrie est exacte et CoForge calcule son propre ombrage.`);
      }
      continue;
    }
    if (t) {
      out.modifiers.push(t);
      continue;
    }
    if (enabled) out.unsupported.push(modifierLabel(md.st.name));
    else out.ignored++;
  }
  if (out.ignored > 0) {
    ctx.notes.add('modificateur-masque', (n) => `${n} modificateur(s) masqué(s) dans le viewport et sans équivalent : ignoré(s).`);
  }
  return out;
}
