"""Fixtures « arbres de nœuds de shader » pour le test d'import (tests/io.blend.nodes.test.ts).

Usage : blender --background --factory-startup --python make_nodes.py -- <sortie.blend> <sortie.json>

Construit un matériau avec un arbre de nœuds varié (Principled complet, textures, calcul,
mélanges, rampe, mappage, relief, cadres, redirections, nœuds réduits et muets) et, pour chaque
énumération utile, une série de nœuds qui en couvrent TOUTES les valeurs : le lecteur natif peut
ainsi vérifier sa table « entier stocké → identifiant » sur la vérité de Blender lui-même.
"""
import bpy
import json
import sys

argv = sys.argv[sys.argv.index("--") + 1:]
out_blend, out_json = argv[0], argv[1]
version = bpy.app.version

bpy.ops.wm.read_factory_settings(use_empty=True)
mat = bpy.data.materials.new("Noeuds")
mat.use_nodes = True
nt = mat.node_tree
for n in list(nt.nodes):
    nt.nodes.remove(n)


def node(idname, x, y, **props):
    n = nt.nodes.new(idname)
    n.location = (x, y)
    for k, v in props.items():
        setattr(n, k, v)
    return n


def inp(n, name):
    for s in n.inputs:
        if s.name == name or s.identifier == name:
            return s
    raise KeyError(name)


def out(n, name):
    for s in n.outputs:
        if s.name == name or s.identifier == name:
            return s
    raise KeyError(name)


link = nt.links.new

# ---------------------------------------------------------------- chaîne principale
output = node("ShaderNodeOutputMaterial", 600, 0)
bsdf = node("ShaderNodeBsdfPrincipled", 200, 0)
bsdf.label = "Surface principale"
link(out(bsdf, "BSDF"), inp(output, "Surface"))
inp(bsdf, "Metallic").default_value = 0.25
inp(bsdf, "Roughness").default_value = 0.35
inp(bsdf, "IOR").default_value = 1.6
inp(bsdf, "Alpha").default_value = 0.9
if version >= (4, 0, 0):
    inp(bsdf, "Coat Weight").default_value = 0.4
    inp(bsdf, "Coat Roughness").default_value = 0.12
    inp(bsdf, "Sheen Weight").default_value = 0.2
    inp(bsdf, "Sheen Tint").default_value = (0.9, 0.2, 0.1, 1.0)
    inp(bsdf, "Specular IOR Level").default_value = 0.7
    inp(bsdf, "Emission Color").default_value = (0.0, 0.5, 1.0, 1.0)
    inp(bsdf, "Emission Strength").default_value = 2.5
    inp(bsdf, "Transmission Weight").default_value = 0.1
    if version >= (4, 2, 0):
        inp(bsdf, "Thin Film Thickness").default_value = 300.0
else:
    inp(bsdf, "Clearcoat").default_value = 0.4
    inp(bsdf, "Clearcoat Roughness").default_value = 0.12
    inp(bsdf, "Sheen").default_value = 0.2
    inp(bsdf, "Specular").default_value = 0.7
    inp(bsdf, "Emission").default_value = (0.0, 0.5, 1.0, 1.0)
    inp(bsdf, "Emission Strength").default_value = 2.5
    inp(bsdf, "Transmission").default_value = 0.1

coord = node("ShaderNodeTexCoord", -1000, 0)
mapping = node("ShaderNodeMapping", -800, 0)
mapping.vector_type = "TEXTURE"
inp(mapping, "Location").default_value = (0.1, 0.2, 0.3)
inp(mapping, "Rotation").default_value = (0.0, 0.0, 0.5)
inp(mapping, "Scale").default_value = (2.0, 2.0, 2.0)
link(out(coord, "Object"), inp(mapping, "Vector"))
noise = node("ShaderNodeTexNoise", -600, 100)
inp(noise, "Scale").default_value = 7.5
inp(noise, "Detail").default_value = 4.0
link(out(mapping, "Vector"), inp(noise, "Vector"))
ramp = node("ShaderNodeValToRGB", -350, 100)
ramp.color_ramp.interpolation = "EASE"
ramp.color_ramp.elements[0].position = 0.2
ramp.color_ramp.elements[0].color = (0.1, 0.2, 0.6, 1.0)
ramp.color_ramp.elements[1].position = 0.8
ramp.color_ramp.elements[1].color = (1.0, 0.6, 0.1, 1.0)
e = ramp.color_ramp.elements.new(0.5)
e.color = (0.0, 1.0, 0.0, 0.5)
link(out(noise, "Fac"), inp(ramp, "Fac"))
link(out(ramp, "Color"), inp(bsdf, "Base Color"))
vor = node("ShaderNodeTexVoronoi", -600, -250)
bump = node("ShaderNodeBump", -150, -250, invert=True)
inp(bump, "Strength").default_value = 0.3
link(out(vor, "Distance"), inp(bump, "Height"))
link(out(bump, "Normal"), inp(bsdf, "Normal"))
math = node("ShaderNodeMath", -350, -100, operation="MULTIPLY", use_clamp=True)
math.inputs[1].default_value = 0.5
link(out(noise, "Fac"), math.inputs[0])
link(out(math, "Value"), inp(bsdf, "Roughness"))
rgb = node("ShaderNodeRGB", -350, 300)
rgb.outputs[0].default_value = (0.8, 0.1, 0.1, 1.0)
val = node("ShaderNodeValue", -350, 400)
val.outputs[0].default_value = 0.42
reroute = node("NodeReroute", -50, 200)
link(out(rgb, "Color"), reroute.inputs[0])

# Cadre contenant le bruit et la rampe ; un nœud réduit, un nœud muet.
frame = node("NodeFrame", -700, 300)
frame.label = "Bruit coloré"
noise.parent = frame
ramp.parent = frame
coord.hide = True
vor.mute = True

# ---------------------------------------------------------------- énumérations (toutes les valeurs)
enums = {}


def sweep(idname, prop, x0, y0, extra=None):
    probe = nt.nodes.new(idname)
    values = [it.identifier for it in probe.bl_rna.properties[prop].enum_items]
    nt.nodes.remove(probe)
    kept = []
    for v in values:
        i = len(kept)
        n = node(idname, x0 + (i % 10) * 160, y0 - (i // 10) * 120)
        try:
            if extra:
                for k, val2 in extra.items():
                    setattr(n, k, val2)
            setattr(n, prop, v)
        except TypeError:
            nt.nodes.remove(n)  # valeur refusée dans un arbre de shader
            continue
        n.label = f"enum:{prop}:{v}"
        kept.append(v)
    enums[f"{idname}.{prop}"] = kept


sweep("ShaderNodeMath", "operation", 0, -1000)
sweep("ShaderNodeVectorMath", "operation", 0, -1600)
sweep("ShaderNodeMix", "blend_type", 0, -2200, {"data_type": "RGBA"})
sweep("ShaderNodeMix", "data_type", 0, -2600)
sweep("ShaderNodeMapping", "vector_type", 0, -2900)
sweep("ShaderNodeMapRange", "interpolation_type", 0, -3100)
sweep("ShaderNodeClamp", "clamp_type", 0, -3300)
sweep("ShaderNodeTexGradient", "gradient_type", 0, -3500)
sweep("ShaderNodeTexWave", "wave_type", 0, -3800)
sweep("ShaderNodeTexWave", "bands_direction", 0, -4000)
sweep("ShaderNodeTexWave", "rings_direction", 0, -4200, {"wave_type": "RINGS"})
sweep("ShaderNodeTexWave", "wave_profile", 0, -4400)
sweep("ShaderNodeTexVoronoi", "feature", 0, -4600)
sweep("ShaderNodeTexVoronoi", "distance", 0, -4800)
sweep("ShaderNodeTexNoise", "noise_dimensions", 0, -5000)
sweep("ShaderNodeSeparateColor", "mode", 0, -5200)
sweep("ShaderNodeCombineColor", "mode", 0, -5400)
sweep("ShaderNodeBsdfGlossy", "distribution", 0, -5600)
if version < (4, 0, 0):
    sweep("ShaderNodeMixRGB", "blend_type", 0, -6000)

# ---------------------------------------------------------------- vérité terrain
def value(v):
    try:
        return [float(x) for x in v]
    except TypeError:
        return float(v) if not isinstance(v, bool) else bool(v)


nodes = {}
for n in nt.nodes:
    d = {
        "idname": n.bl_idname,
        "label": n.label,
        "location": list(n.location),
        "location_absolute": list(getattr(n, "location_absolute", n.location)),
        "width": n.width,
        "hide": n.hide,
        "mute": n.mute,
        "parent": n.parent.name if n.parent else None,
        "inputs": {},
        "outputs": {},
    }
    for s in n.inputs:
        if hasattr(s, "default_value"):
            d["inputs"][s.identifier] = value(s.default_value)
    for s in n.outputs:
        if hasattr(s, "default_value"):
            d["outputs"][s.identifier] = value(s.default_value)
    if n.bl_idname == "ShaderNodeValToRGB":
        d["ramp"] = {"interpolation": n.color_ramp.interpolation, "elements": [{"position": el.position, "color": list(el.color)} for el in n.color_ramp.elements]}
    nodes[n.name] = d

links = [[l.from_node.name, l.from_socket.identifier, l.to_node.name, l.to_socket.identifier] for l in nt.links]

ob_mesh = bpy.data.meshes.new("Support")
ob_mesh.from_pydata([(0, 0, 0), (1, 0, 0), (0, 1, 0)], [], [(0, 1, 2)])
ob = bpy.data.objects.new("Support", ob_mesh)
bpy.context.scene.collection.objects.link(ob)
ob.data.materials.append(mat)

bpy.ops.wm.save_as_mainfile(filepath=out_blend, compress=True)
with open(out_json, "w", encoding="utf-8") as f:
    json.dump({"version": list(version), "nodes": nodes, "links": links, "enums": enums}, f, indent=1)
print("OK", out_blend)
