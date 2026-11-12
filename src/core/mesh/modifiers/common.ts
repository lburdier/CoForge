/**
 * Outils communs aux modificateurs.
 *
 * Les modificateurs n'utilisent jamais d'identifiants aléatoires : tout identifiant créé est un
 * condensé (64 bits, 12 caractères) du « sel » du modificateur et des identifiants d'entrée dont
 * l'élément dérive. Mêmes entrées → mêmes identifiants, d'une évaluation à l'autre et d'un poste à l'autre.
 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function encode32(h: number): string {
  let x = h >>> 0;
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += ALPHABET[x % 62];
    x = Math.floor(x / 62);
  }
  return out;
}

/**
 * Identifiant déterministe dérivé d'une suite de fragments (identifiants d'entrée, indices, marqueurs).
 * Ne contient jamais '|' (réservé aux clés d'arêtes).
 */
export function hashId(...parts: (string | number)[]): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let p = 0; p < parts.length; p++) {
    const part = parts[p];
    const s = typeof part === 'string' ? part : String(part);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    // séparateur de fragments : ('ab','c') et ('a','bc') donnent des condensés différents
    h1 = Math.imul(h1 ^ 0x1f, 2654435761);
    h2 = Math.imul(h2 ^ 0x1f, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return encode32(h1) + encode32(h2);
}

/** Nombre fini, sinon la valeur de repli (les paramètres viennent d'un document partagé : tout peut arriver). */
export function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Nettoie une boucle : retire les répétitions consécutives (cycliques).
 * Renvoie null si le résultat n'est pas une face valide (moins de 3 sommets ou sommet répété).
 */
export function cleanLoop(loop: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const v of loop) if (out.length === 0 || out[out.length - 1] !== v) out.push(v);
  while (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
  if (out.length < 3) return null;
  if (new Set(out).size !== out.length) return null;
  return out;
}
