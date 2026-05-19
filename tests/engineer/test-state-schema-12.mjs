// plugins/engineer/scripts/state.mjs — ADR-0028 §Layer-2 schema 1.2 +
// commit_manifest field tests. T3a (schema 1.1 → 1.2 additive bump) and
// T3b (recordComposedFile / recordRefineFile helpers, command-mode only).
//
// Covers:
//   - SCHEMA_VERSION bump to '1.2'
//   - SUPPORTED_SCHEMA_VERSIONS accepts 1, '1.1', '1.2' (read backward compat)
//   - commit_manifest absent (additive optional) round-trips on schema 1.2 file
//   - commit_manifest populated entries round-trip (parse + serialize)
//   - commit_manifest entry-shape validation (required keys, unknown subkey
//     rejection)
//   - Schema 1.1 legacy file still readable, mutation preserves disk schema
//     (no silent promotion to 1.2)
//   - recordComposedFile / recordRefineFile helpers append under per-file
//     lock, accumulate multiple entries (no dedup), set phase / op correctly
//   - Helpers no-op when workflowPath is empty / missing (command-mode boundary)
//   - CLI subcommands record-composed-file / record-refine-file round-trip
//
// Run via `node --test tests/engineer/test-state-schema-12.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const STATE_PATH = resolve(REPO_ROOT, 'plugins/engineer/scripts/state.mjs');

const {
  SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  createWorkflow,
  readWorkflow,
  parseWorkflowFile,
  listWorkflowFiles,
  recordComposedFile,
  recordRefineFile,
  setCheckpoint,
} = await import(STATE_PATH);

function gitInit(dir, branch) {
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir, stdio: 'ignore' });
}

async function withTmpRepo(fn, { branch = 'test' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'engineer-schema12-'));
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
// T3a — schema 1.2 constants and read/write
// -----------------------------------------------------------------------------

describe('state.mjs — ADR-0028 §Layer-2 schema 1.2 constants', () => {
  it('SCHEMA_VERSION is "1.2" (ADR-0028 §Layer-2 commit_manifest bump)', () => {
    strictEqual(SCHEMA_VERSION, '1.2');
  });

  it('SUPPORTED_SCHEMA_VERSIONS accepts 1, "1.1", "1.2" (read backward compat)', () => {
    ok(SUPPORTED_SCHEMA_VERSIONS.has(1));
    ok(SUPPORTED_SCHEMA_VERSIONS.has('1.1'));
    ok(SUPPORTED_SCHEMA_VERSIONS.has('1.2'));
    strictEqual(SUPPORTED_SCHEMA_VERSIONS.has(2), false);
    strictEqual(SUPPORTED_SCHEMA_VERSIONS.has('1.3'), false);
  });
});

describe('state.mjs — ADR-0028 schema 1.2 file emit + round-trip', () => {
  it('createWorkflow writes schema: "1.2" on disk', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'compose',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'schema 1.2 emit test',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const raw = await readFile(filePath, 'utf8');
      ok(/^schema: "1\.2"$/m.test(raw), `expected schema: "1.2" on disk, got:\n${raw.split('\n').slice(0, 5).join('\n')}`);
    });
  });

  it('schema 1.2 file with commit_manifest absent reads OK (additive optional)', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'compose',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'no manifest',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.schema, '1.2');
      strictEqual('commit_manifest' in frontmatter, false);
    });
  });

  it('schema 1.2 file with empty commit_manifest: [] round-trips', () => {
    const text = buildFixture({
      schema: '"1.2"',
      extra: 'commit_manifest: []\n',
    });
    const { frontmatter } = parseWorkflowFile(text);
    deepStrictEqual(frontmatter.commit_manifest, []);
  });

  it('schema 1.2 file with populated commit_manifest entries round-trips', () => {
    const text = buildFixture({
      schema: '"1.2"',
      extra:
        'commit_manifest:\n' +
        '  - path: "plugins/engineer/scripts/validate-commit.mjs"\n' +
        '    phase: "compose"\n' +
        '    op: "create"\n' +
        '    recorded_at: "2026-05-19T04:00:00Z"\n' +
        '  - path: "plugins/engineer/scripts/state.mjs"\n' +
        '    phase: "refine"\n' +
        '    op: "edit"\n' +
        '    recorded_at: "2026-05-19T05:00:00Z"\n',
    });
    const { frontmatter } = parseWorkflowFile(text);
    strictEqual(frontmatter.commit_manifest.length, 2);
    deepStrictEqual(frontmatter.commit_manifest[0], {
      path: 'plugins/engineer/scripts/validate-commit.mjs',
      phase: 'compose',
      op: 'create',
      recorded_at: '2026-05-19T04:00:00Z',
    });
    strictEqual(frontmatter.commit_manifest[1].phase, 'refine');
    strictEqual(frontmatter.commit_manifest[1].op, 'edit');
  });

  it('rejects commit_manifest entry missing required key (path)', () => {
    const text = buildFixture({
      schema: '"1.2"',
      extra:
        'commit_manifest:\n' +
        '  - phase: "compose"\n' +
        '    op: "create"\n' +
        '    recorded_at: "2026-05-19T04:00:00Z"\n',
    });
    const err = (() => {
      try { parseWorkflowFile(text); return null; } catch (e) { return e; }
    })();
    ok(err, 'expected missing path to throw');
    ok(/path/.test(err.message), `message: ${err.message}`);
  });

  it('rejects commit_manifest entry with unknown subkey', () => {
    const text = buildFixture({
      schema: '"1.2"',
      extra:
        'commit_manifest:\n' +
        '  - path: "x"\n' +
        '    phase: "compose"\n' +
        '    op: "create"\n' +
        '    recorded_at: "2026-05-19T04:00:00Z"\n' +
        '    rogue_field: "intrusion"\n',
    });
    const err = (() => {
      try { parseWorkflowFile(text); return null; } catch (e) { return e; }
    })();
    ok(err, 'expected unknown subkey rogue_field to throw');
    ok(/rogue_field/.test(err.message), `message: ${err.message}`);
  });
});

describe('state.mjs — schema 1.1 → 1.2 backward compatibility', () => {
  it('reads a hand-crafted schema "1.1" file without commit_manifest (legacy)', () => {
    const text = buildFixture({ schema: '"1.1"', extra: '' });
    const { frontmatter } = parseWorkflowFile(text);
    strictEqual(frontmatter.schema, '1.1');
    strictEqual('commit_manifest' in frontmatter, false);
  });

  it('mutation of a schema "1.1" file preserves disk schema ("1.1", not silently bumped to "1.2")', async () => {
    // ADR-0017 §"Schema versioning policy" — mutation helpers preserve
    // the disk-recorded schema; no silent promotion of legacy files.
    // Equally applies to the 1.1 → 1.2 boundary introduced by ADR-0028.
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'baseline',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      // Hand-downgrade the on-disk schema to "1.1"
      const raw = await readFile(filePath, 'utf8');
      const downgraded = raw.replace(/^schema: "1\.2"$/m, 'schema: "1.1"');
      await writeFile(filePath, downgraded, { mode: 0o600 });

      // Mutate via setCheckpoint
      await setCheckpoint({
        workflowPath: filePath,
        host: 'claude',
        summary: 'preserve-schema test',
      });

      const after = await readFile(filePath, 'utf8');
      ok(/^schema: "1\.1"$/m.test(after), `expected schema "1.1" preserved, got:\n${after.split('\n').slice(0, 5).join('\n')}`);
    });
  });
});

// -----------------------------------------------------------------------------
// T3b — recordComposedFile / recordRefineFile helpers + CLI
// -----------------------------------------------------------------------------

describe('state.mjs — recordComposedFile (ADR-0028 §Layer-2 helper)', () => {
  it('appends a {path, phase: "compose", op, recorded_at} entry under the per-file lock', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'compose',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'compose record test',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      await recordComposedFile({
        workflowPath: filePath,
        path: 'plugins/engineer/scripts/validate-commit.mjs',
        op: 'create',
      });
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.commit_manifest.length, 1);
      strictEqual(frontmatter.commit_manifest[0].path, 'plugins/engineer/scripts/validate-commit.mjs');
      strictEqual(frontmatter.commit_manifest[0].phase, 'compose');
      strictEqual(frontmatter.commit_manifest[0].op, 'create');
      ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(frontmatter.commit_manifest[0].recorded_at));
    });
  });

  it('accumulates multiple entries (no dedup — a path may be touched repeatedly)', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot, verb: 'compose', host: 'claude',
        gitBaseline: MIN_BASELINE, originalRequest: 'multi-append',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      await recordComposedFile({ workflowPath: filePath, path: 'a.mjs', op: 'create' });
      await recordComposedFile({ workflowPath: filePath, path: 'a.mjs', op: 'edit' });
      await recordComposedFile({ workflowPath: filePath, path: 'b.mjs', op: 'create' });
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.commit_manifest.length, 3);
      strictEqual(frontmatter.commit_manifest[0].op, 'create');
      strictEqual(frontmatter.commit_manifest[1].op, 'edit');
      strictEqual(frontmatter.commit_manifest[2].path, 'b.mjs');
    });
  });

  it('no-ops when workflowPath is empty string (command-mode boundary — $ACTIVE not bound)', async () => {
    // ADR-0028 §Layer-2 "they run when $ACTIVE is bound (sub-step
    // invocation) and are no-ops otherwise". The CLI shim passes
    // --workflow-path "$ACTIVE" verbatim; when $ACTIVE is empty the
    // helper must silently return without mutating anything.
    const result = await recordComposedFile({
      workflowPath: '',
      path: 'x.mjs',
      op: 'create',
    });
    strictEqual(result.skipped, true);
    strictEqual(result.reason, 'no-active-workflow');
  });

  it('no-ops when workflowPath is undefined', async () => {
    const result = await recordComposedFile({ path: 'x.mjs', op: 'create' });
    strictEqual(result.skipped, true);
  });

  it('rejects unknown op value (only create / edit allowed)', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot, verb: 'compose', host: 'claude',
        gitBaseline: MIN_BASELINE, originalRequest: 't',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const err = await recordComposedFile({
        workflowPath: filePath,
        path: 'x.mjs',
        op: 'bogus',
      }).then(() => null, (e) => e);
      ok(err, 'expected bogus op to throw');
      ok(/op/.test(err.message), `message: ${err.message}`);
    });
  });

  it('rejects empty path', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot, verb: 'compose', host: 'claude',
        gitBaseline: MIN_BASELINE, originalRequest: 't',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const err = await recordComposedFile({
        workflowPath: filePath,
        path: '',
        op: 'create',
      }).then(() => null, (e) => e);
      ok(err, 'expected empty path to throw');
      ok(/path/.test(err.message), `message: ${err.message}`);
    });
  });

  // Codex critique M2 [security] — recordManifestEntry stores `path` for
  // future `git add <path>` consumption. Reject the three known pathspec
  // injection vectors at the helper boundary so Layer 2 stays hardened
  // independent of Layer 3 implementation:
  //  - leading `-` (would be interpreted as a flag like `-A` or `-f`)
  //  - pathspec magic prefix `:(...)` (broadens scope via signatures)
  //  - absolute path (Phase 7 staging operates on repo-relative paths)
  it('rejects path starting with "-" (flag injection: -A / -f)', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot, verb: 'compose', host: 'claude',
        gitBaseline: MIN_BASELINE, originalRequest: 't',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      for (const dangerous of ['-A', '-f', '--all', '-rm']) {
        const err = await recordComposedFile({
          workflowPath: filePath,
          path: dangerous,
          op: 'create',
        }).then(() => null, (e) => e);
        ok(err, `expected "${dangerous}" to throw`);
        ok(/leading.*-|flag|pathspec/i.test(err.message), `message for ${dangerous}: ${err.message}`);
      }
    });
  });

  it('rejects pathspec magic prefix ":(...)" (e.g., :(exclude), :(top))', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot, verb: 'compose', host: 'claude',
        gitBaseline: MIN_BASELINE, originalRequest: 't',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      for (const magic of [':(exclude)', ':(top)foo', ':!bar', ':/baz']) {
        const err = await recordComposedFile({
          workflowPath: filePath,
          path: magic,
          op: 'create',
        }).then(() => null, (e) => e);
        ok(err, `expected pathspec magic "${magic}" to throw`);
        ok(/pathspec/i.test(err.message), `message for ${magic}: ${err.message}`);
      }
    });
  });

  it('rejects absolute path (Phase 7 staging is repo-relative)', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot, verb: 'compose', host: 'claude',
        gitBaseline: MIN_BASELINE, originalRequest: 't',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const err = await recordComposedFile({
        workflowPath: filePath,
        path: '/etc/passwd',
        op: 'create',
      }).then(() => null, (e) => e);
      ok(err, 'expected absolute path to throw');
      ok(/absolute|repo-relative/i.test(err.message), `message: ${err.message}`);
    });
  });

  it('rejects ".." traversal segments (Refine-verify N1 hardening)', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot, verb: 'compose', host: 'claude',
        gitBaseline: MIN_BASELINE, originalRequest: 't',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      for (const traversal of ['..', '../escape', '../../etc/passwd', 'subdir/../../escape']) {
        const err = await recordComposedFile({
          workflowPath: filePath,
          path: traversal,
          op: 'create',
        }).then(() => null, (e) => e);
        ok(err, `expected "${traversal}" to throw`);
        ok(/traversal|\.\./i.test(err.message), `message for ${traversal}: ${err.message}`);
      }
    });
  });

  it('accepts repo-relative path with "-" in non-leading position (boundary lock)', async () => {
    // Refine-verify N1.1 — explicit positive case for the boundary between
    // "leading-dash rejection" (flag injection vector) and "legitimate
    // filenames containing a dash". `subdir/-leading-dash.txt` does NOT
    // start with `-`, so it MUST pass the helper. This test locks the
    // boundary so a future regression that tightens to "any dash anywhere"
    // fails loudly.
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot, verb: 'compose', host: 'claude',
        gitBaseline: MIN_BASELINE, originalRequest: 't',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      await recordComposedFile({
        workflowPath: filePath,
        path: 'subdir/-not-a-flag.txt',
        op: 'create',
      });
      await recordComposedFile({
        workflowPath: filePath,
        path: 'a-b-c.mjs',
        op: 'edit',
      });
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.commit_manifest.length, 2);
      strictEqual(frontmatter.commit_manifest[0].path, 'subdir/-not-a-flag.txt');
      strictEqual(frontmatter.commit_manifest[1].path, 'a-b-c.mjs');
    });
  });
});

describe('state.mjs — recordRefineFile (ADR-0028 §Layer-2 helper)', () => {
  it('appends a {path, phase: "refine", op, recorded_at} entry under the per-file lock', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot, verb: 'refine', host: 'claude',
        gitBaseline: MIN_BASELINE, originalRequest: 'refine record test',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      await recordRefineFile({
        workflowPath: filePath,
        path: 'plugins/engineer/scripts/state.mjs',
        op: 'edit',
      });
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.commit_manifest.length, 1);
      strictEqual(frontmatter.commit_manifest[0].phase, 'refine');
      strictEqual(frontmatter.commit_manifest[0].op, 'edit');
    });
  });

  it('no-ops when workflowPath is empty', async () => {
    const result = await recordRefineFile({ workflowPath: '', path: 'x.mjs', op: 'edit' });
    strictEqual(result.skipped, true);
  });
});

describe('state.mjs CLI — record-composed-file / record-refine-file subcommands', () => {
  it('record-composed-file --workflow-path <p> --path <p> --op <op> writes entry', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot, verb: 'compose', host: 'claude',
        gitBaseline: MIN_BASELINE, originalRequest: 'cli test',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const result = spawnSync(process.execPath, [
        STATE_PATH, 'record-composed-file',
        '--workflow-path', filePath,
        '--path', 'plugins/engineer/scripts/foo.mjs',
        '--op', 'create',
      ], { encoding: 'utf8' });
      strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.commit_manifest.length, 1);
      strictEqual(frontmatter.commit_manifest[0].phase, 'compose');
    });
  });

  it('record-refine-file --workflow-path <p> --path <p> --op <op> writes entry', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot, verb: 'refine', host: 'claude',
        gitBaseline: MIN_BASELINE, originalRequest: 'cli test',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const result = spawnSync(process.execPath, [
        STATE_PATH, 'record-refine-file',
        '--workflow-path', filePath,
        '--path', 'plugins/engineer/scripts/bar.mjs',
        '--op', 'edit',
      ], { encoding: 'utf8' });
      strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.commit_manifest[0].phase, 'refine');
    });
  });

  it('CLI no-ops with --workflow-path "" (command-mode boundary)', () => {
    const result = spawnSync(process.execPath, [
      STATE_PATH, 'record-composed-file',
      '--workflow-path', '',
      '--path', 'x.mjs',
      '--op', 'create',
    ], { encoding: 'utf8' });
    // Exit 0 and no error written to stderr — the no-op is the contract.
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
  });

  it('CLI fails loudly when --workflow-path is omitted entirely (Codex peer review G1)', () => {
    // ADR-0028 §Layer-2 + Codex peer review G1: the CLI requires the
    // flag to be PRESENT (cliRequire checks key presence in flags).
    // An empty value still no-ops via the helper's command-mode boundary,
    // but a fully omitted flag indicates a broken caller and must fail.
    const result = spawnSync(process.execPath, [
      STATE_PATH, 'record-composed-file',
      '--path', 'x.mjs',
      '--op', 'create',
    ], { encoding: 'utf8' });
    strictEqual(result.status, 1);
    ok(/--workflow-path/.test(result.stderr), `stderr: ${result.stderr}`);
  });
});

// -----------------------------------------------------------------------------
// G2 — legacy schema policy (Codex peer review documentation lock)
// -----------------------------------------------------------------------------

describe('state.mjs — recordComposedFile on legacy schema 1.1 file (Codex G2)', () => {
  it('appends commit_manifest to a schema "1.1" file without bumping schema marker', async () => {
    // ADR-0028 §Layer-2 documented behavior: helper preserves disk-recorded
    // schema per ADR-0017 §"Schema versioning policy". A 1.1 workflow file
    // that gains a commit_manifest entry stays at schema "1.1" — the
    // FRONTMATTER_KEY_ORDER gate (not the schema marker) governs whether
    // commit_manifest is a known key. Tools that key on `schema === "1.2"`
    // for feature detection should instead probe `'commit_manifest' in
    // frontmatter`.
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot, verb: 'compose', host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'legacy schema 1.1 + commit_manifest',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      // Hand-downgrade disk schema to "1.1"
      const raw = await readFile(filePath, 'utf8');
      const downgraded = raw.replace(/^schema: "1\.2"$/m, 'schema: "1.1"');
      await writeFile(filePath, downgraded, { mode: 0o600 });

      await recordComposedFile({
        workflowPath: filePath,
        path: 'plugins/engineer/scripts/foo.mjs',
        op: 'create',
      });

      const after = await readFile(filePath, 'utf8');
      ok(/^schema: "1\.1"$/m.test(after), 'schema marker must remain "1.1"');
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.schema, '1.1');
      strictEqual(frontmatter.commit_manifest.length, 1);
      strictEqual(frontmatter.commit_manifest[0].phase, 'compose');
    });
  });
});

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function buildFixture({ schema, extra }) {
  return (
    '---\n' +
    `schema: ${schema}\n` +
    'workflow_id: "compose-20260519T040000Z-abcdef"\n' +
    'persona: "engineer"\n' +
    'verb: "compose"\n' +
    'profile: ""\n' +
    'original_request: "fixture"\n' +
    'started_at: "2026-05-19T04:00:00Z"\n' +
    'updated_at: "2026-05-19T04:00:00Z"\n' +
    'repo_root: ""\n' +
    'git_baseline:\n' +
    '  branch: "test"\n' +
    '  head: "0000000000000000000000000000000000000000"\n' +
    '  status_digest: ""\n' +
    'current_phase: "phase-0"\n' +
    'next_action: ""\n' +
    'tasks: []\n' +
    'host_history:\n' +
    '  - host: "claude"\n' +
    '    at: "2026-05-19T04:00:00Z"\n' +
    '    event: "created"\n' +
    extra +
    '---\n\n# fixture\n'
  );
}
