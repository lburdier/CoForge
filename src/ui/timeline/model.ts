import { useEffect, useState } from 'react';
import { getApp } from '../../app/context';
import { store } from '../../app/store';
import type { ChannelCurve, ChannelObject } from '../../tools/anim/keyedit';

/**
 * Modèle d'affichage des éditeurs d'animation : lignes de la feuille d'exposition et de la
 * liste des canaux, regroupement des clés par image (losanges), abonnement aux changements.
 */

export interface AnimRow {
  id: string;
  kind: 'summary' | 'object' | 'owner' | 'curve';
  label: string;
  depth: number;
  /** Courbes résumées par la ligne (une seule pour une ligne de courbe). */
  curves: ChannelCurve[];
  curve?: ChannelCurve;
  color?: string;
  expandable: boolean;
}

export interface KeyGroup {
  frame: number;
  ids: string[];
}

export const RULER_H = 22;
export const ROW_H = 20;

/** Lignes (résumé, objet, propriétaire, courbe) ; `collapsed` : lignes repliées. */
export function buildRows(channels: ChannelObject[], collapsed: ReadonlySet<string>, summary: boolean): AnimRow[] {
  const rows: AnimRow[] = [];
  const all = channels.flatMap((c) => c.owners.flatMap((o) => o.curves));
  if (summary) rows.push({ id: 'summary', kind: 'summary', label: 'Résumé', depth: 0, curves: all, expandable: false });
  for (const obj of channels) {
    const objCurves = obj.owners.flatMap((o) => o.curves);
    const objId = `o:${obj.objectId}`;
    rows.push({ id: objId, kind: 'object', label: obj.name, depth: 0, curves: objCurves, expandable: true });
    if (collapsed.has(objId)) continue;
    for (const own of obj.owners) {
      const ownId = `w:${obj.objectId}:${own.owner}`;
      rows.push({ id: ownId, kind: 'owner', label: own.label, depth: 1, curves: own.curves, expandable: true });
      if (collapsed.has(ownId)) continue;
      for (const c of own.curves) rows.push({ id: `c:${c.key}`, kind: 'curve', label: c.label, depth: 2, curves: [c], curve: c, color: c.color, expandable: false });
    }
  }
  return rows;
}

/** Clés d'un ensemble de courbes regroupées par image (un losange par image). */
export function keyGroups(curves: ChannelCurve[]): KeyGroup[] {
  const map = new Map<number, KeyGroup>();
  for (const c of curves) {
    for (const k of c.keys) {
      const f = Math.round(k.frame * 1000) / 1000;
      let g = map.get(f);
      if (!g) map.set(f, (g = { frame: k.frame, ids: [] }));
      g.ids.push(k.id);
    }
  }
  return [...map.values()].sort((a, b) => a.frame - b.frame);
}

/**
 * Version qui change à chaque modification utile aux éditeurs d'animation : clés (y compris
 * celles des autres participants), objets, réglages de scène, état local (image, sélections).
 */
export function useAnimVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf = 0;
    const bump = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setV((x) => x + 1);
      });
    };
    const offDoc = getApp().onDocChange((doc) => {
      bump();
      const offs = [doc.on('anim', bump), doc.on('scene', bump), doc.on('objects', (e) => (e.added.length || e.removed.length || e.changed.some((c) => c.keys.includes('name'))) && bump())];
      return () => offs.forEach((o) => o());
    });
    const offStore = store.subscribe((s, p) => {
      if (
        s.selection !== p.selection ||
        s.keySelection !== p.keySelection ||
        s.handleSelection !== p.handleSelection ||
        s.hiddenCurves !== p.hiddenCurves ||
        s.animOnlySelected !== p.animOnlySelected ||
        s.graphNormalize !== p.graphNormalize ||
        s.autoKey !== p.autoKey
      )
        bump();
    });
    return () => {
      offDoc();
      offStore();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  return v;
}

/** Pas « rond » de graduation pour qu'il y ait au moins `minPx` pixels entre deux traits. */
export function niceStep(unitsPerPx: number, minPx: number, integer: boolean): number {
  const raw = unitsPerPx * minPx;
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-12))));
  for (const m of [1, 2, 5, 10]) {
    const s = m * pow;
    if (s >= raw) return integer ? Math.max(1, Math.round(s)) : s;
  }
  return integer ? Math.max(1, Math.round(10 * pow)) : 10 * pow;
}
