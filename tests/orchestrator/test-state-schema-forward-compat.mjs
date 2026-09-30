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
//   - ADR-0063 D6: a 1.1-era reader (this build minus the six 1.2 keys and
//     plan-set's approval reset) carries plan_approval_* / awaiting_owner_*
//     through read and mutation byte for byte, in place at the tail; when it
//     rewrites the plan, the carried hash no longer matches and a 1.2 reader
//     reports hash_ok false. The same checks run against the released 1.1
//     code (tag plugin-orchestrator-v0.14.1) when the tag is in the clone.
//
// Difference from engineer PR5 test: orchestrator's predicate is string-
// only (no legacy number `1` form — orchestrator has emitted strings
// since schema '1.0'). All other behavior is identical.
//
// Run via `node --test tests/orchestrator/test-state-schema-forward-compat.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, throws, deepStrictEqual } from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  setPlan,
  approvePlan,
  setAwaitingOwner,
  setMacroTerminal,
  readWorkflow,
  planApprovalState,
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
    ok(SUPPORTED_SCHEMA_VERSIONS.has('1.2'));
    strictEqual(SUPPORTED_SCHEMA_VERSIONS.has('1.3'), false);
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

// -----------------------------------------------------------------------------
// ADR-0063 D6 — a 1.1-era reader meets a 1.2 file
// -----------------------------------------------------------------------------

const SCHEMA_12_KEYS = [
  'plan_approval_status',
  'plan_approval_approved_at',
  'plan_approval_plan_hash',
  'awaiting_owner_gate',
  'awaiting_owner_since',
  'awaiting_owner_pointer',
];

// A 1.1-era reader is this build without the six 1.2 entries in
// FRONTMATTER_KEY_ORDER (the only thing that makes a key known to the
// parser) and without plan-set's approval reset (a 1.1 writer never touched
// approval). The copy lives outside the repo and is imported fresh, so it has
// its own module state (including its own carrier Symbol).
async function importSchema11Reader(dir) {
  const src = await readFile(STATE_PATH, 'utf8');
  const keyOrderLine = new RegExp(`^  '(${SCHEMA_12_KEYS.join('|')})',\\n`, 'gm');
  const removed = (src.match(keyOrderLine) ?? []).map((l) => l.trim());
  deepStrictEqual(removed, SCHEMA_12_KEYS.map((k) => `'${k}',`),
    'the six keys must each appear once, one per line, in FRONTMATTER_KEY_ORDER');
  const emit = "export const SCHEMA_VERSION = '1.2';";
  ok(src.includes(emit), 'the build must emit 1.2');
  const reset = '    resetPlanApproval(frontmatter, workflowPath, nowIso, { conflict });\n    validateSchema12Fields(frontmatter);\n';
  strictEqual(src.split(reset).length, 2, 'plan-set resets approval in exactly one place');
  const reader = src
    .replace(keyOrderLine, '')
    .replace(emit, "export const SCHEMA_VERSION = '1.1';")
    .replace(reset, '');
  await writeFile(join(dir, 'state.mjs'), reader);
  await copyFile(resolve(REPO_ROOT, 'plugins/orchestrator/scripts/landing.mjs'), join(dir, 'landing.mjs'));
  return import(pathToFileURL(join(dir, 'state.mjs')).href);
}

const newKeyLines = (text) => text.match(/^(plan_approval_|awaiting_owner_)\w+: .*$/gm) ?? [];
const frontmatterBlock = (text) => text.slice(0, text.indexOf('\n---\n') + 5);
const frontmatterLines = (text) => text.slice(4, text.indexOf('\n---\n')).split('\n');
const st = (id, extra = {}) => ({
  id, verb: 'compose', branch: `feat/${id.toLowerCase()}`, blocked_by: [], status: 'pending', ...extra,
});

describe('ADR-0063 D6 — a 1.1-era reader carries the 1.2 keys', () => {
  it('round-trips the six scalars byte for byte, through read and through mutation', async () => {
    const readerDir = await mkdtemp(join(tmpdir(), 'orchestrator-reader11-'));
    try {
      const r11 = await importSchema11Reader(readerDir);
      strictEqual(r11.SCHEMA_VERSION, '1.1');
      await withTmpRepo(async (repoRoot) => {
        // Written by this (1.2) build: a planned, approved macro.
        await createWorkflow({
          repoRoot, verb: 'plan', host: 'claude',
          gitBaseline: MIN_BASELINE, originalRequest: 'reader 1.1 meets 1.2',
        });
        const filePath = await findActiveWorkflow(repoRoot);
        await setPlan({ workflowPath: filePath, host: 'claude', subtasks: [st('A'), st('B')] });
        // terminal_marker is the last key a 1.1 reader knows; with it present,
        // a 1.2 key placed before it would come back reordered.
        await setMacroTerminal({ workflowPath: filePath, host: 'claude', terminalPhase: 'finalized', terminalMarker: false });
        const ownerEnv = { ...process.env };
        delete ownerEnv.AGENTIC_AUTOPILOT;
        await approvePlan({ workflowPath: filePath, host: 'claude', env: ownerEnv });
        const original = await readFile(filePath, 'utf8');
        deepStrictEqual(frontmatterLines(original).slice(-4), ['terminal_marker: false', ...newKeyLines(original)]);
        const lines = newKeyLines(original);
        strictEqual(lines.length, 3, 'approved: status, approved_at, plan_hash');

        // Read: the keys are unknown to the 1.1 reader and land in its carrier.
        const parsed = r11.parseWorkflowFile(original);
        for (const k of SCHEMA_12_KEYS) ok(!(k in parsed.frontmatter), `${k} is not a known key`);
        deepStrictEqual(parsed.frontmatter[r11.FORWARD_COMPAT_UNKNOWNS].map((e) => e.key),
          ['plan_approval_status', 'plan_approval_approved_at', 'plan_approval_plan_hash']);
        // The frontmatter only: parse + assemble grows the body by one blank
        // line in every state copy (docket C79), which is not what this checks.
        strictEqual(frontmatterBlock(r11.assembleWorkflowFile(parsed.frontmatter, parsed.body)), frontmatterBlock(original));

        // Mutations a 1.1 reader performs keep them, in place at the tail.
        await r11.appendPhase({ workflowPath: filePath, host: 'codex', phaseLabel: 'n', phaseNote: 'x', event: 'updated' });
        await r11.snapshot({ workflowPath: filePath, host: 'codex', trigger: 'stop', statusDigest: '' });
        await r11.setCheckpoint({ workflowPath: filePath, host: 'codex', summary: 'checkpoint' });
        await r11.updateSubtask({ workflowPath: filePath, host: 'codex', subtaskId: 'A', status: 'in_progress', engineerWorkflowId: 'compose-20260930T000000Z-dddddd' });
        await r11.setMacroTerminal({ workflowPath: filePath, host: 'codex', terminalPhase: 'finalized', terminalMarker: false });
        const after = await readFile(filePath, 'utf8');
        deepStrictEqual(newKeyLines(after), lines);
        deepStrictEqual(frontmatterLines(after).slice(-4), ['terminal_marker: false', ...lines]);
        deepStrictEqual(planApprovalState((await readWorkflow(filePath)).frontmatter), { status: 'approved', hash_ok: true });
      });
    } finally {
      await rm(readerDir, { recursive: true, force: true });
    }
  });

  it('a 1.1 plan rewrite carries the approval, and the 1.2 reader sees the hash no longer matches', async () => {
    const readerDir = await mkdtemp(join(tmpdir(), 'orchestrator-reader11-'));
    try {
      const r11 = await importSchema11Reader(readerDir);
      await withTmpRepo(async (repoRoot) => {
        await createWorkflow({
          repoRoot, verb: 'plan', host: 'claude',
          gitBaseline: MIN_BASELINE, originalRequest: 'stale approval',
        });
        const filePath = await findActiveWorkflow(repoRoot);
        await setPlan({ workflowPath: filePath, host: 'claude', subtasks: [st('A')] });
        const ownerEnv = { ...process.env };
        delete ownerEnv.AGENTIC_AUTOPILOT;
        await approvePlan({ workflowPath: filePath, host: 'claude', env: ownerEnv });
        const approvedLines = newKeyLines(await readFile(filePath, 'utf8'));

        await r11.setPlan({ workflowPath: filePath, host: 'codex', subtasks: [st('A', { topic: 'changed by a 1.1 writer' })] });
        deepStrictEqual(newKeyLines(await readFile(filePath, 'utf8')), approvedLines, 'the 1.1 writer carried the approval');
        deepStrictEqual(planApprovalState((await readWorkflow(filePath)).frontmatter), { status: 'approved', hash_ok: false });
        const nr = JSON.parse(execFileSync('node', [STATE_PATH, 'next-ready', '--workflow-path', filePath], { encoding: 'utf8' }));
        deepStrictEqual(nr.approval, { status: 'approved', hash_ok: false });
      });
    } finally {
      await rm(readerDir, { recursive: true, force: true });
    }
  });

  it('carries a pending plan-conflict gate the same way', async () => {
    const readerDir = await mkdtemp(join(tmpdir(), 'orchestrator-reader11-'));
    try {
      const r11 = await importSchema11Reader(readerDir);
      await withTmpRepo(async (repoRoot) => {
        await createWorkflow({
          repoRoot, verb: 'plan', host: 'claude',
          gitBaseline: MIN_BASELINE, originalRequest: 'pending gate',
        });
        const filePath = await findActiveWorkflow(repoRoot);
        await setPlan({ workflowPath: filePath, host: 'claude', subtasks: [st('A')] });
        await setAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'plan-conflict', pointer: 'x/m.md#ensemble-synthesis' });
        const lines = newKeyLines(await readFile(filePath, 'utf8'));
        strictEqual(lines.length, 4, 'pending: status + three awaiting_owner keys');
        await r11.appendPhase({ workflowPath: filePath, host: 'codex', phaseLabel: 'n', phaseNote: 'x', event: 'updated' });
        await r11.setPlan({ workflowPath: filePath, host: 'codex', subtasks: [st('A'), st('B')] });
        const after = await readFile(filePath, 'utf8');
        deepStrictEqual(newKeyLines(after), lines);
        deepStrictEqual(frontmatterLines(after).slice(-4), lines);
      });
    } finally {
      await rm(readerDir, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// ADR-0063 D6 — the released 1.1 orchestrator meets a 1.2 file
// -----------------------------------------------------------------------------

// The surrogate above is derived from the current code, so a parser change
// made on both sides would pass it. This block runs the code installed today:
// the last 1.1 release, read from its tag. CI clones with full history and
// tags; a clone without the tag skips, and the surrogate still runs.
const RELEASED_11_TAG = 'plugin-orchestrator-v0.14.1';

function gitShow(ref) {
  try {
    return execFileSync('git', ['-C', REPO_ROOT, 'show', ref], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

async function importReleased11(dir) {
  const state = gitShow(`${RELEASED_11_TAG}:plugins/orchestrator/scripts/state.mjs`);
  const landing = gitShow(`${RELEASED_11_TAG}:plugins/orchestrator/scripts/landing.mjs`);
  if (state === null || landing === null) return null;
  await writeFile(join(dir, 'state.mjs'), state);
  await writeFile(join(dir, 'landing.mjs'), landing);
  return import(pathToFileURL(join(dir, 'state.mjs')).href);
}

describe('ADR-0063 D6 — the released 1.1 orchestrator carries the 1.2 keys', () => {
  it('reads, mutates and rewrites a 1.2 file, keeping the six keys in place', async (t) => {
    const readerDir = await mkdtemp(join(tmpdir(), 'orchestrator-released11-'));
    try {
      const r11 = await importReleased11(readerDir);
      if (r11 === null) {
        t.skip(`${RELEASED_11_TAG} is not in this clone`);
        return;
      }
      strictEqual(r11.SCHEMA_VERSION, '1.1');
      await withTmpRepo(async (repoRoot) => {
        await createWorkflow({
          repoRoot, verb: 'plan', host: 'claude',
          gitBaseline: MIN_BASELINE, originalRequest: 'released 1.1 meets 1.2',
        });
        const filePath = await findActiveWorkflow(repoRoot);
        await setPlan({ workflowPath: filePath, host: 'claude', subtasks: [st('A'), st('B')] });
        await setMacroTerminal({ workflowPath: filePath, host: 'claude', terminalPhase: 'finalized', terminalMarker: false });
        const ownerEnv = { ...process.env };
        delete ownerEnv.AGENTIC_AUTOPILOT;
        await approvePlan({ workflowPath: filePath, host: 'claude', env: ownerEnv });
        const original = await readFile(filePath, 'utf8');
        const lines = newKeyLines(original);
        strictEqual(lines.length, 3);

        const parsed = r11.parseWorkflowFile(original);
        strictEqual(frontmatterBlock(r11.assembleWorkflowFile(parsed.frontmatter, parsed.body)), frontmatterBlock(original));
        await r11.appendPhase({ workflowPath: filePath, host: 'codex', phaseLabel: 'n', phaseNote: 'x', event: 'updated' });
        await r11.setCheckpoint({ workflowPath: filePath, host: 'codex', summary: 'checkpoint' });
        await r11.updateSubtask({ workflowPath: filePath, host: 'codex', subtaskId: 'A', status: 'in_progress', engineerWorkflowId: 'compose-20260930T000000Z-ffffff' });
        deepStrictEqual(newKeyLines(await readFile(filePath, 'utf8')), lines);
        deepStrictEqual(planApprovalState((await readWorkflow(filePath)).frontmatter), { status: 'approved', hash_ok: true });

        // The released plan-set knows nothing of approval: it carries it, and
        // the 1.2 reader sees that the hash no longer matches.
        await r11.setPlan({ workflowPath: filePath, host: 'codex', subtasks: [st('A', { status: 'in_progress', engineer_workflow_id: 'compose-20260930T000000Z-ffffff' }), st('B', { topic: 'changed by 0.14.1' })] });
        const after = await readFile(filePath, 'utf8');
        deepStrictEqual(newKeyLines(after), lines);
        deepStrictEqual(frontmatterLines(after).slice(-4), ['terminal_marker: false', ...lines]);
        deepStrictEqual(planApprovalState((await readWorkflow(filePath)).frontmatter), { status: 'approved', hash_ok: false });
      });
    } finally {
      await rm(readerDir, { recursive: true, force: true });
    }
  });

  it('carries a pending plan-conflict gate through its writes', async (t) => {
    const readerDir = await mkdtemp(join(tmpdir(), 'orchestrator-released11-'));
    try {
      const r11 = await importReleased11(readerDir);
      if (r11 === null) {
        t.skip(`${RELEASED_11_TAG} is not in this clone`);
        return;
      }
      await withTmpRepo(async (repoRoot) => {
        await createWorkflow({
          repoRoot, verb: 'plan', host: 'claude',
          gitBaseline: MIN_BASELINE, originalRequest: 'released 1.1 meets a pending gate',
        });
        const filePath = await findActiveWorkflow(repoRoot);
        await setPlan({ workflowPath: filePath, host: 'claude', subtasks: [st('A')], verdict: 'conflict' });
        const lines = newKeyLines(await readFile(filePath, 'utf8'));
        strictEqual(lines.length, 4, 'pending: status + three awaiting_owner keys');
        await r11.appendPhase({ workflowPath: filePath, host: 'codex', phaseLabel: 'n', phaseNote: 'x', event: 'updated' });
        await r11.snapshot({ workflowPath: filePath, host: 'codex', trigger: 'stop', statusDigest: '' });
        await r11.setPlan({ workflowPath: filePath, host: 'codex', subtasks: [st('A'), st('B')] });
        const after = await readFile(filePath, 'utf8');
        deepStrictEqual(newKeyLines(after), lines);
        deepStrictEqual(frontmatterLines(after).slice(-4), lines);
        strictEqual((await readWorkflow(filePath)).frontmatter.awaiting_owner_gate, 'plan-conflict');
      });
    } finally {
      await rm(readerDir, { recursive: true, force: true });
    }
  });
});
