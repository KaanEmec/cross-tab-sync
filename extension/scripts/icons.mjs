// Placeholder icons generated at build time: two overlapping rounded "tabs" on a blue tile.
// Tiny PNG encoder (RGBA, no filter) over node:zlib; no image dependencies.
import { crc32, deflateSync } from "node:zlib";

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

function encodePng(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size);
      raw.set([r, g, b, a], row + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function pixel(px, py, size) {
  const x = px / size;
  const y = py / size;
  if (!inRoundedRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.22)) return [0, 0, 0, 0];
  if (inRoundedRect(x, y, 0.36, 0.22, 0.8, 0.62, 0.07)) return [255, 255, 255, 255];
  if (inRoundedRect(x, y, 0.2, 0.38, 0.64, 0.78, 0.07)) return [190, 220, 255, 255];
  return [10, 102, 216, 255];
}

export function icons(sizes = [16, 32, 48, 128]) {
  return Object.fromEntries(sizes.map((s) => [`icon-${s}.png`, encodePng(s, pixel)]));
}
