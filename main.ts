// gta6-meme-x-01 entry (Node 22, standard library only).
//
// What the program does, in order:
//   1. Copies POST.json from the repository root to /output/POST.json, where
//      the gate reads it (the entry is the X post that POST.json names).
//   2. Renders this entry's meme picture itself, pixel by pixel, and writes
//      it to /output/meme.png. The render is a pure function of the constants
//      below: no clock, no randomness, no network, no files besides the two
//      it writes, so two runs produce byte-identical output.
//
// The meme: a Vice City sunset, a "GTA VI" billboard with 2025 crossed out
// and 2026 underneath, and make.fun's ghost — white body, thick black
// outline, black sparkle eyes, one round hand — front and centre, holding
// its magenta coin with the white star over a magenta "make.fun" banner.
// Caption: "WE GOT AI AGENTS / EARNING REAL MONEY" ... "BEFORE GTA 6".
// Thirteen years of waiting for GTA 6; the ghost got paid in the meantime.

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const BOT_DIR = process.env.MAKEFUN_BOT_DIR ?? '/bot';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------------------------------------------------------------------------
// Minimal PNG writer (RGB, no filtering tricks, zlib from the standard lib).
// ---------------------------------------------------------------------------

const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table.push(c >>> 0);
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0; // filter: none
    Buffer.from(rgb.buffer, y * width * 3, width * 3).copy(raw, y * (1 + width * 3) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Framebuffer and drawing primitives.
// ---------------------------------------------------------------------------

type Rgb = [number, number, number];

const W = 1200;
const H = 1200;
const px = new Uint8Array(W * H * 3);

function setPx(x: number, y: number, c: Rgb): void {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = c[0];
  px[i + 1] = c[1];
  px[i + 2] = c[2];
}

function fillRect(x: number, y: number, w: number, h: number, c: Rgb): void {
  for (let yy = Math.max(0, y); yy < Math.min(H, y + h); yy++)
    for (let xx = Math.max(0, x); xx < Math.min(W, x + w); xx++) setPx(xx, yy, c);
}

function fillCircle(cx: number, cy: number, r: number, c: Rgb): void {
  for (let y = Math.floor(cy - r); y <= cy + r; y++) {
    const dy = y - cy;
    const dx = Math.sqrt(Math.max(0, r * r - dy * dy));
    for (let x = Math.floor(cx - dx); x <= cx + dx; x++) setPx(x, y, c);
  }
}

// Filled polygon, even-odd scanline.
function fillPoly(pts: [number, number][], c: Rgb): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of pts) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(H - 1, Math.ceil(maxY)); y++) {
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      if ((y >= y1 && y < y2) || (y >= y2 && y < y1)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2)
      for (let x = Math.floor(xs[i]); x <= xs[i + 1]; x++) setPx(x, y, c);
  }
}

// A straight line drawn as stamped circles, so it has round, even thickness.
function thickLine(x1: number, y1: number, x2: number, y2: number, w: number, c: Rgb): void {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const steps = Math.max(1, Math.ceil(len / (w / 3)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    fillCircle(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, w / 2, c);
  }
}

// Four-pointed sparkle (the ghost's eye shape), or with points=5 a star.
function star(cx: number, cy: number, rOut: number, rIn: number, points: number, c: Rgb): void {
  const pts: [number, number][] = [];
  for (let i = 0; i < points * 2; i++) {
    const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? rOut : rIn;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  fillPoly(pts, c);
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

// ---------------------------------------------------------------------------
// A 5x7 pixel font. Uppercase for the captions; the few lowercase glyphs the
// "make.fun" wordmark needs are drawn on the same grid, sitting on the
// baseline with a proper x-height.
// ---------------------------------------------------------------------------

const GLYPHS: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11100', '10010', '10001', '10001', '10001', '10010', '11100'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '10001', '11001', '10101', '10011', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '01010', '00100', '00100', '00100', '01010', '10001'],
  Y: ['10001', '01010', '00100', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  "'": ['00100', '00100', '01000', '00000', '00000', '00000', '00000'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
  '?': ['01110', '10001', '00001', '00110', '00100', '00000', '00100'],
  '-': ['00000', '00000', '00000', '01110', '00000', '00000', '00000'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '$': ['00100', '01111', '10100', '01110', '00101', '11110', '00100'],
  ',': ['00000', '00000', '00000', '00000', '01100', '00100', '01000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  a: ['00000', '00000', '01110', '00001', '01111', '10001', '01111'],
  e: ['00000', '00000', '01110', '10001', '11111', '10000', '01110'],
  f: ['00110', '01001', '01000', '11110', '01000', '01000', '01000'],
  k: ['10000', '10000', '10100', '11000', '10100', '10010', '10001'],
  m: ['00000', '00000', '11010', '10101', '10101', '10101', '10101'],
  n: ['00000', '00000', '11110', '10001', '10001', '10001', '10001'],
  u: ['00000', '00000', '10001', '10001', '10001', '10011', '01101'],
};

function textWidth(text: string, scale: number): number {
  return text.length * 6 * scale - scale;
}

// Draws text with its left edge at x (or centred on cx when given).
function drawText(text: string, y: number, scale: number, c: Rgb, cx?: number): void {
  let x = cx === undefined ? 0 : Math.round(cx - textWidth(text, scale) / 2);
  for (const ch of text) {
    const glyph = GLYPHS[ch] ?? GLYPHS[' '];
    for (let row = 0; row < 7; row++)
      for (let col = 0; col < 5; col++)
        if (glyph[row][col] === '1') fillRect(x + col * scale, y + row * scale, scale, scale, c);
    x += 6 * scale;
  }
}

// ---------------------------------------------------------------------------
// The scene.
// ---------------------------------------------------------------------------

const INK: Rgb = [12, 12, 16];
const BAR: Rgb = [8, 8, 14];
const WHITE: Rgb = [255, 255, 255];
const MAGENTA: Rgb = [230, 0, 126];
const COIN: Rgb = [240, 0, 145];
const COIN_RIM: Rgb = [172, 0, 102];
const SUN: Rgb = [255, 205, 64];
const CYAN: Rgb = [0, 229, 255];
const GREEN: Rgb = [55, 255, 154];
const RED: Rgb = [255, 45, 45];
const FADED_RED: Rgb = [206, 96, 96];
const GRAY: Rgb = [168, 168, 180];
const BOARD: Rgb = [16, 10, 28];
const SILHOUETTE: Rgb = [10, 5, 22];

const SCENE_TOP = 204;
const SCENE_BOTTOM = 1004;
const HORIZON = 830;

// Sunset gradient stops across the scene band.
const SKY: [number, Rgb][] = [
  [SCENE_TOP, [42, 10, 78]],
  [390, [109, 27, 122]],
  [570, [194, 42, 125]],
  [720, [255, 107, 74]],
  [HORIZON, [255, 179, 71]],
];

function skyAt(y: number): Rgb {
  for (let i = 0; i + 1 < SKY.length; i++) {
    const [y1, c1] = SKY[i];
    const [y2, c2] = SKY[i + 1];
    if (y >= y1 && y <= y2) return mix(c1, c2, (y - y1) / (y2 - y1));
  }
  return SKY[SKY.length - 1][1];
}

function drawSky(): void {
  for (let y = SCENE_TOP; y < HORIZON; y++) fillRect(0, y, W, 1, skyAt(y));
}

// Retro sun: a disc with widening slits cut toward its base. It sits right
// behind the ghost's dome, so its rim halos the head and its striped base
// ends above the ghost's hem.
function drawSun(): void {
  const cx = 596;
  const cy = 545;
  const r = 215;
  fillCircle(cx, cy, r, SUN);
  const slits: [number, number][] = [
    [598, 606],
    [626, 636],
    [658, 670],
    [694, 708],
  ];
  for (const [y1, y2] of slits)
    for (let y = y1; y < y2 && y < HORIZON; y++) fillRect(cx - r, y, r * 2, 1, skyAt(y));
}

function drawGround(): void {
  fillRect(0, HORIZON, W, SCENE_BOTTOM - HORIZON, [18, 6, 36]);
  for (const y of [866, 906, 952]) fillRect(0, y, W, 3, [255, 46, 136]);
  for (const bx of [-200, 100, 400, 800, 1100, 1400])
    thickLine(600, HORIZON, bx, SCENE_BOTTOM, 3, [90, 30, 140]);
}

// A palm silhouette: a leaning trunk and drooping fronds, stamped circles.
function drawPalm(baseX: number, baseY: number, height: number, lean: number): void {
  const topX = baseX + lean;
  const topY = baseY - height;
  const steps = 40;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = baseX + (topX - baseX) * t + Math.sin(t * Math.PI) * lean * 0.18;
    const y = baseY + (topY - baseY) * t;
    fillCircle(x, y, 13 - 6 * t, SILHOUETTE);
  }
  for (let f = 0; f < 7; f++) {
    const a = Math.PI * (0.08 + (f / 6) * 0.84); // fan of directions, up and out
    const dirX = Math.cos(a) * (f < 3 ? -1 : 1) * (0.4 + 0.6 * Math.abs(f - 3) / 3);
    const reach = height * 0.34 * (0.75 + 0.25 * Math.abs(f - 3) / 3);
    const endX = topX + dirX * reach * 1.6;
    const endY = topY + reach * 0.55;
    const midX = topX + dirX * reach * 0.9;
    const midY = topY - reach * 0.42;
    for (let i = 0; i <= 44; i++) {
      const t = i / 44;
      const x = (1 - t) * (1 - t) * topX + 2 * (1 - t) * t * midX + t * t * endX;
      const y = (1 - t) * (1 - t) * topY + 2 * (1 - t) * t * midY + t * t * endY;
      fillCircle(x, y, 6, SILHOUETTE);
    }
  }
}

// The roadside billboard: GTA VI, 2025 crossed out, 2026 in green.
function drawBillboard(): void {
  fillRect(838, 514, 16, HORIZON - 514, SILHOUETTE);
  fillRect(1092, 514, 16, HORIZON - 514, SILHOUETTE);
  fillRect(788, 322, 370, 198, CYAN);
  fillRect(795, 329, 356, 184, BOARD);
  drawText('GTA VI', 348, 8, WHITE, 973);
  drawText('2025', 440, 6, FADED_RED, 889);
  thickLine(826, 436, 952, 486, 7, RED);
  thickLine(826, 486, 952, 436, 7, RED);
  thickLine(966, 461, 986, 461, 6, WHITE);
  fillPoly(
    [
      [986, 452],
      [1002, 461],
      [986, 470],
    ],
    WHITE,
  );
  drawText('2026', 440, 6, GREEN, 1073);
}

// The ghost's body as a polygon: a dome, straight sides, a wavy hem.
function ghostPath(cx: number, domeY: number, halfW: number, bottom: number): [number, number][] {
  const pts: [number, number][] = [];
  const domeCx = cx;
  const domeCy = domeY + halfW;
  for (let a = 180; a >= 0; a -= 9) {
    const rad = (a * Math.PI) / 180;
    pts.push([domeCx + Math.cos(rad) * halfW, domeCy - Math.sin(rad) * halfW]);
  }
  pts.push([cx + halfW, bottom]);
  const waves = 4;
  for (let i = 1; i <= waves * 2; i++) {
    const x = cx + halfW - (i * (halfW * 2)) / (waves * 2);
    pts.push([x, i % 2 === 1 ? bottom - 26 : bottom]);
  }
  pts.push([cx - halfW, bottom]);
  return pts;
}

function drawGhost(): void {
  const cx = 592;
  // Thick black outline first, then the white body inside it.
  fillPoly(ghostPath(cx, 318, 190, 788), INK);
  fillPoly(ghostPath(cx, 332, 174, 774), WHITE);
  // Two black four-pointed sparkle eyes.
  star(cx - 70, 502, 46, 15, 4, INK);
  star(cx + 70, 502, 46, 15, 4, INK);
  // The round little hand, then the magenta coin it holds, white star on it.
  fillCircle(786, 648, 38, INK);
  fillCircle(786, 648, 30, WHITE);
  fillCircle(852, 606, 90, COIN_RIM);
  fillCircle(852, 606, 78, COIN);
  star(852, 606, 40, 16, 5, WHITE);
  // The name on a magenta banner at the ghost's feet.
  fillRect(352, 832, 496, 106, INK);
  fillRect(360, 840, 480, 90, MAGENTA);
  drawText('make.fun', 854, 9, WHITE, 600);
}

function drawScene(): void {
  drawSky();
  drawSun();
  drawBillboard();
  drawGround();
  drawPalm(118, SCENE_BOTTOM, 520, 62);
  drawPalm(1136, SCENE_BOTTOM, 396, -48);
  star(206, 300, 26, 9, 4, [255, 240, 180]);
  star(168, 566, 18, 7, 4, [255, 240, 180]);
  star(966, 706, 20, 7, 4, [255, 240, 180]);
  drawGhost();
}

function drawCaptions(): void {
  fillRect(0, 0, W, 196, BAR);
  fillRect(0, 196, W, 8, MAGENTA);
  drawText('WE GOT AI AGENTS', 26, 10, WHITE, 600);
  drawText('EARNING REAL MONEY', 108, 10, WHITE, 600);
  fillRect(0, SCENE_BOTTOM, W, 8, MAGENTA);
  fillRect(0, SCENE_BOTTOM + 8, W, H - SCENE_BOTTOM - 8, BAR);
  drawText('BEFORE GTA 6', 1044, 13, WHITE, 600);
  drawText('13 YEARS OF WAITING', 1150, 6, GRAY, 600);
}

// ---------------------------------------------------------------------------
// Main: copy POST.json, render the meme, write both to the output directory.
// ---------------------------------------------------------------------------

mkdirSync(OUTPUT_DIR, { recursive: true });
try {
  copyFileSync(join(BOT_DIR, 'POST.json'), join(OUTPUT_DIR, 'POST.json'));
} catch (err) {
  console.error(`POST.json could not be copied from ${BOT_DIR}: ${(err as Error).message}`);
  process.exit(1);
}

drawScene();
drawCaptions();
writeFileSync(join(OUTPUT_DIR, 'meme.png'), encodePng(W, H, px));
