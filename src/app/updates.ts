import type { AppContext } from './context';
import { platform, type UpdateStatus } from './platform';
import { store, toast } from './store';

/**
 * Mises à jour automatiques, côté interface : l'état vient du processus principal
 * (electron/updater.ts) et est recopié dans `store.update` pour la barre d'état et le menu Aide.
 */

function apply(status: UpdateStatus): void {
  const prev = store.getState().update;
  store.setState({ update: status });
  if (status.state === 'ready' && (prev.state !== 'ready' || status.manual)) {
    toast(`CoForge ${status.version ?? ''} est téléchargé : il s'installera à la fermeture (Aide › Redémarrer et mettre à jour).`.replace('  ', ' '));
  } else if (status.manual && status.state === 'none') {
    toast(`CoForge est à jour (version ${platform.version}).`);
  } else if (status.manual && status.state === 'error') {
    toast(`Recherche de mises à jour impossible : ${status.error ?? 'erreur inconnue'}`, 'error');
  } else if (status.manual && status.state === 'downloading') {
    toast(`Téléchargement de CoForge ${status.version ?? ''} en cours…`.replace('  ', ' '));
  }
}

export function bindUpdates(): void {
  platform.onUpdateStatus(apply);
  void platform.updateStatus().then((s) => store.setState({ update: s }), () => {});
}

export function registerUpdateOps(app: AppContext): void {
  app.ops.register(
    {
      id: 'app.check_updates',
      label: 'Rechercher des mises à jour',
      description: 'Vérifie sur GitHub si une version plus récente de CoForge est publiée',
      undoable: false,
      poll: () => platform.isElectron,
      exec: () => {
        const s = store.getState().update;
        if (s.state === 'ready' || s.state === 'downloading') return apply({ ...s, manual: true });
        void platform.checkForUpdates().then(
          (r) => {
            // Le résultat arrive aussi par onUpdateStatus ; on ne traite ici que l'absence d'événement.
            if (r.state === 'disabled') toast('Mises à jour indisponibles hors de l\'application installée.', 'error');
          },
          (err) => toast(`Recherche de mises à jour impossible : ${(err as Error)?.message ?? String(err)}`, 'error'),
        );
      },
    },
    {
      id: 'app.install_update',
      label: 'Redémarrer et mettre à jour',
      description: 'Ferme CoForge, installe la version téléchargée et le relance',
      undoable: false,
      poll: () => store.getState().update.state === 'ready',
      exec: () => platform.installUpdate(),
    },
  );
}
