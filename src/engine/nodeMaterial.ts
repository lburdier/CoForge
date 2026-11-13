import { Box3, Matrix4, Vector2, Vector3, Vector4, type BufferGeometry, type Camera, type Material, type MeshPhysicalMaterial, type Object3D, type Scene, type Texture, type WebGLRenderer } from 'three';
import type { CompiledShader, ShaderParams } from '../core/nodes/shaderCompile';

/**
 * Applique un arbre de nœuds compilé (src/core/nodes/shaderCompile.ts) à un MeshPhysicalMaterial :
 *  - les paramètres constants (ou moyens) vont dans les propriétés du matériau : le path tracer,
 *    qui lit ces propriétés, voit donc toujours un équivalent raisonnable ;
 *  - les canaux qui varient par pixel (couleur, alpha, métal, rugosité, émission, normale) sont
 *    calculés par du GLSL injecté dans le shader physique de three (onBeforeCompile).
 *
 * Coordonnées « Generated » : position dans la boîte englobante de l'objet (0..1), comme Blender.
 * La boîte change d'un objet à l'autre alors que le matériau est partagé : elle est transmise au
 * programme GPU juste avant chaque objet (`nodeSurfaceBeforeRender`), avec la matrice monde.
 *
 * Valeurs des nœuds : uniformes `cf_u` (vec4 empaquetés) ; changer une valeur ne recompile pas le
 * programme (la clé `compiled.key` ne change pas), seules les valeurs des uniformes sont copiées.
 * Images : samplers `cf_img0…` (textures fournies par `images`, voir nodeImages.ts).
 */

interface CfUniforms {
  cfBBoxMin: { value: Vector3 };
  cfBBoxSize: { value: Vector3 };
  cfViewport: { value: Vector2 };
  cfModel: { value: Matrix4 };
  cf_u: { value: Float32Array };
  [img: `cf_img${number}`]: { value: Texture | null };
}

interface NodeState {
  key: string;
  compiled: CompiledShader | null;
  uniforms: CfUniforms;
}

const STATE = Symbol('cfNodeState');

function stateOf(mat: MeshPhysicalMaterial): NodeState {
  const m = mat as unknown as { [STATE]?: NodeState };
  return (m[STATE] ??= {
    key: '',
    compiled: null,
    uniforms: {
      cfBBoxMin: { value: new Vector3() },
      cfBBoxSize: { value: new Vector3(1, 1, 1) },
      cfViewport: { value: new Vector2(1, 1) },
      cfModel: { value: new Matrix4() },
      cf_u: { value: new Float32Array(4) },
    },
  });
}

const clamp = (x: number, lo: number, hi: number) => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo);

/** Paramètres Principled → propriétés du MeshPhysicalMaterial. */
export function applyShaderParams(mat: MeshPhysicalMaterial, p: ShaderParams, xray: boolean, alphaVaries: boolean): void {
  mat.color.setRGB(p.baseColor[0], p.baseColor[1], p.baseColor[2]);
  mat.metalness = clamp(p.metallic, 0, 1);
  mat.roughness = clamp(p.roughness, 0, 1);
  mat.ior = clamp(p.ior, 1, 2.333);
  const emax = Math.max(p.emission[0], p.emission[1], p.emission[2]);
  if (emax > 0) {
    const s = Math.max(1, emax);
    mat.emissive.setRGB(p.emission[0] / s, p.emission[1] / s, p.emission[2] / s);
    mat.emissiveIntensity = s;
  } else {
    mat.emissive.setRGB(0, 0, 0);
    mat.emissiveIntensity = 0;
  }
  // Niveau IOR spéculaire de Blender : 0,5 = réflexion normale de l'IOR ; three : intensité 1.
  mat.specularIntensity = clamp(p.specularLevel * 2, 0, 2);
  mat.specularColor.setRGB(p.specularTint[0], p.specularTint[1], p.specularTint[2]);
  mat.clearcoat = clamp(p.coat, 0, 1);
  mat.clearcoatRoughness = clamp(p.coatRoughness, 0, 1);
  mat.sheen = clamp(p.sheen, 0, 1);
  mat.sheenRoughness = clamp(p.sheenRoughness, 0, 1);
  mat.sheenColor.setRGB(p.sheenTint[0], p.sheenTint[1], p.sheenTint[2]);
  const film = Math.max(0, p.thinFilmThickness);
  mat.iridescence = film > 0 ? 1 : 0;
  mat.iridescenceIOR = clamp(p.thinFilmIor, 1, 2.333);
  mat.iridescenceThicknessRange = [0, film];
  mat.diffuseRoughness = clamp(p.diffuseRoughness, 0, 1);

  const alpha = clamp(p.alpha, 0, 1);
  mat.opacity = alphaVaries ? (xray ? 0.35 : 1) : xray ? alpha * 0.35 : alpha;
  const transparent = alphaVaries || mat.opacity < 1;
  const transmission = xray ? 0 : clamp(p.transmission, 0, 1);
  const needsUpdate = mat.transparent !== transparent;
  mat.transparent = transparent;
  mat.depthWrite = !transparent;
  mat.transmission = transmission;
  mat.thickness = transmission > 0 ? 0.5 : 0;
  if (needsUpdate) mat.needsUpdate = true;
}

/** Remet un matériau dans l'état « sans nœuds » (aucune injection GLSL, extensions à zéro). */
export function clearNodeShader(mat: MeshPhysicalMaterial): void {
  const st = stateOf(mat);
  mat.specularIntensity = 1;
  mat.specularColor.setRGB(1, 1, 1);
  mat.clearcoat = 0;
  mat.sheen = 0;
  mat.iridescence = 0;
  mat.diffuseRoughness = 0;
  if (st.key === '') return;
  st.key = '';
  st.compiled = null;
  mat.onBeforeCompile = () => {};
  mat.customProgramCacheKey = () => '';
  mat.needsUpdate = true;
}

/**
 * Applique un arbre compilé ; recompile le shader seulement si le GLSL a changé. `images` fournit
 * la texture de chaque image du document utilisée par l'arbre.
 */
export function applyCompiledShader(mat: MeshPhysicalMaterial, compiled: CompiledShader, xray: boolean, images?: (id: string) => Texture): void {
  const glsl = Object.keys(compiled.varying).length > 0;
  // En rayons X, l'alpha par pixel n'a pas d'intérêt : on garde l'alpha moyen.
  applyShaderParams(mat, compiled.params, xray, glsl && !!compiled.varying.alpha && !xray);
  const st = stateOf(mat);
  const key = glsl ? `${compiled.key}|${xray ? 'x' : ''}` : '';
  st.compiled = glsl ? compiled : null;
  const uniforms = st.uniforms;
  if (glsl) {
    // Valeurs seules : copiées dans l'objet d'uniforme partagé avec le programme (pas de recompilation).
    uniforms.cf_u.value = compiled.uniforms.length ? compiled.uniforms : new Float32Array(4);
    compiled.images.forEach((id, i) => {
      const slot = (uniforms[`cf_img${i}`] ??= { value: null });
      slot.value = images ? images(id) : null;
    });
  }
  if (key === st.key) return;
  st.key = key;
  if (!glsl) {
    mat.onBeforeCompile = () => {};
    mat.customProgramCacheKey = () => '';
  } else {
    const c = compiled;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = injectVertex(shader.vertexShader);
      shader.fragmentShader = injectFragment(shader.fragmentShader, c, xray);
    };
    mat.customProgramCacheKey = () => `cfnodes:${hash(key)}`;
  }
  mat.needsUpdate = true;
}

// ------------------------------------------------------------------ injection GLSL

const VARYINGS = 'varying vec3 cf_vOPos;\nvarying vec3 cf_vONrm;\nvarying vec3 cf_vWPos;\nvarying vec3 cf_vWNrm;\nvarying vec3 cf_vOLoc;\n';

function replaceOnce(src: string, find: string, replacement: string): string {
  const i = src.indexOf(find);
  if (i < 0) throw new Error(`Point d'injection GLSL introuvable : ${find}`);
  return src.slice(0, i) + replacement + src.slice(i + find.length);
}

function injectVertex(src: string): string {
  src = replaceOnce(src, '#include <common>', `#include <common>\n${VARYINGS}`);
  return replaceOnce(
    src,
    '#include <worldpos_vertex>',
    `#include <worldpos_vertex>
cf_vOPos = transformed;
cf_vONrm = objectNormal;
cf_vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
cf_vWNrm = inverseTransformDirection(normalize(normalMatrix * objectNormal), viewMatrix);
cf_vOLoc = modelMatrix[3].xyz;`,
  );
}

const PRELUDE = `
vec3 cf_wpos = cf_vWPos;
float cf_back = gl_FrontFacing ? 0.0 : 1.0;
vec3 cf_N = normalize(cf_vWNrm) * (gl_FrontFacing ? 1.0 : -1.0);
vec3 cf_I = isOrthographic ? normalize(inverseTransformDirection(vec3(0.0, 0.0, 1.0), viewMatrix)) : normalize(cameraPosition - cf_wpos);
vec3 cf_gen = (cf_vOPos - cfBBoxMin) / max(cfBBoxSize, vec3(1e-6));
vec3 cf_opos = cf_vOPos;
vec3 cf_onrm = normalize(cf_vONrm);
vec3 cf_cam = -vViewPosition;
vec3 cf_win = vec3(gl_FragCoord.xy / max(cfViewport, vec2(1.0)), 0.0);
vec3 cf_refl = reflect(-cf_I, cf_N);
vec3 cf_trueN = normalize(cross(dFdx(cf_wpos), dFdy(cf_wpos)));
vec3 cf_oloc = cf_vOLoc;
float cf_orand = fract(sin(dot(cf_oloc, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
vec3 cf_tangent = cf_orthotangent(vec3(-(cf_gen.y - 0.5), cf_gen.x - 0.5, 0.0), cf_N);
`;

function injectFragment(src: string, c: CompiledShader, xray: boolean): string {
  const v = c.varying;
  // Déclarations attendues par la bibliothèque (shader/glsl.ts) : valeurs des nœuds, matrice monde, images.
  const decls =
    `uniform vec3 cfBBoxMin;\nuniform vec3 cfBBoxSize;\nuniform vec2 cfViewport;\nuniform mat4 cfModel;\n` +
    `uniform vec4 cf_u[${Math.max(1, c.uniformVec4)}];\n` +
    c.images.map((_, i) => `uniform sampler2D cf_img${i};\n`).join('');
  src = replaceOnce(src, '#include <clipping_planes_pars_fragment>', `#include <clipping_planes_pars_fragment>\n${VARYINGS}${decls}${c.library}`);
  src = replaceOnce(src, '#include <logdepthbuf_fragment>', `#include <logdepthbuf_fragment>\n${PRELUDE}\n${c.code}\n`);
  if (v.baseColor) src = replaceOnce(src, '#include <color_fragment>', `#include <color_fragment>\ndiffuseColor.rgb = max(${v.baseColor}, vec3(0.0));`);
  if (v.alpha && !xray) src = replaceOnce(src, '#include <alphamap_fragment>', `#include <alphamap_fragment>\ndiffuseColor.a = clamp(${v.alpha}, 0.0, 1.0);`);
  if (v.roughness) src = replaceOnce(src, '#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nroughnessFactor = clamp(${v.roughness}, 0.0, 1.0);`);
  if (v.metallic) src = replaceOnce(src, '#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\nmetalnessFactor = clamp(${v.metallic}, 0.0, 1.0);`);
  if (v.normal) src = replaceOnce(src, '#include <normal_fragment_maps>', `#include <normal_fragment_maps>\nnormal = normalize((viewMatrix * vec4(${v.normal}, 0.0)).xyz);`);
  if (v.emission) src = replaceOnce(src, '#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance = max(${v.emission}, vec3(0.0));`);
  return src;
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36) + s.length.toString(36);
}

// ------------------------------------------------------------------ uniformes par objet

const box = new Box3();
const size = new Vector3();
const viewport = new Vector4();

/**
 * À poser sur `onBeforeRender` des surfaces : transmet la boîte englobante de l'objet (coordonnées
 * « Generated ») et la taille de la vue au programme GPU du matériau à nœuds. Les matériaux
 * intégrés de three n'envoient leurs uniformes qu'au changement de matériau : pour deux objets
 * consécutifs du même matériau, on écrit donc directement dans le programme déjà lié.
 */
export function nodeSurfaceBeforeRender(
  this: Object3D,
  renderer: WebGLRenderer,
  _scene: Scene,
  _camera: Camera,
  geometry: BufferGeometry,
  material: Material,
): void {
  const st = (material as unknown as { [STATE]?: NodeState })[STATE];
  if (!st?.compiled) return;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  box.copy(geometry.boundingBox!);
  const u = st.uniforms;
  u.cfBBoxMin.value.copy(box.min);
  box.getSize(size);
  u.cfBBoxSize.value.copy(size);
  renderer.getCurrentViewport(viewport);
  u.cfViewport.value.set(viewport.z, viewport.w);
  u.cfModel.value.copy(this.matrixWorld);
  const props = renderer.properties.get(material) as { currentProgram?: { program: WebGLProgram; getUniforms(): { setValue(gl: WebGL2RenderingContext, name: string, v: unknown): void } } };
  const program = props.currentProgram;
  if (!program) return;
  const gl = renderer.getContext() as WebGL2RenderingContext;
  renderer.state.useProgram(program.program);
  const pu = program.getUniforms();
  pu.setValue(gl, 'cfBBoxMin', u.cfBBoxMin.value);
  pu.setValue(gl, 'cfBBoxSize', u.cfBBoxSize.value);
  pu.setValue(gl, 'cfViewport', u.cfViewport.value);
  pu.setValue(gl, 'cfModel', u.cfModel.value);
  pu.setValue(gl, 'cf_u', u.cf_u.value);
}
