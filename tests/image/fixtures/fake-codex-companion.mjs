#!/usr/bin/env node
// A stand-in for codex-companion, for tests only.
//
// It speaks the same contract the real bridge does — `task --prompt-file <f>
// --cwd <d> --output-format json`, a JSON envelope on stdout — and it learns
// where to write the same way Codex does: by reading the absolute path out of
// the generated prompt. That means the spawn / envelope-parse / file-verify /
// alpha-inspect chain in compose-dispatch is exercised for real, with no
// network call and no billed generation.
//
// `FAKE_IMAGE_MODE` picks what comes back:
//   transparent  — a PNG with one fully transparent pixel
//   opaque       — an RGBA PNG whose every pixel is opaque (the case a
//                  channel-presence check cannot tell from `transparent`)
//   rgb          — a PNG with no alpha channel at all
//   corrupt      — a PNG whose IDAT payload is garbage
//   interlaced   — an alpha-bearing PNG flagged Adam7. The inspector decides
//                  on the IHDR interlace byte and returns before touching the
//                  pixels, so the scanlines are deliberately left progressive:
//                  this fixture exists to reach the "valid, but not inspected"
//                  state, not to be a conformant Adam7 encoder.
//   nofile       — reports success without writing anything
//
// A critique prompt (it names no output path) gets an assessment that ends in
// "verdict: pass"; `FAKE_ASSESSMENT_BYTES=<n>` pads it with n ASCII bytes
// before the verdict, so a test can push a critique result past a pipe's
// 64 KiB. When `FAKE_COMPANION_LOG` names a file, the fixture appends one line
// to it as it starts, so a test can order what the dispatcher wrote before the
// spawn against the spawn itself.
//
// The fixture delivers its envelope whole: an exit waits for the write's
// callback, and each branch returns once it has scheduled one. Exiting at once
// would drop what a pipe has not taken yet, and a test past 64 KiB would then
// measure the fixture's truncation instead of the dispatcher's.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

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

function png(mode) {
  const colorType = mode === 'rgb' ? 2 : 6;
  const channels = colorType === 2 ? 3 : 4;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  if (mode === 'interlaced') ihdr[12] = 1;

  const lines = [];
  for (let y = 0; y < 2; y++) {
    const line = Buffer.alloc(1 + 2 * channels); // leading filter byte 0
    for (let x = 0; x < 2; x++) {
      const at = 1 + x * channels;
      line[at] = 10; line[at + 1] = 20; line[at + 2] = 30;
      if (channels === 4) {
        // Only the very first pixel is transparent, and only in that mode.
        line[at + 3] = mode === 'transparent' && x === 0 && y === 0 ? 0 : 255;
      }
    }
    lines.push(line);
  }
  const idat = mode === 'corrupt' ? Buffer.alloc(32, 0x7f) : deflateSync(Buffer.concat(lines));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Write the envelope, then exit once the write has been taken.
function reply(envelope, code) {
  process.stdout.write(JSON.stringify(envelope), () => process.exit(code));
}

function main() {
  const promptFileIdx = process.argv.indexOf('--prompt-file');
  if (promptFileIdx < 0) {
    reply({ status: 'error', error: { kind: 'misuse', message: 'no --prompt-file' } }, 2);
    return;
  }
  if (process.env.FAKE_COMPANION_LOG) appendFileSync(process.env.FAKE_COMPANION_LOG, 'companion ran\n');
  const prompt = readFileSync(process.argv[promptFileIdx + 1], 'utf8');
  const m = prompt.match(/EXACTLY this absolute path:\n(.+)/);
  if (!m && prompt.startsWith('You are evaluating an image.')) {
    const pad = 'x'.repeat(Number(process.env.FAKE_ASSESSMENT_BYTES) || 0);
    reply({ status: 'success', stdout: `A 2x2 square of dark blue. ${pad ? `${pad} ` : ''}verdict: pass` }, 0);
    return;
  }
  if (!m) {
    reply({ status: 'error', error: { kind: 'misuse', message: 'no output path in prompt' } }, 2);
    return;
  }
  const outPath = m[1].trim();
  const mode = process.env.FAKE_IMAGE_MODE || 'opaque';

  if (mode !== 'nofile') writeFileSync(outPath, png(mode));
  process.stdout.write(JSON.stringify({
    status: 'success',
    stdout: `wrote ${outPath} (fixture, mode=${mode})`,
  }));
}

main();
