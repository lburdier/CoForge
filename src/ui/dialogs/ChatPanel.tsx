import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquare, Send, X } from 'lucide-react';
import { getApp } from '../../app/context';
import { useDoc } from '../../app/hooks';
import { useApp } from '../../app/store';
import { markChatRead } from '../lib/chatRead';
import { contrastColor, initialOf } from '../lib/util';
import { closeDialog } from './Dialog';

function formatTime(t: number): string {
  const d = new Date(t);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return hm;
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${hm}`;
}

/**
 * Discussion de la session : panneau flottant non bloquant (on peut continuer
 * à travailler dans le viewport). Les messages vivent dans le document partagé.
 */
export function ChatPanel() {
  const messages = useDoc((doc) => doc.getChat(), ['chat']);
  const user = useApp((s) => s.user);
  const online = useApp((s) => s.session.status === 'connected');
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stick = useRef(true);

  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Défilement automatique vers le dernier message, sauf si l'utilisateur relit l'historique.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    const last = messages[messages.length - 1];
    if (last) markChatRead(last.time);
  }, [messages]);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    const u = user;
    getApp().doc.postChat({ userId: u.id, userName: u.name, color: u.color, text: t.slice(0, 2000) });
    setText('');
    stick.current = true;
  };

  return createPortal(
    <div className="cf-chat" role="dialog" aria-label="Discussion" onKeyDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      <header className="cf-dialog-header">
        <MessageSquare size={14} />
        <span className="cf-dialog-title">Discussion</span>
        <span className={`cf-chat-state${online ? ' is-online' : ''}`}>{online ? 'en session' : 'hors ligne'}</span>
        <button type="button" tabIndex={-1} className="cf-dialog-close" aria-label="Fermer" onClick={closeDialog}>
          <X size={14} />
        </button>
      </header>
      <div
        ref={listRef}
        className="cf-chat-list"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {messages.length === 0 && (
          <div className="cf-chat-empty">
            {online ? 'Aucun message pour l’instant. Dites bonjour !' : 'Les messages sont enregistrés avec la scène et partagés en session.'}
          </div>
        )}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const grouped = !!prev && prev.userId === m.userId && m.time - prev.time < 120000;
          const mine = m.userId === user.id;
          return (
            <div key={m.id} className={`cf-chat-msg${grouped ? ' is-grouped' : ''}${mine ? ' is-mine' : ''}`}>
              {!grouped && (
                <div className="cf-chat-meta">
                  <span className="cf-chat-avatar" style={{ background: m.color, color: contrastColor(m.color) }}>
                    {initialOf(m.userName)}
                  </span>
                  <span className="cf-chat-name" style={{ color: m.color }}>
                    {m.userName}
                  </span>
                  <span className="cf-chat-time">{formatTime(m.time)}</span>
                </div>
              )}
              <div className="cf-chat-text">{m.text}</div>
            </div>
          );
        })}
      </div>
      <div className="cf-chat-input">
        <input
          ref={inputRef}
          className="cf-text"
          value={text}
          placeholder="Écrire un message…"
          maxLength={2000}
          spellCheck
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              send();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              closeDialog();
            }
          }}
        />
        <button type="button" className="cf-btn is-accent" disabled={!text.trim()} data-tip="Envoyer (Entrée)" onClick={send}>
          <Send size={13} />
        </button>
      </div>
    </div>,
    document.body,
  );
}
