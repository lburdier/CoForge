"""Fixture « énumérations des nœuds de la vague 3 » (tests/nodes.shader.import.test.ts).

Usage : blender --background --factory-startup --python make_enums_v3.py -- <sortie.blend> <sortie.json>

Un matériau « Enums » : pour chaque nœud et chaque valeur de ses énumérations, un nœud réglé sur
cette valeur et nommé « idname|prop|valeur ». Le JSON donne la vérité (version, noms).
Plus un petit arbre complet branché (briques → Principled, Voronoï → rampe, courbes RVB).
"""
import bpy, json, sys

argv = sys.argv[sys.argv.index("--") + 1:]
out_blend, out_json = argv[0], argv[1]
bpy.ops.wm.read_factory_settings(use_empty=True)
mat = bpy.data.materials.new("Enums")
mat.use_nodes = True
nt = mat.node_tree
for n in list(nt.nodes):
    nt.nodes.remove(n)

ENUMS = {
    "ShaderNodeTexNoise": ["noise_type", "noise_dimensions"],
    "ShaderNodeTexVoronoi": ["voronoi_dimensions", "feature", "distance"],
    "ShaderNodeTexBrick": [],
    "ShaderNodeTexGabor": ["gabor_type"],
    "ShaderNodeTexImage": ["projection", "extension", "interpolation"],
    "ShaderNodeTexEnvironment": ["projection"],
    "ShaderNodeTexSky": ["sky_type"],
    "ShaderNodeTangent": ["direction_type", "axis"],
    "ShaderNodeAttribute": ["attribute_type"],
    "ShaderNodeNormalMap": ["space"],
    "ShaderNodeDisplacement": ["space"],
    "ShaderNodeVectorDisplacement": ["space"],
    "ShaderNodeVectorRotate": ["rotation_type"],
    "ShaderNodeVectorTransform": ["vector_type", "convert_from", "convert_to"],
    "ShaderNodeMapRange": ["data_type"],
    "ShaderNodeMix": ["factor_mode"],
    "ShaderNodeBsdfToon": ["component"],
    "ShaderNodeBsdfHair": ["component"],
    "ShaderNodeBsdfHairPrincipled": ["model", "parametrization"],
    "ShaderNodeBsdfMetallic": ["fresnel_type"],
    "ShaderNodeSubsurfaceScattering": ["falloff"],
    "ShaderNodeBsdfSheen": ["distribution"],
    "ShaderNodeVolumeScatter": ["phase"],
    "ShaderNodeTexIES": ["mode"],
    "ShaderNodeTexPointDensity": ["point_source", "space"],
}
truth = {}
y = 0
for idname, props in ENUMS.items():
    try:
        probe = nt.nodes.new(idname)
    except Exception:
        continue
    nt.nodes.remove(probe)
    if not props:
        n = nt.nodes.new(idname); n.location = (0, y); y -= 300
        n.name = f"{idname}||"
        truth[n.name] = {"idname": idname}
    for prop in props:
        if prop not in probe.bl_rna.properties if False else not hasattr(bpy.types, idname):
            continue
        rna = getattr(bpy.types, idname).bl_rna.properties.get(prop)
        if rna is None:
            continue
        for item in rna.enum_items:
            n = nt.nodes.new(idname)
            n.location = (0, y); y -= 300
            if idname == "ShaderNodeMix" and prop == "factor_mode":
                n.data_type = "VECTOR"
            try:
                setattr(n, prop, item.identifier)
            except Exception:
                nt.nodes.remove(n)
                continue
            n.name = f"{idname}|{prop}|{item.identifier}"
            truth[n.name] = {"idname": idname, "prop": prop, "value": item.identifier}

# Réglages numériques de propriétés
b = nt.nodes.new("ShaderNodeTexBrick"); b.name = "brick_props"; b.offset = 0.3; b.offset_frequency = 3; b.squash = 1.7; b.squash_frequency = 4
b.location = (600, 0)
truth["brick_props"] = {"idname": "ShaderNodeTexBrick", "offset": 0.3, "offset_frequency": 3, "squash": 1.7, "squash_frequency": 4}
s = nt.nodes.new("ShaderNodeTexSky"); s.name = "sky_props"; s.sun_elevation = 0.5; s.sun_rotation = 1.0; s.sun_intensity = 2.0; s.sun_disc = False
s.location = (600, -300)
truth["sky_props"] = {"idname": "ShaderNodeTexSky", "sun_elevation": 0.5, "sun_rotation": 1.0, "sun_intensity": 2.0, "sun_disc": False}
v = nt.nodes.new("ShaderNodeTexVoronoi"); v.name = "vor_norm"; v.normalize = True; v.location = (600, -600)
truth["vor_norm"] = {"idname": "ShaderNodeTexVoronoi", "normalize": True}
c = nt.nodes.new("ShaderNodeRGBCurve"); c.name = "curves"; c.location = (600, -900)
cm = c.mapping
cm.curves[3].points.new(0.5, 0.8)
cm.update()
truth["curves"] = {"idname": "ShaderNodeRGBCurve", "curves": [[[p.location[0], p.location[1]] for p in cu.points] for cu in cm.curves]}
fc = nt.nodes.new("ShaderNodeFloatCurve"); fc.name = "fcurve"; fc.location = (600, -1200)
fc.mapping.curves[0].points[0].location = (0.0, 0.25)
fc.mapping.update()
truth["fcurve"] = {"idname": "ShaderNodeFloatCurve", "curves": [[[p.location[0], p.location[1]] for p in cu.points] for cu in fc.mapping.curves]}
out = nt.nodes.new("ShaderNodeOutputMaterial"); out.location = (1200, 0)
bs = nt.nodes.new("ShaderNodeBsdfPrincipled"); bs.location = (900, 0)
nt.links.new(b.outputs["Color"], bs.inputs["Base Color"])
nt.links.new(bs.outputs["BSDF"], out.inputs["Surface"])

me = bpy.data.meshes.new("Support")
me.from_pydata([(0, 0, 0), (1, 0, 0), (0, 1, 0)], [], [(0, 1, 2)])
me.materials.append(mat)
ob = bpy.data.objects.new("Support", me)
bpy.context.scene.collection.objects.link(ob)
bpy.ops.wm.save_as_mainfile(filepath=out_blend, compress=True)
json.dump({"version": list(bpy.app.version), "nodes": truth}, open(out_json, "w"), indent=1)
