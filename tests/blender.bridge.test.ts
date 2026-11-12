import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  blenderArgs,
  convertBlendBytesToGLB,
  convertBlendToGLB,
  evaluateBlend,
  evaluateBlendBytes,
  findBlender,
  type BlendEvalReport,
} from '../electron/blenderBridge';
import type { BlendEvalMesh } from '../src/engine/io/types';

/**
 * Pont Blender, contre de VRAIS Blender. Chaque version disponible fabrique elle-même, en
 * arrière-plan et dans un dossier temporaire, le petit .blend de test (aucun fichier de
 * l'utilisateur n'est ouvert), puis le pont l'évalue et le convertit. Sans Blender sur la
 * machine, tous les tests sont sautés.
 */

const KNOWN = ['5.1', '5.0', '4.3']
  .map((v) => path.join('C:\\Program Files\\Blender Foundation', `Blender ${v}`, 'blender.exe'))
  .filter((exe) => fs.existsSync(exe));
// Autre machine : le Blender que le pont trouve tout seul (PATH, installeur, Steam…).
const located = KNOWN.length === 0 ? await findBlender() : null;
const targets = KNOWN.length > 0 ? KNOWN : located ? [located.exe] : [];
const none = targets.length === 0;

const LAUNCH_TIMEOUT = 120_000;
/** Dossiers de travail du pont déjà présents avant les tests (restes éventuels d'un arrêt brutal). */

/** Scène de test : cube à modificateur, courbe, texte, instances, matériaux texturés, lumière, caméra. */
const FIXTURE_SCRIPT = String.raw`import json
import os
import sys

import bpy

out_dir = sys.argv[sys.argv.index("--") + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
col = scene.collection


def add_object(name, data):
    ob = bpy.data.objects.new(name, data)
    col.objects.link(ob)
    return ob


def principled(mat):
    try:
        mat.use_nodes = True
    except Exception:
        pass
    tree = mat.node_tree
    for node in tree.nodes:
        if node.type == "BSDF_PRINCIPLED":
            return tree, node
    out = tree.nodes.new("ShaderNodeOutputMaterial")
    node = tree.nodes.new("ShaderNodeBsdfPrincipled")
    tree.links.new(node.outputs[0], out.inputs["Surface"])
    return tree, node


def textured(name, image, reroute):
    mat = bpy.data.materials.new(name)
    tree, bsdf = principled(mat)
    tex = tree.nodes.new("ShaderNodeTexImage")
    tex.image = image
    source = tex.outputs["Color"]
    if reroute:
        relay = tree.nodes.new("NodeReroute")
        tree.links.new(source, relay.inputs[0])
        source = relay.outputs[0]
    tree.links.new(source, bsdf.inputs["Base Color"])
    return mat


def solid_image(name, rgba, size):
    img = bpy.data.images.new(name, size, size, alpha=True)
    img.pixels.foreach_set(list(rgba) * (size * size))
    return img


def cube_mesh(name, half):
    me = bpy.data.meshes.new(name)
    v = [(-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1), (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)]
    f = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    me.from_pydata([(x * half, y * half, z * half) for x, y, z in v], [], f)
    me.update()
    return me


# Texture unie EMPAQUETEE dans le .blend (204, 51, 102 sur 255 = #cc3366).
packed = solid_image("Unie", (204 / 255, 51 / 255, 102 / 255, 1.0), 64)
packed.pack()

# Texture sur disque, a cote du .blend (chemin relatif) : bleu pur.
disk_path = os.path.join(out_dir, "tex_disque.png")
tmp = solid_image("Tmp", (0.0, 0.0, 1.0, 1.0), 4)
tmp.filepath_raw = disk_path
tmp.file_format = "PNG"
tmp.save()
lost_path = os.path.join(out_dir, "perdue.png")
tmp.filepath_raw = lost_path
tmp.save()
bpy.data.images.remove(tmp)
disk = bpy.data.images.load(disk_path)
disk.filepath = "//tex_disque.png"
lost = bpy.data.images.load(lost_path)
lost.filepath = "//perdue.png"

mat_packed = textured("MatTexture", packed, True)
mat_disk = textured("MatDisque", disk, False)
mat_lost = textured("MatPerdue", lost, False)
mat_plain = bpy.data.materials.new("MatUni")
principled(mat_plain)[1].inputs["Base Color"].default_value = (0.1, 0.8, 0.1, 1.0)
for mat in (mat_packed, mat_disk, mat_lost, mat_plain):
    mat.use_fake_user = True

# Cube + modificateur Reseau (2 copies non soudees) : 16 sommets, 12 faces.
cube = add_object("Cube", cube_mesh("Cube", 1.0))
cube.data.materials.append(mat_packed)
array = cube.modifiers.new("Reseau", "ARRAY")
array.count = 2
array.use_relative_offset = True
array.relative_offset_displace = (1.5, 0.0, 0.0)
array.use_merge_vertices = False

# Courbe de Bezier avec biseau (un tube).
cu = bpy.data.curves.new("Courbe", "CURVE")
cu.dimensions = "3D"
sp = cu.splines.new("BEZIER")
sp.bezier_points.add(1)
for point, co in zip(sp.bezier_points, ((0.0, 0.0, 0.0), (2.0, 0.0, 0.0))):
    point.co = co
    point.handle_left_type = "AUTO"
    point.handle_right_type = "AUTO"
cu.bevel_depth = 0.1
cu.bevel_resolution = 2
curve = add_object("Courbe", cu)
curve.location = (0.0, 3.0, 0.0)
cu.materials.append(mat_plain)

# Texte extrude.
font = bpy.data.curves.new("Texte", "FONT")
font.body = "CF"
font.extrude = 0.05
text = add_object("Texte", font)
text.location = (0.0, 6.0, 0.0)

# Instances sur les sommets d'un plan (4 briques), l'instancier etant deplace et tourne.
plane = bpy.data.meshes.new("Emetteur")
plane.from_pydata([(-1, -1, 0), (1, -1, 0), (1, 1, 0), (-1, 1, 0)], [], [(0, 1, 2, 3)])
plane.update()
emitter = add_object("Emetteur", plane)
emitter.location = (3.0, -5.0, 1.0)
emitter.rotation_euler = (0.0, 0.0, 0.5)
brick = add_object("Brique", cube_mesh("Brique", 0.1))
brick.data.materials.append(mat_plain)
brick.parent = emitter
emitter.instance_type = "VERTS"

# Noeuds de geometrie : 3 cubes instancies sur une ligne (API des noeuds variable selon la version).
gn = False
try:
    tree = bpy.data.node_groups.new("Semis", "GeometryNodeTree")
    if hasattr(tree, "interface"):
        tree.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    else:
        tree.outputs.new("NodeSocketGeometry", "Geometry")
    out = tree.nodes.new("NodeGroupOutput")
    line = tree.nodes.new("GeometryNodeMeshLine")
    line.inputs["Count"].default_value = 3
    box = tree.nodes.new("GeometryNodeMeshCube")
    place = tree.nodes.new("GeometryNodeInstanceOnPoints")
    tree.links.new(line.outputs["Mesh"], place.inputs["Points"])
    tree.links.new(box.outputs["Mesh"], place.inputs["Instance"])
    tree.links.new(place.outputs["Instances"], out.inputs[0])
    host = bpy.data.meshes.new("Noeuds")
    host.from_pydata([(0, 0, 0), (1, 0, 0), (0, 1, 0)], [], [(0, 1, 2)])
    host.update()
    nodes = add_object("Noeuds", host)
    nodes.location = (-6.0, 0.0, 0.0)
    mod = nodes.modifiers.new("Semis", "NODES")
    mod.node_group = tree
    gn = True
except Exception as err:
    print("noeuds de geometrie indisponibles :", err)

lamp = add_object("Lampe", bpy.data.lights.new("Lampe", "POINT"))
lamp.location = (4.0, 1.0, 6.0)
cam = add_object("Camera", bpy.data.cameras.new("Camera"))
cam.location = (7.0, -7.0, 5.0)
scene.camera = cam
add_object("Vide", None)

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out_dir, "scene.blend"), compress=False)
os.remove(lost_path)
with open(os.path.join(out_dir, "fixture.json"), "w", encoding="utf-8") as f:
    json.dump({"gn": gn, "version": ".".join(str(n) for n in bpy.app.version)}, f)
`;

const REQUEST = {
  objects: ['Cube', 'Courbe', 'Texte', 'Emetteur', 'Noeuds', 'Vide', 'Lampe', 'Absent'],
  materials: ['MatTexture', 'MatDisque', 'MatPerdue', 'MatUni', 'Absent'],
};

function sha(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Dossiers de travail créés par le pont dans CE processus (d'autres processus peuvent utiliser
 * le pont en même temps : on ne compte pas leurs dossiers).
 */
const createdWorkDirs: string[] = [];
const realMkdtemp = fs.promises.mkdtemp.bind(fs.promises);
vi.spyOn(fs.promises, 'mkdtemp').mockImplementation((async (prefix: string, options?: unknown) => {
  const dir = String(await realMkdtemp(prefix, options as BufferEncoding));
  if (path.basename(dir).startsWith('coforge-blender-')) createdWorkDirs.push(dir);
  return dir;
}) as typeof fs.promises.mkdtemp);

function bounds(mesh: BlendEvalMesh): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i++) {
    const k = i % 3;
    min[k] = Math.min(min[k], mesh.positions[i]);
    max[k] = Math.max(max[k], mesh.positions[i]);
  }
  return { min, max };
}

/** Maillage bien formé : coordonnées finies, indices valides, un emplacement par polygone. */
function expectWellFormed(mesh: BlendEvalMesh | undefined): asserts mesh is BlendEvalMesh {
  expect(mesh).toBeDefined();
  const m = mesh!;
  const count = m.positions.length / 3;
  expect(Number.isInteger(count)).toBe(true);
  expect(m.positions.every(Number.isFinite)).toBe(true);
  expect(m.polygons.length).toBeGreaterThan(0);
  for (const poly of m.polygons) {
    expect(poly.length).toBeGreaterThanOrEqual(3);
    for (const v of poly) expect(v >= 0 && v < count && Number.isInteger(v)).toBe(true);
  }
  expect(m.slots?.length).toBe(m.polygons.length);
}

function hexChannels(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

/** Entête et bloc JSON d'un glTF binaire. */
function parseGLB(glb: Uint8Array): { magic: string; version: number; length: number; json: any } {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
  return { magic: String.fromCharCode(...glb.subarray(0, 4)), version: view.getUint32(4, true), length: view.getUint32(8, true), json };
}

describe('pont Blender', () => {
  it.skipIf(!none)('aucun Blender sur cette machine : le pont le dit sans planter', async () => {
    expect(await findBlender()).toBeNull();
    await expect(evaluateBlend(path.join(os.tmpdir(), 'absent.blend'), { objects: ['Cube'] })).rejects.toThrow(/introuvable/);
  });

  for (const exe of none ? ['(aucun Blender installé)'] : targets) {
    describe(none ? exe : path.basename(path.dirname(exe)), () => {
      let dir = '';
      let blend = '';
      let fixture = { gn: false, version: '' };
      let before = '';
      let byPath: BlendEvalReport;
      const previousEnv = process.env.COFORGE_BLENDER;

      beforeAll(async () => {
        if (none) return;
        process.env.COFORGE_BLENDER = exe;
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coforge-test-'));
        const script = path.join(dir, 'fixture.py');
        fs.writeFileSync(script, FIXTURE_SCRIPT, 'utf8');
        const r = spawnSync(exe, ['--background', '--factory-startup', '-noaudio', '--python-exit-code', '1', '--python', script, '--', dir], {
          encoding: 'utf8',
          timeout: LAUNCH_TIMEOUT,
          windowsHide: true,
        });
        blend = path.join(dir, 'scene.blend');
        if (r.status !== 0 || !fs.existsSync(blend)) throw new Error(`Fabrication du .blend de test impossible :\n${r.stdout}\n${r.stderr}`);
        fixture = JSON.parse(fs.readFileSync(path.join(dir, 'fixture.json'), 'utf8'));
        before = sha(blend);
        byPath = await evaluateBlend(blend, REQUEST);
      }, LAUNCH_TIMEOUT * 2);

      afterAll(() => {
        if (previousEnv === undefined) delete process.env.COFORGE_BLENDER;
        else process.env.COFORGE_BLENDER = previousEnv;
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
      });

      it.skipIf(none)('trouve le Blender désigné et sa version', async () => {
        const found = await findBlender();
        expect(found?.exe).toBe(exe);
        expect(found?.version).toMatch(/^\d+\.\d+(\.\d+)?$/);
        expect(fixture.version.startsWith(found!.version.split('.').slice(0, 2).join('.'))).toBe(true);
        expect(byPath.blenderVersion).toBe(fixture.version);
      });

      it.skipIf(none)('lance Blender en arrière-plan, réglages d’usine, scripts du fichier désactivés', () => {
        const args = blenderArgs('a.blend', 's.py', ['x']);
        expect(args.slice(0, 3)).toEqual(['--background', '--factory-startup', '--disable-autoexec']);
        expect(args.indexOf('a.blend')).toBeLessThan(args.indexOf('--python'));
        expect(args.slice(-2)).toEqual(['--', 'x']);
      });

      it.skipIf(none)('maillage final : modificateurs appliqués, repère local', () => {
        const cube = byPath.meshes.Cube;
        expectWellFormed(cube);
        expect(cube.positions.length / 3).toBe(16);
        expect(cube.polygons.length).toBe(12);
        expect(cube.polygons.every((p) => p.length === 4)).toBe(true);
        const b = bounds(cube);
        expect(b.min).toEqual([-1, -1, -1]);
        expect(b.max).toEqual([4, 1, 1]);
        expect(cube.materials).toEqual(['MatTexture']);
        expect(cube.smooth).toBe(false);
      });

      it.skipIf(none)('courbe et texte : géométrie finale', () => {
        const curve = byPath.meshes.Courbe;
        expectWellFormed(curve);
        const cb = bounds(curve);
        // Tube de rayon 0,1 le long de X, exprimé dans le repère LOCAL (l'objet est en Y = 3).
        expect(cb.min[0]).toBeCloseTo(0, 2);
        expect(cb.max[0]).toBeCloseTo(2, 2);
        expect(cb.max[1]).toBeCloseTo(0.1, 2);
        expect(cb.min[2]).toBeCloseTo(-0.1, 2);
        expect(curve.materials).toEqual(['MatUni']);

        const text = byPath.meshes.Texte;
        expectWellFormed(text);
        const tb = bounds(text);
        expect(tb.max[0] - tb.min[0]).toBeGreaterThan(0.5);
        expect(tb.max[2] - tb.min[2]).toBeCloseTo(0.1, 2);
      });

      it.skipIf(none)('instances réalisées dans le maillage de l’objet qui les génère', () => {
        const emitter = byPath.meshes.Emetteur;
        expectWellFormed(emitter);
        // Plan (4 sommets, 1 face) + 4 briques (8 sommets, 6 faces) posées sur ses sommets.
        expect(emitter.positions.length / 3).toBe(4 + 4 * 8);
        expect(emitter.polygons.length).toBe(1 + 4 * 6);
        const b = bounds(emitter);
        for (const k of [0, 1]) {
          expect(b.min[k]).toBeCloseTo(-1.1, 4);
          expect(b.max[k]).toBeCloseTo(1.1, 4);
        }
        expect(b.min[2]).toBeCloseTo(-0.1, 4);
        expect(b.max[2]).toBeCloseTo(0.1, 4);
        // Emplacements : celui du plan (vide) puis le matériau des briques.
        expect(emitter.materials).toEqual([null, 'MatUni']);
        expect(emitter.slots!.filter((s) => s === 1).length).toBe(24);
        expect(byPath.notes?.join(' ')).toMatch(/instance\(s\)/);

        // Nœuds de géométrie : le .blend de test en contient dès que la version sait les construire ainsi.
        if (Number(fixture.version.split('.')[0]) >= 4) expect(fixture.gn).toBe(true);
        if (fixture.gn) {
          const nodes = byPath.meshes.Noeuds;
          expectWellFormed(nodes);
          expect(nodes.polygons.length).toBe(3 * 6);
          expect(nodes.positions.length / 3).toBe(3 * 8);
          const nb = bounds(nodes);
          expect(nb.min[2]).toBeCloseTo(-0.5, 4);
          expect(nb.max[2]).toBeCloseTo(2.5, 4);
        }
      });

      it.skipIf(none)('objets sans géométrie ou absents : pas d’entrée', () => {
        expect(byPath.meshes.Vide).toBeUndefined();
        expect(byPath.meshes.Lampe).toBeUndefined();
        expect(byPath.meshes.Absent).toBeUndefined();
      });

      it.skipIf(none)('couleur moyenne de la texture de couleur de base', () => {
        const colors = byPath.materialColors ?? {};
        expect(colors.MatTexture).toMatch(/^#[0-9a-f]{6}$/);
        const got = hexChannels(colors.MatTexture);
        [0xcc, 0x33, 0x66].forEach((want, i) => expect(Math.abs(got[i] - want)).toBeLessThanOrEqual(1));
        // Image sur disque retrouvée par chemin relatif au .blend.
        expect(colors.MatDisque).toBe('#0000ff');
        // Image manquante, matériau sans texture, matériau inconnu : pas d'entrée.
        expect(colors.MatPerdue).toBeUndefined();
        expect(colors.MatUni).toBeUndefined();
        expect(colors.Absent).toBeUndefined();
      });

      it.skipIf(none)(
        'par octets : mêmes maillages, texture empaquetée retrouvée',
        async () => {
          const result = await evaluateBlendBytes(new Uint8Array(fs.readFileSync(blend)), REQUEST);
          expect(Object.keys(result.meshes).sort()).toEqual(Object.keys(byPath.meshes).sort());
          expect(result.meshes.Cube.polygons).toEqual(byPath.meshes.Cube.polygons);
          expect(result.meshes.Cube.positions).toEqual(byPath.meshes.Cube.positions);
          expect(result.materialColors?.MatTexture).toBe(byPath.materialColors?.MatTexture);
          // Sans le dossier du fichier, la texture liée par chemin relatif est introuvable.
          expect(result.materialColors?.MatDisque).toBeUndefined();
        },
        LAUNCH_TIMEOUT,
      );

      it.skipIf(none)(
        'conversion complète en .glb',
        async () => {
          const glb = await convertBlendToGLB(blend);
          const { magic, version, length, json } = parseGLB(glb);
          expect(magic).toBe('glTF');
          expect(version).toBe(2);
          expect(length).toBe(glb.byteLength);
          const names: string[] = (json.nodes ?? []).map((n: { name?: string }) => n.name);
          for (const name of ['Cube', 'Courbe', 'Texte', 'Lampe', 'Camera']) expect(names).toContain(name);
          // Modificateurs appliqués : le cube exporté a ses deux copies (24 sommets par cube, normales par face).
          const cubeNode = json.nodes.find((n: { name?: string }) => n.name === 'Cube');
          const prim = json.meshes[cubeNode.mesh].primitives[0];
          expect(json.accessors[prim.indices].count).toBe(12 * 2 * 3);
          expect(json.extensionsUsed).toContain('KHR_lights_punctual');
          expect(json.cameras?.length).toBe(1);
          expect(json.animations).toBeUndefined();
          // +Y vers le haut : la lampe (4, 1, 6) en Z-up devient (4, 6, -1).
          const lamp = json.nodes.find((n: { name?: string }) => n.name === 'Lampe');
          [4, 6, -1].forEach((v, i) => expect(lamp.translation[i]).toBeCloseTo(v, 4));
          // Couleur moyenne de la texture inscrite dans le matériau, images non embarquées.
          const mat = json.materials.find((m: { name?: string }) => m.name === 'MatTexture');
          const factor: number[] = mat.pbrMetallicRoughness.baseColorFactor;
          const linear = [0xcc, 0x33, 0x66].map((c) => ((c / 255 + 0.055) / 1.055) ** 2.4);
          linear.forEach((v, i) => expect(factor[i]).toBeCloseTo(v, 2));
          expect(mat.pbrMetallicRoughness.baseColorTexture).toBeUndefined();
          expect(json.images).toBeUndefined();

          const fromBytes = await convertBlendBytesToGLB(new Uint8Array(fs.readFileSync(blend)));
          expect(parseGLB(fromBytes).magic).toBe('glTF');
          expect(parseGLB(fromBytes).json.nodes.length).toBe(json.nodes.length);
        },
        LAUNCH_TIMEOUT * 2,
      );

      it.skipIf(none)(
        'erreurs en français : fichier absent, fichier qui n’est pas un .blend',
        async () => {
          await expect(evaluateBlend(path.join(dir, 'absent.blend'), REQUEST)).rejects.toThrow(/Fichier introuvable/);
          await expect(convertBlendToGLB(path.join(dir, 'absent.blend'))).rejects.toThrow(/Fichier introuvable/);
          const fake = path.join(dir, 'faux.blend');
          fs.writeFileSync(fake, 'ceci n’est pas un fichier Blender');
          await expect(evaluateBlend(fake, REQUEST)).rejects.toThrow(/n'a pas pu ouvrir ce fichier/);
          await expect(convertBlendBytesToGLB(new Uint8Array(fs.readFileSync(fake)))).rejects.toThrow(/n'a pas pu ouvrir ce fichier/);
          // Requête vide : pas de lancement de Blender.
          const empty = await evaluateBlend(blend, { objects: [] });
          expect(empty.meshes).toEqual({});
        },
        LAUNCH_TIMEOUT,
      );

      it.skipIf(none)('le .blend n’est jamais modifié et le dossier de travail est nettoyé', () => {
        expect(sha(blend)).toBe(before);
        expect(fs.existsSync(`${blend}1`)).toBe(false);
        expect(fs.readdirSync(dir).sort()).toEqual(['faux.blend', 'fixture.json', 'fixture.py', 'scene.blend', 'tex_disque.png']);
        // Chaque évaluation / conversion a eu son dossier de travail, supprimé ensuite.
        expect(createdWorkDirs.length).toBeGreaterThan(0);
        expect(createdWorkDirs.filter((d) => fs.existsSync(d))).toEqual([]);
      });
    });
  }
});
