# CoForge — règles communes de l'équipe

CoForge est un logiciel Windows (Electron) de modélisation 3D collaborative en temps réel :
blocking et hard surface, éclairage, deux moteurs de rendu, interface inspirée de Blender.
Projet : `E:\YNOV\WIORKFLOW\CoForge`.

## Architecture en une page

```
electron/        processus principal : fenêtre, fichiers, serveur de session embarqué
server/          serveur de collaboration (Node pur, aussi lançable seul sur une machine dédiée)
src/core/        données et algorithmes PURS (aucun DOM)
  doc/           schema.ts (types), SceneDoc.ts (façade du document CRDT Yjs), transforms.ts
  mesh/          noyau de modélisation : primitives, opérations, modificateurs, triangulation
src/net/         client de collaboration (document + présence)
src/engine/      viewport three.js : synchronisation doc → scène, picking, rendu temps réel et path tracing
src/tools/       opérateurs (G/R/S, extrusion…), clavier/souris, gizmos
src/ui/          interface React (barres, outliner, propriétés, dialogues)
src/app/         assemblage : contexte, store local, fichiers, session
```

Principe collaboratif : la scène entière vit dans un document CRDT (Yjs). Chaque objet, chaque
propriété, chaque sommet et chaque face est une entrée indépendante : les éditions simultanées
fusionnent sans conflit, hors-ligne compris. Le serveur ne fait que relayer et persister. Ce qui est
personnel (sélection, mode, caméra) reste local et est diffusé comme « présence » éphémère.

## Fichiers de contrat — À LIRE EN PREMIER, À NE PAS MODIFIER

- `src/core/doc/schema.ts` — types de toutes les données de scène
- `src/core/doc/SceneDoc.ts` — lecture/écriture du document, événements, annulation
- `src/core/doc/transforms.ts` — matrices locales/monde, parentage
- `src/core/mesh/types.ts` — contrat du noyau de modélisation
- `src/app/store.ts` — état local (zustand) ; `src/app/context.ts` — AppContext ; `src/app/hooks.ts` — hook `useDoc`
- `src/app/platform.ts` — pont Electron (`window.coforge`)
- `src/engine/api.ts` — contrat du viewport ; `src/net/api.ts` — contrat réseau
- `src/tools/api.ts` — registre d'opérateurs ; `src/tools/menus.ts` — catalogue des opérateurs et menus

Si un contrat vous semble faux ou insuffisant : ne le modifiez pas, contournez au mieux et
signalez-le précisément dans votre rapport final.

## Règles

1. Ne touchez QUE les fichiers de votre zone (indiquée dans votre consigne). D'autres développeurs
   travaillent en même temps dans les autres dossiers.
2. Ne modifiez pas `package.json`, ne lancez pas `npm install`. Dépendances déjà installées :
   three 0.187, three-mesh-bvh, three-bvh-csg, three-gpu-pathtracer, yjs, y-websocket, y-protocols,
   lib0, ws, react 19, react-dom, zustand 5, lucide-react, electron 45, electron-builder, esbuild,
   vite 8, vitest 5, typescript 7. S'il vous manque vraiment un paquet, signalez-le dans le rapport.
3. TypeScript strict. Vos fichiers doivent passer `npx tsc --noEmit -p tsconfig.json` (des erreurs
   peuvent apparaître dans les zones des autres pendant qu'ils travaillent : ignorez-les, ne les corrigez pas).
4. Repère Z vers le haut, mètres, rotations Euler XYZ en radians, couleurs `'#rrggbb'`.
5. Tous les textes visibles par l'utilisateur et les commentaires sont en français.
6. Jamais d'accès direct aux types Yjs hors de `SceneDoc` : passez par ses méthodes.
   Le document peut être remplacé à chaud : lisez toujours `app.doc`, abonnez-vous via `app.onDocChange`.
7. Robustesse collaborative : une donnée peut disparaître à tout instant (supprimée par un autre
   utilisateur). Tout accès par identifiant doit tolérer `null`.
8. Pas de commit git. Pas de fichiers de documentation supplémentaires.
9. Code complet et fonctionnel : pas de TODO, pas de fonctions vides, pas de fonctionnalités simulées.
10. Rapport final attendu : fichiers créés, API publique exposée, ce que vous avez réellement vérifié
    (commandes lancées et résultats), limites connues, problèmes de contrat rencontrés.

## Reprise du chantier (important)

Un premier passage a été interrompu en cours de route : votre zone peut contenir des fichiers
déjà écrits, complets ou tronqués. Commencez par les lire, gardez ce qui est bon, terminez ou
réécrivez ce qui est incomplet. Ne repartez pas de zéro sans raison.

## Zones et interfaces internes

| Zone | Fichiers | Expose |
|---|---|---|
| mesh-ops | `src/core/mesh/ops/**`, `src/core/mesh/select.ts`, `src/core/mesh/primitives.ts`, `tests/mesh.ops.test.ts` | `src/core/mesh/ops/index.ts` réexporte toutes les opérations |
| mesh-mod | `src/core/mesh/modifiers/**`, `src/core/mesh/index.ts`, `src/core/mesh/topology.ts`, `triangulate.ts`, `vec.ts`, `tests/mesh.modifiers.test.ts` | `evaluateModifiers`, `triangulate`, `meshBounds` ; `index.ts` fait aussi `export * from './ops'`, `'./select'`, `'./primitives'` |
| engine-core | `src/engine/*.ts` (sauf `api.ts`) | `src/engine/index.ts` : `createViewport(app): IViewport` |
| engine-render | `src/engine/render/**`, `src/engine/io/**` | voir ci-dessous |
| tools-base | `src/tools/**` sauf `api.ts`, `menus.ts`, `src/tools/mesh/**` | `registerTools(app)` |
| tools-mesh | `src/tools/mesh/**` | `registerMeshOps(app): void` dans `src/tools/mesh/index.ts` (opérateurs `mesh.*`) |
| ui-shell | `src/ui/**` sauf `outliner/` et `properties/` | `src/ui/App.tsx` : `App` |
| ui-panels | `src/ui/outliner/**`, `src/ui/properties/**` | `Outliner` (`outliner/Outliner.tsx`), `PropertiesEditor` (`properties/PropertiesEditor.tsx`), sans props, remplissent leur conteneur |

### engine-render → engine-core

```ts
// src/engine/render/index.ts
export type FrameMode = 'plain' | 'realtime' | 'pathtrace';
export type DirtyKind = 'geometry' | 'materials' | 'lights' | 'environment' | 'camera';
export class RenderPipeline {
  constructor(renderer: THREE.WebGLRenderer);
  setSize(width: number, height: number, pixelRatio: number): void;
  /** Signale ce qui a changé depuis la dernière image (relance l'accumulation du path tracing). */
  markDirty(kind: DirtyKind): void;
  /**
   * Dessine une image du viewport. `plain` : rendu direct sans effets (modes fil de fer / solide / matériau) ;
   * `realtime` : rastérisation avec ombres, AO et bloom selon `settings` ; `pathtrace` : un échantillon
   * de plus par appel, jusqu'à `settings.viewportSamples`. `overlay` est dessiné par-dessus, sans effets.
   * Renvoie true tant qu'il faut rappeler render() à l'image suivante (accumulation en cours).
   */
  render(f: { scene: THREE.Scene; camera: THREE.Camera; overlay: THREE.Scene | null; mode: FrameMode; settings: RenderSettings }): boolean;
  /** Échantillons accumulés (path tracing), 0 sinon. */
  readonly samples: number;
  dispose(): void;
}
/** Rendu de l'image finale hors écran ; n'altère pas la taille du viewport. Rejette avec Error('Rendu annulé') si signal est abandonné. */
export function renderFinalImage(a: {
  renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.Camera; settings: RenderSettings;
  width: number; height: number; samples: number;
  onProgress(progress: number, samples: number, previewUrl: string | null): void; signal: AbortSignal;
}): Promise<string>;

// src/engine/io/index.ts
export interface ExportItem { name: string; mesh: MeshData; matrixWorld: THREE.Matrix4; material: MaterialData | null; smooth: boolean; autoSmoothAngle: number }
export function exportGLB(items: ExportItem[]): Promise<ArrayBuffer>;   // Y-up
export function exportOBJ(items: ExportItem[]): string;                 // polygones conservés
export function importFile(doc: SceneDoc, name: string, data: ArrayBuffer): Promise<string[]>; // crée objets, maillages (sommets soudés), matériaux
```

La scène three.js fournie par engine-core est en repère Z-up (`camera.up = (0,0,1)`), contient des
`THREE.Mesh` à `MeshPhysicalMaterial` (BufferGeometry non indexée : position + normal), des lumières
three.js (`PointLight`, `DirectionalLight`, `SpotLight`, `RectAreaLight`), `scene.background` et
`scene.environment` déjà réglés par `WorldEnv`. Les gizmos et aides sont dans `overlay`, jamais dans `scene`.

### Thème de l'interface (variables CSS, définies par ui-shell dans `src/ui/styles/theme.css`)

`--bg-app #161616`, `--bg-panel #303030`, `--bg-header #2b2b2b`, `--bg-field #545454`, `--bg-field-dark #1d1d1d`,
`--bg-hover #656565`, `--bg-row-alt #2b2b2b`, `--accent #4772b3`, `--accent-hover #5680c2`, `--select #f5a623`,
`--active #ffbb55`, `--text #e6e6e6`, `--text-dim #9a9a9a`, `--border #1a1a1a`, `--danger #c0392b`,
`--radius 4px`, `--font 12px 'Segoe UI', system-ui, sans-serif`, `--row-h 22px`.
Classes préfixées `cf-`. ui-shell stylise les widgets existants (`src/ui/widgets`) ; ui-panels met ses
styles dans `src/ui/outliner/outliner.css` et `src/ui/properties/properties.css`, importés par ses composants.
