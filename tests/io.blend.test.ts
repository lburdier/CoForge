import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { SceneDoc } from '../src/core/doc/SceneDoc';
import { readBlendScene, type BlendScene } from '../src/engine/io/blend';
import { BlendFile } from '../src/engine/io/blend/file';
import { applyImportedScene } from '../src/engine/io/scene';

/**
 * Lecteur .blend natif comparé à la vérité terrain exportée par Blender lui-même
 * (scripts/blend-fixtures/make_fixtures.py), pour chaque version disponible dans
 * tests/fixtures/blend : bXYZ_full (compressé) et bXYZ_mini (non compressé).
 */

const DIR = join(__dirname, 'fixtures', 'blend');
const TOL = 1e-4;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Truth = any;

function load(name: string): ArrayBuffer {
  const b = readFileSync(join(DIR, name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

const fixtures = readdirSync(DIR)
  .filter((f) => /^b\d+(w32)?_(full|mini)\.json$/.test(f))
  .map((f) => f.replace(/\.json$/, ''))
  .sort();

function close(a: ArrayLike<number>, b: ArrayLike<number>, tol = TOL): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!(Math.abs(a[i] - b[i]) <= tol * Math.max(1, Math.abs(b[i])))) return false;
  return true;
}

/** Couleur linéaire de Blender → '#rrggbb' sRGB (formule sRGB standard, écrite ici indépendamment du lecteur). */
function hex(rgb: number[]): string {
  return (
    '#' +
    rgb
      .slice(0, 3)
      .map((c) => {
        const v = Math.min(1, Math.max(0, c));
        const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
        return Math.round(s * 255).toString(16).padStart(2, '0');
      })
      .join('')
  );
}

/** Deux couleurs '#rrggbb' égales à une unité d'arrondi près par canal. */
function sameHex(a: string, b: string): boolean {
  if (!/^#[0-9a-f]{6}$/i.test(a)) return false;
  for (let i = 1; i < 7; i += 2) if (Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)) > 1) return false;
  return true;
}

/** Objets de la scène (avant les copies d'instances, qui sont ajoutées à la fin). */
function sceneObjects(scene: BlendScene, truth: Truth) {
  return scene.objects.slice(0, truth.scene_objects.length);
}

/** Visibilité effective d'une collection importée (elle et ses parents). */
function colVisible(scene: BlendScene, c: number | null): boolean {
  for (let d = 0; c !== null && d < 64; d++) {
    if (!scene.collections[c].visible) return false;
    c = scene.collections[c].parent;
  }
  return true;
}

/** Visibilité attendue d'après bpy. */
function truthVisible(truth: Truth, o: Truth): boolean {
  if (o.hide_viewport || o.hide_eye) return false;
  if (truth.scene_layers) return (o.layers as number[]).some((l) => (truth.scene_layers as number[]).includes(l));
  const byName = new Map<string, Truth>((truth.collections as Truth[]).map((c) => [c.name, c]));
  const holder = (truth.collections as Truth[]).find((c) => (c.objects as string[]).includes(o.name));
  for (let c = holder, d = 0; c && d < 64; c = c.parent ? byName.get(c.parent) : undefined, d++) {
    if (c.hide_viewport || c.exclude || c.layer_hide) return false;
  }
  return true;
}

function truthRenderable(truth: Truth, o: Truth): boolean {
  if (o.hide_render) return false;
  if (!truth.collections) return true;
  const byName = new Map<string, Truth>((truth.collections as Truth[]).map((c) => [c.name, c]));
  const holder = (truth.collections as Truth[]).find((c) => (c.objects as string[]).includes(o.name));
  for (let c = holder, d = 0; c && d < 64; c = c.parent ? byName.get(c.parent) : undefined, d++) {
    if (c.hide_render || c.exclude) return false;
  }
  return true;
}

/** Ces objets ne sont pas recalculables : seule la matrice enregistrée (jusqu'à 4.0) les donne exactement. */
const NOT_RECOMPUTED = new Set(['VertParent', 'Constrained']);

for (const tag of fixtures) {
  describe(`fichier ${tag}.blend`, () => {
    let truth: Truth;
    let scene: BlendScene;
    let file: BlendFile;
    const truthByName = new Map<string, Truth>();

    beforeAll(async () => {
      truth = JSON.parse(readFileSync(join(DIR, `${tag}.json`), 'utf8'));
      for (const o of truth.objects) truthByName.set(o.name, o);
      const data = load(`${tag}.blend`);
      file = new BlendFile(new Uint8Array(data));
      scene = await readBlendScene(data);
    });

    it('version, scène active, autres scènes signalées', () => {
      const [major, minor] = truth.blender as number[];
      expect(scene.blenderVersion).toBe(`${major}.${minor}`);
      expect(scene.name).toBe(truth.scene.name);
      for (const other of truth.scene.others as string[]) expect(scene.warnings.some((w) => w.includes(`« ${other} »`))).toBe(true);
      if (tag.endsWith('_full')) expect(file.bytes.length).toBeGreaterThan(readFileSync(join(DIR, `${tag}.blend`)).length); // compressé
      if (tag.includes('w32') || truth.blender[1] === 57) expect(file.pointerSize).toBe(4);
    });

    it('objets de la scène : noms, types, parents', () => {
      const objs = sceneObjects(scene, truth);
      expect(objs.map((o) => o.name).sort()).toEqual([...(truth.scene_objects as string[])].sort());
      for (const [i, o] of objs.entries()) {
        const t = truthByName.get(o.name);
        expect(t, o.name).toBeDefined();
        const expected = t.library || t.data_library ? 'empty' : t.type === 'MESH' ? 'mesh' : t.type === 'LIGHT' || t.type === 'LAMP' ? 'light' : t.type === 'CAMERA' ? 'camera' : 'empty';
        expect(o.type, o.name).toBe(expected);
        const parent = o.parent === null ? null : scene.objects[o.parent].name;
        if (!t.library) expect(parent, o.name).toBe(t.parent && (truth.scene_objects as string[]).includes(t.parent) ? t.parent : null);
        expect(o.parent).not.toBe(i);
      }
    });

    it('matrices monde recalculées (tous modes de rotation, deltas, parent inverse)', () => {
      const stored = file.sdna.byName.get('Object')!.byName.has('obmat') || file.sdna.byName.get('Object')!.byName.has('object_to_world');
      let checked = 0;
      for (const o of sceneObjects(scene, truth)) {
        const t = truthByName.get(o.name);
        if (!t || t.library || (!stored && NOT_RECOMPUTED.has(o.name))) continue;
        expect(close(o.matrixWorld.elements, t.matrix_world), `${o.name} : ${o.matrixWorld.elements.map((v) => v.toFixed(4))} ≠ ${t.matrix_world}`).toBe(true);
        checked++;
      }
      expect(checked).toBeGreaterThan(truth.scene_objects.length / 2);
    });

    it('maillages : positions, polygones, emplacements de matériaux, lissage', () => {
      let checked = 0;
      for (const o of sceneObjects(scene, truth)) {
        const t = truthByName.get(o.name);
        if (!t?.mesh || o.type !== 'mesh') continue;
        const m = scene.meshes[o.mesh!];
        expect(m.name).toBe(t.mesh.name);
        expect(m.weld).toBe(false);
        expect(close(m.positions, t.mesh.positions), `${o.name} positions`).toBe(true);
        expect(m.polygons.map((p) => Array.from(p)), `${o.name} polygones`).toEqual(t.mesh.polygons);
        const slots = m.polygonSlots ? Array.from(m.polygonSlots) : m.polygons.map(() => 0);
        expect(slots, `${o.name} matériaux par face`).toEqual(t.mesh.material_index);
        const smooth = (t.mesh.smooth as boolean[]).filter(Boolean).length;
        const n = t.mesh.smooth.length;
        if (!(t.modifiers as Truth[]).some((md) => md.type === 'NODES')) expect(!!o.shadeSmooth, `${o.name} lissage`).toBe(n > 0 && smooth * 2 >= n);
        if (o.shadeSmooth && t.mesh.auto_smooth !== undefined) {
          expect(o.autoSmoothAngle, `${o.name} angle`).toBeCloseTo(t.mesh.auto_smooth ? (t.mesh.auto_smooth_angle * 180) / Math.PI : 180, 3);
        }
        checked++;
      }
      expect(checked).toBeGreaterThan(tag.endsWith('_mini') ? 0 : 5);
      for (const [name, angle] of Object.entries((truth.expect.auto_smooth ?? {}) as Record<string, number>)) {
        const o = scene.objects.find((x) => x.name === name)!;
        expect(o.shadeSmooth).toBe(true);
        expect(o.autoSmoothAngle).toBeCloseTo(angle, 3);
      }
    });

    it('maillages partagés entre objets (données liées)', () => {
      const a = scene.objects.find((o) => o.name === 'LinkedA');
      const b = scene.objects.find((o) => o.name === 'LinkedB');
      if (!a || !b) return;
      expect(a.mesh).toBe(b.mesh);
    });

    it('emplacements de matériaux (objet et données)', () => {
      for (const o of sceneObjects(scene, truth)) {
        const t = truthByName.get(o.name);
        if (!t || o.type !== 'mesh' || !t.slots.length) continue;
        const names = (o.materials ?? []).map((i) => (i === null ? null : scene.materials[i].name));
        expect(names, o.name).toEqual((t.slots as Truth[]).map((s) => s.material));
      }
      const textured = Object.entries(truth.expect.materials as Record<string, Truth>).filter(([, m]) => m.textured).map(([n]) => n);
      expect(scene.texturedMaterials.map((t) => t.name).sort()).toEqual(textured.sort());
      for (const t of scene.texturedMaterials) expect(scene.materials[t.material].name).toBe(t.name);
    });

    it('collections, visibilité viewport et rendu, affichage', () => {
      if (truth.collections) {
        const ours = scene.collections.map((c) => ({ name: c.name, parent: c.parent === null ? null : scene.collections[c.parent].name, visible: c.visible }));
        const theirs = (truth.collections as Truth[]).map((c) => ({ name: c.name, parent: c.parent, visible: !(c.hide_viewport || c.exclude || c.layer_hide) }));
        expect(ours).toEqual(theirs);
        for (const c of truth.collections as Truth[]) {
          for (const name of c.objects as string[]) {
            const o = scene.objects.find((x) => x.name === name)!;
            expect(o.collection === null ? null : scene.collections[o.collection].name, name).toBe(c.name);
          }
        }
      }
      for (const o of sceneObjects(scene, truth)) {
        const t = truthByName.get(o.name);
        if (!t) continue;
        expect(o.visible !== false && colVisible(scene, o.collection), `${o.name} visible`).toBe(truthVisible(truth, t));
        expect(o.renderable !== false, `${o.name} rendu`).toBe(truthRenderable(truth, t));
        if (o.type === 'mesh') expect(o.displayAs ?? 'solid', o.name).toBe(t.display === 'WIRE' ? 'wire' : t.display === 'BOUNDS' ? 'bounds' : 'solid');
      }
    });

    it('modificateurs traduits exactement, les autres mettent l\'objet en attente', () => {
      for (const [name, list] of Object.entries(truth.expect.native_modifiers as Record<string, Truth[]>)) {
        const o = scene.objects.find((x) => x.name === name)!;
        const mods = (o.modifiers ?? []).filter((m) => m.enabled !== false);
        expect(mods.map((m) => m.type), name).toEqual(list.map((m) => m.type));
        list.forEach((exp, k) => {
          const got = mods[k] as Truth;
          for (const [key, value] of Object.entries(exp)) {
            if (key === 'type') continue;
            if (key === 'target') expect(scene.objects[got.target].name).toBe(value);
            else if (Array.isArray(value)) expect(close(got.params[key], value as number[]), `${name}.${key}`).toBe(true);
            else if (typeof value === 'number') expect(got.params[key], `${name}.${key}`).toBeCloseTo(value, 3);
            else expect(got.params[key], `${name}.${key}`).toBe(value);
          }
        });
      }
    });

    it('objets en attente (courbes, textes, modificateurs, bibliothèques…) avec repli', () => {
      const pending = new Map(scene.pending.map((p) => [p.name, p]));
      for (const [name, reason] of Object.entries(truth.expect.pending as Record<string, string>)) {
        const p = pending.get(name);
        expect(p, name).toBeDefined();
        expect(p!.reason.startsWith(reason), `${name} : ${p!.reason}`).toBe(true);
        expect(scene.objects[p!.object].name).toBe(name);
      }
      // Ce qui est traduit nativement ne doit pas être en attente.
      for (const o of sceneObjects(scene, truth)) {
        const t = truthByName.get(o.name);
        if (!t || t.name in truth.expect.pending) continue;
        const native = (truth.expect.native_modifiers[t.name] && !(t.name in truth.expect.pending)) || (t.modifiers.length === 0 && ['MESH', 'EMPTY', 'LIGHT', 'LAMP', 'CAMERA'].includes(t.type) && !t.library && !t.data_library && t.name !== 'ShapeKeyZero');
        if (native) expect(pending.has(o.name), o.name).toBe(false);
      }
      expect(pending.has('ShapeKeyZero')).toBe(false);
      for (const [name] of Object.entries(truth.expect.empties as Record<string, string>)) {
        const o = scene.objects.find((x) => x.name === name)!;
        expect(o.type === 'empty' || (o.type === 'mesh' && scene.meshes[o.mesh!].polygons.length === 0), name).toBe(true);
        expect(pending.has(name)).toBe(false);
      }
    });

    it('instances de collections développées (décalage, imbrication, anti-récursion)', () => {
      const instancers = (truth.expect.instancers ?? []) as string[];
      const n = truth.scene_objects.length;
      if (truth.expect.recursive) {
        // Collection qui s'instancie elle-même : Blender n'en donne pas de vérité comparable
        // (profondeur propre à chaque lecteur). Arrêt propre exigé, nombre d'objets borné, et la
        // première copie du maillage est bien placée sous l'instanciateur.
        expect(scene.objects.length).toBeLessThan(200);
        const outer = scene.objects.findIndex((o) => o.name === 'RecOuter');
        const copy = scene.objects.findIndex((o, i) => i >= n && o.name === 'RecMesh' && o.parent === outer);
        expect(outer).toBeGreaterThanOrEqual(0);
        expect(copy, 'copie de RecMesh sous RecOuter').toBeGreaterThanOrEqual(0);
        expect(close(scene.objects[copy].matrixWorld.elements, scene.objects[outer].matrixWorld.elements)).toBe(true);
        // Blender 2.8+ refuse de créer le cycle ; les versions antérieures l'enregistrent.
        if (truthByName.get('RecInner')?.instance_collection) {
          expect(scene.warnings.some((w) => /récursi/i.test(w)), 'récursion signalée').toBe(true);
        }
        return;
      }
      const top = (i: number): number => {
        let k = i;
        for (let d = 0; k >= n && d < 64; d++) k = scene.objects[k].parent!;
        return k;
      };
      const ours = new Map<string, number[][]>();
      for (let i = n; i < scene.objects.length; i++) {
        const key = `${scene.objects[top(i)].name}>${scene.objects[i].name}`;
        if (!ours.has(key)) ours.set(key, []);
        ours.get(key)!.push(Array.from(scene.objects[i].matrixWorld.elements));
      }
      const theirs = new Map<string, number[][]>();
      for (const inst of truth.instances as Truth[]) {
        if (!instancers.includes(inst.instancer)) continue;
        const key = `${inst.instancer}>${inst.object}`;
        if (!theirs.has(key)) theirs.set(key, []);
        theirs.get(key)!.push(inst.matrix_world);
      }
      expect([...ours.keys()].sort()).toEqual([...theirs.keys()].sort());
      for (const [key, mats] of theirs) for (const m of mats) expect(ours.get(key)!.some((x) => close(x, m)), key).toBe(true);
    });

    it('lumières : type, couleur, puissance, rayon, cône, taille, ombres', () => {
      const legacy = truth.blender[0] < 2 || (truth.blender[0] === 2 && truth.blender[1] < 80);
      // Avant 2.80, les lampes n'ont pas d'unité : la référence est ce qu'en fait Blender 2.93 en
      // ouvrant le fichier (scripts/blend-fixtures/legacy_truth.py → *_as293.json).
      const asModern = legacy && existsSync(join(DIR, `${tag}_as293.json`)) ? JSON.parse(readFileSync(join(DIR, `${tag}_as293.json`), 'utf8')).lights : null;
      if (legacy && tag.endsWith('_full')) expect(asModern, 'vérité *_as293.json').not.toBeNull();
      // Blender 4.2+ écrit `energy_new` (interface) et `energy` (compatibilité, ancienne
      // normalisation des surfaciques, × 4/π) : le lecteur lit `energy`, cf. lights.ts.
      const twoEnergies = file.sdna.byName.get('Lamp')?.byName.has('energy_new') ?? false;
      let checked = 0;
      for (const o of sceneObjects(scene, truth)) {
        const t = truthByName.get(o.name);
        if (!t?.light || o.type !== 'light' || t.library || t.data_library) continue;
        const l = o.light!;
        const L = t.light;
        const kind = L.type === 'SUN' || L.type === 'HEMI' ? 'sun' : L.type === 'SPOT' ? 'spot' : L.type === 'AREA' ? 'area' : 'point';
        expect(l.kind, o.name).toBe(kind);
        expect(sameHex(l.color!, hex(L.color)), `${o.name} couleur ${l.color} ≠ ${hex(L.color)}`).toBe(true);
        const M = asModern?.[t.data];
        if (legacy) expect(M, `${o.name} absent de la vérité 2.93`).toBeDefined();
        const ref = legacy ? M : L;
        const power = !legacy && kind === 'area' && twoEnergies ? (ref.energy * 4) / Math.PI : ref.energy;
        expect(l.power!, `${o.name} puissance`).toBeCloseTo(power, 3);
        expect(l.castShadow, `${o.name} ombres`).toBe(ref.use_shadow);
        if (kind !== 'area') expect(l.radius!, `${o.name} rayon`).toBeCloseTo(L.shadow_soft_size, 4);
        if (kind === 'spot') {
          expect(l.spotAngle!, `${o.name} cône`).toBeCloseTo((ref.spot_size * 180) / Math.PI, 3);
          expect(l.spotBlend!, `${o.name} adoucissement`).toBeCloseTo(L.spot_blend, 4);
        }
        if (kind === 'area') {
          expect(l.sizeX!, `${o.name} taille X`).toBeCloseTo(L.size, 4);
          expect(l.sizeY!, `${o.name} taille Y`).toBeCloseTo(L.shape === 'RECTANGLE' || L.shape === 'ELLIPSE' ? L.size_y : L.size, 4);
        }
        checked++;
      }
      if (tag.endsWith('_full')) expect(checked).toBeGreaterThanOrEqual(4);
    });

    it('caméras : type, champ vertical (cadre de Blender), ortho, découpe, profondeur de champ', () => {
      let checked = 0;
      for (const o of sceneObjects(scene, truth)) {
        const t = truthByName.get(o.name);
        if (!t?.camera || o.type !== 'camera') continue;
        const c = o.camera!;
        const C = t.camera;
        expect(c.kind, o.name).toBe(C.type === 'ORTHO' ? 'ortho' : 'persp');
        if (C.frame) {
          // Cadre de la caméra calculé par Blender (view_frame) : hauteur visible et distance.
          const ys = (C.frame as number[][]).map((p) => p[1]);
          const height = Math.max(...ys) - Math.min(...ys);
          const depth = Math.abs((C.frame as number[][])[0][2]);
          if (c.kind === 'persp') expect(c.fov!, `${o.name} champ vertical`).toBeCloseTo((2 * Math.atan(height / 2 / depth) * 180) / Math.PI, 3);
          else expect(c.orthoScale!, `${o.name} hauteur ortho`).toBeCloseTo(height, 4);
        } else {
          // Blender 2.57 n'a pas view_frame : `angle` couvre la plus grande dimension de l'image
          // (capteur de 32 mm), d'où le champ vertical d'après le format du rendu.
          const R = truth.scene.render;
          const w = R.resolution_x * R.pixel_aspect_x;
          const h = R.resolution_y * R.pixel_aspect_y;
          const k = w >= h ? h / w : 1;
          if (c.kind === 'persp') expect(c.fov!, `${o.name} champ vertical`).toBeCloseTo((2 * Math.atan(Math.tan(C.angle_y / 2) * k) * 180) / Math.PI, 3);
          else expect(c.orthoScale!, `${o.name} hauteur ortho`).toBeCloseTo(C.ortho_scale * k, 4);
        }
        expect(c.near!, `${o.name} near`).toBeCloseTo(C.clip_start, 5);
        expect(c.far!, `${o.name} far`).toBeCloseTo(C.clip_end, 3);
        if (C.dof) {
          expect(c.dofEnabled, `${o.name} profondeur de champ`).toBe(C.dof.use);
          expect(c.focusDistance!, `${o.name} mise au point`).toBeCloseTo(C.dof.distance, 4);
          expect(c.fstop!, `${o.name} ouverture`).toBeCloseTo(C.dof.fstop, 4);
        } else if (C.dof_legacy) {
          if (C.dof_legacy.distance > 0) expect(c.focusDistance!, `${o.name} mise au point`).toBeCloseTo(C.dof_legacy.distance, 4);
          if (C.dof_legacy.aperture_type === 'FSTOP') {
            expect(c.dofEnabled, `${o.name} profondeur de champ`).toBe(true);
            expect(c.fstop!, `${o.name} ouverture`).toBeCloseTo(C.dof_legacy.aperture_fstop, 4);
          }
        }
        checked++;
      }
      expect(checked).toBeGreaterThanOrEqual(tag.endsWith('_full') ? 2 : 1);
    });

    it('matériaux : Principled, verre, émission, mélanges, transparence, sans nœuds', () => {
      const byName = new Map(scene.materials.map((m) => [m.name, m]));
      const lerp = (a: number[], b: number[], f: number) => a.map((v, i) => v * (1 - f) + b[i] * f);
      for (const [name, e] of Object.entries((truth.expect.materials ?? {}) as Record<string, Truth>)) {
        const m = byName.get(name);
        if (!m) continue; // matériau non utilisé par un objet de la scène
        const col = (got: string, want: number[], what: string) => expect(sameHex(got, hex(want)), `${name} ${what} ${got} ≠ ${hex(want)}`).toBe(true);
        switch (e.kind) {
          case 'principled':
            if (e.base_color) col(m.baseColor, e.base_color, 'couleur');
            if (e.metallic !== undefined) expect(m.metallic, `${name} métal`).toBeCloseTo(e.metallic, 4);
            expect(m.roughness, `${name} rugosité`).toBeCloseTo(e.roughness, 4);
            if (e.ior !== undefined) expect(m.ior, `${name} IOR`).toBeCloseTo(e.ior, 4);
            if (e.alpha !== undefined) expect(m.alpha, `${name} alpha`).toBeCloseTo(e.alpha, 4);
            if (e.emission) {
              col(m.emission, e.emission, 'émission');
              expect(m.emissionStrength, `${name} force d'émission`).toBeCloseTo(e.emission_strength, 4);
            }
            if (e.transmission !== undefined) expect(m.transmission, `${name} transmission`).toBeCloseTo(e.transmission, 4);
            break;
          case 'glass':
            col(m.baseColor, e.base_color, 'couleur');
            expect(m.roughness, `${name} rugosité`).toBeCloseTo(e.roughness, 4);
            expect(m.ior, `${name} IOR`).toBeCloseTo(e.ior, 4);
            expect(m.transmission, `${name} transmission`).toBe(1);
            break;
          case 'emission':
            col(m.emission, e.emission, 'émission');
            expect(m.emissionStrength, `${name} force d'émission`).toBeCloseTo(e.emission_strength, 4);
            break;
          case 'diffuse':
            col(m.baseColor, e.base_color, 'couleur');
            break;
          case 'mix':
            // Mix Shader : (1 − fac) × A + fac × B, en linéaire.
            col(m.baseColor, lerp(e.a, e.b, e.fac), 'couleur mélangée');
            expect(m.metallic, `${name} métal (part du Glossy)`).toBeCloseTo(e.fac, 4);
            break;
          case 'transparent_mix':
            col(m.baseColor, e.base_color, 'couleur');
            expect(m.alpha, `${name} alpha`).toBeCloseTo(e.alpha, 4);
            break;
          case 'no_nodes':
            if (e.use_nodes) break; // Blender 5 : arbre de nœuds par défaut, valeurs du Principled
            col(m.baseColor, e.base_color, 'couleur');
            if (e.metallic !== undefined) expect(m.metallic, `${name} métal`).toBeCloseTo(e.metallic, 4);
            if (e.roughness !== undefined) expect(m.roughness, `${name} rugosité`).toBeCloseTo(e.roughness, 4);
            if (e.hardness !== undefined) {
              // Blender Internal : conversion documentée dans materials.ts.
              expect(m.alpha, `${name} alpha`).toBeCloseTo(e.alpha, 4);
              expect(m.metallic, `${name} miroir → métal`).toBeCloseTo(e.mirror, 4);
              expect(m.roughness, `${name} dureté → rugosité`).toBeCloseTo(Math.sqrt(2 / (e.hardness + 2)), 4);
              expect(m.emissionStrength, `${name} emit`).toBeCloseTo(e.emit, 4);
            }
            break;
        }
      }
    });

    it('monde et rendu', () => {
      const W = truth.scene.world;
      if (W && W.mode && scene.world) {
        expect(scene.world.mode, 'mode du monde').toBe(W.mode);
        expect(scene.world.strength!, 'force du monde').toBeCloseTo(W.strength, 4);
        if (W.mode === 'sky') {
          if (W.sun_elevation !== undefined) {
            expect(scene.world.sunElevation!, 'élévation').toBeCloseTo(W.sun_elevation, 3);
            expect(scene.world.sunAzimuth!, 'azimut').toBeCloseTo(W.sun_rotation, 3);
          } else {
            const d = W.sun_direction as number[];
            expect(scene.world.sunElevation!, 'élévation').toBeCloseTo((Math.asin(d[2]) * 180) / Math.PI, 3);
            expect(scene.world.sunAzimuth!, 'azimut').toBeCloseTo(((Math.atan2(d[0], d[1]) * 180) / Math.PI + 360) % 360, 3);
          }
        } else if (W.expect_color) {
          expect(sameHex(scene.world.color!, hex(W.expect_color)), `couleur du monde ${scene.world.color}`).toBe(true);
        }
      }
      const R = truth.scene.render;
      const r = scene.render!;
      expect(r.resX).toBe(Math.floor((R.resolution_x * R.resolution_percentage) / 100));
      expect(r.resY).toBe(Math.floor((R.resolution_y * R.resolution_percentage) / 100));
      expect(r.engine).toBe(R.engine === 'CYCLES' ? 'pathtrace' : 'realtime');
      if (R.engine === 'CYCLES' && R.cycles_samples !== undefined) expect(r.samples).toBe(R.cycles_samples);
      expect(!!r.transparentBg, 'fond transparent').toBe(R.film_transparent);
      if (R.view_transform) {
        const tm = R.view_transform === 'AgX' ? 'agx' : String(R.view_transform).startsWith('Filmic') ? 'filmic' : 'standard';
        expect(r.toneMapping).toBe(tm);
        expect(r.exposure!).toBeCloseTo(R.exposure, 4);
      }
    });

    it('caméra active, avertissements regroupés', () => {
      const cam = scene.activeCamera;
      expect(cam === null || cam === undefined ? null : scene.objects[cam].name).toBe(truth.scene.camera);
      const warn = scene.warnings.join('\n');
      const keys: Record<string, RegExp> = { vertex_parent: /Parentage à un sommet/, constraint: /Contraintes/, animation: /Animation/ };
      for (const w of truth.expect.warn as string[]) expect(warn, w).toMatch(keys[w]);
      // Une phrase par cause, pas une par objet.
      expect(new Set(scene.warnings).size).toBe(scene.warnings.length);
    });

    it('applyImportedScene sur un vrai SceneDoc', () => {
      const doc = SceneDoc.createNew('Test');
      const before = doc.listObjects().length; // scène par défaut (cube, lumière, caméra)
      const res = applyImportedScene(doc, scene, { mode: 'open' });
      expect(res.objectIds.length).toBeGreaterThanOrEqual(scene.objects.length);
      const objs = doc.listObjects();
      expect(objs.length - before).toBe(res.objectIds.length);
      for (const id of res.objectIds) expect(doc.getObject(id), id).not.toBeNull();
      const cube = objs.find((o) => o.name === (tag.endsWith('_mini') ? 'MiniCube' : 'Child') && res.objectIds.includes(o.id))!;
      expect(cube.type).toBe('mesh');
      const mesh = doc.getMesh(cube.data!)!;
      expect(mesh.verts.size).toBe(8);
      expect(mesh.faces.size).toBe(6);
      if (truth.scene.camera) expect(doc.getScene().activeCamera).not.toBeNull();
    });
  });
}

describe('fichiers sans scène (bibliothèques d\'assets, bpy.data.libraries.write)', () => {
  const assets = readdirSync(DIR).filter((f) => /^b\d+(w32)?_asset\.json$/.test(f)).map((f) => f.replace(/\.json$/, ''));
  it('au moins une fixture présente', () => expect(assets.length).toBeGreaterThan(0));
  for (const tag of assets) {
    it(`${tag} : objets à la racine, maillage et matériaux repris`, async () => {
      const truth = JSON.parse(readFileSync(join(DIR, `${tag}.json`), 'utf8'));
      const file = new BlendFile(new Uint8Array(load(`${tag}.blend`)));
      expect(file.blocksOf('SC').length).toBe(0);
      const scene = await readBlendScene(load(`${tag}.blend`));
      expect(scene.objects.map((o) => o.name).sort()).toEqual((truth.objects as Truth[]).map((o) => o.name).sort());
      expect(scene.warnings.some((w) => /sans scène/.test(w))).toBe(true);
      for (const t of truth.objects as Truth[]) {
        const o = scene.objects.find((x) => x.name === t.name)!;
        expect(o.collection).toBeNull();
        expect(close(o.matrixWorld.elements, t.matrix_world), `${t.name} matrice`).toBe(true);
        const m = scene.meshes[o.mesh!];
        expect(close(m.positions, t.mesh.positions)).toBe(true);
        expect(m.polygons.map((p) => Array.from(p))).toEqual(t.mesh.polygons);
        expect(Array.from(m.polygonSlots ?? m.polygons.map(() => 0))).toEqual(t.mesh.material_index);
        expect((o.materials ?? []).map((i) => (i === null ? null : scene.materials[i].name))).toEqual(t.slots);
      }
      const doc = SceneDoc.createNew('Test');
      const res = applyImportedScene(doc, scene);
      expect(res.counts.meshes).toBeGreaterThan(0);
    });
  }
});

describe('fichiers abîmés', () => {
  const sample = fixtures.find((f) => f.startsWith('b501_mini')) ?? fixtures[fixtures.length - 1];

  it('fichier tronqué : erreur claire', async () => {
    const data = new Uint8Array(load(`${sample}.blend`));
    for (const cut of [5, 11, 40, Math.floor(data.length / 3), data.length - 3]) {
      await expect(readBlendScene(data.slice(0, cut).buffer)).rejects.toThrow(/\.blend|Blender/);
    }
  });

  it('fichier compressé tronqué : erreur claire (gzip et zstd)', async () => {
    const zstd = fixtures.find((f) => f === 'b501_full');
    if (zstd) {
      const data = new Uint8Array(load(`${zstd}.blend`));
      await expect(readBlendScene(data.slice(0, data.length >> 1).buffer)).rejects.toThrow(/zstd|\.blend/);
    }
    // Copie dans un Uint8Array ordinaire : `Buffer.slice` de Node renvoie une VUE, dont `.buffer`
    // redonnerait le fichier entier.
    const gz = new Uint8Array(gzipSync(new Uint8Array(load(`${sample}.blend`))));
    await expect(readBlendScene(gz.slice(0, gz.length >> 1).buffer)).rejects.toThrow(/gzip|\.blend/);
    // Le même fichier compressé en entier est lu.
    const ok = await readBlendScene(gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength) as ArrayBuffer);
    expect(ok.objects.length).toBeGreaterThan(0);
  });

  it('zstd sans table de positionnement : décompression en flux identique', async () => {
    const zstd = fixtures.find((f) => f === 'b501_full');
    if (!zstd) return;
    const data = new Uint8Array(load(`${zstd}.blend`));
    // Retire la trame « ignorable » finale qui porte la table (taille lue dans son en-tête).
    const view = new DataView(data.buffer);
    let p = 0;
    let cut = -1;
    while (p + 8 <= data.length) {
      const magic = view.getUint32(p, true);
      if (magic === 0x184d2a5e) {
        cut = p;
        break;
      }
      if (magic !== 0xfd2fb528) break;
      // Trame zstd : on cherche la suivante en parcourant ses blocs (en-tête de 3 octets).
      const flg = data[p + 4];
      const ss = (flg >> 5) & 1;
      const fcf = flg >> 6;
      const did = [0, 1, 2, 4][flg & 3];
      let q = p + 5 + (ss ? 0 : 1) + did + (fcf ? 1 << fcf : ss);
      for (;;) {
        const h = data[q] | (data[q + 1] << 8) | (data[q + 2] << 16);
        const type = (h >> 1) & 3;
        const size = h >> 3;
        q += 3 + (type === 1 ? 1 : size);
        if (h & 1) break;
      }
      if (flg & 4) q += 4;
      p = q;
    }
    expect(cut).toBeGreaterThan(0);
    const stripped = data.slice(0, cut);
    const { decompressBlend, decompressBlendAsync } = await import('../src/engine/io/blend/decompress');
    const viaStream = await decompressBlendAsync(stripped, async () => {});
    expect(Buffer.from(viaStream).equals(Buffer.from(decompressBlend(data)))).toBe(true);
    const scene = await readBlendScene(stripped.buffer);
    expect(scene.objects.length).toBe((await readBlendScene(data.buffer)).objects.length);
  });

  it('pas un .blend : erreur claire', async () => {
    await expect(readBlendScene(new TextEncoder().encode('ceci n’est pas un fichier Blender').buffer as ArrayBuffer)).rejects.toThrow(/Blender/);
    await expect(readBlendScene(new ArrayBuffer(0))).rejects.toThrow();
  });

  it('octets corrompus : erreur ou lecture partielle, jamais de blocage', async () => {
    const base = new Uint8Array(load(`${sample}.blend`));
    let seed = 12345;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let trial = 0; trial < 25; trial++) {
      const data = base.slice();
      for (let k = 0; k < 200; k++) data[12 + Math.floor(rand() * (data.length - 12))] = Math.floor(rand() * 256);
      const t0 = Date.now();
      try {
        const s = await readBlendScene(data.buffer);
        expect(Array.isArray(s.objects)).toBe(true);
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
      }
      expect(Date.now() - t0).toBeLessThan(5000);
    }
  });

  it('en-têtes de blocs aux longueurs absurdes : erreur, pas d\'allocation géante', async () => {
    const data = new Uint8Array(load(`${sample}.blend`)).slice();
    const file = new BlendFile(data);
    const view = new DataView(data.buffer);
    // Longueur du 3e bloc portée à 2 Gio (champ len de l'en-tête de bloc, 8 octets après le code en 5.x).
    const head = file.pos[2] - (file.version >= 500 ? 32 : file.pointerSize === 8 ? 24 : 20);
    if (file.version >= 500) view.setUint32(head + 16, 0x7fffffff, true);
    else view.setInt32(head + 4, 0x7fffffff, true);
    await expect(readBlendScene(data.buffer)).rejects.toThrow(/tronqué|corrompu/);
  });
});
