// plugins/image alpha-inspect unit test (ADR-0037 transparency follow-up).
//
// The inspector's whole reason to exist is separating three cases a header
// flag cannot: a real cutout, an RGBA image whose every pixel is opaque, and
// an image with no alpha channel at all. So the FIRST test asserts that
// three-way separation on synthesized fixtures — the same control-first order
// the probe used before pointing its decoder at real output
// (plugins/image/docs/transparency-probe.md § "Alpha evidence"). Every later
// case builds on a control that has already been shown to hold.
//
// Run via `node --test tests/image/test-alpha-inspect.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, match } from 'node:assert/strict';
import { deflateSync } from 'node:zlib';

import { inspectAlpha } from '../../plugins/image/scripts/alpha-inspect.mjs';

// ---------------------------------------------------------------------------
// Minimal PNG encoder — real chunks, real CRCs, real deflate, so the fixtures
// are valid PNGs rather than something shaped only to satisfy this decoder.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
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

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Apply a PNG scanline filter (the encode direction) so the decoder's
// un-filtering is exercised for real, not bypassed with filter 0 everywhere.
function filterLines(lines, bpp, filterType) {
  const out = [];
  let prev = Buffer.alloc(lines[0].length);
  for (const line of lines) {
    const f = Buffer.alloc(line.length);
    for (let x = 0; x < line.length; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v;
      switch (filterType) {
        case 0: v = line[x]; break;
        case 1: v = line[x] - a; break;
        case 2: v = line[x] - b; break;
        case 3: v = line[x] - ((a + b) >> 1); break;
        case 4: v = line[x] - paeth(a, b, c); break;
        default: throw new Error(`bad filter ${filterType}`);
      }
      f[x] = v & 0xff;
    }
    out.push(Buffer.concat([Buffer.from([filterType]), f]));
    prev = line;
  }
  return Buffer.concat(out);
}

function makePng({
  width, height, bitDepth = 8, colorType, lines,
  trns = null, plte = null, interlace = 0, filterType = 0, idatParts = 1,
}) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = interlace;

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8));
  const raw = deflateSync(filterLines(lines, bpp, filterType));

  const parts = [sig, chunk('IHDR', ihdr)];
  if (plte) parts.push(chunk('PLTE', plte));
  if (trns) parts.push(chunk('tRNS', trns));
  if (idatParts > 1) {
    const step = Math.ceil(raw.length / idatParts);
    for (let i = 0; i < raw.length; i += step) parts.push(chunk('IDAT', raw.subarray(i, i + step)));
  } else {
    parts.push(chunk('IDAT', raw));
  }
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// 2x2 RGBA, alpha supplied per pixel.
function rgba(alphas, opts = {}) {
  const lines = [];
  let i = 0;
  for (let y = 0; y < 2; y++) {
    const line = Buffer.alloc(8);
    for (let x = 0; x < 2; x++) {
      line[x * 4] = 10; line[x * 4 + 1] = 20; line[x * 4 + 2] = 30; line[x * 4 + 3] = alphas[i++];
    }
    lines.push(line);
  }
  return makePng({ width: 2, height: 2, colorType: 6, lines, ...opts });
}

// ---------------------------------------------------------------------------

describe('alpha-inspect — the three-way control (run before anything else)', () => {
  // A header flag says "yes" to both of the first two. Only pixel inspection
  // separates them, and that separation is the reason this module exists.
  it('a real cutout is transparent', () => {
    const r = inspectAlpha(rgba([0, 255, 255, 255]));
    strictEqual(r.format, 'png');
    strictEqual(r.channel, true);
    strictEqual(r.transparent, true);
    strictEqual(r.source, 'pixels');
  });

  it('an all-opaque RGBA image has a channel but is NOT transparent', () => {
    const r = inspectAlpha(rgba([255, 255, 255, 255]));
    strictEqual(r.channel, true, 'the alpha channel is present…');
    strictEqual(r.transparent, false, '…but nothing in it is actually transparent');
    strictEqual(r.source, 'pixels');
  });

  it('a plain RGB image has no channel and cannot be transparent', () => {
    const lines = [Buffer.from([1, 2, 3, 4, 5, 6]), Buffer.from([7, 8, 9, 10, 11, 12])];
    const r = inspectAlpha(makePng({ width: 2, height: 2, colorType: 2, lines }));
    strictEqual(r.channel, false);
    strictEqual(r.transparent, false);
    strictEqual(r.source, 'format', 'the format itself settles it — no decode needed');
  });
});

describe('alpha-inspect — un-filtering (every PNG filter type)', () => {
  // Un-filtering is the most defect-prone part of the decoder: a wrong Paeth
  // or Average reconstruction corrupts the alpha bytes and silently flips the
  // verdict. Each filter gets both a transparent and an opaque fixture, so a
  // broken reconstruction cannot pass by accidentally reading 0 everywhere.
  for (const f of [0, 1, 2, 3, 4]) {
    it(`filter ${f}: detects a transparent pixel`, () => {
      strictEqual(inspectAlpha(rgba([0, 255, 255, 255], { filterType: f })).transparent, true);
    });
    it(`filter ${f}: reports an opaque image as opaque`, () => {
      strictEqual(inspectAlpha(rgba([255, 255, 255, 255], { filterType: f })).transparent, false);
    });
  }

  it('a transparent pixel in the LAST row survives reconstruction', () => {
    // Catches an un-filter that stops one scanline early.
    strictEqual(inspectAlpha(rgba([255, 255, 255, 0], { filterType: 4 })).transparent, true);
  });
});

describe('alpha-inspect — colour types and bit depths', () => {
  it('greyscale + alpha (type 4)', () => {
    const lines = [Buffer.from([50, 255, 60, 0]), Buffer.from([70, 255, 80, 255])];
    strictEqual(inspectAlpha(makePng({ width: 2, height: 2, colorType: 4, lines })).transparent, true);
  });

  it('greyscale + alpha, all opaque', () => {
    const lines = [Buffer.from([50, 255, 60, 255]), Buffer.from([70, 255, 80, 255])];
    strictEqual(inspectAlpha(makePng({ width: 2, height: 2, colorType: 4, lines })).transparent, false);
  });

  it('16-bit RGBA: alpha 65534 is transparent, not rounded to opaque', () => {
    // An 8-bit reader looking at the high byte would see 255 and call it
    // opaque. The probe measured a real cutout whose body sat at 254, so
    // near-opaque values must not be quietly treated as opaque.
    const line = Buffer.alloc(16);
    for (let x = 0; x < 2; x++) {
      line.writeUInt16BE(1000, x * 8); line.writeUInt16BE(2000, x * 8 + 2); line.writeUInt16BE(3000, x * 8 + 4);
      line.writeUInt16BE(x === 0 ? 65534 : 65535, x * 8 + 6);
    }
    const opaqueLine = Buffer.alloc(16);
    for (let x = 0; x < 2; x++) opaqueLine.writeUInt16BE(65535, x * 8 + 6);
    strictEqual(inspectAlpha(makePng({ width: 2, height: 2, bitDepth: 16, colorType: 6, lines: [line, opaqueLine] })).transparent, true);
  });

  it('16-bit RGBA, fully opaque', () => {
    const line = Buffer.alloc(16);
    for (let x = 0; x < 2; x++) line.writeUInt16BE(65535, x * 8 + 6);
    strictEqual(inspectAlpha(makePng({ width: 2, height: 2, bitDepth: 16, colorType: 6, lines: [line, line] })).transparent, false);
  });
});

describe('alpha-inspect — tRNS', () => {
  const plte = Buffer.from([0, 0, 0, 255, 255, 255]); // 2 entries

  it('palette (type 3): a pixel using a transparent entry is transparent', () => {
    const lines = [Buffer.from([0, 1]), Buffer.from([1, 1])];
    const r = inspectAlpha(makePng({ width: 2, height: 2, colorType: 3, lines, plte, trns: Buffer.from([0, 255]) }));
    strictEqual(r.channel, true);
    strictEqual(r.transparent, true);
  });

  it('palette: an UNUSED transparent entry does not make the image transparent', () => {
    // The distinction a table-only check would get wrong: entry 0 is
    // transparent, but no pixel references it.
    const lines = [Buffer.from([1, 1]), Buffer.from([1, 1])];
    strictEqual(inspectAlpha(makePng({ width: 2, height: 2, colorType: 3, lines, plte, trns: Buffer.from([0, 255]) })).transparent, false);
  });

  it('palette at bit depth 4 unpacks sub-byte indices', () => {
    // Two 4-bit indices per byte: 0x01 → indices 0 then 1.
    const lines = [Buffer.from([0x01]), Buffer.from([0x11])];
    strictEqual(inspectAlpha(makePng({ width: 2, height: 2, bitDepth: 4, colorType: 3, lines, plte, trns: Buffer.from([0, 255]) })).transparent, true);
  });

  it('greyscale (type 0) tRNS key present', () => {
    const lines = [Buffer.from([7, 200]), Buffer.from([200, 200])];
    const trns = Buffer.alloc(2); trns.writeUInt16BE(7);
    strictEqual(inspectAlpha(makePng({ width: 2, height: 2, colorType: 0, lines, trns })).transparent, true);
  });

  it('greyscale tRNS key absent', () => {
    const lines = [Buffer.from([9, 200]), Buffer.from([200, 200])];
    const trns = Buffer.alloc(2); trns.writeUInt16BE(7);
    strictEqual(inspectAlpha(makePng({ width: 2, height: 2, colorType: 0, lines, trns })).transparent, false);
  });

  it('truecolour (type 2) tRNS key triple present', () => {
    const lines = [Buffer.from([1, 2, 3, 9, 9, 9]), Buffer.from([9, 9, 9, 9, 9, 9])];
    const trns = Buffer.alloc(6);
    trns.writeUInt16BE(1, 0); trns.writeUInt16BE(2, 2); trns.writeUInt16BE(3, 4);
    const r = inspectAlpha(makePng({ width: 2, height: 2, colorType: 2, lines, trns }));
    strictEqual(r.channel, true, 'tRNS gives a type-2 image a transparency channel');
    strictEqual(r.transparent, true);
  });
});

describe('alpha-inspect — structural cases', () => {
  it('reads alpha split across multiple IDAT chunks', () => {
    strictEqual(inspectAlpha(rgba([0, 255, 255, 255], { idatParts: 3 })).transparent, true);
  });

  it('refuses an interlaced PNG instead of guessing', () => {
    const r = inspectAlpha(rgba([0, 255, 255, 255], { interlace: 1 }));
    strictEqual(r.transparent, null, 'unknown, not a verdict');
    strictEqual(r.channel, true);
    match(r.reason, /interlaced/i);
  });

  it('an interlaced image that CANNOT carry alpha is still decided', () => {
    // Adam7 only blocks the pixel scan. A colour type with no alpha channel
    // and no tRNS is settled by the format, so interlacing is irrelevant and
    // answering "unknown" here would be needlessly weak.
    const lines = [Buffer.from([1, 2, 3, 4, 5, 6]), Buffer.from([7, 8, 9, 10, 11, 12])];
    const r = inspectAlpha(makePng({ width: 2, height: 2, colorType: 2, lines, interlace: 1 }));
    strictEqual(r.transparent, false);
    strictEqual(r.source, 'format');
  });

  it('a truncated PNG reports a reason rather than throwing', () => {
    const full = rgba([0, 255, 255, 255]);
    const r = inspectAlpha(full.subarray(0, 30));
    strictEqual(r.transparent, null);
    ok(r.reason, 'must explain why it could not decide');
  });

  it('non-image bytes report a reason', () => {
    strictEqual(inspectAlpha(Buffer.from('definitely not an image, just prose')).transparent, null);
  });

  it('a tiny buffer is handled', () => {
    strictEqual(inspectAlpha(Buffer.from([1, 2, 3])).format, null);
  });
});

describe('alpha-inspect — valid separates "malformed" from "not inspected"', () => {
  // Both leave `transparent` null, and the dispatcher must treat them
  // differently: a corrupt image is a bad result, a well-formed image this
  // module does not decode is merely unknown. Collapsing them would either
  // pass corrupt output off as success or fail perfectly good images.
  it('a corrupt IDAT stream is INVALID', () => {
    const good = rgba([0, 255, 255, 255]);
    // Overwrite the deflate payload, keeping every chunk length intact so the
    // walk still reaches inflate.
    const bad = Buffer.from(good);
    const idat = bad.indexOf(Buffer.from('IDAT', 'ascii'));
    ok(idat > 0, 'fixture must contain an IDAT chunk');
    bad.fill(0x7f, idat + 4, idat + 12);
    const r = inspectAlpha(bad);
    strictEqual(r.transparent, null);
    strictEqual(r.valid, false, 'corrupt bytes are not a valid image');
  });

  it('a truncated PNG is INVALID', () => {
    strictEqual(inspectAlpha(rgba([0, 255, 255, 255]).subarray(0, 30)).valid, false);
  });

  it('an interlaced PNG is VALID but not inspected', () => {
    const r = inspectAlpha(rgba([0, 255, 255, 255], { interlace: 1 }));
    strictEqual(r.transparent, null);
    strictEqual(r.valid, true, 'Adam7 is a legal PNG this module declines to decode');
  });

  it('every conclusive verdict is marked valid', () => {
    for (const buf of [rgba([0, 255, 255, 255]), rgba([255, 255, 255, 255])]) {
      strictEqual(inspectAlpha(buf).valid, true);
    }
  });
});

describe('alpha-inspect — non-PNG formats', () => {
  it('JPEG can never carry alpha', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x00, 0x02, 0x00, 0x03, 0x01, 0x11, 0x00]);
    const r = inspectAlpha(jpeg);
    strictEqual(r.format, 'jpeg');
    strictEqual(r.channel, false);
    strictEqual(r.transparent, false);
    strictEqual(r.source, 'format');
  });

  it('WebP VP8X with the ALPHA flag is inconclusive, not a positive verdict', () => {
    const buf = Buffer.alloc(32);
    buf.write('RIFF', 0, 'ascii'); buf.write('WEBP', 8, 'ascii'); buf.write('VP8X', 12, 'ascii');
    buf[20] = 0x10; // ALPHA flag
    const r = inspectAlpha(buf);
    strictEqual(r.format, 'webp');
    strictEqual(r.channel, true);
    strictEqual(r.transparent, null, 'the flag says a channel exists; it does not say any pixel uses it');
    match(r.reason, /pixel-level/i);
  });

  it('WebP VP8X without the ALPHA flag is a definite no', () => {
    const buf = Buffer.alloc(32);
    buf.write('RIFF', 0, 'ascii'); buf.write('WEBP', 8, 'ascii'); buf.write('VP8X', 12, 'ascii');
    buf[20] = 0x00;
    const r = inspectAlpha(buf);
    strictEqual(r.channel, false);
    strictEqual(r.transparent, false);
  });

  it('lossy VP8 without a VP8X container cannot carry alpha', () => {
    const buf = Buffer.alloc(32);
    buf.write('RIFF', 0, 'ascii'); buf.write('WEBP', 8, 'ascii'); buf.write('VP8 ', 12, 'ascii');
    strictEqual(inspectAlpha(buf).transparent, false);
  });
});
