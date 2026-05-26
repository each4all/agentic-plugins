// plugins/orchestrator/scripts/state.mjs — ADR-0028 §Forward-compat
// behavior tests, ported from engineer PR5 (#356 commit 031d3cb).
// Implements the same predicate + Symbol carrier + raw-preserving emit
// pattern on the orchestrator schema track.
//
// Covers:
//   - isSupportedSchema() predicate accepts any `1.y` string minor;
//     rejects unknown majors, the bare "1", the number form of any
//     value (orchestrator has emitted only the string form since '1.0'),
//     and malformed strings.
//   - validateFrontmatter() accepts a future-minor schema field
//     (e.g., "1.99") well-formed.
//   - parseWorkflowFile() silent-skips unknown additive scalar keys
//     on read; surfaces them via FORWARD_COMPAT_UNKNOWNS Symbol carrier.
//   - serializeFrontmatter() re-emits carrier entries at the tail with
//     `raw` byte-identical preservation.
//   - Closed-schema rejection still applies to unknown majors, non-
//     additive type errors, missing required keys, and block-style
//     unknowns.
//   - Mutation helpers (setCheckpoint, snapshot, appendPhase) preserve
//     the carrier across the read-mutate-write boundary.
//   - CLI `state.mjs read` exposes carrier under `_forward_compat_unknowns`.
//
// Difference from engineer PR5 test: orchestrator's predicate is string-
// only (no legacy number `1` form — orchestrator has emitted strings
// since schema '1.0'). All other behavior is identical.
//
// Run via `node --test tests/orchestrator/test-state-schema-forward-compat.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, throws, deepStrictEqual } from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const STATE_PATH = resolve(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs');

const {
  SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  FORWARD_COMPAT_UNKNOWNS,
  isSupportedSchema,
  parseWorkflowFile,
  assembleWorkflowFile,
  createWorkflow,
  setCheckpoint,
  findActiveWorkflow,
} = await import(STATE_PATH);

function gitInit(dir, branch) {
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir, stdio: 'ignore' });
  // Empty initial commit so HEAD resolves.
  execFileSync(
    'git',
    ['commit', '--allow-empty', '-m', 'initial', '--no-gpg-sign'],
    { cwd: dir, stdio: 'ignore' },
  );
}

async function withTmpRepo(fn, { branch = 'main' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-forward-compat-'));
  try {
    gitInit(dir, branch);
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const MIN_BASELINE = {
  branch: 'main',
  head: '0000000000000000000000000000000000000000',
  status_digest: '',
};

// -----------------------------------------------------------------------------
// isSupportedSchema predicate (orchestrator-tailored)
// -----------------------------------------------------------------------------

describe('isSupportedSchema — ADR-0028 §Forward-compat predicate (orchestrator)', () => {
  it('accepts every explicitly-known minor', () => {
    strictEqual(isSupportedSchema('1.0'), true);
    strictEqual(isSupportedSchema('1.1'), true);
  });

  it('accepts future minors (1.2, 1.10, 1.99, 1.999)', () => {
    strictEqual(isSupportedSchema('1.2'), true);
    strictEqual(isSupportedSchema('1.10'), true);
    strictEqual(isSupportedSchema('1.99'), true);
    strictEqual(isSupportedSchema('1.999'), true);
  });

  it('rejects unknown majors', () => {
    strictEqual(isSupportedSchema('2.0'), false);
    strictEqual(isSupportedSchema('2.1'), false);
    strictEqual(isSupportedSchema('0.1'), false);
  });

  it('rejects the legacy number 1 (orchestrator has no number-form precedent)', () => {
    // Difference from engineer: orchestrator has emitted only string-
    // form schemas since '1.0'. The number `1` is rejected — no orchestrator
    // workflow file should ever carry that shape.
    strictEqual(isSupportedSchema(1), false);
  });

  it('rejects the bare string "1" (no minor digit)', () => {
    strictEqual(isSupportedSchema('1'), false);
  });

  it('rejects the number form of any minor', () => {
    strictEqual(isSupportedSchema(1.0), false);
    strictEqual(isSupportedSchema(1.5), false);
    strictEqual(isSupportedSchema(1.2), false);
  });

  it('rejects malformed strings', () => {
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

  it('rejects non-ASCII digits in the minor position', () => {
    // /^1\.(0|[1-9]\d*)$/ uses \d which (without /u) matches ASCII 0-9
    // only.
    strictEqual(isSupportedSchema('1.٠'), false);  // Arabic-Indic 0
    strictEqual(isSupportedSchema('1.१'), false);  // Devanagari 1
    strictEqual(isSupportedSchema('1.５'), false);  // Fullwidth 5
  });

  it('SUPPORTED_SCHEMA_VERSIONS Set remains the explicitly-known-minors document', () => {
    // The Set is no longer the parse gate (predicate is), but it still
    // documents which minors this build was authored knowing about.
    ok(SUPPORTED_SCHEMA_VERSIONS.has('1.0'));
    ok(SUPPORTED_SCHEMA_VERSIONS.has('1.1'));
    strictEqual(SUPPORTED_SCHEMA_VERSIONS.has('1.2'), false);
    strictEqual(SUPPORTED_SCHEMA_VERSIONS.has(2), false);
  });
});

// -----------------------------------------------------------------------------
// Hand-rolled frontmatter fixture for parser/serializer unit tests
// -----------------------------------------------------------------------------

function makeFrontmatter({ schema = SCHEMA_VERSION, extra = '' } = {}) {
  // A minimal-valid orchestrator frontmatter. Required: schema,
  // workflow_id, workflow_type, original_request, started_at, updated_at,
  // repo_root, git_baseline, current_phase, next_action, plan, host_history.
  const schemaLine =
    typeof schema === 'number'
      ? `schema: ${schema}`
      : `schema: ${JSON.stringify(schema)}`;
  return [
    '---',
    schemaLine,
    'workflow_id: "test-macro-id"',
    'workflow_type: "macro"',
    'original_request: "forward-compat probe"',
    'started_at: "2026-05-26T09:00:00Z"',
    'updated_at: "2026-05-26T09:00:00Z"',
    'repo_root: "/tmp/x"',
    'git_baseline:',
    '  branch: "main"',
    '  head: "0000000000000000000000000000000000000000"',
    '  status_digest: ""',
    'current_phase: "phase-0"',
    'next_action: "n/a"',
    'plan:',
    '  subtasks:',
    'host_history:',
    '  - host: "codex"',
    '    at: "2026-05-26T09:00:00Z"',
    '    event: "created"',
    extra,
    '---',
    '',
    '# body',
    '',
  ].filter((l) => l !== undefined).join('\n');
}

// -----------------------------------------------------------------------------
// parseWorkflowFile — unknown scalar additive key stash
// -----------------------------------------------------------------------------

describe('parseWorkflowFile — Forward-compat read tolerance (orchestrator)', () => {
  it('accepts a future-minor schema field (1.99) with no unknown keys', () => {
    const text = makeFrontmatter({ schema: '1.99' });
    const { frontmatter } = parseWorkflowFile(text);
    strictEqual(frontmatter.schema, '1.99');
    strictEqual(frontmatter[FORWARD_COMPAT_UNKNOWNS], undefined);
  });

  it('silent-skips an unknown additive scalar key; surfaces via FORWARD_COMPAT_UNKNOWNS', () => {
    const text = makeFrontmatter({
      schema: '1.2',
      extra: 'future_macro_field: "x"',
    });
    const { frontmatter } = parseWorkflowFile(text);
    strictEqual(frontmatter.schema, '1.2');
    strictEqual('future_macro_field' in frontmatter, false);
    deepStrictEqual(frontmatter[FORWARD_COMPAT_UNKNOWNS], [
      { key: 'future_macro_field', value: 'x', raw: '"x"' },
    ]);
  });

  it('preserves the order of multiple unknown scalars in encounter sequence', () => {
    const text = makeFrontmatter({
      schema: '1.3',
      extra: ['alpha: "a"', 'beta: "b"', 'gamma: "c"'].join('\n'),
    });
    const { frontmatter } = parseWorkflowFile(text);
    deepStrictEqual(frontmatter[FORWARD_COMPAT_UNKNOWNS], [
      { key: 'alpha', value: 'a', raw: '"a"' },
      { key: 'beta', value: 'b', raw: '"b"' },
      { key: 'gamma', value: 'c', raw: '"c"' },
    ]);
  });

  it('handles scalar types correctly (number/bool/string)', () => {
    const text = makeFrontmatter({
      schema: '1.5',
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

  it('preserves inline list/object literal verbatim', () => {
    // Same edge as engineer PR5 — permissive-fallback parseScalar would
    // round-trip `[]` → string `'[]'` → quoted `'"[]"'`. The `raw` field
    // bypasses that.
    const text = makeFrontmatter({
      schema: '1.7',
      extra: ['future_list: []', 'future_map: {}'].join('\n'),
    });
    const { frontmatter, body } = parseWorkflowFile(text);
    deepStrictEqual(frontmatter[FORWARD_COMPAT_UNKNOWNS], [
      { key: 'future_list', value: '[]', raw: '[]' },
      { key: 'future_map', value: '{}', raw: '{}' },
    ]);
    const reassembled = assembleWorkflowFile(frontmatter, body);
    ok(/^future_list: \[\]$/m.test(reassembled), `expected bare future_list: []; got:\n${reassembled}`);
    ok(/^future_map: \{\}$/m.test(reassembled), `expected bare future_map: {}; got:\n${reassembled}`);
  });

  it('rejects an empty key', () => {
    const text = makeFrontmatter({
      schema: '1.4',
      extra: ': "no name"',
    });
    throws(() => parseWorkflowFile(text), /Empty frontmatter key/);
  });

  it('rejects block-style unknown keys with a forward-compat-aware message', () => {
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

describe('validateFrontmatter — Forward-compat predicate + closed rejection (orchestrator)', () => {
  it('accepts a future-minor schema 1.99 well-formed frontmatter', () => {
    const text = makeFrontmatter({ schema: '1.99' });
    const { frontmatter } = parseWorkflowFile(text);
    strictEqual(frontmatter.schema, '1.99');
  });

  it('rejects unknown majors (2.0, 0.5, "2")', () => {
    for (const s of ['2.0', '0.5', '2']) {
      const text = makeFrontmatter({ schema: s });
      throws(() => parseWorkflowFile(text), /Unsupported schema version.*Forward-compat/s);
    }
  });

  it('rejects the legacy number 1 (orchestrator-specific)', () => {
    // Engineer accepts number 1 for legacy pre-ADR-0017 files; orchestrator
    // never had that shape, so its predicate (and validator) reject it.
    const text = makeFrontmatter({ schema: 1 });
    throws(() => parseWorkflowFile(text), /Unsupported schema version.*Forward-compat/s);
  });

  it('rejects malformed schema strings ("1.01", "1.x", "1.")', () => {
    for (const s of ['1.01', '1.x', '1.']) {
      const text = makeFrontmatter({ schema: s });
      throws(() => parseWorkflowFile(text), /Unsupported schema version.*Forward-compat/s);
    }
  });

  it('still rejects missing required keys (non-additive deviation)', () => {
    const text = makeFrontmatter({ schema: '1.5' })
      .replace('workflow_id: "test-macro-id"\n', '');
    throws(() => parseWorkflowFile(text), /Missing required frontmatter field: workflow_id/);
  });

  it('still rejects wrong-type-on-known-key on a future-minor schema (Codex peer M1)', () => {
    // Even when accepting a future-minor `1.5` schema, the known-key
    // validators still fire — a wrong-type known key throws. Forward-
    // compat read-tolerance only relaxes the schema-version Set gate
    // and unknown-additive-key surfacing; the closed-schema correctness
    // for KNOWN keys is unchanged.
    const text = makeFrontmatter({ schema: '1.5' })
      .replace('workflow_id: "test-macro-id"', 'workflow_id: 42');
    throws(() => parseWorkflowFile(text), /workflow_id must be a non-empty string/);
  });
});

// -----------------------------------------------------------------------------
// serializeFrontmatter — tail-emit of Symbol carrier
// -----------------------------------------------------------------------------

describe('serializeFrontmatter — Forward-compat tail re-emit (orchestrator)', () => {
  it('round-trips unknown scalars: parse → assemble → parse preserves value', () => {
    const original = makeFrontmatter({
      schema: '1.4',
      extra: 'future_marker: "2026-05-26T07:00:00Z"',
    });
    const { frontmatter, body } = parseWorkflowFile(original);
    const reassembled = assembleWorkflowFile(frontmatter, body);
    const { frontmatter: fm2 } = parseWorkflowFile(reassembled);
    deepStrictEqual(fm2[FORWARD_COMPAT_UNKNOWNS], [
      {
        key: 'future_marker',
        value: '2026-05-26T07:00:00Z',
        raw: '"2026-05-26T07:00:00Z"',
      },
    ]);
    ok(/^future_marker: "2026-05-26T07:00:00Z"$/m.test(reassembled));
  });

  it('emits multiple unknowns at the tail in encounter order', () => {
    const original = makeFrontmatter({
      schema: '1.6',
      extra: ['alpha_new: "A"', 'beta_new: 7', 'gamma_new: true'].join('\n'),
    });
    const { frontmatter, body } = parseWorkflowFile(original);
    const reassembled = assembleWorkflowFile(frontmatter, body);
    const idxAlpha = reassembled.indexOf('alpha_new:');
    const idxBeta = reassembled.indexOf('beta_new:');
    const idxGamma = reassembled.indexOf('gamma_new:');
    const idxHostHistory = reassembled.indexOf('host_history:');
    ok(idxHostHistory > 0, 'host_history marker must be present');
    ok(idxAlpha > idxHostHistory, 'alpha_new must follow host_history');
    ok(idxBeta > idxAlpha, 'beta_new must follow alpha_new');
    ok(idxGamma > idxBeta, 'gamma_new must follow beta_new');
  });

  it('does not emit a stale fm[key] for stashed unknowns (no duplicate keys)', () => {
    const original = makeFrontmatter({
      schema: '1.4',
      extra: 'just_one: "x"',
    });
    const { frontmatter, body } = parseWorkflowFile(original);
    const reassembled = assembleWorkflowFile(frontmatter, body);
    const occurrences = reassembled.match(/^just_one:/gm) ?? [];
    strictEqual(occurrences.length, 1);
    strictEqual('just_one' in frontmatter, false);
  });
});

// -----------------------------------------------------------------------------
// Integration — mutation helpers preserve the Symbol carrier
// -----------------------------------------------------------------------------

describe('Forward-compat × mutation helpers — carrier survives read-mutate-write (orchestrator)', () => {
  it('setCheckpoint preserves an unknown scalar across the mutation boundary', async () => {
    await withTmpRepo(async (repoRoot) => {
      // Create a fresh orchestrator macro, then hand-edit to a future
      // minor + inject an unknown scalar.
      await createWorkflow({
        repoRoot, verb: 'plan', host: 'codex',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'forward-compat × mutation',
      });
      const filePath = await findActiveWorkflow(repoRoot);
      ok(filePath, 'findActiveWorkflow must return a path after createWorkflow');
      let raw = await readFile(filePath, 'utf8');
      // Inject an unknown line just before host_history (always written
      // by createWorkflow). host_history is a block-style list in
      // orchestrator frontmatter, so its anchor `host_history:` is
      // reliable.
      const futureLine = 'unseen_future_field: "from-the-future"';
      raw = raw.replace(/^schema: ".+?"$/m, 'schema: "1.42"');
      raw = raw.replace(/^host_history:$/m, `${futureLine}\nhost_history:`);
      await writeFile(filePath, raw);

      await setCheckpoint({
        workflowPath: filePath, host: 'codex',
        at: '2026-05-26T07:30:00Z',
        summary: 'mid-mutation checkpoint',
      });

      const after = await readFile(filePath, 'utf8');
      ok(
        /^unseen_future_field: "from-the-future"$/m.test(after),
        `unknown additive scalar must survive mutation; got:\n${after}`,
      );
      ok(/^schema: "1\.42"$/m.test(after), 'schema field must remain "1.42" on disk');
    });
  });
});

// -----------------------------------------------------------------------------
// CLI `read` — carrier projection
// -----------------------------------------------------------------------------

describe('state.mjs CLI `read` — Forward-compat carrier surface (orchestrator)', () => {
  it('exposes Symbol carrier under _forward_compat_unknowns when present', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot, verb: 'plan', host: 'codex',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'cli read carrier surface',
      });
      const filePath = await findActiveWorkflow(repoRoot);
      let raw = await readFile(filePath, 'utf8');
      raw = raw.replace(/^schema: ".+?"$/m, 'schema: "1.42"');
      raw = raw.replace(/^host_history:$/m, 'future_thing: "x"\nhost_history:');
      await writeFile(filePath, raw);

      const stdout = execFileSync(
        'node',
        [STATE_PATH, 'read', '--workflow-path', filePath],
        { encoding: 'utf8' },
      );
      const parsed = JSON.parse(stdout);
      deepStrictEqual(parsed._forward_compat_unknowns, [
        { key: 'future_thing', value: 'x', raw: '"x"' },
      ]);
      strictEqual(parsed.schema, '1.42');
      strictEqual(parsed.workflow_type, 'macro');
    });
  });

  it('omits _forward_compat_unknowns when the carrier is empty', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot, verb: 'plan', host: 'codex',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'cli read no carrier',
      });
      const filePath = await findActiveWorkflow(repoRoot);
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
