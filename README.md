# CoForge

Modélisation 3D collaborative en temps réel pour Windows : blocking et hard surface, éclairage, deux moteurs de rendu, outliner, dans une interface inspirée de Blender.

## Télécharger

L'installateur Windows (`CoForge-Setup-x.y.z.exe`) est dans la page [Releases](../../releases). L'exécutable n'est pas signé : Windows SmartScreen peut demander une confirmation au premier lancement.

## Fonctions

- **Collaboration temps réel** : la scène entière est un document CRDT (Yjs). Chaque objet, sommet et face est une entrée indépendante : plusieurs personnes éditent la même scène, voire le même maillage, sans conflit. Présence (caméras, sélections), chat, suivi de la vue d'un participant.
- **Héberger / rejoindre** : l'application embarque le serveur de session (Fichier → Héberger). Un serveur autonome est aussi livré : `node coforge-server.cjs --port 4455 --data ./rooms`.
- **Modélisation** : primitives, mode édition (sommets, arêtes, faces), extrusion, inset, biseau, loop cut, subdivision, pont, fusion, remplissage ; modificateurs miroir, réseau, biseau, subdivision, solidifier, booléen.
- **Transformations** : G / R / S avec contraintes d'axe et de plan, saisie numérique, pivots, aimantation à la grille ou **aux sommets**.
- **Éclairage** : lumières point, soleil, spot, surface ; monde couleur ou ciel procédural.
- **Rendu** :
  - *Temps réel* (rastérisation, ombres, occlusion ambiante, bloom) — dans l'esprit d'EEVEE ;
  - *Path tracing* GPU progressif — dans l'esprit de Cycles — avec **affichage instantané** : résolution interne réduite, débruitage et remise à l'échelle (même principe que DLSS, réalisé en shaders pour tous les GPU ; ce n'est pas le DLSS de NVIDIA, inaccessible depuis WebGL).
- **Import** : `.blend` (Blender 2.5x → 5.1, lecteur natif ; si Blender est installé, il est sollicité pour la géométrie finale des courbes, textes et modificateurs sans équivalent), glTF/GLB, FBX, OBJ, STL, PLY, Collada. **Export** : GLB, OBJ.

### Limites connues

- Pas d'UV, de textures image, d'animation ni d'armatures : à l'import, un matériau texturé reprend la couleur moyenne de sa texture, et tout ce qui n'est pas repris est listé dans le rapport d'import.
- Les moteurs de rendu sont des équivalents d'EEVEE et de Cycles, pas les moteurs de Blender.

## Développement

```bash
npm install
npm run dev        # application Electron en développement
npm test           # tests (vitest)
npm run build      # build de production
npm run dist       # installateur Windows dans release/
```

Pile : Electron, TypeScript, React, three.js, three-gpu-pathtracer, Yjs. Architecture et conventions : `docs/EQUIPE.md`.

## Licence

MIT.
