import { getApp } from '../../app/context';
import type { WorldSettings } from '../../core/doc/schema';
import { ColorField, Panel, Row, Select, type SelectOption } from '../widgets/basic';
import { NumberField } from '../widgets/NumberField';
import { useDocWhen } from './docHooks';

const MODE_OPTIONS: SelectOption<WorldSettings['mode']>[] = [
  { value: 'color', label: 'Couleur unie' },
  { value: 'sky', label: 'Ciel procédural' },
];

function set(patch: Partial<WorldSettings>): void {
  getApp().doc.updateWorld(patch);
}

/** Onglet « Monde » : fond et éclairage d'environnement. */
export function WorldTab() {
  const w = useDocWhen((doc) => doc.getScene().world, { scene: (e) => e.keys.some((k) => k.startsWith('w:')) });
  return (
    <>
      <Panel id="world.surface" title="Surface">
        <Row label="Mode">
          <Select value={w.mode} options={MODE_OPTIONS} onChange={(mode) => set({ mode })} />
        </Row>
        {w.mode === 'color' && (
          <Row label="Couleur">
            <ColorField value={w.color} onChange={(color) => set({ color })} />
          </Row>
        )}
        <Row label="Intensité">
          <NumberField value={w.strength} min={0} max={1000} step={0.01} onChange={(strength) => set({ strength })} tip="Intensité de l’éclairage d’environnement" />
        </Row>
      </Panel>
      {w.mode === 'sky' && (
        <Panel id="world.sun" title="Soleil">
          <Row label="Élévation">
            <NumberField value={w.sunElevation} min={-90} max={90} step={0.5} precision={1} unit="°" onChange={(sunElevation) => set({ sunElevation })} />
          </Row>
          <Row label="Azimut">
            <NumberField
              value={w.sunAzimuth}
              min={0}
              max={360}
              step={0.5}
              precision={1}
              unit="°"
              onChange={(sunAzimuth) => set({ sunAzimuth })}
              tip="Direction du soleil autour de l’axe vertical Z"
            />
          </Row>
        </Panel>
      )}
    </>
  );
}
