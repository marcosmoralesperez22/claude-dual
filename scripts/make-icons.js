// Genera los iconos de la app (PNG + ICO) sin dependencias externas.
// Uso: npm run icons
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT = path.join(__dirname, '..', 'assets');

const BG = [30, 27, 46];
const A = [240, 132, 92];
const B = [108, 124, 240];
const MIX = [245, 239, 230];

// ---------- Rasterizado (supersampling 4x4) ----------

function insideRoundRect(x, y, inset, r) {
  const lo = inset;
  const hi = 1 - inset;
  if (x < lo || x > hi || y < lo || y > hi) return false;
  const cx = Math.min(Math.max(x, lo + r), hi - r);
  const cy = Math.min(Math.max(y, lo + r), hi - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inCircle(x, y, cx, cy, r) {
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function sample(x, y, withBackground) {
  const a = inCircle(x, y, 0.4, 0.5, 0.235);
  const b = inCircle(x, y, 0.6, 0.5, 0.235);
  if (a && b) return [...MIX, 255];
  if (a) return [...A, 255];
  if (b) return [...B, 255];
  if (withBackground && insideRoundRect(x, y, 0.03, 0.22)) return [...BG, 255];
  return [0, 0, 0, 0];
}

function render(size, withBackground = true) {
  const SS = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample((pxi + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, withBackground);
          // Acumulamos con alfa premultiplicado
          r += c[0] * c[3];
          g += c[1] * c[3];
          b += c[2] * c[3];
          a += c[3];
        }
      }
      const i = (py * size + pxi) * 4;
      px[i + 3] = Math.round(a / (SS * SS));
      if (a > 0) {
        px[i] = Math.round(r / a);
        px[i + 1] = Math.round(g / a);
        px[i + 2] = Math.round(b / a);
      }
    }
  }
  return px;
}

// ---------- Codificador PNG ----------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filtro "None"
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function png(size, withBackground = true) {
  return encodePng(size, render(size, withBackground));
}

// ---------- ICO (entradas PNG, válido desde Windows Vista) ----------

function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); // planos
    e.writeUInt16LE(32, 6); // bits por píxel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

// ---------- Salida ----------

fs.mkdirSync(OUT, { recursive: true });

fs.writeFileSync(path.join(OUT, 'icon.png'), png(512));
fs.writeFileSync(
  path.join(OUT, 'icon.ico'),
  encodeIco([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: png(size) })))
);
fs.writeFileSync(path.join(OUT, 'tray.png'), png(16));
fs.writeFileSync(path.join(OUT, 'tray@2x.png'), png(32));

console.log('Iconos generados en', OUT);
