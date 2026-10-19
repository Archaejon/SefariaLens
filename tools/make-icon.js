'use strict';

/**
 * Generates build/icon.png (256x256) with no image dependencies: a dark
 * rounded square holding a gold reading lens over three lines of text.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 256;
const SS = 3; // supersampling factor

const BG = [26, 22, 17];
const GOLD = [216, 181, 108];
const CREAM = [244, 235, 214];

function inRoundedRect(x, y, w, h, r) {
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function distToRing(x, y, cx, cy, radius) {
  return Math.abs(Math.hypot(x - cx, y - cy) - radius);
}

function shade(x, y) {
  // rounded background
  if (!inRoundedRect(x, y, SIZE, SIZE, 54)) return [0, 0, 0, 0];

  let color = BG;
  let alpha = 255;

  // gold hairline border
  const inset = 5;
  const outer = inRoundedRect(x, y, SIZE, SIZE, 54);
  const inner = inRoundedRect(x - inset, y - inset, SIZE - inset * 2, SIZE - inset * 2, 50);
  if (outer && !inner) color = GOLD;

  // lens ring
  const cx = 128;
  const cy = 116;
  const radius = 58;
  const ringDist = distToRing(x, y, cx, cy, radius);
  if (ringDist <= 7) color = GOLD;

  // three text lines inside the lens
  const lines = [
    { y: 92, from: 96, to: 160 },
    { y: 113, from: 88, to: 168 },
    { y: 134, from: 100, to: 150 },
  ];
  for (const line of lines) {
    if (y >= line.y && y < line.y + 7 && x >= line.from && x <= line.to) {
      color = CREAM;
      // keep the ring readable where lines meet it
      if (Math.hypot(x - cx, y - cy) > radius - 4) color = GOLD;
    }
  }

  // handle of the lens
  const hx = x - 190;
  const hy = y - 186;
  const along = hx * 0.707 + hy * 0.707;
  const across = -hx * 0.707 + hy * 0.707;
  if (along >= 0 && along <= 46 && Math.abs(across) <= 8) color = GOLD;

  return [...color, alpha];
}

function build() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [pr, pg, pb, pa] = shade(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
          const w = pa / 255;
          r += pr * w; g += pg * w; b += pb * w; a += pa;
        }
      }
      const n = SS * SS;
      const wsum = a / 255 || 1;
      const i = (y * SIZE + x) * 4;
      pixels[i] = Math.round(r / wsum);
      pixels[i + 1] = Math.round(g / wsum);
      pixels[i + 2] = Math.round(b / wsum);
      pixels[i + 3] = Math.round(a / n);
    }
  }
  return pixels;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crcTable = chunk.table || (chunk.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeInt32BE(crc ^ -1);
  return Buffer.concat([len, body, crcBuf]);
}

function png(pixels) {
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0;
    pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png(build()));
console.log(`wrote ${out}`);
