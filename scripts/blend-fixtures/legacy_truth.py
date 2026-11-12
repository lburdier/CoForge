# -*- coding: utf-8 -*-
"""
Vérité « telle que la reprend un Blender moderne » pour les fixtures d'avant 2.80.

Les lampes de Blender ≤ 2.79 n'ont pas d'unité physique : la seule référence pour leur
conversion est ce que fait Blender 2.80+ en ouvrant le fichier. Lancement :
    blender-2.93 --background --factory-startup tests/fixtures/blend/b279_full.blend \
        --python legacy_truth.py -- tests/fixtures/blend/b279_full_as293.json

Le fichier ouvert n'est jamais réenregistré.
"""
import bpy
import json
import sys

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
if not ARGS:
    raise SystemExit('usage : ... --python legacy_truth.py -- <sortie.json>')

lights = {}
for la in bpy.data.lights:
    d = {'type': la.type, 'energy': round(float(la.energy), 6), 'use_shadow': bool(la.use_shadow)}
    if la.type == 'SPOT':
        d['spot_size'] = round(float(la.spot_size), 6)
    lights[la.name] = d

out = {'converted_by': bpy.app.version_string, 'lights': lights}
f = open(ARGS[0], 'w')
try:
    json.dump(out, f, sort_keys=True, separators=(',', ':'))
finally:
    f.close()
print('[legacy] ecrit %s (%d lampes)' % (ARGS[0], len(lights)))
