import { useMemo, useState, type FormEvent } from 'react';
import { Anvil, Info, Keyboard, Pencil, Search, Settings } from 'lucide-react';
import { useDoc } from '../../app/hooks';
import { platform } from '../../app/platform';
import { setUser, store, useApp } from '../../app/store';
import { shortcutTable } from '../lib/menus';
import { normalizeText, renameObject } from '../lib/util';
import { ColorField, Hint, TextField } from '../widgets/basic';
import { NumberField } from '../widgets/NumberField';
import { Dialog, FormRow, closeDialog } from './Dialog';

// ------------------------------------------------------------------ renommer (F2)

export function RenameDialog() {
  const activeId = useApp((s) => s.activeId);
  const current = useDoc((doc) => (activeId ? (doc.getObject(activeId)?.name ?? null) : null), ['objects'], [activeId]);
  const [name, setName] = useState(current ?? '');

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (activeId && current !== null) renameObject(activeId, name);
    closeDialog();
  };

  return (
    <Dialog
      title="Renommer l'objet actif"
      icon={Pencil}
      width={340}
      footer={
        <>
          <div className="cf-spacer" />
          <button type="button" className="cf-btn" onClick={closeDialog}>
            Annuler
          </button>
          <button type="button" className="cf-btn is-accent" disabled={current === null || !name.trim()} onClick={() => submit()}>
            Renommer
          </button>
        </>
      }
    >
      {current === null ? (
        <Hint>Aucun objet actif (il a peut-être été supprimé par un autre utilisateur).</Hint>
      ) : (
        <form className="cf-form" onSubmit={submit}>
          <input
            className="cf-text cf-rename-input"
            value={name}
            maxLength={63}
            spellCheck={false}
            data-autofocus=""
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" hidden />
        </form>
      )}
    </Dialog>
  );
}

// ------------------------------------------------------------------ raccourcis clavier

export function ShortcutsDialog() {
  const groups = useMemo(() => shortcutTable(), []);
  const [filter, setFilter] = useState('');
  const tokens = normalizeText(filter).split(/\s+/).filter(Boolean);
  const shown = groups
    .map((g) => ({
      group: g.group,
      rows: tokens.length ? g.rows.filter((r) => tokens.every((t) => normalizeText(`${r.label} ${r.shortcut} ${r.path}`).includes(t))) : g.rows,
    }))
    .filter((g) => g.rows.length > 0);
  return (
    <Dialog title="Raccourcis clavier" icon={Keyboard} width={560} className="cf-shortcuts">
      <div className="cf-search-field is-inline">
        <Search size={13} />
        <input value={filter} placeholder="Filtrer les raccourcis…" spellCheck={false} data-autofocus="" onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="cf-shortcuts-scroll">
        {shown.length === 0 && <Hint>Aucun raccourci ne correspond.</Hint>}
        {shown.map((g) => (
          <section key={g.group} className="cf-shortcuts-group">
            <div className="cf-group-label">{g.group}</div>
            <table className="cf-table">
              <tbody>
                {g.rows.map((r) => (
                  <tr key={`${r.label}|${r.shortcut}`}>
                    <td className="cf-table-key">
                      {r.shortcut.split(' / ').map((k, i) => (
                        <kbd key={i}>{k}</kbd>
                      ))}
                    </td>
                    <td>{r.label}</td>
                    <td className="cf-dim">{r.path}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ préférences

export function PreferencesDialog() {
  const user = useApp((s) => s.user);
  const snapIncrement = useApp((s) => s.snapIncrement);
  return (
    <Dialog
      title="Préférences"
      icon={Settings}
      width={400}
      footer={
        <>
          <div className="cf-spacer" />
          <button type="button" className="cf-btn is-accent" onClick={closeDialog}>
            Fermer
          </button>
        </>
      }
    >
      <div className="cf-form">
        <div className="cf-group-label">Identité (visible par les collaborateurs)</div>
        <FormRow label="Nom">
          <TextField value={user.name} maxLength={40} autoFocus onCommit={(t) => t.trim() && setUser({ name: t.trim() })} />
        </FormRow>
        <FormRow label="Couleur">
          <ColorField value={user.color} onChange={(color) => setUser({ color })} />
        </FormRow>
        <div className="cf-form-sep" />
        <div className="cf-group-label">Édition</div>
        <FormRow label="Pas d'aimantation">
          <NumberField
            value={snapIncrement}
            min={0.001}
            max={100}
            step={0.005}
            precision={3}
            unit="m"
            undoGroup={false}
            onChange={(v) => store.setState({ snapIncrement: v })}
          />
        </FormRow>
        <Hint>Les préférences d'identité sont mémorisées sur cet ordinateur.</Hint>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ à propos

export function AboutDialog() {
  return (
    <Dialog
      title="À propos de CoForge"
      icon={Info}
      width={380}
      footer={
        <>
          <div className="cf-spacer" />
          <button type="button" className="cf-btn is-accent" onClick={closeDialog} data-autofocus="">
            Fermer
          </button>
        </>
      }
    >
      <div className="cf-about">
        <div className="cf-about-logo">
          <Anvil size={34} />
        </div>
        <div className="cf-about-name">CoForge</div>
        <div className="cf-dim">Version {platform.version}</div>
        <p className="cf-dialog-text">
          Modélisation 3D collaborative en temps réel : blocking, hard surface, éclairage et rendu, à plusieurs sur la même scène.
        </p>
        <p className="cf-dim cf-about-tech">Three.js · Yjs (CRDT) · React · Electron</p>
      </div>
    </Dialog>
  );
}
