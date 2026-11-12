import { Flashlight, Lightbulb, RectangleHorizontal, Sun, Video } from 'lucide-react';
import { getApp } from '../../app/context';
import { edgeKey, type CameraData, type LightData, type LightKind, type MeshData, type ObjectData } from '../../core/doc/schema';
import { formatCount, RAD2DEG, DEG2RAD, tidy } from '../lib/util';
import { Checkbox, ColorField, Hint, Panel, Row, Select, TextField, type SelectOption } from '../widgets/basic';
import { NumberField, Slider } from '../widgets/NumberField';
import { runOp } from './actions';
import { useDocWhen } from './docHooks';

/** Nombre d'objets qui partagent le bloc de données `dataId` (instances liées). */
function useDataUsers(type: ObjectData['type'], dataId: string | null): number {
  return useDocWhen(
    (doc) => (dataId ? doc.listObjects().filter((o) => o.type === type && o.data === dataId).length : 0),
    { objects: (e) => e.added.length > 0 || e.removed.length > 0 || e.changed.some((c) => c.keys.includes('data') || c.keys.includes('type')) },
    [type, dataId],
  );
}

function UsersHint({ users, what }: { users: number; what: string }) {
  if (users <= 1) return null;
  return (
    <Hint>
      {what} partagé par {users} objets (instances liées) : toute modification les affecte tous.
    </Hint>
  );
}

/** Onglet « Données » : bloc de données de l'objet actif selon son type. */
export function DataTab({ obj }: { obj: ObjectData }) {
  switch (obj.type) {
    case 'light':
      return <LightData obj={obj} />;
    case 'camera':
      return <CameraDataTab obj={obj} />;
    case 'mesh':
      return <MeshDataTab obj={obj} />;
    default:
      return <Hint className="cf-props-empty">Un objet vide n’a pas de données.</Hint>;
  }
}

function MissingData({ what }: { what: string }) {
  return <Hint className="cf-props-warn">{what} de cet objet n’existe plus (supprimé par un autre utilisateur ?).</Hint>;
}

// ------------------------------------------------------------------ lumière

const LIGHT_KINDS: SelectOption<LightKind>[] = [
  { value: 'point', label: 'Ponctuelle', icon: Lightbulb },
  { value: 'sun', label: 'Soleil', icon: Sun },
  { value: 'spot', label: 'Projecteur', icon: Flashlight },
  { value: 'area', label: 'Surfacique', icon: RectangleHorizontal },
];

function LightData({ obj }: { obj: ObjectData }) {
  const id = obj.data;
  const light = useDocWhen(
    (doc) => (id ? doc.getLight(id) : null),
    { data: (e) => e.table === 'lights' && !!id && (e.changed.includes(id) || e.added.includes(id) || e.removed.includes(id)) },
    [id],
  );
  const users = useDataUsers('light', id);
  if (!id || !light) return <MissingData what="La lumière" />;
  const set = (patch: Partial<Omit<LightData, 'id'>>) => getApp().doc.updateLight(id, patch);
  const sun = light.kind === 'sun';
  return (
    <>
      <Panel id="data.light" title="Lumière">
        <Row label="Genre">
          <Select value={light.kind} options={LIGHT_KINDS} onChange={(kind) => set({ kind })} />
        </Row>
        <Row label="Couleur">
          <ColorField value={light.color} onChange={(color) => set({ color })} />
        </Row>
        <Row label={sun ? 'Intensité' : 'Puissance'} tip={sun ? 'Éclairement en W/m², comme dans Blender' : 'Puissance rayonnée en watts, comme dans Blender'}>
          <NumberField
            value={light.power}
            min={0}
            max={sun ? 1000 : 1e7}
            step={sun ? 0.01 : 1}
            precision={sun ? 3 : 1}
            unit={sun ? 'W/m²' : 'W'}
            onChange={(power) => set({ power })}
          />
        </Row>
        {light.kind !== 'area' && (
          <Row label="Rayon" tip="Taille de la source : des ombres plus douces en path tracing">
            <NumberField value={light.radius} min={0} max={100} step={0.001} precision={3} unit="m" onChange={(radius) => set({ radius })} />
          </Row>
        )}
        <Row>
          <Checkbox checked={light.castShadow} onChange={(castShadow) => set({ castShadow })} label="Projeter des ombres" />
        </Row>
        <UsersHint users={users} what="Ces données de lumière sont" />
      </Panel>
      {light.kind === 'spot' && (
        <Panel id="data.spot" title="Forme du projecteur">
          <Row label="Angle" tip="Angle total du cône de lumière">
            <NumberField value={light.spotAngle} min={1} max={180} step={0.5} precision={1} unit="°" onChange={(spotAngle) => set({ spotAngle })} />
          </Row>
          <Row label="Adoucissement" tip="Douceur du bord du cône (0 : net, 1 : très progressif)">
            <Slider value={light.spotBlend} onChange={(spotBlend) => set({ spotBlend })} />
          </Row>
        </Panel>
      )}
      {light.kind === 'area' && (
        <Panel id="data.area" title="Forme de la surface">
          <Row label="Taille X">
            <NumberField value={light.sizeX} min={0.001} max={1000} step={0.01} unit="m" onChange={(sizeX) => set({ sizeX })} />
          </Row>
          <Row label="Y">
            <NumberField value={light.sizeY} min={0.001} max={1000} step={0.01} unit="m" onChange={(sizeY) => set({ sizeY })} />
          </Row>
        </Panel>
      )}
    </>
  );
}

// ------------------------------------------------------------------ caméra

const CAMERA_KINDS: SelectOption<CameraData['kind']>[] = [
  { value: 'persp', label: 'Perspective' },
  { value: 'ortho', label: 'Orthographique' },
];

/** Demi-hauteur du capteur de référence (plein format 24×36 mm), le champ de vision étant vertical. */
const SENSOR_HALF_H = 12;

const fovToFocal = (fov: number) => SENSOR_HALF_H / Math.tan((Math.max(0.01, Math.min(179.9, fov)) * DEG2RAD) / 2);
const focalToFov = (focal: number) => 2 * Math.atan(SENSOR_HALF_H / Math.max(0.01, focal)) * RAD2DEG;

function CameraDataTab({ obj }: { obj: ObjectData }) {
  const id = obj.data;
  const cam = useDocWhen(
    (doc) => (id ? doc.getCamera(id) : null),
    { data: (e) => e.table === 'cameras' && !!id && (e.changed.includes(id) || e.added.includes(id) || e.removed.includes(id)) },
    [id],
  );
  const isActive = useDocWhen((doc) => doc.getScene().activeCamera === obj.id, { scene: (e) => e.keys.includes('activeCamera'), objects: (e) => e.removed.length > 0 }, [obj.id]);
  const users = useDataUsers('camera', id);
  if (!id || !cam) return <MissingData what="La caméra" />;
  const set = (patch: Partial<Omit<CameraData, 'id'>>) => getApp().doc.updateCamera(id, patch);
  const persp = cam.kind === 'persp';
  return (
    <>
      <div className="cf-props-actions">
        <button
          type="button"
          className={`cf-btn${isActive ? ' is-active' : ''}`}
          disabled={isActive}
          data-tip={isActive ? 'Cette caméra est déjà la caméra active de la scène' : 'Le rendu final sera fait depuis cette caméra'}
          data-tip-key="Ctrl+Num 0"
          onClick={() => {
            const objectId = obj.id;
            runOp('object.set_active_camera', {}, (doc) => {
              if (doc.getObject(objectId)) doc.setActiveCamera(objectId);
            });
          }}
        >
          <Video size={14} />
          <span>{isActive ? 'Caméra active' : 'Définir comme caméra active'}</span>
        </button>
      </div>
      <Panel id="data.lens" title="Objectif">
        <Row label="Type">
          <Select value={cam.kind} options={CAMERA_KINDS} onChange={(kind) => set({ kind })} />
        </Row>
        {persp ? (
          <>
            <Row label="Focale" tip="Focale équivalente plein format (capteur 24×36 mm), liée au champ de vision vertical">
              <NumberField
                value={tidy(fovToFocal(cam.fov))}
                min={1}
                max={5000}
                step={0.1}
                precision={1}
                unit="mm"
                onChange={(focal) => set({ fov: tidy(focalToFov(focal)) })}
              />
            </Row>
            <Row label="Champ de vision" tip="Champ de vision vertical">
              <NumberField value={cam.fov} min={0.5} max={175} step={0.1} precision={1} unit="°" onChange={(fov) => set({ fov })} />
            </Row>
          </>
        ) : (
          <Row label="Échelle" tip="Hauteur visible en mètres">
            <NumberField value={cam.orthoScale} min={0.001} max={100000} step={0.01} unit="m" onChange={(orthoScale) => set({ orthoScale })} />
          </Row>
        )}
        <Row label="Début de coupe" tip="Plan de coupe proche : rien n’est rendu plus près">
          <NumberField value={cam.near} min={0.0001} max={Math.max(0.0001, cam.far - 0.0001)} step={0.001} precision={4} unit="m" onChange={(near) => set({ near })} />
        </Row>
        <Row label="Fin" tip="Plan de coupe lointain : rien n’est rendu plus loin">
          <NumberField value={cam.far} min={cam.near + 0.0001} max={1e7} step={1} precision={2} unit="m" onChange={(far) => set({ far })} />
        </Row>
      </Panel>
      <Panel id="data.dof" title="Profondeur de champ" defaultOpen={false}>
        <Row>
          <Checkbox checked={cam.dofEnabled} onChange={(dofEnabled) => set({ dofEnabled })} label="Activer (path tracing)" />
        </Row>
        <Row label="Distance de mise au point">
          <NumberField
            value={cam.focusDistance}
            min={0}
            max={1e6}
            step={0.01}
            unit="m"
            disabled={!cam.dofEnabled}
            onChange={(focusDistance) => set({ focusDistance })}
          />
        </Row>
        <Row label="Ouverture" tip="Nombre f : plus il est petit, plus le flou d’arrière-plan est marqué">
          <NumberField value={cam.fstop} min={0.1} max={128} step={0.05} precision={1} unit="f" disabled={!cam.dofEnabled} onChange={(fstop) => set({ fstop })} />
        </Row>
      </Panel>
      <UsersHint users={users} what="Ces données de caméra sont" />
    </>
  );
}

// ------------------------------------------------------------------ maillage

interface MeshStats {
  verts: number;
  edges: number;
  faces: number;
  tris: number;
}

function meshStats(mesh: MeshData | null): MeshStats | null {
  if (!mesh) return null;
  const edges = new Set<string>();
  let tris = 0;
  for (const loop of mesh.faces.values()) {
    tris += Math.max(0, loop.length - 2);
    for (let i = 0; i < loop.length; i++) edges.add(edgeKey(loop[i], loop[(i + 1) % loop.length]));
  }
  return { verts: mesh.verts.size, edges: edges.size, faces: mesh.faces.size, tris };
}

function MeshDataTab({ obj }: { obj: ObjectData }) {
  const id = obj.data;
  // Recalcul seulement quand la topologie change (pas à chaque déplacement de sommet).
  const info = useDocWhen(
    (doc) => (id ? { name: doc.getMeshName(id), stats: meshStats(doc.getMesh(id)) } : null),
    { mesh: (e) => e.id === id && (e.topologyChanged || e.removed) },
    [id],
  );
  const users = useDataUsers('mesh', id);
  if (!id || !info || !info.stats) return <MissingData what="Le maillage" />;
  const s = info.stats;
  return (
    <>
      <Panel id="data.mesh" title="Maillage">
        <Row label="Nom" tip="Nom du bloc de données de maillage (lecture seule : SceneDoc n’expose pas de renommage des maillages)">
          <TextField value={info.name} onCommit={() => undefined} disabled />
        </Row>
        <Row label="Utilisateurs" tip="Nombre d’objets qui partagent ce maillage">
          <span className="cf-props-value">{users}</span>
        </Row>
        <UsersHint users={users} what="Ce maillage est" />
      </Panel>
      <Panel id="data.stats" title="Statistiques">
        <div className="cf-props-stats">
          <span>Sommets</span>
          <b>{formatCount(s.verts)}</b>
          <span>Arêtes</span>
          <b>{formatCount(s.edges)}</b>
          <span>Faces</span>
          <b>{formatCount(s.faces)}</b>
          <span>Triangles</span>
          <b>{formatCount(s.tris)}</b>
        </div>
      </Panel>
    </>
  );
}
