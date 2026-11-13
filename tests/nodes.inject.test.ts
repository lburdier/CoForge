import { describe, expect, it } from 'vitest';
import { MeshPhysicalMaterial, ShaderLib } from 'three';
import { compileShaderTree } from '../src/core/nodes/shaderCompile';
import { registerShaderNodes } from '../src/core/nodes/shaderNodes';
import { addNode, connect, createNode, type Tree } from '../src/ui/nodes/treeOps';
import { applyCompiledShader } from '../src/engine/nodeMaterial';

registerShaderNodes();

/** Arbre bruit → couleur de base du Principled → sortie (canal qui varie par pixel). */
function noiseTree(): Tree {
  const t: Tree = { nodes: {}, links: [] };
  const out = createNode('shader', 'ShaderNodeOutputMaterial', 300, 0);
  const bsdf = createNode('shader', 'ShaderNodeBsdfPrincipled', 0, 0);
  const noise = createNode('shader', 'ShaderNodeTexNoise', -300, 0);
  for (const n of [out, bsdf, noise]) addNode(t, n);
  connect('shader', t, noise.id, 'Color', bsdf.id, 'Base Color');
  connect('shader', t, bsdf.id, 'BSDF', out.id, 'Surface');
  return t;
}

describe('injection GLSL des matériaux à nœuds', () => {
  it('déclare les uniformes utilisés par la bibliothèque (cf_u, cfModel)', () => {
    const compiled = compileShaderTree(noiseTree() as never);
    expect(compiled.code).toContain('cf_u[');
    const mat = new MeshPhysicalMaterial();
    applyCompiledShader(mat, compiled, false);
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: ShaderLib.physical.vertexShader,
      fragmentShader: ShaderLib.physical.fragmentShader,
    };
    mat.onBeforeCompile(shader as never, null as never);
    const frag = shader.fragmentShader;
    expect(frag).toMatch(new RegExp(`uniform vec4 cf_u\\[${Math.max(1, compiled.uniformVec4)}\\];`));
    expect(frag).toContain('uniform mat4 cfModel;');
    // Les déclarations précèdent la bibliothèque qui les utilise.
    expect(frag.indexOf('uniform vec4 cf_u[')).toBeLessThan(frag.indexOf('float cf_uf(int k)'));
    expect(shader.uniforms).toHaveProperty('cf_u');
    expect(shader.uniforms).toHaveProperty('cfModel');
  });
});
