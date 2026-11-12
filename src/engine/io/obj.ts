import { Matrix4, Vector3 } from 'three';
import type { Vec3 } from '../../core/doc/schema';
import { Z_UP_TO_Y_UP, safeToken } from './convert';
import type { ExportItem } from './types';

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '0';
  let s = v.toFixed(6);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' || s === '' ? '0' : s;
}

/**
 * Export Wavefront OBJ : un objet (`o` + `g`) par élément, sommets en coordonnées monde
 * Y-up, polygones conservés tels quels (pas de triangulation), lissage `s 1` / `s off`,
 * `usemtl` avec le nom du matériau. Les faces dont un sommet manque sont ignorées.
 */
export function exportOBJ(items: ExportItem[]): string {
  const out: string[] = ['# CoForge — export Wavefront OBJ (Y vers le haut, mètres)'];
  const m = new Matrix4();
  const p = new Vector3();
  let base = 1;
  const usedNames = new Map<string, number>();
  for (const item of items) {
    const mesh = item.mesh;
    m.copy(Z_UP_TO_Y_UP).multiply(item.matrixWorld);
    // Une transformation miroir inverserait le sens des faces : on le rétablit.
    const flip = m.determinant() < 0;
    let name = safeToken(item.name, 'Objet');
    const n = usedNames.get(name) ?? 0;
    usedNames.set(name, n + 1);
    if (n > 0) name = `${name}.${String(n).padStart(3, '0')}`;

    const index = new Map<string, number>();
    const coords: string[] = [];
    for (const [vid, pos] of mesh.verts) {
      p.set(pos[0], pos[1], pos[2]).applyMatrix4(m);
      index.set(vid, base + coords.length);
      coords.push(`v ${fmt(p.x)} ${fmt(p.y)} ${fmt(p.z)}`);
    }
    const faceLines: string[] = [];
    for (const loop of mesh.faces.values()) {
      if (loop.length < 3) continue;
      const idx: number[] = [];
      for (const vid of loop) {
        const i = index.get(vid);
        if (i === undefined) break;
        idx.push(i);
      }
      if (idx.length !== loop.length) continue;
      if (flip) idx.reverse();
      faceLines.push(`f ${idx.join(' ')}`);
    }

    out.push(`o ${name}`, `g ${name}`);
    if (item.material) out.push(`usemtl ${safeToken(item.material.name, 'Materiau')}`);
    out.push(item.smooth ? 's 1' : 's off');
    out.push(...coords, ...faceLines);
    base += coords.length;
  }
  return out.join('\n') + '\n';
}

// ------------------------------------------------------------------ lecture

export interface ObjChunk {
  name: string;
  material: string | null;
  smooth: boolean;
  /** Polygones : indices (base 0) dans `ParsedOBJ.positions`. */
  faces: number[][];
}

export interface ParsedOBJ {
  /** Positions telles que lues (repère du fichier, Y-up), 3 flottants par sommet. */
  positions: number[];
  chunks: ObjChunk[];
}

/**
 * Lecture d'un fichier OBJ : sommets `v`, faces `f` (formats v, v/vt, v/vt/vn, v//vn,
 * indices négatifs), objets/groupes `o`/`g`, matériaux `usemtl`, lissage `s`.
 * Un nouveau morceau commence à chaque changement d'objet/groupe ou de matériau.
 */
export function parseOBJ(text: string): ParsedOBJ {
  const positions: number[] = [];
  const chunks: ObjChunk[] = [];
  let name = 'Objet';
  let material: string | null = null;
  let smooth = false;
  let cur: ObjChunk | null = null;

  const current = (): ObjChunk => {
    if (!cur || cur.name !== name || cur.material !== material) {
      cur = { name, material, smooth, faces: [] };
      chunks.push(cur);
    }
    return cur;
  };

  const raw = text.replace(/\r\n?/g, '\n').replace(/\\\n/g, ' ').split('\n');
  for (const rawLine of raw) {
    const hash = rawLine.indexOf('#');
    const line = (hash >= 0 ? rawLine.slice(0, hash) : rawLine).trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const tag = parts[0];
    switch (tag) {
      case 'v': {
        const x = parseFloat(parts[1]);
        const y = parseFloat(parts[2]);
        const z = parseFloat(parts[3]);
        positions.push(Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0, Number.isFinite(z) ? z : 0);
        break;
      }
      case 'f': {
        const nv = positions.length / 3;
        const poly: number[] = [];
        for (let i = 1; i < parts.length; i++) {
          const k = parseInt(parts[i].split('/')[0], 10);
          if (!Number.isFinite(k) || k === 0) continue;
          poly.push(k > 0 ? k - 1 : nv + k);
        }
        if (poly.length >= 3) {
          const c = current();
          if (smooth) c.smooth = true;
          c.faces.push(poly);
        }
        break;
      }
      case 'o':
      case 'g': {
        const n = parts.slice(1).join(' ').trim();
        if (n) name = n;
        break;
      }
      case 'usemtl': {
        const n = parts.slice(1).join(' ').trim();
        material = n || null;
        break;
      }
      case 's': {
        const v = (parts[1] ?? '').toLowerCase();
        smooth = !(v === '' || v === 'off' || v === '0');
        break;
      }
      default:
        break;
    }
  }
  return { positions, chunks: chunks.filter((c) => c.faces.length > 0) };
}

/** Position Y-up lue → Z-up. */
export function objPositionsToZUp(positions: readonly number[]): Float64Array {
  const out = new Float64Array(positions.length);
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const v: Vec3 = [positions[i], -positions[i + 2], positions[i + 1]];
    out[i] = v[0];
    out[i + 1] = v[1];
    out[i + 2] = v[2];
  }
  return out;
}
