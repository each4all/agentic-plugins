// Tests for lib/sanitize.mjs — generic value sanitization (ADR-0057 §Decision 3).
// Pure helpers only: line normalization + secret redaction + their composition.
// No artifact writes, no host-config access.
//
// This file was `test-permission-sanitize.mjs`. ADR-0057 measured the module's two
// halves as having disjoint consumers: these four exports had seven non-advisor
// importers, while `tokenizeCommand` / `stripEnvAssignments` / `generalizeCommand`
// had exactly two — the advisor core and the usage learner, both deleted. The
// generalization cases went with the functions they covered; nothing here lost
// coverage, because nothing here ever exercised them.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  singleLine,
  redactSecrets,
  sanitizeValue,
  hasCredentialShape,
} from '../../plugins/runtime/scripts/lib/sanitize.mjs';

describe('sanitize singleLine', () => {
  it('collapses CR/LF/tab and runs of whitespace to a single space', () => {
    assert.equal(singleLine('a\n\tb   c'), 'a b c');
  });
  it('strips all C0 control chars and DEL (settings-grade width)', () => {
    // Built via fromCharCode so no literal control chars live in source.
    const ctrl = String.fromCharCode(0, 7, 31, 127);
    assert.equal(singleLine('a' + ctrl + 'b'), 'a b');
  });
  it('trims leading/trailing whitespace', () => {
    assert.equal(singleLine('  hi  '), 'hi');
  });
  it('coerces null/undefined to empty string', () => {
    assert.equal(singleLine(null), '');
    assert.equal(singleLine(undefined), '');
  });
});

describe('sanitize redactSecrets', () => {
  it('redacts emails', () => {
    assert.match(redactSecrets('contact me@example.com now'), /<redacted-email>/);
  });
  it('redacts GitHub tokens', () => {
    assert.match(redactSecrets('ghp_0123456789abcdefABCD'), /<redacted-token>/);
    assert.match(redactSecrets('github_pat_11AB:CDEF0123456789'), /<redacted-token>/);
  });
  it('redacts OpenAI/Anthropic keys', () => {
    assert.match(redactSecrets('sk-ant-0123456789abcdef'), /<redacted-token>/);
    assert.match(redactSecrets('sk-proj-0123456789abcdef'), /<redacted-token>/);
  });
  it('redacts AWS access keys', () => {
    assert.match(redactSecrets('AKIAIOSFODNN7EXAMPLE'), /<redacted-aws-key>/);
  });
  it('redacts long hex blobs', () => {
    assert.match(redactSecrets('deadbeefdeadbeefdeadbeefdeadbeef'), /<redacted-hex>/);
  });
  it('redacts password= assignments without dropping the key name', () => {
    const out = redactSecrets('password=hunter2 trailing');
    assert.match(out, /password=<redacted>/);
    assert.doesNotMatch(out, /hunter2/);
  });
  it('redacts spaced password assignments (Codex review MAJOR)', () => {
    assert.doesNotMatch(redactSecrets('password = hunter2'), /hunter2/);
  });
  it('redacts bearer tokens including base64 chars (Codex review MAJOR)', () => {
    const out = redactSecrets('Authorization: Bearer abc+def/ghi==');
    assert.match(out, /Bearer <redacted>/);
    assert.doesNotMatch(out, /abc\+def/);
    assert.doesNotMatch(out, /ghi==/);
  });
  it('redacts plain bearer tokens', () => {
    const out = redactSecrets('Bearer abc.def-123_XYZ');
    assert.match(out, /Bearer <redacted>/);
    assert.doesNotMatch(out, /abc\.def-123_XYZ/);
  });
  it('redacts credentials embedded in URLs', () => {
    const out = redactSecrets('https://user:s3cr3t@host.example/path');
    assert.doesNotMatch(out, /s3cr3t/);
    assert.match(out, /<redacted>@host\.example/);
  });
  it('leaves ordinary text untouched', () => {
    assert.equal(redactSecrets('npm run test'), 'npm run test');
  });
});

describe('sanitize sanitizeValue', () => {
  it('returns null for null/undefined (pointer-safe)', () => {
    assert.equal(sanitizeValue(null), null);
    assert.equal(sanitizeValue(undefined), null);
  });
  it('applies singleLine then redactSecrets', () => {
    assert.equal(sanitizeValue('token\nsk-ant-0123456789abcdef'), 'token <redacted-token>');
  });
});

// hasCredentialShape was previously covered only transitively. It is the export
// `machine-profile.mjs` uses as its own secret gate, so it gets a direct case.
describe('sanitize hasCredentialShape', () => {
  it('is true for a credential-shaped token and false for ordinary prose', () => {
    assert.equal(hasCredentialShape('sk-ant-0123456789abcdef'), true);
    assert.equal(hasCredentialShape('a plain sentence with no token'), false);
  });
});
