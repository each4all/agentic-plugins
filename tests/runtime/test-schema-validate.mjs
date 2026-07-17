// tests/runtime/test-schema-validate.mjs — machine-bootstrap-contract.md §4.1, §11.1.
//
// §11.1 is explicit that prose tokens are a FLOOR, not the enforcement: "Tests MUST
// validate REAL artifacts against those schemas". So the packaged plugin-set is
// validated here as itself, not as a fixture that resembles it.
//
// The validator's own closed keyword subset is tested first, because everything else
// rests on it: a validator that ignores a keyword it does not implement turns every
// constraint below into a suggestion.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual, throws } from 'node:assert';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SCHEMA_MAX_BYTES,
  assertSupportedSchema,
  canonicalJson,
  canonicalize,
  compareSchemaVersion,
  loadSchema,
  makeDefValidator,
  makeValidator,
  parseSchemaVersion,
  validateAgainstSchema,
} from '../../plugins/runtime/scripts/lib/schema-validate.mjs';
import { loadPluginSet } from '../../plugins/runtime/scripts/lib/plugin-set.mjs';
import { createBootstrapRun, scanBootstrapRuns, writeBootstrapProof } from '../../plugins/runtime/scripts/lib/bootstrap-artifacts.mjs';

const READER = 'agentic-machine-profile-1.0';

// A minimal schema in the supported subset, for the validator's own unit tests.
const TOY = {
  type: 'object',
  additionalProperties: false,
  required: ['schema', 'name'],
  properties: {
    // Pins family+major and leaves the MINOR free — the same shape the packaged
    // schemas use, and for the same reason: a `const` on the full version string
    // would reject the newer-minor documents §4.1's forward-compat rule accepts.
    schema: { type: 'string', pattern: '^agentic-machine-profile-1\\.[0-9]+$' },
    name: { type: 'string', maxLength: 8 },
    tags: { type: 'array', maxItems: 2, items: { type: 'string' } },
    nested: {
      type: 'object',
      additionalProperties: false,
      properties: { deep: { type: ['string', 'null'] } },
    },
  },
};

const toy = (over = {}) => ({ schema: READER, name: 'ok', ...over });

describe('runtime schema validator — the keyword subset is closed', () => {
  // The load-bearing property: an unimplemented keyword must be an ERROR against the
  // schema, never silently skipped. `maxitems: 256` reading as "capped" while capping
  // nothing is a constraint that exists only in the author's head.
  it('rejects a schema carrying a keyword the validator does not implement', () => {
    for (const bad of [
      { type: 'object', oneOf: [{ type: 'string' }] },
      { type: 'array', uniqueItems: true },
      { type: 'string', format: 'email' },
      { type: 'array', maxitems: 256 },
      { type: 'integer', minimum: 1 },
      { type: 'object', properties: { a: { type: 'string', maxLenght: 4 } } },
    ]) {
      const errors = assertSupportedSchema(bad);
      ok(errors.length > 0, `rejects ${JSON.stringify(bad)}`);
      match(errors.join(' '), /unsupported schema keyword|silently does not apply/);
    }
  });

  it('rejects additionalProperties other than false — the closed-schema rule has one form', () => {
    ok(assertSupportedSchema({ type: 'object', additionalProperties: true }).length > 0);
    ok(assertSupportedSchema({ type: 'object', additionalProperties: { type: 'string' } }).length > 0);
    deepStrictEqual(assertSupportedSchema({ type: 'object', additionalProperties: false }), []);
  });

  it('validating against an unsupported schema THROWS — it is a bug here, not bad data', () => {
    throws(() => validateAgainstSchema(toy(), { type: 'object', anyOf: [] }, { readerVersion: READER }), /not supported by this validator/);
  });

  it('every packaged schema is inside the subset', async () => {
    for (const family of ['agentic-machine-profile', 'runtime-bootstrap-run', 'runtime-plugin-set']) {
      const schema = await loadSchema(family);
      deepStrictEqual(assertSupportedSchema(schema), [], `${family} uses only implemented keywords`);
    }
  });
});

describe('runtime schema validator — version gate (#18)', () => {
  it('parses and compares schema versions', () => {
    deepStrictEqual(parseSchemaVersion('agentic-machine-profile-1.0'), { family: 'agentic-machine-profile', major: 1, minor: 0, version: 'agentic-machine-profile-1.0' });
    strictEqual(parseSchemaVersion('nope'), null);
    strictEqual(parseSchemaVersion('agentic-machine-profile-1'), null, 'a bare major is not a schema version — the minor is what the forward-compat rule turns on');
  });

  it('an unknown MAJOR is rejected with a diagnostic, never read as if it were known', () => {
    const result = validateAgainstSchema({ ...toy(), schema: 'agentic-machine-profile-2.0' }, TOY, { readerVersion: READER });
    strictEqual(result.ok, false);
    strictEqual(result.version.reason, 'unknown-major');
    match(result.errors[0], /major 2 is not readable|upgrade the runtime plugin/);
  });

  it('an ADDITIVE minor is accepted, and its unknown SCALAR keys are ignored with a warning', () => {
    const result = validateAgainstSchema(
      { schema: 'agentic-machine-profile-1.7', name: 'ok', future_scalar: 'hello', another: 42 },
      TOY,
      { readerVersion: READER },
    );
    strictEqual(result.ok, true, `expected accept, got ${result.errors.join('; ')}`);
    strictEqual(result.version.reason, 'newer-minor');
    strictEqual(result.warnings.length, 2, 'each ignored key is warned about, not silently dropped');
    match(result.warnings[0], /unknown scalar key ignored/);
  });

  it('a newer minor does NOT forgive an unknown STRUCTURAL key, at any depth', () => {
    for (const doc of [
      { schema: 'agentic-machine-profile-1.7', name: 'ok', future_object: { a: 1 } },
      { schema: 'agentic-machine-profile-1.7', name: 'ok', future_array: [1] },
      { schema: 'agentic-machine-profile-1.7', name: 'ok', nested: { deep: null, future_object: { a: 1 } } },
    ]) {
      const result = validateAgainstSchema(doc, TOY, { readerVersion: READER });
      strictEqual(result.ok, false, `structural key refused: ${JSON.stringify(doc)}`);
      match(result.errors.join(' '), /unknown structural keys are refused at any schema minor/);
    }
  });

  it('a same-or-older minor has no excuse for an unknown key, even a scalar', () => {
    for (const version of ['agentic-machine-profile-1.0', 'agentic-machine-profile-1.0']) {
      const result = validateAgainstSchema({ schema: version, name: 'ok', stray: 'x' }, TOY, { readerVersion: READER });
      strictEqual(result.ok, false);
      match(result.errors.join(' '), /is not newer than this runtime's/);
    }
  });

  it('a wrong family is rejected — a profile is not a run manifest', () => {
    const result = validateAgainstSchema({ ...toy(), schema: 'runtime-bootstrap-run-1.0' }, TOY, { readerVersion: READER });
    strictEqual(result.ok, false);
    strictEqual(result.version.reason, 'wrong-family');
  });

  it('a missing or malformed schema string is rejected, not defaulted', () => {
    for (const doc of [{ name: 'ok' }, { schema: 42, name: 'ok' }, { schema: 'garbage', name: 'ok' }]) {
      strictEqual(validateAgainstSchema(doc, TOY, { readerVersion: READER }).ok, false);
    }
  });

  it('an invalid READER version throws — that is a programming error, not data', () => {
    throws(() => compareSchemaVersion(READER, 'not-a-version'), /reader schema version/);
  });
});

describe('runtime schema validator — caps are refusals, not truncations', () => {
  it('maxItems refuses the artifact and says so', () => {
    const result = validateAgainstSchema(toy({ tags: ['a', 'b', 'c'] }), TOY, { readerVersion: READER });
    strictEqual(result.ok, false);
    match(result.errors[0], /exceeds maxItems 2 — the artifact is refused, not truncated/);
  });

  it('the 64 KiB artifact cap is measured in BYTES, not code units', () => {
    strictEqual(SCHEMA_MAX_BYTES, 64 * 1024);
    // Multi-byte characters: 40k of them is ~120 KB but only 40k `length`. A cap
    // counting code units would wave this through.
    const fat = { schema: READER, name: 'ok', nested: { deep: '가'.repeat(40_000) } };
    const result = validateAgainstSchema(fat, TOY, { readerVersion: READER });
    strictEqual(result.ok, false);
    match(result.errors.join(' '), /over the 65536-byte cap — refused, not truncated/);
    ok(result.bytes > 64 * 1024);
  });

  it('an unserializable document is reported, not thrown', () => {
    const circular = toy();
    circular.nested = { deep: null };
    circular.self = circular;
    const result = validateAgainstSchema(circular, TOY, { readerVersion: READER });
    strictEqual(result.ok, false);
    match(result.errors.join(' '), /not serializable as JSON|unknown/);
  });
});

describe('runtime schema validator — structural checks', () => {
  it('enforces type, const, enum, pattern, maxLength, required', () => {
    const cases = [
      [toy({ name: 42 }), /expected string, got number/],
      [toy({ name: 'far-too-long-a-name' }), /exceeds maxLength 8/],
      [{ schema: READER }, /missing required key 'name'/],
      [toy({ nested: { deep: 5 } }), /expected string \| null, got number/],
    ];
    for (const [doc, re] of cases) {
      const result = validateAgainstSchema(doc, TOY, { readerVersion: READER });
      strictEqual(result.ok, false, JSON.stringify(doc));
      match(result.errors.join(' '), re);
    }
  });

  it('a nullable union accepts null AND the type', () => {
    strictEqual(validateAgainstSchema(toy({ nested: { deep: null } }), TOY, { readerVersion: READER }).ok, true);
    strictEqual(validateAgainstSchema(toy({ nested: { deep: 'x' } }), TOY, { readerVersion: READER }).ok, true);
  });
});

describe('runtime schema validator — canonical order (§4.1)', () => {
  it('derives canonical order from the SCHEMA, so there is no second list to drift', () => {
    // Built in deliberately wrong order.
    const scrambled = { name: 'ok', nested: { deep: 'x' }, schema: READER };
    deepStrictEqual(Object.keys(canonicalize(scrambled, TOY)), ['schema', 'name', 'nested']);
    strictEqual(canonicalJson(scrambled, TOY), `${JSON.stringify({ schema: READER, name: 'ok', nested: { deep: 'x' } }, null, 2)}\n`);
  });

  it('canonicalization is idempotent and order-insensitive — two builders hash alike', () => {
    const a = { schema: READER, name: 'ok', tags: ['x'] };
    const b = { tags: ['x'], name: 'ok', schema: READER };
    strictEqual(canonicalJson(a, TOY), canonicalJson(b, TOY));
    strictEqual(canonicalJson(canonicalize(b, TOY), TOY), canonicalJson(b, TOY));
  });

  it('keys the schema does not name are SORTED, not left in builder order', () => {
    const doc = { name: 'ok', zz: 'last', schema: 'agentic-machine-profile-1.7', aa: 'also' };
    deepStrictEqual(Object.keys(canonicalize(doc, TOY)), ['schema', 'name', 'aa', 'zz']);
    // Two builders that assembled the same facts in different orders must hash alike —
    // which is the entire reason canonicalization exists.
    const other = { schema: 'agentic-machine-profile-1.7', aa: 'also', zz: 'last', name: 'ok' };
    strictEqual(canonicalJson(doc, TOY), canonicalJson(other, TOY));
  });

  // A newer minor may legitimately carry unknown SCALAR keys — including ones named
  // after Object.prototype members. `key in out` walks the prototype chain, so those
  // read as "already emitted" and vanish: silent data loss in a hashing path.
  it('does not drop keys that collide with Object.prototype names', () => {
    const doc = { schema: 'agentic-machine-profile-1.7', name: 'ok', constructor: 'future', toString: 'v', hasOwnProperty: 'z' };
    const out = canonicalize(doc, TOY);
    for (const key of ['constructor', 'toString', 'hasOwnProperty']) {
      ok(Object.hasOwn(out, key), `${key} survives canonicalization`);
      strictEqual(out[key], doc[key]);
    }
    // And the document round-trips through validation as a genuine newer-minor doc.
    strictEqual(validateAgainstSchema(doc, TOY, { readerVersion: READER }).ok, true);
  });
});

describe('runtime schema validator — REAL artifacts (§11.1)', () => {
  // The packaged plugin-set is validated as ITSELF. §11.1: "Tests MUST validate real
  // artifacts against those schemas" — a fixture that resembles the artifact proves
  // the fixture, and the shipped file is what a consumer actually reads.
  it('the shipped data/plugin-set.json validates against the packaged schema', async () => {
    const pluginSet = await loadPluginSet();
    const schema = await loadSchema('runtime-plugin-set');
    const result = validateAgainstSchema(pluginSet, schema, { readerVersion: 'runtime-plugin-set-1.0' });
    strictEqual(result.ok, true, `shipped plugin-set.json is invalid:\n  ${result.errors.join('\n  ')}`);
    deepStrictEqual(result.warnings, []);
  });

  it('the shipped plugin-set is canonically ordered on disk — the file IS the canonical form', async () => {
    const pluginSet = await loadPluginSet();
    const schema = await loadSchema('runtime-plugin-set');
    deepStrictEqual(Object.keys(pluginSet), Object.keys(canonicalize(pluginSet, schema)));
  });

  // The seam C3 left open, now closed. Asserting the validator in isolation would
  // prove the validator; this proves the WIRING — that a bad artifact is actually
  // refused by the writer a caller reaches for, and that nothing lands on disk.
  it('the packaged validator plugs into the storage writers and refuses a bad artifact end-to-end', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'agentic-schema-'));
    const validate = await makeValidator('runtime-bootstrap-run');

    // boundary.* must ALL be false (§5) — the schema is where that is enforced, so a
    // true flag must never reach disk through the writer.
    const bad = await createBootstrapRun({
      homeDir,
      repoRoot: null,
      now: new Date('2026-07-17T09:00:00Z'),
      validate,
      manifest: {
        schema: 'runtime-bootstrap-run-1.0',
        selection: { bundle: 'base', desired: ['runtime', 'companions'], excluded: [] },
        steps: [],
        boundary: { writes_host_config: true, writes_credential: false, writes_config_local_toml: false, performs_network_request: false },
      },
    });
    strictEqual(bad.created, false, 'a boundary-violating manifest is refused');
    strictEqual(bad.reason, 'invalid-manifest');
    match(bad.diagnostics.join(' '), /must equal false/);
    strictEqual((await scanBootstrapRuns({ homeDir })).runs.length, 0, 'and nothing was written');

    const good = await createBootstrapRun({
      homeDir,
      repoRoot: null,
      now: new Date('2026-07-17T09:00:00Z'),
      validate,
      manifest: {
        schema: 'runtime-bootstrap-run-1.0',
        selection: { bundle: 'base', desired: ['runtime', 'companions'], excluded: [] },
        steps: [{ id: 'host.claude.present', stage: 1, status: 'pending', declinable: false, blocked_by: [] }],
        boundary: { writes_host_config: false, writes_credential: false, writes_config_local_toml: false, performs_network_request: false },
      },
    });
    strictEqual(good.created, true, `a conforming manifest is written: ${good.diagnostics.join('; ')}`);
    await rm(homeDir, { recursive: true, force: true });
  });

  // Peer finding: writeBootstrapProof's seam could not be filled. A proof record is
  // written to its own file and carries no top-level `schema`, so the whole-document
  // validator rejected every one of them for a version they were never meant to have.
  it('a $defs subschema validator fills the proof seam a whole-document validator cannot', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'agentic-proof-'));
    const runValidate = await makeValidator('runtime-bootstrap-run');
    const proofValidate = await makeDefValidator('runtime-bootstrap-run', 'proof');

    const record = {
      kind: 'deep-peer-smoke',
      status: 'failed',
      directions: {
        'claude->codex': { status: 'passed', ran_at: '2026-07-17T09:00:00Z' },
        'codex->claude': { status: 'failed', ran_at: '2026-07-17T09:00:00Z' },
      },
      artifact_pointer: null,
      artifact_hash: null,
      bound_versions: { runtime: '0.80.1', claude: '2.1.208', codex: '0.144.1', plugins: { claude: {}, codex: {} } },
      ran_at: '2026-07-17T09:00:00Z',
    };
    strictEqual(runValidate(record).ok, false, 'the whole-document validator cannot judge a fragment');
    strictEqual(proofValidate(record).ok, true, `the $defs validator can: ${proofValidate(record).errors.join('; ')}`);

    const created = await createBootstrapRun({
      homeDir, repoRoot: null, now: new Date('2026-07-17T09:00:00Z'), validate: runValidate,
      manifest: {
        schema: 'runtime-bootstrap-run-1.0',
        selection: { bundle: 'base', desired: ['runtime', 'companions'], excluded: [] },
        steps: [],
        boundary: { writes_host_config: false, writes_credential: false, writes_config_local_toml: false, performs_network_request: false },
      },
    });
    const written = await writeBootstrapProof({ homeDir, repoRoot: null, runId: created.run_id, kind: 'deep-peer-smoke', record, validate: proofValidate });
    strictEqual(written.ok, true, 'and it plugs into the writer');
    await rm(homeDir, { recursive: true, force: true });
  });

  // §5: "a schema that could only say directions: [...] could not express it". An
  // EMPTY map is the same failure wearing the right shape — a `passed` aggregate with
  // no evidence behind it at all.
  it('a proof whose directions map is empty is refused', async () => {
    const proofValidate = await makeDefValidator('runtime-bootstrap-run', 'proof');
    const base = {
      kind: 'deep-peer-smoke', status: 'passed', directions: {}, artifact_pointer: null, artifact_hash: null,
      bound_versions: { runtime: '0.80.1', claude: null, codex: null, plugins: { claude: {}, codex: {} } }, ran_at: null,
    };
    const result = proofValidate(base);
    strictEqual(result.ok, false);
    match(result.errors.join(' '), /missing required key 'claude->codex'|missing required key 'codex->claude'/);

    // A direction that did not run says so explicitly, rather than being absent.
    const explicit = { ...base, directions: { 'claude->codex': { status: 'absent', ran_at: null }, 'codex->claude': { status: 'absent', ran_at: null } } };
    strictEqual(proofValidate(explicit).ok, true);
  });

  it('a plugin-set with an unknown plugin key shape is refused', async () => {
    const schema = await loadSchema('runtime-plugin-set');
    const pluginSet = await loadPluginSet();
    const broken = structuredClone(pluginSet);
    broken.plugins.engineer.unexpected = { a: 1 };
    strictEqual(validateAgainstSchema(broken, schema, { readerVersion: 'runtime-plugin-set-1.0' }).ok, false);

    const badHook = structuredClone(pluginSet);
    badHook.plugins.engineer.hook_bearing.codex = 'yes';
    const result = validateAgainstSchema(badHook, schema, { readerVersion: 'runtime-plugin-set-1.0' });
    strictEqual(result.ok, false);
    match(result.errors.join(' '), /expected boolean, got string/);
  });
});
