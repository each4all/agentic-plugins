// plugins/image compose-dispatch functional test (ADR-0037 compose-core).
//
// Unit coverage for the lean image-generation dispatcher: companion
// discovery ordering, zero-dep image sniffing, the typed error taxonomy,
// the generate+save prompt contract, cost surfacing — plus two ADR-0037
// guards: the dispatcher calls NO direct OpenAI API and passes NO sandbox
// bypass flag to the companion (generation rides Codex's integrated tool).
//
// Run via `node --test tests/image/test-compose-dispatch.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual, match } from 'node:assert/strict';
import { readFileSync, mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  semverCompare, sniffImage, classifyError, buildPrompt, estimateCost, ERROR_KINDS,
  normalizeFormat, dispatch, BACKGROUNDS, TRANSPARENT_FORMATS,
} from '../../plugins/image/scripts/compose-dispatch.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const DISPATCH_SRC = readFileSync(resolve(REPO_ROOT, 'plugins/image/scripts/compose-dispatch.mjs'), 'utf8');

describe('compose-dispatch — semverCompare', () => {
  it('orders SemVer numerically (not lexically)', () => {
    ok(semverCompare('0.4.0', '0.10.0') < 0, '0.4.0 < 0.10.0');
    strictEqual(semverCompare('1.2.3', '1.2.3'), 0);
    ok(semverCompare('0.5.0', '0.4.9') > 0);
  });
});

describe('compose-dispatch — sniffImage (zero-dep, off the bytes)', () => {
  it('reads PNG IHDR width/height', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 4, 0, 0, 0, 2, 0x40]);
    deepStrictEqual(sniffImage(png), { format: 'png', width: 1024, height: 576 });
  });

  it('detects JPEG SOF0 dimensions', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x00, 0x02, 0x00, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
    const r = sniffImage(jpeg);
    strictEqual(r.format, 'jpeg');
    strictEqual(r.height, 256);
    strictEqual(r.width, 512);
  });

  it('returns a null format for non-image bytes', () => {
    strictEqual(sniffImage(Buffer.from('this is not an image at all')).format, null);
  });

  it('returns nulls (no throw) on a truncated PNG-like buffer (< 24 bytes)', () => {
    const trunc = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
    strictEqual(sniffImage(trunc).format, null);
  });
});

describe('compose-dispatch — classifyError typed taxonomy', () => {
  it('moderation from peer text', () => strictEqual(classifyError({ stdout: 'request was blocked by our content policy' }, 1), 'moderation_blocked'));
  it('quota from error message', () => strictEqual(classifyError({ error: { message: 'insufficient_quota / billing' } }, 1), 'quota_exhausted'));
  it('cli-not-found from companion kind', () => strictEqual(classifyError({ error: { kind: 'peer_cli_not_found' } }, 3), 'peer_cli_not_found'));
  it('exit code 3 without a kind is peer_run_error (not assumed auth)', () => strictEqual(classifyError({}, 3), 'peer_run_error'));
  it('unauthenticated only from an explicit auth kind', () => strictEqual(classifyError({ error: { kind: 'peer_unauthenticated' } }, 3), 'peer_unauthenticated'));
  it('tool unavailable from peer text', () => strictEqual(classifyError({ stdout: 'the image generation tool is not available in this session' }, 1), 'tool_unavailable'));
  it('falls back to peer_run_error', () => strictEqual(classifyError({ stdout: 'some other failure' }, 1), 'peer_run_error'));
  it('all surfaced kinds are in the exported taxonomy', () => {
    for (const k of ['moderation_blocked', 'quota_exhausted', 'peer_cli_not_found', 'peer_unauthenticated', 'tool_unavailable', 'write_failed']) {
      ok(ERROR_KINDS.includes(k), `${k} must be a declared error kind`);
    }
  });
});

describe('compose-dispatch — buildPrompt (generate+save contract)', () => {
  it('renders the tool instruction, the exact output path, and the no-retry rule', () => {
    const p = buildPrompt('a blue circle', '/runs/x/img-1.png', 'png');
    match(p, /image generation tool/i);
    ok(p.includes('/runs/x/img-1.png'), 'must embed the exact absolute output path');
    match(p, /EXACTLY this absolute path/);
    match(p, /do NOT retry/i);
  });

  it('renders size and quality into the prompt when provided (the only channel that influences generation)', () => {
    const p = buildPrompt('a circle', '/runs/x.png', 'png', '1024x1024', 'low');
    ok(p.includes('1024x1024'), 'size must be rendered into the prompt');
    ok(/low quality/i.test(p), 'quality must be rendered into the prompt');
  });
});

describe('compose-dispatch — estimateCost (surfaced, not hidden)', () => {
  it('maps quality tiers to per-image estimates', () => {
    strictEqual(estimateCost({ quality: 'low' }).estimate_usd, 0.005);
    strictEqual(estimateCost({ quality: 'high' }).estimate_usd, 0.19);
    strictEqual(estimateCost({}).tier, 'medium');
  });
});

describe('compose-dispatch — ADR-0037 guards (no direct API, no sandbox bypass)', () => {
  it('contains no direct OpenAI image API call form', () => {
    ok(!/\bimages\s*\.\s*(generate|edit|createVariation)\s*\(/.test(DISPATCH_SRC), 'no images.generate(');
    ok(!/api\.openai\.com/.test(DISPATCH_SRC), 'no api.openai.com');
    ok(!/\bnew\s+OpenAI\b/.test(DISPATCH_SRC), 'no new OpenAI()');
    ok(!/\bOPENAI_API_KEY\b/.test(DISPATCH_SRC), 'no OPENAI_API_KEY');
    ok(!/from\s+['"]openai['"]/.test(DISPATCH_SRC), 'no openai import');
  });

  it('never passes a sandbox/approval bypass flag to the companion', () => {
    ok(!/dangerously-bypass/.test(DISPATCH_SRC), 'must not bypass Codex sandbox/approvals (ADR-0037 §integration)');
    ok(!/--skip-git-repo-check/.test(DISPATCH_SRC));
  });

  it('invokes codex-companion via the task subcommand with JSON output', () => {
    match(DISPATCH_SRC, /'task'/, 'dispatches the companion task subcommand');
    match(DISPATCH_SRC, /--output-format/, 'reads a structured envelope');
  });
});

describe('compose-dispatch — normalizeFormat (no silent coercion)', () => {
  it('defaults an absent format to png', () => {
    for (const v of [undefined, null, '']) strictEqual(normalizeFormat(v), 'png');
  });

  it('normalizes case and surrounding space', () => {
    strictEqual(normalizeFormat('PNG'), 'png');
    strictEqual(normalizeFormat(' JPEG '), 'jpeg');
  });

  it('returns null for an unknown format instead of falling back to png', () => {
    // The old fallback made `--format jpg` silently deliver a PNG — and, once
    // transparency existed, silently skip the transparent+jpeg policy too.
    for (const v of ['jpg', 'gif', 'tiff']) strictEqual(normalizeFormat(v), null, v);
  });
});

describe('compose-dispatch — buildPrompt background clause (ADR-0055)', () => {
  const clauseOf = (p) => p.split('\n').find((l) => /background/i.test(l)) || '';

  it('renders a transparent request and names the alpha channel', () => {
    const c = clauseOf(buildPrompt('a logo', '/runs/x/a-1.png', 'png', null, null, 'transparent'));
    match(c, /transparent background/i);
    match(c, /alpha channel/i);
  });

  it('the background clause itself carries no negation word', () => {
    // Scoped to the clause on purpose: the surrounding prompt legitimately
    // says "do not create any other files" and "do NOT retry", and asserting
    // over the whole prompt would pressure those safeguards out.
    const c = clauseOf(buildPrompt('a logo', '/runs/x/a-1.png', 'png', null, null, 'transparent'));
    ok(!/\b(?:no|not|without|never|avoid)\b/i.test(c), `clause must be phrased positively, got: ${c}`);
  });

  it('renders an opaque request', () => {
    match(clauseOf(buildPrompt('a logo', '/runs/x/a-1.png', 'png', null, null, 'opaque')), /opaque background/i);
  });

  it('says nothing about the background for auto or when unset', () => {
    for (const bg of ['auto', null]) {
      const p = buildPrompt('a logo', '/runs/x/a-1.png', 'png', null, null, bg);
      ok(!/background/i.test(p), `background must be left to the tool for ${bg}`);
    }
  });

  it('still renders the path, size and quality alongside a background', () => {
    const p = buildPrompt('a logo', '/runs/x/a-1.png', 'png', '1024x1024', 'high', 'transparent');
    ok(p.includes('/runs/x/a-1.png'));
    ok(p.includes('1024x1024'));
    match(p, /high quality/i);
  });
});

// A fixture companion stands in for codex-companion: it speaks the same
// contract and writes a synthesized PNG, so the spawn / envelope / verify /
// inspect chain runs for real with no network call and no billed generation.
// Every dispatch test injects it — including the pre-flight ones, where a
// regression that skipped the check would otherwise fall through to a LIVE,
// billed companion instead of failing the test.
const FAKE_COMPANION = resolve(REPO_ROOT, 'tests/image/fixtures/fake-codex-companion.mjs');
const withFake = (mode = 'opaque') => ({
  findCompanion: async () => FAKE_COMPANION,
  env: { ...process.env, FAKE_IMAGE_MODE: mode },
});

describe('compose-dispatch — pre-flight rejection (before any spend)', () => {
  // Each case must return BEFORE the run directory is created, which is itself
  // before the companion is invoked. `run_id` is assigned only after the
  // pre-flight, so a null id plus an empty run root proves nothing was
  // started — and would fail if the check were moved later.
  const preflight = async (opts) => {
    const runRoot = mkdtempSync(join(tmpdir(), 'image-preflight-'));
    const manifest = await dispatch({ promptText: 'a logo', runRoot, ...withFake(), ...opts });
    return { manifest, runRoot, entries: readdirSync(runRoot) };
  };

  it('rejects transparent + jpeg without spending', async () => {
    const { manifest, entries } = await preflight({ format: 'jpeg', background: 'transparent' });
    strictEqual(manifest.status, 'error');
    strictEqual(manifest.error.kind, 'unsupported_parameters');
    strictEqual(manifest.run_id, null, 'no run was started');
    strictEqual(manifest.generation_attempted, false, 'the cost estimate must not read as spend');
    deepStrictEqual(entries, [], 'no run directory may be created');
  });

  it('rejects transparent + webp as unverifiable, not as incapable', async () => {
    const { manifest } = await preflight({ format: 'webp', background: 'transparent' });
    strictEqual(manifest.error.kind, 'unsupported_parameters');
    ok(!/no alpha channel/i.test(manifest.error.detail), 'webp does support alpha — the plugin cannot verify it');
    match(manifest.error.detail, /verif/i);
  });

  it('rejects an unknown background rather than coercing it', async () => {
    const { manifest, entries } = await preflight({ background: 'transparant' });
    strictEqual(manifest.error.kind, 'unsupported_parameters');
    deepStrictEqual(entries, []);
  });

  it('rejects an unknown format rather than coercing it to png', async () => {
    const { manifest } = await preflight({ format: 'jpg' });
    strictEqual(manifest.error.kind, 'unsupported_parameters');
    match(manifest.error.message, /format/);
  });

  it('records the requested background on the rejection manifest', async () => {
    const { manifest } = await preflight({ format: 'jpeg', background: 'transparent' });
    strictEqual(manifest.requested_parameters.background, 'transparent');
    strictEqual(manifest.requested_parameters.format, 'jpeg');
  });

  it('runs the pre-flight before companion discovery', () => {
    // The assertions above prove "before the run dir" behaviourally — with the
    // fixture injected, a skipped check would create one. Discovery happens
    // earlier still and spawns a process of its own, so its position is
    // pinned structurally.
    const preflightAt = DISPATCH_SRC.indexOf('---- Pre-flight');
    const discoveryAt = DISPATCH_SRC.indexOf('await resolveCompanion(env)');
    ok(preflightAt > 0 && discoveryAt > 0, 'both anchors must exist');
    ok(preflightAt < discoveryAt, 'the pre-flight must precede discovery — resolving a companion spawns a process');
  });
});

describe('compose-dispatch — transparency contract surface', () => {
  it('declares both new error kinds', () => {
    for (const k of ['unsupported_parameters', 'background_not_honored']) {
      ok(ERROR_KINDS.includes(k), `${k} must be a declared error kind`);
    }
  });

  it('contracts transparency for png only', () => {
    deepStrictEqual(TRANSPARENT_FORMATS, ['png']);
    ok(BACKGROUNDS.includes('transparent'));
  });

});

describe('compose-dispatch — the background gate, end to end through a fixture companion', () => {
  const run = async (mode, opts = {}) => {
    const runRoot = mkdtempSync(join(tmpdir(), 'image-gate-'));
    return dispatch({ promptText: 'a logo', runRoot, ...withFake(mode), ...opts });
  };

  it('a honored transparent request succeeds and records what the bytes showed', async () => {
    const m = await run('transparent', { background: 'transparent' });
    strictEqual(m.status, 'success');
    strictEqual(m.observed_parameters.background, 'transparent');
    strictEqual(m.observed_parameters.alpha.source, 'pixels', 'decided by decoding, not by a header flag');
    strictEqual(m.images.length, 1);
    strictEqual(m.generation_attempted, true);
  });

  it('an UNHONORED transparent request fails, even though the file is a valid image', async () => {
    // The fixture returns an RGBA png whose every pixel is opaque — the exact
    // case a channel-presence check would pass.
    const m = await run('opaque', { background: 'transparent' });
    strictEqual(m.status, 'error');
    strictEqual(m.error.kind, 'background_not_honored');
    strictEqual(m.observed_parameters.alpha.channel, true, 'the channel IS present…');
    strictEqual(m.observed_parameters.alpha.transparent, false, '…and every pixel in it is opaque');
  });

  it('the unhonored file is retained, but never as a selectable candidate', async () => {
    // `variant-select.mjs` and the decide skill treat every images[] entry as
    // selectable without consulting `status`, so the retained file goes to
    // failed_outputs[] instead.
    const m = await run('opaque', { background: 'transparent' });
    deepStrictEqual(m.images, []);
    strictEqual(m.failed_outputs.length, 1);
    ok(existsSync(m.failed_outputs[0].path), 'the file it names is really there');
  });

  it('a request that comes back with no alpha channel at all also fails', async () => {
    const m = await run('rgb', { background: 'transparent' });
    strictEqual(m.error.kind, 'background_not_honored');
    strictEqual(m.observed_parameters.alpha.channel, false);
  });

  it('an undecodable image is write_failed, not a broken promise', async () => {
    const m = await run('corrupt', { background: 'transparent' });
    strictEqual(m.error.kind, 'write_failed', 'corrupt bytes are a bad result, not an unhonored request');
    strictEqual(m.observed_parameters.alpha.valid, false);
  });

  it('an UNDECIDED inspection succeeds — only the definite negative fails', async () => {
    // A valid image the inspector declines to decode (interlaced PNG) leaves
    // `transparent: null`. Failing here would turn "we could not tell" into
    // "the request was broken", which is the distinction `valid` exists for —
    // and it is a state a real Codex response can reach, so it is exercised
    // rather than only documented.
    const m = await run('interlaced', { background: 'transparent' });
    strictEqual(m.status, 'success');
    strictEqual(m.observed_parameters.alpha.valid, true);
    strictEqual(m.observed_parameters.alpha.transparent, null);
    strictEqual(m.observed_parameters.background, null, 'undecided is recorded as undecided');
    ok(m.observed_parameters.alpha.reason, 'and it says why');
    strictEqual(m.images.length, 1, 'the image is still a usable candidate');
  });

  it('opaque and auto requests are NEVER gated on alpha', async () => {
    for (const background of ['opaque', 'auto', undefined]) {
      const m = await run('rgb', { background });
      strictEqual(m.status, 'success', `background=${background} must not fail on alpha`);
      strictEqual(m.observed_parameters.background, 'opaque', 'the observation is still recorded');
    }
  });

  it('records the alpha observation even when nobody asked about it', async () => {
    const m = await run('transparent', { background: 'auto' });
    strictEqual(m.status, 'success');
    strictEqual(m.observed_parameters.alpha.transparent, true);
  });

  it('renders the transparent clause into the prompt the companion actually receives', async () => {
    // Not just into the manifest: the fixture reads the prompt FILE, the same
    // way Codex does, so this pins the clause on the path that reaches the tool.
    const m = await run('transparent', { background: 'transparent' });
    match(m.prompt, /fully transparent background/i);
    match(readFileSync(join(dirname(m.images[0].path), 'prompt.txt'), 'utf8'), /fully transparent background/i);
  });
});
