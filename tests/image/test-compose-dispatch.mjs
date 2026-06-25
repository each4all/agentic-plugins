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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  semverCompare, sniffImage, classifyError, buildPrompt, estimateCost, ERROR_KINDS,
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
