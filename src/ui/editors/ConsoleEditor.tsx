import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Terminal, Trash2 } from 'lucide-react';
import { COMMAND_HELP, executeCommand } from '../lib/consoleCommands';
import { logInfo } from '../lib/infoLog';
import { IconButton } from '../widgets/basic';
import { EditorHeader, EditorShell } from './common';

interface Line {
  id: number;
  kind: 'in' | 'out' | 'err';
  text: string;
}

let lineId = 1;
const WELCOME: Line[] = [{ id: 0, kind: 'out', text: 'Console CoForge : tapez « help » pour la liste des commandes. Tab complète, ↑ / ↓ parcourent l’historique.' }];
/** Contenu conservé d'une zone à l'autre pendant la session (comme la console de Blender). */
let sharedLines: Line[] = WELCOME;
const history: string[] = [];

/**
 * Console (pendant de la console Python de Blender) : commandes CoForge, sans exécution de code
 * arbitraire. Les commandes tapées sont aussi notées dans l'éditeur Info.
 */
export function ConsoleEditor() {
  const [lines, setLines] = useState<Line[]>(sharedLines);
  const [input, setInput] = useState('');
  const [hist, setHist] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    sharedLines = lines;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const submit = () => {
    const cmd = input;
    setInput('');
    setHist(null);
    const trimmed = cmd.trim();
    if (trimmed && history[history.length - 1] !== cmd) {
      history.push(cmd);
      if (history.length > 200) history.shift();
    }
    const r = executeCommand(cmd);
    if (r.clear) {
      setLines([]);
      return;
    }
    // « run » est déjà noté par le registre d'opérateurs.
    if (trimmed && !/^run\s/i.test(trimmed)) logInfo('console', trimmed);
    setLines((ls) =>
      [...ls, { id: lineId++, kind: 'in' as const, text: cmd }, ...r.out.map((t) => ({ id: lineId++, kind: r.ok ? ('out' as const) : ('err' as const), text: t }))].slice(-1000),
    );
  };

  const complete = () => {
    const words = [...new Set(COMMAND_HELP.flatMap(([a]) => a.split(' / ').map((w) => w.split(' ')[0])))];
    const t = input.trimStart().toLowerCase();
    const m = words.filter((w) => w.startsWith(t));
    if (m.length === 1) setInput(`${m[0]} `);
    else if (m.length > 1) setLines((ls) => [...ls, { id: lineId++, kind: 'out', text: m.join('   ') }]);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter') submit();
    else if (e.key === 'Tab') {
      e.preventDefault();
      complete();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (!history.length) return;
      let i = hist ?? history.length;
      i = e.key === 'ArrowUp' ? Math.max(0, i - 1) : Math.min(history.length, i + 1);
      setHist(i);
      setInput(history[i] ?? '');
    }
  };

  return (
    <EditorShell className="cf-console">
      <EditorHeader title="Console" icon={Terminal}>
        <div className="cf-spacer" />
        <IconButton icon={Trash2} tip="Effacer la console" onClick={() => setLines([])} />
      </EditorHeader>
      <div ref={bodyRef} className="cf-ed-body cf-console-body" onClick={() => inputRef.current?.focus()}>
        {lines.map((l) => (
          <div key={l.id} className={`cf-console-line is-${l.kind}`}>
            {l.kind === 'in' && <span className="cf-console-prompt">&gt;&gt;&gt; </span>}
            {l.text}
          </div>
        ))}
        <div className="cf-console-input">
          <span className="cf-console-prompt">&gt;&gt;&gt; </span>
          <input ref={inputRef} value={input} spellCheck={false} onChange={(e) => setInput(e.target.value)} onKeyDown={onKey} aria-label="Commande" />
        </div>
      </div>
    </EditorShell>
  );
}
