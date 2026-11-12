// Génère l'icône de l'application sans dépendance externe (encodeur PNG maison + zlib) :
//   build/icon.png  512×512
//   build/icon.ico  ICO contenant un PNG 256×256
// Motif : cube isométrique orange sur fond sombre arrondi.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------------ PNG

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** Encode une image RGBA 8 bits (Uint8Array de size×size×4) en PNG. */
function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // profondeur
  header[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filtre « aucun »
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ICO à une seule image, stockée en PNG (largeur/hauteur 0 = 256). */
function encodeIco(png256) {
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // type icône
  head.writeUInt16LE(1, 4); // une image
  head[6] = 0; // largeur 256
  head[7] = 0; // hauteur 256
  head.writeUInt16LE(1, 10); // plans
  head.writeUInt16LE(32, 12); // bits par pixel
  head.writeUInt32LE(png256.length, 14);
  head.writeUInt32LE(22, 18); // position des données
  return Buffer.concat([head, png256]);
}

// ------------------------------------------------------------------ dessin (coordonnées normalisées 0..1)

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

function inRoundedRect(x, y, min, max, radius) {
  if (x < min || x > max || y < min || y > max) return false;
  const cx = Math.min(Math.max(x, min + radius), max - radius);
  const cy = Math.min(Math.max(y, min + radius), max - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function inConvex(poly, x, y) {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Rétrécit un polygone vers son centre (laisse un liseré sombre entre les faces). */
function shrink(poly, factor) {
  const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
  const cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  return poly.map(([x, y]) => [cx + (x - cx) * factor, cy + (y - cy) * factor]);
}

const CX = 0.5;
const CY = 0.5;
const R = 0.33;
const W = R * Math.cos(Math.PI / 6);
const top = [CX, CY - R];
const upRight = [CX + W, CY - R / 2];
const lowRight = [CX + W, CY + R / 2];
const bottom = [CX, CY + R];
const lowLeft = [CX - W, CY + R / 2];
const upLeft = [CX - W, CY - R / 2];
const center = [CX, CY];

const FACES = [
  { poly: shrink([top, upRight, center, upLeft], 0.93), color: hex('#ffbe55') }, // dessus
  { poly: shrink([upLeft, center, bottom, lowLeft], 0.93), color: hex('#f5961e') }, // gauche
  { poly: shrink([center, upRight, lowRight, bottom], 0.93), color: hex('#c8690a') }, // droite
];
const BG_TOP = hex('#2b2b2b');
const BG_BOTTOM = hex('#161616');

/** Couleur [r, v, b, a] d'un point de l'icône. */
function sample(x, y) {
  if (!inRoundedRect(x, y, 0.03, 0.97, 0.2)) return [0, 0, 0, 0];
  for (const face of FACES) if (inConvex(face.poly, x, y)) return [...face.color, 255];
  const t = Math.min(1, Math.max(0, (y - 0.03) / 0.94));
  return [BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t, BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t, BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t, 255];
}

/** Rendu avec suréchantillonnage 4×4 (alpha non prémultiplié en sortie). */
function render(size) {
  const SS = 4;
  const out = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
          const alpha = c[3] / 255;
          r += c[0] * alpha;
          g += c[1] * alpha;
          b += c[2] * alpha;
          a += alpha;
        }
      }
      const i = (py * size + px) * 4;
      if (a > 0) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
      }
      out[i + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return out;
}

const outDir = path.join(root, 'build');
fs.mkdirSync(outDir, { recursive: true });
const png512 = encodePng(512, render(512));
const png256 = encodePng(256, render(256));
fs.writeFileSync(path.join(outDir, 'icon.png'), png512);
fs.writeFileSync(path.join(outDir, 'icon.ico'), encodeIco(png256));
console.log(`build/icon.png (${png512.length} octets), build/icon.ico (${png256.length + 22} octets)`);
