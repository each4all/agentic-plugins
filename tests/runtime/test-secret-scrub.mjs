// Tests for lib/secret-scrub.mjs scrubSecrets, moved with the function out of
// test-egress-channel.mjs (ADR-0064 Decision 2, item 2). The egress payload
// builder that also used it went with ADR-0064 Decision 1.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { scrubSecrets } from '../../plugins/runtime/scripts/lib/secret-scrub.mjs';

describe('scrubSecrets', () => {
  it('redacts a credential-bearing URL', () => {
    const out = scrubSecrets('see https://user:hunter2pw@host.example/path now');
    assert.ok(!out.includes('hunter2pw'));
    assert.match(out, /https:\/\/\[redacted\]@host\.example/);
  });

  it('redacts a bearer token', () => {
    const out = scrubSecrets('Authorization: Bearer abcDEF123456ghiJKL');
    assert.ok(!out.includes('abcDEF123456ghiJKL'));
    assert.match(out, /bearer \[redacted\]/i);
  });

  it('redacts a Telegram-bot-token shape', () => {
    const out = scrubSecrets('token 123456789:AAA_bbbCCCdddEEEfffGGGhhhIII here');
    assert.ok(!out.includes('123456789:AAA'));
    assert.match(out, /\[redacted\]/);
  });

  it('redacts common provider key prefixes incl. AWS AKIA and ASIA (temporary)', () => {
    for (const key of ['sk-abcdef1234567890ABCDEF', 'ghp_abcdefghijklmnop1234', 'AKIAABCDEFGHIJKLMNOP', 'ASIAIOSFODNN7EXAMPLE']) {
      assert.match(scrubSecrets(`k=${key}`), /\[redacted\]/, `${key} should be redacted`);
      assert.ok(!scrubSecrets(`k=${key}`).includes(key), `${key} must not survive`);
    }
  });

  it('leaves ordinary short text untouched', () => {
    assert.equal(scrubSecrets('approval · @mba · repo:main'), 'approval · @mba · repo:main');
  });

  it('does NOT redact structured ids (a long workflow_id / session hash is not a secret)', () => {
    // The bare "long high-entropy run" rule was deliberately dropped: a session
    // hash and a long workflow id are indistinguishable from a raw secret by
    // length, and a `{32,}` rule would eat them.
    const wf = 'investigate-20260705T124630Z-53da47c9f1';
    const hash = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
    assert.equal(scrubSecrets(`wf ${wf} · ${hash}`), `wf ${wf} · ${hash}`);
  });

  it('is null/undefined-safe', () => {
    assert.equal(scrubSecrets(undefined), '');
    assert.equal(scrubSecrets(null), '');
  });
});
