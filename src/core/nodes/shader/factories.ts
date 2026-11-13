import type { NodePropDef, SocketDef } from '../types';

/** Fabriques de sockets et de propriétés du catalogue de shader (identifiants de Blender, libellés français). */

export const f = (id: string, label: string, def: number, extra: Partial<SocketDef> = {}): SocketDef => ({ id, label, type: 'float', default: def, ...extra });
export const fac = (id: string, label: string, def: number, extra: Partial<SocketDef> = {}): SocketDef => f(id, label, def, { min: 0, max: 1, subtype: 'factor', ...extra });
export const ang = (id: string, label: string, def: number, extra: Partial<SocketDef> = {}): SocketDef => f(id, label, def, { subtype: 'angle', ...extra });
export const c = (id: string, label: string, def: string, extra: Partial<SocketDef> = {}): SocketDef => ({ id, label, type: 'color', default: def, ...extra });
export const v = (id: string, label: string, def: [number, number, number] = [0, 0, 0], extra: Partial<SocketDef> = {}): SocketDef => ({ id, label, type: 'vector', default: def, ...extra });
export const vecIn = (id = 'Vector', label = 'Vecteur', extra: Partial<SocketDef> = {}): SocketDef => ({ id, label, type: 'vector', hideValue: true, ...extra });
export const normalIn = (id = 'Normal', label = 'Normale', extra: Partial<SocketDef> = {}): SocketDef => ({ id, label, type: 'vector', hideValue: true, ...extra });
export const sh = (id: string, label: string, extra: Partial<SocketDef> = {}): SocketDef => ({ id, label, type: 'shader', ...extra });
export const fo = (id: string, label: string, extra: Partial<SocketDef> = {}): SocketDef => ({ id, label, type: 'float', ...extra });
export const co = (id: string, label: string, extra: Partial<SocketDef> = {}): SocketDef => ({ id, label, type: 'color', ...extra });
export const vo = (id: string, label: string, extra: Partial<SocketDef> = {}): SocketDef => ({ id, label, type: 'vector', ...extra });

export const en = (id: string, label: string, def: string, options: [string, string][], extra: Partial<NodePropDef> = {}): NodePropDef => ({
  id,
  label,
  kind: 'enum',
  default: def,
  options: options.map(([value, l]) => ({ value, label: l })),
  ...extra,
});
export const bool = (id: string, label: string, def: boolean, extra: Partial<NodePropDef> = {}): NodePropDef => ({ id, label, kind: 'bool', default: def, ...extra });
export const num = (id: string, label: string, def: number, extra: Partial<NodePropDef> = {}): NodePropDef => ({ id, label, kind: 'float', default: def, ...extra });
export const int = (id: string, label: string, def: number, extra: Partial<NodePropDef> = {}): NodePropDef => ({ id, label, kind: 'int', default: def, ...extra });
export const str = (id: string, label: string, def = '', extra: Partial<NodePropDef> = {}): NodePropDef => ({ id, label, kind: 'string', default: def, ...extra });

/** Socket ou propriété visible si la propriété `prop` vaut l'une des valeurs. */
export const is = (prop: string, ...values: string[]) => (p: Record<string, unknown>) => values.includes(String(p[prop]));
export const isNot = (prop: string, ...values: string[]) => (p: Record<string, unknown>) => !values.includes(String(p[prop]));

/** Couleurs Blender courantes (linéaire → sRGB). */
export const GRAY_08 = '#e7e7e7';
export const GRAY_05 = '#bcbcbc';
export const GRAY_02 = '#7c7c7c';
export const WHITE = '#ffffff';
export const BLACK = '#000000';

/**
 * Courbe (nœuds Courbes RVB / vectorielles / flottante), propriété `mapping` de kind 'curve' :
 *   { curves: [{ points: [{ x, y, handle? : 'AUTO' | 'VECTOR' }] }], clip?: { minX, minY, maxX, maxY } }
 * Courbes RVB : 4 courbes (C, R, V, B) ; vectorielles : 3 (X, Y, Z, sur [-1, 1]) ; flottante : 1.
 */
export interface CurvePoint {
  x: number;
  y: number;
  handle?: 'AUTO' | 'VECTOR';
}
export interface CurveMapping {
  curves: { points: CurvePoint[] }[];
}

export function identityCurves(n: number, lo = 0, hi = 1): CurveMapping {
  return { curves: Array.from({ length: n }, () => ({ points: [{ x: lo, y: lo }, { x: hi, y: hi }] })) };
}
