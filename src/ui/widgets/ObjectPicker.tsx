import { useEffect, useRef, useState } from 'react';
import { Pipette, X } from 'lucide-react';
import { getApp } from '../../app/context';
import { useDoc } from '../../app/hooks';
import { toast } from '../../app/store';
import type { ObjectData, ObjectType } from '../../core/doc/schema';
import { objectIcon } from '../lib/icons';
import { IconButton, Select, type SelectOption } from './basic';

const NONE = '__none__';

export interface ObjectPickerProps {
  /** Identifiant de l'objet choisi, ou null. */
  value: string | null;
  onChange(id: string | null): void;
  /** Types d'objets acceptés (tous par défaut). */
  types?: ObjectType[];
  /** Objets à exclure (en général l'objet qui porte le réglage). */
  exclude?: string | string[];
  /** Filtre supplémentaire. */
  filter?(obj: ObjectData): boolean;
  /** Texte affiché quand rien n'est choisi. */
  placeholder?: string;
  disabled?: boolean;
  tip?: string;
  /** Masque le bouton « effacer ». */
  noClear?: boolean;
}

/**
 * Pipette : attend un clic gauche dans le viewport 3D et renvoie l'objet situé sous le pointeur
 * (`null` : clic dans le vide). Le clic est intercepté en phase de capture : les outils et la
 * sélection ne le reçoivent pas. Les autres boutons (orbite, pan, zoom) restent utilisables.
 * Échap, ou un clic hors du viewport, annule. Renvoie la fonction d'annulation.
 */
export function pickObjectInViewport(onPick: (id: string | null) => void, onCancel?: () => void): () => void {
  const dom: HTMLCanvasElement | undefined = getApp().viewport?.dom;
  if (!dom) {
    onCancel?.();
    return () => undefined;
  }
  const previousCursor = dom.style.cursor;
  dom.style.cursor = 'crosshair';
  let done = false;
  const finish = () => {
    if (done) return false;
    done = true;
    dom.style.cursor = previousCursor;
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
    return true;
  };
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as Node | null;
    if (!target || !(target === dom || dom.contains(target))) {
      // Clic ailleurs dans l'interface : la pipette est abandonnée, le clic suit son cours.
      if (finish()) onCancel?.();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const r = dom.getBoundingClientRect();
    let id: string | null = null;
    try {
      id = getApp().viewport.pickObject(e.clientX - r.left, e.clientY - r.top);
    } catch (err) {
      console.error('[ui] pipette : échec du picking', err);
    }
    if (finish()) onPick(id);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (finish()) onCancel?.();
  };
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('keydown', onKey, true);
  return () => {
    if (finish()) onCancel?.();
  };
}

/**
 * Sélecteur d'objet à la Blender : liste déroulante des objets acceptés, pipette pour désigner
 * l'objet d'un clic dans le viewport, croix pour effacer. Tolère une valeur qui ne correspond
 * plus à aucun objet (supprimé par un autre utilisateur) : le champ apparaît alors vide.
 */
export function ObjectPicker({ value, onChange, types, exclude, filter, placeholder = '(aucun)', disabled, tip, noClear }: ObjectPickerProps) {
  const [picking, setPicking] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);
  const excluded = Array.isArray(exclude) ? exclude : exclude ? [exclude] : [];
  const excludeKey = excluded.join(',');
  const typesKey = types ? types.join(',') : '';

  const accepts = (o: ObjectData): boolean => !excluded.includes(o.id) && (!types || types.includes(o.type)) && (!filter || filter(o));
  const acceptsRef = useRef(accepts);
  acceptsRef.current = accepts;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const options = useDoc(
    (doc) => {
      const opts: SelectOption<string>[] = doc
        .listObjects()
        .filter(accepts)
        .map((o) => ({ value: o.id, label: o.name, icon: objectIcon(o.type) }))
        .sort((a, b) => a.label.localeCompare(b.label, 'fr', { numeric: true }));
      return [{ value: NONE, label: placeholder }, ...opts];
    },
    ['objects'],
    [excludeKey, typesKey, filter, placeholder],
  );

  // La pipette est abandonnée si le champ disparaît.
  useEffect(
    () => () => {
      cancelRef.current?.();
      cancelRef.current = null;
    },
    [],
  );

  const valid = !!value && options.some((o) => o.value === value);

  const togglePick = () => {
    if (picking) {
      cancelRef.current?.();
      return;
    }
    setPicking(true);
    toast('Pipette : cliquez un objet dans le viewport (Échap pour annuler)');
    cancelRef.current = pickObjectInViewport(
      (id) => {
        cancelRef.current = null;
        setPicking(false);
        const obj = id ? getApp().doc.getObject(id) : null;
        if (!obj) {
          toast('Pipette : aucun objet sous le pointeur', 'error');
          return;
        }
        if (!acceptsRef.current(obj)) {
          toast(`Pipette : « ${obj.name} » ne convient pas pour ce champ`, 'error');
          return;
        }
        onChangeRef.current(obj.id);
      },
      () => {
        cancelRef.current = null;
        setPicking(false);
      },
    );
  };

  return (
    <div className={`cf-objpick${picking ? ' is-picking' : ''}`}>
      <Select
        value={valid ? value! : NONE}
        options={options}
        disabled={disabled}
        tip={tip}
        placeholder={placeholder}
        onChange={(v) => onChange(v === NONE ? null : v)}
      />
      <IconButton
        icon={Pipette}
        size={12}
        active={picking}
        disabled={disabled}
        tip={picking ? 'Annuler la pipette (Échap)' : 'Pipette : désigner l’objet d’un clic dans le viewport'}
        onClick={togglePick}
      />
      {!noClear && <IconButton icon={X} size={12} disabled={disabled || !value} tip="Effacer" onClick={() => onChange(null)} />}
    </div>
  );
}
