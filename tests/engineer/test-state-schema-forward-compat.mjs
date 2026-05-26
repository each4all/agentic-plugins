// plugins/engineer/scripts/state.mjs — ADR-0028 §Forward-compat (PR5)
// behavior tests. Implements the policy text shipped in PR4 (commit
// eaf195f) in the parser, serializer, and validator.
//
// Covers:
//   - isSupportedSchema() predicate accepts legacy number 1 and any 1.x
//     string minor; rejects unknown majors, bare "1", malformed strings.
//   - validateFrontmatter() accepts a future-minor schema field (e.g.,
//     "1.99") well-formed, without requiring an explicit Set entry.
//   - parseWorkflowFile() silent-skips unknown additive scalar keys on
//     read; surfaces them via FORWARD_COMPAT_UNKNOWNS Symbol carrier.
//   - serializeFrontmatter() re-emits carrier entries at the tail, so
//     round-trip writes preserve unknown additives byte-for-byte for
//     known keys + the unknown lines.
//   - Closed-schema rejection still applies to unknown majors, non-
//     additive type errors on known keys, and block-style unknowns.
//   - Mutation helpers (setCheckpoint, etc.) preserve the carrier across
//     the read-mutate-write boundary — the Symbol is invisible to
//     Object.keys() and `key in fm` so mutation code is untouched.
//
// Run via `node --test tests/engineer/test-state-schema-forward-compat.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, throws, deepStrictEqual } from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const STATE_PATH = resolve(REPO_ROOT, 'plugins/engineer/scripts/state.mjs');

const {
  SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  FORWARD_COMPAT_UNKNOWNS,
  isSupportedSchema,
  parseWorkflowFile,
  assembleWorkflowFile,
  createWorkflow,
  listWorkflowFiles,
  setCheckpoint,
} = await import(STATE_PATH);

function gitInit(dir, branch) {
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir, stdio: 'ignore' });
}

async function withTmpRepo(fn, { branch = 'test' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'engineer-forward-compat-'));
  try {
    gitInit(dir, branch);
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const MIN_BASELINE = {
  branch: 'test',
  head: '0000000000000000000000000000000000000000',
  status_digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
};

// -----------------------------------------------------------------------------
// isSupportedSchema predicate
// -----------------------------------------------------------------------------

describe('isSupportedSchema — ADR-0028 §Forward-compat predicate', () => {
  it('accepts legacy schema=1 (number form)', () => {
    strictEqual(isSupportedSchema(1), true);
  });

  it('accepts every explicitly-known minor', () => {
    strictEqual(isSupportedSchema('1.1'), true);
    strictEqual(isSupportedSchema('1.2'), true);
    strictEqual(isSupportedSchema('1.3'), true);
  });

  it('accepts future minors (1.4, 1.5, 1.10, 1.99, 1.100, 1.999)', () => {
    strictEqual(isSupportedSchema('1.4'), true);
    strictEqual(isSupportedSchema('1.5'), true);
    strictEqual(isSupportedSchema('1.10'), true);
    strictEqual(isSupportedSchema('1.99'), true);
    strictEqual(isSupportedSchema('1.100'), true);
    strictEqual(isSupportedSchema('1.999'), true);
  });

  it('accepts the canonical 1.0 string form', () => {
    // 1.0 is a valid 1.x minor — the predicate is open-ended within major 1.
    strictEqual(isSupportedSchema('1.0'), true);
  });

  it('rejects unknown majors', () => {
    strictEqual(isSupportedSchema(2), false);
    strictEqual(isSupportedSchema('2.0'), false);
    strictEqual(isSupportedSchema('2.1'), false);
    strictEqual(isSupportedSchema('0.1'), false);
  });

  it('rejects the bare string "1" (canonical legacy form is the number 1)', () => {
    // The YAML parser emits number 1 for `schema: 1`; the string "1" is a
    // different shape and not a known canonical form.
    strictEqual(isSupportedSchema('1'), false);
  });

  it('rejects the number form of a minor (parser emits strings for 1.x)', () => {
    // state.mjs:60-62 — `schema: 1.2` round-trips through JS Number and
    // loses precision; the canonical disk form for any minor is a string.
    strictEqual(isSupportedSchema(1.5), false);
    strictEqual(isSupportedSchema(1.2), false);
  });

  it('rejects malformed strings (leading zero, missing minor, junk)', () => {
    strictEqual(isSupportedSchema(''), false);
    strictEqual(isSupportedSchema('1.'), false);
    strictEqual(isSupportedSchema('1.01'), false);
    strictEqual(isSupportedSchema('01.2'), false);
    strictEqual(isSupportedSchema('one'), false);
    strictEqual(isSupportedSchema('1.x'), false);
    strictEqual(isSupportedSchema('1.2.3'), false);
  });

  it('rejects non-string non-number values', () => {
    strictEqual(isSupportedSchema(null), false);
    strictEqual(isSupportedSchema(undefined), false);
    strictEqual(isSupportedSchema(true), false);
    strictEqual(isSupportedSchema([]), false);
    strictEqual(isSupportedSchema({}), false);
  });

  it('SUPPORTED_SCHEMA_VERSIONS Set remains the explicitly-known-minors document', () => {
    // The Set is no longer the parse gate (predicate is), but it still
    // documents which minors this build was authored knowing about.
    // Existing tests assert this set's contents — those tests continue
    // to pass without modification.
    ok(SUPPORTED_SCHEMA_VERSIONS.has(1));
    ok(SUPPORTED_SCHEMA_VERSIONS.has('1.1'));
    ok(SUPPORTED_SCHEMA_VERSIONS.has('1.2'));
    ok(SUPPORTED_SCHEMA_VERSIONS.has('1.3'));
    strictEqual(SUPPORTED_SCHEMA_VERSIONS.has('1.4'), false);
    strictEqual(SUPPORTED_SCHEMA_VERSIONS.has(2), false);
  });
});

// -----------------------------------------------------------------------------
// parseWorkflowFile — unknown scalar additive key stash
// -----------------------------------------------------------------------------

function makeFrontmatter({ schema = SCHEMA_VERSION, extra = '' } = {}) {
  // A minimal-valid frontmatter that satisfies validateFrontmatter's required
  // field set, plus an optional `extra` block of additional lines inserted
  // between `host_history: []` and the closing `---`.
  const schemaLine =
    typeof schema === 'number'
      ? `schema: ${schema}`
      : `schema: ${JSON.stringify(schema)}`;
  return [
    '---',
    schemaLine,
    'workflow_id: "test-wf-id"',
    'persona: "engineer"',
    'verb: "investigate"',
    'profile: ""',
    'original_request: "forward-compat probe"',
    'started_at: "2026-05-26T06:00:00Z"',
    'updated_at: "2026-05-26T06:00:00Z"',
    'repo_root: "/tmp/x"',
    'git_baseline:',
    '  branch: "test"',
    '  head: "0000000000000000000000000000000000000000"',
    '  status_digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"',
    'current_phase: "phase-0"',
    'next_action: "n/a"',
    'tasks: []',
    'host_history: []',
    extra,
    '---',
    '',
    '# body',
    '',
  ].filter((l) => l !== undefined).join('\n');
}

describe('parseWorkflowFile — Forward-compat read tolerance', () => {
  it('accepts a future-minor schema field (1.99) with no unknown keys', () => {
    const text = makeFrontmatter({ schema: '1.99' });
    const { frontmatter } = parseWorkflowFile(text);
    strictEqual(frontmatter.schema, '1.99');
    // Carrier not populated when there are no unknowns.
    strictEqual(frontmatter[FORWARD_COMPAT_UNKNOWNS], undefined);
  });

  it('silent-skips an unknown additive scalar key; surfaces via FORWARD_COMPAT_UNKNOWNS', () => {
    const text = makeFrontmatter({
      schema: '1.4',
      extra: 'cool_new_thing: "future value"',
    });
    const { frontmatter } = parseWorkflowFile(text);
    strictEqual(frontmatter.schema, '1.4');
    // Unknown key MUST NOT appear as a direct fm property.
    strictEqual('cool_new_thing' in frontmatter, false);
    strictEqual(Object.keys(frontmatter).includes('cool_new_thing'), false);
    // It MUST surface through the Symbol carrier — `{key, value, raw}`
    // (raw preserves the verbatim line tail for byte-identical re-emit).
    deepStrictEqual(frontmatter[FORWARD_COMPAT_UNKNOWNS], [
      { key: 'cool_new_thing', value: 'future value', raw: '"future value"' },
    ]);
  });

  it('preserves the order of multiple unknown scalars in encounter sequence', () => {
    const text = makeFrontmatter({
      schema: '1.5',
      extra: ['first_future: "a"', 'second_future: "b"', 'third_future: "c"'].join('\n'),
    });
    const { frontmatter } = parseWorkflowFile(text);
    deepStrictEqual(frontmatter[FORWARD_COMPAT_UNKNOWNS], [
      { key: 'first_future', value: 'a', raw: '"a"' },
      { key: 'second_future', value: 'b', raw: '"b"' },
      { key: 'third_future', value: 'c', raw: '"c"' },
    ]);
  });

  it('handles scalar types correctly through parseScalar (number/bool/string)', () => {
    const text = makeFrontmatter({
      schema: '1.7',
      extra: [
        'future_int: 42',
        'future_bool: true',
        'future_str: "hello world"',
      ].join('\n'),
    });
    const { frontmatter } = parseWorkflowFile(text);
    deepStrictEqual(frontmatter[FORWARD_COMPAT_UNKNOWNS], [
      { key: 'future_int', value: 42, raw: '42' },
      { key: 'future_bool', value: true, raw: 'true' },
      { key: 'future_str', value: 'hello world', raw: '"hello world"' },
    ]);
  });

  it('preserves inline list/object literal verbatim (Codex review M2 fix)', () => {
    // The unknown stash branch now stores the post-colon `raw` line tail so
    // permissive-fallback shapes (inline `[]`, `{}`) round-trip without
    // being coerced through parseScalar('[]') → 'literal string `[]`' →
    // yamlScalar → '"[]"' (quoted string — a semantic type change).
    const text = makeFrontmatter({
      schema: '1.9',
      extra: ['future_list: []', 'future_map: {}'].join('\n'),
    });
    const { frontmatter, body } = parseWorkflowFile(text);
    deepStrictEqual(frontmatter[FORWARD_COMPAT_UNKNOWNS], [
      { key: 'future_list', value: '[]', raw: '[]' },
      { key: 'future_map', value: '{}', raw: '{}' },
    ]);
    // Round-trip MUST keep the bare literal — not quote it.
    const reassembled = assembleWorkflowFile(frontmatter, body);
    ok(/^future_list: \[\]$/m.test(reassembled), `expected bare future_list: []; got:\n${reassembled}`);
    ok(/^future_map: \{\}$/m.test(reassembled), `expected bare future_map: {}; got:\n${reassembled}`);
  });

  it('rejects an empty key (Codex review m1 fix)', () => {
    // `: value` produces key === ''. Without an explicit gate, the carrier
    // would silently swallow a nameless line and the serializer would emit
    // it as malformed YAML.
    const text = makeFrontmatter({
      schema: '1.4',
      extra: ': "no name"',
    });
    throws(() => parseWorkflowFile(text), /Empty frontmatter key/);
  });

  it('rejects block-style unknown keys with a forward-compat-aware message', () => {
    // A block-style unknown (key followed by empty value, then an indented
    // sub-block) hits the "Empty value for unrecognized block key" branch.
    const text = makeFrontmatter({
      schema: '1.4',
      extra: ['future_block:', '  nested: "v"'].join('\n'),
    });
    throws(() => parseWorkflowFile(text), /Empty value for unrecognized block key: future_block.*scalar additive keys only/s);
  });
});

// -----------------------------------------------------------------------------
// validateFrontmatter — predicate-based accept + closed rejection
// -----------------------------------------------------------------------------

describe('validateFrontmatter — Forward-compat predicate + closed rejection', () => {
  it('accepts a future-minor schema 1.99 well-formed frontmatter', () => {
    const text = makeFrontmatter({ schema: '1.99' });
    // parseWorkflowFile invokes validateFrontmatter internally; no throw == accept.
    const { frontmatter } = parseWorkflowFile(text);
    strictEqual(frontmatter.schema, '1.99');
  });

  it('rejects unknown majors (2.0, 0.5, "2")', () => {
    for (const s of ['"2.0"', '"0.5"', '"2"']) {
      const text = makeFrontmatter({ schema: JSON.parse(s) });
      throws(() => parseWorkflowFile(text), /Unsupported schema version.*Forward-compat/s);
    }
  });

  it('rejects malformed schema strings ("1.01", "1.x", "")', () => {
    for (const s of ['1.01', '1.x', '1.']) {
      const text = makeFrontmatter({ schema: s });
      throws(() => parseWorkflowFile(text), /Unsupported schema version.*Forward-compat/s);
    }
  });

  it('still rejects wrong-type-on-known-key (non-additive deviation)', () => {
    // tasks must be an array — a string-typed `tasks` on a forward-minor
    // schema still throws; the predicate-based read-tolerance does NOT
    // weaken known-key validation.
    const text = makeFrontmatter({
      schema: '1.5',
    }).replace('tasks: []', 'tasks: "not-an-array"');
    throws(() => parseWorkflowFile(text), /tasks must be an array/);
  });

  it('still rejects missing required keys (non-additive deviation)', () => {
    // Drop a required key — must still throw despite tolerant predicate.
    const text = makeFrontmatter({ schema: '1.5' })
      .replace('workflow_id: "test-wf-id"\n', '');
    throws(() => parseWorkflowFile(text), /Missing required frontmatter field: workflow_id/);
  });
});

// -----------------------------------------------------------------------------
// serializeFrontmatter — tail-emit of Symbol carrier
// -----------------------------------------------------------------------------

describe('serializeFrontmatter — Forward-compat tail re-emit', () => {
  it('round-trips unknown scalars: parse → assemble → parse preserves value', () => {
    const original = makeFrontmatter({
      schema: '1.4',
      extra: 'parent_writeback_at_clone: "2026-05-26T07:00:00Z"',
    });
    const { frontmatter, body } = parseWorkflowFile(original);
    const reassembled = assembleWorkflowFile(frontmatter, body);
    // Reparse — value must survive.
    const { frontmatter: fm2 } = parseWorkflowFile(reassembled);
    deepStrictEqual(fm2[FORWARD_COMPAT_UNKNOWNS], [
      {
        key: 'parent_writeback_at_clone',
        value: '2026-05-26T07:00:00Z',
        raw: '"2026-05-26T07:00:00Z"',
      },
    ]);
    // The reassembled file must contain the unknown line.
    ok(/^parent_writeback_at_clone: "2026-05-26T07:00:00Z"$/m.test(reassembled));
  });

  it('emits multiple unknowns at the tail in encounter order', () => {
    const original = makeFrontmatter({
      schema: '1.6',
      extra: ['alpha_new: "A"', 'beta_new: 7', 'gamma_new: true'].join('\n'),
    });
    const { frontmatter, body } = parseWorkflowFile(original);
    const reassembled = assembleWorkflowFile(frontmatter, body);
    // All three appear, in declared order, AFTER host_history.
    const idxAlpha = reassembled.indexOf('alpha_new:');
    const idxBeta = reassembled.indexOf('beta_new:');
    const idxGamma = reassembled.indexOf('gamma_new:');
    const idxHostHistory = reassembled.indexOf('host_history:');
    ok(idxHostHistory > 0, 'host_history known marker must be present');
    ok(idxAlpha > idxHostHistory, 'alpha_new must follow host_history');
    ok(idxBeta > idxAlpha, 'beta_new must follow alpha_new');
    ok(idxGamma > idxBeta, 'gamma_new must follow beta_new');
  });

  it('does not emit a stale fm[key] for stashed unknowns (no duplicate keys)', () => {
    // The post-stash code path must not also write fm[key] — that would
    // both bypass the closed-schema gate and cause duplicate lines.
    const original = makeFrontmatter({
      schema: '1.4',
      extra: 'just_one: "x"',
    });
    const { frontmatter, body } = parseWorkflowFile(original);
    const reassembled = assembleWorkflowFile(frontmatter, body);
    const occurrences = reassembled.match(/^just_one:/gm) ?? [];
    strictEqual(occurrences.length, 1);
    // And fm.just_one must NOT exist as a direct property.
    strictEqual('just_one' in frontmatter, false);
  });
});

// -----------------------------------------------------------------------------
// Integration — mutation helpers preserve the Symbol carrier
// -----------------------------------------------------------------------------

describe('Forward-compat × mutation helpers — carrier survives read-mutate-write', () => {
  it('setCheckpoint preserves an unknown scalar across the mutation boundary', async () => {
    await withTmpRepo(async (repoRoot) => {
      // Create a fresh workflow with the build's current SCHEMA_VERSION,
      // then hand-edit the file to (a) flip schema to a future minor and
      // (b) inject an unknown scalar additive key. This simulates a
      // current-build reader meeting a future-minor file on disk.
      await createWorkflow({
        repoRoot, verb: 'investigate', host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'forward-compat × mutation',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      let raw = await readFile(filePath, 'utf8');
      // Inject an unknown additive scalar line just before the workflow_type
      // line (always written by createWorkflow per ADR-0020 PR 2, so a
      // reliable anchor). createWorkflow already populates host_history with
      // a "created" entry, so a `host_history: []` anchor would not match.
      const futureLine = 'unseen_future_field: "from-the-future"';
      raw = raw.replace(
        /^schema: ".+?"$/m,
        'schema: "1.42"',
      );
      raw = raw.replace(
        /^workflow_type: /m,
        `${futureLine}\nworkflow_type: `,
      );
      await writeFile(filePath, raw);

      // Now invoke a mutation helper. The carrier must flow through and
      // re-appear on disk after the helper writes the file back.
      await setCheckpoint({
        workflowPath: filePath, host: 'claude',
        at: '2026-05-26T07:30:00Z',
        summary: 'mid-mutation checkpoint',
      });

      const after = await readFile(filePath, 'utf8');
      // The unknown additive line must still be present after mutation.
      ok(
        /^unseen_future_field: "from-the-future"$/m.test(after),
        `unknown additive scalar must survive mutation; got:\n${after}`,
      );
      // The disk schema MUST NOT be silently promoted/downgraded.
      ok(/^schema: "1\.42"$/m.test(after), 'schema field must remain "1.42" on disk');
    });
  });
});

// -----------------------------------------------------------------------------
// CLI `read` — Codex local review M1 fix: surface carrier as _forward_compat_unknowns
// -----------------------------------------------------------------------------

describe('state.mjs CLI `read` — Forward-compat carrier surface', () => {
  it('exposes Symbol carrier under _forward_compat_unknowns when present', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot, verb: 'investigate', host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'cli read carrier surface',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      let raw = await readFile(filePath, 'utf8');
      raw = raw.replace(/^schema: ".+?"$/m, 'schema: "1.42"');
      raw = raw.replace(/^workflow_type: /m, 'future_thing: "x"\nworkflow_type: ');
      await writeFile(filePath, raw);

      const stdout = execFileSync(
        'node',
        [STATE_PATH, 'read', '--workflow-path', filePath],
        { encoding: 'utf8' },
      );
      const parsed = JSON.parse(stdout);
      // The diagnostic projection MUST surface the carrier under a known
      // underscored key (Symbols are invisible to JSON.stringify, so a
      // bare `JSON.stringify(frontmatter)` would silently drop unknowns —
      // contradicting ADR-0028 §Forward-compat rule 2 lossless intent).
      deepStrictEqual(parsed._forward_compat_unknowns, [
        { key: 'future_thing', value: 'x', raw: '"x"' },
      ]);
      // The known fields remain present.
      strictEqual(parsed.schema, '1.42');
      strictEqual(parsed.workflow_type, 'verb-chain');
    });
  });

  it('omits _forward_compat_unknowns when the carrier is empty (no diagnostic noise)', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot, verb: 'investigate', host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'cli read no carrier',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const stdout = execFileSync(
        'node',
        [STATE_PATH, 'read', '--workflow-path', filePath],
        { encoding: 'utf8' },
      );
      const parsed = JSON.parse(stdout);
      strictEqual(parsed._forward_compat_unknowns, undefined);
    });
  });
});

// -----------------------------------------------------------------------------
// Predicate hardening — Unicode digit rejection (Codex local review m4)
// -----------------------------------------------------------------------------

describe('isSupportedSchema — Unicode digit hardening', () => {
  it('rejects non-ASCII digits in the minor position', () => {
    // /^1\.(0|[1-9]\d*)$/ uses \d which (without /u) matches ASCII 0-9
    // only. A Unicode-digit minor like Arabic-Indic '٠' (U+0660) MUST NOT
    // satisfy the predicate — keeps the schema string canonicalization
    // ASCII-only and matches the YAML emit path (yamlScalar /
    // JSON.stringify produces ASCII digits exclusively).
    strictEqual(isSupportedSchema('1.٠'), false);  // Arabic-Indic 0
    strictEqual(isSupportedSchema('1.१'), false);  // Devanagari 1
    strictEqual(isSupportedSchema('1.５'), false);  // Fullwidth 5
  });
});
