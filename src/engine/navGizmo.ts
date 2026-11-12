import { Quaternion, Vector3 } from 'three';
import type { ViewDirection } from './api';

/**
 * Gizmo d'orientation cliquable (en haut à droite du viewport, comme Blender) :
 * boules d'axes colorées (X rouge, Y vert, Z bleu ; négatives plus sombres),
 * clic = vue axiale (re-clic sur l'axe déjà aligné = vue opposée), glisser = orbite.
 * Dessous : boutons zoom (glisser), panoramique (glisser), vue caméra, perspective/ortho.
 *
 * C'est un petit canvas 2D superposé au viewport : ses événements n'atteignent
 * jamais le canvas WebGL, donc jamais les outils de sélection.
 */

export interface NavGizmoHost {
  viewQuaternion(): Quaternion;
  setView(dir: ViewDirection): void;
  beginDrag(mode: 'orbit' | 'pan' | 'zoom', e: PointerEvent, el: Element): void;
  dragMove(e: PointerEvent): boolean;
  endDrag(e: PointerEvent): boolean;
  toggleCameraView(): void;
  toggleOrtho(): void;
  isOrtho(): boolean;
  inCameraView(): boolean;
}

const SIZE = 100;
const R = 36;
const BALL = 10;
const BTN = 28;
const BTN_GAP = 6;
const BUTTONS = ['zoom', 'pan', 'camera', 'ortho'] as const;
type Button = (typeof BUTTONS)[number];

interface Ball {
  dir: ViewDirection;
  axis: 'x' | 'y' | 'z';
  positive: boolean;
  color: string;
  dark: string;
  x: number;
  y: number;
  z: number;
}

const AXES: { axis: 'x' | 'y' | 'z'; v: Vector3; color: string; dark: string; pos: ViewDirection; neg: ViewDirection }[] = [
  { axis: 'x', v: new Vector3(1, 0, 0), color: '#ff3352', dark: '#9c2335', pos: 'right', neg: 'left' },
  { axis: 'y', v: new Vector3(0, 1, 0), color: '#8bdc00', dark: '#5a8a0a', pos: 'back', neg: 'front' },
  { axis: 'z', v: new Vector3(0, 0, 1), color: '#2890ff', dark: '#1f5c9c', pos: 'top', neg: 'bottom' },
];

const OPPOSITE: Record<ViewDirection, ViewDirection> = { front: 'back', back: 'front', left: 'right', right: 'left', top: 'bottom', bottom: 'top' };

/** Positions écran (relatives au centre, y vers le bas) des 6 boules pour une orientation de vue. */
export function gizmoBalls(viewQuat: Quaternion, radius = R): Ball[] {
  const inv = viewQuat.clone().invert();
  const out: Ball[] = [];
  for (const a of AXES) {
    for (const positive of [true, false]) {
      const v = a.v.clone().multiplyScalar(positive ? 1 : -1).applyQuaternion(inv);
      out.push({ dir: positive ? a.pos : a.neg, axis: a.axis, positive, color: a.color, dark: a.dark, x: v.x * radius, y: -v.y * radius, z: v.z });
    }
  }
  // de l'arrière vers l'avant
  return out.sort((p, q) => p.z - q.z);
}

export class NavGizmo {
  readonly dom: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private pr = 1;
  private hoverBall: Ball | null = null;
  private hoverBtn: Button | null = null;
  private hoverSphere = false;
  private press: { pointerId: number; x: number; y: number; ball: Ball | null; btn: Button | null; dragging: boolean } | null = null;
  private offs: (() => void)[] = [];
  private lastKey = '';

  constructor(private host: NavGizmoHost) {
    const c = document.createElement('canvas');
    c.className = 'cf-nav-gizmo';
    c.style.position = 'absolute';
    c.style.top = '6px';
    c.style.right = '6px';
    c.style.width = `${SIZE}px`;
    c.style.height = `${this.height}px`;
    c.style.zIndex = '2';
    c.style.touchAction = 'none';
    c.title = '';
    this.dom = c;
    this.ctx = c.getContext('2d');
    this.setPixelRatio(1);
    this.bind();
  }

  private get height(): number {
    return SIZE + BUTTONS.length * (BTN + BTN_GAP) + 4;
  }

  setPixelRatio(pr: number): void {
    this.pr = Math.max(1, pr);
    this.dom.width = Math.round(SIZE * this.pr);
    this.dom.height = Math.round(this.height * this.pr);
    this.lastKey = '';
  }

  private buttonCenter(i: number): { x: number; y: number } {
    return { x: SIZE / 2, y: SIZE + 4 + i * (BTN + BTN_GAP) + BTN / 2 };
  }

  private local(e: PointerEvent): { x: number; y: number } {
    const r = this.dom.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private hitBall(x: number, y: number): Ball | null {
    const balls = gizmoBalls(this.host.viewQuaternion());
    for (let i = balls.length - 1; i >= 0; i--) {
      const b = balls[i];
      if (Math.hypot(x - (SIZE / 2 + b.x), y - (SIZE / 2 + b.y)) <= BALL + 1) return b;
    }
    return null;
  }

  private hitButton(x: number, y: number): Button | null {
    for (let i = 0; i < BUTTONS.length; i++) {
      const c = this.buttonCenter(i);
      if (Math.hypot(x - c.x, y - c.y) <= BTN / 2) return BUTTONS[i];
    }
    return null;
  }

  private inSphere(x: number, y: number): boolean {
    return Math.hypot(x - SIZE / 2, y - SIZE / 2) <= R + BALL + 2;
  }

  private bind(): void {
    const c = this.dom;
    const down = (e: PointerEvent) => {
      if (e.button !== 0 && e.button !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      const { x, y } = this.local(e);
      const btn = this.hitButton(x, y);
      const ball = btn ? null : this.hitBall(x, y);
      if (!btn && !ball && !this.inSphere(x, y)) return;
      this.press = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, ball, btn, dragging: false };
      try {
        c.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (btn === 'zoom' || btn === 'pan') {
        this.press.dragging = true;
        this.host.beginDrag(btn, e, c);
      }
    };
    const move = (e: PointerEvent) => {
      const p = this.press;
      if (p && p.pointerId === e.pointerId) {
        e.stopPropagation();
        if (!p.dragging && !p.btn && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 3) {
          p.dragging = true;
          this.host.beginDrag('orbit', e, c);
        }
        if (p.dragging) this.host.dragMove(e);
        return;
      }
      const { x, y } = this.local(e);
      const btn = this.hitButton(x, y);
      const ball = btn ? null : this.hitBall(x, y);
      const sphere = !btn && this.inSphere(x, y);
      if (btn !== this.hoverBtn || ball?.dir !== this.hoverBall?.dir || sphere !== this.hoverSphere) {
        this.hoverBtn = btn;
        this.hoverBall = ball;
        this.hoverSphere = sphere;
        c.style.cursor = btn || ball || sphere ? 'pointer' : 'default';
        c.title = btn ? BUTTON_TIPS[btn] : ball ? `Vue ${VIEW_LABELS[ball.dir]}` : '';
        this.draw(true);
      }
    };
    const up = (e: PointerEvent) => {
      const p = this.press;
      if (!p || p.pointerId !== e.pointerId) return;
      e.stopPropagation();
      this.press = null;
      try {
        c.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (p.dragging) {
        this.host.endDrag(e);
        return;
      }
      if (p.btn === 'camera') this.host.toggleCameraView();
      else if (p.btn === 'ortho') this.host.toggleOrtho();
      else if (p.ball) {
        // re-cliquer l'axe déjà aligné donne la vue opposée
        const f = new Vector3(0, 0, -1).applyQuaternion(this.host.viewQuaternion());
        const a = AXES.find((x) => x.axis === p.ball!.axis)!;
        const towardViewer = a.v.clone().multiplyScalar(p.ball.positive ? 1 : -1);
        const aligned = f.dot(towardViewer) < -0.9999;
        this.host.setView(aligned ? OPPOSITE[p.ball.dir] : p.ball.dir);
      }
    };
    const leave = () => {
      if (this.press) return;
      if (this.hoverBall || this.hoverBtn || this.hoverSphere) {
        this.hoverBall = null;
        this.hoverBtn = null;
        this.hoverSphere = false;
        this.draw(true);
      }
    };
    const stop = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
    };
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('pointerleave', leave);
    c.addEventListener('contextmenu', stop);
    c.addEventListener('auxclick', stop);
    this.offs.push(() => {
      c.removeEventListener('pointerdown', down);
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerup', up);
      c.removeEventListener('pointercancel', up);
      c.removeEventListener('pointerleave', leave);
      c.removeEventListener('contextmenu', stop);
      c.removeEventListener('auxclick', stop);
    });
  }

  /** Redessine si l'orientation ou l'état a changé (`force` : toujours). */
  draw(force = false): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const q = this.host.viewQuaternion();
    const key = `${q.x.toFixed(4)},${q.y.toFixed(4)},${q.z.toFixed(4)},${q.w.toFixed(4)}|${this.host.isOrtho()}|${this.host.inCameraView()}`;
    if (!force && key === this.lastKey) return;
    this.lastKey = key;
    const pr = this.pr;
    ctx.setTransform(pr, 0, 0, pr, 0, 0);
    ctx.clearRect(0, 0, SIZE, this.height);
    const cx = SIZE / 2;
    const cy = SIZE / 2;

    if (this.hoverSphere || this.press) {
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.beginPath();
      ctx.arc(cx, cy, R + BALL + 2, 0, Math.PI * 2);
      ctx.fill();
    }

    const balls = gizmoBalls(q);
    ctx.lineWidth = 2;
    for (const b of balls) {
      const x = cx + b.x;
      const y = cy + b.y;
      const hover = this.hoverBall?.dir === b.dir;
      if (b.positive) {
        ctx.strokeStyle = b.color;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x, y, BALL, 0, Math.PI * 2);
      if (b.positive) {
        ctx.fillStyle = b.color;
        ctx.fill();
      } else {
        ctx.fillStyle = b.dark;
        ctx.globalAlpha = 0.85;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = b.color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.lineWidth = 2;
      }
      if (hover) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      if (b.positive || hover) {
        ctx.fillStyle = b.positive ? '#141414' : '#ffffff';
        ctx.font = '700 11px "Segoe UI", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${b.positive ? '' : '-'}${b.axis.toUpperCase()}`, x, y + 0.5);
      }
    }

    for (let i = 0; i < BUTTONS.length; i++) {
      const btn = BUTTONS[i];
      const c = this.buttonCenter(i);
      const active = (btn === 'camera' && this.host.inCameraView()) || (btn === 'ortho' && this.host.isOrtho());
      ctx.beginPath();
      ctx.arc(c.x, c.y, BTN / 2, 0, Math.PI * 2);
      ctx.fillStyle = this.hoverBtn === btn ? 'rgba(255,255,255,0.22)' : active ? 'rgba(71,114,179,0.75)' : 'rgba(0,0,0,0.28)';
      ctx.fill();
      drawIcon(ctx, btn, c.x, c.y, this.host.isOrtho());
    }
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.dom.remove();
  }
}

const BUTTON_TIPS: Record<Button, string> = {
  zoom: 'Zoomer (glisser)',
  pan: 'Déplacer la vue (glisser)',
  camera: 'Vue caméra',
  ortho: 'Perspective / Orthographique',
};

const VIEW_LABELS: Record<ViewDirection, string> = {
  front: 'de face',
  back: 'arrière',
  left: 'de gauche',
  right: 'de droite',
  top: 'de dessus',
  bottom: 'de dessous',
};

function drawIcon(ctx: CanvasRenderingContext2D, btn: Button, x: number, y: number, ortho: boolean): void {
  ctx.save();
  ctx.strokeStyle = '#e6e6e6';
  ctx.fillStyle = '#e6e6e6';
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  switch (btn) {
    case 'zoom':
      ctx.arc(x - 2, y - 2, 5, 0, Math.PI * 2);
      ctx.moveTo(x + 1.6, y + 1.6);
      ctx.lineTo(x + 6, y + 6);
      ctx.moveTo(x - 4.5, y - 2);
      ctx.lineTo(x + 0.5, y - 2);
      ctx.moveTo(x - 2, y - 4.5);
      ctx.lineTo(x - 2, y + 0.5);
      ctx.stroke();
      break;
    case 'pan': {
      const s = 7;
      ctx.moveTo(x - s, y);
      ctx.lineTo(x + s, y);
      ctx.moveTo(x, y - s);
      ctx.lineTo(x, y + s);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const tx = x + dx * s;
        const ty = y + dy * s;
        ctx.moveTo(tx - dx * 2.5 - dy * 2.5, ty - dy * 2.5 - dx * 2.5);
        ctx.lineTo(tx, ty);
        ctx.lineTo(tx - dx * 2.5 + dy * 2.5, ty - dy * 2.5 + dx * 2.5);
      }
      ctx.stroke();
      break;
    }
    case 'camera':
      ctx.rect(x - 7, y - 4, 9, 8);
      ctx.moveTo(x + 2, y - 1);
      ctx.lineTo(x + 7, y - 4);
      ctx.lineTo(x + 7, y + 4);
      ctx.lineTo(x + 2, y + 1);
      ctx.stroke();
      break;
    case 'ortho':
      if (ortho) {
        // grille orthogonale
        for (let i = -1; i <= 1; i++) {
          ctx.moveTo(x - 6, y + i * 4);
          ctx.lineTo(x + 6, y + i * 4);
          ctx.moveTo(x + i * 4, y - 6);
          ctx.lineTo(x + i * 4, y + 6);
        }
      } else {
        // grille en perspective
        ctx.moveTo(x - 4, y - 5);
        ctx.lineTo(x + 4, y - 5);
        ctx.lineTo(x + 7, y + 5);
        ctx.lineTo(x - 7, y + 5);
        ctx.closePath();
        ctx.moveTo(x, y - 5);
        ctx.lineTo(x, y + 5);
        ctx.moveTo(x - 5.5, y);
        ctx.lineTo(x + 5.5, y);
      }
      ctx.stroke();
      break;
  }
  ctx.restore();
}
