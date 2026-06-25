// plugins/image brief-validate functional test (ADR-0037 frame slice).
//
// Unit coverage for the ImageBrief output-parameter validator: size grid /
// max-edge / aspect / total-pixel limits, quality/format/variants enums, and
// the gpt-image-2 transparent-background rejection (contracts.md §5).
//
// Run via `node --test tests/image/test-brief-validate.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';

import { parseSize, validateSize, validateBrief } from '../../plugins/image/scripts/brief-validate.mjs';

describe('brief-validate — parseSize', () => {
  it('parses WxH', () => deepStrictEqual(parseSize('1024x1024'), { width: 1024, height: 1024 }));
  it('parses the unicode × separator', () => deepStrictEqual(parseSize('1536×1024'), { width: 1536, height: 1024 }));
  it('returns null for junk', () => strictEqual(parseSize('big'), null));
});

describe('brief-validate — validateSize (gpt-image-2 limits)', () => {
  it('accepts a valid size', () => deepStrictEqual(validateSize('1024x1024'), []));
  it('flags off-grid edges (not multiples of 16)', () => ok(validateSize('1000x1000').some((s) => /multiples of 16/.test(s))));
  it('flags a max edge over 3840', () => ok(validateSize('4096x1024').some((s) => /max edge/.test(s))));
  it('flags an aspect over 3:1', () => ok(validateSize('3072x512').some((s) => /aspect/.test(s))));
  it('flags total pixels below the floor', () => ok(validateSize('64x64').some((s) => /total pixels/.test(s))));
  it('flags a non-WxH string', () => ok(validateSize('huge').some((s) => /is not WxH/.test(s))));
});

describe('brief-validate — validateBrief', () => {
  it('a well-formed brief is valid', () => {
    const r = validateBrief({ output: { size: '1024x1024', quality: 'low', format: 'png', variants: 1 }, success_criteria: ['clean blue circle'] });
    strictEqual(r.valid, true);
    deepStrictEqual(r.issues, []);
  });

  it('rejects bad quality and format', () => {
    const r = validateBrief({ output: { quality: 'ultra', format: 'gif' } });
    ok(!r.valid);
    ok(r.issues.some((i) => /quality/.test(i)));
    ok(r.issues.some((i) => /format/.test(i)));
  });

  it('rejects a transparent-background request (gpt-image-2 unsupported)', () => {
    const r = validateBrief({ constraints: ['please use a transparent background'], output: {} });
    ok(!r.valid);
    ok(r.issues.some((i) => /transparent/.test(i)));
  });

  it('rejects an invalid variant count', () => {
    const r = validateBrief({ output: { variants: 0 } });
    ok(!r.valid);
    ok(r.issues.some((i) => /variants/.test(i)));
  });

  it('warns (does not fail) on multi-variant cost', () => {
    const r = validateBrief({ output: { variants: 4 }, success_criteria: ['x'] });
    ok(r.valid);
    ok(r.warnings.some((w) => /cost/.test(w)));
  });

  it('warns when success_criteria is missing', () => {
    const r = validateBrief({ output: { size: '1024x1024' } });
    ok(r.warnings.some((w) => /success_criteria/.test(w)));
  });
});

describe('brief-validate — Codex-review hardening', () => {
  it('accepts size "auto" (contracts §5)', () => {
    strictEqual(parseSize('auto'), 'auto');
    deepStrictEqual(validateSize('auto'), []);
  });
  it('parseSize rejects non-string input (no coercion)', () => {
    strictEqual(parseSize(['1024x1024']), null);
  });
  it('validateBrief(null) returns invalid without throwing', () => {
    const r = validateBrief(null);
    strictEqual(r.valid, false);
    ok(r.issues.some((i) => /JSON object/.test(i)));
  });
  it('validates aspect_ratio independently of size', () => {
    const r = validateBrief({ aspect_ratio: '10:1', output: {} });
    ok(!r.valid);
    ok(r.issues.some((i) => /aspect_ratio/.test(i)));
  });
  it('rejects a non opaque/auto background', () => {
    const r = validateBrief({ output: { background: 'white' } });
    ok(!r.valid);
    ok(r.issues.some((i) => /background/.test(i)));
  });
  it('caps variants at the cost ceiling', () => {
    const r = validateBrief({ output: { variants: 100 }, success_criteria: ['x'] });
    ok(!r.valid);
    ok(r.issues.some((i) => /<= 8/.test(i)));
  });
  it('validates output_compression range', () => {
    const r = validateBrief({ output: { output_compression: 150, format: 'jpeg' } });
    ok(!r.valid);
    ok(r.issues.some((i) => /output_compression/.test(i)));
  });
  it('flags a transparent background in subject, not only constraints', () => {
    const r = validateBrief({ subject: 'a logo on a transparent background', output: {} });
    ok(!r.valid);
    ok(r.issues.some((i) => /transparent/.test(i)));
  });
  it('does not flag a negated transparent mention', () => {
    const r = validateBrief({ constraints: ['avoid a transparent background'], output: {} });
    ok(r.valid);
  });
  it('does not flag transparent as a medium adjective', () => {
    const r = validateBrief({ style: 'transparent watercolor washes', output: {} });
    ok(r.valid);
  });
});
