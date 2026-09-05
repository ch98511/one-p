// Generates PNG app icons with a pure-JS encoder (no native deps).
// Draws a simple "camera / radar alert" glyph on a dark rounded square.
import zlib from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = new URL("../docs/icons/", import.meta.url);
mkdirSync(OUT, { recursive: true });

const BG = [15, 23, 42];       // slate-900
const RING = [56, 189, 248];   // sky-400
const LENS = [226, 232, 240];  // slate-200
const DOT = [239, 68, 68];     // red-500

function px(x0, y0, w, h) {
  // pixel buffer RGBA
  const buf = Buffer.alloc(w * h * 4);
  const cx = w / 2, cy = h / 2;
  const R = Math.min(w, h) * 0.34;       // outer lens ring radius
  const Rin = R * 0.62;                    // lens radius
  const dotR = R * 0.20;                    // center alert dot
  const corner = w * 0.18;                  // rounded corner radius
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // rounded-rect background mask
      const rx = Math.max(corner - x, x - (w - corner), 0);
      const ry = Math.max(corner - y, y - (h - corner), 0);
      const inCorner = rx > 0 && ry > 0;
      const bgOn = !inCorner || (rx * rx + ry * ry) <= corner * corner;
      let r = 0, g = 0, b = 0, a = 0;
      if (bgOn) {
        r = BG[0]; g = BG[1]; b = BG[2]; a = 255;
        const d = Math.hypot(x - cx, y - cy);
        if (d <= dotR) { [r, g, b] = DOT; }
        else if (d <= Rin) { [r, g, b] = LENS; }
        else if (d <= R && d >= R - Math.max(2, R * 0.14)) { [r, g, b] = RING; }
      }
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
    }
  }
  return buf;
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  // add filter byte (0) per scanline
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

for (const size of [192, 512]) {
  const png = encodePNG(size, size, px(0, 0, size, size));
  writeFileSync(new URL(`icon-${size}.png`, OUT), png);
  console.log(`wrote icon-${size}.png (${png.length} bytes)`);
}
console.log("done");
