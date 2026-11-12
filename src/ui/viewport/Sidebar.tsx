import { useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Matrix4, Vector3 } from 'three';
import { getApp } from '../../app/context';
import { useDoc } from '../../app/hooks';
import { store, useApp, type EditSelection } from '../../app/store';
import { edgeVerts, type MeshData, type Vec3 } from '../../core/doc/schema';
import { worldMatrix } from '../../core/doc/transforms';
import type { Peer } from '../../net/api';
import { TransformFields } from '../properties/TransformFields';
import { runOp } from '../lib/ops';
import { renameObject, tidy, usePersistent } from '../lib/util';
import { Avatar, Checkbox, Hint, Panel, Row, Select, TextField, type SelectOption } from '../widgets/basic';
import { NumberField, VectorField } from '../widgets/NumberField';

type SidebarTab = 'item' | 'view' | 'session';

const TABS: { id: SidebarTab; label: string }[] = [
  { id: 'item', label: 'Élément' },
  { id: 'view', label: 'Vue' },
  { id: 'session', label: 'Session' },
];

// ------------------------------------------------------------------ onglet Élément

/** Sommets concernés par la sélection d'édition (sommets + extrémités d'arêtes + sommets de faces). */
function selectedVertIds(mesh: MeshData, sel: EditSelection): string[] {
  const out = new Set<string>();
  for (const v of sel.verts) if (mesh.verts.has(v)) out.add(v);
  for (const k of sel.edges) {
    const [a, b] = edgeVerts(k);
    if (mesh.verts.has(a) && mesh.verts.has(b)) {
      out.add(a);
      out.add(b);
    }
  }
  for (const f of sel.faces) {
    const loop = mesh.faces.get(f);
    if (loop) for (const v of loop) if (mesh.verts.has(v)) out.add(v);
  }
  return [...out];
}

const SPACE_OPTIONS: SelectOption<'local' | 'global'>[] = [
  { value: 'local', label: 'Locale' },
  { value: 'global', label: 'Globale' },
];

/** Médiane (moyenne) des sommets sélectionnés, éditable : déplace tous les sommets de la sélection. */
function MedianFields({ objectId }: { objectId: string }) {
  const sel = useApp((s) => s.editSelection);
  const [space, setSpace] = usePersistent<'local' | 'global'>('sidebar.medianSpace', 'local');
  const info = useDoc(
    (doc) => {
      const obj = doc.getObject(objectId);
      const mesh = obj?.data ? doc.getMesh(obj.data) : null;
      if (!obj || !mesh || !obj.data) return null;
      const ids = selectedVertIds(mesh, sel);
      if (!ids.length) return { meshId: obj.data, ids, median: null as Vec3 | null, world: null as Matrix4 | null };
      const m: Vec3 = [0, 0, 0];
      for (const id of ids) {
        const p = mesh.verts.get(id)!;
        m[0] += p[0];
        m[1] += p[1];
        m[2] += p[2];
      }
      const median: Vec3 = [m[0] / ids.length, m[1] / ids.length, m[2] / ids.length];
      return { meshId: obj.data, ids, median, world: worldMatrix(doc, objectId) };
    },
    ['mesh', 'objects'],
    [objectId, sel],
  );

  if (!info) return null;
  if (!info.median || !info.world) return <Hint>Aucun élément sélectionné.</Hint>;

  const shown: Vec3 =
    space === 'global'
      ? (new Vector3(...info.median).applyMatrix4(info.world).toArray() as Vec3)
      : info.median;
  const display: Vec3 = [tidy(shown[0]), tidy(shown[1]), tidy(shown[2])];

  const apply = (next: Vec3) => {
    // Relecture à la source : pendant un glissement, plusieurs valeurs peuvent arriver entre deux rendus.
    const doc = getApp().doc;
    const obj = doc.getObject(objectId);
    const mesh = obj?.data ? doc.getMesh(obj.data) : null;
    if (!obj?.data || !mesh) return;
    const ids = selectedVertIds(mesh, store.getState().editSelection);
    if (!ids.length) return;
    const cur = new Vector3();
    for (const id of ids) cur.add(new Vector3(...mesh.verts.get(id)!));
    cur.divideScalar(ids.length);
    const world = worldMatrix(doc, objectId);
    if (space === 'global' && Math.abs(world.determinant()) < 1e-12) return;
    // Seules les composantes réellement modifiées sont reprises (les autres restent exactes).
    const shownNow = space === 'global' ? cur.clone().applyMatrix4(world) : cur.clone();
    const target = shownNow.toArray() as Vec3;
    for (let i = 0; i < 3; i++) if (next[i] !== display[i]) target[i] = next[i];
    const local = new Vector3(...target);
    if (space === 'global') local.applyMatrix4(world.invert());
    const d = local.sub(cur);
    if (d.lengthSq() === 0) return;
    const moved = new Map<string, Vec3>();
    for (const id of ids) {
      const p = mesh.verts.get(id)!;
      moved.set(id, [p[0] + d.x, p[1] + d.y, p[2] + d.z]);
    }
    doc.setMeshVerts(obj.data, moved);
  };

  return (
    <>
      <div className="cf-group-label">{info.ids.length === 1 ? 'Sommet' : `Médiane (${info.ids.length} sommets)`}</div>
      <VectorField value={display} unit="m" step={0.01} onChange={apply} />
      <Row label="Espace">
        <Select<'local' | 'global'> value={space} options={SPACE_OPTIONS} onChange={(v) => setSpace(v)} />
      </Row>
    </>
  );
}

function ItemTab() {
  const activeId = useApp((s) => s.activeId);
  const mode = useApp((s) => s.mode);
  const name = useDoc((doc) => (activeId ? (doc.getObject(activeId)?.name ?? null) : null), ['objects'], [activeId]);
  if (!activeId || name === null) return <Hint>Aucun objet actif.</Hint>;
  return (
    <>
      <Panel id="sidebar.item.name" title="Objet">
        <Row label="Nom">
          <TextField value={name} onCommit={(t) => renameObject(activeId, t)} />
        </Row>
      </Panel>
      {mode === 'edit' ? (
        <Panel id="sidebar.item.median" title="Transformation">
          <MedianFields objectId={activeId} />
        </Panel>
      ) : (
        <Panel id="sidebar.item.transform" title="Transformation">
          <TransformFields id={activeId} />
        </Panel>
      )}
    </>
  );
}

// ------------------------------------------------------------------ onglet Vue

/** Capteur de 36 mm de large, comme la caméra par défaut de Blender. */
const SENSOR = 36;

function fovToFocal(fovV: number, aspect: number): number {
  const fovH = 2 * Math.atan(Math.tan((fovV * Math.PI) / 360) * Math.max(aspect, 1e-3));
  return SENSOR / 2 / Math.tan(fovH / 2);
}

function focalToFov(focal: number, aspect: number): number {
  const fovH = 2 * Math.atan(SENSOR / 2 / focal);
  return (2 * Math.atan(Math.tan(fovH / 2) / Math.max(aspect, 1e-3)) * 180) / Math.PI;
}

/** Caméra du viewport, relue régulièrement (elle n'est pas dans le store). */
function useViewState() {
  const [view, setView] = useState(() => getApp().viewport.getViewState());
  useEffect(() => {
    const t = setInterval(() => {
      const v = getApp().viewport.getViewState();
      setView((prev) => (prev.fov === v.fov && prev.aspect === v.aspect && prev.ortho === v.ortho ? prev : v));
    }, 300);
    return () => clearInterval(t);
  }, []);
  return [view, setView] as const;
}

function ViewTab() {
  const cursor = useApp((s) => s.cursor3d);
  const cameraView = useApp((s) => s.cameraView);
  const ortho = useApp((s) => s.orthographic);
  const [view, setView] = useViewState();
  const focal = fovToFocal(view.fov, view.aspect);
  return (
    <>
      <Panel id="sidebar.view.view" title="Vue">
        <Row label="Focale">
          <NumberField
            value={focal}
            min={1}
            max={5000}
            step={0.5}
            precision={1}
            unit="mm"
            undoGroup={false}
            disabled={cameraView || ortho}
            onChange={(f) => {
              const vp = getApp().viewport;
              const cur = vp.getViewState();
              const next = { ...cur, fov: focalToFov(f, cur.aspect) };
              vp.setViewState(next, false);
              setView(next);
            }}
          />
        </Row>
        <Checkbox
          label="Orthographique"
          checked={ortho}
          onChange={(v) => runOp('view.toggle_ortho', {}, () => store.setState({ orthographic: v }))}
        />
        <Checkbox label="Vue caméra" checked={cameraView} onChange={(v) => runOp('view.camera', {}, () => store.setState({ cameraView: v }))} />
      </Panel>
      <Panel id="sidebar.view.cursor" title="Curseur 3D">
        <VectorField value={cursor} unit="m" step={0.01} undoGroup={false} onChange={(cursor3d) => store.setState({ cursor3d })} />
        <div className="cf-btn-row">
          <button type="button" className="cf-btn" onClick={() => store.setState({ cursor3d: [0, 0, 0] })}>
            Réinitialiser
          </button>
          <button type="button" className="cf-btn" onClick={() => runOp('view.snap_cursor', { to: 'selected' })}>
            Vers la sélection
          </button>
        </div>
      </Panel>
    </>
  );
}

// ------------------------------------------------------------------ onglet Session

const MODE_LABELS = { object: 'mode objet', edit: 'mode édition' } as const;

/** Présence détaillée des pairs, rafraîchie au plus 4 fois par seconde. */
function usePeerDetails(): Map<number, Peer> {
  const [peers, setPeers] = useState<Map<number, Peer>>(() => new Map(getApp().collab.getPeers().map((p) => [p.clientId, p])));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = getApp().collab.onPeers(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        setPeers(new Map(getApp().collab.getPeers().map((p) => [p.clientId, p])));
      }, 250);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, []);
  return peers;
}

function PeerRow({ clientId, name, color, detail }: { clientId: number; name: string; color: string; detail: Peer | undefined }) {
  const following = useApp((s) => s.followClientId === clientId);
  const activeName = useDoc(
    (doc) => (detail?.state.activeId ? (doc.getObject(detail.state.activeId)?.name ?? null) : null),
    ['objects'],
    [detail?.state.activeId],
  );
  const st = detail?.state;
  const sub = st ? `${MODE_LABELS[st.mode] ?? st.mode}${activeName ? ` - ${activeName}` : ''}${st.selection.length > 1 ? ` (+${st.selection.length - 1})` : ''}` : '';
  return (
    <div className={`cf-peer-row${following ? ' is-following' : ''}`}>
      <Avatar name={name} color={color} size={18} />
      <div className="cf-peer-text">
        <div className="cf-peer-name">{name}</div>
        {sub && <div className="cf-peer-sub">{sub}</div>}
      </div>
      <button
        type="button"
        tabIndex={-1}
        className={`cf-btn is-small${following ? ' is-active' : ''}`}
        disabled={!st?.camera && !following}
        data-tip={following ? 'Arrêter de suivre' : 'Suivre sa vue'}
        onClick={() => store.setState({ followClientId: following ? null : clientId })}
      >
        {following ? <EyeOff size={12} /> : <Eye size={12} />}
        {following ? 'Suivi' : 'Suivre'}
      </button>
    </div>
  );
}

function SessionTab() {
  const status = useApp((s) => s.session.status);
  const room = useApp((s) => s.session.room);
  const peers = useApp((s) => s.session.peers);
  const user = useApp((s) => s.user);
  const details = usePeerDetails();
  if (status === 'offline') {
    return (
      <>
        <Hint>Vous travaillez hors ligne.</Hint>
        <div className="cf-btn-row">
          <button type="button" className="cf-btn is-accent" onClick={() => store.setState({ dialog: 'host' })}>
            Héberger…
          </button>
          <button type="button" className="cf-btn" onClick={() => store.setState({ dialog: 'join' })}>
            Rejoindre…
          </button>
        </div>
      </>
    );
  }
  return (
    <Panel id="sidebar.session.peers" title={`Session « ${room ?? '-'} »`}>
      <div className="cf-peer-row is-self">
        <Avatar name={user.name} color={user.color} size={18} />
        <div className="cf-peer-text">
          <div className="cf-peer-name">{user.name} (vous)</div>
        </div>
      </div>
      {peers.length === 0 && <Hint>Personne d'autre n'est connecté pour l'instant.</Hint>}
      {peers.map((p) => (
        <PeerRow key={p.clientId} clientId={p.clientId} name={p.name} color={p.color} detail={details.get(p.clientId)} />
      ))}
    </Panel>
  );
}

// ------------------------------------------------------------------ panneau

/** Panneau latéral (N) superposé à droite du viewport, onglets verticaux sur le bord. */
export function Sidebar() {
  const show = useApp((s) => s.showSidebar);
  const [tab, setTab] = usePersistent<SidebarTab>('sidebar.tab', 'item');
  const [width, setWidth] = usePersistent('sidebar.width', 250);
  const current = TABS.some((t) => t.id === tab) ? tab : 'item';
  const body = useMemo(() => {
    switch (current) {
      case 'view':
        return <ViewTab />;
      case 'session':
        return <SessionTab />;
      default:
        return <ItemTab />;
    }
  }, [current]);
  if (!show) return null;
  return (
    <div className="cf-sidebar" style={{ width }} onContextMenu={(e) => e.preventDefault()}>
      <div
        className="cf-sidebar-resize"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const startX = e.clientX;
          const startW = width;
          const el = e.currentTarget;
          el.setPointerCapture(e.pointerId);
          const move = (ev: PointerEvent) => setWidth(Math.max(180, Math.min(520, startW - (ev.clientX - startX))));
          const up = () => {
            el.removeEventListener('pointermove', move);
            el.removeEventListener('pointerup', up);
            el.removeEventListener('lostpointercapture', up);
          };
          el.addEventListener('pointermove', move);
          el.addEventListener('pointerup', up);
          el.addEventListener('lostpointercapture', up);
          e.preventDefault();
        }}
      />
      <div className="cf-sidebar-body">{body}</div>
      <div className="cf-sidebar-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            tabIndex={-1}
            aria-selected={current === t.id}
            className={`cf-sidebar-tab${current === t.id ? ' is-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}
