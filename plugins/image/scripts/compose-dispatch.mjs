#!/usr/bin/env node
// plugins/image/scripts/compose-dispatch.mjs (ADR-0037, ADR-0055)
//
// Lean L2 image-generation dispatcher. Routes an image prompt to Codex's
// INTEGRATED gpt-image tool through the codex-companion bridge, verifies the
// returned file on the shared filesystem, and writes an ImageResult run
// manifest (see ../docs/contracts.md §4).
//
// This is the CLAUDE-host path: Claude has no native image generation, so it
// dispatches to Codex via the existing companion bridge. On the Codex host the
// model invokes gpt-image natively (no dispatcher needed) and the compose
// skill applies the same background policy by hand.
//
// agentic-plugins NEVER calls the OpenAI image API directly (ADR-0037
// Alternative 6) — generation always rides Codex's own integrated tool and
// auth. No direct image-endpoint call appears anywhere in this file.
//
// CLI:
//   node compose-dispatch.mjs --prompt-file <f> [--run-root <dir>] [--repo-root <dir>]
//                             [--format png|jpeg|webp] [--slug <s>] [--size <s>] [--quality <q>]
//                             [--background opaque|auto|transparent]
//   node compose-dispatch.mjs --prompt "<text>" ...
//   stdout: the ImageResult manifest (JSON); also written to <run-dir>/manifest.json
//   exit 0 on success; exit 1 with a typed error.kind on failure; exit 2 on misuse.

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, statSync, lstatSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';

import { inspectAlpha } from './alpha-inspect.mjs';

// Typed error taxonomy (contracts.md §8). No blind retry of user/auth errors.
// The six image-facing kinds, two transport kinds for malformed/other
// companion failures, and two parameter kinds added with transparency support.
export const ERROR_KINDS = [
  'moderation_blocked',
  'quota_exhausted',
  'peer_cli_not_found',
  'peer_unauthenticated',
  'tool_unavailable',
  'write_failed',
  'malformed_envelope',
  'peer_run_error',
  // Rejected before any spend: the requested parameter set cannot be honored.
  'unsupported_parameters',
  // An explicit transparent request whose returned bytes carry no transparency.
  'background_not_honored',
];

export const FORMATS = ['png', 'jpeg', 'webp'];
export const BACKGROUNDS = ['opaque', 'auto', 'transparent'];
// Transparency is contracted for PNG only — the plugin can verify alpha in PNG
// bytes and cannot in WebP, and an unverifiable transparency claim is exactly
// what ADR-0055 exists to avoid. See contracts.md §5.
export const TRANSPARENT_FORMATS = ['png'];

const MAX_COMPANION_OUTPUT = 4 * 1024 * 1024; // 4 MiB cap on companion stdout/stderr
const MAX_IMAGE_BYTES = 64 * 1024 * 1024; // refuse to treat >64 MiB as a generated image

export function semverCompare(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Locate the companions plugin scripts dir (which ships discover-peer.mjs +
// codex-companion.mjs) — AGENTIC_COMPANIONS_ROOT override, Claude multi-version
// cache (SemVer-highest), or the Codex single marketplace layout.
export function findCompanionsScriptsDir(env = process.env) {
  const root = env.AGENTIC_COMPANIONS_ROOT;
  if (root && existsSync(join(root, 'discover-peer.mjs'))) return root;
  const claudeBase = join(homedir(), '.claude', 'plugins', 'cache', 'agentic-plugins', 'companions');
  if (existsSync(claudeBase)) {
    let versions = [];
    try {
      versions = readdirSync(claudeBase, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(claudeBase, d.name, 'scripts', 'discover-peer.mjs')))
        .map((d) => d.name)
        .sort(semverCompare);
    } catch { /* ignore */ }
    if (versions.length) return join(claudeBase, versions[versions.length - 1], 'scripts');
  }
  const codexDir = join(homedir(), '.codex', '.tmp', 'marketplaces', 'agentic-plugins', 'plugins', 'companions', 'scripts');
  if (existsSync(join(codexDir, 'discover-peer.mjs'))) return codexDir;
  return null;
}

// Resolve codex-companion through the canonical discover-peer.mjs CLI so we
// inherit its manifest verification + --prompt-file/CONTRACT_VERSION preflight
// (rather than blindly picking any cache entry that merely has the file).
export async function findCodexCompanion(env = process.env) {
  const dir = findCompanionsScriptsDir(env);
  if (!dir) return null;
  const discoverPeer = join(dir, 'discover-peer.mjs');
  return new Promise((res) => {
    const child = spawn('node', [discoverPeer, '--peer', 'codex'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { if (out.length < 1 << 16) out += d; });
    child.on('close', (code) => res(code === 0 && out.trim() ? out.trim() : null));
    child.on('error', () => res(null));
  });
}

// Zero-dependency image header sniff (PNG / JPEG / WebP VP8X/VP8/VP8L) — never
// trust the model's self-reported dimensions; read them off the bytes
// (contracts.md §4). Length-guarded so a truncated file returns nulls rather
// than throwing ERR_OUT_OF_RANGE.
export function sniffImage(buf) {
  if (!buf || buf.length < 4) return { format: null, width: null, height: null };
  // PNG: 89 50 4E 47 ; IHDR width@16 height@20 (needs >= 24 bytes). A shorter
  // PNG-signed buffer is truncated/invalid → null (no ERR_OUT_OF_RANGE throw).
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    if (buf.length < 24) return { format: null, width: null, height: null };
    return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: FF D8 ... SOFn marker (FF C0-CF except C4/C8/CC) → height@+5 width@+7
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o + 9 <= buf.length) {
      if (buf[o] !== 0xff) { o++; continue; }
      const m = buf[o + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { format: 'jpeg', height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
      }
      if (m === 0xd8 || m === 0xd9 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
      if (o + 4 > buf.length) break;
      o += 2 + buf.readUInt16BE(o + 2);
    }
    return { format: 'jpeg', width: null, height: null };
  }
  // WebP: 'RIFF'....'WEBP' + a chunk fourcc
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fourcc = buf.toString('ascii', 12, 16);
    if (fourcc === 'VP8X') {
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { format: 'webp', width: w, height: h };
    }
    if (fourcc === 'VP8 ' && buf.length >= 30 && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      const w = (buf[26] | (buf[27] << 8)) & 0x3fff;
      const h = (buf[28] | (buf[29] << 8)) & 0x3fff;
      return { format: 'webp', width: w, height: h };
    }
    if (fourcc === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
      const bits = buf.readUInt32LE(21);
      const w = (bits & 0x3fff) + 1;
      const h = ((bits >> 14) & 0x3fff) + 1;
      return { format: 'webp', width: w, height: h };
    }
    return { format: 'webp', width: null, height: null };
  }
  return { format: null, width: null, height: null };
}

// Classify a companion envelope / exit into the typed taxonomy. Image kinds
// (moderation, quota, tool-unavailable) come from the peer text; transport
// kinds come from the companion's own error.kind. Exit code 3 alone is NOT
// assumed to be auth — codex-companion uses 3 for cli-not-found, auth, AND
// invocation/signal failures, so fall back to peer_run_error without a kind.
export function classifyError(envelope = {}, exitCode = 0) {
  const e = envelope.error || {};
  const k = String(e.kind || '').toLowerCase();
  if (k.includes('not_found')) return 'peer_cli_not_found';
  if (k.includes('unauth') || k.includes('auth')) return 'peer_unauthenticated';
  const text = `${envelope.stdout || ''} ${e.message || ''} ${e.detail || ''}`.toLowerCase();
  if (/moderation|content policy|safety system|flagged|disallowed/.test(text)) return 'moderation_blocked';
  if (/quota|rate limit|billing|insufficient_quota|exceeded/.test(text)) return 'quota_exhausted';
  if (/image generation (tool )?(is )?(not available|unavailable)|no image tool|tool not enabled/.test(text)) return 'tool_unavailable';
  void exitCode;
  return 'peer_run_error';
}

// Render the brief's prompt-mediated parameters into the generation prompt —
// Codex surfaces only the prompt, so size/quality/background must be stated in
// words (contracts.md §5). This is the only channel that can influence
// generation.
export function buildPrompt(userPrompt, outPath, format = 'png', size = null, quality = null, background = null) {
  const fmt = String(format).toUpperCase();
  const lines = [
    'Generate an image using your built-in image generation tool (gpt-image).',
    '',
    `Image description: ${userPrompt}`,
  ];
  const bg = background == null ? null : String(background).toLowerCase();
  // The background clause is phrased positively, with no negation word in it.
  // Negation wording is what defeated the old free-text guard, and a clause
  // that mixes "transparent" with "no backdrop" is ambiguous to read back. The
  // transparent phrasing mirrors Codex's own built-in guidance ("ask built-in
  // image_gen for a transparent background and preserve the generated alpha"),
  // observed in the binary during the 2026-08-23 probe. `auto` states nothing,
  // leaving the choice to the tool.
  if (bg === 'transparent') {
    lines.push('', `Render the subject on a fully transparent background, and preserve the generated alpha channel in the saved ${fmt} file.`);
  } else if (bg === 'opaque') {
    lines.push('', 'Render the image on a fully opaque background.');
  }
  const wants = [];
  if (size) wants.push(`a pixel size of ${size}`);
  if (quality) wants.push(`${quality} quality`);
  if (wants.length) lines.push('', `Render the image at ${wants.join(' and ')} if your tool supports it.`);
  lines.push(
    '',
    `Save the generated image as a ${fmt} file to EXACTLY this absolute path:`,
    outPath,
    '',
    'Write the image ONLY to that path; do not create any other files.',
    'After saving, reply with the absolute path you wrote, the file size in bytes, and the pixel dimensions (width x height).',
    'If you cannot generate it (content moderation, quota/billing, or the image tool is unavailable), do NOT retry — say so explicitly and name the reason.',
  );
  return lines.join('\n');
}

// gpt-image-2 per-image cost is size/quality dependent and prompt-mediated, so
// this is a coarse surfaced estimate — actual spend is billed by Codex/OpenAI.
export function estimateCost(opts = {}) {
  const tier = opts.quality && ['low', 'medium', 'high', 'auto'].includes(opts.quality) ? opts.quality : 'medium';
  const perImage = { low: 0.005, medium: 0.04, high: 0.19, auto: 0.04 }[tier];
  return { estimate_usd: perImage, tier, basis: 'gpt-image-2 approx per-image; prompt-mediated, actual billed by Codex/OpenAI' };
}

// Normalize a requested format, or return null when it is not one this plugin
// can ask for. Unknown values are NOT coerced to png: a silent coercion made
// `--format JPEG` skip the transparency/format policy below while also
// quietly delivering something other than what was asked for.
export function normalizeFormat(format) {
  if (format == null || format === '') return 'png';
  const f = String(format).trim().toLowerCase();
  return FORMATS.includes(f) ? f : null;
}

function isoStamp(now) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function runCompanion(companionPath, promptFile, cwd, env) {
  return new Promise((res) => {
    const child = spawn('node', [companionPath, 'task', '--prompt-file', promptFile, '--cwd', cwd, '--output-format', 'json'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { if (stdout.length < MAX_COMPANION_OUTPUT) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_COMPANION_OUTPUT) stderr += d; });
    child.on('close', (code) => res({ code: code ?? -1, stdout, stderr }));
    child.on('error', (err) => res({ code: -1, stdout: '', stderr: String(err && err.message ? err.message : err) }));
  });
}

// Read at most `len` bytes, so a file that grows between statSync and the read
// cannot force unbounded memory use. Alpha inspection needs the whole raster,
// not just a header, so the cap is the image cap rather than a header window.
function readCapped(path, len) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

export async function dispatch(opts = {}) {
  const env = opts.env || process.env;
  const now = opts.now || new Date();
  const repoRoot = opts.repoRoot || process.cwd();
  const format = normalizeFormat(opts.format);
  const background = opts.background == null ? null : String(opts.background).trim().toLowerCase();

  const baseError = (kind, message, detail = '', extra = {}) => ({
    run_id: opts._runId || null,
    host: 'claude',
    status: 'error',
    brief_ref: opts.briefRef || null,
    prompt: opts._prompt || null,
    requested_parameters: { size: opts.size || null, quality: opts.quality || null, format, background, variants: 1 },
    observed_parameters: null,
    // Whether the companion was actually invoked. A pre-flight rejection still
    // carries a cost ESTIMATE, and without this field that estimate reads as
    // money spent.
    generation_attempted: false,
    images: [],
    failed_outputs: [],
    cost: estimateCost(opts),
    error: { kind, message, detail },
    created_at: now.toISOString(),
    ...extra,
  });

  // ---- Pre-flight ---------------------------------------------------------
  // Before discovery, before any file is written, and above all before any
  // spend. An unhonorable request must not be paid for.
  if (format === null) {
    return baseError(
      'unsupported_parameters',
      `format "${opts.format}" is not one of ${FORMATS.join('|')}`,
      'An unrecognized format is rejected rather than coerced to png, so a typo cannot silently deliver a different format — or skip the transparency/format policy.',
    );
  }
  if (background != null && !BACKGROUNDS.includes(background)) {
    return baseError(
      'unsupported_parameters',
      `background "${opts.background}" is not one of ${BACKGROUNDS.join('|')}`,
      'An unrecognized value is rejected rather than coerced: a silent fallback would generate an opaque image while the caller believed it had asked for transparency.',
    );
  }
  if (background === 'transparent' && !TRANSPARENT_FORMATS.includes(format)) {
    return baseError(
      'unsupported_parameters',
      `a transparent background is contracted for ${TRANSPARENT_FORMATS.join('|')} only, not "${format}"`,
      format === 'jpeg'
        ? 'JPEG has no alpha channel at all. Use png.'
        : 'WebP is alpha-capable, but this plugin inspects webp alpha only at the header-flag level, so a transparent webp result could never be verified — and an unverifiable transparency claim is what this contract exists to prevent. Use png.',
    );
  }

  // Resolution seam. `dispatch` otherwise hard-wires discovery, which leaves
  // no way to exercise the post-generation path — file verification, alpha
  // inspection, the background gate — without a live, billed generation.
  // Overriding it lets a fixture companion stand in; nothing in the plugin
  // sets it.
  const resolveCompanion = opts.findCompanion || findCodexCompanion;
  const companion = await resolveCompanion(env);

  if (!companion) {
    // Honest-scope failure: no reachable Codex bridge (contracts.md §8).
    return baseError(
      'peer_cli_not_found',
      'codex-companion not found — Claude has no native image generation and no reachable Codex bridge.',
      'Install Codex CLI + the companions plugin, or set AGENTIC_COMPANIONS_ROOT.',
    );
  }

  // Resolve + constrain the run dir under the intended artifact root (no escape).
  const defaultRoot = resolve(repoRoot, '.agentic-plugins/runs/image');
  const runRoot = opts.runRoot ? resolve(opts.runRoot) : defaultRoot;
  const runId = `image-${isoStamp(now)}-${opts.rand || Math.random().toString(16).slice(2, 8)}`;
  const runDir = resolve(runRoot, runId);
  const slug = String(opts.slug || 'image').replace(/[^a-z0-9-]/gi, '-').slice(0, 40) || 'image';
  const outPath = resolve(runDir, `${slug}-1.${format}`);
  if (outPath !== runDir + sep + `${slug}-1.${format}`) {
    return baseError('write_failed', 'resolved output path escapes the run directory', outPath);
  }
  const prompt = buildPrompt(opts.promptText, outPath, format, opts.size, opts.quality, background);
  opts._runId = runId;
  opts._prompt = prompt;

  let promptFile;
  try {
    mkdirSync(runDir, { recursive: true });
    promptFile = join(runDir, 'prompt.txt');
    writeFileSync(promptFile, prompt);
  } catch (err) {
    return baseError('write_failed', 'could not create the run directory / prompt file', String(err && err.message ? err.message : err));
  }

  const base = {
    run_id: runId,
    host: 'claude',
    brief_ref: opts.briefRef || null,
    prompt,
    requested_parameters: { size: opts.size || null, quality: opts.quality || null, format, background, variants: 1 },
    generation_attempted: true,
    failed_outputs: [],
    cost: estimateCost(opts),
    created_at: now.toISOString(),
  };
  const finish = (manifest) => {
    try { writeFileSync(join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`); } catch { /* best-effort */ }
    return manifest;
  };

  const { code, stdout, stderr } = await runCompanion(companion, promptFile, repoRoot, env);

  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return finish({ ...base, status: 'error', observed_parameters: null, images: [], error: { kind: 'malformed_envelope', message: 'codex-companion did not return a JSON envelope', detail: (stderr || stdout).slice(0, 500) } });
  }

  // Conjunctive success: the companion contract pins status=success AND exit 0.
  if (!(envelope.status === 'success' && code === 0)) {
    const kind = classifyError(envelope, code);
    return finish({ ...base, status: 'error', observed_parameters: null, images: [], error: { kind, message: (envelope.error && envelope.error.message) || 'image generation failed', detail: String(envelope.stdout || '').slice(0, 500) } });
  }

  // Do NOT trust Codex stdout — verify the file actually landed (contracts.md §4).
  let st;
  try {
    if (!existsSync(outPath)) {
      return finish({ ...base, status: 'error', observed_parameters: null, images: [], error: { kind: 'write_failed', message: 'Codex reported success but no image is at the expected path', detail: outPath } });
    }
    const ls = lstatSync(outPath);
    if (!ls.isFile()) {
      return finish({ ...base, status: 'error', observed_parameters: null, images: [], error: { kind: 'write_failed', message: 'output path is not a regular file (symlink/dir refused)', detail: outPath } });
    }
    st = statSync(outPath);
  } catch (err) {
    return finish({ ...base, status: 'error', observed_parameters: null, images: [], error: { kind: 'write_failed', message: 'could not stat the generated file', detail: String(err && err.message ? err.message : err) } });
  }
  if (st.size === 0) {
    return finish({ ...base, status: 'error', observed_parameters: null, images: [], error: { kind: 'write_failed', message: 'generated image file is empty', detail: outPath } });
  }
  if (st.size > MAX_IMAGE_BYTES) {
    return finish({ ...base, status: 'error', observed_parameters: null, images: [], error: { kind: 'write_failed', message: `generated file exceeds the ${MAX_IMAGE_BYTES}-byte image cap`, detail: `${st.size} bytes` } });
  }

  let bytes;
  let sniff;
  try {
    bytes = readCapped(outPath, Math.min(st.size, MAX_IMAGE_BYTES));
    sniff = sniffImage(bytes);
  } catch (err) {
    return finish({ ...base, status: 'error', observed_parameters: null, images: [], error: { kind: 'write_failed', message: 'could not read the generated file', detail: String(err && err.message ? err.message : err) } });
  }
  if (!sniff.format) {
    // A non-empty file that is not a recognized image is not a valid result.
    return finish({ ...base, status: 'error', observed_parameters: null, images: [], error: { kind: 'write_failed', message: 'returned file is not a recognized image (png/jpeg/webp)', detail: outPath } });
  }

  // Alpha is read from the pixels for the same reason dimensions are: the
  // prompt is the only request channel, so the bytes are the only honest
  // record of what came back. Observed on every successful generation —
  // measured at 36 ms for the largest image gpt-image-2 can produce, against a
  // generation that takes tens of seconds and costs money.
  const alpha = inspectAlpha(bytes);
  const observed = {
    width: sniff.width,
    height: sniff.height,
    format: sniff.format,
    background: alpha.transparent === true ? 'transparent' : (alpha.transparent === false ? 'opaque' : null),
    alpha,
    note: 'sniffed from bytes; Codex surfaces only the prompt, so requested size/quality/background are best-effort. background "transparent" means at least one non-opaque pixel was decoded — a byte-level fact, not a judgement of cutout quality. null means alpha could not be determined (see alpha.reason).',
  };
  const image = { path: outPath, bytes: st.size, width: sniff.width, height: sniff.height, format: sniff.format, selected: false, rejected: false };

  if (background === 'transparent') {
    // A malformed image and an un-inspectable one are different failures. The
    // first is a bad result (`write_failed`); the second is merely unknown and
    // must not be reported as a broken promise.
    if (!alpha.valid) {
      return finish({
        ...base,
        status: 'error',
        observed_parameters: observed,
        images: [],
        failed_outputs: [image],
        error: { kind: 'write_failed', message: 'the generated image could not be decoded, so the transparent-background request could not be verified', detail: `${outPath} — ${alpha.reason || 'unknown decode failure'}` },
      });
    }
    // Only the DEFINITE negative gates. `alpha.transparent === null` means the
    // inspector could not decide, which is recorded and passed through rather
    // than turned into a failure.
    if (alpha.transparent === false) {
      return finish({
        ...base,
        status: 'error',
        observed_parameters: observed,
        // The file landed and was paid for, so it is retained — but NOT in
        // `images[]`, which `image:decide` / `variant-select.mjs` treat as
        // selectable candidates regardless of `status`.
        images: [],
        failed_outputs: [image],
        error: {
          kind: 'background_not_honored',
          message: 'a transparent background was requested but the returned image carries no transparency',
          detail: `${outPath} — alpha channel: ${alpha.channel === true ? 'present, but every pixel is fully opaque' : 'absent'} (source: ${alpha.source || 'unknown'})`,
        },
      });
    }
  }

  return finish({
    ...base,
    status: 'success',
    observed_parameters: observed,
    images: [image],
    error: null,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    let parsed;
    try {
      parsed = parseArgs({
        options: {
          'prompt-file': { type: 'string' },
          prompt: { type: 'string' },
          'run-root': { type: 'string' },
          'repo-root': { type: 'string' },
          format: { type: 'string' },
          slug: { type: 'string' },
          size: { type: 'string' },
          quality: { type: 'string' },
          background: { type: 'string' },
        },
        strict: true,
      });
    } catch (err) {
      console.error(`compose-dispatch: ${err.message}`);
      process.exit(2);
    }
    const v = parsed.values;
    if (v.background != null && !BACKGROUNDS.includes(String(v.background).trim().toLowerCase())) {
      console.error(`compose-dispatch: --background must be one of ${BACKGROUNDS.join('|')}`);
      process.exit(2);
    }
    if (normalizeFormat(v.format) === null) {
      console.error(`compose-dispatch: --format must be one of ${FORMATS.join('|')}`);
      process.exit(2);
    }
    let promptText = v.prompt;
    if (v['prompt-file']) {
      try { promptText = (await import('node:fs')).readFileSync(v['prompt-file'], 'utf8').trim(); } catch (err) {
        console.error(`compose-dispatch: cannot read --prompt-file: ${err.message}`);
        process.exit(2);
      }
    }
    if (!promptText) {
      console.error('compose-dispatch: --prompt or --prompt-file is required');
      process.exit(2);
    }
    const manifest = await dispatch({
      promptText,
      runRoot: v['run-root'],
      repoRoot: v['repo-root'] || process.cwd(),
      format: v.format,
      slug: v.slug,
      size: v.size,
      quality: v.quality,
      background: v.background,
      env: process.env,
    });
    console.log(JSON.stringify(manifest, null, 2));
    process.exit(manifest.status === 'success' ? 0 : 1);
  })();
}
