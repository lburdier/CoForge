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
  /** main → renderer : nouvel état des mises à jour (UpdateStatus). */
  updateStatus: 'coforge:update-status',
  /** renderer → main : état courant des mises à jour. */
  updateGetStatus: 'coforge:update-get-status',
  /** renderer → main : vérifier maintenant (à la demande de l'utilisateur). */
  updateCheck: 'coforge:update-check',
  /** renderer → main : fermer (avec la confirmation habituelle) puis installer la mise à jour téléchargée. */
  updateInstall: 'coforge:update-install',
  /** main → renderer : un lien d'invitation coforge:// attend (sans charge utile). */
  inviteLink: 'coforge:invite-link',
  /** renderer → main : récupère (et retire) le lien d'invitation en attente, ou null. */
  takeInviteLink: 'coforge:take-invite-link',
  /** renderer → main : adresse IP publique (requête externe, sur demande de l'utilisateur). */
  publicAddress: 'coforge:public-address',
} as const;
