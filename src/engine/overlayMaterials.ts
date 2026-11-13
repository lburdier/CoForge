import { AlwaysStencilFunc, Color, DoubleSide, KeepStencilOp, LineBasicMaterial, MeshBasicMaterial, NotEqualStencilFunc, ReplaceStencilOp, ShaderMaterial, Vector2, type Material } from 'three';

/**
 * Matériaux de la scène d'overlay (jamais utilisés dans le rendu final).
 *
 * Tout l'overlay est rendu dans la liste « transparente » de three.js : l'ordre
 * de dessin est donc piloté uniquement par `renderOrder` (voir ORDER).
 * On ne suppose pas que le tampon de profondeur de la scène principale soit
 * disponible quand l'overlay est dessiné : la profondeur des surfaces est
 * reproduite par des « occulteurs » (copies profondeur seule des maillages).
 */

/** Ordres de rendu dans l'overlay. */
export const ORDER = {
  gridXray: -300,
  occluder: -200,
  outlineMask: -160,
  grid: -150,
  peerOutline: -120,
  outline: -110,
  faces: -50,
  wire: 0,
  gizmo: 10,
  cageEdges: 20,
  cageVerts: 30,
  origins: 40,
  presence: 50,
  cursor: 60,
  tools: 100,
} as const;

/** Profondeur seule : reproduit la surface des objets pour masquer les overlays situés derrière. */
export function createOccluderMaterial(): MeshBasicMaterial {
  const m = new MeshBasicMaterial({ side: DoubleSide });
  m.name = 'occulteur';
  m.colorWrite = false;
  m.depthWrite = true;
  m.depthTest = true;
  m.transparent = true;
  m.opacity = 1;
  m.polygonOffset = true;
  m.polygonOffsetFactor = 1;
  m.polygonOffsetUnits = 1;
  m.toneMapped = false;
  return m;
}

/** Valeur de stencil écrite par la silhouette des objets contourés. */
export const OUTLINE_STENCIL = 1;

/**
 * Masque de silhouette des objets contourés : n'écrit ni couleur ni profondeur, seulement le
 * stencil, sur toute la silhouette (sans test de profondeur). Les contours ne sont ensuite dessinés
 * qu'en dehors de ce masque : la coque gonflée ne peut plus recouvrir les faces de l'objet (sur un
 * objet allongé, extrudé ou vu de biais, ses faces avant passaient devant la surface malgré le recul
 * en profondeur, d'où des triangles de couleur sur l'objet).
 */
export function createOutlineMaskMaterial(): MeshBasicMaterial {
  const m = new MeshBasicMaterial({ side: DoubleSide });
  m.name = 'masque-contour';
  m.colorWrite = false;
  m.depthWrite = false;
  m.depthTest = false;
  m.transparent = true;
  m.toneMapped = false;
  m.stencilWrite = true;
  m.stencilRef = OUTLINE_STENCIL;
  m.stencilFunc = AlwaysStencilFunc;
  m.stencilZPass = ReplaceStencilOp;
  m.stencilZFail = ReplaceStencilOp;
  m.stencilFail = ReplaceStencilOp;
  return m;
}

/**
 * Contour de sélection « coque » : la surface est gonflée en espace écran
 * d'une largeur fixe en pixels le long des normales de contour, et reculée en
 * profondeur pour rester derrière l'occulteur de l'objet : seul l'anneau qui
 * dépasse de la silhouette reste visible.
 */
export function createOutlineMaterial(color: string, widthPx: number): ShaderMaterial {
  const m = new ShaderMaterial({
    name: 'contour',
    uniforms: {
      uColor: { value: new Color(color) },
      uWidth: { value: widthPx },
      uResolution: { value: new Vector2(1, 1) },
    },
    vertexShader: /* glsl */ `
      attribute vec3 outlineNormal;
      uniform float uWidth;
      uniform vec2 uResolution;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec4 clip = projectionMatrix * mv;
        vec3 n = normalize(normalMatrix * outlineNormal);
        vec2 dir = (projectionMatrix * vec4(n, 0.0)).xy;
        float len = length(dir);
        if (len > 1e-6) {
          dir /= len;
          clip.xy += dir * (uWidth * 2.0 / uResolution) * clip.w;
        }
        gl_Position = clip;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      void main() { gl_FragColor = vec4(uColor, 1.0); }
    `,
    side: DoubleSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });
  m.polygonOffset = true;
  m.polygonOffsetFactor = 4;
  m.polygonOffsetUnits = 16;
  m.toneMapped = false;
  // Seulement hors de la silhouette marquée par le masque (voir createOutlineMaskMaterial).
  m.stencilWrite = true;
  m.stencilRef = OUTLINE_STENCIL;
  m.stencilFunc = NotEqualStencilFunc;
  m.stencilFail = KeepStencilOp;
  m.stencilZFail = KeepStencilOp;
  m.stencilZPass = KeepStencilOp;
  m.stencilWriteMask = 0;
  return m;
}

/** Points ronds de taille fixe en pixels, couleur par sommet (attribut `aColor`, vec4). */
export function createPointsMaterial(sizePx: number, border = true): ShaderMaterial {
  const m = new ShaderMaterial({
    name: 'points',
    uniforms: {
      uSize: { value: sizePx },
      uPixelRatio: { value: 1 },
      uBorder: { value: border ? 1 : 0 },
    },
    vertexShader: /* glsl */ `
      attribute vec4 aColor;
      uniform float uSize;
      uniform float uPixelRatio;
      varying vec4 vColor;
      void main() {
        vColor = aColor;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = uSize * uPixelRatio;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uBorder;
      varying vec4 vColor;
      void main() {
        vec2 c = gl_PointCoord * 2.0 - 1.0;
        float r = dot(c, c);
        if (r > 1.0) discard;
        vec3 col = vColor.rgb;
        if (uBorder > 0.5 && r > 0.55) col *= 0.25;
        gl_FragColor = vec4(col, vColor.a);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });
  m.toneMapped = false;
  return m;
}

/** Couleurs par sommet pour les lignes (attribut `aColor`, vec4). */
export function createVertexColorLineMaterial(): ShaderMaterial {
  const m = new ShaderMaterial({
    name: 'lignes',
    vertexShader: /* glsl */ `
      attribute vec4 aColor;
      varying vec4 vColor;
      void main() {
        vColor = aColor;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec4 vColor;
      void main() { gl_FragColor = vColor; }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });
  m.toneMapped = false;
  return m;
}

/**
 * Faces semi-transparentes à couleur par sommet (faces sélectionnées du mode édition).
 * Légèrement avancées en profondeur pour passer devant l'occulteur de la surface.
 */
export function createVertexColorFaceMaterial(): ShaderMaterial {
  const m = new ShaderMaterial({
    name: 'faces',
    vertexShader: /* glsl */ `
      attribute vec4 aColor;
      varying vec4 vColor;
      void main() {
        vColor = aColor;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec4 vColor;
      void main() {
        if (vColor.a <= 0.001) discard;
        gl_FragColor = vColor;
      }
    `,
    side: DoubleSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });
  m.toneMapped = false;
  return m;
}

/**
 * Cache de matériaux de lignes unies, partagés par (couleur, opacité).
 * `setDepthTest` bascule tous les matériaux d'un coup (mode rayons X).
 */
export class LineMaterialCache {
  private map = new Map<string, LineBasicMaterial>();
  private depthTest = true;

  get(color: string, opacity = 1): LineBasicMaterial {
    const key = `${color}|${opacity}`;
    let m = this.map.get(key);
    if (!m) {
      m = new LineBasicMaterial({ color: new Color(color), transparent: true, opacity, depthWrite: false, depthTest: this.depthTest });
      m.toneMapped = false;
      this.map.set(key, m);
    }
    return m;
  }

  setDepthTest(on: boolean): void {
    if (this.depthTest === on) return;
    this.depthTest = on;
    for (const m of this.map.values()) m.depthTest = on;
  }

  dispose(): void {
    for (const m of this.map.values()) m.dispose();
    this.map.clear();
  }
}

export function setDepthTest(materials: Iterable<Material>, on: boolean): void {
  for (const m of materials) m.depthTest = on;
}
