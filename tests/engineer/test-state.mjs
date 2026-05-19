// plugins/engineer/scripts/state.mjs unit tests (Stage 2 Deliverable E,
// Cluster 2 Option B — regression protection for Phase 6 fixes).
//
// Covers:
//   - secret scrubbing (Phase 6 fix #8 — AWS ASIA + GitHub fine-grained PAT
//     + sk-/sk-ant-/sk-proj- + Slack tokens + 32+ hex bearer)
//   - singleLine helper (CR/LF collapse + multi-space collapse)
//   - generateWorkflowId regex shape per ADR-0011 §1
//   - parseWorkflowFile / validateFrontmatter (Phase 6 fix #7 — schema=1
//     closed, required fields, nested key sets, enum values)
//   - createWorkflow + readWorkflow round-trip (special chars preserved,
//     host_history append, frontmatter intact)
//   - single-active invariant enforcement (ADR-0011 §1)
//   - withFileLock serializes concurrent acquirers (Phase 6 fix #1 — lock
//     ownership protocol)
//
// Lock-race / atomic-rename internals (Phase 6 fix #1 detail and fix #2
// ownership-token verify) are exercised through public API behaviors —
// the rename-atomic stale reclaim is not directly observable without
// killing a process mid-lock, which is out of scope for in-process unit
// tests. The serialization assertion proves the public contract.
//
// Run via `node --test tests/engineer/test-state.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual, rejects, match } from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const STATE_PATH = resolve(REPO_ROOT, 'plugins/engineer/scripts/state.mjs');

const {
  scrubSecrets,
  singleLine,
  generateWorkflowId,
  parseWorkflowFile,
  createWorkflow,
  readWorkflow,
  listWorkflowFiles,
  findActiveWorkflow,
  findActiveWorkflowByBranch,
  withFileLock,
  workflowFilePath,
  WORKFLOW_DIR_REL,
  LEGACY_WORKFLOW_DIR_REL,
  // ADR-0017 schema 1.1
  SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  TERMINAL_PHASES,
  ENSEMBLE_RESULTS_RETENTION_CAP,
  ARCHIVE_DIR_REL,
  LEGACY_ARCHIVE_DIR_REL,
  resolveWorkflowStorage,
  pruneEnsembleResults,
  recordPendingEnsemble,
  commitEnsemble,
  setCheckpoint,
  setTerminal,
  archiveWorkflow,
  archiveDir,
  terminalMarkerCheck,
  terminalPhaseCheck,
  noActiveChildrenCheck,
} = await import(STATE_PATH);

// Real git repo so findActiveWorkflow's `git branch --show-current` probe
// (ADR-0018 §sub-2) returns the expected name. Without the init+checkout,
// the probe sees detached/uninitialized state and branch-keyed lookup
// returns null even when a same-branch workflow is on disk.
function gitInit(dir, branch) {
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir, stdio: 'ignore' });
}

async function withTmpRepo(fn, { branch = 'test' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'engineer-state-test-'));
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

async function writeWorkflowFixture(path, branch) {
  await writeFile(path, [
    '---',
    `workflow_id: ${JSON.stringify(path.split('/').at(-1).replace(/\.md$/, ''))}`,
    'schema: "1.1"',
    'persona: "engineer"',
    'verb: "investigate"',
    'profile: ""',
    'original_request: "fixture"',
    'started_at: "2026-01-01T00:00:00Z"',
    'updated_at: "2026-01-01T00:00:00Z"',
    'repo_root: ""',
    'git_baseline:',
    `  branch: ${JSON.stringify(branch)}`,
    '  head: "0000000000000000000000000000000000000000"',
    '  status_digest: ""',
    'current_phase: "phase-0"',
    'next_action: ""',
    'tasks:',
    'host_history:',
    '  - host: "codex"',
    '    at: "2026-01-01T00:00:00Z"',
    '    event: "created"',
    'workflow_type: "verb-chain"',
    '---',
    '',
    '# fixture',
    '',
  ].join('\n'));
}

describe('state.mjs — scrubSecrets (Phase 6 fix #8 — extended secret patterns)', () => {
  it('AWS access key (AKIA prefix) is redacted', () => {
    const out = scrubSecrets('aws=AKIAIOSFODNN7EXAMPLE rest');
    strictEqual(out, 'aws=<redacted> rest');
  });

  it('AWS temporary credential (ASIA prefix) is redacted (Phase 6)', () => {
    const out = scrubSecrets('temp=ASIAIOSFODNN7EXAMPLE done');
    strictEqual(out, 'temp=<redacted> done');
  });

  it('GitHub classic token (ghp_) is redacted', () => {
    const out = scrubSecrets('tok=ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    strictEqual(out, 'tok=<redacted>');
  });

  it('GitHub fine-grained PAT (github_pat_) is redacted (Phase 6)', () => {
    const out = scrubSecrets(
      'tok=github_pat_11ABCDEFGHIJKLMNOPQRSTU_extralongstring1234567890abcdefgh',
    );
    strictEqual(out, 'tok=<redacted>');
  });

  it('OpenAI/Anthropic API keys (sk-, sk-ant-, sk-proj-) are redacted (Phase 6)', () => {
    strictEqual(
      scrubSecrets('key=sk-abcdefghijklmnopqrstuvwxyz0123'),
      'key=<redacted>',
    );
    strictEqual(
      scrubSecrets('key=sk-ant-abcdefghijklmnopqrstuvwxyz0123'),
      'key=<redacted>',
    );
    strictEqual(
      scrubSecrets('key=sk-proj-abcdefghijklmnopqrstuvwxyz0123'),
      'key=<redacted>',
    );
  });

  it('Slack tokens (xoxb-, xoxp-, xoxa-, xoxr-) are redacted (Phase 6)', () => {
    for (const prefix of ['xoxb', 'xoxp', 'xoxa', 'xoxr']) {
      const out = scrubSecrets(`tok=${prefix}-1234567890-abcdef`);
      strictEqual(out, 'tok=<redacted>', `prefix=${prefix} not redacted`);
    }
  });

  it('Generic 32+ hex bearer token is redacted', () => {
    const out = scrubSecrets('bearer=abcdef0123456789abcdef0123456789ab rest');
    strictEqual(out, 'bearer=<redacted> rest');
  });

  it('Plain text without secrets is unchanged', () => {
    const input = 'This is a normal sentence with words and spaces.';
    strictEqual(scrubSecrets(input), input);
  });

  it('Multiple secrets in one input are all redacted', () => {
    const out = scrubSecrets(
      'a=AKIAIOSFODNN7EXAMPLE b=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    );
    strictEqual(out, 'a=<redacted> b=<redacted>');
  });
});

describe('state.mjs — singleLine', () => {
  it('collapses LF to space', () => {
    strictEqual(singleLine('a\nb'), 'a b');
  });

  it('collapses CRLF to space', () => {
    strictEqual(singleLine('a\r\nb'), 'a b');
  });

  it('collapses multiple consecutive spaces to single space', () => {
    strictEqual(singleLine('a    b'), 'a b');
  });

  it('trims leading/trailing whitespace', () => {
    strictEqual(singleLine('  a b  '), 'a b');
  });

  it('mixed CR/LF/multi-space combination is normalized', () => {
    strictEqual(singleLine('  a\n\n  b\r\n  c  '), 'a b c');
  });
});

describe('state.mjs — generateWorkflowId (ADR-0011 §1 format)', () => {
  it('produces id matching <verb>-YYYYMMDDTHHMMSSZ-<6 hex>', () => {
    const id = generateWorkflowId('investigate');
    ok(/^investigate-\d{8}T\d{6}Z-[0-9a-f]{6}$/.test(id), `unexpected id shape: ${id}`);
  });

  it('honors injected `now` for deterministic timestamp', () => {
    const id = generateWorkflowId('compose', {
      now: new Date('2026-05-06T12:34:56Z'),
    });
    ok(id.startsWith('compose-20260506T123456Z-'), `id="${id}"`);
  });

  it('rejects invalid verbs', () => {
    try {
      generateWorkflowId('invalid-verb');
      ok(false, 'should have thrown for invalid verb');
    } catch (err) {
      ok(/Invalid verb/i.test(err.message), `unexpected error: ${err.message}`);
    }
  });
});

describe('state.mjs — parseWorkflowFile + validateFrontmatter (Phase 6 fix #7)', () => {
  it('round-trips a freshly created workflow', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'test request',
        currentPhase: 'phase-0',
        nextAction: 'do thing',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      ok(filePath, 'no workflow file found');
      const { frontmatter, body } = await readWorkflow(filePath);
      // ADR-0028 §Layer-2 bumped emit to schema "1.2"; legacy 1/1.1 readers
      // still accepted (SUPPORTED_SCHEMA_VERSIONS).
      strictEqual(frontmatter.schema, '1.2');
      strictEqual(frontmatter.verb, 'investigate');
      strictEqual(frontmatter.persona, 'engineer');
      strictEqual(frontmatter.original_request, 'test request');
      strictEqual(frontmatter.current_phase, 'phase-0');
      strictEqual(frontmatter.next_action, 'do thing');
      ok(Array.isArray(frontmatter.host_history));
      strictEqual(frontmatter.host_history.length, 1);
      strictEqual(frontmatter.host_history[0].event, 'created');
      strictEqual(frontmatter.host_history[0].host, 'claude');
      ok(body.includes('phase-0'));
    });
  });

  it('rejects schema mismatch (schema=1 closed per ADR-0011 §2)', () => {
    const text = `---
schema: 99
workflow_id: x-20260506T000000Z-abcdef
persona: engineer
verb: investigate
profile: ""
original_request: ""
started_at: 2026-05-06T00:00:00Z
updated_at: 2026-05-06T00:00:00Z
repo_root: /tmp
git_baseline:
  branch: main
  head: 0000000000000000000000000000000000000000
  status_digest: ""
current_phase: phase-0
next_action: ""
tasks: []
host_history:
  - host: claude
    at: 2026-05-06T00:00:00Z
    event: created
---

# body
`;
    try {
      parseWorkflowFile(text);
      ok(false, 'should have thrown for schema=99');
    } catch (err) {
      ok(/Unsupported schema/.test(err.message), `unexpected error: ${err.message}`);
    }
  });

  it('rejects missing required field', () => {
    const text = `---
schema: 1
workflow_id: x-20260506T000000Z-abcdef
persona: engineer
verb: investigate
profile: ""
original_request: ""
started_at: 2026-05-06T00:00:00Z
updated_at: 2026-05-06T00:00:00Z
repo_root: /tmp
git_baseline:
  branch: main
  head: 0000000000000000000000000000000000000000
  status_digest: ""
current_phase: phase-0
tasks: []
host_history: []
---

# body
`;
    // Missing next_action
    try {
      parseWorkflowFile(text);
      ok(false, 'should have thrown for missing next_action');
    } catch (err) {
      ok(/Missing required.*next_action/.test(err.message), `err: ${err.message}`);
    }
  });

  it('rejects unknown nested key in git_baseline', () => {
    const text = `---
schema: 1
workflow_id: x-20260506T000000Z-abcdef
persona: engineer
verb: investigate
profile: ""
original_request: ""
started_at: 2026-05-06T00:00:00Z
updated_at: 2026-05-06T00:00:00Z
repo_root: /tmp
git_baseline:
  branch: main
  head: 0000000000000000000000000000000000000000
  status_digest: ""
  bogus: extra
current_phase: phase-0
next_action: ""
tasks: []
host_history: []
---

# body
`;
    try {
      parseWorkflowFile(text);
      ok(false, 'should have thrown for unknown nested key');
    } catch (err) {
      ok(/Unknown nested key git_baseline\.bogus/.test(err.message), `err: ${err.message}`);
    }
  });

  it('rejects invalid host in host_history entry', () => {
    const text = `---
schema: 1
workflow_id: x-20260506T000000Z-abcdef
persona: engineer
verb: investigate
profile: ""
original_request: ""
started_at: 2026-05-06T00:00:00Z
updated_at: 2026-05-06T00:00:00Z
repo_root: /tmp
git_baseline:
  branch: main
  head: 0000000000000000000000000000000000000000
  status_digest: ""
current_phase: phase-0
next_action: ""
tasks: []
host_history:
  - host: bogus
    at: 2026-05-06T00:00:00Z
    event: created
---

# body
`;
    try {
      parseWorkflowFile(text);
      ok(false, 'should have thrown for invalid host');
    } catch (err) {
      ok(/Invalid host/.test(err.message), `err: ${err.message}`);
    }
  });
});

describe('state.mjs — createWorkflow round-trip with special characters', () => {
  it('creates new workflow state under canonical .agentic-plugins/state by default', async () => {
    await withTmpRepo(async (repoRoot) => {
      const { filePath } = await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'codex',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'canonical state home',
      });
      ok(filePath.includes('/.agentic-plugins/state/engineer/workflows/'), filePath);
      const storage = await resolveWorkflowStorage(repoRoot);
      strictEqual(storage.home, 'canonical');
      strictEqual(storage.canonicalHasState, true);
      strictEqual(storage.legacyHasState, false);
    });
  });

  it('keeps writing to the legacy state home while legacy engineer state exists', async () => {
    await withTmpRepo(async (repoRoot) => {
      const legacyDir = join(repoRoot, LEGACY_WORKFLOW_DIR_REL);
      await mkdir(legacyDir, { recursive: true });
      await writeWorkflowFixture(
        join(legacyDir, 'investigate-20260101T000000Z-aaaaaa.md'),
        'legacy/main',
      );

      const { filePath } = await createWorkflow({
        repoRoot,
        verb: 'compose',
        host: 'claude',
        gitBaseline: { ...MIN_BASELINE, branch: 'feature/new' },
        originalRequest: 'legacy write continuity',
      });

      ok(filePath.includes('/.claude/agentic-engineer/workflows/'), filePath);
      const storage = await resolveWorkflowStorage(repoRoot);
      strictEqual(storage.home, 'legacy');
      strictEqual(storage.canonicalHasState, false);
      strictEqual(storage.legacyHasState, true);
    });
  });

  it('fails closed when canonical and legacy homes both have an active workflow on the same branch', async () => {
    await withTmpRepo(async (repoRoot) => {
      await mkdir(join(repoRoot, WORKFLOW_DIR_REL), { recursive: true });
      await mkdir(join(repoRoot, LEGACY_WORKFLOW_DIR_REL), { recursive: true });
      await writeWorkflowFixture(
        join(repoRoot, WORKFLOW_DIR_REL, 'investigate-20260101T000000Z-aaaaaa.md'),
        'test',
      );
      await writeWorkflowFixture(
        join(repoRoot, LEGACY_WORKFLOW_DIR_REL, 'investigate-20260101T000001Z-bbbbbb.md'),
        'test',
      );

      await rejects(
        () => findActiveWorkflowByBranch(repoRoot, 'test'),
        /Ambiguous engineer workflow storage/,
      );
    });
  });

  it('blocks ordinary writes when canonical and legacy homes both contain engineer state', async () => {
    await withTmpRepo(async (repoRoot) => {
      await mkdir(join(repoRoot, WORKFLOW_DIR_REL), { recursive: true });
      await mkdir(join(repoRoot, LEGACY_WORKFLOW_DIR_REL), { recursive: true });
      await writeWorkflowFixture(
        join(repoRoot, WORKFLOW_DIR_REL, 'investigate-20260101T000000Z-aaaaaa.md'),
        'canonical/branch',
      );
      await writeWorkflowFixture(
        join(repoRoot, LEGACY_WORKFLOW_DIR_REL, 'investigate-20260101T000001Z-bbbbbb.md'),
        'legacy/branch',
      );

      await rejects(
        () => createWorkflow({
          repoRoot,
          verb: 'compose',
          host: 'codex',
          gitBaseline: MIN_BASELINE,
          originalRequest: 'blocked split home',
        }),
        /Workflow storage migration blocked/,
      );
    });
  });

  it('preserves UTF-8 / quotes / Korean / control-adjacent chars in original_request', async () => {
    await withTmpRepo(async (repoRoot) => {
      const tricky = '한국어 + "quoted" + symbols #@! and unicode ☕';
      await createWorkflow({
        repoRoot,
        verb: 'frame',
        host: 'codex',
        gitBaseline: MIN_BASELINE,
        originalRequest: tricky,
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.original_request, tricky);
    });
  });

  it('scrubs secrets in original_request before persisting', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'lookup AKIAIOSFODNN7EXAMPLE problem',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const { frontmatter } = await readWorkflow(filePath);
      ok(
        !frontmatter.original_request.includes('AKIAIOSFODNN7EXAMPLE'),
        `secret leaked into frontmatter: ${frontmatter.original_request}`,
      );
      ok(frontmatter.original_request.includes('<redacted>'));
    });
  });
});

describe('state.mjs — single-active invariant (ADR-0011 §1, ADR-0018 §sub-2 cascade)', () => {
  it('rejects second createWorkflow on the same branch (per-branch invariant)', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'first',
      });
      await rejects(
        async () => {
          await createWorkflow({
            repoRoot,
            verb: 'compose',
            host: 'claude',
            gitBaseline: MIN_BASELINE,
            originalRequest: 'second',
          });
        },
        /per-branch|same-branch|already exists on branch/i,
      );
    });
  });

  it('allows createWorkflow on a different branch when one already exists (cross-branch coexistence)', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'on test branch',
      });
      // Switch fixture to 'other' branch; createWorkflow with a
      // matching gitBaseline.branch must succeed since same-branch
      // single-active is per ADR-0018 §sub-2 not directory-wide.
      execFileSync('git', ['checkout', '-q', '-b', 'other'], {
        cwd: repoRoot,
        stdio: 'ignore',
      });
      await createWorkflow({
        repoRoot,
        verb: 'compose',
        host: 'claude',
        gitBaseline: { ...MIN_BASELINE, branch: 'other' },
        originalRequest: 'on other branch',
      });
      const files = await listWorkflowFiles(repoRoot);
      strictEqual(files.length, 2, 'both workflows should coexist on disk');
    });
  });
});

describe('state.mjs — findActiveWorkflow branch-keyed lookup (ADR-0018 §sub-2)', () => {
  it('(a) returns null on empty workflows directory', async () => {
    await withTmpRepo(async (repoRoot) => {
      strictEqual(await findActiveWorkflow(repoRoot), null);
    });
  });

  it('(b) returns path when single workflow matches current branch', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'same-branch case',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      strictEqual(await findActiveWorkflow(repoRoot), filePath);
    });
  });

  it('(c) returns null when single workflow is on a different branch', async () => {
    await withTmpRepo(async (repoRoot) => {
      // Fixture is on 'test'; workflow's git_baseline.branch is 'other'.
      // createWorkflow's own branch reject would block this in the
      // public API after A5, so we use findActiveWorkflowByBranch
      // directly to verify the resolver itself.
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: { ...MIN_BASELINE, branch: 'other' },
        originalRequest: 'cross-branch case',
      });
      strictEqual(
        await findActiveWorkflowByBranch(repoRoot, 'test'),
        null,
        'workflow on branch=other must not match current branch=test',
      );
    });
  });

  it('(d) throws when two same-branch workflow files coexist (corruption / external write)', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'first',
      });
      // Bypass createWorkflow's branch-keyed reject by duplicating the
      // workflow file directly — simulates external mutation or
      // pre-Option-A migration leftover.
      const [first] = await listWorkflowFiles(repoRoot);
      const second = first.replace(/-[0-9a-f]{6}\.md$/, '-aaaaaa.md');
      const content = await readFile(first, 'utf8');
      await writeFile(second, content, { mode: 0o600 });
      await rejects(
        async () => {
          await findActiveWorkflow(repoRoot);
        },
        /per-branch|same-branch|two workflows/i,
      );
    });
  });

  it('(e) returns null under detached HEAD (empty branch identity)', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'detached test',
      });
      // Empty branch simulates detached HEAD without mutating the
      // fixture's git state (which would risk leaking into other tests).
      strictEqual(await findActiveWorkflowByBranch(repoRoot, ''), null);
    });
  });

  it('(f) treats branch identity as case-sensitive (Feature/x !== feature/x)', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: { ...MIN_BASELINE, branch: 'Feature/x' },
        originalRequest: 'case-sensitive',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      strictEqual(
        await findActiveWorkflowByBranch(repoRoot, 'Feature/x'),
        filePath,
        'exact case match must succeed',
      );
      strictEqual(
        await findActiveWorkflowByBranch(repoRoot, 'feature/x'),
        null,
        'case-only difference must NOT match (byte-exact rule)',
      );
    });
  });

  it('(g) cross-branch malformed file does NOT block same-branch lookup (lightweight extractor + skip)', async () => {
    await withTmpRepo(async (repoRoot) => {
      const { filePath: validPath } = await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'good',
      });
      // Sibling file whose body is corrupt but whose lightweight
      // extractable git_baseline.branch is 'other' — cross-branch.
      // The lightweight extractor reads `branch: "other"` and skips
      // this file without invoking the strict parseWorkflowFile.
      const sibling = join(
        repoRoot,
        '.agentic-plugins/state/engineer/workflows/investigate-20260101T000000Z-zzzzzz.md',
      );
      await writeFile(
        sibling,
        '---\nschema: 99\ngit_baseline:\n  branch: "other"\n---\n!!corrupt body!!\n',
        { mode: 0o600 },
      );
      const result = await findActiveWorkflow(repoRoot);
      strictEqual(
        result,
        validPath,
        'cross-branch malformed file must not block lookup of the same-branch workflow',
      );
    });
  });

  it('(h) same-branch malformed file FAILS CLOSED (Codex P2 — invariant protection)', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'good',
      });
      // Sibling file with no extractable branch field AND unparseable
      // frontmatter. Under skip-malformed policy this would silently
      // hide a potential same-branch duplicate; the fail-closed rule
      // (sub-2 brainstorm decision) requires findActiveWorkflow to
      // throw rather than risk inviting createWorkflow to add a
      // second same-branch file.
      const opaque = join(
        repoRoot,
        '.agentic-plugins/state/engineer/workflows/investigate-20260101T000000Z-zzzzzz.md',
      );
      await writeFile(opaque, '---\n!!totally corrupt!!\n', { mode: 0o600 });
      await rejects(
        async () => {
          await findActiveWorkflow(repoRoot);
        },
        /branch identity is undeterminable|invariant at risk/i,
      );
    });
  });
});

describe('state.mjs CLI — find-active --branch + auto-probe (ADR-0018 §sub-2)', () => {
  function runCli(args) {
    return spawnSync(process.execPath, [STATE_PATH, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  it('(a) auto-probe: same-branch workflow → stdout=path, exit=0', async () => {
    await withTmpRepo(async (repoRoot) => {
      const { filePath } = await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'cli auto-probe success',
      });
      const proc = runCli(['find-active', '--repo-root', repoRoot]);
      strictEqual(proc.status, 0, `stderr: ${proc.stderr}`);
      strictEqual(proc.stdout.trim(), filePath);
    });
  });

  it('(b) auto-probe: cross-branch workflow → stdout=empty, exit=0', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: { ...MIN_BASELINE, branch: 'other' },
        originalRequest: 'cli cross-branch',
      });
      const proc = runCli(['find-active', '--repo-root', repoRoot]);
      strictEqual(proc.status, 0, `stderr: ${proc.stderr}`);
      strictEqual(proc.stdout, '');
    });
  });

  it('(c) --branch "" (detached-HEAD equivalent) → stdout=empty, exit=0', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'cli detached',
      });
      const proc = runCli([
        'find-active',
        '--repo-root',
        repoRoot,
        '--branch',
        '',
      ]);
      strictEqual(proc.status, 0, `stderr: ${proc.stderr}`);
      strictEqual(proc.stdout, '');
    });
  });

  it('(d) auto-probe: same-branch duplicate → exit=1, stderr contains per-branch reason', async () => {
    await withTmpRepo(async (repoRoot) => {
      const { filePath } = await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'cli dup first',
      });
      // Duplicate the file directly to bypass createWorkflowUnderLock's
      // own per-branch reject — simulating corruption.
      const second = filePath.replace(/-[0-9a-f]{6}\.md$/, '-aaaaaa.md');
      const text = await readFile(filePath, 'utf8');
      await writeFile(second, text, { mode: 0o600 });
      const proc = runCli(['find-active', '--repo-root', repoRoot]);
      strictEqual(proc.status, 1);
      match(proc.stderr, /per-branch|same-branch|two workflows/i);
    });
  });

  it('(e) --branch X overrides auto-probe (tests bypass git probing)', async () => {
    await withTmpRepo(async (repoRoot) => {
      const { filePath } = await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: { ...MIN_BASELINE, branch: 'feat/explicit' },
        originalRequest: 'cli explicit branch',
      });
      // Fixture branch is 'test'; auto-probe would return null for
      // this workflow. --branch 'feat/explicit' must locate it.
      const proc = runCli([
        'find-active',
        '--repo-root',
        repoRoot,
        '--branch',
        'feat/explicit',
      ]);
      strictEqual(proc.status, 0, `stderr: ${proc.stderr}`);
      strictEqual(proc.stdout.trim(), filePath);
    });
  });
});

describe('state.mjs — withFileLock serialization (Phase 6 fix #1 ownership protocol)', () => {
  it('two concurrent acquirers serialize (one waits for the other)', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'lock test',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);

      const events = [];
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      const a = withFileLock(filePath, async () => {
        events.push('A:enter');
        await sleep(50);
        events.push('A:exit');
      });

      const b = withFileLock(filePath, async () => {
        events.push('B:enter');
        await sleep(10);
        events.push('B:exit');
      });

      await Promise.all([a, b]);

      // Either A then B, or B then A — but never interleaved.
      const sequence = events.join(',');
      const validSequences = ['A:enter,A:exit,B:enter,B:exit', 'B:enter,B:exit,A:enter,A:exit'];
      ok(
        validSequences.includes(sequence),
        `lock did NOT serialize: ${sequence}`,
      );
    });
  });

  it('passes ownership { lockPath, token } to the wrapped fn', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'token test',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);

      let received;
      await withFileLock(filePath, async (ownership) => {
        received = ownership;
      });

      ok(received, 'fn was not given ownership object');
      strictEqual(typeof received.lockPath, 'string');
      strictEqual(typeof received.token, 'string');
      ok(received.token.length > 0, 'token is empty');
      ok(received.lockPath.endsWith('.lock'), `lockPath: ${received.lockPath}`);
    });
  });
});

// ============================================================================
// ADR-0017 schema 1.1 — additive optional frontmatter fields, ensemble
// bookkeeping helpers, archive helper, gate helpers.
// ============================================================================

describe('state.mjs — ADR-0017 schema 1.1 + ADR-0028 schema 1.2 constants', () => {
  it('SCHEMA_VERSION is "1.2" (ADR-0028 §Layer-2 commit_manifest bump)', () => {
    strictEqual(SCHEMA_VERSION, '1.2');
  });

  it('SUPPORTED_SCHEMA_VERSIONS accepts 1, "1.1", and "1.2" (read backward compat)', () => {
    ok(SUPPORTED_SCHEMA_VERSIONS.has(1));
    ok(SUPPORTED_SCHEMA_VERSIONS.has('1.1'));
    ok(SUPPORTED_SCHEMA_VERSIONS.has('1.2'));
    strictEqual(SUPPORTED_SCHEMA_VERSIONS.has(2), false);
    strictEqual(SUPPORTED_SCHEMA_VERSIONS.has('1.0'), false);
  });

  it('TERMINAL_PHASES whitelist matches ADR-0017 §sub-5', () => {
    ok(TERMINAL_PHASES.has('commit-complete'));
    ok(TERMINAL_PHASES.has('summary-complete'));
    ok(TERMINAL_PHASES.has('fix-complete'));
    strictEqual(TERMINAL_PHASES.has('phase-2-presented'), false);
  });

  it('ENSEMBLE_RESULTS_RETENTION_CAP is 20', () => {
    strictEqual(ENSEMBLE_RESULTS_RETENTION_CAP, 20);
  });

  it('workflow and archive dirs default to canonical .agentic-plugins/state', () => {
    strictEqual(WORKFLOW_DIR_REL, '.agentic-plugins/state/engineer/workflows');
    strictEqual(ARCHIVE_DIR_REL, '.agentic-plugins/state/engineer/archive');
    strictEqual(LEGACY_ARCHIVE_DIR_REL, '.claude/agentic-engineer/archive');
  });
});

describe('state.mjs — ADR-0017 frontmatter accept (read-side, schema 1 + "1.1")', () => {
  it('reads a legacy schema=1 file (hand-downgraded) with no 1.1 fields (backward compat)', async () => {
    await withTmpRepo(async (repoRoot) => {
      // PR3 flipped createWorkflow's emit to schema="1.1", so to test the
      // schema-1 (legacy) read path we hand-downgrade the on-disk schema
      // field after creation. This simulates a pre-PR3 file landing on a
      // post-PR3 reader, which ADR-0017 "additive non-breaking" guarantees.
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'legacy schema 1',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const { readFile, writeFile } = await import('node:fs/promises');
      const raw = await readFile(filePath, 'utf8');
      // ADR-0028 §Layer-2 — createWorkflow now emits schema "1.2"; the
      // legacy backward-compat test still hand-downgrades to integer 1.
      const downgraded = raw.replace(/^schema: "1\.2"\s*$/m, 'schema: 1');
      await writeFile(filePath, downgraded, { mode: 0o600 });

      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.schema, 1);
      strictEqual('latest_checkpoint' in frontmatter, false);
      strictEqual('ensemble_results' in frontmatter, false);
      strictEqual('pending_ensemble' in frontmatter, false);
      strictEqual('terminal_marker' in frontmatter, false);
      strictEqual('child_completions' in frontmatter, false);
    });
  });

  it('reads a hand-crafted schema="1.1" file with all five new fields populated', () => {
    const text =
      '---\n' +
      'schema: "1.1"\n' +
      'workflow_id: "investigate-20260507T010101Z-abcdef"\n' +
      'persona: "engineer"\n' +
      'verb: "investigate"\n' +
      'profile: ""\n' +
      'original_request: "round-trip test"\n' +
      'started_at: "2026-05-07T01:01:01Z"\n' +
      'updated_at: "2026-05-07T01:02:00Z"\n' +
      'repo_root: "/tmp/repo"\n' +
      'git_baseline:\n' +
      '  branch: "main"\n' +
      '  head: "0000000000000000000000000000000000000000"\n' +
      '  status_digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"\n' +
      'current_phase: "commit-complete"\n' +
      'next_action: "archive"\n' +
      'tasks: []\n' +
      'host_history:\n' +
      '  - host: "claude"\n' +
      '    at: "2026-05-07T01:01:01Z"\n' +
      '    event: "created"\n' +
      'latest_checkpoint:\n' +
      '  at: "2026-05-07T01:01:30Z"\n' +
      '  summary: "halfway through implementation"\n' +
      'pending_ensemble:\n' +
      '  - phase: "review"\n' +
      '    ensemble_type: "review"\n' +
      '    run_id: "review-123"\n' +
      '    started_at: "2026-05-07T01:01:45Z"\n' +
      'ensemble_results:\n' +
      '  - phase: "explore"\n' +
      '    ensemble_type: "explore"\n' +
      '    run_id: "explore-001"\n' +
      '    verdict: "agree"\n' +
      '    summary: "Codex AGREED on architecture"\n' +
      '    completed_at: "2026-05-07T01:01:50Z"\n' +
      '    codex_session_id: "sess-abc"\n' +
      'terminal_marker: true\n' +
      'child_completions:\n' +
      '  - child_id: "fix-20260507T010202Z-xyz"\n' +
      '    spawned_at: "2026-05-07T01:02:02Z"\n' +
      '    commit: "deadbeef"\n' +
      '    closed_at: "2026-05-07T01:03:00Z"\n' +
      '---\n\n# body\n';
    const { frontmatter } = parseWorkflowFile(text);
    strictEqual(frontmatter.schema, '1.1');
    deepStrictEqual(frontmatter.latest_checkpoint, {
      at: '2026-05-07T01:01:30Z',
      summary: 'halfway through implementation',
    });
    strictEqual(frontmatter.terminal_marker, true);
    strictEqual(frontmatter.pending_ensemble.length, 1);
    strictEqual(frontmatter.pending_ensemble[0].run_id, 'review-123');
    strictEqual(frontmatter.ensemble_results.length, 1);
    strictEqual(frontmatter.ensemble_results[0].codex_session_id, 'sess-abc');
    strictEqual(frontmatter.child_completions[0].commit, 'deadbeef');
  });

  it('rejects schema=2 (still closed; only 1 + "1.1" supported)', () => {
    const text =
      '---\nschema: 2\nworkflow_id: "x"\npersona: "engineer"\nverb: "investigate"\n' +
      'profile: ""\noriginal_request: ""\nstarted_at: ""\nupdated_at: ""\n' +
      'repo_root: ""\ngit_baseline:\n  branch: ""\n  head: ""\n  status_digest: ""\n' +
      'current_phase: ""\nnext_action: ""\ntasks: []\nhost_history: []\n---\n\n';
    const err = (() => {
      try { parseWorkflowFile(text); return null; } catch (e) { return e; }
    })();
    ok(err, 'expected schema=2 to be rejected');
    ok(/Unsupported schema/.test(err.message), `message: ${err.message}`);
  });

  it('rejects unknown 1.1 entry-key under ensemble_results', () => {
    const text =
      '---\nschema: "1.1"\nworkflow_id: "x"\npersona: "engineer"\nverb: "investigate"\n' +
      'profile: ""\noriginal_request: ""\nstarted_at: ""\nupdated_at: ""\n' +
      'repo_root: ""\ngit_baseline:\n  branch: ""\n  head: ""\n  status_digest: ""\n' +
      'current_phase: ""\nnext_action: ""\ntasks: []\nhost_history: []\n' +
      'ensemble_results:\n' +
      '  - phase: "x"\n    ensemble_type: "x"\n    run_id: "x"\n' +
      '    verdict: "x"\n    summary: "x"\n    completed_at: "x"\n' +
      '    codex_session_id: "x"\n    rogue_field: "intrusion"\n' +
      '---\n\n';
    const err = (() => {
      try { parseWorkflowFile(text); return null; } catch (e) { return e; }
    })();
    ok(err, 'expected unknown nested key rogue_field to throw');
    ok(/rogue_field/.test(err.message), `message: ${err.message}`);
  });
});

describe('state.mjs — pruneEnsembleResults FIFO retention (ADR-0017 §sub-4)', () => {
  it('returns input unchanged when length ≤ cap', () => {
    const entries = [
      { run_id: 'a', completed_at: '2026-05-07T01:00:00Z' },
      { run_id: 'b', completed_at: '2026-05-07T01:01:00Z' },
    ];
    deepStrictEqual(pruneEnsembleResults(entries, 5), entries);
  });

  it('evicts oldest by completed_at when length > cap (cap=2)', () => {
    const entries = [
      { run_id: 'old', completed_at: '2026-05-07T01:00:00Z' },
      { run_id: 'mid', completed_at: '2026-05-07T01:01:00Z' },
      { run_id: 'new', completed_at: '2026-05-07T01:02:00Z' },
    ];
    const pruned = pruneEnsembleResults(entries, 2);
    strictEqual(pruned.length, 2);
    strictEqual(pruned[0].run_id, 'mid');
    strictEqual(pruned[1].run_id, 'new');
  });

  it('default cap is 20 — 21st append evicts the oldest', () => {
    const entries = [];
    for (let i = 0; i < 21; i++) {
      const stamp = `2026-05-07T01:${String(i).padStart(2, '0')}:00Z`;
      entries.push({ run_id: `run-${i}`, completed_at: stamp });
    }
    const pruned = pruneEnsembleResults(entries);
    strictEqual(pruned.length, 20);
    strictEqual(pruned[0].run_id, 'run-1');
    strictEqual(pruned[19].run_id, 'run-20');
  });

  it('does not mutate the input array', () => {
    const entries = [
      { run_id: 'a', completed_at: '2026-05-07T01:02:00Z' },
      { run_id: 'b', completed_at: '2026-05-07T01:00:00Z' },
    ];
    const before = JSON.stringify(entries);
    pruneEnsembleResults(entries, 1);
    strictEqual(JSON.stringify(entries), before);
  });

  it('rejects negative or non-integer caps', () => {
    const err = (() => {
      try { pruneEnsembleResults([], -1); return null; } catch (e) { return e; }
    })();
    ok(err, 'expected negative cap to throw');
  });
});

describe('state.mjs — recordPendingEnsemble (ADR-0017 §sub-4 idempotent)', () => {
  it('appends a new pending entry under the per-file lock', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'test',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      await recordPendingEnsemble({
        workflowPath: filePath,
        phase: 'review',
        ensemble_type: 'review',
        run_id: 'review-123',
      });
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.pending_ensemble.length, 1);
      strictEqual(frontmatter.pending_ensemble[0].run_id, 'review-123');
      strictEqual(typeof frontmatter.pending_ensemble[0].started_at, 'string');
    });
  });

  it('replaces an entry with the same run_id (idempotent under retry)', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'test',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      await recordPendingEnsemble({
        workflowPath: filePath,
        phase: 'explore',
        ensemble_type: 'explore',
        run_id: 'explore-1',
        started_at: '2026-05-07T01:00:00Z',
      });
      await recordPendingEnsemble({
        workflowPath: filePath,
        phase: 'explore',
        ensemble_type: 'explore',
        run_id: 'explore-1',
        started_at: '2026-05-07T01:00:30Z',
      });
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.pending_ensemble.length, 1);
      strictEqual(
        frontmatter.pending_ensemble[0].started_at,
        '2026-05-07T01:00:30Z',
      );
    });
  });
});

describe('state.mjs — commitEnsemble three-step atomic mutation (ADR-0017 §sub-4)', () => {
  it('pops matching pending, appends result, prunes', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'test',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);

      await recordPendingEnsemble({
        workflowPath: filePath,
        phase: 'review',
        ensemble_type: 'review',
        run_id: 'review-1',
      });

      await commitEnsemble({
        workflowPath: filePath,
        run_id: 'review-1',
        phase: 'review',
        ensemble_type: 'review',
        verdict: 'agree',
        summary: 'Codex AGREED on the patch',
        codex_session_id: 'sess-xyz',
      });

      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.pending_ensemble.length, 0);
      strictEqual(frontmatter.ensemble_results.length, 1);
      strictEqual(frontmatter.ensemble_results[0].run_id, 'review-1');
      strictEqual(frontmatter.ensemble_results[0].codex_session_id, 'sess-xyz');
    });
  });

  it('is idempotent on the same run_id (second commit no-op for results list)', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'test',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const args = {
        workflowPath: filePath,
        run_id: 'r1',
        phase: 'review',
        ensemble_type: 'review',
        verdict: 'agree',
        summary: 'first',
      };
      await commitEnsemble(args);
      const second = await commitEnsemble({ ...args, summary: 'second' });
      strictEqual(second.idempotentSkip, true);
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.ensemble_results.length, 1);
      strictEqual(frontmatter.ensemble_results[0].summary, 'first');
    });
  });

  it('enforces the retention cap inside the same lock window', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'test',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      // Append 4 with cap=3 → oldest evicted.
      for (let i = 0; i < 4; i++) {
        await commitEnsemble({
          workflowPath: filePath,
          run_id: `r${i}`,
          phase: 'review',
          ensemble_type: 'review',
          verdict: 'agree',
          summary: `result ${i}`,
          completed_at: `2026-05-07T01:0${i}:00Z`,
          cap: 3,
        });
      }
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.ensemble_results.length, 3);
      strictEqual(frontmatter.ensemble_results[0].run_id, 'r1');
      strictEqual(frontmatter.ensemble_results[2].run_id, 'r3');
    });
  });
});

describe('state.mjs — setCheckpoint + setTerminal (ADR-0017 §sub-2 + §sub-5)', () => {
  it('setCheckpoint records latest_checkpoint and host_history "checkpointed"', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'test',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      await setCheckpoint({
        workflowPath: filePath,
        host: 'claude',
        summary: 'PR1 schema 1.1 reader done',
      });
      const { frontmatter } = await readWorkflow(filePath);
      ok(frontmatter.latest_checkpoint);
      strictEqual(
        frontmatter.latest_checkpoint.summary,
        'PR1 schema 1.1 reader done',
      );
      strictEqual(typeof frontmatter.latest_checkpoint.at, 'string');
      const last = frontmatter.host_history.at(-1);
      strictEqual(last.event, 'checkpointed');
      strictEqual(last.host, 'claude');
    });
  });

  it('setTerminal sets current_phase + terminal_marker atomically', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'test',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      await setTerminal({
        workflowPath: filePath,
        host: 'claude',
        terminalPhase: 'commit-complete',
        nextAction: 'archive',
      });
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.current_phase, 'commit-complete');
      strictEqual(frontmatter.terminal_marker, true);
      strictEqual(frontmatter.next_action, 'archive');
    });
  });

  it('setTerminal rejects phase outside whitelist', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'test',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      await rejects(
        setTerminal({
          workflowPath: filePath,
          host: 'claude',
          terminalPhase: 'phase-2-presented',
        }),
        /not in whitelist/,
      );
    });
  });
});

describe('state.mjs — archiveWorkflow (ADR-0017 §sub-5)', () => {
  it('moves the file from workflows/ to archive/ + appends host_history "archived"', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'test',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const result = await archiveWorkflow({
        workflowPath: filePath,
        host: 'claude',
        repoRoot,
      });
      strictEqual(result.archived, true);
      ok(result.to.includes(ARCHIVE_DIR_REL));
      strictEqual(await listWorkflowFiles(repoRoot).then((l) => l.length), 0);
      const { frontmatter } = await readWorkflow(result.to);
      strictEqual(frontmatter.host_history.at(-1).event, 'archived');
    });
  });

  it('uses a timestamp-suffix collision policy', async () => {
    await withTmpRepo(async (repoRoot) => {
      // Pre-create the archive directory + a colliding file.
      const { mkdir, writeFile } = await import('node:fs/promises');
      const archDir = archiveDir(repoRoot);
      await mkdir(archDir, { recursive: true, mode: 0o700 });
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'collide',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const baseName = filePath.split('/').pop();
      const collide = `${archDir}/${baseName}`;
      await writeFile(collide, 'placeholder', { mode: 0o600 });

      const result = await archiveWorkflow({
        workflowPath: filePath,
        host: 'claude',
        repoRoot,
      });
      strictEqual(result.archived, true);
      ok(
        result.to !== collide,
        `expected collision-suffix path, got ${result.to}`,
      );
      // Sub-second random suffix per Codex/Concurrency review M1: the
      // pattern is `<stem>-<isoCompact>-<6-hex>.md` so two concurrent
      // archives at the same iso-second do not generate the same name.
      ok(
        /-\d{8}T\d{6}Z-[0-9a-f]{6}\.md$/.test(result.to),
        `path: ${result.to}`,
      );
    });
  });

  it('is idempotent if the source is already absent', async () => {
    await withTmpRepo(async (repoRoot) => {
      const fakePath = workflowFilePath(repoRoot, 'investigate-20260507T000000Z-deadbe');
      const result = await archiveWorkflow({
        workflowPath: fakePath,
        host: 'claude',
        repoRoot,
      });
      strictEqual(result.archived, false);
      strictEqual(result.reason, 'source-missing');
    });
  });
});

describe('state.mjs — gate helpers (ADR-0017 §sub-5)', () => {
  it('terminalMarkerCheck — true only on explicit terminal_marker===true', () => {
    strictEqual(terminalMarkerCheck({ terminal_marker: true }), true);
    strictEqual(terminalMarkerCheck({ terminal_marker: false }), false);
    strictEqual(terminalMarkerCheck({ terminal_marker: 'true' }), false);
    strictEqual(terminalMarkerCheck({}), false);
    strictEqual(terminalMarkerCheck(null), false);
    strictEqual(terminalMarkerCheck(undefined), false);
  });

  it('terminalPhaseCheck — only the three whitelisted values', () => {
    strictEqual(terminalPhaseCheck('commit-complete'), true);
    strictEqual(terminalPhaseCheck('summary-complete'), true);
    strictEqual(terminalPhaseCheck('fix-complete'), true);
    strictEqual(terminalPhaseCheck('phase-2-presented'), false);
    strictEqual(terminalPhaseCheck('phase-0'), false);
    strictEqual(terminalPhaseCheck(''), false);
  });

  it('noActiveChildrenCheck — empty/absent passes; entry without commit/closed_at fails', () => {
    strictEqual(noActiveChildrenCheck({}), true);
    strictEqual(noActiveChildrenCheck({ child_completions: [] }), true);
    strictEqual(
      noActiveChildrenCheck({
        child_completions: [{
          child_id: 'fix-1', spawned_at: 't',
          commit: 'deadbeef', closed_at: 't2',
        }],
      }),
      true,
    );
    strictEqual(
      noActiveChildrenCheck({
        child_completions: [{ child_id: 'fix-1', spawned_at: 't' }],
      }),
      false,
    );
    strictEqual(
      noActiveChildrenCheck({
        child_completions: [{
          child_id: 'fix-1', spawned_at: 't', commit: '', closed_at: 't2',
        }],
      }),
      false,
    );
  });
});

// ============================================================================
// Phase 6 resolve — additional tests covering review findings:
//   - schema-version preservation across mutation (Test review M1)
//   - CLI subcommand surface (Test review M2)
//   - boolean strictness at write boundary (Codex/Schema MAJOR M5/M6)
//   - required-field validation on helpers (Codex MAJOR M3/M4)
//   - list-of-objects value-type assertions (Codex/Schema MINOR/MAJOR)
//   - archiveWorkflow archiveDirectory-only path (Codex MAJOR M2)
// ============================================================================

describe('state.mjs — schema-version preservation on mutation round-trip', () => {
  it('createWorkflow emits schema="1.2" (ADR-0028 §Layer-2 emit bump)', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'ADR-0028 bumps emit to 1.2',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.schema, '1.2');
    });
  });

  it('setCheckpoint preserves schema="1.2" on disk (no silent downgrade)', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'mutator preserves 1.2',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      await setCheckpoint({
        workflowPath: filePath,
        host: 'claude',
        summary: 'after ADR-0028 emit bump',
      });
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.schema, '1.2');
      strictEqual(frontmatter.latest_checkpoint.summary, 'after ADR-0028 emit bump');
    });
  });

  it('setCheckpoint preserves legacy schema="1.1" on disk (no silent promotion to 1.2)', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'legacy schema 1.1 stays at 1.1',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      // ADR-0028 §Layer-2: 1.1 → 1.2 transition mirrors the 1 → 1.1
      // policy — mutation helpers preserve the disk-recorded schema and
      // never silently promote to 1.2. Workflow files created before the
      // emit bump (still on schema "1.1") must continue to read/write at
      // 1.1 across mutation.
      const { readFile, writeFile } = await import('node:fs/promises');
      const original = await readFile(filePath, 'utf8');
      const downgraded = original.replace(/^schema: "1\.2"\s*$/m, 'schema: "1.1"');
      strictEqual(
        downgraded.includes('\nschema: "1.1"\n'),
        true,
        'expected the test fixture to start at schema "1.1"; ' +
          'check assembleWorkflowFile output if this assertion fails',
      );
      await writeFile(filePath, downgraded, { mode: 0o600 });

      await setCheckpoint({
        workflowPath: filePath,
        host: 'claude',
        summary: 'on legacy schema 1.1',
      });
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.schema, '1.1');
      strictEqual(frontmatter.latest_checkpoint.summary, 'on legacy schema 1.1');
    });
  });

  it('setCheckpoint preserves legacy schema=1 on disk (no silent promotion)', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'legacy schema 1 stays at 1',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      // Hand-downgrade further to legacy integer schema=1 (pre-1.1 PR3
      // era). ADR-0017 + ADR-0028 §Layer-2 — auto-promotion to "1.2"
      // would surprise existing pipelines that key on `schema === 1`.
      const { readFile, writeFile } = await import('node:fs/promises');
      const original = await readFile(filePath, 'utf8');
      const downgraded = original.replace(/^schema: "1\.2"\s*$/m, 'schema: 1');
      strictEqual(
        downgraded.includes('\nschema: 1\n'),
        true,
        'expected the test fixture to start at numeric schema=1; ' +
          'check assembleWorkflowFile output if this assertion fails',
      );
      await writeFile(filePath, downgraded, { mode: 0o600 });

      await setCheckpoint({
        workflowPath: filePath,
        host: 'claude',
        summary: 'on legacy schema 1',
      });
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.schema, 1);
      strictEqual(frontmatter.latest_checkpoint.summary, 'on legacy schema 1');
    });
  });
});

describe('state.mjs — boolean strictness on write (Codex/Schema review M5/M6)', () => {
  it('serializeFrontmatter rejects non-boolean terminal_marker', () => {
    // Provoke serialization via assembleWorkflowFile through setTerminal's
    // frontmatter shape would require a full file; assert through parser
    // round-trip with a hand-crafted assembled string instead. Easier:
    // call setTerminal which validates at the JS API too.
    const fakeFm = {
      schema: 1,
      workflow_id: 'x',
      persona: 'engineer',
      verb: 'investigate',
      profile: '',
      original_request: '',
      started_at: '',
      updated_at: '',
      repo_root: '',
      git_baseline: { branch: '', head: '', status_digest: '' },
      current_phase: '',
      next_action: '',
      tasks: [],
      host_history: [],
      terminal_marker: 'true',                                      // string, not boolean
    };
    // serializeFrontmatter is internal; reach it via parseWorkflowFile
    // round-trip — write the bad shape via a manual YAML, parse, expect
    // the validator to reject the type.
    const text =
      '---\nschema: 1\nworkflow_id: "x"\npersona: "engineer"\nverb: "investigate"\n' +
      'profile: ""\noriginal_request: ""\nstarted_at: ""\nupdated_at: ""\n' +
      'repo_root: ""\ngit_baseline:\n  branch: ""\n  head: ""\n  status_digest: ""\n' +
      'current_phase: ""\nnext_action: ""\ntasks: []\nhost_history: []\n' +
      'terminal_marker: "true"\n---\n\n';
    // Manual YAML quoted "true" parses as the string "true", which is
    // NOT a boolean — validateFrontmatter must reject.
    const err = (() => {
      try { parseWorkflowFile(text); return null; } catch (e) { return e; }
    })();
    ok(err, 'expected non-boolean terminal_marker to throw');
    ok(/terminal_marker/.test(err.message), `message: ${err.message}`);
  });

  it('setTerminal rejects non-boolean terminalMarker', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'test',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      await rejects(
        setTerminal({
          workflowPath: filePath,
          host: 'claude',
          terminalPhase: 'commit-complete',
          terminalMarker: 'false',                                  // string!
        }),
        /must be a boolean/,
      );
    });
  });
});

describe('state.mjs — helper required-field validation (Codex review M3/M4)', () => {
  it('recordPendingEnsemble rejects missing phase / ensemble_type / run_id', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'test',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      await rejects(
        recordPendingEnsemble({
          workflowPath: filePath,
          // phase missing
          ensemble_type: 'review',
          run_id: 'r1',
        }),
        /phase must be a non-empty string/,
      );
    });
  });

  it('commitEnsemble rejects missing required fields', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'test',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      await rejects(
        commitEnsemble({
          workflowPath: filePath,
          run_id: 'r1',
          phase: 'review',
          ensemble_type: 'review',
          // verdict missing
          summary: 'something',
        }),
        /verdict must be a non-empty string/,
      );
    });
  });

  it('commitEnsemble rejects non-string codex_session_id', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'test',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      await rejects(
        commitEnsemble({
          workflowPath: filePath,
          run_id: 'r1',
          phase: 'review',
          ensemble_type: 'review',
          verdict: 'agree',
          summary: 'ok',
          codex_session_id: 42,                                     // number, not string|null
        }),
        /codex_session_id must be string\|null/,
      );
    });
  });
});

describe('state.mjs — list-of-objects value-type validation (Codex/Schema MINOR/MAJOR)', () => {
  it('rejects numeric run_id under ensemble_results entry', () => {
    const text =
      '---\nschema: "1.1"\nworkflow_id: "x"\npersona: "engineer"\nverb: "investigate"\n' +
      'profile: ""\noriginal_request: ""\nstarted_at: ""\nupdated_at: ""\n' +
      'repo_root: ""\ngit_baseline:\n  branch: ""\n  head: ""\n  status_digest: ""\n' +
      'current_phase: ""\nnext_action: ""\ntasks: []\nhost_history: []\n' +
      'ensemble_results:\n' +
      '  - phase: "review"\n    ensemble_type: "review"\n    run_id: 42\n' +
      '    verdict: "agree"\n    summary: "x"\n    completed_at: "x"\n' +
      '    codex_session_id: "x"\n---\n\n';
    const err = (() => {
      try { parseWorkflowFile(text); return null; } catch (e) { return e; }
    })();
    ok(err, 'expected numeric run_id to throw');
    ok(/run_id must be a string/.test(err.message), `message: ${err.message}`);
  });

  it('accepts ensemble_results entry with codex_session_id absent (optional)', () => {
    const text =
      '---\nschema: "1.1"\nworkflow_id: "x"\npersona: "engineer"\nverb: "investigate"\n' +
      'profile: ""\noriginal_request: ""\nstarted_at: ""\nupdated_at: ""\n' +
      'repo_root: ""\ngit_baseline:\n  branch: ""\n  head: ""\n  status_digest: ""\n' +
      'current_phase: ""\nnext_action: ""\ntasks: []\nhost_history: []\n' +
      'ensemble_results:\n' +
      '  - phase: "review"\n    ensemble_type: "review"\n    run_id: "r1"\n' +
      '    verdict: "agree"\n    summary: "x"\n    completed_at: "x"\n---\n\n';
    const { frontmatter } = parseWorkflowFile(text);
    strictEqual(frontmatter.ensemble_results.length, 1);
    strictEqual('codex_session_id' in frontmatter.ensemble_results[0], false);
  });
});

describe('state.mjs — archiveWorkflow archiveDirectory-only mode (Codex review M2)', () => {
  it('derives directory-lock root from workflowPath when only archiveDirectory is given', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'test',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const customArchive = `${repoRoot}/custom-archive`;
      // No repoRoot — only archiveDirectory.
      const result = await archiveWorkflow({
        workflowPath: filePath,
        host: 'claude',
        archiveDirectory: customArchive,
      });
      strictEqual(result.archived, true);
      ok(result.to.startsWith(customArchive));
    });
  });

  it('locks the same .creation-lock as createWorkflow (Codex re-review M-1)', async () => {
    // Hand-derived dirLockRoot must produce the canonical lock path
    // `<repoRoot>/.agentic-plugins/state/engineer/.creation-lock`. The previous
    // (incorrect) two-deep dirname produced
    // `<repoRoot>/.agentic-plugins/state/engineer/.agentic-plugins/state/engineer/.creation-lock`,
    // which did not serialize with the rest of the engineer locking
    // domain.
    const { stat } = await import('node:fs/promises');
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'test',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const customArchive = `${repoRoot}/custom-archive`;
      // After archive, the canonical creation-lock path must NOT exist
      // doubled under the workflows dir. (The archive helper releases
      // the lock; we just check no stray nested directories were left.)
      await archiveWorkflow({
        workflowPath: filePath,
        host: 'claude',
        archiveDirectory: customArchive,
      });
      const stray = `${repoRoot}/.agentic-plugins/state/engineer/.agentic-plugins`;
      const strayStat = await stat(stray).catch(() => null);
      strictEqual(strayStat, null, `unexpected stray dir at ${stray}`);
    });
  });
});

describe('state.mjs — non-string timestamp gates (Codex re-review M-3)', () => {
  it('recordPendingEnsemble rejects non-string started_at', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'test',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      await rejects(
        recordPendingEnsemble({
          workflowPath: filePath,
          phase: 'review',
          ensemble_type: 'review',
          run_id: 'r1',
          started_at: 42,                                            // number
        }),
        /started_at must be a string/,
      );
    });
  });

  it('commitEnsemble rejects non-string completed_at', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'test',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      await rejects(
        commitEnsemble({
          workflowPath: filePath,
          run_id: 'r1',
          phase: 'review',
          ensemble_type: 'review',
          verdict: 'agree',
          summary: 'ok',
          completed_at: 42,                                          // number
        }),
        /completed_at must be a string/,
      );
    });
  });
});

// ============================================================================
// ADR-0019 PR-A — schema 1.1 cross-plugin parent-linkage fields
// (parent_workflow + originating_subtask + parent_detached). All three
// are optional top-level scalars; validateSchema11Fields gates types,
// createWorkflow enforces "both-or-neither" cross-validation.
// ============================================================================

describe('state.mjs — ADR-0019 PR-A parent-linkage fields (schema 1.1 additive)', () => {
  it('parses a hand-crafted 1.1 file with parent_workflow + originating_subtask set', () => {
    const text =
      '---\n' +
      'schema: "1.1"\n' +
      'workflow_id: "investigate-20260510T070000Z-aabbcc"\n' +
      'persona: "engineer"\n' +
      'verb: "investigate"\n' +
      'profile: "architecture"\n' +
      'original_request: "subtask dispatched by orchestrator"\n' +
      'started_at: "2026-05-10T07:00:00Z"\n' +
      'updated_at: "2026-05-10T07:00:00Z"\n' +
      'repo_root: "/tmp/repo"\n' +
      'git_baseline:\n' +
      '  branch: "feat/sub-1"\n' +
      '  head: "0000000000000000000000000000000000000000"\n' +
      '  status_digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"\n' +
      'current_phase: "phase-0"\n' +
      'next_action: "Run investigate skill"\n' +
      'tasks: []\n' +
      'host_history:\n' +
      '  - host: "claude"\n' +
      '    at: "2026-05-10T07:00:00Z"\n' +
      '    event: "created"\n' +
      'parent_workflow: "macro-plan-20260510T065959Z-aaaaaa"\n' +
      'originating_subtask: "PR1"\n' +
      '---\n\n# body\n';
    const { frontmatter } = parseWorkflowFile(text);
    strictEqual(frontmatter.parent_workflow, 'macro-plan-20260510T065959Z-aaaaaa');
    strictEqual(frontmatter.originating_subtask, 'PR1');
    strictEqual('parent_detached' in frontmatter, false);
  });

  it('parses a 1.1 file with parent_detached: true (set later by /finalize/abort)', () => {
    const text =
      '---\n' +
      'schema: "1.1"\n' +
      'workflow_id: "compose-20260510T080000Z-ddeeff"\n' +
      'persona: "engineer"\n' +
      'verb: "compose"\n' +
      'profile: ""\n' +
      'original_request: "schema bump implementation"\n' +
      'started_at: "2026-05-10T08:00:00Z"\n' +
      'updated_at: "2026-05-10T08:30:00Z"\n' +
      'repo_root: "/tmp/repo"\n' +
      'git_baseline:\n' +
      '  branch: "feat/sub-2"\n' +
      '  head: "0000000000000000000000000000000000000000"\n' +
      '  status_digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"\n' +
      'current_phase: "phase-1"\n' +
      'next_action: "implement"\n' +
      'tasks: []\n' +
      'host_history:\n' +
      '  - host: "codex"\n' +
      '    at: "2026-05-10T08:00:00Z"\n' +
      '    event: "created"\n' +
      'terminal_marker: false\n' +
      'parent_workflow: "macro-plan-20260510T080000Z-bbbbbb"\n' +
      'originating_subtask: "PR2"\n' +
      'parent_detached: true\n' +
      '---\n\n# body\n';
    const { frontmatter } = parseWorkflowFile(text);
    strictEqual(frontmatter.parent_workflow, 'macro-plan-20260510T080000Z-bbbbbb');
    strictEqual(frontmatter.originating_subtask, 'PR2');
    strictEqual(frontmatter.parent_detached, true);
    strictEqual(frontmatter.terminal_marker, false);
  });

  it('rejects empty-string parent_workflow', () => {
    const text =
      '---\nschema: "1.1"\nworkflow_id: "x"\npersona: "engineer"\nverb: "investigate"\n' +
      'profile: ""\noriginal_request: ""\nstarted_at: ""\nupdated_at: ""\n' +
      'repo_root: ""\ngit_baseline:\n  branch: ""\n  head: ""\n  status_digest: ""\n' +
      'current_phase: ""\nnext_action: ""\ntasks: []\nhost_history: []\n' +
      'parent_workflow: ""\noriginating_subtask: "PR1"\n---\n\n';
    const err = (() => {
      try { parseWorkflowFile(text); return null; } catch (e) { return e; }
    })();
    ok(err, 'expected empty parent_workflow to throw');
    ok(/parent_workflow must be a non-empty string/.test(err.message), `message: ${err.message}`);
  });

  it('rejects empty-string originating_subtask', () => {
    const text =
      '---\nschema: "1.1"\nworkflow_id: "x"\npersona: "engineer"\nverb: "investigate"\n' +
      'profile: ""\noriginal_request: ""\nstarted_at: ""\nupdated_at: ""\n' +
      'repo_root: ""\ngit_baseline:\n  branch: ""\n  head: ""\n  status_digest: ""\n' +
      'current_phase: ""\nnext_action: ""\ntasks: []\nhost_history: []\n' +
      'parent_workflow: "macro-x"\noriginating_subtask: ""\n---\n\n';
    const err = (() => {
      try { parseWorkflowFile(text); return null; } catch (e) { return e; }
    })();
    ok(err, 'expected empty originating_subtask to throw');
    ok(/originating_subtask must be a non-empty string/.test(err.message), `message: ${err.message}`);
  });

  it('rejects non-boolean parent_detached', () => {
    const text =
      '---\nschema: "1.1"\nworkflow_id: "x"\npersona: "engineer"\nverb: "investigate"\n' +
      'profile: ""\noriginal_request: ""\nstarted_at: ""\nupdated_at: ""\n' +
      'repo_root: ""\ngit_baseline:\n  branch: ""\n  head: ""\n  status_digest: ""\n' +
      'current_phase: ""\nnext_action: ""\ntasks: []\nhost_history: []\n' +
      'parent_detached: "yes"\n---\n\n';
    const err = (() => {
      try { parseWorkflowFile(text); return null; } catch (e) { return e; }
    })();
    ok(err, 'expected string parent_detached to throw');
    ok(/parent_detached must be a boolean/.test(err.message), `message: ${err.message}`);
  });

  it('createWorkflow round-trip persists parent_workflow + originating_subtask', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'compose',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'orchestrator dispatched compose',
        parentWorkflow: 'macro-plan-20260510T090000Z-zzzzzz',
        originatingSubtask: 'PR3',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.parent_workflow, 'macro-plan-20260510T090000Z-zzzzzz');
      strictEqual(frontmatter.originating_subtask, 'PR3');
      // parent_detached omitted at create-time per ADR-0019 §3
      strictEqual('parent_detached' in frontmatter, false);
    });
  });

  it('createWorkflow rejects half-set linkage (parent_workflow only)', async () => {
    await withTmpRepo(async (repoRoot) => {
      await rejects(
        createWorkflow({
          repoRoot,
          verb: 'investigate',
          host: 'claude',
          gitBaseline: MIN_BASELINE,
          originalRequest: 'half-set parent should fail',
          parentWorkflow: 'macro-plan-orphan',
          // originatingSubtask intentionally omitted
        }),
        /parent_workflow and originating_subtask must be set together/,
      );
    });
  });

  it('createWorkflow rejects half-set linkage (originating_subtask only)', async () => {
    await withTmpRepo(async (repoRoot) => {
      await rejects(
        createWorkflow({
          repoRoot,
          verb: 'investigate',
          host: 'claude',
          gitBaseline: MIN_BASELINE,
          originalRequest: 'half-set subtask should fail',
          originatingSubtask: 'PR4',
          // parentWorkflow intentionally omitted
        }),
        /parent_workflow and originating_subtask must be set together/,
      );
    });
  });

  it('createWorkflow rejects explicitly-empty parent_workflow string', async () => {
    // ADR-0019 dispatch shims may expand unset env vars to empty `--flag ''`
    // args. Treating that as "omitted" would silently drop the parent
    // association. Only undefined/null mean omitted; '' is invalid.
    await withTmpRepo(async (repoRoot) => {
      await rejects(
        createWorkflow({
          repoRoot,
          verb: 'compose',
          host: 'claude',
          gitBaseline: MIN_BASELINE,
          originalRequest: 'empty parentWorkflow should reject',
          parentWorkflow: '',
          originatingSubtask: 'PR-x',
        }),
        /parentWorkflow must be a non-empty string when provided/,
      );
    });
  });

  it('createWorkflow rejects explicitly-empty originating_subtask string', async () => {
    await withTmpRepo(async (repoRoot) => {
      await rejects(
        createWorkflow({
          repoRoot,
          verb: 'compose',
          host: 'claude',
          gitBaseline: MIN_BASELINE,
          originalRequest: 'empty originatingSubtask should reject',
          parentWorkflow: 'macro-x',
          originatingSubtask: '',
        }),
        /originatingSubtask must be a non-empty string when provided/,
      );
    });
  });

  it('CLI create rejects empty --parent-workflow flag (shim safety)', async () => {
    await withTmpRepo(async (repoRoot) => {
      const result = spawnSync(process.execPath, [
        STATE_PATH,
        'create',
        '--repo-root', repoRoot,
        '--verb', 'investigate',
        '--host', 'claude',
        '--git-baseline-branch', MIN_BASELINE.branch,
        '--git-baseline-head', MIN_BASELINE.head,
        '--status-digest', MIN_BASELINE.status_digest,
        '--parent-workflow', '',
        '--originating-subtask', 'PR-shim',
      ], { encoding: 'utf8' });
      strictEqual(result.status, 1, `expected exit 1, got ${result.status}: ${result.stderr}`);
      match(result.stderr, /parentWorkflow must be a non-empty string when provided/);
    });
  });

  it('createWorkflow without parent linkage omits both fields', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'manual workflow no parent',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual('parent_workflow' in frontmatter, false);
      strictEqual('originating_subtask' in frontmatter, false);
      strictEqual('parent_detached' in frontmatter, false);
    });
  });

  it('CLI create --parent-workflow + --originating-subtask flags pass through', async () => {
    await withTmpRepo(async (repoRoot) => {
      const out = execFileSync(process.execPath, [
        STATE_PATH,
        'create',
        '--repo-root', repoRoot,
        '--verb', 'compose',
        '--host', 'claude',
        '--git-baseline-branch', MIN_BASELINE.branch,
        '--git-baseline-head', MIN_BASELINE.head,
        '--status-digest', MIN_BASELINE.status_digest,
        '--parent-workflow', 'macro-plan-cli-test',
        '--originating-subtask', 'PR-cli',
      ], { encoding: 'utf8' });
      const filePath = out.trim();
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.parent_workflow, 'macro-plan-cli-test');
      strictEqual(frontmatter.originating_subtask, 'PR-cli');
    });
  });

  it('FRONTMATTER_KEY_ORDER places parent linkage fields after ADR-0017 1.1 fields', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'frame',
        host: 'codex',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'serialization order test',
        parentWorkflow: 'macro-order',
        originatingSubtask: 'PR-order',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const raw = await readFile(filePath, 'utf8');
      // The serialized frontmatter must place parent_workflow AFTER
      // host_history (last schema-1 field) and AFTER any ADR-0017 1.1
      // optional fields. Since this workflow has no ADR-0017 fields
      // populated, host_history is the immediate predecessor.
      const idxHostHistory = raw.indexOf('\nhost_history:');
      const idxParentWorkflow = raw.indexOf('\nparent_workflow:');
      const idxOriginatingSubtask = raw.indexOf('\noriginating_subtask:');
      ok(idxHostHistory > 0, 'host_history must appear');
      ok(idxParentWorkflow > 0, 'parent_workflow must appear');
      ok(idxOriginatingSubtask > 0, 'originating_subtask must appear');
      ok(idxParentWorkflow > idxHostHistory, 'parent_workflow must serialize after host_history');
      ok(idxOriginatingSubtask > idxParentWorkflow, 'originating_subtask must serialize after parent_workflow');
    });
  });
});

// ============================================================================
// ADR-0020 §Sub-decision 5 — schema 1.1-additive workflow_type discriminator
// (verb-chain | start). The field is always-written at create-time with a
// 'verb-chain' default (discriminator semantics: self-describing > omit-when-
// unset, parent_workflow precedent intentionally diverged). On read, absent
// equals 'verb-chain' (legacy 1.1 files without the field remain valid).
// SCHEMA_VERSION stays '1.1' (additive, Alternative E "1.2 bump" rejected).
// ============================================================================

describe('state.mjs — ADR-0020 workflow_type field (schema 1.1 additive)', () => {
  it('parses a 1.1 file with workflow_type: verb-chain explicitly set', () => {
    const text =
      '---\n' +
      'schema: "1.1"\n' +
      'workflow_id: "investigate-20260511T140000Z-aa1122"\n' +
      'persona: "engineer"\n' +
      'verb: "investigate"\n' +
      'profile: ""\n' +
      'original_request: "verb chain workflow"\n' +
      'started_at: "2026-05-11T14:00:00Z"\n' +
      'updated_at: "2026-05-11T14:00:00Z"\n' +
      'repo_root: "/tmp/repo"\n' +
      'git_baseline:\n' +
      '  branch: "main"\n' +
      '  head: "0000000000000000000000000000000000000000"\n' +
      '  status_digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"\n' +
      'current_phase: "phase-0"\n' +
      'next_action: "Run investigate skill"\n' +
      'tasks: []\n' +
      'host_history:\n' +
      '  - host: "claude"\n' +
      '    at: "2026-05-11T14:00:00Z"\n' +
      '    event: "created"\n' +
      'workflow_type: "verb-chain"\n' +
      '---\n\n# body\n';
    const { frontmatter } = parseWorkflowFile(text);
    strictEqual(frontmatter.workflow_type, 'verb-chain');
  });

  it('parses a 1.1 file with workflow_type: start (lifecycle macro workflow per ADR-0020 PR 3)', () => {
    const text =
      '---\n' +
      'schema: "1.1"\n' +
      'workflow_id: "investigate-20260511T140100Z-bb2233"\n' +
      'persona: "engineer"\n' +
      'verb: "investigate"\n' +
      'profile: ""\n' +
      'original_request: "lifecycle macro workflow"\n' +
      'started_at: "2026-05-11T14:01:00Z"\n' +
      'updated_at: "2026-05-11T14:01:00Z"\n' +
      'repo_root: "/tmp/repo"\n' +
      'git_baseline:\n' +
      '  branch: "main"\n' +
      '  head: "0000000000000000000000000000000000000000"\n' +
      '  status_digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"\n' +
      'current_phase: "phase-1-brainstorm"\n' +
      'next_action: "investigate options"\n' +
      'tasks: []\n' +
      'host_history:\n' +
      '  - host: "claude"\n' +
      '    at: "2026-05-11T14:01:00Z"\n' +
      '    event: "created"\n' +
      'workflow_type: "start"\n' +
      '---\n\n# body\n';
    const { frontmatter } = parseWorkflowFile(text);
    strictEqual(frontmatter.workflow_type, 'start');
  });

  it('parses a legacy 1.1 file without workflow_type (read-time default verb-chain is caller responsibility)', () => {
    // ADR-0020 §Sub-decision 5 — pre-PR-2 files have no workflow_type.
    // The parser MUST accept absence silently; the caller (e.g.,
    // resume.md drift report) supplies the 'verb-chain' default at
    // render-time.
    const text =
      '---\n' +
      'schema: "1.1"\n' +
      'workflow_id: "investigate-20260511T140200Z-cc3344"\n' +
      'persona: "engineer"\n' +
      'verb: "investigate"\n' +
      'profile: ""\n' +
      'original_request: "pre-PR-2 legacy file"\n' +
      'started_at: "2026-05-11T14:02:00Z"\n' +
      'updated_at: "2026-05-11T14:02:00Z"\n' +
      'repo_root: "/tmp/repo"\n' +
      'git_baseline:\n' +
      '  branch: "main"\n' +
      '  head: "0000000000000000000000000000000000000000"\n' +
      '  status_digest: ""\n' +
      'current_phase: "phase-0"\n' +
      'next_action: "Run investigate skill"\n' +
      'tasks: []\n' +
      'host_history:\n' +
      '  - host: "claude"\n' +
      '    at: "2026-05-11T14:02:00Z"\n' +
      '    event: "created"\n' +
      '---\n\n# body\n';
    const { frontmatter } = parseWorkflowFile(text);
    strictEqual('workflow_type' in frontmatter, false);
  });

  it('rejects unknown workflow_type value (enum violation)', () => {
    const text =
      '---\nschema: "1.1"\nworkflow_id: "x"\npersona: "engineer"\nverb: "investigate"\n' +
      'profile: ""\noriginal_request: ""\nstarted_at: ""\nupdated_at: ""\n' +
      'repo_root: ""\ngit_baseline:\n  branch: ""\n  head: ""\n  status_digest: ""\n' +
      'current_phase: ""\nnext_action: ""\ntasks: []\nhost_history: []\n' +
      'workflow_type: "plan"\n---\n\n';
    const err = (() => {
      try { parseWorkflowFile(text); return null; } catch (e) { return e; }
    })();
    ok(err, 'expected unknown workflow_type to throw');
    ok(/workflow_type must be one of/.test(err.message), `message: ${err.message}`);
  });

  it('rejects non-string workflow_type', () => {
    const text =
      '---\nschema: "1.1"\nworkflow_id: "x"\npersona: "engineer"\nverb: "investigate"\n' +
      'profile: ""\noriginal_request: ""\nstarted_at: ""\nupdated_at: ""\n' +
      'repo_root: ""\ngit_baseline:\n  branch: ""\n  head: ""\n  status_digest: ""\n' +
      'current_phase: ""\nnext_action: ""\ntasks: []\nhost_history: []\n' +
      'workflow_type: 42\n---\n\n';
    const err = (() => {
      try { parseWorkflowFile(text); return null; } catch (e) { return e; }
    })();
    ok(err, 'expected numeric workflow_type to throw');
    // Numeric YAML scalar parses as Number; the parser may already
    // reject at scalar-type level before the enum check fires. Either
    // 'must be a string' or 'must be one of' satisfies the contract.
    ok(
      /workflow_type must be (a string|one of)/.test(err.message),
      `message: ${err.message}`,
    );
  });

  it('createWorkflow without workflowType writes workflow_type: verb-chain (always-write default)', async () => {
    // ADR-0020 §Sub-decision 5 always-write design — discriminator
    // semantics, every new workflow self-describes. Diverges from the
    // parent_workflow precedent (omit-when-unset) intentionally.
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'default workflow_type test',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.workflow_type, 'verb-chain');
    });
  });

  it('createWorkflow with workflowType: "start" writes workflow_type: start', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'lifecycle macro start',
        workflowType: 'start',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.workflow_type, 'start');
    });
  });

  it('createWorkflow rejects invalid workflowType at create-time (clear error)', async () => {
    await withTmpRepo(async (repoRoot) => {
      await rejects(
        createWorkflow({
          repoRoot,
          verb: 'investigate',
          host: 'claude',
          gitBaseline: MIN_BASELINE,
          originalRequest: 'invalid enum should fail',
          workflowType: 'plan',
        }),
        /workflow_type must be one of/,
      );
    });
  });

  it('CLI create --workflow-type start flag passes through', async () => {
    await withTmpRepo(async (repoRoot) => {
      const out = execFileSync(process.execPath, [
        STATE_PATH,
        'create',
        '--repo-root', repoRoot,
        '--verb', 'investigate',
        '--host', 'claude',
        '--git-baseline-branch', MIN_BASELINE.branch,
        '--git-baseline-head', MIN_BASELINE.head,
        '--status-digest', MIN_BASELINE.status_digest,
        '--workflow-type', 'start',
      ], { encoding: 'utf8' });
      const filePath = out.trim();
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.workflow_type, 'start');
    });
  });

  it('CLI create without --workflow-type writes workflow_type: verb-chain (default flows through CLI too)', async () => {
    await withTmpRepo(async (repoRoot) => {
      const out = execFileSync(process.execPath, [
        STATE_PATH,
        'create',
        '--repo-root', repoRoot,
        '--verb', 'frame',
        '--host', 'codex',
        '--git-baseline-branch', MIN_BASELINE.branch,
        '--git-baseline-head', MIN_BASELINE.head,
        '--status-digest', MIN_BASELINE.status_digest,
      ], { encoding: 'utf8' });
      const filePath = out.trim();
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.workflow_type, 'verb-chain');
    });
  });

  it('CLI create rejects invalid --workflow-type value (enum guard at CLI)', async () => {
    await withTmpRepo(async (repoRoot) => {
      const result = spawnSync(process.execPath, [
        STATE_PATH,
        'create',
        '--repo-root', repoRoot,
        '--verb', 'investigate',
        '--host', 'claude',
        '--git-baseline-branch', MIN_BASELINE.branch,
        '--git-baseline-head', MIN_BASELINE.head,
        '--status-digest', MIN_BASELINE.status_digest,
        '--workflow-type', 'plan',
      ], { encoding: 'utf8' });
      strictEqual(result.status, 1, `expected exit 1, got ${result.status}: ${result.stderr}`);
      match(result.stderr, /workflow_type must be one of/);
    });
  });

  it('CLI create rejects empty --workflow-type flag (shim safety; mirrors parent-workflow empty-string handling)', async () => {
    // Dispatch shims may expand an unset env var to `--workflow-type ''`.
    // The destructuring default only applies on `undefined`, so an empty
    // string falls through to the eager enum check and is rejected. This
    // matches the parent_workflow precedent at the same code path
    // (createWorkflow rejects '' as explicitly-provided-but-invalid).
    await withTmpRepo(async (repoRoot) => {
      const result = spawnSync(process.execPath, [
        STATE_PATH,
        'create',
        '--repo-root', repoRoot,
        '--verb', 'investigate',
        '--host', 'claude',
        '--git-baseline-branch', MIN_BASELINE.branch,
        '--git-baseline-head', MIN_BASELINE.head,
        '--status-digest', MIN_BASELINE.status_digest,
        '--workflow-type', '',
      ], { encoding: 'utf8' });
      strictEqual(result.status, 1, `expected exit 1, got ${result.status}: ${result.stderr}`);
      match(result.stderr, /workflow_type must be one of/);
    });
  });

  it('FRONTMATTER_KEY_ORDER places workflow_type after parent-linkage fields (ADR-0020 group placement)', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'compose',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'serialization order test for workflow_type',
        parentWorkflow: 'macro-plan-order',
        originatingSubtask: 'PR-order',
        workflowType: 'verb-chain',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const raw = await readFile(filePath, 'utf8');
      const idxOriginatingSubtask = raw.indexOf('\noriginating_subtask:');
      const idxWorkflowType = raw.indexOf('\nworkflow_type:');
      ok(idxOriginatingSubtask > 0, 'originating_subtask must appear');
      ok(idxWorkflowType > 0, 'workflow_type must appear');
      ok(
        idxWorkflowType > idxOriginatingSubtask,
        'workflow_type must serialize after originating_subtask (ADR-0020 group after ADR-0019 group)',
      );
    });
  });
});
