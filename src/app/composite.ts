import type { CompositorSettings } from '../core/doc/schema';

/**
 * Compositing de l'image rendue (pixels sRGB 8 bits) : exposition et gamma, contraste,
 * saturation et teinte, vignettage. Fonction PURE sur un tampon RGBA : testable sous Node.
 */
export function compositePixels(data: Uint8ClampedArray, width: number, height: number, s: CompositorSettings): void {
  const toLin = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    toLin[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  const toSrgb = (l: number) => {
    const c = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(Math.max(0, l), 1 / 2.4) - 0.055;
    return c;
  };
  const gain = s.useExposure ? Math.pow(2, Number.isFinite(s.exposure) ? s.exposure : 0) : 1;
  const invGamma = s.useExposure && s.gamma > 0 ? 1 / s.gamma : 1;
  const tint = hexRgb(s.tint);
  const color = s.useColor;
  const contrast = Number.isFinite(s.contrast) ? s.contrast : 1;
  const sat = Number.isFinite(s.saturation) ? s.saturation : 1;
  const vig = s.useVignette ? Math.max(0, Math.min(1, s.vignette)) : 0;
  const cx = width / 2;
  const cy = height / 2;
  const rmax = Math.hypot(cx, cy) || 1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let r = toLin[data[i]] * gain;
      let g = toLin[data[i + 1]] * gain;
      let b = toLin[data[i + 2]] * gain;
      r = toSrgb(r);
      g = toSrgb(g);
      b = toSrgb(b);
      if (invGamma !== 1) {
        r = Math.pow(Math.max(0, r), invGamma);
        g = Math.pow(Math.max(0, g), invGamma);
        b = Math.pow(Math.max(0, b), invGamma);
      }
      if (color) {
        r = (r - 0.5) * contrast + 0.5;
        g = (g - 0.5) * contrast + 0.5;
        b = (b - 0.5) * contrast + 0.5;
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = (l + (r - l) * sat) * tint[0];
        g = (l + (g - l) * sat) * tint[1];
        b = (l + (b - l) * sat) * tint[2];
      }
      if (vig > 0) {
        const d = Math.hypot(x - cx, y - cy) / rmax;
        const t = Math.max(0, Math.min(1, (d - 0.35) / 0.65));
        const k = 1 - vig * t * t * (3 - 2 * t);
        r *= k;
        g *= k;
        b *= k;
      }
      data[i] = r * 255;
      data[i + 1] = g * 255;
      data[i + 2] = b * 255;
    }
  }
}

function hexRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return [1, 1, 1];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Applique le compositing à une image (URL) ; renvoie une URL d'objet PNG à révoquer. */
export async function compositeImageUrl(url: string, s: CompositorSettings): Promise<string> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D indisponible');
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, canvas.width, canvas.height);
  compositePixels(px.data, canvas.width, canvas.height, s);
  ctx.putImageData(px, 0, 0);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) throw new Error('Encodage PNG impossible');
  return URL.createObjectURL(blob);
}
