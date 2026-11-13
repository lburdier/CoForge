import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { EditorTypeButton, useArea } from '../layout/editorTypes';
import './editors.css';

/** En-tête commun des éditeurs de zone : bouton « Type d'éditeur », titre, outils. */
export function EditorHeader({ title, icon: Icon, children }: { title: string; icon: LucideIcon; children?: ReactNode }) {
  const area = useArea();
  return (
    <div className="cf-ed-header">
      {area ? <EditorTypeButton /> : <Icon size={14} className="cf-ed-icon" />}
      <span className="cf-ed-title">{title}</span>
      {children}
    </div>
  );
}

export function EditorShell({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={`cf-ed ${className}`}>{children}</div>;
}
