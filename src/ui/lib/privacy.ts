/**
 * Masquage des adresses IP à l'écran (partage d'écran, stream, capture) : les liens et adresses
 * restent copiables tels quels, seul l'affichage est masqué tant que l'utilisateur ne demande pas
 * à les voir. Les noms d'hôte (ex. tunnel *.trycloudflare.com) ne révèlent pas d'IP : ils restent lisibles.
 */

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_BRACKETED = /\[[0-9a-f:.]+\]/gi;
const IPV6_PARAM = /(host=)([0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7})(?=[&#]|$)/gi;

export const MASK = '•••';

/** Remplace toute adresse IP d'un texte (lien, URL, adresse:port) par « ••• ». */
export function maskIps(text: string): string {
  return text
    .replace(IPV4, MASK)
    .replace(IPV6_BRACKETED, `[${MASK}]`)
    .replace(IPV6_PARAM, `$1${MASK}`);
}

/** Le texte contient-il une adresse IP ? */
export function containsIp(text: string): boolean {
  IPV4.lastIndex = 0;
  IPV6_BRACKETED.lastIndex = 0;
  IPV6_PARAM.lastIndex = 0;
  const found = IPV4.test(text) || IPV6_BRACKETED.test(text) || IPV6_PARAM.test(text);
  IPV4.lastIndex = 0;
  IPV6_BRACKETED.lastIndex = 0;
  IPV6_PARAM.lastIndex = 0;
  return found;
}
