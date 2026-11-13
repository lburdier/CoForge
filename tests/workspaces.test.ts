import { describe, expect, it } from 'vitest';
import {
  TABS_STORAGE_KEY,
  WORKSPACES,
  addTabFromPreset,
  cycleTab,
  defaultTabsState,
  duplicateTab,
  loadTabsState,
  moveTab,
  moveTabBy,
  parseTabsState,
  presetView,
  removeTab,
  renameTab,
  resetTab,
  saveTabsState,
  setTabLayout,
  setTabView,
  uniqueTabName,
  type TabsStorage,
  type WorkspaceTabsState,
} from '../src/ui/lib/workspaces';

/** Stockage en mémoire (substitut de localStorage). */
function memoryStorage(init: Record<string, string> = {}): TabsStorage & { data: Record<string, string> } {
  const data = { ...init };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

const names = (st: WorkspaceTabsState) => st.tabs.map((t) => t.name);

describe('onglets d’espaces de travail', () => {
  it('onglets par défaut : un par modèle, le premier actif', () => {
    const st = defaultTabsState();
    expect(st.tabs.map((t) => t.id)).toEqual(WORKSPACES.map((w) => w.id));
    expect(names(st)).toEqual(WORKSPACES.map((w) => w.label));
    expect(st.active).toBe('layout');
  });

  it('noms uniques façon Blender : .001, .002…', () => {
    expect(uniqueTabName('Shading', ['Disposition'])).toBe('Shading');
    expect(uniqueTabName('Shading', ['Shading'])).toBe('Shading.001');
    expect(uniqueTabName('Shading', ['Shading', 'Shading.001'])).toBe('Shading.002');
    expect(uniqueTabName('Shading.001', ['Shading', 'Shading.001'])).toBe('Shading.002');
    expect(uniqueTabName('   ', [])).toBe('Espace de travail');
  });

  it('ajout depuis un modèle : suffixe unique, inséré après l’onglet visé, activé', () => {
    let st = defaultTabsState();
    st = addTabFromPreset(st, 'modeling', 'layout');
    expect(st.tabs[1].name).toBe('Modélisation.001');
    expect(st.tabs[1].preset).toBe('modeling');
    expect(st.active).toBe(st.tabs[1].id);
    const first = st.tabs[1].id;
    st = addTabFromPreset(st, 'modeling', first);
    expect(st.tabs[2].name).toBe('Modélisation.002');
    expect(new Set(st.tabs.map((t) => t.id)).size).toBe(st.tabs.length);
    // Disposition et réglages d'origine du modèle.
    const shading = addTabFromPreset(st, 'shading');
    const tab = shading.tabs.find((t) => t.id === shading.active)!;
    expect(tab.view.bottomEditor).toBe('shader_nodes');
    expect(tab.view.shading).toBe('material');
    // Modèle inconnu : rien ne change.
    expect(addTabFromPreset(st, 'inexistant')).toBe(st);
  });

  it('duplication : copie de la disposition courante et des réglages, nom suffixé', () => {
    let st = defaultTabsState();
    st = setTabLayout(st, 'shading', { rightW: 500, outlinerH: 111, bottomH: 222 });
    st = setTabView(st, 'shading', { shading: 'rendered', showToolbar: false, bottomEditor: null, propertiesTab: 'world' });
    const dup = duplicateTab(st, 'shading');
    const i = dup.tabs.findIndex((t) => t.id === 'shading');
    const copy = dup.tabs[i + 1];
    expect(copy.name).toBe('Shading.001');
    expect(copy.id).not.toBe('shading');
    expect(copy.layout).toEqual({ rightW: 500, outlinerH: 111, bottomH: 222 });
    expect(copy.view).toEqual({ shading: 'rendered', showToolbar: false, bottomEditor: null, propertiesTab: 'world' });
    expect(dup.active).toBe(copy.id);
    // La copie est indépendante de l'original.
    expect(copy.layout).not.toBe(dup.tabs[i].layout);
  });

  it('renommage : nom vide refusé, nom pris suffixé, longueur bornée', () => {
    const st = defaultTabsState();
    expect(renameTab(st, 'layout', '   ')).toBe(st);
    expect(renameTab(st, 'inconnu', 'X')).toBe(st);
    const a = renameTab(st, 'layout', '  Mon espace ');
    expect(a.tabs[0].name).toBe('Mon espace');
    const b = renameTab(a, 'modeling', 'Mon espace');
    expect(b.tabs[1].name).toBe('Mon espace.001');
    const c = renameTab(st, 'layout', 'x'.repeat(200));
    expect(c.tabs[0].name.length).toBe(64);
  });

  it('suppression : refusée pour le dernier onglet, voisin activé', () => {
    let st = defaultTabsState();
    st = { ...st, active: 'modeling' };
    const a = removeTab(st, 'modeling');
    expect(a.tabs.some((t) => t.id === 'modeling')).toBe(false);
    expect(a.active).toBe('shading'); // voisin de droite
    const last = { ...st, active: st.tabs[st.tabs.length - 1].id };
    const b = removeTab(last, last.active);
    expect(b.active).toBe(st.tabs[st.tabs.length - 2].id); // pas de voisin à droite : celui de gauche
    const c = removeTab(st, 'shading');
    expect(c.active).toBe('modeling'); // onglet inactif supprimé : l'actif ne change pas
    let one: WorkspaceTabsState = st;
    while (one.tabs.length > 1) one = removeTab(one, one.tabs[0].id);
    expect(one.tabs.length).toBe(1);
    expect(removeTab(one, one.tabs[0].id)).toBe(one);
  });

  it('réordonnancement : déplacer à gauche / à droite, glisser à une position', () => {
    const st = defaultTabsState();
    const ids = st.tabs.map((t) => t.id);
    expect(moveTabBy(st, 'modeling', -1).tabs.map((t) => t.id).slice(0, 2)).toEqual(['modeling', 'layout']);
    expect(moveTabBy(st, 'layout', -1)).toBe(st); // déjà en tête
    expect(moveTabBy(st, ids[ids.length - 1], 1)).toBe(st); // déjà en queue
    const moved = moveTab(st, 'layout', 3);
    expect(moved.tabs.map((t) => t.id)).toEqual([ids[1], ids[2], ids[3], 'layout', ...ids.slice(4)]);
    expect(moveTab(st, 'layout', 999).tabs.at(-1)!.id).toBe('layout');
    expect(moved.active).toBe(st.active);
  });

  it('réinitialisation : disposition et réglages du modèle rétablis, nom conservé', () => {
    let st = renameTab(defaultTabsState(), 'shading', 'Matières');
    st = setTabLayout(st, 'shading', { rightW: 999, outlinerH: 999 });
    st = setTabView(st, 'shading', { shading: 'wireframe', showToolbar: false, bottomEditor: null });
    const r = resetTab(st, 'shading');
    const tab = r.tabs.find((t) => t.id === 'shading')!;
    const preset = WORKSPACES.find((w) => w.id === 'shading')!;
    expect(tab.name).toBe('Matières');
    expect(tab.layout).toEqual(preset.layout);
    expect(tab.view).toEqual(presetView(preset));
  });

  it('onglet suivant / précédent en boucle (Ctrl+PgSuiv / Ctrl+PgPréc)', () => {
    const st = defaultTabsState();
    expect(cycleTab(st, 1).active).toBe('modeling');
    expect(cycleTab(st, -1).active).toBe(st.tabs[st.tabs.length - 1].id);
  });

  it('persistance : enregistrement puis relecture identique', () => {
    const storage = memoryStorage();
    let st = addTabFromPreset(defaultTabsState(), 'rendering');
    st = setTabLayout(st, st.active, { rightW: 410, outlinerH: 150, bottomH: 260 });
    saveTabsState(st, storage);
    expect(JSON.parse(storage.data[TABS_STORAGE_KEY]).active).toBe(st.active);
    expect(loadTabsState(storage)).toEqual(st);
  });

  it('préférence corrompue : le démarrage se fait avec les onglets par défaut', () => {
    expect(loadTabsState(memoryStorage({ [TABS_STORAGE_KEY]: '{pas du json' }))).toEqual(defaultTabsState());
    expect(loadTabsState(memoryStorage({ [TABS_STORAGE_KEY]: '"texte"' }))).toEqual(defaultTabsState());
    expect(loadTabsState(memoryStorage({ [TABS_STORAGE_KEY]: '{"tabs":[]}' }))).toEqual(defaultTabsState());
    expect(loadTabsState(null)).toEqual(defaultTabsState());
    const throwing: TabsStorage = {
      getItem: () => {
        throw new Error('stockage indisponible');
      },
      setItem: () => {
        throw new Error('stockage indisponible');
      },
    };
    expect(loadTabsState(throwing)).toEqual(defaultTabsState());
    expect(() => saveTabsState(defaultTabsState(), throwing)).not.toThrow();
  });

  it('préférence partiellement corrompue : entrées invalides écartées ou corrigées', () => {
    const parsed = parseTabsState({
      active: 'absent',
      tabs: [
        null,
        42,
        { id: 'a', name: 'A', preset: 'shading', layout: { rightW: 'large', outlinerH: -5, bottomH: 1e999 }, view: { shading: 'plasma', showToolbar: 'oui', bottomEditor: 7, propertiesTab: 'inconnu' } },
        { id: 'a', name: 'doublon', preset: 'layout' },
        { id: 'b', name: 'A', preset: 'preset-disparu', layout: { rightW: 300, outlinerH: 100 }, view: { shading: 'wireframe', showToolbar: false, bottomEditor: null, propertiesTab: 'world' } },
        { name: 'sans identifiant' },
      ],
    })!;
    expect(parsed.tabs.map((t) => t.id)).toEqual(['a', 'b']);
    expect(parsed.active).toBe('a');
    const shading = WORKSPACES.find((w) => w.id === 'shading')!;
    expect(parsed.tabs[0].layout).toEqual(shading.layout);
    expect(parsed.tabs[0].view).toEqual(presetView(shading));
    // Modèle disparu : repli sur le premier modèle ; nom en double : suffixé.
    expect(parsed.tabs[1].preset).toBe(WORKSPACES[0].id);
    expect(parsed.tabs[1].name).toBe('A.001');
    expect(parsed.tabs[1].view).toEqual({ shading: 'wireframe', showToolbar: false, bottomEditor: null, propertiesTab: 'world' });
  });

  it('reprise de l’ancienne préférence des tailles de zones', () => {
    const storage = memoryStorage({ 'coforge.ui.layout': JSON.stringify({ shading: { rightW: 444, outlinerH: 123, bottomH: 321 }, layout: 'abîmé' }) });
    const st = loadTabsState(storage);
    expect(st.tabs.find((t) => t.id === 'shading')!.layout).toEqual({ rightW: 444, outlinerH: 123, bottomH: 321 });
    expect(st.tabs.find((t) => t.id === 'layout')!.layout).toEqual(WORKSPACES[0].layout);
  });
});
