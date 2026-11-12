# -*- coding: utf-8 -*-
"""
Fixtures du lecteur .blend natif de CoForge (src/engine/io/blend).

Lancement (une fois par version de Blender) :
    blender --background --factory-startup --python make_fixtures.py -- <dossier de sortie> [étiquette]

Écrit, pour la version de Blender qui exécute le script :
    b<XYZ>_full.blend   scène complète, fichier COMPRESSÉ (gzip jusqu'à 2.93, zstd ensuite)
    b<XYZ>_full.json    vérité terrain exportée par bpy (matrices monde, maillages, lumières…)
    b<XYZ>_mini.blend   petite scène de variantes, fichier NON compressé
    b<XYZ>_mini.json    vérité terrain correspondante

Le script doit tourner de Blender 2.57 (Python 3.2) à Blender 5.x : pas de f-strings, pas
d'opérateur « @ », chaque fonctionnalité optionnelle est essayée puis notée dans `skipped`.
"""
import bpy
import json
import math
import operator
import os
import sys

from mathutils import Euler, Matrix, Quaternion, Vector

V = tuple(bpy.app.version)
NEW = V >= (2, 80, 0)  # collections, lumières en watts, EEVEE
HAS_POLY = V >= (2, 63, 0)  # BMesh : n-gones, polygons/loops
HAS_NODE_IDNAME = V >= (2, 67, 0)  # nodes.new('ShaderNode…')
ROW_MAJOR = V >= (2, 62, 0)  # mathutils : m[ligne][colonne]
MATMUL = getattr(operator, 'matmul', None) if NEW else None

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT_DIR = os.path.abspath(ARGS[0]) if ARGS else os.path.abspath('.')
TAG = ARGS[1] if len(ARGS) > 1 else 'b%d%02d' % (V[0], V[1])

SKIPPED = []
EXPECT = {}


def log(msg):
    print('[fixtures] ' + msg.encode('ascii', 'replace').decode('ascii'))


def mul(a, b):
    return MATMUL(a, b) if MATMUL else a * b


def attempt(label, fn):
    """Exécute une construction optionnelle ; un échec est noté, jamais fatal."""
    try:
        return fn()
    except Exception as exc:  # noqa
        SKIPPED.append('%s: %s' % (label, str(exc).strip().split('\n')[-1][:160]))
        log('IGNORE %s -> %s' % (label, exc))
        return None


def flat(m):
    """Matrice 4x4 à plat, colonnes d'abord (comme three.js et comme le fichier .blend)."""
    if ROW_MAJOR:
        return [float(m[r][c]) for c in range(4) for r in range(4)]
    return [float(m[c][r]) for c in range(4) for r in range(4)]


def scene():
    return bpy.context.scene


def update():
    if NEW:
        bpy.context.view_layer.update()
    else:
        scene().update()


def reset():
    try:
        bpy.ops.wm.read_factory_settings(use_empty=True)
    except Exception:  # noqa
        bpy.ops.wm.read_factory_settings()
    sc = scene()
    for ob in list(bpy.data.objects):
        for s in bpy.data.scenes:
            try:
                if NEW:
                    for c in [s.collection] + list(bpy.data.collections):
                        if ob.name in c.objects:
                            c.objects.unlink(ob)
                else:
                    s.objects.unlink(ob)
            except Exception:  # noqa
                pass
        try:
            bpy.data.objects.remove(ob)
        except Exception:  # noqa
            pass
    # Allège le fichier : rien de tout cela n'est lu par CoForge.
    for attr in ('brushes', 'palettes', 'linestyles', 'meshes', 'materials', 'textures', 'images', 'lamps',
                 'lights', 'cameras', 'curves', 'worlds', 'node_groups', 'grease_pencils', 'paint_curves'):
        col = getattr(bpy.data, attr, None)
        if col is None:
            continue
        for item in list(col):
            try:
                col.remove(item)
            except Exception:  # noqa
                pass
    # Les espaces de travail de l'interface pèsent l'essentiel d'un fichier vide : on n'en garde qu'un.
    spaces = getattr(bpy.data, 'workspaces', None)
    if spaces is not None and hasattr(bpy.data, 'batch_remove'):
        try:
            win = bpy.context.window
            keep = win.workspace if win is not None else spaces[0]
            bpy.data.batch_remove(ids=[w for w in spaces if w != keep])
        except Exception as exc:  # noqa
            log('espaces de travail gardes : %s' % exc)
    return scene()


def rounded(value):
    """Arrondit les flottants de la vérité terrain (fichiers JSON plus petits, précision 1e-6 conservée)."""
    if isinstance(value, float):
        return round(value, 6)
    if isinstance(value, dict):
        return dict((k, rounded(v)) for k, v in value.items())
    if isinstance(value, (list, tuple)):
        return [rounded(v) for v in value]
    return value


def no_thumbnail():
    """Pas de vignette (bloc TEST, ~64 Ko) : les fixtures restent petites."""
    prefs = getattr(bpy.context, 'preferences', None) or getattr(bpy.context, 'user_preferences', None)
    fp = getattr(prefs, 'filepaths', None) if prefs is not None else None
    if fp is None:
        return
    for attr, value in (('file_preview_type', 'NONE'), ('use_save_preview_images', False)):
        if hasattr(fp, attr):
            try:
                setattr(fp, attr, value)
            except Exception:  # noqa
                pass


def save(path, compress):
    no_thumbnail()
    if os.path.exists(path):
        os.remove(path)
    try:
        bpy.ops.wm.save_as_mainfile(filepath=path, compress=compress, check_existing=False)
    except TypeError:
        bpy.ops.wm.save_as_mainfile(filepath=path, compress=compress)
    for ext in ('1', '2'):
        if os.path.exists(path + ext):
            os.remove(path + ext)
    log('ecrit %s (%d octets)' % (path, os.path.getsize(path)))


# ---------------------------------------------------------------- géométrie

def cube(h=1.0):
    v = [(-h, -h, -h), (h, -h, -h), (h, h, -h), (-h, h, -h), (-h, -h, h), (h, -h, h), (h, h, h), (-h, h, h)]
    f = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    return v, f


def prism(n, r=1.0, h=1.0):
    """Prisme à n côtés : deux n-gones (ou éventails de triangles avant 2.63) et n quadrilatères."""
    v = []
    for z in (-h, h):
        for i in range(n):
            a = 2.0 * math.pi * i / n
            v.append((r * math.cos(a), r * math.sin(a), z))
    f = []
    for i in range(n):
        j = (i + 1) % n
        f.append((i, j, n + j, n + i))
    if HAS_POLY:
        f.append(tuple(reversed(range(n))))
        f.append(tuple(range(n, 2 * n)))
    else:
        for i in range(1, n - 1):
            f.append((0, i + 1, i))
            f.append((n, n + i, n + i + 1))
    return v, f


def pyramid(s=1.0, h=1.5):
    v = [(-s, -s, 0.0), (s, -s, 0.0), (s, s, 0.0), (-s, s, 0.0), (0.0, 0.0, h)]
    f = [(0, 3, 2, 1), (0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4)]
    return v, f


def plane(s=1.0):
    return [(-s, -s, 0.0), (s, -s, 0.0), (s, s, 0.0), (-s, s, 0.0)], [(0, 1, 2, 3)]


def new_mesh(name, geo, edges=()):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(p) for p in geo[0]], [tuple(e) for e in edges], [tuple(f) for f in geo[1]])
    me.update()
    return me


def mesh_faces(me):
    return me.polygons if HAS_POLY else me.faces


# ---------------------------------------------------------------- objets, collections

COLLS = {}
LAYER_OF = {'root': 0, 'A': 1, 'A_sub': 1, 'hidden': 2, 'excluded': 2, 'eye': 2, 'src': 10, 'src_sub': 10, 'outer': 10}


def new_coll(key, name, parent):
    c = bpy.data.collections.new(name)
    if parent is not None:
        parent.children.link(c)
    COLLS[key] = c
    return c


def link(ob, where='root'):
    if NEW:
        (scene().collection if where == 'root' else COLLS[where]).objects.link(ob)
    else:
        scene().objects.link(ob)
        layer = LAYER_OF.get(where, 0)
        ob.layers = [i == layer for i in range(20)]
    return ob


def add(name, data, where='root', loc=None, rot=None, scale=None, mode=None):
    ob = bpy.data.objects.new(name, data)
    link(ob, where)
    if mode:
        ob.rotation_mode = mode
    if loc is not None:
        ob.location = loc
    if rot is not None:
        ob.rotation_euler = rot
    if scale is not None:
        ob.scale = scale
    return ob


def set_parent(ob, parent, inverse=None):
    ob.parent = parent
    if inverse is not None:
        if hasattr(ob, 'matrix_parent_inverse'):
            ob.matrix_parent_inverse = inverse
        else:
            SKIPPED.append('matrix_parent_inverse absent : parent sans inverse pour %s' % ob.name)


def hide_viewport(ob, value=True):
    if NEW:
        ob.hide_viewport = value
    else:
        ob.hide = value


def display(ob, kind):
    if NEW:
        ob.display_type = kind
    else:
        ob.draw_type = kind


def new_light(name, kind):
    if hasattr(bpy.data, 'lights'):
        return bpy.data.lights.new(name, kind)
    return bpy.data.lamps.new(name, kind)


def sock(node, names):
    for n in names:
        if n in node.inputs:
            return node.inputs[n]
    return None


def node_tree_of(owner):
    """Arbre de nœuds vidé d'un matériau, d'un monde ou d'une lampe (None si indisponible)."""
    try:
        owner.use_nodes = True
    except Exception:  # noqa
        pass
    nt = getattr(owner, 'node_tree', None)
    if nt is None:
        return None
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    return nt


# ---------------------------------------------------------------- matériaux

def mat_principled():
    m = bpy.data.materials.new('MatPrincipled')
    nt = node_tree_of(m)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    b = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(b.outputs[0], out.inputs[0])
    exp = {'kind': 'principled'}
    sock(b, ['Base Color']).default_value = (0.8, 0.2, 0.1, 1.0)
    exp['base_color'] = [0.8, 0.2, 0.1]
    sock(b, ['Metallic']).default_value = 0.7
    exp['metallic'] = 0.7
    sock(b, ['Roughness']).default_value = 0.3
    exp['roughness'] = 0.3
    sock(b, ['IOR']).default_value = 1.33
    exp['ior'] = 1.33
    s = sock(b, ['Alpha'])
    if s is not None:
        s.default_value = 0.9
        exp['alpha'] = 0.9
    s = sock(b, ['Emission Color', 'Emission'])
    if s is not None:
        s.default_value = (0.1, 0.6, 1.0, 1.0)
        exp['emission'] = [0.1, 0.6, 1.0]
        st = sock(b, ['Emission Strength'])
        if st is not None:
            st.default_value = 2.5
            exp['emission_strength'] = 2.5
        else:
            exp['emission_strength'] = 1.0
    s = sock(b, ['Transmission Weight', 'Transmission'])
    if s is not None:
        s.default_value = 0.25
        exp['transmission'] = 0.25
    EXPECT['materials']['MatPrincipled'] = exp
    return m


def mat_textured():
    m = bpy.data.materials.new('MatTextured')
    nt = node_tree_of(m)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    b = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(b.outputs[0], out.inputs[0])
    img = bpy.data.images.new('TexImage', 4, 4)
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    # Texture branchée INDIRECTEMENT (à travers un nœud de teinte) sur la couleur de base.
    hue = nt.nodes.new('ShaderNodeHueSaturation')
    nt.links.new(tex.outputs[0], hue.inputs['Color'])
    nt.links.new(hue.outputs[0], sock(b, ['Base Color']))
    sock(b, ['Roughness']).default_value = 0.65
    EXPECT['materials']['MatTextured'] = {'kind': 'principled', 'textured': True, 'roughness': 0.65}
    return m


def mat_glass():
    m = bpy.data.materials.new('MatGlass')
    nt = node_tree_of(m)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    g = nt.nodes.new('ShaderNodeBsdfGlass')
    nt.links.new(g.outputs[0], out.inputs[0])
    g.inputs['Color'].default_value = (0.7, 0.9, 1.0, 1.0)
    g.inputs['Roughness'].default_value = 0.05
    g.inputs['IOR'].default_value = 1.5
    EXPECT['materials']['MatGlass'] = {'kind': 'glass', 'base_color': [0.7, 0.9, 1.0], 'roughness': 0.05, 'ior': 1.5}
    return m


def mat_emissive():
    m = bpy.data.materials.new('MatEmissive')
    nt = node_tree_of(m)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    e = nt.nodes.new('ShaderNodeEmission')
    nt.links.new(e.outputs[0], out.inputs[0])
    e.inputs['Color'].default_value = (1.0, 0.5, 0.05, 1.0)
    e.inputs['Strength'].default_value = 12.0
    EXPECT['materials']['MatEmissive'] = {'kind': 'emission', 'emission': [1.0, 0.5, 0.05], 'emission_strength': 12.0}
    return m


def mat_diffuse():
    m = bpy.data.materials.new('MatDiffuse')
    nt = node_tree_of(m)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    d = nt.nodes.new('ShaderNodeBsdfDiffuse')
    nt.links.new(d.outputs[0], out.inputs[0])
    d.inputs['Color'].default_value = (0.2, 0.6, 0.3, 1.0)
    EXPECT['materials']['MatDiffuse'] = {'kind': 'diffuse', 'base_color': [0.2, 0.6, 0.3]}
    return m


def mat_mix():
    """Mix Shader (0,3) entre un Diffuse et un Glossy, à travers un nœud Reroute."""
    m = bpy.data.materials.new('MatMix')
    nt = node_tree_of(m)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    mix = nt.nodes.new('ShaderNodeMixShader')
    d = nt.nodes.new('ShaderNodeBsdfDiffuse')
    g = nt.nodes.new('ShaderNodeBsdfGlossy')
    r = nt.nodes.new('NodeReroute')
    mix.inputs[0].default_value = 0.3
    d.inputs['Color'].default_value = (0.9, 0.1, 0.1, 1.0)
    g.inputs['Color'].default_value = (0.1, 0.1, 0.9, 1.0)
    g.inputs['Roughness'].default_value = 0.2
    nt.links.new(d.outputs[0], mix.inputs[1])
    nt.links.new(g.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], r.inputs[0])
    nt.links.new(r.outputs[0], out.inputs[0])
    EXPECT['materials']['MatMix'] = {'kind': 'mix', 'fac': 0.3, 'a': [0.9, 0.1, 0.1], 'b': [0.1, 0.1, 0.9], 'b_roughness': 0.2}
    return m


def mat_transparent():
    """Mix Shader (0,4) entre un Principled et un Transparent : alpha = 0,6."""
    m = bpy.data.materials.new('MatTransparent')
    nt = node_tree_of(m)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    mix = nt.nodes.new('ShaderNodeMixShader')
    d = nt.nodes.new('ShaderNodeBsdfDiffuse')
    t = nt.nodes.new('ShaderNodeBsdfTransparent')
    mix.inputs[0].default_value = 0.4
    d.inputs['Color'].default_value = (0.3, 0.3, 0.8, 1.0)
    nt.links.new(d.outputs[0], mix.inputs[1])
    nt.links.new(t.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs[0])
    EXPECT['materials']['MatTransparent'] = {'kind': 'transparent_mix', 'base_color': [0.3, 0.3, 0.8], 'alpha': 0.6}
    return m


def mat_no_nodes():
    m = bpy.data.materials.new('MatNoNodes')
    exp = {'kind': 'no_nodes'}
    if NEW:
        try:
            m.use_nodes = False
        except Exception:  # noqa
            pass
        m.diffuse_color = (0.25, 0.5, 0.75, 1.0)
        m.metallic = 0.4
        m.roughness = 0.35
        exp.update({'base_color': [0.25, 0.5, 0.75], 'metallic': 0.4, 'roughness': 0.35})
        exp['use_nodes'] = bool(getattr(m, 'use_nodes', False)) and getattr(m, 'node_tree', None) is not None
    else:
        m.diffuse_color = (0.25, 0.5, 0.75)
        m.use_transparency = True
        m.alpha = 0.45
        m.emit = 0.5
        m.specular_hardness = 120
        m.raytrace_mirror.use = True
        m.raytrace_mirror.reflect_factor = 0.6
        exp.update({'base_color': [0.25, 0.5, 0.75], 'alpha': 0.45, 'emit': 0.5, 'hardness': 120, 'mirror': 0.6,
                    'intensity': float(m.diffuse_intensity)})
        exp['use_nodes'] = False
    EXPECT['materials']['MatNoNodes'] = exp
    return m


# ---------------------------------------------------------------- vérité terrain

def mesh_truth(me):
    d = {'name': me.name}
    d['positions'] = [float(c) for v in me.vertices for c in v.co]
    faces = mesh_faces(me)
    d['polygons'] = [[int(i) for i in f.vertices] for f in faces]
    d['material_index'] = [int(f.material_index) for f in faces]
    d['smooth'] = [bool(f.use_smooth) for f in faces]
    d['materials'] = [(m.name if m else None) for m in me.materials]
    if hasattr(me, 'use_auto_smooth'):
        d['auto_smooth'] = bool(me.use_auto_smooth)
        angle = me.auto_smooth_angle
        # Avant 2.6x : entier en degrés ; ensuite : flottant en radians.
        d['auto_smooth_angle'] = math.radians(angle) if isinstance(angle, int) else float(angle)
    d['library'] = me.library is not None
    return d


def light_truth(la):
    d = {'type': la.type, 'color': [float(c) for c in la.color], 'energy': float(la.energy)}
    for a in ('shadow_soft_size', 'spot_size', 'spot_blend', 'size', 'size_y', 'shape', 'angle', 'distance', 'falloff_type'):
        if hasattr(la, a):
            val = getattr(la, a)
            d[a] = val if isinstance(val, str) else float(val)
    if hasattr(la, 'use_shadow'):
        d['use_shadow'] = bool(la.use_shadow)
    elif hasattr(la, 'shadow_method'):
        d['use_shadow'] = la.shadow_method != 'NOSHADOW'
    nt = getattr(la, 'node_tree', None)
    if not NEW and getattr(la, 'use_nodes', False) and nt is not None:
        for n in nt.nodes:
            if n.type == 'EMISSION':
                d['node_strength'] = float(n.inputs['Strength'].default_value)
                d['node_color'] = [float(c) for c in n.inputs['Color'].default_value][:3]
    return d


def camera_truth(cam, sc):
    d = {'type': cam.type, 'lens': float(cam.lens), 'ortho_scale': float(cam.ortho_scale),
         'clip_start': float(cam.clip_start), 'clip_end': float(cam.clip_end)}
    for a in ('sensor_width', 'sensor_height', 'sensor_fit'):
        if hasattr(cam, a):
            val = getattr(cam, a)
            d[a] = val if isinstance(val, str) else float(val)
    # Cadre de la caméra à la distance 1 : source de vérité du champ VERTICAL et de la hauteur ortho.
    if hasattr(cam, 'view_frame'):  # absent en 2.57
        try:
            frame = cam.view_frame(scene=sc)
        except TypeError:
            frame = cam.view_frame(sc)
        d['frame'] = [[float(c) for c in p] for p in frame]
    else:
        d['angle_y'] = float(cam.angle) if hasattr(cam, 'angle') else None
    dof = getattr(cam, 'dof', None)
    if dof is not None and hasattr(dof, 'use_dof'):
        d['dof'] = {'use': bool(dof.use_dof), 'distance': float(dof.focus_distance), 'fstop': float(dof.aperture_fstop)}
    else:
        d['dof_legacy'] = {'distance': float(cam.dof_distance)}
        cy = getattr(cam, 'cycles', None)
        if cy is not None:
            for a in ('aperture_type', 'aperture_fstop', 'aperture_size'):
                if hasattr(cy, a):
                    val = getattr(cy, a)
                    d['dof_legacy'][a] = val if isinstance(val, str) else float(val)
    return d


MOD_ATTRS = {
    'MIRROR': ['use_x', 'use_y', 'use_z', 'use_mirror_merge', 'merge_threshold'],
    'ARRAY': ['count', 'fit_type', 'use_relative_offset', 'use_constant_offset', 'use_object_offset', 'use_merge_vertices'],
    'BEVEL': ['width', 'segments', 'limit_method', 'angle_limit', 'offset_type'],
    'SUBSURF': ['levels', 'subdivision_type'],
    'SOLIDIFY': ['thickness', 'offset', 'use_rim', 'use_even_offset'],
    'BOOLEAN': ['operation'],
}


def modifier_truth(md):
    d = {'name': md.name, 'type': md.type, 'show_viewport': bool(md.show_viewport)}
    for a in MOD_ATTRS.get(md.type, []):
        if hasattr(md, a):
            val = getattr(md, a)
            d[a] = val if isinstance(val, (str, bool, int)) else float(val)
    if md.type == 'MIRROR':
        if hasattr(md, 'use_axis'):
            d['use_x'], d['use_y'], d['use_z'] = [bool(b) for b in md.use_axis]
        d['mirror_object'] = md.mirror_object.name if md.mirror_object else None
    if md.type == 'ARRAY':
        d['relative_offset_displace'] = [float(c) for c in md.relative_offset_displace]
        d['constant_offset_displace'] = [float(c) for c in md.constant_offset_displace]
    if md.type == 'BOOLEAN':
        d['object'] = md.object.name if md.object else None
    return d


def object_truth(ob, mats):
    d = {'name': ob.name, 'type': ob.type, 'parent': ob.parent.name if ob.parent else None,
         'parent_type': ob.parent_type, 'matrix_world': mats.get(ob.name, flat(ob.matrix_world)),
         'rotation_mode': ob.rotation_mode, 'hide_render': bool(ob.hide_render),
         'data': ob.data.name if ob.data is not None else None,
         'library': ob.library is not None,
         'data_library': ob.data is not None and ob.data.library is not None}
    d['hide_viewport'] = bool(ob.hide_viewport) if NEW else bool(ob.hide)
    d['hide_eye'] = False
    if NEW:
        try:
            d['hide_eye'] = bool(ob.hide_get())
        except Exception:  # noqa
            pass
    else:
        d['layers'] = [i for i in range(20) if ob.layers[i]]
    d['display'] = ob.display_type if NEW else ob.draw_type
    d['slots'] = [{'material': (s.material.name if s.material else None), 'link': s.link} for s in ob.material_slots]
    d['modifiers'] = [modifier_truth(md) for md in ob.modifiers]
    inst = getattr(ob, 'instance_collection', None) if NEW else getattr(ob, 'dupli_group', None)
    d['instance_collection'] = inst.name if inst else None
    if ob.type == 'MESH' and ob.data is not None and ob.data.library is None:
        d['mesh'] = mesh_truth(ob.data)
    if ob.type in ('LAMP', 'LIGHT') and ob.data is not None:
        d['light'] = light_truth(ob.data)
    if ob.type == 'CAMERA' and ob.data is not None:
        d['camera'] = camera_truth(ob.data, scene())
    return d


def layer_collections(lc, parent, out):
    for child in lc.children:
        c = child.collection
        out.append({'name': c.name, 'parent': parent, 'hide_viewport': bool(c.hide_viewport),
                    'hide_render': bool(c.hide_render), 'exclude': bool(child.exclude),
                    'layer_hide': bool(child.hide_viewport), 'objects': [o.name for o in c.objects]})
        layer_collections(child, c.name, out)


def world_truth(sc):
    w = sc.world
    if w is None:
        return None
    d = {'name': w.name}
    col = getattr(w, 'color', None)
    if col is None:
        col = w.horizon_color
    d['color'] = [float(c) for c in col]
    d.update(EXPECT.get('world', {}))
    return d


def instances_truth(sc):
    out = []
    if NEW:
        dg = bpy.context.evaluated_depsgraph_get()
        for inst in dg.object_instances:
            if inst.is_instance:
                top = inst.parent
                out.append({'instancer': top.name, 'object': inst.object.name, 'matrix_world': flat(inst.matrix_world)})
    else:
        for ob in sc.objects:
            if ob.dupli_type != 'GROUP' or ob.dupli_group is None:
                continue
            # Les duplications d'un calque masqué ne sont pas construites : on l'affiche le temps du calcul.
            ob.dupli_list_create(sc)
            for d in ob.dupli_list:
                out.append({'instancer': ob.name, 'object': d.object.name, 'matrix_world': flat(d.matrix)})
            ob.dupli_list_clear()
    return out


def render_truth(sc):
    r = sc.render
    d = {'resolution_x': int(r.resolution_x), 'resolution_y': int(r.resolution_y),
         'resolution_percentage': int(r.resolution_percentage), 'engine': r.engine,
         'pixel_aspect_x': float(r.pixel_aspect_x), 'pixel_aspect_y': float(r.pixel_aspect_y)}
    cy = getattr(sc, 'cycles', None)
    if cy is not None:
        d['cycles_samples'] = int(cy.samples)
    if hasattr(r, 'film_transparent'):
        d['film_transparent'] = bool(r.film_transparent)
    elif cy is not None and r.engine == 'CYCLES':
        d['film_transparent'] = bool(cy.film_transparent)
    else:
        d['film_transparent'] = getattr(r, 'alpha_mode', 'SKY') in ('TRANSPARENT', 'PREMUL', 'STRAIGHT')
    vs = getattr(sc, 'view_settings', None)
    if vs is not None:
        d['view_transform'] = vs.view_transform
        d['exposure'] = float(vs.exposure)
    return d


def collect(sc, mats):
    update()
    t = {'blender': list(V), 'tag': TAG, 'version_string': bpy.app.version_string, 'skipped': list(SKIPPED)}
    t['scene'] = {'name': sc.name, 'camera': sc.camera.name if sc.camera else None,
                  'render': render_truth(sc), 'world': world_truth(sc), 'others': [s.name for s in bpy.data.scenes if s != sc]}
    if NEW:
        t['scene_objects'] = [o.name for o in sc.collection.all_objects]
        cols = []
        layer_collections(bpy.context.view_layer.layer_collection, None, cols)
        t['collections'] = cols
        t['root_objects'] = [o.name for o in sc.collection.objects]
    else:
        t['scene_objects'] = [o.name for o in sc.objects]
        t['scene_layers'] = [i for i in range(20) if sc.layers[i]]
    t['objects'] = [object_truth(o, mats) for o in bpy.data.objects]
    t['instances'] = attempt('vérité des instances', lambda: instances_truth(sc)) or []
    t['expect'] = EXPECT
    return t


def world_matrices():
    """Matrices monde évaluées par Blender. Les objets masqués (calque masqué avant 2.8,
    hide_viewport ensuite) ne sont pas évalués : tout est rendu visible le temps de la lecture."""
    sc = scene()
    restore = []
    if NEW:
        for o in bpy.data.objects:
            if o.hide_viewport:
                restore.append(o)
                o.hide_viewport = False
    else:
        layers = list(sc.layers)
        sc.layers = [True] * 20
    update()
    out = {}
    dg = bpy.context.evaluated_depsgraph_get() if NEW else None
    for o in bpy.data.objects:
        m = o.matrix_world
        if dg is not None:
            try:
                m = o.evaluated_get(dg).matrix_world
            except Exception:  # noqa
                pass
        out[o.name] = flat(m)
    for o in restore:
        o.hide_viewport = True
    if not NEW:
        sc.layers = layers
    update()
    return out


def write_json(path, data):
    f = open(path, 'w')
    try:
        json.dump(rounded(data), f, sort_keys=True, separators=(',', ':'))
    finally:
        f.close()


# ---------------------------------------------------------------- scène complète

def build_library(path):
    reset()
    me = new_mesh('LibMesh', pyramid(0.5, 1.0))
    me.use_fake_user = True
    add('LibObject', me, loc=(1.0, 1.0, 1.0))
    save(path, False)


def build_full(lib_path):
    sc = reset()
    sc.name = 'Principale'
    EXPECT.clear()
    EXPECT.update({'materials': {}, 'pending': {}, 'native_modifiers': {}, 'empties': {}, 'warn': []})
    del SKIPPED[:]

    r = sc.render
    r.resolution_x, r.resolution_y, r.resolution_percentage = 1280, 720, 50
    attempt('moteur Cycles', lambda: setattr(r, 'engine', 'CYCLES'))
    attempt('échantillons Cycles', lambda: setattr(sc.cycles, 'samples', 77))
    vs = getattr(sc, 'view_settings', None)
    if vs is not None:
        for name in ('AgX', 'Filmic'):
            try:
                vs.view_transform = name
                break
            except Exception:  # noqa
                pass
        vs.exposure = 0.75

    if NEW:
        root = sc.collection
        a = new_coll('A', 'ColA', root)
        new_coll('A_sub', 'ColA_Sub', a)
        new_coll('hidden', 'ColHidden', root)
        new_coll('excluded', 'ColExcluded', root)
        new_coll('eye', 'ColEyeOff', root)
        src = new_coll('src', 'InstSource', None)
        new_coll('src_sub', 'InstSource_Sub', src)
        new_coll('outer', 'InstOuter', None)
    else:
        sc.layers = [i in (0, 1) for i in range(20)]

    # --- matériaux
    mats = {}
    if HAS_NODE_IDNAME and hasattr(bpy.types, 'ShaderNodeBsdfPrincipled'):
        for fn in (mat_principled, mat_textured):
            m = attempt(fn.__name__, fn)
            if m is not None:
                mats[m.name] = m
    if HAS_NODE_IDNAME:
        for fn in (mat_glass, mat_emissive, mat_diffuse, mat_mix, mat_transparent):
            m = attempt(fn.__name__, fn)
            if m is not None:
                mats[m.name] = m
    m = attempt('mat_no_nodes', mat_no_nodes)
    if m is not None:
        mats[m.name] = m

    def mat(name):
        return mats.get(name) or mats.get('MatNoNodes')

    # --- hiérarchie et transformations
    cube_me = new_mesh('CubeMesh', cube())
    pyr_me = new_mesh('PyramidMesh', pyramid())
    root_ob = add('Root', None, loc=(1.0, 2.0, 3.0), rot=(0.3, -0.5, 1.1), scale=(1.5, 0.5, 2.0))
    child = add('Child', cube_me, loc=(2.0, 0.0, 1.0), scale=(1.0, 2.0, 0.5), mode='ZXY')
    child.rotation_euler = (0.2, 0.7, -0.4)
    inv = mul(Matrix.Translation((0.5, -0.25, 0.1)), Matrix.Rotation(0.4, 4, 'Z'))
    set_parent(child, root_ob, inv)
    update()
    grand = add('GrandChild', pyr_me, loc=(0.0, 1.0, 2.0), mode='QUATERNION')
    grand.rotation_quaternion = (2.0, 0.5, 0.1, 0.3)  # volontairement non normalisé
    grand.delta_location = (0.1, 0.2, 0.3)
    grand.delta_rotation_quaternion = (0.9, 0.1, 0.0, 0.2)
    grand.delta_scale = (1.1, 0.9, 1.2)
    set_parent(grand, child, child.matrix_world.inverted())
    aa = add('AxisAngle', None, loc=(-3.0, 1.0, 0.0), mode='AXIS_ANGLE')
    aa.rotation_axis_angle = (1.2, 0.2, 0.5, 1.0)
    for i, order in enumerate(('XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX')):
        e = add('Eul_' + order, None, loc=(i * 1.5, -4.0, 0.0), scale=(1.0, 1.5, 0.75), mode=order)
        e.rotation_euler = (0.4, -0.7, 1.3)
        e.delta_rotation_euler = (0.1, 0.2, -0.3)
        e.delta_scale = (2.0, 1.0, 0.5)
        e.delta_location = (0.0, 0.0, 0.25)
    add('NegScale', pyr_me, loc=(-6.0, 0.0, 0.0), rot=(0.0, 0.3, 0.0), scale=(-1.0, 1.0, 1.5))

    def vert_parent():
        ob = add('VertParent', None, loc=(0.0, 0.0, 0.5))
        ob.parent = child
        ob.parent_type = 'VERTEX'
        ob.parent_vertices = (2, 0, 0)
        EXPECT['warn'].append('vertex_parent')
    attempt('parent sommet', vert_parent)

    def constrained():
        ob = add('Constrained', None, loc=(4.0, 4.0, 4.0))
        c = ob.constraints.new('COPY_LOCATION')
        c.target = root_ob
        EXPECT['warn'].append('constraint')
    attempt('contrainte', constrained)

    def animated():
        ob = add('Animated', None, loc=(0.0, -8.0, 0.0))
        ob.keyframe_insert(data_path='location', frame=1)
        ob.location = (0.0, -8.0, 2.0)
        ob.keyframe_insert(data_path='location', frame=20)
        sc.frame_set(1)
        EXPECT['warn'].append('animation')
    attempt('animation', animated)

    # --- maillages
    ngon = add('NgonPrism', new_mesh('NgonPrismMesh', prism(7)), 'A', loc=(0.0, 3.0, 0.0), rot=(0.1, 0.2, 0.3))
    ngon.data.materials.append(mat('MatPrincipled'))

    mm_me = new_mesh('MultiMatMesh', cube(0.5))
    for name in ('MatPrincipled', 'MatGlass', 'MatEmissive'):
        mm_me.materials.append(mat(name))
    for i, f in enumerate(mesh_faces(mm_me)):
        f.material_index = i % 3
    mm = add('MultiMat', mm_me, 'A', loc=(3.0, 3.0, 0.0))

    def object_slot():
        mm.material_slots[1].link = 'OBJECT'
        mm.material_slots[1].material = mat('MatDiffuse')
    attempt('emplacement lié à un objet', object_slot)

    sm_me = new_mesh('SmoothAllMesh', prism(12))
    for f in mesh_faces(sm_me):
        f.use_smooth = True
    add('SmoothAll', sm_me, 'A_sub', loc=(6.0, 3.0, 0.0))

    auto_me = new_mesh('SmoothAutoMesh', prism(12))
    for f in mesh_faces(auto_me):
        f.use_smooth = True
    auto_ob = add('SmoothAuto', auto_me, 'A_sub', loc=(9.0, 3.0, 0.0))
    if hasattr(auto_me, 'use_auto_smooth'):
        auto_me.use_auto_smooth = True
        if isinstance(auto_me.auto_smooth_angle, int):
            auto_me.auto_smooth_angle = 45
        else:
            auto_me.auto_smooth_angle = math.radians(45.0)
        EXPECT['auto_smooth'] = {'SmoothAuto': 45.0}
    else:
        def smooth_by_angle():
            # Ce que fait « Shade Auto Smooth » (4.1+) : le groupe de nœuds « Smooth by Angle » des
            # ressources essentielles est ajouté au fichier puis posé en modificateur. L'opérateur
            # lui-même attend le chargement asynchrone des ressources, indisponible en arrière-plan.
            base = bpy.utils.system_resource('DATAFILES')
            path = os.path.join(base, 'assets', 'geometry_nodes', 'smooth_by_angle.blend')
            if not os.path.exists(path):  # Blender 5.x : ressources regroupées
                path = os.path.join(base, 'assets', 'nodes', 'geometry_nodes_essentials.blend')
            with bpy.data.libraries.load(path, link=False) as (data_from, data_to):
                data_to.node_groups = [n for n in data_from.node_groups if n == 'Smooth by Angle']
            group = data_to.node_groups[0]
            md = auto_ob.modifiers.new('Smooth by Angle', 'NODES')
            md.node_group = group
            ident = 'Input_1'
            iface = getattr(group, 'interface', None)
            for item in (iface.items_tree if iface is not None else []):
                if getattr(item, 'in_out', '') == 'INPUT' and item.name == 'Angle':
                    ident = item.identifier
            md[ident] = math.radians(45.0)
            EXPECT['auto_smooth'] = {'SmoothAuto': 45.0}
        attempt('Smooth by Angle', smooth_by_angle)

    mixed_me = new_mesh('SmoothMixedMesh', prism(6))
    for i, f in enumerate(mesh_faces(mixed_me)):
        f.use_smooth = i < 2
    add('SmoothMixed', mixed_me, 'A_sub', loc=(12.0, 3.0, 0.0))

    shared = new_mesh('SharedMesh', pyramid(0.75, 1.0))
    shared.materials.append(mat('MatDiffuse'))
    add('LinkedA', shared, loc=(-2.0, -2.0, 0.0))
    add('LinkedB', shared, loc=(-4.0, -2.0, 0.0), rot=(0.0, 0.0, 0.7), scale=(1.0, 1.0, 2.0))

    loose_geo = ([(-1, -1, 0), (1, -1, 0), (1, 1, 0), (-1, 1, 0), (2, 0, 0), (3, 0, 1), (5, 5, 5)], [(0, 1, 2, 3)])
    add('LooseGeom', new_mesh('LooseGeomMesh', loose_geo, edges=[(4, 5)]), loc=(-8.0, -2.0, 0.0))
    add('EmptyMesh', bpy.data.meshes.new('EmptyMeshData'), loc=(-10.0, -2.0, 0.0))
    EXPECT['empties']['EmptyMesh'] = 'maillage vide'

    tex_me = new_mesh('TexturedMesh', plane())
    tex_me.materials.append(mat('MatTextured'))
    add('TexturedObj', tex_me, loc=(0.0, -6.0, 0.0))
    nn_me = new_mesh('NoNodesMesh', plane())
    nn_me.materials.append(mat('MatNoNodes'))
    add('NoNodesObj', nn_me, loc=(3.0, -6.0, 0.0))
    mix_me = new_mesh('MixMesh', plane())
    mix_me.materials.append(mat('MatMix'))
    add('MixObj', mix_me, loc=(6.0, -6.0, 0.0))
    tr_me = new_mesh('TransparentMesh', plane())
    tr_me.materials.append(mat('MatTransparent'))
    add('TransparentObj', tr_me, loc=(9.0, -6.0, 0.0))

    # --- visibilité
    hv = add('HiddenViewport', cube_me, loc=(0.0, 9.0, 0.0))
    hide_viewport(hv)
    hr = add('HiddenRender', cube_me, loc=(3.0, 9.0, 0.0))
    hr.hide_render = True
    eye = add('HiddenEye', cube_me, loc=(6.0, 9.0, 0.0))
    add('InHiddenCol', cube_me, 'hidden', loc=(9.0, 9.0, 0.0))
    add('InExcluded', cube_me, 'excluded', loc=(12.0, 9.0, 0.0), rot=(0.5, 0.0, 0.0))
    add('InEyeOff', cube_me, 'eye', loc=(15.0, 9.0, 0.0))
    wire = add('WireObj', cube_me, loc=(18.0, 9.0, 0.0))
    display(wire, 'WIRE')
    bounds = add('BoundsObj', cube_me, loc=(21.0, 9.0, 0.0))
    display(bounds, 'BOUNDS')

    # --- lumières
    lp = new_light('LightPointData', 'POINT')
    lp.color = (1.0, 0.5, 0.25)
    lp.energy = 500.0 if NEW else 2.5
    lp.shadow_soft_size = 0.25
    add('LightPoint', lp, loc=(4.0, 1.0, 6.0))
    ls = new_light('LightSunData', 'SUN')
    ls.energy = 3.5
    ls.color = (1.0, 0.95, 0.8)
    attempt('angle du soleil', lambda: setattr(ls, 'angle', math.radians(2.0)))
    add('LightSun', ls, loc=(0.0, 0.0, 10.0), rot=(0.6, 0.1, 0.9))
    lsp = new_light('LightSpotData', 'SPOT')
    lsp.energy = 800.0 if NEW else 4.0
    lsp.spot_size = 1.0
    lsp.spot_blend = 0.3
    lsp.shadow_soft_size = 0.1
    add('LightSpot', lsp, loc=(-4.0, 1.0, 6.0), rot=(0.4, 0.0, 0.0))
    lar = new_light('LightAreaData', 'AREA')
    lar.energy = 120.0 if NEW else 1.5
    lar.shape = 'RECTANGLE'
    lar.size = 2.0
    lar.size_y = 0.5
    add('LightArea', lar, loc=(0.0, 4.0, 6.0))

    def area_disk():
        d = new_light('LightAreaDiskData', 'AREA')
        d.shape = 'DISK'
        d.size = 1.5
        d.energy = 60.0
        add('LightAreaDisk', d, loc=(2.0, 4.0, 6.0))
    if NEW:
        attempt('lumière disque', area_disk)

    def no_shadow():
        d = new_light('LightNoShadowData', 'POINT')
        d.energy = 50.0 if NEW else 1.0
        if hasattr(d, 'use_shadow'):
            d.use_shadow = False
        else:
            d.shadow_method = 'NOSHADOW'
            cy = getattr(d, 'cycles', None)
            if cy is not None:
                cy.cast_shadow = False
        add('LightNoShadow', d, loc=(6.0, 1.0, 6.0))
    attempt('lumière sans ombre', no_shadow)

    def cycles_lamp():
        # Avant 2.8, Cycles lit la puissance dans le nœud Emission de la lampe (en watts).
        d = new_light('LightNodesData', 'POINT')
        d.use_nodes = True
        em = [n for n in d.node_tree.nodes if n.type == 'EMISSION'][0]
        em.inputs['Strength'].default_value = 250.0
        em.inputs['Color'].default_value = (0.2, 0.4, 1.0, 1.0)
        add('LightNodes', d, loc=(8.0, 1.0, 6.0))
    if not NEW and HAS_NODE_IDNAME:
        attempt('lampe Cycles à nœuds', cycles_lamp)

    # --- caméras
    cp = bpy.data.cameras.new('CamPerspData')
    cp.lens = 35.0
    attempt('capteur', lambda: setattr(cp, 'sensor_width', 36.0))
    cp.clip_start, cp.clip_end = 0.25, 250.0
    if hasattr(cp, 'dof') and hasattr(cp.dof, 'use_dof'):
        cp.dof.use_dof = True
        cp.dof.focus_distance = 4.2
        cp.dof.aperture_fstop = 1.8
    else:
        cp.dof_distance = 4.2

        def legacy_dof():
            cp.cycles.aperture_type = 'FSTOP'
            cp.cycles.aperture_fstop = 1.8
        attempt('profondeur de champ Cycles', legacy_dof)
    cam = add('CamPersp', cp, loc=(7.0, -7.0, 5.0), rot=(1.1, 0.0, 0.8))
    sc.camera = cam
    co = bpy.data.cameras.new('CamOrthoData')
    co.type = 'ORTHO'
    co.ortho_scale = 7.5
    add('CamOrtho', co, loc=(0.0, 0.0, 12.0))

    def cam_vertical():
        cv = bpy.data.cameras.new('CamVertData')
        cv.sensor_fit = 'VERTICAL'
        cv.sensor_height = 20.0
        cv.lens = 50.0
        add('CamVert', cv, loc=(-7.0, -7.0, 5.0), rot=(1.2, 0.0, -0.8))
    attempt('caméra à capteur vertical', cam_vertical)

    # --- modificateurs
    def mod_object(name, x):
        return add(name, new_mesh(name + 'Mesh', cube(0.5)), loc=(x, 14.0, 0.0))

    def m_mirror():
        ob = mod_object('ModMirror', 0.0)
        md = ob.modifiers.new('Miroir', 'MIRROR')
        if hasattr(md, 'use_axis'):
            md.use_axis = (True, True, False)
        else:
            md.use_x, md.use_y, md.use_z = True, True, False
        md.use_mirror_merge = True
        md.merge_threshold = 0.002
        EXPECT['native_modifiers']['ModMirror'] = [{'type': 'mirror', 'axisX': True, 'axisY': True, 'axisZ': False, 'merge': True, 'mergeDist': 0.002}]
    attempt('modificateur miroir', m_mirror)

    def m_array():
        ob = mod_object('ModArray', 3.0)
        md = ob.modifiers.new('Reseau', 'ARRAY')
        md.fit_type = 'FIXED_COUNT'
        md.count = 4
        md.use_relative_offset = True
        md.relative_offset_displace = (1.5, 0.0, 0.0)
        md.use_constant_offset = True
        md.constant_offset_displace = (0.0, 0.0, 0.2)
        md.use_merge_vertices = False
        EXPECT['native_modifiers']['ModArray'] = [{'type': 'array', 'count': 4, 'relative': [1.5, 0.0, 0.0], 'constant': [0.0, 0.0, 0.2]}]
    attempt('modificateur réseau', m_array)

    def m_bevel():
        ob = mod_object('ModBevel', 6.0)
        md = ob.modifiers.new('Biseau', 'BEVEL')
        md.width = 0.05
        md.segments = 3
        md.limit_method = 'ANGLE'
        md.angle_limit = math.radians(40.0)
        EXPECT['native_modifiers']['ModBevel'] = [{'type': 'bevel', 'width': 0.05, 'segments': 3, 'angleLimit': 40.0}]
    attempt('modificateur biseau', m_bevel)

    def m_subsurf():
        ob = mod_object('ModSubsurf', 9.0)
        md = ob.modifiers.new('Subdivision', 'SUBSURF')
        md.levels = 2
        EXPECT['native_modifiers']['ModSubsurf'] = [{'type': 'subsurf', 'levels': 2}]
    attempt('modificateur subdivision', m_subsurf)

    def m_solidify():
        ob = add('ModSolidify', new_mesh('ModSolidifyMesh', plane()), loc=(12.0, 14.0, 0.0))
        md = ob.modifiers.new('Solidifier', 'SOLIDIFY')
        md.thickness = 0.1
        md.offset = -1.0
        md.use_even_offset = False
        md.use_rim = True
        if hasattr(md, 'use_quality_normals'):
            md.use_quality_normals = False
        EXPECT['native_modifiers']['ModSolidify'] = [{'type': 'solidify', 'thickness': 0.1, 'offset': -1.0}]
    attempt('modificateur solidifier', m_solidify)

    def m_boolean():
        ob = mod_object('ModBoolean', 15.0)
        cutter = add('BoolCutter', new_mesh('BoolCutterMesh', cube(0.3)), loc=(15.4, 14.4, 0.4))
        display(cutter, 'WIRE')
        md = ob.modifiers.new('Booleen', 'BOOLEAN')
        md.operation = 'DIFFERENCE'
        md.object = cutter
        EXPECT['native_modifiers']['ModBoolean'] = [{'type': 'boolean', 'operation': 'difference', 'target': 'BoolCutter'}]
    attempt('modificateur booléen', m_boolean)

    def m_stack():
        ob = mod_object('ModStack', 18.0)
        md = ob.modifiers.new('Miroir', 'MIRROR')
        if hasattr(md, 'use_axis'):
            md.use_axis = (False, False, True)
        else:
            md.use_x, md.use_y, md.use_z = False, False, True
        md.use_mirror_merge = False
        sub = ob.modifiers.new('Subdivision', 'SUBSURF')
        sub.levels = 1
        hidden = ob.modifiers.new('Decimation', 'DECIMATE')  # non traduisible mais désactivé à l'écran
        hidden.show_viewport = False
        EXPECT['native_modifiers']['ModStack'] = [
            {'type': 'mirror', 'axisX': False, 'axisY': False, 'axisZ': True, 'merge': False},
            {'type': 'subsurf', 'levels': 1}]
    attempt('pile de modificateurs', m_stack)

    def m_mirror_object():
        ob = mod_object('ModMirrorObj', 21.0)
        md = ob.modifiers.new('Miroir', 'MIRROR')
        md.mirror_object = root_ob
        EXPECT['pending']['ModMirrorObj'] = 'modificateur'
    attempt('miroir avec objet', m_mirror_object)

    def m_displace():
        ob = mod_object('ModDisplace', 24.0)
        ob.modifiers.new('Deplacement', 'DISPLACE')
        sub = ob.modifiers.new('Subdivision', 'SUBSURF')
        sub.levels = 1
        EXPECT['pending']['ModDisplace'] = 'modificateur'
        EXPECT['native_modifiers']['ModDisplace'] = [{'type': 'subsurf', 'levels': 1}]
    attempt('modificateur déplacement', m_displace)

    def m_bevel_weight():
        ob = mod_object('ModBevelWeight', 27.0)
        md = ob.modifiers.new('Biseau', 'BEVEL')
        md.limit_method = 'WEIGHT'
        EXPECT['pending']['ModBevelWeight'] = 'modificateur'
    attempt('biseau par poids', m_bevel_weight)

    def m_array_fit():
        ob = mod_object('ModArrayFit', 30.0)
        md = ob.modifiers.new('Reseau', 'ARRAY')
        md.fit_type = 'FIT_LENGTH'
        md.fit_length = 5.0
        EXPECT['pending']['ModArrayFit'] = 'modificateur'
    attempt('réseau ajusté en longueur', m_array_fit)

    def m_simple_subsurf():
        ob = mod_object('ModSubsurfSimple', 33.0)
        md = ob.modifiers.new('Subdivision', 'SUBSURF')
        md.subdivision_type = 'SIMPLE'
        EXPECT['pending']['ModSubsurfSimple'] = 'modificateur'
    attempt('subdivision simple', m_simple_subsurf)

    def m_nodes():
        ob = mod_object('ModNodes', 36.0)
        md = ob.modifiers.new('Noeuds', 'NODES')
        md.node_group = bpy.data.node_groups.new('GroupeGeo', 'GeometryNodeTree')
        EXPECT['pending']['ModNodes'] = 'modificateur'
    if V >= (2, 92, 0):
        attempt('nœuds de géométrie', m_nodes)

    def armature():
        arm = bpy.data.armatures.new('ArmatureData')
        arm_ob = add('ArmatureObj', arm, loc=(39.0, 14.0, 0.0))
        EXPECT['empties']['ArmatureObj'] = 'armature'
        ob = mod_object('ModArmature', 39.0)
        md = ob.modifiers.new('Armature', 'ARMATURE')
        md.object = arm_ob
        EXPECT['pending']['ModArmature'] = 'modificateur'
    attempt('armature', armature)

    def shape_keys():
        ob = mod_object('ShapeKeyed', 42.0)
        ob.shape_key_add(name='Basis')
        kb = ob.shape_key_add(name='Gonfle')
        for p in kb.data:
            p.co = p.co * 1.5
        kb.value = 0.6
        EXPECT['pending']['ShapeKeyed'] = 'cl' + chr(0xe9) + 's de forme'
        zero = mod_object('ShapeKeyZero', 45.0)
        zero.shape_key_add(name='Basis')
        kz = zero.shape_key_add(name='Inactif')
        for p in kz.data:
            p.co = p.co * 2.0
        kz.value = 0.0
    attempt('clés de forme', shape_keys)

    # --- objets que seul Blender sait évaluer
    def curve():
        cu = bpy.data.curves.new('CurveData', 'CURVE')
        cu.dimensions = '3D'
        sp = cu.splines.new('BEZIER')
        sp.bezier_points.add(1)
        sp.bezier_points[0].co = (-1.0, 0.0, 0.0)
        sp.bezier_points[0].handle_left = (-1.5, -0.5, 0.0)
        sp.bezier_points[0].handle_right = (-0.5, 0.5, 0.0)
        sp.bezier_points[1].co = (1.0, 0.0, 0.0)
        sp.bezier_points[1].handle_left = (0.5, -0.5, 0.0)
        sp.bezier_points[1].handle_right = (1.5, 0.5, 0.0)
        cu.bevel_depth = 0.1
        add('CurveObj', cu, loc=(0.0, 18.0, 0.0))
        EXPECT['pending']['CurveObj'] = 'courbe'
        return cu
    curve_data = attempt('courbe', curve)

    def text():
        fo = bpy.data.curves.new('TextData', 'FONT')
        fo.body = 'CoForge'
        add('TextObj', fo, loc=(3.0, 18.0, 0.0))
        EXPECT['pending']['TextObj'] = 'texte'
    attempt('texte', text)

    def surface():
        su = bpy.data.curves.new('SurfData', 'SURFACE')
        ob = add('SurfObj', su, loc=(6.0, 18.0, 0.0))
        EXPECT['pending']['SurfObj'] = 'surface' if ob.type == 'SURFACE' else 'courbe'
    attempt('surface', surface)

    def metaball():
        mb = bpy.data.metaballs.new('MetaData')
        mb.elements.new()
        add('MetaObj', mb, loc=(9.0, 18.0, 0.0))
        EXPECT['pending']['MetaObj'] = 'm' + chr(0xe9) + 'taballe'
    attempt('métaballe', metaball)

    def lattice():
        add('LatticeObj', bpy.data.lattices.new('LatticeData'), loc=(12.0, 18.0, 0.0))
        EXPECT['empties']['LatticeObj'] = 'lattice'
    attempt('lattice', lattice)

    def volume():
        add('VolumeObj', bpy.data.volumes.new('VolumeData'), loc=(15.0, 18.0, 0.0))
        EXPECT['pending']['VolumeObj'] = 'volume'
    if hasattr(bpy.data, 'volumes'):
        attempt('volume', volume)

    def hair_curves():
        add('HairObj', bpy.data.hair_curves.new('HairData'), loc=(18.0, 18.0, 0.0))
        EXPECT['pending']['HairObj'] = 'courbes'
    if hasattr(bpy.data, 'hair_curves'):
        attempt('courbes (cheveux)', hair_curves)

    def pointcloud():
        add('PointCloudObj', bpy.data.pointclouds.new('PointCloudData'), loc=(21.0, 18.0, 0.0))
        EXPECT['pending']['PointCloudObj'] = 'nuage de points'
    if hasattr(bpy.data, 'pointclouds'):
        attempt('nuage de points', pointcloud)

    def grease_pencil():
        col = getattr(bpy.data, 'grease_pencils_v3', None) or bpy.data.grease_pencils
        add('GreasePencilObj', col.new('GreasePencilData'), loc=(24.0, 18.0, 0.0))
        EXPECT['pending']['GreasePencilObj'] = 'grease pencil'
    if NEW:
        attempt('grease pencil', grease_pencil)

    # --- instances de collection
    def instances():
        src_cube = add('SrcCube', cube_me, 'src', loc=(1.0, 0.0, 0.0), rot=(0.0, 0.0, 0.5))
        src_child = add('SrcChild', pyr_me, 'src', loc=(0.0, 0.0, 1.5))
        set_parent(src_child, src_cube)
        sl = new_light('SrcLightData', 'POINT')
        add('SrcLight', sl, 'src', loc=(0.0, 2.0, 2.0))
        add('SrcSubObj', shared, 'src_sub', loc=(-2.0, 0.0, 0.0), scale=(0.5, 0.5, 0.5))
        if curve_data is not None:
            add('SrcCurve', curve_data, 'src', loc=(0.0, -2.0, 0.0))
        if NEW:
            group = COLLS['src']
            group.instance_offset = (0.5, 0.0, 0.25)
        else:
            group = bpy.data.groups.new('InstSource')
            for name in ('SrcCube', 'SrcChild', 'SrcLight', 'SrcSubObj', 'SrcCurve'):
                if name in bpy.data.objects:
                    group.objects.link(bpy.data.objects[name])
            group.dupli_offset = (0.5, 0.0, 0.25)

        def instancer(name, grp, where, loc, rot, scale):
            e = add(name, None, where, loc=loc, rot=rot, scale=scale)
            if NEW:
                e.instance_type = 'COLLECTION'
                e.instance_collection = grp
            else:
                e.dupli_type = 'GROUP'
                e.dupli_group = grp
            return e
        instancer('Inst1', group, 'root', (5.0, 5.0, 0.0), (0.0, 0.0, 0.8), (2.0, 2.0, 2.0))
        instancer('Inst2', group, 'root', (-5.0, 5.0, 1.0), (0.3, 0.0, 0.0), (1.0, 2.0, 1.0))
        outer_inst = instancer('OuterInst', group, 'outer', (0.0, 2.0, 0.0), (0.0, 0.0, -0.4), (1.0, 1.0, 1.0))
        outer_mesh = add('OuterMesh', cube_me, 'outer', loc=(3.0, 0.0, 0.0), scale=(0.25, 0.25, 0.25))
        if NEW:
            outer = COLLS['outer']
        else:
            outer = bpy.data.groups.new('InstOuter')
            outer.objects.link(outer_inst)
            outer.objects.link(outer_mesh)
        instancer('InstNested', outer, 'root', (8.0, -3.0, 0.0), (0.0, 0.2, 1.0), (1.5, 1.5, 1.5))
        EXPECT['instancers'] = ['Inst1', 'Inst2', 'InstNested'] + ([] if NEW else ['OuterInst'])
    attempt('instances de collection', instances)

    # --- données liées depuis une bibliothèque externe
    def linked():
        if lib_path is None:
            raise RuntimeError('pas de bibliothèque')
        with bpy.data.libraries.load(lib_path, link=True) as (data_from, data_to):
            data_to.meshes = ['LibMesh']
            data_to.objects = ['LibObject']
        lib_mesh = data_to.meshes[0]
        lib_ob = data_to.objects[0]
        add('LinkedDataObj', lib_mesh, loc=(0.0, 22.0, 0.0))
        EXPECT['pending']['LinkedDataObj'] = 'biblioth' + chr(0xe8) + 'que'
        link(lib_ob)
        EXPECT['pending']['LibObject'] = 'biblioth' + chr(0xe8) + 'que'
    attempt('données liées (bibliothèque)', linked)

    # --- monde : ciel procédural
    def world_sky():
        w = bpy.data.worlds.new('MondeCiel')
        sc.world = w
        nt = node_tree_of(w)
        out = nt.nodes.new('ShaderNodeOutputWorld')
        bg = nt.nodes.new('ShaderNodeBackground')
        sky = nt.nodes.new('ShaderNodeTexSky')
        nt.links.new(sky.outputs[0], bg.inputs['Color'])
        nt.links.new(bg.outputs[0], out.inputs[0])
        bg.inputs['Strength'].default_value = 1.7
        exp = {'mode': 'sky', 'strength': 1.7, 'sky_type': sky.sky_type}
        if hasattr(sky, 'sun_elevation') and sky.sky_type not in ('PREETHAM', 'HOSEK_WILKIE'):
            sky.sun_elevation = math.radians(25.0)
            sky.sun_rotation = math.radians(60.0)
            exp['sun_elevation'] = 25.0
            exp['sun_rotation'] = 60.0
        else:
            d = Vector((0.4, -0.6, 0.5)).normalized()
            sky.sun_direction = d
            exp['sun_direction'] = [float(c) for c in d]
        EXPECT['world'] = exp
    if HAS_NODE_IDNAME:
        attempt('monde ciel', world_sky)
    if 'world' not in EXPECT:
        def world_plain():
            w = bpy.data.worlds.new('MondeUni')
            sc.world = w
            if hasattr(w, 'color'):
                w.color = (0.05, 0.1, 0.2)
            else:
                w.horizon_color = (0.05, 0.1, 0.2)
            EXPECT['world'] = {'mode': 'color', 'strength': 1.0, 'expect_color': [0.05, 0.1, 0.2]}
        attempt('monde uni', world_plain)

    # --- seconde scène (non importée, signalée)
    def other_scene():
        other = bpy.data.scenes.new('Autre')
        ob = bpy.data.objects.new('AutreObj', None)
        if NEW:
            other.collection.objects.link(ob)
        else:
            other.objects.link(ob)
    attempt('seconde scène', other_scene)

    # --- matrices monde relevées quand tout est encore visible et inclus
    world = world_matrices()

    if NEW:
        COLLS['hidden'].hide_viewport = True
        lcs = bpy.context.view_layer.layer_collection.children
        lcs['ColExcluded'].exclude = True
        lcs['ColEyeOff'].hide_viewport = True
        attempt('masquage par oeil', lambda: eye.hide_set(True))
    return collect(sc, world)


# ---------------------------------------------------------------- petite scène de variantes

def build_mini():
    sc = reset()
    sc.name = 'Mini'
    EXPECT.clear()
    EXPECT.update({'materials': {}, 'pending': {}, 'native_modifiers': {}, 'empties': {}, 'warn': []})
    del SKIPPED[:]
    COLLS.clear()

    r = sc.render
    r.resolution_x, r.resolution_y, r.resolution_percentage = 600, 900, 100
    for engine in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE', 'BLENDER_RENDER'):
        try:
            r.engine = engine
            break
        except Exception:  # noqa
            pass

    def transparent():
        if hasattr(r, 'film_transparent'):
            r.film_transparent = True
        else:
            r.alpha_mode = 'TRANSPARENT'
    attempt('fond transparent', transparent)
    vs = getattr(sc, 'view_settings', None)
    if vs is not None:
        for name in ('Standard', 'Default'):
            try:
                vs.view_transform = name
                break
            except Exception:  # noqa
                pass
        vs.exposure = -1.25

    me = new_mesh('MiniCubeMesh', cube())
    add('MiniCube', me, loc=(1.0, -2.0, 0.5), rot=(0.2, 0.4, 0.6), scale=(1.0, 2.0, 3.0))
    cp = bpy.data.cameras.new('MiniCamData')
    cp.lens = 28.0
    add('MiniCam', cp, loc=(5.0, -5.0, 4.0), rot=(1.0, 0.0, 0.7))
    co = bpy.data.cameras.new('MiniCamOrthoData')
    co.type = 'ORTHO'
    co.ortho_scale = 4.0
    cam = add('MiniCamOrtho', co, loc=(0.0, 0.0, 9.0))
    sc.camera = cam
    sun = new_light('MiniSunData', 'SUN')
    sun.energy = 2.0
    add('MiniSun', sun, loc=(0.0, 0.0, 5.0), rot=(0.5, 0.5, 0.0))

    def world_color():
        w = bpy.data.worlds.new('MondeCouleur')
        sc.world = w
        nt = node_tree_of(w) if HAS_NODE_IDNAME else None
        if nt is not None and (NEW or r.engine == 'CYCLES'):
            out = nt.nodes.new('ShaderNodeOutputWorld')
            bg = nt.nodes.new('ShaderNodeBackground')
            nt.links.new(bg.outputs[0], out.inputs[0])
            bg.inputs['Color'].default_value = (0.2, 0.4, 0.1, 1.0)
            bg.inputs['Strength'].default_value = 0.5
            EXPECT['world'] = {'mode': 'color', 'strength': 0.5, 'expect_color': [0.2, 0.4, 0.1]}
        else:
            try:
                w.use_nodes = False
            except Exception:  # noqa
                pass
            if hasattr(w, 'color'):
                w.color = (0.2, 0.4, 0.1)
            else:
                w.horizon_color = (0.2, 0.4, 0.1)
            EXPECT['world'] = {'mode': 'color', 'strength': 1.0, 'expect_color': [0.2, 0.4, 0.1]}
    attempt('monde couleur', world_color)

    def recursive_instance():
        # Collection qui s'instancie elle-même : le lecteur doit s'arrêter seul.
        if NEW:
            grp = bpy.data.collections.new('Recursive')
            inner = bpy.data.objects.new('RecInner', None)
            grp.objects.link(inner)
            mesh_ob = bpy.data.objects.new('RecMesh', me)
            grp.objects.link(mesh_ob)
            inner.instance_type = 'COLLECTION'
            inner.instance_collection = grp
            outer = add('RecOuter', None, loc=(0.0, 6.0, 0.0))
            outer.instance_type = 'COLLECTION'
            outer.instance_collection = grp
        else:
            grp = bpy.data.groups.new('Recursive')
            inner = add('RecInner', None, 'src')
            mesh_ob = add('RecMesh', me, 'src')
            grp.objects.link(inner)
            grp.objects.link(mesh_ob)
            inner.dupli_type = 'GROUP'
            inner.dupli_group = grp
            outer = add('RecOuter', None, loc=(0.0, 6.0, 0.0))
            outer.dupli_type = 'GROUP'
            outer.dupli_group = grp
        EXPECT['recursive'] = True
    attempt('instance récursive', recursive_instance)

    world = world_matrices()
    t = collect(sc, world)
    t['instances'] = []  # non comparées : la profondeur de récursion est propre à chaque lecteur
    return t


def build_asset(path):
    """Fichier SANS scène, comme en écrivent les bibliothèques d'assets et les scripts de
    production : `bpy.data.libraries.write` avec un objet et ses dépendances (maillage, matériaux)."""
    reset()
    me = new_mesh('AssetMesh', cube(0.5))
    for name in ('AssetMatA', 'AssetMatB'):
        m = bpy.data.materials.new(name)
        m.diffuse_color = (0.8, 0.3, 0.1, 1.0) if NEW else (0.8, 0.3, 0.1)
        me.materials.append(m)
    for i, f in enumerate(mesh_faces(me)):
        f.material_index = i % 2
    ob = add('AssetCube', me, loc=(1.0, 2.0, 3.0), rot=(0.1, 0.2, 0.3), scale=(1.0, 1.0, 2.0))
    world = world_matrices()
    if os.path.exists(path):
        os.remove(path)
    bpy.data.libraries.write(path, set([ob]), compress=False)
    log('ecrit %s (%d octets)' % (path, os.path.getsize(path)))
    return {'blender': list(V), 'objects': [{'name': ob.name, 'matrix_world': world[ob.name], 'mesh': mesh_truth(me),
                                              'slots': [s.material.name for s in ob.material_slots]}]}


def main():
    if not os.path.isdir(OUT_DIR):
        os.makedirs(OUT_DIR)
    log('Blender %s -> %s (%s)' % (bpy.app.version_string, OUT_DIR, TAG))
    lib_path = os.path.join(OUT_DIR, '_lib_%s.blend' % TAG)
    attempt('bibliothèque', lambda: build_library(lib_path))
    if not os.path.exists(lib_path):
        lib_path = None
    truth = build_full(lib_path)
    save(os.path.join(OUT_DIR, TAG + '_full.blend'), True)
    write_json(os.path.join(OUT_DIR, TAG + '_full.json'), truth)
    truth = build_mini()
    save(os.path.join(OUT_DIR, TAG + '_mini.blend'), False)
    write_json(os.path.join(OUT_DIR, TAG + '_mini.json'), truth)
    if lib_path and os.path.exists(lib_path):
        os.remove(lib_path)
    asset = attempt('fichier sans scène', lambda: build_asset(os.path.join(OUT_DIR, TAG + '_asset.blend')))
    if asset is not None:
        write_json(os.path.join(OUT_DIR, TAG + '_asset.json'), asset)
    log('TERMINE')


main()
