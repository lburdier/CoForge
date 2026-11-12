import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BlendEvalMesh, BlendEvalRequest, BlendEvalResult } from '../src/engine/io/types';

/**
 * Pont vers un Blender installé sur la machine (processus principal uniquement).
 *
 * Le lecteur .blend natif (src/engine/io/blend) ne sait pas reconstruire certains objets :
 * courbes, textes, métaballes, nœuds de géométrie, modificateurs non pris en charge… Quand un
 * Blender est disponible, on lui fait ouvrir le fichier en arrière-plan et on récupère :
 *  - le maillage FINAL de ces objets (repère local, modificateurs appliqués, instances réalisées) ;
 *  - la couleur moyenne de la texture qui pilote la couleur de base des matériaux demandés ;
 *  - ou, en dernier recours, toute la scène convertie en glTF binaire (.glb).
 *
 * Sécurité : un .blend peut embarquer des scripts Python. Blender est toujours lancé avec
 * `--disable-autoexec` (aucun script du fichier n'est exécuté) et `--factory-startup` (ni
 * préférences ni extensions de l'utilisateur), sans shell, arguments passés en tableau. Le
 * fichier n'est JAMAIS enregistré : tout ce que font les scripts reste en mémoire dans Blender,
 * et les fichiers de travail vivent dans un dossier temporaire supprimé à la fin.
 *
 * Limites connues :
 *  - l'évaluation se fait avec les réglages « vue 3D » des modificateurs (niveaux de subdivision
 *    de la vue, modificateurs masqués dans la vue ignorés), à l'image courante du fichier ;
 *  - les instances (nœuds de géométrie, particules en objets/collections, instances sur sommets
 *    ou faces, instances de collection) sont réalisées dans le maillage de l'objet qui les
 *    génère, dans la limite de `MAX_INSTANCE_VERTS` sommets par évaluation ; au-delà elles sont
 *    comptées dans `notes`. Seul le graphe de la scène active fournit des instances ;
 *  - les cheveux (particules « chemin »), volumes et nuages de points n'ont pas de maillage ;
 *  - par octets (fichier sans chemin connu), les textures et bibliothèques liées par chemin
 *    relatif ne sont pas retrouvées.
 */

export interface BlenderInstall {
  exe: string;
  /** Ex. « 5.1.0 ». */
  version: string;
}

/** Résultat d'évaluation, avec des remarques en français destinées au rapport d'import. */
export interface BlendEvalReport extends BlendEvalResult {
  notes?: string[];
}

/** Délai maximal d'une évaluation ou d'une conversion ; au-delà, Blender est tué. */
export const EVAL_TIMEOUT_MS = 180_000;
/** Budget de sommets pour les instances réalisées, toutes instances d'une évaluation confondues. */
export const MAX_INSTANCE_VERTS = 300_000;
const VERSION_TIMEOUT_MS = 20_000;
/** Plus ancienne version dont l'API Python (graphe de dépendances, `to_mesh`) convient aux scripts. */
const MIN_VERSION = [2, 93];
/** Une recherche infructueuse est retentée après ce délai (Blender installé entre-temps). */
const MISS_TTL_MS = 30_000;
/** Sorties de Blender conservées pour le diagnostic (fin du flux). */
const LOG_TAIL = 16_384;
/** Au-delà, le .glb ne traverserait pas l'IPC dans de bonnes conditions. */
const MAX_GLB_BYTES = 1024 * 1024 * 1024;

// ------------------------------------------------------------------ lancement d'un processus

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Processus Blender en cours et dossiers de travail : libérés par `shutdownBlenderBridge`. */
const children = new Set<ChildProcess>();
const workDirs = new Set<string>();

function run(exe: string, args: string[], timeoutMs: number, cwd?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(exe, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    children.add(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const tail = (acc: string, chunk: Buffer): string => {
      const next = acc + chunk.toString('utf8');
      return next.length > LOG_TAIL ? next.slice(next.length - LOG_TAIL) : next;
    };
    child.stdout?.on('data', (c: Buffer) => (stdout = tail(stdout, c)));
    child.stderr?.on('data', (c: Buffer) => (stderr = tail(stderr, c)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      children.delete(child);
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      children.delete(child);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/**
 * À appeler quand l'application quitte : tue les Blender encore en cours et supprime leurs
 * dossiers de travail (qui peuvent contenir une copie du .blend importé).
 */
export function shutdownBlenderBridge(): void {
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* déjà terminé */
    }
  }
  children.clear();
  for (const dir of workDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    } catch {
      /* dossier encore verrouillé par le processus mourant : laissé au nettoyage du système */
    }
  }
  workDirs.clear();
}

// ------------------------------------------------------------------ recherche de Blender

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    // Alias d'exécution du Microsoft Store : `stat` échoue sur ce point d'analyse, `lstat` non.
    try {
      fs.lstatSync(p);
      return /\\WindowsApps\\/i.test(p);
    } catch {
      return false;
    }
  }
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const parseVersion = (text: string): number[] => (text.match(/\d+/g) ?? []).map(Number);

/** Bibliothèques Steam déclarées dans `libraryfolders.vdf` (en plus du dossier Steam lui-même). */
function steamLibraries(steamRoot: string): string[] {
  const libs = [steamRoot];
  try {
    const vdf = fs.readFileSync(path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.push(m[1].replace(/\\\\/g, '\\'));
  } catch {
    /* pas de Steam à cet endroit */
  }
  return libs;
}

/** Exécutables candidats, du plus prioritaire au moins prioritaire (sans vérifier qu'ils existent). */
function candidates(): string[] {
  const env = process.env;
  const win = process.platform === 'win32';
  const exeName = win ? 'blender.exe' : 'blender';
  const out: string[] = [];
  const push = (p: string | undefined | null): void => {
    if (p && !out.some((q) => (win ? q.toLowerCase() === p.toLowerCase() : q === p))) out.push(p);
  };

  // 1. Choix explicite : chemin de l'exécutable, ou du dossier qui le contient.
  const forced = env.COFORGE_BLENDER?.trim().replace(/^"(.*)"$/, '$1');
  if (forced) {
    let dir = false;
    try {
      dir = fs.statSync(forced).isDirectory();
    } catch {
      /* chemin inexistant : écarté plus loin */
    }
    push(dir ? path.join(forced, exeName) : forced);
  }

  // 2. PATH.
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    const clean = dir.trim().replace(/^"(.*)"$/, '$1');
    if (clean) push(path.join(clean, exeName));
  }

  if (win) {
    const programDirs = [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']].filter((d): d is string => !!d);
    // 3. Installeur officiel : « Blender Foundation\Blender 5.1\blender.exe », la version la plus haute d'abord.
    const installs: { exe: string; version: number[] }[] = [];
    for (const pf of new Set(programDirs)) {
      const root = path.join(pf, 'Blender Foundation');
      for (const name of listDir(root)) {
        if (!/^blender/i.test(name)) continue;
        installs.push({ exe: path.join(root, name, exeName), version: parseVersion(name) });
      }
    }
    installs.sort((a, b) => compareVersions(b.version, a.version));
    for (const i of installs) push(i.exe);
    // 4. Steam (dossier par défaut et bibliothèques secondaires).
    for (const pf of new Set(programDirs)) {
      for (const lib of steamLibraries(path.join(pf, 'Steam'))) push(path.join(lib, 'steamapps', 'common', 'Blender', exeName));
    }
    // 5. Microsoft Store (alias d'exécution).
    if (env.LOCALAPPDATA) push(path.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', exeName));
  } else if (process.platform === 'darwin') {
    push('/Applications/Blender.app/Contents/MacOS/Blender');
    push(path.join(os.homedir(), 'Applications', 'Blender.app', 'Contents', 'MacOS', 'Blender'));
    push(path.join(os.homedir(), 'Library', 'Application Support', 'Steam', 'steamapps', 'common', 'Blender', 'Blender.app', 'Contents', 'MacOS', 'Blender'));
  } else {
    for (const p of ['/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender', '/opt/blender/blender']) push(p);
    push(path.join(os.homedir(), '.steam', 'steam', 'steamapps', 'common', 'Blender', 'blender'));
  }
  return out;
}

/** Version annoncée par `blender --version`, ou null si ce n'est pas un Blender utilisable. */
async function probe(exe: string): Promise<string | null> {
  try {
    const r = await run(exe, ['--version'], VERSION_TIMEOUT_MS);
    const m = /Blender\s+(\d+\.\d+(?:\.\d+)?)/.exec(r.stdout) ?? /Blender\s+(\d+\.\d+(?:\.\d+)?)/.exec(r.stderr);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function locate(): Promise<BlenderInstall | null> {
  for (const exe of candidates()) {
    if (!isFile(exe)) continue;
    const version = await probe(exe);
    if (version && compareVersions(parseVersion(version), MIN_VERSION) >= 0) return { exe, version };
  }
  return null;
}

let cache: { key: string; at: number; found: Promise<BlenderInstall | null>; missed: boolean } | null = null;

/**
 * Cherche un Blender utilisable : variable `COFORGE_BLENDER`, PATH, installeur officiel
 * (version la plus haute), Steam, Microsoft Store ; chemins usuels sous macOS et Linux.
 * Le résultat est mis en cache (une recherche infructueuse est retentée après 30 s).
 */
export function findBlender(): Promise<BlenderInstall | null> {
  const key = process.env.COFORGE_BLENDER ?? '';
  if (cache && cache.key === key && !(cache.missed && Date.now() - cache.at > MISS_TTL_MS)) return cache.found;
  const entry = { key, at: Date.now(), found: locate().catch(() => null), missed: false };
  cache = entry;
  void entry.found.then((found) => {
    entry.missed = found === null;
    entry.at = Date.now();
  });
  return entry.found;
}

// ------------------------------------------------------------------ scripts exécutés dans Blender

/**
 * Partie commune des scripts Python (API bpy, Blender 2.93 → 5.x) : sortie JSON et couleur
 * moyenne de la texture de couleur de base d'un matériau. Les textes sont écrits tels quels
 * sur le disque (`String.raw`) ; commentaires sans accents pour rester en ASCII.
 */
const PY_COMMON = String.raw`import json
import sys

import bpy


def script_args():
    return sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def blender_version():
    return ".".join(str(n) for n in bpy.app.version)


def write_json(path, payload):
    with open(path, "w", encoding="utf-8") as f:
        f.write(json.dumps(payload, separators=(",", ":"), allow_nan=False))


# ---------------------------------------------------------------- couleur moyenne des textures

def srgb_to_linear(c):
    c = min(1.0, max(0.0, c))
    if c <= 0.04045:
        return c / 12.92
    return ((c + 0.055) / 1.055) ** 2.4


def linear_to_srgb(c):
    c = min(1.0, max(0.0, c))
    if c <= 0.0031308:
        return c * 12.92
    return 1.055 * (c ** (1.0 / 2.4)) - 0.055


def to_hex(rgb):
    return "#" + "".join("%02x" % int(round(linear_to_srgb(c) * 255.0)) for c in rgb)


def stores_linear(img):
    # Tampons flottants : deja en lineaire. Tampons 8 bits : dans l'espace de l'image.
    if img.is_float:
        return True
    try:
        name = img.colorspace_settings.name.lower()
    except Exception:
        return False
    return "non-color" in name or name.startswith("linear") or name in ("raw", "data")


def reduced_pixels(img):
    # Pixels (a plat) d'une COPIE reduite de l'image : l'image du fichier n'est pas touchee.
    w, h = img.size[0], img.size[1]
    if w <= 0 or h <= 0:
        return None
    small = img.copy()
    try:
        tw, th = min(w, 32), min(h, 32)
        if tw != w or th != h:
            small.scale(tw, th)
        ch = small.channels
        count = small.size[0] * small.size[1] * ch
        if ch < 1 or count <= 0 or len(small.pixels) != count:
            return None
        px = [0.0] * count
        small.pixels.foreach_get(px)
        return px, ch
    finally:
        bpy.data.images.remove(small)


def sampled_pixels(img):
    # Repli sans copie : echantillonnage regulier des pixels d'origine (lecture seule).
    import numpy
    w, h = img.size[0], img.size[1]
    ch = img.channels
    count = w * h * ch
    if w <= 0 or h <= 0 or ch < 1 or len(img.pixels) != count:
        return None
    buf = numpy.empty(count, dtype=numpy.float32)
    img.pixels.foreach_get(buf)
    rows = buf.reshape(-1, ch)
    step = max(1, (w * h) // 4096)
    return [float(v) for v in rows[::step].reshape(-1)], ch


def image_linear_average(img, cache):
    # Moyenne (r, v, b) en lineaire, ponderee par l'alpha ; None si l'image est introuvable.
    key = img.as_pointer()
    if key in cache:
        return cache[key]
    cache[key] = None
    data = None
    for reader in (reduced_pixels, sampled_pixels):
        try:
            data = reader(img)
        except Exception:
            data = None
        if data is not None:
            break
    if data is None:
        return None
    px, ch = data
    linear = stores_linear(img)
    acc = [0.0, 0.0, 0.0]
    weighted = [0.0, 0.0, 0.0]
    total = 0.0
    n = 0
    for i in range(0, len(px) - ch + 1, ch):
        if ch >= 3:
            rgb = (px[i], px[i + 1], px[i + 2])
        else:
            rgb = (px[i], px[i], px[i])
        if not all(v == v and abs(v) != float("inf") for v in rgb):
            continue
        if linear:
            rgb = tuple(max(0.0, v) for v in rgb)
        else:
            rgb = tuple(srgb_to_linear(v) for v in rgb)
        a = px[i + 3] if ch == 4 else 1.0
        a = min(1.0, max(0.0, a)) if a == a else 0.0
        for k in range(3):
            acc[k] += rgb[k]
            weighted[k] += rgb[k] * a
        total += a
        n += 1
    if n == 0:
        return None
    if total > 1e-6:
        result = tuple(v / total for v in weighted)
    else:
        result = tuple(v / n for v in acc)
    cache[key] = result
    return result


def group_output_socket(tree, outer_socket):
    for node in tree.nodes:
        if node.type == "GROUP_OUTPUT" and getattr(node, "is_active_output", True):
            for s in node.inputs:
                if s.identifier == outer_socket.identifier:
                    return s
    return None


def upstream_image(socket, seen, depth):
    # Remonte les liens depuis une entree jusqu'au premier noeud Image Texture garni.
    if socket is None or depth > 32:
        return None
    for link in socket.links:
        if getattr(link, "is_muted", False):
            continue
        node = link.from_node
        key = node.as_pointer()
        if key in seen:
            continue
        seen.add(key)
        if getattr(node, "mute", False) and node.type != "REROUTE":
            continue
        if node.type == "TEX_IMAGE":
            if node.image is not None:
                return node.image
            continue
        if node.type == "GROUP" and node.node_tree is not None:
            found = upstream_image(group_output_socket(node.node_tree, link.from_socket), seen, depth + 1)
            if found is not None:
                return found
        # Melange, teinte, courbes, renvoi... : entrees de couleur d'abord, jamais les coordonnees.
        inputs = [s for s in node.inputs if s.is_linked and s.type != "VECTOR"]
        inputs.sort(key=lambda s: 0 if s.type == "RGBA" else 1)
        for s in inputs:
            found = upstream_image(s, seen, depth + 1)
            if found is not None:
                return found
    return None


def base_color_socket(tree):
    # Entree de couleur de base du shader relie a la sortie du materiau (Principled d'abord).
    out = None
    for target in ("ALL", "EEVEE", "CYCLES"):
        try:
            out = tree.get_output_node(target)
        except Exception:
            out = None
        if out is not None:
            break
    queue = []
    if out is not None and out.inputs.get("Surface") is not None:
        queue = [l.from_node for l in out.inputs["Surface"].links]
    seen = set()
    fallback = None
    while queue:
        node = queue.pop(0)
        key = node.as_pointer()
        if key in seen:
            continue
        seen.add(key)
        if node.type == "BSDF_PRINCIPLED":
            return node.inputs.get("Base Color")
        if node.type == "GROUP" and node.node_tree is not None:
            for inner in node.node_tree.nodes:
                if inner.type == "BSDF_PRINCIPLED":
                    return inner.inputs.get("Base Color")
        if fallback is None:
            s = node.inputs.get("Base Color")
            if s is None:
                s = node.inputs.get("Color")
            if s is not None and s.type == "RGBA":
                fallback = s
        for s in node.inputs:
            if s.type == "SHADER":
                queue.extend(l.from_node for l in s.links)
    if fallback is not None:
        return fallback
    for node in tree.nodes:
        if node.type == "BSDF_PRINCIPLED":
            return node.inputs.get("Base Color")
    return None


def base_color_source(mat):
    # (entree de couleur de base, image qui l'alimente) ou None.
    tree = mat.node_tree if getattr(mat, "use_nodes", True) else None
    if tree is None:
        return None
    socket = base_color_socket(tree)
    if socket is None or not socket.is_linked:
        return None
    img = upstream_image(socket, set(), 0)
    if img is None:
        return None
    return socket, img
`;

/**
 * Évaluation. Arguments après « -- » : requête JSON `{ objects, materials, maxInstanceVerts }`,
 * puis fichier de sortie JSON `{ blenderVersion, meshes, materialColors, instances, skippedInstances }`.
 */
export const BLENDER_EVAL_SCRIPT =
  String.raw`# CoForge : maillages finaux et couleurs moyennes de textures d'un .blend (lecture seule).
` +
  PY_COMMON +
  String.raw`

# ---------------------------------------------------------------- maillages finaux

def slot_names(ob, me):
    names = [slot.material.name if slot.material else None for slot in ob.material_slots]
    if not names:
        names = [m.name if m else None for m in me.materials]
    return names


def mesh_geometry(ob, me):
    nv = len(me.vertices)
    npoly = len(me.polygons)
    nloop = len(me.loops)
    if nv == 0 or npoly == 0 or nloop == 0:
        return None
    co = [0.0] * (nv * 3)
    me.vertices.foreach_get("co", co)
    loops = [0] * nloop
    me.loops.foreach_get("vertex_index", loops)
    starts = [0] * npoly
    me.polygons.foreach_get("loop_start", starts)
    totals = [0] * npoly
    me.polygons.foreach_get("loop_total", totals)
    slots = [0] * npoly
    me.polygons.foreach_get("material_index", slots)
    try:
        flags = [False] * npoly
        me.polygons.foreach_get("use_smooth", flags)
        smooth = any(flags)
    except Exception:
        smooth = any(p.use_smooth for p in me.polygons)
    return {
        "co": co,
        "polygons": [loops[s:s + t] for s, t in zip(starts, totals)],
        "slots": slots,
        "materials": slot_names(ob, me),
        "smooth": bool(smooth),
    }


def local_geometry(ob):
    # ob : objet evalue (ou d'origine en dernier recours). None si le type n'a pas de maillage.
    try:
        me = ob.to_mesh()
    except Exception:
        return None
    if me is None:
        return None
    try:
        return mesh_geometry(ob, me)
    except Exception:
        return None
    finally:
        try:
            ob.to_mesh_clear()
        except Exception:
            pass


class Builder:
    # Maillage final d'un objet : sa geometrie propre puis ses instances realisees.
    def __init__(self):
        self.base = None
        self.positions = []
        self.polygons = []
        self.slots = []
        self.materials = []
        self.smooth = False
        self.instances = 0

    def slot(self, name):
        try:
            return self.materials.index(name)
        except ValueError:
            self.materials.append(name)
            return len(self.materials) - 1

    def add(self, geo, matrix):
        first = len(self.positions) // 3
        co = geo["co"]
        flip = False
        if matrix is None:
            self.positions.extend(co)
        else:
            flip = matrix.determinant() < 0.0
            a, b, c, d = matrix[0]
            e, f, g, h = matrix[1]
            i, j, k, l = matrix[2]
            out = self.positions
            for n in range(0, len(co), 3):
                x = co[n]
                y = co[n + 1]
                z = co[n + 2]
                out.append(a * x + b * y + c * z + d)
                out.append(e * x + f * y + g * z + h)
                out.append(i * x + j * y + k * z + l)
        if first == 0 and not flip:
            self.polygons.extend(geo["polygons"])
        elif flip:
            self.polygons.extend([v + first for v in reversed(p)] for p in geo["polygons"])
        else:
            self.polygons.extend([v + first for v in p] for p in geo["polygons"])
        names = geo["materials"]
        slots = geo["slots"]
        if matrix is None and not self.materials and first == 0:
            # Geometrie propre de l'objet : ses emplacements de materiaux sont repris tels quels
            # (completes par des emplacements vides si des faces pointent au-dela).
            self.materials = list(names)
            need = (max(slots) + 1) if slots else 0
            while len(self.materials) < need:
                self.materials.append(None)
            self.slots.extend(slots)
        else:
            remap = [self.slot(name) for name in names]
            empty = None
            for s in slots:
                if 0 <= s < len(remap):
                    self.slots.append(remap[s])
                else:
                    if empty is None:
                        empty = self.slot(None)
                    self.slots.append(empty)
        self.smooth = self.smooth or geo["smooth"]

    def payload(self):
        if not self.polygons:
            return None
        return {
            "positions": [round(v, 6) for v in self.positions],
            "polygons": self.polygons,
            "slots": self.slots,
            "materials": self.materials,
            "smooth": bool(self.smooth),
        }


def evaluated_in(ob, dg):
    try:
        ob_eval = ob.evaluated_get(dg)
    except Exception:
        return None
    return ob_eval if getattr(ob_eval, "is_evaluated", False) else None


def other_depsgraphs(ob, active):
    # Graphes des autres scenes / calques de vue qui contiennent l'objet.
    for scene in bpy.data.scenes:
        if scene.objects.get(ob.name) is None:
            continue
        for layer in scene.view_layers:
            try:
                if layer.objects.get(ob.name) is None:
                    continue
                layer.update()
                dg = layer.depsgraph
            except Exception:
                continue
            if dg is not None and dg != active:
                yield dg


def can_instance(ob):
    try:
        if ob.instance_type != "NONE":
            return True
        if len(ob.particle_systems) > 0:
            return True
        return any(m.type == "NODES" for m in ob.modifiers)
    except Exception:
        return False


def add_instance(inst, instancers, builders, budget, skipped, cache):
    if not inst.is_instance:
        return
    parent = inst.parent
    if parent is None:
        return
    root = parent.original if parent.original is not None else parent
    name = root.name
    if name not in instancers:
        return
    ob = inst.object
    if ob is None:
        return
    key = (ob.original.as_pointer() if ob.original is not None else 0, ob.data.as_pointer() if ob.data is not None else 0)
    if key in cache:
        geo = cache[key]
    else:
        geo = local_geometry(ob)
        cache[key] = geo
    if geo is None:
        return
    nv = len(geo["co"]) // 3
    if nv > budget[0]:
        skipped[name] = skipped.get(name, 0) + 1
        return
    # Repere local de l'objet qui genere l'instance (matrice singuliere : instance ignoree).
    matrix = parent.matrix_world.inverted() @ inst.matrix_world
    budget[0] -= nv
    builder = builders[name]
    builder.add(geo, matrix)
    builder.instances += 1


def gather_instances(dg, instancers, builders, budget, skipped):
    # Instances generees par les objets demandes (noeuds de geometrie, particules, instances
    # sur sommets / faces, instances de collection), ramenees dans le repere local de l'objet.
    cache = {}
    for inst in dg.object_instances:
        try:
            add_instance(inst, instancers, builders, budget, skipped, cache)
        except Exception:
            continue


def main():
    argv = script_args()
    if len(argv) < 2:
        raise SystemExit("arguments manquants")
    request_path, out_path = argv[0], argv[1]
    version = blender_version()
    if not bpy.data.filepath:
        # Le .blend n'a pas ete charge (version trop recente, fichier illisible) : la scene
        # courante est celle d'usine, il ne faut surtout pas l'evaluer a sa place.
        write_json(out_path, {"blenderVersion": version, "error": "load"})
        return
    with open(request_path, "r", encoding="utf-8") as f:
        request = json.load(f)
    names = request.get("objects", [])
    budget = [int(request.get("maxInstanceVerts", 0))]

    active = bpy.context.evaluated_depsgraph_get()
    builders = {}
    instancers = {}
    for name in names:
        if name in builders:
            continue
        ob = bpy.data.objects.get(name)
        if ob is None:
            continue
        builder = Builder()
        builders[name] = builder
        ob_eval = evaluated_in(ob, active)
        if ob_eval is not None and can_instance(ob):
            instancers[name] = ob
        if ob.type == "EMPTY":
            # Un vide n'a pas de geometrie propre ; il peut porter des instances de collection.
            continue
        if ob_eval is None:
            for dg in other_depsgraphs(ob, active):
                ob_eval = evaluated_in(ob, dg)
                if ob_eval is not None:
                    break
        if ob_eval is None:
            # Objet hors de tout calque de vue (collection exclue, objet desactive) : pas de
            # modificateurs evalues. Un maillage est mieux repris par le lecteur natif ; pour
            # une courbe, un texte ou une metaballe, la forme de base vaut mieux que rien.
            if ob.type == "MESH":
                continue
            ob_eval = ob
        base = local_geometry(ob_eval)
        if base is None:
            continue
        # Un instancier dont " Afficher l'instancier " est decoche ne montre que ses instances :
        # sa geometrie propre n'est gardee que s'il n'en produit finalement aucune.
        if name in instancers and not getattr(ob, "show_instancer_for_viewport", True):
            builder.base = base
        else:
            builder.add(base, None)

    skipped = {}
    if instancers and budget[0] > 0:
        gather_instances(active, instancers, builders, budget, skipped)

    meshes = {}
    instances = {}
    for name, builder in builders.items():
        if builder.instances > 0:
            instances[name] = builder.instances
        elif builder.base is not None:
            builder.add(builder.base, None)
        data = builder.payload()
        if data is not None:
            meshes[name] = data

    colors = {}
    cache = {}
    for name in request.get("materials", []):
        if name in colors:
            continue
        mat = bpy.data.materials.get(name)
        if mat is None:
            continue
        try:
            source = base_color_source(mat)
            rgb = image_linear_average(source[1], cache) if source is not None else None
        except Exception:
            rgb = None
        if rgb is not None:
            colors[name] = to_hex(rgb)

    payload = {"blenderVersion": version, "meshes": meshes, "materialColors": colors,
               "instances": instances, "skippedInstances": skipped,
               "empty": [n for n in builders if n not in meshes]}
    try:
        write_json(out_path, payload)
    except ValueError:
        # Coordonnees non finies (NaN, infini) : remplacees par 0, le JSON strict les refuse.
        for mesh in meshes.values():
            mesh["positions"] = [v if v == v and abs(v) != float("inf") else 0.0 for v in mesh["positions"]]
        write_json(out_path, payload)


main()
`;

/**
 * Conversion complète en .glb. Arguments après « -- » : fichier .glb à écrire, puis fichier
 * d'état JSON `{ blenderVersion, ok, attempt, baked, errors }`.
 *
 * L'exporteur glTF change de paramètres d'une version de Blender à l'autre : seuls ceux que la
 * version connaît sont passés, puis des jeux d'arguments de plus en plus sobres sont essayés.
 * CoForge n'a pas de textures : la couleur moyenne de la texture de couleur de base est
 * inscrite dans le matériau (en mémoire seulement) avant l'export, et les images ne sont pas
 * embarquées quand l'exporteur le permet.
 */
export const BLENDER_CONVERT_SCRIPT =
  String.raw`# CoForge : conversion d'un .blend en glTF binaire (lecture seule, rien n'est enregistre).
` +
  PY_COMMON +
  String.raw`

# ---------------------------------------------------------------- conversion glTF

import os


def bake_texture_colors():
    # En memoire uniquement : la couleur moyenne remplace le lien vers la texture.
    baked = 0
    cache = {}
    for mat in bpy.data.materials:
        try:
            source = base_color_source(mat)
            if source is None:
                continue
            socket, img = source
            rgb = image_linear_average(img, cache)
            if rgb is None:
                continue
            tree = socket.id_data
            for link in list(socket.links):
                tree.links.remove(link)
            socket.default_value = (rgb[0], rgb[1], rgb[2], 1.0)
            baked += 1
        except Exception:
            continue
    return baked


FULL = {
    "export_format": "GLB",
    "export_apply": True,
    "export_yup": True,
    "export_cameras": True,
    "export_lights": True,
    "export_animations": False,
    "export_skins": False,
    "export_morph": False,
    "export_extras": False,
    "export_materials": "EXPORT",
    "export_image_format": "NONE",
    "export_texcoords": False,
    "export_colors": False,
    "export_draco_mesh_compression_enable": False,
    "export_gn_mesh": True,
    "use_selection": False,
    "use_visible": False,
    "use_renderable": False,
    "use_active_collection": False,
    "use_active_scene": True,
    "will_save_settings": False,
    "check_existing": False,
}
BASIC = ("export_format", "export_apply", "export_yup", "export_cameras", "export_lights", "export_animations")


def known_properties():
    try:
        return set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
    except Exception:
        return None


def attempts():
    known = known_properties()

    def keep(args):
        return {k: v for k, v in args.items() if known is None or k in known}

    without_new = {k: v for k, v in FULL.items() if k not in ("export_image_format", "export_gn_mesh", "export_texcoords", "export_colors")}
    return [
        keep(FULL),
        keep(without_new),
        keep({k: FULL[k] for k in BASIC}),
        {"export_format": "GLB"},
    ]


def ensure_exporter():
    # L'exporteur glTF est actif d'usine ; a defaut, on tente d'activer le module livre avec Blender.
    if known_properties() is not None:
        return
    try:
        import addon_utils
        addon_utils.enable("io_scene_gltf2", default_set=False)
    except Exception:
        pass


def main():
    argv = script_args()
    if len(argv) < 2:
        raise SystemExit("arguments manquants")
    glb_path, status_path = argv[0], argv[1]
    status = {"blenderVersion": blender_version(), "ok": False, "attempt": 0, "baked": 0, "errors": []}
    if not bpy.data.filepath:
        status["error"] = "load"
        write_json(status_path, status)
        return
    try:
        status["baked"] = bake_texture_colors()
    except Exception as err:
        status["errors"].append(str(err)[:300])
    ensure_exporter()
    for index, args in enumerate(attempts()):
        try:
            if os.path.exists(glb_path):
                os.remove(glb_path)
            result = bpy.ops.export_scene.gltf(filepath=glb_path, **args)
        except Exception as err:
            status["errors"].append(str(err)[:300])
            continue
        if "FINISHED" in result and os.path.isfile(glb_path) and os.path.getsize(glb_path) > 0:
            status["ok"] = True
            status["attempt"] = index + 1
            break
        status["errors"].append("resultat " + str(result))
    write_json(status_path, status)


main()
`;

// ------------------------------------------------------------------ exécution d'un script

/** Arguments de la ligne de commande (sans l'exécutable) : fichier ouvert en lecture, puis script. */
export function blenderArgs(blendPath: string, scriptPath: string, scriptArgs: string[]): string[] {
  return [
    '--background',
    '--factory-startup',
    '--disable-autoexec',
    '-noaudio',
    blendPath,
    '--python-exit-code',
    '1',
    '--python',
    scriptPath,
    '--',
    ...scriptArgs,
  ];
}

/** Dernières lignes utiles de la sortie de Blender, pour un message d'erreur. */
function lastLines(r: RunResult): string {
  const lines = `${r.stdout}\n${r.stderr}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !/^Blender \d|^Blender quit|^Read blend:/.test(l));
  return lines.slice(-3).join(' | ').slice(0, 400);
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coforge-blender-'));
  workDirs.add(dir);
  try {
    return await fn(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }).catch(() => {});
    workDirs.delete(dir);
  }
}

async function requireBlender(): Promise<BlenderInstall> {
  const blender = await findBlender();
  if (!blender) throw new Error('Aucun Blender (2.93 ou plus récent) trouvé sur cette machine.');
  return blender;
}

function requireFile(filePath: string): string {
  const full = path.resolve(filePath);
  if (!isFile(full)) throw new Error(`Fichier introuvable : ${filePath}`);
  return full;
}

/** Messages de Blender quand il refuse le fichier (format inconnu, version plus récente, lecture impossible). */
const LOAD_FAILURE = /File format is not supported|Failed to read blend file|not a blend file|newer Blender|Unable to open|Cannot read file/i;

function loadFailure(blender: BlenderInstall): string {
  return `Blender ${blender.version} n'a pas pu ouvrir ce fichier (il a peut-être été enregistré avec une version plus récente).`;
}

/** Lance un script sur un .blend et renvoie le JSON qu'il a écrit dans `outputPath`. */
async function runScript(
  blender: BlenderInstall,
  dir: string,
  blendPath: string,
  script: string,
  scriptArgs: string[],
  outputPath: string,
  what: string,
): Promise<Record<string, unknown>> {
  const scriptPath = path.join(dir, 'coforge_script.py');
  await fs.promises.writeFile(scriptPath, script, 'utf8');
  let r: RunResult;
  try {
    // Dossier courant = dossier temporaire : rien n'est chargé depuis le dossier du .blend.
    r = await run(blender.exe, blenderArgs(blendPath, scriptPath, scriptArgs), EVAL_TIMEOUT_MS, dir);
  } catch (err) {
    throw new Error(`Impossible de lancer Blender (${blender.exe}) : ${err instanceof Error ? err.message : String(err)}`);
  }
  if (r.timedOut) throw new Error(`Blender n'a pas répondu en ${Math.round(EVAL_TIMEOUT_MS / 1000)} s : ${what} abandonnée.`);

  let text: string;
  try {
    text = await fs.promises.readFile(outputPath, 'utf8');
  } catch {
    // Fichier illisible : Blender quitte avant même de lancer le script.
    if (LOAD_FAILURE.test(`${r.stdout}
${r.stderr}`)) throw new Error(loadFailure(blender));
    const detail = lastLines(r);
    throw new Error(`Blender ${blender.version} n'a rien renvoyé (code ${r.code ?? 'inconnu'})${detail ? ` : ${detail}` : '.'}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`Réponse de Blender ${blender.version} illisible.`);
  }
  if (!raw || typeof raw !== 'object') throw new Error(`Réponse de Blender ${blender.version} illisible.`);
  if ((raw as { error?: unknown }).error === 'load') throw new Error(loadFailure(blender));
  return raw as Record<string, unknown>;
}

// ------------------------------------------------------------------ évaluation

function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && (v.length === 0 || typeof v[0] === 'number');
}

function cleanNames(names: unknown): string[] {
  if (!Array.isArray(names)) return [];
  return [...new Set(names.filter((n): n is string => typeof n === 'string' && n !== ''))];
}

function countMap(raw: unknown): [string, number][] {
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw as Record<string, unknown>).filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] > 0);
}

/** Remarques en français sur les instances réalisées ou laissées de côté. */
function instanceNotes(raw: Record<string, unknown>): string[] {
  const notes: string[] = [];
  const done = countMap(raw.instances);
  if (done.length > 0) {
    const total = done.reduce((s, [, n]) => s + n, 0);
    notes.push(
      `${total} instance(s) générée(s) par ${done.length} objet(s) (nœuds de géométrie, particules, instances de collection) réalisée(s) dans leur maillage final.`,
    );
  }
  const skipped = countMap(raw.skippedInstances);
  if (skipped.length > 0) {
    const total = skipped.reduce((s, [, n]) => s + n, 0);
    const names = skipped
      .slice(0, 4)
      .map(([name]) => `« ${name} »`)
      .join(', ');
    notes.push(
      `${total} instance(s) non reprise(s) (${names}${skipped.length > 4 ? '…' : ''}) : limite de ${MAX_INSTANCE_VERTS.toLocaleString('fr-FR')} sommets d'instances atteinte.`,
    );
  }
  return notes;
}

/** Ne garde que les maillages et couleurs bien formés (le détail des indices est revérifié à l'import). */
function cleanResult(raw: Record<string, unknown>, version: string): BlendEvalReport {
  const meshes: Record<string, BlendEvalMesh> = {};
  if (raw.meshes && typeof raw.meshes === 'object') {
    for (const [name, value] of Object.entries(raw.meshes as Record<string, unknown>)) {
      const m = value as Partial<BlendEvalMesh> | null;
      if (!m || !isNumberArray(m.positions) || m.positions.length % 3 !== 0) continue;
      if (!Array.isArray(m.polygons) || m.polygons.length === 0 || !m.polygons.every((p) => isNumberArray(p))) continue;
      const mesh: BlendEvalMesh = { positions: m.positions, polygons: m.polygons };
      if (isNumberArray(m.slots) && m.slots.length === m.polygons.length) mesh.slots = m.slots;
      if (Array.isArray(m.materials)) mesh.materials = m.materials.map((n) => (typeof n === 'string' ? n : null));
      mesh.smooth = m.smooth === true;
      meshes[name] = mesh;
    }
  }
  const materialColors: Record<string, string> = {};
  if (raw.materialColors && typeof raw.materialColors === 'object') {
    for (const [name, color] of Object.entries(raw.materialColors as Record<string, unknown>)) {
      if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) materialColors[name] = color.toLowerCase();
    }
  }
  const result: BlendEvalReport = {
    meshes,
    materialColors,
    blenderVersion: typeof raw.blenderVersion === 'string' ? raw.blenderVersion : version,
  };
  if (Array.isArray(raw.empty)) {
    const empty = raw.empty.filter((n): n is string => typeof n === 'string' && !(n in meshes)).slice(0, 10000);
    if (empty.length > 0) result.empty = empty;
  }
  const notes = instanceNotes(raw);
  if (notes.length > 0) result.notes = notes;
  return result;
}

async function evaluateIn(dir: string, blendPath: string, request: BlendEvalRequest, blender: BlenderInstall): Promise<BlendEvalReport> {
  const requestPath = path.join(dir, 'requete.json');
  const outputPath = path.join(dir, 'sortie.json');
  await fs.promises.writeFile(requestPath, JSON.stringify({ ...request, maxInstanceVerts: MAX_INSTANCE_VERTS }), 'utf8');
  const raw = await runScript(blender, dir, blendPath, BLENDER_EVAL_SCRIPT, [requestPath, outputPath], outputPath, 'évaluation');
  return cleanResult(raw, blender.version);
}

function cleanRequest(request: BlendEvalRequest): BlendEvalRequest {
  return { objects: cleanNames(request?.objects), materials: cleanNames(request?.materials) };
}

const isEmptyRequest = (r: BlendEvalRequest): boolean => r.objects.length === 0 && (r.materials?.length ?? 0) === 0;

/**
 * Fait évaluer par Blender un fichier .blend : maillage final des objets nommés (modificateurs
 * appliqués, instances réalisées) et couleur moyenne '#rrggbb' de la texture de couleur de base
 * des matériaux nommés. Les objets absents, vides ou sans géométrie et les matériaux sans
 * texture lisible ne figurent pas dans le résultat. Rejette (message en français) si le
 * fichier ou Blender est introuvable, si Blender échoue ou dépasse 180 s.
 */
export async function evaluateBlend(filePath: string, request: BlendEvalRequest): Promise<BlendEvalReport> {
  const full = requireFile(filePath);
  const blender = await requireBlender();
  const req = cleanRequest(request);
  if (isEmptyRequest(req)) return { meshes: {}, materialColors: {}, blenderVersion: blender.version };
  return withTempDir((dir) => evaluateIn(dir, full, req, blender));
}

/**
 * Variante pour un .blend dont on n'a que les octets : il est écrit dans le dossier
 * temporaire le temps de l'évaluation. Les bibliothèques et textures liées par chemin relatif
 * ne sont alors pas retrouvées par Blender (les textures empaquetées le sont).
 */
export async function evaluateBlendBytes(data: Uint8Array, request: BlendEvalRequest): Promise<BlendEvalReport> {
  const blender = await requireBlender();
  const req = cleanRequest(request);
  if (isEmptyRequest(req)) return { meshes: {}, materialColors: {}, blenderVersion: blender.version };
  return withTempDir(async (dir) => {
    const blendPath = path.join(dir, 'scene.blend');
    await fs.promises.writeFile(blendPath, data);
    return evaluateIn(dir, blendPath, req, blender);
  });
}

// ------------------------------------------------------------------ conversion en .glb

async function convertIn(dir: string, blendPath: string, blender: BlenderInstall): Promise<Uint8Array> {
  const glbPath = path.join(dir, 'scene.glb');
  const statusPath = path.join(dir, 'etat.json');
  const status = await runScript(blender, dir, blendPath, BLENDER_CONVERT_SCRIPT, [glbPath, statusPath], statusPath, 'conversion');
  if (status.ok !== true) {
    const errors = Array.isArray(status.errors) ? status.errors.filter((e): e is string => typeof e === 'string') : [];
    const detail = errors.length > 0 ? ` : ${errors[errors.length - 1].replace(/\s+/g, ' ').slice(0, 300)}` : '.';
    throw new Error(`L'export glTF de Blender ${blender.version} a échoué${detail}`);
  }
  const stat = await fs.promises.stat(glbPath).catch(() => null);
  if (!stat || stat.size < 12) throw new Error(`Blender ${blender.version} n'a pas produit de fichier .glb.`);
  if (stat.size > MAX_GLB_BYTES) throw new Error('La scène convertie par Blender est trop volumineuse (plus de 1 Go).');
  const buffer = await fs.promises.readFile(glbPath);
  if (buffer.toString('latin1', 0, 4) !== 'glTF') throw new Error(`Le fichier produit par Blender ${blender.version} n'est pas un glTF binaire.`);
  // Copie « nue » : pas de Buffer adossé au pool de Node.
  return new Uint8Array(buffer);
}

/**
 * Fait convertir un .blend entier en glTF binaire par Blender (repli quand le lecteur natif
 * échoue) : scène active, modificateurs appliqués, lumières (KHR_lights_punctual), caméras,
 * +Y vers le haut, sans animation. Renvoie les octets du .glb ; rejette avec un message en
 * français si le fichier ou Blender est introuvable, si l'export échoue ou dépasse 180 s.
 */
export async function convertBlendToGLB(filePath: string): Promise<Uint8Array> {
  const full = requireFile(filePath);
  const blender = await requireBlender();
  return withTempDir((dir) => convertIn(dir, full, blender));
}

/** Variante pour un .blend dont on n'a que les octets (mêmes réserves que `evaluateBlendBytes`). */
export async function convertBlendBytesToGLB(data: Uint8Array): Promise<Uint8Array> {
  const blender = await requireBlender();
  return withTempDir(async (dir) => {
    const blendPath = path.join(dir, 'scene.blend');
    await fs.promises.writeFile(blendPath, data);
    return convertIn(dir, blendPath, blender);
  });
}
