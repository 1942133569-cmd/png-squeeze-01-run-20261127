// png-squeeze-01: a lossless PNG re-encoder.
//
// Reads each 1280x720 RGBA screenshot at /input/<id>/image.png and writes the
// same pixels back as a much smaller PNG at /output/<id>/image.png.
//
// How it wins bytes over a plain RGBA + Paeth + zlib-9 encode:
//   - colour-type reduction: a palette (type 3) when the image holds at most
//     256 colours, grey (type 0) or grey+alpha (type 4) when every pixel is
//     grey, RGB (type 2) when every pixel is opaque, and a tRNS key instead
//     of an alpha channel when every non-opaque pixel shares one transparent
//     colour;
//   - palette orderings tried and weighed: by count, by luminance, by first
//     appearance, and by a greedy nearest-colour chain;
//   - per-row filter choice: fixed filters, the minimum-signed-sum heuristic,
//     the fewest-distinct-pairs heuristic, and brute force (each filter
//     weighed by a real zlib run over the row, with the previous 32 KiB as
//     its dictionary), all screened by zlib level 6, the winner re-weighed
//     at level 9 with two memory levels and two strategies.
// Every choice is fixed work, never the clock: two runs write the same bytes.
//
// The PNG codec and filter code below is my own implementation, written for
// this entry; the filter definitions follow the PNG specification, and the
// screen/brute-force approach follows the published description of the
// contest's own scale compressor. See NOTICE for the upstream licences.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- PNG codec

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngOf(chunks: Array<[string, Uint8Array]>): Uint8Array {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width: number, height: number, colourType: number): Uint8Array {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

/** The Paeth predictor of PNG filter 4. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Row `cur` (stride samples, `bpp` bytes a pixel, `prev` the row above or
 * null) filtered by `type` into out[0, stride).
 */
function filterRow(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

/** The sum of a filtered row's bytes read as signed (-128 to 127), absolute. */
function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

interface Decoded {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/**
 * The image a PNG holds, as RGBA, or throws. Reads the chunk set the contest
 * accepts: bit depth 8, colour types 0/2/3/4/6, no interlace, chunks IHDR,
 * PLTE, tRNS, IDAT, IEND only, each CRC correct.
 */
function decodePng(bytes: Uint8Array): Decoded {
  if (bytes.length < SIGNATURE.length || SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new Error('not a PNG');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = SIGNATURE.length;
  let header: { width: number; height: number; colourType: number } | null = null;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let idatDone = false;
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    if (at + 12 > bytes.length) throw new Error('chunk cut short');
    const len = view.getUint32(at);
    if (len > 0x7fffffff || at + 12 + len > bytes.length) throw new Error('chunk overruns file');
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) throw new Error(`${type} chunk fails its CRC`);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (!['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(type)) throw new Error(`unread chunk ${type}`);
    if (header === null && type !== 'IHDR') throw new Error('first chunk is not IHDR');
    if (type !== 'IDAT' && idat.length > 0) idatDone = true;
    if (type === 'IHDR') {
      if (header !== null) throw new Error('IHDR twice');
      if (len !== 13) throw new Error('IHDR is not 13 bytes');
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), colourType: data[9] };
      if (data[8] !== 8) throw new Error('bit depth is not 8');
      if (!Object.hasOwn(CHANNELS, header.colourType)) throw new Error('bad colour type');
      if (data[10] !== 0 || data[11] !== 0 || data[12] !== 0) throw new Error('not compression 0 / filter 0 / no interlace');
    } else if (type === 'PLTE') {
      if (palette !== null || header === null || header.colourType !== 3 || idat.length > 0) throw new Error('bad PLTE');
      if (len === 0 || len % 3 !== 0 || len > 768) throw new Error('bad PLTE size');
      palette = data;
    } else if (type === 'tRNS') {
      if (trns !== null || header === null || idat.length > 0) throw new Error('bad tRNS');
      const ct = header.colourType;
      if (ct === 3) {
        if (palette === null || len > palette.length / 3) throw new Error('bad palette tRNS');
      } else if (ct === 0 || ct === 2) {
        if (len !== (ct === 0 ? 2 : 6)) throw new Error('bad tRNS size');
      } else {
        throw new Error('tRNS with colour type ' + ct);
      }
      trns = data;
    } else if (type === 'IDAT') {
      if (idatDone) throw new Error('IDAT chunks are not in a row');
      if (header !== null && header.colourType === 3 && palette === null) throw new Error('IDAT before PLTE');
      idat.push(data);
    } else {
      if (len !== 0) throw new Error('IEND is not empty');
      ended = true;
    }
  }
  if (!ended || header === null || idat.length === 0) throw new Error('no IEND, header or IDAT');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  let raw: Uint8Array;
  try {
    raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  } catch {
    throw new Error('IDAT is not one zlib stream');
  }
  if (raw.length !== expected) throw new Error('IDAT inflates to the wrong size');

  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) throw new Error(`row ${y} has filter type ${ft}`);
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) {
      samples.set(raw.subarray(src, src + stride), o);
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      }
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    }
  }

  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    if (palette === null) throw new Error('palette image without PLTE');
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3];
      lut[e * 4 + 1] = palette[e * 3 + 1];
      lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) throw new Error('index past the palette');
      rgba[d] = lut[e * 4];
      rgba[d + 1] = lut[e * 4 + 1];
      rgba[d + 2] = lut[e * 4 + 2];
      rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { width, height, rgba };
}

// ------------------------------------------------------- image analysis

interface Colour {
  rgba: [number, number, number, number];
  word: number;
  count: number;
}

interface Analysis {
  opaque: boolean;
  grey: boolean;
  colours: Colour[] | null; // null when more than 256 colours
}

/** What the image holds: whether every pixel is opaque, whether every pixel is grey, and its colours when at most 256. */
function analyse(rgba: Uint8Array): Analysis {
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  let opaque = true;
  let grey = true;
  const counts = new Map<number, number>();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else {
        counts.set(c, k + 1);
      }
    }
  }
  if (many) return { opaque, grey, colours: null };
  const colours: Colour[] = [...counts.keys()].map((c) => {
    const b = new Uint8Array(Uint32Array.of(c).buffer);
    return { rgba: [b[0], b[1], b[2], b[3]] as [number, number, number, number], word: c, count: counts.get(c) as number };
  });
  return { opaque, grey, colours };
}

/**
 * The one fully transparent value (grey or RGB) the image may key by tRNS
 * instead of an alpha channel: every pixel opaque or that exact value at
 * alpha 0, and no opaque pixel of the same value. Null when there is none.
 */
function transparentKey(rgba: Uint8Array, grey: boolean): number | null {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

/** The image's samples in colour type `ct` (0, 2, 4 or 6) from its RGBA. */
function samplesOf(rgba: Uint8Array, ct: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

// ------------------------------------------------------------- palette forms

const lumOf = (c: Colour): number => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];

/** Nearest-colour chain over a list of colours, starting from the most frequent. */
function greedyChain(list: Colour[]): Colour[] {
  if (list.length === 0) return [];
  const used = new Uint8Array(list.length);
  const order: Colour[] = [];
  let cur = 0;
  for (let i = 1; i < list.length; i++) {
    if (list[i].count > list[cur].count || (list[i].count === list[cur].count && list[i].word < list[cur].word)) cur = i;
  }
  order.push(list[cur]);
  used[cur] = 1;
  for (let k = 1; k < list.length; k++) {
    const prev = order[k - 1].rgba;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < list.length; i++) {
      if (used[i]) continue;
      const c = list[i].rgba;
      const d = (c[0] - prev[0]) * (c[0] - prev[0]) + (c[1] - prev[1]) * (c[1] - prev[1]) + (c[2] - prev[2]) * (c[2] - prev[2]);
      if (d < bestD || (d === bestD && list[i].word < list[best].word)) {
        bestD = d;
        best = i;
      }
    }
    order.push(list[best]);
    used[best] = 1;
  }
  return order;
}

/**
 * A palette's entries in the order a trial writes them: the transparent ones
 * first (by alpha, so tRNS stays short), then by `order`.
 */
function paletteOrder(colours: Colour[], order: string): Colour[] {
  const transparent = colours.filter((c) => c.rgba[3] !== 255);
  const opaque = colours.filter((c) => c.rgba[3] === 255);
  const byCount = (a: Colour, b: Colour): number => b.count - a.count || a.word - b.word;
  const byLum = (a: Colour, b: Colour): number => lumOf(a) - lumOf(b) || a.word - b.word;
  const trans = [...transparent].sort((a, b) => a.rgba[3] - b.rgba[3] || a.word - b.word);
  let rest: Colour[];
  if (order === 'luminance') rest = [...opaque].sort(byLum);
  else if (order === 'greedy') rest = greedyChain(opaque);
  else rest = [...opaque].sort(byCount);
  return [...trans, ...rest];
}

interface PaletteForm {
  plte: Uint8Array;
  trns: Uint8Array | null;
  indices: Uint8Array;
}

function paletteForm(rgba: Uint8Array, colours: Colour[], order: string, firstSeen: number[] | null): PaletteForm {
  let entries: Colour[];
  if (order === 'first' && firstSeen !== null) {
    const byIndex = new Map<number, number>();
    firstSeen.forEach((w, i) => byIndex.set(w, i));
    const transparent = colours.filter((c) => c.rgba[3] !== 255).sort((a, b) => a.rgba[3] - b.rgba[3] || a.word - b.word);
    const opaque = colours
      .filter((c) => c.rgba[3] === 255)
      .sort((a, b) => (byIndex.get(a.word) as number) - (byIndex.get(b.word) as number));
    entries = [...transparent, ...opaque];
  } else {
    entries = paletteOrder(colours, order);
  }
  const index = new Map<number, number>(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]) as number;
  return { plte, trns, indices };
}

// --------------------------------------------------------------------- forms

type FilterChoice = number | 'minsum' | 'pairs' | 'brute';

interface Form {
  colourType: number;
  bpp: number;
  samples: Uint8Array;
  plte: Uint8Array | null;
  trns: Uint8Array | null;
  filters: FilterChoice[];
}

const FILTERS_CHANNELS: FilterChoice[] = [0, 1, 2, 4, 'minsum', 'pairs', 'brute'];

/** The forms an image can be written in, each with the filter choices it is screened with. */
function formsOf(rgba: Uint8Array): Form[] {
  const { opaque, grey, colours } = analyse(rgba);
  const forms: Form[] = [];
  if (colours !== null) {
    // Order of first appearance, for the 'first' palette ordering.
    const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.length >>> 2);
    const seenAt = new Map<number, number>();
    for (let i = 0; i < u32.length; i++) {
      if (!seenAt.has(u32[i])) seenAt.set(u32[i], i);
    }
    const firstSeen = [...seenAt.keys()].sort((a, b) => (seenAt.get(a) as number) - (seenAt.get(b) as number));
    for (const [order, filters] of [
      ['count', [0]],
      ['luminance', [0, 'minsum', 'brute']],
      ['first', [0, 'minsum']],
      ['greedy', [0, 'minsum', 'brute']],
    ] as Array<[string, FilterChoice[]]>) {
      const p = paletteForm(rgba, colours, order, firstSeen);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct: number;
  let trns: Uint8Array | null = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = ({ 0: 1, 2: 3, 4: 2, 6: 4 })[ct] as number;
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: FILTERS_CHANNELS });
  return forms;
}

/** The bytes a form's PLTE and tRNS chunks take in its file. */
function chunkBytes(form: Form): number {
  return (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
}

// -------------------------------------------------------------------- filters

const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;

/** How many distinct pairs of neighbouring bytes a filtered row holds. */
function pairsOf(row: Uint8Array, seen: Uint32Array, stamp: number): number {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

/**
 * The raw data of an image of `samples` (height rows of width x bpp samples),
 * each row behind its filter byte, by `choice`: a filter type (0 to 4) for
 * every row, or 'minsum' (least signed sum), 'pairs' (fewest distinct byte
 * pairs), or 'brute' (each of the five filters weighed by a zlib run over the
 * row, with the 32 KiB written before it as its dictionary).
 */
function filtered(samples: Uint8Array, width: number, height: number, bpp: number, choice: FilterChoice): Uint8Array {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial: Uint8Array[] = [];
  for (let t = 0; t < 5; t++) {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    trial.push(row);
  }
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost: number;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      else {
        cost = deflateSync(trial[t], before.length === 0 ? { level: BRUTE_LEVEL, memLevel: 9 } : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before }).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

// ---------------------------------------------------------------------- screen

const SCREEN = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };

interface Screened {
  form: Form;
  choice: FilterChoice;
  data: Uint8Array;
  bytes: number; // zlib bytes + PLTE/tRNS chunk bytes
}

/**
 * The screen's winner for an image: each form's filter choices weighed by a
 * zlib run at level 6 (brute force held back for the winner alone), the
 * smallest total wins, the first on a tie.
 */
function screen(rgba: Uint8Array, width: number, height: number): Screened {
  let best: Screened | null = null;
  for (const form of formsOf(rgba)) {
    const chunks = chunkBytes(form);
    for (const choice of form.filters) {
      if (choice === 'brute') continue;
      const data = filtered(form.samples, width, height, form.bpp, choice);
      const bytes = deflateSync(data, SCREEN).length + chunks;
      if (best === null || bytes < best.bytes) best = { form, choice, data, bytes };
    }
  }
  if (best === null) throw new Error('no form screened');
  // Brute force on the winning form alone, weighed the same way.
  if (best.form.filters.includes('brute')) {
    const data = filtered(best.form.samples, width, height, best.form.bpp, 'brute');
    const bytes = deflateSync(data, SCREEN).length + chunkBytes(best.form);
    if (bytes < best.bytes) best = { form: best.form, choice: 'brute', data, bytes };
  }
  return best;
}

/** The PNG of an image of `form` whose IDAT holds the zlib stream `idat`. */
function pngOfForm(width: number, height: number, form: Form, idat: Uint8Array): Uint8Array {
  const chunks: Array<[string, Uint8Array]> = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

/**
 * The best PNG of an image: the screen's winner, its filtered data re-weighed
 * at level 9 with two memory levels and two strategies, the smallest kept.
 */
function encodeBest(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const win = screen(rgba, width, height);
  const chunks = chunkBytes(win.form);
  const cands: Uint8Array[] = [win.data];
  // The brute-force filtering of the winning form is a second candidate when
  // the screen did not already pick it.
  if (win.choice !== 'brute' && win.form.filters.includes('brute')) {
    const brute = filtered(win.form.samples, width, height, win.form.bpp, 'brute');
    cands.push(brute);
  }
  let bestBytes = Infinity;
  let bestZlib: Uint8Array | null = null;
  let bestData: Uint8Array = cands[0];
  for (const data of cands) {
    for (const opts of [
      { level: 9, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY },
      { level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY },
    ]) {
      const z = deflateSync(data, opts);
      if (z.length + chunks < bestBytes) {
        bestBytes = z.length + chunks;
        bestZlib = new Uint8Array(z.buffer, z.byteOffset, z.length);
        bestData = data;
      }
    }
  }
  if (bestZlib === null) throw new Error('no zlib stream');
  // Last tries: the other strategies on the winning candidate.
  for (const strategy of [constants.Z_FILTERED, constants.Z_RLE, constants.Z_HUFFMAN_ONLY]) {
    const alt = deflateSync(bestData, { level: 9, memLevel: 8, strategy });
    if (alt.length + chunks < bestBytes) {
      bestBytes = alt.length + chunks;
      bestZlib = new Uint8Array(alt.buffer, alt.byteOffset, alt.length);
    }
  }
  return pngOfForm(width, height, win.form, bestZlib);
}

// ------------------------------------------------------------------------ main

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), encodeBest(image.rgba, image.width, image.height));
}
