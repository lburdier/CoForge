/** Canaux IPC partagés entre le processus principal et le preload. */
export const IPC = {
  hostStart: 'coforge:host-start',
  hostStop: 'coforge:host-stop',
  openFile: 'coforge:open-file',
  saveFile: 'coforge:save-file',
  getStartupFile: 'coforge:get-startup-file',
  setTitle: 'coforge:set-title',
  /** renderer → main : Blender installé ({ version }) ou null. */
  blenderInfo: 'coforge:blender-info',
  /** renderer → main : (source { path | data }, requête) → maillages finaux et couleurs moyennes, ou null sans Blender. */
  blenderEvaluate: 'coforge:blender-evaluate',
  /** renderer → main : (source { path | data }) → octets .glb, ou null sans Blender. */
  blenderConvert: 'coforge:blender-convert',
  /** renderer → main : un callback de fermeture est enregistré. */
  closeRegistered: 'coforge:close-registered',
  /** main → renderer : la fenêtre veut se fermer (argument : identifiant de la demande). */
  closeRequest: 'coforge:close-request',
  /** renderer → main : la demande est bien reçue, la réponse suivra (l'utilisateur peut être devant une confirmation). */
  closeAck: 'coforge:close-ack',
  /** renderer → main : (identifiant, autorisé). */
  closeResponse: 'coforge:close-response',
} as const;
