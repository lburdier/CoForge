const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Identifiant court, unique entre utilisateurs sans coordination (aléatoire, ~71 bits).
 * Ne contient jamais le caractère '|' (réservé aux clés d'arêtes).
 */
export function newId(length = 12): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}
