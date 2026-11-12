import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getApp } from '../../app/context';
import type { DocEvents, SceneDoc } from '../../core/doc/SceneDoc';
import { toast } from '../../app/store';

/** Utilitaires communs de l'interface (aucun composant ici). */

export const RAD2DEG = 180 / Math.PI;
export const DEG2RAD = Math.PI / 180;

export function clamp(v: number, min?: number, max?: number): number {
  if (min !== undefined && v < min) return min;
  if (max !== undefined && v > max) return max;
  return v;
}

/** Arrondi qui élimine le bruit flottant (1e-6). */
export function tidy(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

export function formatNumber(v: number, precision: number): string {
  if (!Number.isFinite(v)) return '0';
  const s = v.toFixed(precision);
  // évite « -0.000 »
  return Number(s) === 0 ? (0).toFixed(precision) : s;
}

/** Nombre entier lisible à la française : 12 345. */
export function formatCount(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/**
 * Évalue une expression arithmétique simple saisie dans un champ numérique :
 * + - * / ^, parenthèses, virgule ou point décimal, constante « pi ».
 * Renvoie null si l'expression est invalide.
 */
export function evalExpression(input: string): number | null {
  const src = input.replace(/\s+/g, '').replace(/,/g, '.').toLowerCase();
  if (!src) return null;
  let i = 0;

  const parsePrimary = (): number => {
    const c = src[i];
    if (c === '(') {
      i++;
      const v = parseSum();
      if (src[i] !== ')') throw new Error('parenthèse');
      i++;
      return v;
    }
    if (c === '-') {
      i++;
      return -parsePower();
    }
    if (c === '+') {
      i++;
      return parsePower();
    }
    if (src.startsWith('pi', i)) {
      i += 2;
      return Math.PI;
    }
    const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/.exec(src.slice(i));
    if (!m) throw new Error('nombre');
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const parsePower = (): number => {
    const base = parsePrimary();
    if (src[i] === '^') {
      i++;
      return Math.pow(base, parsePower());
    }
    return base;
  };
  const parseProduct = (): number => {
    let v = parsePower();
    while (src[i] === '*' || src[i] === '/') {
      const op = src[i++];
      const r = parsePower();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const parseSum = (): number => {
    let v = parseProduct();
    while (src[i] === '+' || src[i] === '-') {
      const op = src[i++];
      const r = parseProduct();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };

  try {
    const v = parseSum();
    if (i !== src.length || !Number.isFinite(v)) return null;
    return v;
  } catch {
    return null;
  }
}

/** Comparaison insensible à la casse et aux accents. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

export function isHexColor(s: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(s);
}

/** Couleur de texte lisible (noir ou blanc) sur un fond donné. */
export function contrastColor(hex: string): string {
  if (!isHexColor(hex)) return '#ffffff';
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return r * 0.299 + g * 0.587 + b * 0.114 > 150 ? '#111111' : '#ffffff';
}

export function initialOf(name: string): string {
  const t = name.trim();
  return t ? t[0].toUpperCase() : '?';
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copié dans le presse-papiers');
  } catch {
    // repli : zone de texte temporaire
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    toast(ok ? 'Copié dans le presse-papiers' : 'Copie impossible', ok ? 'info' : 'error');
  }
}

// ------------------------------------------------------------------ stockage local

const PREFIX = 'coforge.ui.';

export function loadStored<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(PREFIX + key);
    if (raw === null || raw === undefined) return fallback;
    const v = JSON.parse(raw);
    return typeof v === typeof fallback && Array.isArray(v) === Array.isArray(fallback) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveStored(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* stockage indisponible */
  }
}

/** useState mémorisé dans localStorage (tailles de panneaux, replis…). */
export function usePersistent<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => loadStored(key, initial));
  const set = useCallback(
    (v: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
        saveStored(key, next);
        return next;
      });
    },
    [key],
  );
  return [value, set];
}

// ------------------------------------------------------------------ document

/**
 * Comme `useDoc`, mais les relectures sont limitées à une toutes les `ms`
 * millisecondes : pour les valeurs coûteuses (statistiques) qui n'ont pas à
 * suivre chaque image d'une opération modale.
 */
export function useDocThrottled<T>(read: (doc: SceneDoc) => T, ms: number, events: (keyof DocEvents)[] = ['change']): T {
  const [version, setVersion] = useState(0);
  const eventsKey = events.join(',');
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        setVersion((v) => v + 1);
      }, ms);
    };
    const off = getApp().onDocChange((doc) => {
      setVersion((v) => v + 1);
      const unsubs = events.map((ev) => doc.on(ev, schedule));
      return () => unsubs.forEach((u) => u());
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventsKey, ms]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => read(getApp().doc), [version]);
}

/** Statistiques de scène, rafraîchies au plus deux fois par seconde. */
export function useSceneStats(): { objects: number; verts: number; faces: number } {
  return useDocThrottled((doc) => doc.stats(), 500);
}

/** Référence toujours à jour vers la dernière valeur (pour les gestionnaires stables). */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/**
 * Renomme un objet en garantissant un nom unique (suffixe .001 à la Blender).
 * Sans effet si le nom est vide ou inchangé.
 */
export function renameObject(id: string, name: string): void {
  const doc = getApp().doc;
  const obj = doc.getObject(id);
  const next = name.trim();
  if (!obj || !next || next === obj.name) return;
  const taken = doc.listObjects().some((o) => o.id !== id && o.name === next);
  doc.updateObject(id, { name: taken ? doc.uniqueName(next) : next });
}

/** Exécute plusieurs écritures comme UNE étape d'annulation. */
export function withOp(fn: (doc: SceneDoc) => void): void {
  const doc = getApp().doc;
  doc.beginOp();
  try {
    doc.transact(() => fn(doc));
  } finally {
    doc.endOp();
  }
}

/** Empêche les frappes d'un champ d'atteindre les raccourcis globaux. */
export function stopKeys(e: { stopPropagation(): void }): void {
  e.stopPropagation();
}
