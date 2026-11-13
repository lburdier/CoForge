import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { FileText, Play, Plus, Trash2 } from 'lucide-react';
import { toast } from '../../app/store';
import { runScript } from '../lib/consoleCommands';
import { logInfo } from '../lib/infoLog';
import { withOp } from '../lib/util';
import { useDocWhen } from '../properties/docHooks';
import { IconButton, Select, TextField } from '../widgets/basic';
import { EditorHeader, EditorShell } from './common';

const SAMPLE = `# Script CoForge : une commande par ligne (tapez « help » dans la console).
# Alt+P ou le bouton ▶ exécute le script ; tout est annulable (Ctrl+Z).
run object.add {"type":"cube"}
set Cube location 0 0 1
stats
`;

/** Texte affiché par zone (comme le bloc de texte actif d'un éditeur de texte de Blender). */
const currentByArea = new Map<string, string>();

/**
 * Éditeur de texte : blocs de texte PARTAGÉS du document (scripts, notes). La frappe reste locale
 * et s'enregistre dans le document après une courte pause ou à la sortie du champ.
 */
export function TextEditor({ areaId }: { areaId: string }) {
  const texts = useDocWhen((doc) => doc.listTexts(), { data: (e) => e.table === 'texts' });
  const [cur, setCurState] = useState<string | null>(() => currentByArea.get(areaId) ?? null);
  const setCur = (id: string | null) => {
    if (id) currentByArea.set(areaId, id);
    else currentByArea.delete(areaId);
    setCurState(id);
  };
  const text = texts.find((t) => t.id === cur) ?? texts[0] ?? null;
  const [draft, setDraft] = useState<string | null>(null);
  const [output, setOutput] = useState<{ ok: boolean; lines: string[] } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const value = draft ?? text?.content ?? '';
  const lineCount = useMemo(() => value.split('\n').length, [value]);

  const flush = (content = draft) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!text || content === null || content === text.content) {
      setDraft(null);
      return;
    }
    withOp((doc) => doc.updateText(text.id, { content }));
    setDraft(null);
  };

  // Changement de texte affiché : on enregistre le brouillon en cours.
  useEffect(() => () => flush(), [text?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const edit = (v: string) => {
    setDraft(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => flush(v), 600);
  };

  const create = () => {
    let id = '';
    withOp((doc) => {
      const n = doc.listTexts().length;
      id = doc.addText({ name: n ? `Texte.${String(n).padStart(3, '0')}` : 'Texte', content: n ? '' : SAMPLE });
    });
    if (id) setCur(id);
  };
  const remove = () => {
    if (!text) return;
    if (!window.confirm(`Supprimer le texte « ${text.name} » pour tous les participants ?`)) return;
    withOp((doc) => doc.removeText(text.id));
    setCur(null);
  };
  const run = () => {
    if (!text) return;
    flush(value);
    const r = runScript(value);
    setOutput({ ok: r.ok, lines: r.out.length ? r.out : [r.ok ? 'Script exécuté.' : 'Échec.'] });
    logInfo(r.ok ? 'console' : 'error', `Script « ${text.name} » : ${r.ok ? 'exécuté' : `arrêt ligne ${r.line}`}`);
    if (!r.ok) toast(`Script « ${text.name} » : erreur ligne ${r.line}`, 'error');
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.altKey && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault();
      run();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const el = e.currentTarget;
      const s = el.selectionStart;
      const next = `${value.slice(0, s)}    ${value.slice(el.selectionEnd)}`;
      edit(next);
      requestAnimationFrame(() => el.setSelectionRange(s + 4, s + 4));
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      flush(value);
    }
  };

  return (
    <EditorShell className="cf-texted">
      <EditorHeader title="Éditeur de texte" icon={FileText}>
        <Select value={text?.id ?? ''} placeholder="Aucun texte" options={texts.map((t) => ({ value: t.id, label: t.name }))} onChange={setCur} tip="Texte affiché" />
        <IconButton icon={Plus} tip="Nouveau texte" onClick={create} />
        {text && (
          <>
            <div className="cf-texted-name">
              <TextField
                value={text.name}
                maxLength={63}
                onCommit={(v) => {
                  const name = v.trim();
                  if (name && name !== text.name) withOp((doc) => doc.updateText(text.id, { name }));
                }}
              />
            </div>
            <IconButton icon={Trash2} tip="Supprimer ce texte" onClick={remove} />
          </>
        )}
        <div className="cf-spacer" />
        {text && (
          <button type="button" className="cf-btn" onClick={run} data-tip="Exécuter le script (Alt+P)">
            <Play size={12} /> Exécuter
          </button>
        )}
      </EditorHeader>
      {!text ? (
        <div className="cf-ed-empty">
          <button type="button" className="cf-btn" onClick={create}>
            <Plus size={13} /> Nouveau texte
          </button>
          <span>Les textes sont enregistrés dans la scène et partagés avec les collaborateurs.</span>
        </div>
      ) : (
        <div className="cf-texted-main">
          <div className="cf-texted-wrap">
            <div ref={gutterRef} className="cf-texted-gutter" aria-hidden>
              {Array.from({ length: lineCount }, (_, i) => (
                <div key={i}>{i + 1}</div>
              ))}
            </div>
            <textarea
              ref={areaRef}
              className="cf-texted-area"
              value={value}
              spellCheck={false}
              wrap="off"
              onChange={(e) => edit(e.target.value)}
              onBlur={() => flush()}
              onKeyDown={onKey}
              onScroll={(e) => {
                if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
              }}
            />
          </div>
          {output && (
            <div className={`cf-texted-out${output.ok ? '' : ' is-error'}`}>
              {output.lines.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
              <button type="button" className="cf-texted-out-close" onClick={() => setOutput(null)} aria-label="Fermer">
                ×
              </button>
            </div>
          )}
        </div>
      )}
    </EditorShell>
  );
}
