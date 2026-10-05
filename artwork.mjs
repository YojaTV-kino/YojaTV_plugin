// Artwork for the reference server: a small PNG per title, drawn on request in pure Node (no
// dependencies, nothing committed), so the cards in Kino fill in and each title is recognisable.
//
//   poster   300x450 (2:3)   -- the card of a movie, a season or a channel
//   backdrop 480x270 (16:9)  -- the info page's background, and an episode's still
//
// Each image is a colour picked from the id (the same id always gets the same colour), a small
// label on top ("PELICULA", "SERIE - TEMPORADA 2", "EPISODIO 3"...), the title in big letters and
// "TU SERVIDOR" at the bottom. Letters come from a 5x7 bitmap font below, uppercase and without
// accents: "Película" is drawn as "PELICULA".

import { deflateSync } from "node:zlib";

export const SHAPES = {
  poster: { width: 300, height: 450 },
  backdrop: { width: 480, height: 270 },
};

// 5x7 glyphs, one number per row, the 5 low bits left to right.
const FONT = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11], B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e], D: [0x1c, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1c],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f], F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f], H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e], J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11], L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11], N: [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e], P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d], R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e], T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e], V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a], X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x11, 0x0a, 0x04, 0x04, 0x04], Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  0: [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e], 1: [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  2: [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f], 3: [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  4: [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02], 5: [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  6: [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e], 7: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  8: [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e], 9: [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  ":": [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x0c, 0x00], ".": [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  "(": [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02], ")": [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  "-": [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00], "?": [0x0e, 0x11, 0x01, 0x02, 0x04, 0x00, 0x04],
  " ": [0, 0, 0, 0, 0, 0, 0],
};

// "Película con doblaje" -> "PELICULA CON DOBLAJE"; anything the font lacks becomes "?".
const printable = (s) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/./g, (c) => (FONT[c] ? c : "?"));

// A stable hue per id: the same title always has the same colour, neighbours rarely share one.
function hue(id) {
  let h = 2166136261;
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0) % 360;
}

function hsl(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}

class Canvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.px = Buffer.alloc(width * height * 3);
  }
  rect(x, y, w, h, [r, g, b]) {
    for (let j = Math.max(0, y); j < Math.min(this.height, y + h); j++) {
      for (let i = Math.max(0, x); i < Math.min(this.width, x + w); i++) {
        const o = (j * this.width + i) * 3;
        this.px[o] = r; this.px[o + 1] = g; this.px[o + 2] = b;
      }
    }
  }
  // One line of text, centred on `cx`, its top at `y`, each font pixel `scale` screen pixels.
  text(line, cx, y, scale, color) {
    let x = Math.round(cx - textWidth(line, scale) / 2);
    for (const c of line) {
      FONT[c].forEach((bits, row) => {
        for (let col = 0; col < 5; col++) {
          if (bits & (0x10 >> col)) this.rect(x + col * scale, y + row * scale, scale, scale, color);
        }
      });
      x += 6 * scale;
    }
  }
  png() {
    const raw = Buffer.alloc((this.width * 3 + 1) * this.height);
    for (let j = 0; j < this.height; j++) {
      raw[j * (this.width * 3 + 1)] = 0; // filter: none
      this.px.copy(raw, j * (this.width * 3 + 1) + 1, j * this.width * 3, (j + 1) * this.width * 3);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.width, 0);
    ihdr.writeUInt32BE(this.height, 4);
    ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw, { level: 9 })),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }
}

const textWidth = (line, scale) => (line.length * 6 - 1) * scale;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

// Greedy word wrap at `maxChars` per line.
function wrap(text, maxChars) {
  const lines = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const last = lines[lines.length - 1];
    if (last !== undefined && (last + " " + word).length <= maxChars) lines[lines.length - 1] = last + " " + word;
    else lines.push(word);
  }
  return lines;
}

/**
 * The PNG for one title. `id` picks the colour, `title` is drawn big, `label` small on top.
 * `shape` is "poster" or "backdrop".
 */
export function artwork({ id, title, label, shape }) {
  const { width, height } = SHAPES[shape];
  const canvas = new Canvas(width, height);
  const h = hue(id);

  // Background: the title's colour, darkening downwards in bands.
  const bands = 12;
  for (let b = 0; b < bands; b++) {
    const y0 = Math.floor((b * height) / bands);
    const y1 = Math.floor(((b + 1) * height) / bands);
    canvas.rect(0, y0, width, y1 - y0, hsl(h, 0.55, 0.42 - (0.22 * b) / bands));
  }
  const white = [255, 255, 255];
  const pale = hsl(h, 0.6, 0.85);
  const margin = Math.round(width * 0.08);

  // Top label and bottom brand, small.
  const small = 2;
  const pad = Math.round(margin / 2);
  canvas.rect(0, 0, width, 7 * small + 2 * pad, hsl(h, 0.6, 0.22));
  canvas.text(printable(label), width / 2, pad, small, pale);
  canvas.text("TU SERVIDOR", width / 2, height - pad - 7 * small, small, pale);

  // The title: as big as fits, wrapped, centred in the space left.
  const text = printable(title);
  const avail = width - 2 * margin;
  let scale = 6;
  let lines;
  for (; scale > 1; scale--) {
    const maxChars = Math.floor((avail / scale + 1) / 6);
    lines = wrap(text, maxChars);
    const tall = lines.length * 9 * scale;
    if (lines.every((l) => l.length <= maxChars) && tall <= height - 4 * margin) break;
  }
  const lineHeight = 9 * scale;
  let y = Math.round((height - lines.length * lineHeight + 2 * scale) / 2);
  for (const line of lines) {
    canvas.text(line, width / 2, y, scale, white);
    y += lineHeight;
  }
  return canvas.png();
}
