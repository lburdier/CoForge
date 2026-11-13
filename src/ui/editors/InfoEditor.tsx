import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Copy, Info, Play, Terminal, Trash2 } from 'lucide-react';
import { toast } from '../../app/store';
import { clearInfo, useInfoLog, type InfoKind } from '../lib/infoLog';
import { IconButton } from '../widgets/basic';
import { EditorHeader, EditorShell } from './common';

const KIND_LABEL: Record<InfoKind, string> = { op: 'Opérateurs', info: 'Messages', error: 'Erreurs', console: 'Console' };
const KIND_ICON = { op: Play, info: Info, error: AlertCircle, console: Terminal };

/** Éditeur Info : journal des opérateurs exécutés et des messages (comme l'éditeur Info de Blender). */
export function InfoEditor() {
  const entries = useInfoLog();
  const [hidden, setHidden] = useState<Set<InfoKind>>(new Set());
  const [sel, setSel] = useState<Set<number>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const shown = entries.filter((e) => !hidden.has(e.kind));

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown.length]);

  const toggle = (k: InfoKind) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const copy = () => {
    const lines = shown.filter((e) => sel.size === 0 || sel.has(e.id)).map((e) => e.text);
    navigator.clipboard?.writeText(lines.join('\n')).then(
      () => toast(`${lines.length} ligne(s) copiée(s)`),
      () => toast('Copie impossible', 'error'),
    );
  };

  return (
    <EditorShell className="cf-info">
      <EditorHeader title="Info" icon={Info}>
        {(Object.keys(KIND_LABEL) as InfoKind[]).map((k) => (
          <button key={k} type="button" className={`cf-ed-chip${hidden.has(k) ? '' : ' is-on'}`} onClick={() => toggle(k)}>
            {KIND_LABEL[k]}
          </button>
        ))}
        <div className="cf-spacer" />
        <IconButton icon={Copy} tip="Copier (la sélection, ou tout)" onClick={copy} />
        <IconButton
          icon={Trash2}
          tip="Vider le journal"
          onClick={() => {
            clearInfo();
            setSel(new Set());
          }}
        />
      </EditorHeader>
      <div ref={listRef} className="cf-ed-body cf-info-list">
        {shown.length === 0 && <div className="cf-ed-empty">Le journal est vide : les opérations et les messages s’afficheront ici.</div>}
        {shown.map((e) => {
          const Icon = KIND_ICON[e.kind];
          return (
            <div
              key={e.id}
              className={`cf-info-row is-${e.kind}${sel.has(e.id) ? ' is-selected' : ''}`}
              onClick={(ev) =>
                setSel((s) => {
                  const multi = ev.ctrlKey || ev.shiftKey;
                  const n = new Set(multi ? s : []);
                  if (multi && s.has(e.id)) n.delete(e.id);
                  else n.add(e.id);
                  return n;
                })
              }
            >
              <Icon size={12} />
              <span className="cf-info-time">{new Date(e.time).toLocaleTimeString('fr-FR')}</span>
              <span className="cf-info-text">{e.text}</span>
            </div>
          );
        })}
      </div>
    </EditorShell>
  );
}
