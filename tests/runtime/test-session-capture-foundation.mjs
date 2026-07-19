// ADR-0044 S2 foundation tests: the `session` config family, the shared
// effective-config loader, and the three load-bearing session-capture
// schemas (session-capture-contract.md §11 S2 obligations).
//
// Mutation discipline: every rejection case is paired with a passing
// control case first, so a green run proves the gate bites rather than the
// fixture never reaching it.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CONFIG_KEYS,
  CONFIG_KEY_FAMILIES,
  SESSION_CAPTURE_MODES,
  SESSION_KEY_DEFAULTS,
  loadEffectiveConfig,
  loadSessionConfig,
  validateConfigValue,
} from '../../plugins/runtime/scripts/lib/runtime-config.mjs';
import {
  PACKAGED_SCHEMA_FILES,
  assertSupportedSchema,
  loadSchema,
  validateAgainstSchema,
} from '../../plugins/runtime/scripts/lib/schema-validate.mjs';

async function makeConfigFixture({ repoToml = null, userToml = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'session-config-'));
  const repoRoot = join(root, 'repo');
  const homeDir = join(root, 'home');
  await mkdir(join(repoRoot, '.agentic-plugins'), { recursive: true });
  await mkdir(join(homeDir, '.agentic-plugins'), { recursive: true });
  if (repoToml !== null) await writeFile(join(repoRoot, '.agentic-plugins', 'config.toml'), repoToml);
  if (userToml !== null) await writeFile(join(homeDir, '.agentic-plugins', 'config.toml'), userToml);
  return {
    repoRoot,
    homeDir,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('session config family (ADR-0044 §3)', () => {
  it('registers session_capture as its own family with the shipped default off', () => {
    // ADR-0045 S7b widened the family with the user-scope-only entry-brief
    // pair; loadSessionConfig still resolves only session_capture (the
    // capture gate and the entry gate are independent failure domains).
    deepStrictEqual([...CONFIG_KEY_FAMILIES.session], ['session_capture', 'entry_brief', 'entry_brief_empty']);
    ok(CONFIG_KEYS.includes('session_capture'), 'session_capture derives into CONFIG_KEYS');
    strictEqual(SESSION_KEY_DEFAULTS.session_capture, 'off');
    deepStrictEqual([...SESSION_CAPTURE_MODES], ['off', 'stop-hook']);
  });

  it('accepts exactly the enum and rejects everything else', () => {
    for (const value of SESSION_CAPTURE_MODES) {
      validateConfigValue('session_capture', value); // control: must not throw
    }
    for (const bad of ['on', 'true', 'stop_hook', 'Stop-Hook', '']) {
      throws(
        () => validateConfigValue('session_capture', bad),
        /session_capture must be one of off, stop-hook/,
        `rejects ${JSON.stringify(bad)}`,
      );
    }
  });
});

describe('loadSessionConfig (repo → user → shipped default)', () => {
  it('falls back to the shipped default when no layer sets the key', async () => {
    const fx = await makeConfigFixture();
    try {
      const loaded = loadSessionConfig({ repoRoot: fx.repoRoot, homeDir: fx.homeDir });
      strictEqual(loaded.ok, true, loaded.errors?.join('; '));
      strictEqual(loaded.config.sessionCapture, 'off');
    } finally {
      await fx.cleanup();
    }
  });

  it('reads the user-global layer and lets repo config shadow it', async () => {
    const fx = await makeConfigFixture({
      repoToml: 'session_capture = "off"\n',
      userToml: 'session_capture = "stop-hook"\n',
    });
    try {
      const loaded = loadSessionConfig({ repoRoot: fx.repoRoot, homeDir: fx.homeDir });
      strictEqual(loaded.ok, true);
      strictEqual(loaded.config.sessionCapture, 'off', 'repo layer wins over user layer');

      const userOnly = loadSessionConfig({ repoRoot: join(fx.repoRoot, '..'), homeDir: fx.homeDir });
      strictEqual(userOnly.ok, true);
      strictEqual(userOnly.config.sessionCapture, 'stop-hook', 'user layer wins over the default');
    } finally {
      await fx.cleanup();
    }
  });

  it('fail-closes on an invalid effective value', async () => {
    const fx = await makeConfigFixture({ repoToml: 'session_capture = "always"\n' });
    try {
      const loaded = loadSessionConfig({ repoRoot: fx.repoRoot, homeDir: fx.homeDir });
      strictEqual(loaded.ok, false);
      strictEqual(loaded.config, null);
      ok(loaded.errors.some((e) => /session_capture must be one of/.test(e)), loaded.errors.join('; '));
    } finally {
      await fx.cleanup();
    }
  });

  it('fail-closes when a config layer exists but is unreadable (EISDIR, not ENOENT)', async () => {
    const fx = await makeConfigFixture({ userToml: 'session_capture = "stop-hook"\n' });
    try {
      // A config.toml that is a DIRECTORY is present-but-unreadable — the
      // shared loader must fail closed rather than let the user layer flip
      // the gate while the higher-precedence repo layer is broken.
      await mkdir(join(fx.repoRoot, '.agentic-plugins', 'config.toml'));
      const loaded = loadSessionConfig({ repoRoot: fx.repoRoot, homeDir: fx.homeDir });
      strictEqual(loaded.ok, false);
      ok(loaded.errors.some((e) => /fail-closed/.test(e)), loaded.errors.join('; '));
    } finally {
      await fx.cleanup();
    }
  });

  it('preserves an explicit empty higher-precedence value and fail-closes on it (no gate flip)', async () => {
    // Before the S2 hardening, `session_capture = ""` in the repo layer was
    // silently dropped by the parser and a user-layer "stop-hook" became
    // effective — a lower layer flipping a gate the higher layer set.
    const fx = await makeConfigFixture({
      repoToml: 'session_capture = ""\n',
      userToml: 'session_capture = "stop-hook"\n',
    });
    try {
      const loaded = loadSessionConfig({ repoRoot: fx.repoRoot, homeDir: fx.homeDir });
      strictEqual(loaded.ok, false, 'an explicit empty value must fail closed, never fall through');
      ok(loaded.errors.some((e) => /session_capture must be one of/.test(e)), loaded.errors.join('; '));
    } finally {
      await fx.cleanup();
    }
  });

  it('ignores keys under a [table] header — the config surface is flat-key', async () => {
    const fx = await makeConfigFixture({
      repoToml: '[some.table]\nsession_capture = "stop-hook"\n',
    });
    try {
      const loaded = loadSessionConfig({ repoRoot: fx.repoRoot, homeDir: fx.homeDir });
      strictEqual(loaded.ok, true);
      strictEqual(loaded.config.sessionCapture, 'off', 'a table-scoped key must not read as the global gate key');
    } finally {
      await fx.cleanup();
    }
  });

  it('shares the generic core: loadEffectiveConfig honors explicit keys and defaults', async () => {
    const fx = await makeConfigFixture({ userToml: 'session_capture = "stop-hook"\nnotify_channel = "file-log"\n' });
    try {
      const loaded = loadEffectiveConfig({
        repoRoot: fx.repoRoot,
        homeDir: fx.homeDir,
        keys: ['session_capture'],
        defaults: SESSION_KEY_DEFAULTS,
      });
      strictEqual(loaded.ok, true);
      deepStrictEqual(loaded.effective, { session_capture: 'stop-hook' }, 'only the requested keys are resolved');
    } finally {
      await fx.cleanup();
    }
  });
});

describe('session-capture schemas are load-bearing (contract §3)', () => {
  const FAMILIES = ['runtime-session-capture', 'runtime-session-entry', 'runtime-session-note'];

  const VALID = {
    'runtime-session-capture': {
      schema: 'runtime-session-capture-1.0',
      captured_at: '2026-07-18T12:00:00Z',
      origin: 'stop-hook',
      summary_source: 'staged-note',
      host: 'claude',
      session_id: 'abc-123',
      repo_recent_terminal_evidence: 'none',
      repo_root: '/tmp/repo',
      branch: 'main',
      head_short: '42bbad3',
      dirty_count: 2,
      status_digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      note: {
        staged_at: '2026-07-18T11:00:00Z',
        host: null,
        branch: 'main',
        head_short: '42bbad3',
        content: 'working on the capture foundation',
        content_hash: `sha256:${'a'.repeat(64)}`,
      },
      fingerprint: `fp1:${'b'.repeat(64)}`,
    },
    'runtime-session-entry': {
      schema: 'runtime-session-entry-1.0',
      captured_at: '2026-07-18T12:00:00Z',
      origin: 'stop-hook',
      summary_source: 'structural',
      host: 'claude',
      branch: null,
      head_short: null,
      dirty_count: null,
      repo_recent_terminal_evidence: 'fresh',
      summary_line: null,
      note_staged_at: null,
      fingerprint: `fp1:${'b'.repeat(64)}`,
    },
    'runtime-session-note': {
      schema: 'runtime-session-note-1.0',
      staged_at: '2026-07-18T11:00:00Z',
      host: 'codex',
      branch: null,
      head_short: null,
      content: 'a staged note\nwith a second line',
      content_hash: `sha256:${'c'.repeat(64)}`,
    },
  };

  it('every session family is packaged, loads, and uses only supported constraints', async () => {
    for (const family of FAMILIES) {
      ok(PACKAGED_SCHEMA_FILES[family], `${family} is registered in PACKAGED_SCHEMA_FILES`);
      const schema = await loadSchema(family);
      strictEqual(schema.$id, `${family}-1.0`);
      deepStrictEqual(assertSupportedSchema(schema), [], `${family} carries no unimplemented constraint`);
    }
  });

  it('accepts a canonical-valid document per family (control cases)', async () => {
    for (const family of FAMILIES) {
      const schema = await loadSchema(family);
      const result = validateAgainstSchema(VALID[family], schema, { readerVersion: `${family}-1.0` });
      strictEqual(result.ok, true, `${family}: ${JSON.stringify(result.errors)}`);
    }
  });

  it('rejects an unknown key at any depth — including an imperative field on entry', async () => {
    for (const [family, extra] of [
      ['runtime-session-capture', { publisher_pid: 123 }],
      ['runtime-session-entry', { next_action: 'run this command' }],
      ['runtime-session-note', { note_kind: 'todo' }],
    ]) {
      const schema = await loadSchema(family);
      const mutated = { ...VALID[family], ...extra };
      const result = validateAgainstSchema(mutated, schema, { readerVersion: `${family}-1.0` });
      strictEqual(result.ok, false, `${family} must reject unknown key ${Object.keys(extra)[0]}`);
    }
  });

  it('rejects wrong-family and wrong-shape schema ids', async () => {
    const schema = await loadSchema('runtime-session-entry');
    for (const badSchemaId of ['runtime-session-capture-1.0', 'runtime-session-entry-2.0', 'not-a-version']) {
      const result = validateAgainstSchema(
        { ...VALID['runtime-session-entry'], schema: badSchemaId },
        schema,
        { readerVersion: 'runtime-session-entry-1.0' },
      );
      strictEqual(result.ok, false, `entry must reject schema id ${badSchemaId}`);
    }
  });

  it('enforces the single-line and format clamps (mutation cases)', async () => {
    const entrySchema = await loadSchema('runtime-session-entry');
    const multiLine = validateAgainstSchema(
      { ...VALID['runtime-session-entry'], summary_source: 'staged-note', summary_line: 'first\nsecond', note_staged_at: '2026-07-18T11:00:00Z' },
      entrySchema,
      { readerVersion: 'runtime-session-entry-1.0' },
    );
    strictEqual(multiLine.ok, false, 'multi-line summary_line is rejected');

    const overlong = validateAgainstSchema(
      { ...VALID['runtime-session-entry'], summary_source: 'staged-note', summary_line: 'x'.repeat(161), note_staged_at: '2026-07-18T11:00:00Z' },
      entrySchema,
      { readerVersion: 'runtime-session-entry-1.0' },
    );
    strictEqual(overlong.ok, false, 'a 161-char summary_line is rejected (contract §4 clamp)');

    const captureSchema = await loadSchema('runtime-session-capture');
    const badFingerprint = validateAgainstSchema(
      { ...VALID['runtime-session-capture'], fingerprint: 'sha256:not-fp1' },
      captureSchema,
      { readerVersion: 'runtime-session-capture-1.0' },
    );
    strictEqual(badFingerprint.ok, false, 'a non-fp1 fingerprint is rejected');

    const noteSchema = await loadSchema('runtime-session-note');
    const badHash = validateAgainstSchema(
      { ...VALID['runtime-session-note'], content_hash: 'md5:abc' },
      noteSchema,
      { readerVersion: 'runtime-session-note-1.0' },
    );
    strictEqual(badHash.ok, false, 'a non-sha256 content_hash is rejected');
  });

  it('rejects prototype-named keys smuggled through JSON.parse (closed-schema hardening)', async () => {
    const entrySchema = await loadSchema('runtime-session-entry');
    const base = JSON.stringify(VALID['runtime-session-entry']);
    for (const smuggled of ['"constructor":"echo pwned"', '"toString":"x"', '"__proto__":{"polluted":1}', '"hasOwnProperty":"y"']) {
      const doc = JSON.parse(`${base.slice(0, -1)},${smuggled}}`);
      const result = validateAgainstSchema(doc, entrySchema, { readerVersion: 'runtime-session-entry-1.0' });
      strictEqual(result.ok, false, `entry must reject prototype-named key in ${smuggled}`);
    }
  });

  it('rejects a newer-minor document outright — session families are strict-versioned', async () => {
    const entrySchema = await loadSchema('runtime-session-entry');
    const doc = { ...VALID['runtime-session-entry'], schema: 'runtime-session-entry-1.1', next_action: 'run this command' };
    const result = validateAgainstSchema(doc, entrySchema, { readerVersion: 'runtime-session-entry-1.0' });
    strictEqual(result.ok, false, 'a 1.1 document with a smuggled scalar imperative must be rejected, not forgiven');
  });

  it('excludes the full C0 range from single-line fields, not just CR/LF', async () => {
    const entrySchema = await loadSchema('runtime-session-entry');
    for (const [label, bad] of [['tab', 'a\tb'], ['escape', 'a\u001bb'], ['DEL', 'a\u007fb'], ['NUL', 'a\u0000b']]) {
      const doc = { ...VALID['runtime-session-entry'], summary_source: 'staged-note', summary_line: bad, note_staged_at: '2026-07-18T11:00:00Z' };
      const result = validateAgainstSchema(doc, entrySchema, { readerVersion: 'runtime-session-entry-1.0' });
      strictEqual(result.ok, false, `summary_line containing ${label} is rejected`);
    }
  });

  it('treats nullability as explicit, not as omission', async () => {
    const captureSchema = await loadSchema('runtime-session-capture');
    const { session_id: _dropped, ...withoutSessionId } = VALID['runtime-session-capture'];
    const omitted = validateAgainstSchema(withoutSessionId, captureSchema, { readerVersion: 'runtime-session-capture-1.0' });
    strictEqual(omitted.ok, false, 'omitting a required nullable field is rejected — absence is null, not omission');

    const nulled = validateAgainstSchema(
      { ...VALID['runtime-session-capture'], session_id: null, branch: null, head_short: null, dirty_count: null, status_digest: null, note: null, summary_source: 'structural' },
      captureSchema,
      { readerVersion: 'runtime-session-capture-1.0' },
    );
    strictEqual(nulled.ok, true, `null-degraded slot still validates: ${JSON.stringify(nulled.errors)}`);
  });
});
