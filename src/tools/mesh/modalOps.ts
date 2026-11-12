import { BufferGeometry, Float32BufferAttribute, Group, Line, LineBasicMaterial, LineLoop, Vector3 } from 'three';
import type { AppContext } from '../../app/context';
import { edgeVerts, type Vec3 } from '../../core/doc/schema';
import { bevelEdges, insetFaces, insetFacesIndividual, loopCut, loopCutPreview } from '../../core/mesh/ops';
import { edgeRing } from '../../core/mesh/select';
import { selectionCenter } from '../../core/mesh/topology';
import type { ModalHandler, ModalResult, OperatorDef } from '../api';
import { fail, getMeshEditContext, pollMeshEdit, toWorld, type MeshEditContext } from './context';
import { LiveMeshEdit, NumInput, eventPos, fmt, isCancelKey, isConfirmKey, localUnitsPerPixel, project } from './modal';

/**
 * Opérateurs modaux du mode édition : incrustation (I), biseau (Ctrl+B), coupe en boucle (Ctrl+R).
 * Chaque mouvement recalcule l'opération depuis l'instantané pris au départ (LiveMeshEdit) ;
 * l'annulation du document est faite par le registre, la sélection d'origine est remise ici.
 */

const MAX_SEGMENTS = 32;
const MAX_CUTS = 64;
/** Glissement maximal de la coupe en boucle : à ±1 elle se confondrait avec une boucle existante (faces d’aire nulle). */
const MAX_SLIDE = 0.99;

/** Distance écran entre la souris et un point monde projeté (null si le point est derrière la caméra). */
function screenDistance(app: AppContext, m: { x: number; y: number }, world: Vector3): number | null {
  const c = project(app, world);
  return c ? Math.hypot(m.x - c.x, m.y - c.y) : null;
}

// ------------------------------------------------------------------ incrustation

function insetOperator(): OperatorDef {
  return {
    id: 'mesh.inset',
    label: 'Incruster les faces',
    description: 'Crée une couronne de faces à l’intérieur de la sélection (épaisseur à la souris, Ctrl : profondeur, I : individuel)',
    modes: ['edit'],
    poll: pollMeshEdit,
    exec(app, inv) {
      const ctx = getMeshEditContext(app);
      if (!ctx) return false;
      const faces = [...ctx.selection.faces];
      if (faces.length === 0) return fail('Sélectionnez au moins une face');
      const live = new LiveMeshEdit(app, ctx);
      const centerWorld = toWorld(ctx, selectionCenter(ctx.mesh, faces) ?? [0, 0, 0]);
      const upp = localUnitsPerPixel(app, ctx, centerWorld);

      let thicknessRaw = 0;
      let depth = 0;
      let individual = !!inv.args.individual;
      let last: { x: number; y: number } | null = inv.mouse ? { ...inv.mouse } : null;
      const numeric = new NumInput();

      const thickness = () => (numeric.active ? Math.max(0, numeric.value() ?? 0) : Math.max(0, thicknessRaw));
      const status = () =>
        `Incruster : épaisseur ${numeric.active ? numeric.text : fmt(thickness())} | profondeur ${fmt(depth)} (Ctrl) | ` +
        `I : individuel ${individual ? 'oui' : 'non'} | Entrée/clic : valider | Échap : annuler`;

      const apply = (): ModalResult | void => {
        const t = thickness();
        let ok: boolean;
        if (t === 0 && depth === 0) ok = live.revert();
        else ok = live.update((orig, idGen) => (individual ? insetFacesIndividual(orig, faces, t, depth, idGen) : insetFaces(orig, faces, t, depth, idGen)));
        if (!ok) return 'cancelled';
        app.ops.setModalStatus(status());
        app.viewport.requestRender();
      };

      const handler: ModalHandler = {
        status: status(),
        onPointerMove(e) {
          const m = eventPos(app, e);
          if (!last) {
            last = m;
            return;
          }
          if (e.ctrlKey) {
            // Ctrl : la souris règle la profondeur (vers le haut = vers l'extérieur).
            depth += (last.y - m.y) * upp;
          } else if (!numeric.active) {
            // Rapprocher la souris du centre de la sélection épaissit la couronne.
            const dPrev = screenDistance(app, last, centerWorld);
            const dCur = screenDistance(app, m, centerWorld);
            if (dPrev !== null && dCur !== null) thicknessRaw = Math.max(0, thicknessRaw + (dPrev - dCur) * upp);
          }
          last = m;
          return apply();
        },
        onPointerDown(e) {
          if (e.button === 0) return 'finished';
          if (e.button === 2) return 'cancelled';
        },
        onKeyDown(e) {
          if (isCancelKey(e)) return 'cancelled';
          if (isConfirmKey(e)) return 'finished';
          if ((e.key === 'i' || e.key === 'I') && !e.ctrlKey && !e.altKey) {
            individual = !individual;
            return apply();
          }
          if (numeric.handle(e)) return apply();
        },
        onEnd(committed) {
          if (!committed) live.restoreSelection();
        },
      };
      return handler;
    },
  };
}

// ------------------------------------------------------------------ biseau

function bevelOperator(): OperatorDef {
  return {
    id: 'mesh.bevel',
    label: 'Biseauter',
    description: 'Biseaute les arêtes sélectionnées (largeur à la souris, molette : segments)',
    modes: ['edit'],
    poll: pollMeshEdit,
    defaults: { segments: 1 },
    exec(app, inv) {
      const ctx = getMeshEditContext(app);
      if (!ctx) return false;
      const edges = [...ctx.selection.edges];
      if (edges.length === 0) return fail('Sélectionnez au moins une arête');
      const live = new LiveMeshEdit(app, ctx);
      const centerWorld = toWorld(ctx, selectionCenter(ctx.mesh, ctx.selection) ?? [0, 0, 0]);
      const upp = localUnitsPerPixel(app, ctx, centerWorld);

      let widthRaw = 0;
      let segments = Math.max(1, Math.min(MAX_SEGMENTS, Math.round(Number(inv.args.segments) || 1)));
      let last: { x: number; y: number } | null = inv.mouse ? { ...inv.mouse } : null;
      const numeric = new NumInput();

      const width = () => (numeric.active ? Math.max(0, numeric.value() ?? 0) : Math.max(0, widthRaw));
      const status = () =>
        `Biseauter : largeur ${numeric.active ? numeric.text : fmt(width())} | segments ${segments} (molette) | Entrée/clic : valider | Échap : annuler`;

      const apply = (): ModalResult | void => {
        const w = width();
        const ok = w === 0 ? live.revert() : live.update((orig, idGen) => bevelEdges(orig, edges, w, segments, idGen));
        if (!ok) return 'cancelled';
        app.ops.setModalStatus(status());
        app.viewport.requestRender();
      };

      const handler: ModalHandler = {
        status: status(),
        onPointerMove(e) {
          const m = eventPos(app, e);
          if (!last) {
            last = m;
            return;
          }
          if (!numeric.active) {
            // Éloigner la souris du centre de la sélection élargit le biseau.
            const dPrev = screenDistance(app, last, centerWorld);
            const dCur = screenDistance(app, m, centerWorld);
            if (dPrev !== null && dCur !== null) widthRaw = Math.max(0, widthRaw + (dCur - dPrev) * upp);
          }
          last = m;
          return apply();
        },
        onWheel(e) {
          const next = Math.max(1, Math.min(MAX_SEGMENTS, segments + (e.deltaY < 0 ? 1 : -1)));
          if (next === segments) return;
          segments = next;
          return apply();
        },
        onPointerDown(e) {
          if (e.button === 0) return 'finished';
          if (e.button === 2) return 'cancelled';
        },
        onKeyDown(e) {
          if (isCancelKey(e)) return 'cancelled';
          if (isConfirmKey(e)) return 'finished';
          if (numeric.handle(e)) return apply();
        },
        onEnd(committed) {
          if (!committed) live.restoreSelection();
        },
      };
      return handler;
    },
  };
}

// ------------------------------------------------------------------ coupe en boucle

/** Aperçu de la coupe en boucle dans l'overlay du viewport (polylignes en coordonnées monde). */
class LoopPreview {
  private group: Group | null = null;
  private material = new LineBasicMaterial({ color: 0xffd23f, depthTest: false, transparent: true });

  constructor(private app: AppContext) {}

  show(ctx: MeshEditContext, lines: Vec3[][], closed: boolean): void {
    this.clear();
    const root = this.app.viewport.overlayRoot;
    if (!root || lines.length === 0) return;
    const group = new Group();
    group.name = 'coforge-loopcut-preview';
    group.renderOrder = 999;
    for (const line of lines) {
      if (line.length < 2) continue;
      const pts: number[] = [];
      for (const p of line) {
        const w = toWorld(ctx, p);
        pts.push(w.x, w.y, w.z);
      }
      const geo = new BufferGeometry();
      geo.setAttribute('position', new Float32BufferAttribute(pts, 3));
      const obj = closed && line.length > 2 ? new LineLoop(geo, this.material) : new Line(geo, this.material);
      obj.renderOrder = 999;
      obj.frustumCulled = false;
      group.add(obj);
    }
    root.add(group);
    this.group = group;
    this.app.viewport.requestRender();
  }

  clear(): void {
    const g = this.group;
    if (!g) return;
    this.group = null;
    g.removeFromParent();
    g.traverse((o) => {
      const geo = (o as Line).geometry;
      if (geo && o !== g) geo.dispose();
    });
    this.app.viewport.requestRender();
  }

  dispose(): void {
    this.clear();
    this.material.dispose();
  }
}

function loopCutOperator(): OperatorDef {
  return {
    id: 'mesh.loop_cut',
    label: 'Coupe en boucle',
    description: 'Coupe un anneau de quads (survol : aperçu, molette : nombre de coupes, clic : fixer puis glisser)',
    modes: ['edit'],
    poll: pollMeshEdit,
    defaults: { cuts: 1 },
    exec(app, inv) {
      const ctx = getMeshEditContext(app);
      if (!ctx) return false;
      const live = new LiveMeshEdit(app, ctx);
      const preview = new LoopPreview(app);
      const mesh = ctx.mesh;

      let cuts = Math.max(1, Math.min(MAX_CUTS, Math.round(Number(inv.args.cuts) || 1)));
      let phase: 'hover' | 'slide' = 'hover';
      const sliding = () => phase === 'slide';
      let hoverKey: string | null = null;
      let factor = 0;
      // Glissement : paramètre écran de la souris le long de l'arête survolée, au moment du clic.
      let slideRef: { a: { x: number; y: number }; b: { x: number; y: number }; t0: number } | null = null;

      const hoverStatus = () =>
        `Coupe en boucle : ${cuts} coupe${cuts > 1 ? 's' : ''} (molette) | survolez une arête | clic : fixer | Échap : annuler`;
      const slideStatus = () => `Coupe en boucle : glissement ${fmt(factor, 3)} | clic/Entrée : valider | clic droit : centrer | Échap : annuler`;

      const updatePreview = () => {
        if (!hoverKey) {
          preview.clear();
          return;
        }
        let lines: Vec3[][] = [];
        try {
          lines = loopCutPreview(mesh, hoverKey, cuts, 0);
        } catch {
          lines = [];
        }
        preview.show(ctx, lines, edgeRing(mesh, hoverKey).closed);
      };

      const hover = (m: { x: number; y: number }) => {
        const hit = app.viewport.pickElement(m.x, m.y, 'edge');
        const key = hit && hit.type === 'edge' && mesh.verts.has(edgeVerts(hit.id)[0]) ? hit.id : null;
        if (key === hoverKey) return;
        hoverKey = key;
        updatePreview();
      };

      /** Points écran où la coupe croise l'arête survolée pour factor = -1 et +1 (indépendant du sens choisi par loopCut). */
      const slideAxis = (key: string): { a: { x: number; y: number }; b: { x: number; y: number } } | null => {
        const [va, vb] = edgeVerts(key);
        const pa = mesh.verts.get(va);
        const pb = mesh.verts.get(vb);
        if (!pa || !pb) return null;
        const onEdge = (f: number): Vec3 | null => {
          let best: Vec3 | null = null;
          let bestD = Infinity;
          for (const line of loopCutPreview(mesh, key, 1, f)) {
            for (const p of line) {
              const d = distToSegment(p, pa, pb);
              if (d < bestD) {
                bestD = d;
                best = p;
              }
            }
          }
          return best;
        };
        const lo = onEdge(-1);
        const hi = onEdge(1);
        if (!lo || !hi) return null;
        const a = project(app, toWorld(ctx, lo));
        const b = project(app, toWorld(ctx, hi));
        if (!a || !b || Math.hypot(b.x - a.x, b.y - a.y) < 1) return null;
        return { a, b };
      };

      const paramOn = (ref: { a: { x: number; y: number }; b: { x: number; y: number } }, m: { x: number; y: number }) => {
        const dx = ref.b.x - ref.a.x;
        const dy = ref.b.y - ref.a.y;
        return ((m.x - ref.a.x) * dx + (m.y - ref.a.y) * dy) / (dx * dx + dy * dy);
      };

      const applyCut = (): ModalResult | void => {
        if (!hoverKey) return 'cancelled';
        const key = hoverKey;
        if (!live.update((orig, idGen) => loopCut(orig, key, cuts, factor, idGen))) return 'cancelled';
        app.ops.setModalStatus(slideStatus());
        app.viewport.requestRender();
      };

      /** Fixe la boucle survolée et passe au glissement. */
      const fix = (m: { x: number; y: number } | null): ModalResult | void => {
        if (!hoverKey) return;
        const key = hoverKey;
        const res = loopCut(mesh, key, cuts, 0);
        if (!res.delta.setFaces || Object.keys(res.delta.setFaces).length === 0) {
          fail('Coupe impossible ici : l’arête doit appartenir à un anneau de quadrangles');
          return;
        }
        preview.clear();
        phase = 'slide';
        factor = 0;
        const axis = slideAxis(key);
        slideRef = axis && m ? { ...axis, t0: paramOn(axis, m) } : null;
        return applyCut();
      };

      if (inv.mouse) hover(inv.mouse);

      const handler: ModalHandler = {
        status: hoverStatus(),
        onPointerMove(e) {
          const m = eventPos(app, e);
          if (!live.alive()) return 'cancelled';
          if (phase === 'hover') {
            hover(m);
            app.ops.setModalStatus(hoverStatus());
            return;
          }
          if (!slideRef) return;
          const next = Math.max(-MAX_SLIDE, Math.min(MAX_SLIDE, (paramOn(slideRef, m) - slideRef.t0) * 2));
          if (next === factor) return;
          factor = next;
          return applyCut();
        },
        onWheel(e) {
          if (phase !== 'hover') return;
          const next = Math.max(1, Math.min(MAX_CUTS, cuts + (e.deltaY < 0 ? 1 : -1)));
          if (next === cuts) return;
          cuts = next;
          updatePreview();
          app.ops.setModalStatus(hoverStatus());
        },
        onPointerDown(e) {
          if (phase === 'hover') {
            if (e.button === 0) return fix(eventPos(app, e));
            if (e.button === 2) return 'cancelled';
            return;
          }
          if (e.button === 0) return 'finished';
          if (e.button === 2) {
            // Clic droit pendant le glissement : la coupe reste, centrée.
            factor = 0;
            const r = applyCut();
            return r === 'cancelled' ? r : 'finished';
          }
        },
        onKeyDown(e) {
          if (isCancelKey(e)) return 'cancelled';
          if (isConfirmKey(e)) {
            if (phase === 'slide') return 'finished';
            if (!hoverKey) return 'cancelled';
            const r = fix(null);
            if (r === 'cancelled') return r;
            return sliding() ? 'finished' : undefined;
          }
        },
        onEnd(committed) {
          preview.dispose();
          if (!committed) live.restoreSelection();
        },
      };
      return handler;
    },
  };
}

function distToSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap: Vec3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const l2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  const t = l2 > 0 ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / l2)) : 0;
  return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
}

export function modalOperators(): OperatorDef[] {
  return [insetOperator(), bevelOperator(), loopCutOperator()];
}
