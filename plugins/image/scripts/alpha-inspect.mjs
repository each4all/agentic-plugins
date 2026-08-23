#!/usr/bin/env node
// plugins/image/scripts/alpha-inspect.mjs (ADR-0055)
//
// Decide whether a generated image actually carries transparency, by reading
// the pixels — not by trusting a header flag.
//
// The distinction matters and is the whole reason this file exists: a
// `hasAlpha`-style channel check cannot separate a real cutout from an RGBA
// image whose every pixel is opaque (docs/transparency-probe.md § "Alpha
// evidence"). `compose-dispatch.mjs` already refuses to trust Codex's stdout
// for dimensions and sniffs them off the bytes; applying a weaker standard to
// alpha would be inconsistent, so alpha is decoded the same way.
//
// What a positive result means, precisely: at least one decoded pixel is not
// fully opaque. That is a byte-level fact, NOT a judgement that the background
// was cut out well — a stray semi-transparent speckle satisfies it too. The
// probe needed a connected-component pass to say anything about cutout
// quality, and no such claim is made here. The negative result is the strong
// one: zero non-opaque pixels means the request was definitively not honored.
//
// Scope, stated rather than implied:
//   PNG   — full pixel inspection. Colour types 0/2/3/4/6, bit depths 1..16,
//           `tRNS` for 0/2/3, multi-IDAT. Interlaced (Adam7) is REFUSED with a
//           reason, not guessed at — except where the colour type makes
//           transparency impossible, which is decidable without decoding.
//           An APNG's animation frames (`fdAT`) are not walked; the verdict
//           describes the default image in `IDAT`.
//   WebP  — alpha *flag* only (VP8X ALPHA bit / VP8L alpha_is_used). Pixel
//           level would need a VP8/VP8L decoder: out of scope, and reported as
//           inconclusive rather than as a verdict.
//   JPEG  — no alpha channel exists, definitively.
//
// Pure functions over a Buffer; no I/O, no dependencies beyond node:zlib.

import { inflateSync } from 'node:zlib';

// Refuse to inflate a decompression bomb. A 3840x3840 16-bit RGBA image — the
// largest gpt-image-2 can produce (contracts.md §5) — needs ~118 MB raw plus
// one filter byte per row, so this leaves generous headroom while still
// bounding a hostile file. Checked twice: against the size IHDR implies,
// before inflating, and again by zlib itself while inflating.
const MAX_RAW_BYTES = 320 * 1024 * 1024;

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// samples per pixel, by PNG colour type. Index 1 and 5 are not valid types.
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * The shape every branch returns.
 *
 * `transparent` is deliberately three-valued:
 *   true  — at least one non-opaque pixel was decoded
 *   false — proven absent (no alpha channel, or every pixel fully opaque)
 *   null  — could not be determined; `reason` says why
 *
 * `valid` separates the two ways `transparent` can be null, because they
 * deserve different handling: a MALFORMED image (`valid: false`) is a bad
 * result, while a well-formed image this inspector does not decode
 * (`valid: true`, e.g. interlaced) is merely unknown. A caller must not read
 * either null as failure.
 */
function result(fields = {}) {
  return {
    format: null,
    valid: false,
    channel: null,
    transparent: null,
    source: null,
    reason: null,
    ...fields,
  };
}

function isPng(buf) {
  if (buf.length < PNG_SIG.length) return false;
  for (let i = 0; i < PNG_SIG.length; i++) if (buf[i] !== PNG_SIG[i]) return false;
  return true;
}

// Walk the chunk stream once, collecting only what an alpha verdict needs.
// Length-guarded throughout: a truncated file yields what was read so far and
// `truncated: true`, never a throw.
function readPngChunks(buf) {
  const out = { ihdr: null, idat: [], trns: null, plteEntries: 0, truncated: false };
  let o = 8;
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    const dataStart = o + 8;
    const dataEnd = dataStart + len;
    // A declared length running past the buffer means the file is truncated.
    if (dataEnd > buf.length) { out.truncated = true; break; }
    if (type === 'IHDR' && len >= 13) {
      out.ihdr = {
        width: buf.readUInt32BE(dataStart),
        height: buf.readUInt32BE(dataStart + 4),
        bitDepth: buf[dataStart + 8],
        colorType: buf[dataStart + 9],
        interlace: buf[dataStart + 12],
      };
    } else if (type === 'IDAT') {
      out.idat.push(buf.subarray(dataStart, dataEnd));
    } else if (type === 'tRNS') {
      out.trns = buf.subarray(dataStart, dataEnd);
    } else if (type === 'PLTE') {
      out.plteEntries = Math.floor(len / 3);
    } else if (type === 'IEND') {
      break;
    }
    o = dataEnd + 4; // skip the CRC
  }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Reverse the per-scanline filters over the inflated stream.
 * Returns the un-filtered raster (filter bytes removed), or null if the
 * stream is short or carries an unknown filter type.
 */
export function unfilter(raw, width, height, channels, bitDepth) {
  const bitsPerPixel = channels * bitDepth;
  const bytesPerLine = Math.ceil((width * bitsPerPixel) / 8);
  // The filter unit is a whole pixel, or one byte when a pixel is sub-byte.
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  if (raw.length < height * (bytesPerLine + 1)) return null;

  const out = Buffer.allocUnsafe(height * bytesPerLine);
  let ri = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[ri++];
    const cur = ri;
    const lineStart = y * bytesPerLine;
    const prevStart = lineStart - bytesPerLine;
    switch (filter) {
      case 0:
        raw.copy(out, lineStart, cur, cur + bytesPerLine);
        break;
      case 1:
        for (let x = 0; x < bytesPerLine; x++) {
          const a = x >= bpp ? out[lineStart + x - bpp] : 0;
          out[lineStart + x] = (raw[cur + x] + a) & 0xff;
        }
        break;
      case 2:
        for (let x = 0; x < bytesPerLine; x++) {
          const b = y > 0 ? out[prevStart + x] : 0;
          out[lineStart + x] = (raw[cur + x] + b) & 0xff;
        }
        break;
      case 3:
        for (let x = 0; x < bytesPerLine; x++) {
          const a = x >= bpp ? out[lineStart + x - bpp] : 0;
          const b = y > 0 ? out[prevStart + x] : 0;
          out[lineStart + x] = (raw[cur + x] + ((a + b) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let x = 0; x < bytesPerLine; x++) {
          const a = x >= bpp ? out[lineStart + x - bpp] : 0;
          const b = y > 0 ? out[prevStart + x] : 0;
          const c = y > 0 && x >= bpp ? out[prevStart + x - bpp] : 0;
          out[lineStart + x] = (raw[cur + x] + paeth(a, b, c)) & 0xff;
        }
        break;
      default:
        return null; // unknown filter type — do not guess
    }
    ri += bytesPerLine;
  }
  return { raster: out, bytesPerLine };
}

// Read the `i`-th sub-byte sample (bit depth 1/2/4) from a scanline.
function subByteSample(raster, lineStart, i, bitDepth) {
  const perByte = 8 / bitDepth;
  const byte = raster[lineStart + Math.floor(i / perByte)];
  const shift = 8 - bitDepth * ((i % perByte) + 1);
  return (byte >> shift) & ((1 << bitDepth) - 1);
}

function inspectPng(buf) {
  const { ihdr, idat, trns, truncated } = readPngChunks(buf);
  if (!ihdr) return result({ format: 'png', reason: 'no IHDR chunk' });

  const { width, height, bitDepth, colorType, interlace } = ihdr;
  const channels = CHANNELS[colorType];
  if (!channels) return result({ format: 'png', reason: `unsupported colour type ${colorType}` });

  const channelAlpha = colorType === 4 || colorType === 6;
  const channel = channelAlpha || trns != null;

  // No alpha channel and no tRNS: transparency is impossible. This is a real
  // verdict from the format itself — it is how the probe's opaque control arm
  // (colour type 2, no tRNS) is correctly reported as opaque, and it is
  // decided BEFORE the interlace refusal below, because an interlaced image
  // that cannot carry alpha does not need decoding either.
  if (!channel) {
    return result({ format: 'png', valid: true, channel: false, transparent: false, source: 'format' });
  }

  if (interlace !== 0) {
    return result({ format: 'png', valid: true, channel, reason: 'interlaced (Adam7) PNG is not inspected' });
  }
  if (!width || !height) {
    return result({ format: 'png', channel, reason: 'zero-dimension image' });
  }
  if (!idat.length) {
    return result({ format: 'png', channel, reason: truncated ? 'truncated before IDAT' : 'no IDAT chunk' });
  }

  const bytesPerLine = Math.ceil((width * channels * bitDepth) / 8);
  const expected = height * (bytesPerLine + 1);
  if (expected > MAX_RAW_BYTES) {
    return result({ format: 'png', valid: true, channel, reason: 'raster exceeds the inspection size cap' });
  }

  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: MAX_RAW_BYTES });
  } catch (err) {
    return result({ format: 'png', channel, reason: `IDAT inflate failed: ${err && err.message ? err.message : err}` });
  }

  const un = unfilter(raw, width, height, channels, bitDepth);
  if (!un) return result({ format: 'png', channel, reason: 'IDAT stream is short or uses an unknown filter type' });
  const { raster } = un;

  const found = (transparent) => result({ format: 'png', valid: true, channel: true, transparent, source: 'pixels' });
  const max = (1 << bitDepth) - 1; // fully-opaque sample value at this bit depth

  // Colour types 4 and 6 carry alpha as the last sample of every pixel.
  if (channelAlpha) {
    const step = bitDepth === 16 ? channels * 2 : channels;
    const off = bitDepth === 16 ? step - 2 : step - 1;
    const opaque = bitDepth === 16 ? 65535 : 255;
    for (let y = 0; y < height; y++) {
      const lineStart = y * bytesPerLine;
      for (let x = 0; x < width; x++) {
        const at = lineStart + x * step + off;
        const a = bitDepth === 16 ? raster.readUInt16BE(at) : raster[at];
        if (a < opaque) return found(true);
      }
    }
    return found(false);
  }

  // Colour type 3: tRNS is a per-palette-index alpha table; entries beyond its
  // length are opaque. Transparency exists iff some pixel indexes a
  // non-opaque entry — an unused transparent palette slot does NOT count.
  if (colorType === 3) {
    const table = trns;
    let anyNonOpaque = false;
    for (let i = 0; i < table.length; i++) if (table[i] < 255) { anyNonOpaque = true; break; }
    if (!anyNonOpaque) return found(false);
    for (let y = 0; y < height; y++) {
      const lineStart = y * bytesPerLine;
      for (let x = 0; x < width; x++) {
        const idx = bitDepth === 8 ? raster[lineStart + x] : subByteSample(raster, lineStart, x, bitDepth);
        if (idx < table.length && table[idx] < 255) return found(true);
      }
    }
    return found(false);
  }

  // Colour types 0 and 2: tRNS names one fully-transparent sample value
  // (grey, or an RGB triple). Values are stored as 2 bytes each whatever the
  // bit depth, so a sub-16-bit image keeps the value in the low byte.
  if (colorType === 0) {
    if (trns.length < 2) return result({ format: 'png', channel: true, reason: 'malformed tRNS for greyscale' });
    const key = trns.readUInt16BE(0) & max;
    for (let y = 0; y < height; y++) {
      const lineStart = y * bytesPerLine;
      for (let x = 0; x < width; x++) {
        let v;
        if (bitDepth === 16) v = raster.readUInt16BE(lineStart + x * 2);
        else if (bitDepth === 8) v = raster[lineStart + x];
        else v = subByteSample(raster, lineStart, x, bitDepth);
        if (v === key) return found(true);
      }
    }
    return found(false);
  }

  // colorType === 2
  if (trns.length < 6) return result({ format: 'png', channel: true, reason: 'malformed tRNS for truecolour' });
  const kr = trns.readUInt16BE(0) & max;
  const kg = trns.readUInt16BE(2) & max;
  const kb = trns.readUInt16BE(4) & max;
  const wide = bitDepth === 16;
  const step = wide ? 6 : 3;
  for (let y = 0; y < height; y++) {
    const lineStart = y * bytesPerLine;
    for (let x = 0; x < width; x++) {
      const at = lineStart + x * step;
      const r = wide ? raster.readUInt16BE(at) : raster[at];
      const g = wide ? raster.readUInt16BE(at + 2) : raster[at + 1];
      const b = wide ? raster.readUInt16BE(at + 4) : raster[at + 2];
      if (r === kr && g === kg && b === kb) return found(true);
    }
  }
  return found(false);
}

function inspectWebp(buf) {
  const fourcc = buf.toString('ascii', 12, 16);
  const flagOnly = (alpha) => (alpha
    ? result({ format: 'webp', valid: true, channel: true, source: 'flag', reason: 'the webp alpha flag is set, but pixel-level inspection is not supported — a declared channel is not proof that any pixel uses it' })
    : result({ format: 'webp', valid: true, channel: false, transparent: false, source: 'flag' }));
  if (fourcc === 'VP8X' && buf.length >= 21) {
    // VP8X flag byte: bit 4 (0x10) is ALPHA.
    return flagOnly((buf[20] & 0x10) !== 0);
  }
  if (fourcc === 'VP8L' && buf.length >= 26 && buf[20] === 0x2f) {
    // VP8L header bit 28 (after the 0x2f signature) is alpha_is_used.
    return flagOnly(((buf.readUInt32LE(21) >> 28) & 1) === 1);
  }
  if (fourcc === 'VP8 ') {
    // Lossy VP8 without a VP8X container cannot carry an alpha chunk.
    return result({ format: 'webp', valid: true, channel: false, transparent: false, source: 'flag' });
  }
  return result({ format: 'webp', reason: 'unrecognized webp chunk layout' });
}

/**
 * Inspect a whole image buffer for real transparency.
 * Never throws: a malformed file returns a `reason`, not an exception.
 */
export function inspectAlpha(buf) {
  if (!buf || buf.length < 12) return result({ reason: 'buffer too small to identify' });
  try {
    if (isPng(buf)) return inspectPng(buf);
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      // JPEG has no alpha channel at all — a definitive verdict, not a guess.
      return result({ format: 'jpeg', valid: true, channel: false, transparent: false, source: 'format' });
    }
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      return inspectWebp(buf);
    }
  } catch (err) {
    return result({ reason: `inspection failed: ${err && err.message ? err.message : err}` });
  }
  return result({ reason: 'not a recognized image (png/jpeg/webp)' });
}
