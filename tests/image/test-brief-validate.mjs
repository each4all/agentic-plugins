// plugins/image brief-validate functional test (ADR-0037 frame slice).
//
// Unit coverage for the ImageBrief output-parameter validator: size grid /
// max-edge / aspect / total-pixel limits, quality/format/variants enums, and
// the ADR-0055 transparent-background contract (contracts.md §5) — which
// replaced a blanket rejection with a request/precedence/format policy.
//
// Run via `node --test tests/image/test-brief-validate.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';

import { parseSize, validateSize, validateBrief, isTransparencyRequest } from '../../plugins/image/scripts/brief-validate.mjs';

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

  it('warns (no longer rejects) an unrecorded transparent-background request', () => {
    // ADR-0055 reversed this: transparency is supported, so a prose request is
    // no longer an error. It is still surfaced, because a request that never
    // reaches output.background cannot be checked against the returned bytes.
    const r = validateBrief({ constraints: ['please use a transparent background'], output: {}, success_criteria: ['x'] });
    ok(r.valid, 'a transparency request is not an error any more');
    ok(r.warnings.some((w) => /transparent/.test(w)), 'but it must not pass silently');
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
  it('rejects a background outside the enum', () => {
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
    const r = validateBrief({ subject: 'a logo on a transparent background', output: {}, success_criteria: ['x'] });
    ok(r.warnings.some((w) => /transparent/.test(w)));
  });
  it('does not flag a negated transparent mention', () => {
    const r = validateBrief({ constraints: ['avoid a transparent background'], output: {}, success_criteria: ['x'] });
    ok(r.valid);
    ok(!r.warnings.some((w) => /transparent/.test(w)));
  });
  it('does not flag transparent as a medium adjective', () => {
    const r = validateBrief({ style: 'transparent watercolor washes', output: {}, success_criteria: ['x'] });
    ok(r.valid);
    ok(!r.warnings.some((w) => /transparent/.test(w)));
  });
});

describe('brief-validate — isTransparencyRequest (ADR-0055 §Guard)', () => {
  // Every row is asserted individually so a regression names the wording that
  // broke, rather than reporting "the table failed". The two rows marked
  // (regression) are the ones the pre-ADR-0055 guard got wrong: it tested
  // negation against the WHOLE field, so a negation word anywhere disarmed it
  // — including the trailing "No backdrop, no white fill" in the probe's own
  // successful transparent prompt.
  const REQUESTS = [
    'transparent background',
    'transparent bg',
    'transparent-background',                                    // (regression) hyphenated form slipped through
    'a glass bottle on a transparent background',
    'transparent background, not opaque',                        // (regression) trailing negation is not a negation of this
    'Render the subject on a fully transparent background with a real alpha channel. No backdrop, no white fill.',
    'background should be transparent',
    'no opaque background; transparent background',              // an earlier negated phrase must not swallow this one
    'see-through background',
    'alpha channel',
  ];
  const NOT_REQUESTS = [
    'no transparent background',
    'avoid a transparent background',
    'without any transparent background',
    'never use a transparent background',
    'non-transparent background',
    'nontransparent background',
    'transparent watercolor washes',                             // a medium adjective, not a background
    'a transparent glass bottle on a white surface',             // a material, not a background
    'background must not be transparent',                        // negation INSIDE the matched span
    'background: not transparent',                               // negation INSIDE the matched span
    'not a see-through background',
    'no alpha channel',
  ];

  for (const text of REQUESTS) {
    it(`reads as a request: "${text.slice(0, 48)}"`, () => strictEqual(isTransparencyRequest(text), true));
  }
  for (const text of NOT_REQUESTS) {
    it(`reads as NOT a request: "${text.slice(0, 48)}"`, () => strictEqual(isTransparencyRequest(text), false));
  }
  it('ignores non-string fields without coercing them', () => {
    strictEqual(isTransparencyRequest(null), false);
    strictEqual(isTransparencyRequest(['transparent background']), false);
  });
});

describe('brief-validate — transparency precedence (ADR-0055 §Decision 2)', () => {
  const base = { success_criteria: ['x'] };

  it('output.background "transparent" is accepted', () => {
    const r = validateBrief({ ...base, output: { background: 'transparent', format: 'png' } });
    ok(r.valid);
  });

  it('prose asking for transparency alongside an explicit "transparent" is silent', () => {
    const r = validateBrief({ ...base, subject: 'a logo on a transparent background', output: { background: 'transparent' } });
    ok(r.valid);
    ok(!r.warnings.some((w) => /transparent/.test(w)), 'the request is already recorded — nothing to say');
  });

  it('prose asking for transparency against an explicit "opaque" is a CONTRADICTION', () => {
    const r = validateBrief({ ...base, subject: 'a logo on a transparent background', output: { background: 'opaque' } });
    ok(!r.valid, 'the prompt would fight the authoritative parameter');
    ok(r.issues.some((i) => /contradiction|authoritative/.test(i)));
  });

  it('prose asking for transparency with background "auto" only warns', () => {
    const r = validateBrief({ ...base, subject: 'a logo on a transparent background', output: { background: 'auto' } });
    ok(r.valid);
    ok(r.warnings.some((w) => /transparent/.test(w)));
  });
});

describe('brief-validate — transparency format policy (ADR-0055 §Decision 3)', () => {
  const base = { success_criteria: ['x'] };

  it('rejects transparent + jpeg — the format has no alpha channel', () => {
    const r = validateBrief({ ...base, output: { background: 'transparent', format: 'jpeg' } });
    ok(!r.valid);
    ok(r.issues.some((i) => /jpeg/i.test(i) && /alpha/i.test(i)));
  });

  it('rejects transparent + webp — capable, but unverifiable here', () => {
    const r = validateBrief({ ...base, output: { background: 'transparent', format: 'webp' } });
    ok(!r.valid);
    ok(r.issues.some((i) => /webp/i.test(i)));
    ok(r.issues.some((i) => !/no alpha channel/i.test(i)), 'must not claim webp is incapable of alpha');
  });

  it('allows transparent + png', () => {
    ok(validateBrief({ ...base, output: { background: 'transparent', format: 'png' } }).valid);
  });

  it('leaves opaque/auto free to use any format', () => {
    for (const format of ['png', 'jpeg', 'webp']) {
      ok(validateBrief({ ...base, output: { background: 'opaque', format } }).valid, `opaque + ${format}`);
      ok(validateBrief({ ...base, output: { background: 'auto', format } }).valid, `auto + ${format}`);
    }
  });
});
