# Fabrique de petites fixtures REELLES pour tests/io.formats.test.ts (Blender en arriere-plan,
# --factory-startup). Aucun fichier utilisateur n'est ouvert : la scene est construite ici.
import bpy, bmesh, json, math, os, sys
from mathutils import Euler, Vector

out = sys.argv[sys.argv.index('--') + 1]
os.makedirs(out, exist_ok=True)

# scene vide
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
for block in (bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras):
    for d in list(block):
        block.remove(d)
scene = bpy.context.scene
scene.render.resolution_x = 1920
scene.render.resolution_y = 1080
col = scene.collection


def material(name, **kw):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    for key, value in kw.items():
        bsdf.inputs[key].default_value = value
    return m


def mesh_from(name, build):
    bm = bmesh.new()
    build(bm)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return me


def add(name, data, loc=(0, 0, 0), rot=(0, 0, 0), scl=(1, 1, 1), parent=None):
    o = bpy.data.objects.new(name, data)
    col.objects.link(o)
    o.parent = parent
    o.location = loc
    o.rotation_euler = Euler([math.radians(a) for a in rot], 'XYZ')
    o.scale = scl
    return o


rouge = material('Rouge', **{'Base Color': (0.8, 0.1, 0.1, 1.0), 'Metallic': 0.25, 'Roughness': 0.3})
verre = material('Verre', **{'Base Color': (0.9, 0.95, 1.0, 1.0), 'Roughness': 0.05, 'Transmission Weight': 1.0, 'IOR': 1.33})
neon = material('Neon', **{'Base Color': (0.1, 0.1, 0.1, 1.0), 'Emission Color': (0.0, 1.0, 0.5, 1.0), 'Emission Strength': 4.0})
voile = material('Voile', **{'Base Color': (0.2, 0.4, 0.8, 1.0), 'Alpha': 0.4})
voile.surface_render_method = 'BLENDED'

cube = mesh_from('CaisseMesh', lambda bm: bmesh.ops.create_cube(bm, size=2.0))
cube.materials.append(rouge)

bicolore = mesh_from('BicoloreMesh', lambda bm: bmesh.ops.create_cube(bm, size=1.0))
bicolore.materials.append(rouge)
bicolore.materials.append(verre)
for p in bicolore.polygons:
    p.material_index = 1 if p.normal.z > 0.5 else 0

colonne = mesh_from('ColonneMesh', lambda bm: bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=8, radius1=0.5, radius2=0.5, depth=2.0))
colonne.materials.append(neon)
for p in colonne.polygons:
    p.use_smooth = True

vitre = mesh_from('VitreMesh', lambda bm: bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=1.0))
vitre.materials.append(voile)

racine = add('Racine', None, loc=(1, 2, 3), rot=(0, 0, 30))
caisse = add('Caisse', cube, loc=(2, 0, 0.5), rot=(10, 20, 30), scl=(1, 2, 0.5), parent=racine)
liee = add('CaisseLiee', cube, loc=(-2, 1, 0), rot=(0, 0, 90), parent=racine)
bi = add('Bicolore', bicolore, loc=(-3, 1, 0.5), rot=(0, 0, 45))
col_obj = add('Colonne', colonne, loc=(0, 3, 1), rot=(15, 0, 0), scl=(1, 1, 1.5))
vitre_obj = add('Vitre', vitre, loc=(0, -2, 1), rot=(90, 0, 0), parent=caisse)

ampoule_d = bpy.data.lights.new('Ampoule', 'POINT')
ampoule_d.energy = 1000.0
ampoule_d.color = (1.0, 0.5, 0.25)
ampoule = add('Ampoule', ampoule_d, loc=(4, 1, 6))

soleil_d = bpy.data.lights.new('Soleil', 'SUN')
soleil_d.energy = 3.0
soleil = add('Soleil', soleil_d, loc=(0, 0, 8), rot=(45, 0, 30))

spot_d = bpy.data.lights.new('Projecteur', 'SPOT')
spot_d.energy = 500.0
spot_d.spot_size = math.radians(60.0)
spot_d.spot_blend = 0.25
spot = add('Projecteur', spot_d, loc=(0, -5, 4), rot=(60, 0, 0))

cam_d = bpy.data.cameras.new('Camera')
cam_d.lens = 50.0
cam_d.sensor_width = 36.0
cam_d.clip_start = 0.1
cam_d.clip_end = 100.0
cam = add('Camera', cam_d, loc=(7, -7, 5), rot=(63, 0, 45))
scene.camera = cam

ortho_d = bpy.data.cameras.new('Ortho')
ortho_d.type = 'ORTHO'
ortho_d.ortho_scale = 6.0
ortho_d.clip_start = 0.5
ortho_d.clip_end = 50.0
ortho = add('Ortho', ortho_d, loc=(0, 0, 10))

# Blender 5.1 : toute lumiere a un arbre de noeuds, et l'export glTF y lit la couleur (et, pour
# un soleil, la force) dans le noeud d'emission au lieu des reglages de la lumiere. On y recopie
# donc les memes valeurs, pour que le .glb et le .fbx (qui lit les reglages) disent la meme chose.
for l in bpy.data.lights:
    tree = getattr(l, 'node_tree', None)
    emission = next((n for n in tree.nodes if n.type == 'EMISSION'), None) if tree else None
    if emission:
        emission.inputs['Color'].default_value = (l.color[0], l.color[1], l.color[2], 1.0)
        if l.type == 'SUN':
            emission.inputs['Strength'].default_value = l.energy

bpy.context.view_layer.update()

# ---------------------------------------------------------------- verite
aspect = scene.render.resolution_x / scene.render.resolution_y


def flat(m):
    return [m[r][c] for r in range(4) for c in range(4)]  # ligne par ligne


truth = {'blender': bpy.app.version_string, 'objects': [], 'materials': []}
for o in scene.objects:
    e = {
        'name': o.name,
        'type': o.type,
        'parent': o.parent.name if o.parent else None,
        'matrix_world': flat(o.matrix_world),
    }
    if o.type == 'MESH':
        me = o.data
        e['mesh'] = me.name
        e['verts'] = len(me.vertices)
        e['polys'] = len(me.polygons)
        e['tris'] = sum(len(p.vertices) - 2 for p in me.polygons)
        e['poly_sizes'] = sorted(len(p.vertices) for p in me.polygons)
        e['materials'] = [m.name if m else None for m in me.materials]
        e['slot_polys'] = [sum(1 for p in me.polygons if p.material_index == i) for i in range(len(me.materials))]
        e['slot_tris'] = [sum(len(p.vertices) - 2 for p in me.polygons if p.material_index == i) for i in range(len(me.materials))]
        e['smooth'] = any(p.use_smooth for p in me.polygons)
        e['world_verts'] = [list(o.matrix_world @ v.co) for v in me.vertices]
        e['local_verts'] = [list(v.co) for v in me.vertices]
    elif o.type == 'LIGHT':
        l = o.data
        e['light'] = {'type': l.type, 'energy': l.energy, 'color': list(l.color)}
        if l.type == 'SPOT':
            e['light']['spot_size_deg'] = math.degrees(l.spot_size)
            e['light']['spot_blend'] = l.spot_blend
        # direction d'emission dans le monde : -Z local
        e['aim'] = list((o.matrix_world.to_3x3() @ Vector((0, 0, -1))).normalized())
    elif o.type == 'CAMERA':
        c = o.data
        e['camera'] = {'type': c.type, 'clip_start': c.clip_start, 'clip_end': c.clip_end}
        if c.type == 'PERSP':
            # capteur "auto", image plus large que haute : le capteur couvre la largeur
            e['camera']['vfov_deg'] = math.degrees(2 * math.atan((c.sensor_width / 2 / c.lens) / aspect))
        else:
            e['camera']['ortho_scale'] = c.ortho_scale  # plus grande dimension (largeur ici)
            e['camera']['ortho_height'] = c.ortho_scale / aspect
        e['aim'] = list((o.matrix_world.to_3x3() @ Vector((0, 0, -1))).normalized())
        e['up'] = list((o.matrix_world.to_3x3() @ Vector((0, 1, 0))).normalized())
    truth['objects'].append(e)

for m in bpy.data.materials:
    bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    g = lambda k: bsdf.inputs[k].default_value
    truth['materials'].append({
        'name': m.name,
        'base_color_linear': list(g('Base Color')),
        'metallic': g('Metallic'),
        'roughness': g('Roughness'),
        'emission_linear': list(g('Emission Color')),
        'emission_strength': g('Emission Strength'),
        'alpha': g('Alpha'),
        'transmission': g('Transmission Weight'),
        'ior': g('IOR'),
    })

with open(os.path.join(out, 'blender_scene.json'), 'w', encoding='utf-8') as f:
    json.dump(truth, f, indent=1)

# ---------------------------------------------------------------- exports
bpy.ops.export_scene.gltf(filepath=os.path.join(out, 'blender_scene.glb'), export_format='GLB', export_cameras=True, export_lights=True, export_yup=True)
bpy.ops.export_scene.fbx(filepath=os.path.join(out, 'blender_scene.fbx'))
bpy.ops.wm.obj_export(filepath=os.path.join(out, 'blender_scene.obj'), export_materials=True)

for o in scene.objects:
    o.select_set(o is col_obj)
bpy.context.view_layer.objects.active = col_obj
bpy.ops.wm.ply_export(filepath=os.path.join(out, 'blender_colonne.ply'), export_selected_objects=True, ascii_format=False)
bpy.ops.wm.ply_export(filepath=os.path.join(out, 'blender_colonne_ascii.ply'), export_selected_objects=True, ascii_format=True)
bpy.ops.wm.stl_export(filepath=os.path.join(out, 'blender_colonne.stl'), export_selected_objects=True, ascii_format=False)
bpy.ops.wm.stl_export(filepath=os.path.join(out, 'blender_colonne_ascii.stl'), export_selected_objects=True, ascii_format=True)
print('FIXTURES_OK')
