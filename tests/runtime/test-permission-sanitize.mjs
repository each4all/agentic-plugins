// Tests for the shared permission-advisor sanitize util (ADR-0038 §5).
// Pure helpers only: pattern generalization + secret redaction + line
// normalization. No artifact writes, no host-config access.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  singleLine,
  redactSecrets,
  sanitizeValue,
  generalizeCommand,
} from '../../plugins/runtime/scripts/lib/permission-sanitize.mjs';

describe('permission-sanitize singleLine', () => {
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

describe('permission-sanitize redactSecrets', () => {
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

describe('permission-sanitize sanitizeValue', () => {
  it('returns null for null/undefined (pointer-safe)', () => {
    assert.equal(sanitizeValue(null), null);
    assert.equal(sanitizeValue(undefined), null);
  });
  it('applies singleLine then redactSecrets', () => {
    assert.equal(sanitizeValue('token\nsk-ant-0123456789abcdef'), 'token <redacted-token>');
  });
});

describe('permission-sanitize generalizeCommand', () => {
  it('keeps a known wrapper subcommand and drops args (ADR-0038 §5)', () => {
    assert.equal(generalizeCommand('npm run test'), 'npm run *');
    assert.equal(generalizeCommand('git commit -m "msg"'), 'git commit *');
  });
  it('keeps only the program when the 2nd token is a flag/path', () => {
    assert.equal(generalizeCommand('ls -la'), 'ls *');
    assert.equal(generalizeCommand('node script.mjs --key=secret'), 'node *');
  });
  it('drops a bare positional 2nd token for non-wrapper tools (Codex review MAJOR)', () => {
    // `mysql` is not a subcommand wrapper, so `hunter2` (a positional that
    // could be a password) must not survive as a kept token.
    const out = generalizeCommand('mysql hunter2 --flag');
    assert.equal(out, 'mysql *');
    assert.doesNotMatch(out, /hunter2/);
  });
  it('returns a bare command with no args unchanged', () => {
    assert.equal(generalizeCommand('git status'), 'git status');
  });
  it('never retains a secret-shaped argument', () => {
    const out = generalizeCommand('curl https://user:p@ss@host -H "Authorization: Bearer sk-ant-0123456789abcdef"');
    assert.doesNotMatch(out, /sk-ant-0123456789abcdef/);
    assert.doesNotMatch(out, /p@ss/);
    assert.equal(out, 'curl *');
  });
  it('returns empty string for empty/whitespace/nullish input', () => {
    assert.equal(generalizeCommand('   '), '');
    assert.equal(generalizeCommand(''), '');
    assert.equal(generalizeCommand(null), '');
  });
  it('normalizes control chars before tokenizing', () => {
    assert.equal(generalizeCommand('npm\trun\ntest'), 'npm run *');
  });
  // Plan-verify MAJOR #2 — an env-injected secret must never survive as the
  // kept program token (generalizeCommand must mirror gradeCommand's env strip).
  it('strips leading FOO=bar env prefixes (no secret leak)', () => {
    assert.equal(generalizeCommand('TOKEN=sk-ant-0123456789abcdef npm test'), 'npm test');
    assert.equal(generalizeCommand('AWS_SECRET=AKIAEXAMPLEONLY00000 aws s3 ls'), 'aws *');
    const out = generalizeCommand('GITHUB_TOKEN=ghp_EXAMPLEONLYnotarealtoken00 gh repo view');
    assert.ok(!out.includes('ghp_'), `leaked token: ${out}`);
  });
  // Plan-verify MINOR #6 — a path-shaped program must be basenamed so a private
  // directory is never retained in the pattern.
  it('basenames a path-shaped program', () => {
    assert.equal(generalizeCommand('/usr/local/bin/node script.mjs'), 'node *');
    assert.equal(generalizeCommand('/Users/alice/private-tools/scan --target x'), 'scan *');
    assert.equal(generalizeCommand('/usr/bin/git status'), 'git status');
  });

  // Refine-verify BLOCKER — the env-prefix strip above was written against a
  // naive `split(' ')`, which tears a QUOTED value containing a space in half.
  // The assignment-shaped head was dropped and the orphaned tail was PROMOTED
  // into the program slot, where it is emitted verbatim into the rule pattern,
  // the JSON report, the text output, and the written advisory artifact:
  //
  //   TOKEN="first s3cr3t" npm test   ->   s3cr3t" *
  //
  // The unquoted case had already been hardened twice (see the comments this
  // suite's subject replaced); only the quoted mirror was left open. These pins
  // close it, and the fail-closed cases prove an undecidable boundary drops the
  // observation rather than guessing.
  it('does not leak a secret from a QUOTED env assignment (the split(" ") mirror)', () => {
    const canary = 'SUPERSECRETCANARY';
    for (const raw of [
      `TOKEN="first ${canary}" npm test`,
      `TOKEN='first ${canary}' npm test`,
      `AWS_SECRET_ACCESS_KEY="${canary} tail" aws s3 ls`,
    ]) {
      const out = generalizeCommand(raw);
      assert.ok(!out.includes(canary), `leaked canary from ${raw}: ${out}`);
      assert.ok(!/["']/.test(out), `quote survived into the pattern from ${raw}: ${out}`);
    }
    // The command itself still generalizes normally — the fix must not blunt it.
    assert.equal(generalizeCommand(`TOKEN="first ${canary}" npm test`), 'npm test');
    assert.equal(generalizeCommand(`AWS_SECRET_ACCESS_KEY="${canary} tail" aws s3 ls`), 'aws *');
  });

  it('fails closed when a quote boundary is undecidable', () => {
    // An unbalanced quote means we cannot prove the program token is not part of
    // the quoted value. Callers drop an empty pattern (permission-usage-learner
    // skips it; isValidRule rejects it), so dropping the observation is strictly
    // safer than emitting a possibly-leaking one.
    assert.equal(generalizeCommand('TOKEN="unterminated npm test'), '');
    assert.equal(generalizeCommand('TOKEN="a b"'), '');
  });
});
