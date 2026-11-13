import type { AppContext } from '../../app/context';
import { platform } from '../../app/platform';
import { patchRender, setFrame, store, toast } from '../../app/store';
import { pruneKeySelection } from './keyedit';

/**
 * Exécution locale de l'animation :
 *  - tête de lecture du store (`frame`) → `doc.setAnimFrame` (évaluation locale, jamais partagée) ;
 *  - `autoKey` et identité de l'utilisateur → document ;
 *  - boucle de lecture (temps réel : des images sont sautées si l'affichage ne suit pas) ;
 *  - sélection de clés nettoyée quand des clés disparaissent (y compris à distance) ;
 *  - dernière position du pointeur (menus ouverts au clavier).
 */

let pointer = { x: 200, y: 200 };

/** Dernière position connue du pointeur (coordonnées fenêtre). */
export function lastPointer(): { x: number; y: number } {
  return pointer;
}

export function bindAnimation(app: AppContext): () => void {
  const offs: (() => void)[] = [];

  // Document courant ← état local.
  offs.push(
    app.onDocChange((doc) => {
      const s = store.getState();
      doc.setAnimFrame(s.frame);
      doc.setAutoKey(s.autoKey);
      doc.setAnimAuthor(s.user.id);
      if (s.keySelection.size || s.handleSelection.size) store.setState({ keySelection: new Set(), handleSelection: new Set() });
      const off = doc.on('anim', () => pruneKeySelection(doc));
      return off;
    }),
  );

  offs.push(
    store.subscribe((s, prev) => {
      const doc = app.doc;
      if (s.frame !== prev.frame) {
        doc.setAnimFrame(s.frame);
        app.viewport.requestRender();
      }
      if (s.autoKey !== prev.autoKey) doc.setAutoKey(s.autoKey);
      if (s.user !== prev.user) doc.setAnimAuthor(s.user.id);
      if (s.playing !== prev.playing) {
        if (s.playing) startPlayback(app);
        else stopPlayback();
      }
    }),
  );

  if (typeof window !== 'undefined') {
    const onMove = (e: PointerEvent) => {
      pointer = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    offs.push(() => window.removeEventListener('pointermove', onMove));
  }
  offs.push(() => stopPlayback());
  return () => offs.forEach((o) => o());
}

// ------------------------------------------------------------------ lecture

let raf = 0;
let lastTime = 0;
let position = 0;

function startPlayback(app: AppContext): void {
  stopPlayback();
  if (typeof requestAnimationFrame === 'undefined') return;
  const range = app.doc.getAnimSettings();
  const f = store.getState().frame;
  // Hors de la plage : la lecture repart du début (ou de la fin à rebours), comme Blender.
  position = f < range.frameStart || f > range.frameEnd ? (store.getState().playing > 0 ? range.frameStart : range.frameEnd) : Math.round(f);
  setFrame(position);
  lastTime = performance.now();
  const tick = (now: number) => {
    const s = store.getState();
    if (!s.playing) return;
    const { frameStart, frameEnd, fps } = app.doc.getAnimSettings();
    const dt = Math.min(0.25, Math.max(0, (now - lastTime) / 1000));
    lastTime = now;
    position += dt * fps * s.playing;
    const len = frameEnd - frameStart + 1;
    if (position > frameEnd + 1) position = frameStart + ((position - frameStart) % len);
    if (position < frameStart) position = frameEnd + 1 - ((frameStart - position) % len);
    const target = Math.min(frameEnd, Math.max(frameStart, Math.floor(position)));
    if (target !== s.frame) setFrame(target);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

function stopPlayback(): void {
  if (raf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(raf);
  raf = 0;
}

// ------------------------------------------------------------------ rendu de l'animation

function dataUrlToBytes(url: string): Uint8Array {
  const i = url.indexOf(',');
  const bin = atob(url.slice(i + 1));
  const out = new Uint8Array(bin.length);
  for (let j = 0; j < bin.length; j++) out[j] = bin.charCodeAt(j);
  return out;
}

/**
 * Rend chaque image de la plage avec le rendu final (image fixe à l'image courante, répété) et
 * enregistre une suite numérotée « nom_0001.png… ». Le premier fichier est choisi dans la boîte
 * « Enregistrer sous » ; les suivants sont écrits à côté. La tête de lecture est rendue à sa
 * position d'origine à la fin (ou à l'annulation).
 */
export async function renderAnimation(app: AppContext): Promise<void> {
  const { frameStart, frameEnd } = app.doc.getAnimSettings();
  const back = store.getState().frame;
  store.setState({ playing: 0 });
  const pad = (n: number) => String(n).padStart(4, '0');
  let dir = '';
  let stem = '';
  let browser = false;
  try {
    for (let f = frameStart; f <= frameEnd; f++) {
      setFrame(f);
      app.doc.setAnimFrame(f);
      patchRender({ open: true, imageUrl: null, progress: 0, samples: 0 });
      toast(`Rendu de l'animation : image ${f - frameStart + 1} / ${frameEnd - frameStart + 1}`);
      const url = await app.viewport.renderFinal();
      const bytes = dataUrlToBytes(url);
      const filters = [{ name: 'Image PNG', extensions: ['png'] }];
      if (f === frameStart) {
        const chosen = await platform.saveFile(bytes, null, `rendu_${pad(f)}.png`, filters);
        if (!chosen) throw new Error('Rendu annulé');
        browser = !platform.isElectron;
        const m = /^(.*[\\/])?(.*?)(\d*)(\.[^.\\/]*)?$/.exec(chosen);
        dir = m?.[1] ?? '';
        stem = m?.[2] ?? 'rendu_';
      } else if (browser) await platform.saveFile(bytes, null, `${stem}${pad(f)}.png`, filters);
      else await platform.saveFile(bytes, `${dir}${stem}${pad(f)}.png`, `${stem}${pad(f)}.png`, filters);
    }
    toast(`Animation rendue : ${frameEnd - frameStart + 1} images (${stem}${pad(frameStart)}.png…)`);
  } finally {
    setFrame(back);
  }
}
