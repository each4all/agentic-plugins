// plugins/engineer/scripts/phase7-commit.mjs — helper unit tests
// (ADR-0028 §Layer-3).
//
// The driver itself is exercised end-to-end via /engineer:start Phase 7
// dogfood (P14 — PR2 is hand-landed). These tests cover the pure
// helpers + the CLI flag parser; staging logic is structured so the
// branch decision (decideStagingBranch), classification consumer
// (commitShapeFor — P12 exhaustive switch), and body composition
// (composeBody + stripTrailers) are testable without git.
//
// Run via `node --test tests/engineer/test-phase7-commit.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, ok, throws } from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PHASE7_PATH = resolve(REPO_ROOT, 'plugins/engineer/scripts/phase7-commit.mjs');

const {
  parseFlags,
  stripTrailers,
  composeBody,
  inferSubject,
  packageScope,
  parseSimpleToml,
  readPhase7Config,
  decideStagingBranch,
  commitShapeFor,
  isAgenticPluginsRepo,
  pickSubjectForCommit,
  checkSubjectAgainstCC,
  evaluateLandedRecovery,
} = await import(PHASE7_PATH);

// -----------------------------------------------------------------------------
// parseFlags — argv → flag map with repeatable + boolean support

describe('parseFlags — CLI argv parser', () => {
  it('parses simple value flags', () => {
    const f = parseFlags(['--mode', 'plan', '--workflow-path', '/a.md', '--host', 'claude']);
    strictEqual(f.mode, 'plan');
    strictEqual(f['workflow-path'], '/a.md');
    strictEqual(f.host, 'claude');
  });

  it('repeats --subject-pkg into an array', () => {
    const f = parseFlags([
      '--subject-pkg', 'plugins/engineer=feat(engineer): a',
      '--subject-pkg', 'plugins/runtime=docs(runtime): b',
    ]);
    deepStrictEqual(f['subject-pkg'], [
      'plugins/engineer=feat(engineer): a',
      'plugins/runtime=docs(runtime): b',
    ]);
  });

  // ADR-0028 PR4 A4 — `--include-extra` is repeatable so the user can
  // opt specific extras back into the staging set after seeing the
  // plan-mode extras list.
  it('repeats --include-extra into an array (PR4 A4)', () => {
    const f = parseFlags([
      '--include-extra', 'docs/new.md',
      '--include-extra', 'docs/another.md',
    ]);
    deepStrictEqual(f['include-extra'], ['docs/new.md', 'docs/another.md']);
  });

  it('defaults --include-extra to empty array when absent (PR4 A4)', () => {
    const f = parseFlags(['--mode', 'plan']);
    deepStrictEqual(f['include-extra'], []);
  });

  it('handles boolean flags with optional explicit true/false', () => {
    strictEqual(parseFlags(['--accept-current-tree'])['accept-current-tree'], true);
    strictEqual(parseFlags(['--accept-current-tree', 'true'])['accept-current-tree'], true);
    strictEqual(parseFlags(['--accept-current-tree', 'false'])['accept-current-tree'], false);
  });

  it('rejects an unknown positional argument', () => {
    throws(() => parseFlags(['positional', '--mode', 'plan']), /Unexpected positional/);
  });

  it('rejects a value flag missing its value', () => {
    throws(() => parseFlags(['--subject']), /Missing value/);
    throws(() => parseFlags(['--subject', '--mode']), /Missing value/);
  });
});

// -----------------------------------------------------------------------------
// stripTrailers — P9 trailer-allowlist policy

describe('stripTrailers — P9 trailer allowlist (ADR-0028)', () => {
  it('removes BREAKING CHANGE / Co-Authored-By / Closes / Fixes / Refs lines', () => {
    const text =
      'Some change body.\n' +
      'BREAKING CHANGE: drop the old API\n' +
      'Closes: #123\n' +
      'Co-Authored-By: Bot <noreply@example.com>\n' +
      'Fixes: #456\n' +
      'Refs: ABC-789\n' +
      'BREAKING-CHANGE: dashed variant\n' +
      'Last line.\n';
    const out = stripTrailers(text);
    ok(!/BREAKING CHANGE/.test(out));
    ok(!/BREAKING-CHANGE/.test(out));
    ok(!/Co-Authored-By/.test(out));
    ok(!/Closes:/.test(out));
    ok(!/Fixes:/.test(out));
    ok(!/Refs:/.test(out));
    ok(/Some change body\./.test(out));
    ok(/Last line\./.test(out));
  });

  it('case-insensitive trailer match', () => {
    const out = stripTrailers('co-authored-by: x\nbody\n');
    strictEqual(out, 'body');
  });

  // PR4 review F2 (Phase 5 Angle E) — `Workflow-ID:` is in the trailer
  // allowlist so a stale Workflow-ID riding into `original_request` (e.g.
  // user pastes a prior commit message into the feature description)
  // does NOT survive the strip. The fresh Workflow-ID for THIS workflow
  // is re-appended by composeBody after stripTrailers, so the only
  // Workflow-ID that lands in the commit body is the current one — this
  // closes the A2 false-positive recovery vector.
  it('strips stale Workflow-ID trailer (PR4 review F2)', () => {
    const out = stripTrailers(
      'body line\n' +
      'Workflow-ID: investigate-OLD-stale\n',
    );
    ok(!/Workflow-ID/.test(out), `Workflow-ID must be stripped; got ${JSON.stringify(out)}`);
    strictEqual(out, 'body line');
  });

  it('case-insensitive Workflow-ID strip', () => {
    const out = stripTrailers('workflow-id: x\nbody\n');
    strictEqual(out, 'body');
  });

  it('returns empty string for empty / non-string input', () => {
    strictEqual(stripTrailers(''), '');
    strictEqual(stripTrailers(null), '');
    strictEqual(stripTrailers(undefined), '');
  });
});

// -----------------------------------------------------------------------------
// composeBody — P1 three-source composition

describe('composeBody — Workflow-ID trailer (ADR-0028 PR4 A2)', () => {
  it('appends `Workflow-ID: <id>` as the last block when workflowId is provided', () => {
    const body = composeBody({
      originalRequest: 'ship something',
      diffStat: '',
      ensembleSummary: '',
      workflowId: 'investigate-20260525T040653Z-3f5a26',
    });
    ok(/Workflow-ID: investigate-20260525T040653Z-3f5a26$/m.test(body),
      `expected trailer at end of body; got: ${JSON.stringify(body)}`);
    // Trailer is the LAST block (after a blank separator); body ends
    // with the trailer line, no further text.
    ok(body.endsWith('Workflow-ID: investigate-20260525T040653Z-3f5a26'));
  });

  it('omits the trailer when workflowId is absent / empty (backward compat)', () => {
    const body = composeBody({
      originalRequest: 'ship something',
      diffStat: '',
      ensembleSummary: '',
    });
    ok(!/Workflow-ID:/.test(body), `unexpected trailer in body: ${JSON.stringify(body)}`);
    // The pre-PR4 shape is preserved when no workflowId is supplied —
    // important because the helper is shared across executeMode (which
    // now passes workflowId) and any future caller that may not.
    strictEqual(body, 'ship something');
  });

  it('still appends trailer when all other inputs are empty', () => {
    const body = composeBody({
      originalRequest: '',
      diffStat: '',
      ensembleSummary: '',
      workflowId: 'wf-abc',
    });
    strictEqual(body, 'Workflow-ID: wf-abc');
  });

  // PR4 review F2 — closure of the A2 false-positive recovery vector.
  // A user pasting a prior commit's message into `original_request`
  // would otherwise leak a stale Workflow-ID trailer into the new
  // commit. stripTrailers (now Workflow-ID-aware) removes the stale
  // trailer first; composeBody re-appends the workflow's current id.
  it('replaces a stale Workflow-ID trailer in original_request with the current one', () => {
    const body = composeBody({
      originalRequest:
        'feature description\n' +
        'Workflow-ID: investigate-PRIOR-stale',
      diffStat: '',
      ensembleSummary: '',
      workflowId: 'investigate-CURRENT-fresh',
    });
    ok(!body.includes('PRIOR-stale'), `stale Workflow-ID must be stripped; got ${JSON.stringify(body)}`);
    ok(body.endsWith('Workflow-ID: investigate-CURRENT-fresh'));
  });
});

describe('evaluateLandedRecovery — idempotent fast-path predicate (PR4 A2)', () => {
  it('returns landed=true when union of touched-paths covers every manifestPath', () => {
    const r = evaluateLandedRecovery({
      workflowId: 'wf-1',
      manifestPaths: ['a.mjs', 'b.mjs', 'c.md'],
      markedCommits: [
        { sha: 'abc1234', touched: ['a.mjs', 'b.mjs'] },
        { sha: 'def5678', touched: ['c.md'] },
      ],
    });
    strictEqual(r.landed, true);
    deepStrictEqual(r.coveredBy, ['abc1234', 'def5678']);
    deepStrictEqual(r.missingManifest, []);
  });

  it('returns landed=false when even one manifest path is uncovered', () => {
    const r = evaluateLandedRecovery({
      workflowId: 'wf-1',
      manifestPaths: ['a.mjs', 'b.mjs', 'c.md'],
      markedCommits: [
        { sha: 'abc1234', touched: ['a.mjs', 'b.mjs'] },
        // c.md was never touched by a marked commit.
      ],
    });
    strictEqual(r.landed, false);
    deepStrictEqual(r.missingManifest, ['c.md']);
  });

  it('returns landed=false when there are no marked commits', () => {
    const r = evaluateLandedRecovery({
      workflowId: 'wf-1',
      manifestPaths: ['a.mjs'],
      markedCommits: [],
    });
    strictEqual(r.landed, false);
    deepStrictEqual(r.coveredBy, []);
    deepStrictEqual(r.missingManifest, ['a.mjs']);
  });

  it('returns landed=false when workflowId is missing (fail-safe)', () => {
    // No marker → no way to attribute commits → must NOT fire the
    // fast-path. The caller falls back to the legacy no-changes error.
    const r = evaluateLandedRecovery({
      workflowId: '',
      manifestPaths: ['a.mjs'],
      markedCommits: [{ sha: 'abc1234', touched: ['a.mjs'] }],
    });
    strictEqual(r.landed, false);
  });

  it('tolerates an empty manifestPaths list (landed=true degenerate, no work to verify)', () => {
    // A workflow that ran with an empty commit_manifest is a separate
    // class — the caller guards on manifestPaths.length > 0 before
    // probing — but the pure predicate should still answer the
    // "every path covered" question truthfully on the empty set.
    const r = evaluateLandedRecovery({
      workflowId: 'wf-1',
      manifestPaths: [],
      markedCommits: [{ sha: 'abc1234', touched: ['x'] }],
    });
    strictEqual(r.landed, true);
  });
});

describe('composeBody — P1 source composition (ADR-0028)', () => {
  it('concatenates original_request + diff stat + ensemble summary in order', () => {
    const body = composeBody({
      originalRequest: 'Add ADR-0028 Phase 7 driver',
      diffStat:
        ' plugins/engineer/scripts/phase7-commit.mjs | 900 +++++++\n' +
        ' tests/engineer/test-phase7-commit.mjs       | 200 ++++\n',
      ensembleSummary: 'plan-verify agreed; review found 0 issues',
    });
    ok(body.startsWith('Add ADR-0028 Phase 7 driver'));
    ok(body.includes('plugins/engineer/scripts/phase7-commit.mjs'));
    ok(body.includes('plan-verify agreed'));
  });

  it('omits the ensemble summary when it exceeds 200 chars', () => {
    const long = 'x'.repeat(250);
    const body = composeBody({
      originalRequest: 'subject',
      diffStat: '',
      ensembleSummary: long,
    });
    ok(!body.includes(long));
  });

  it('strips trailer-shaped lines from original_request and ensemble summary', () => {
    // P9 — the body composition MUST scan sources 1 and 3 for trailers.
    const body = composeBody({
      originalRequest: 'Refactor.\nBREAKING CHANGE: yes\nDetails.\n',
      diffStat: '',
      ensembleSummary: 'Fixes: #999\nAGREED on plan',
    });
    ok(!body.includes('BREAKING CHANGE'));
    ok(!body.includes('Fixes:'));
    ok(body.includes('Refactor'));
    ok(body.includes('AGREED on plan'));
  });

  it('truncates diff stat to 20 lines per P1', () => {
    const big = Array.from({ length: 30 }, (_, i) => ` file${i}.mjs | 10 +++++`).join('\n');
    const body = composeBody({
      originalRequest: 'work',
      diffStat: big,
      ensembleSummary: '',
    });
    // Body wraps diff in ```; count fenced lines.
    const fence = body.split('```')[1] || '';
    strictEqual(fence.trim().split('\n').length, 20);
  });
});

// -----------------------------------------------------------------------------
// inferSubject — P6 conventional-commit shape

describe('inferSubject — P6 subject inference', () => {
  it('produces feat(engineer): … for compose code on plugins/engineer', () => {
    const s = inferSubject({
      packageKey: 'plugins/engineer',
      frontmatter: {
        verb: 'compose',
        profile: 'code',
        original_request: 'Add Phase 7 driver',
      },
    });
    strictEqual(s, 'feat(engineer): Add Phase 7 driver');
  });

  it('produces fix(runtime): … for refine on plugins/runtime', () => {
    const s = inferSubject({
      packageKey: 'plugins/runtime',
      frontmatter: { verb: 'refine', original_request: 'fix cutover footer' },
    });
    strictEqual(s, 'fix(runtime): fix cutover footer');
  });

  it('produces docs(adr): … for compose plan', () => {
    const s = inferSubject({
      packageKey: 'docs',
      frontmatter: { verb: 'compose', profile: 'plan', original_request: 'propose ADR' },
    });
    // packageScope() takes the last path segment.
    strictEqual(s, 'docs(docs): propose ADR');
  });

  it('emits a scopeless subject when packageKey is null (root-docs commit)', () => {
    const s = inferSubject({
      packageKey: null,
      frontmatter: { verb: 'refine', original_request: 'sync AGENTS.md' },
    });
    strictEqual(s, 'fix: sync AGENTS.md');
  });

  it('caps the description at 60 chars with ellipsis', () => {
    const long = 'x'.repeat(80);
    const s = inferSubject({
      packageKey: 'plugins/engineer',
      frontmatter: { verb: 'refine', original_request: long },
    });
    ok(s.endsWith('...'));
    ok(s.length <= 'fix(engineer): '.length + 60);
  });
});

// -----------------------------------------------------------------------------
// packageScope — M1 disambiguation (Phase 5 critique)

describe('packageScope — last-segment + collision disambiguation (M1)', () => {
  it('returns null for null / empty packageKey', () => {
    strictEqual(packageScope(null), null);
    strictEqual(packageScope(''), null);
  });

  it('default heuristic returns the last segment without a packageMap', () => {
    strictEqual(packageScope('plugins/engineer'), 'engineer');
    strictEqual(packageScope('plugins/runtime'), 'runtime');
    strictEqual(packageScope('companions'), 'companions');
  });

  it('keeps the bare last segment when there is no collision in packageMap', () => {
    const map = ['plugins/engineer', 'plugins/runtime', 'plugins/orchestrator'];
    strictEqual(packageScope('plugins/engineer', map), 'engineer');
    strictEqual(packageScope('plugins/runtime', map), 'runtime');
  });

  it('uses plugin/<name> disambiguation when plugins/<name> collides with a root <name>', () => {
    // M1 — root `companions` vs `plugins/companions` both produce
    // 'companions' under the default heuristic; the plugins/* variant
    // adopts the slash form per the existing convention (commit
    // 91d1de9 feat(plugin/engineer): ...).
    const map = ['companions', 'plugins/companions', 'plugins/engineer'];
    strictEqual(packageScope('plugins/companions', map), 'plugin/companions');
    strictEqual(packageScope('companions', map), 'companions');
    // Unrelated entries unaffected.
    strictEqual(packageScope('plugins/engineer', map), 'engineer');
  });

  it('returns the bare last segment for the non-plugins side of a collision', () => {
    const map = ['foo', 'sub/foo'];
    strictEqual(packageScope('foo', map), 'foo');
    // Non-plugins-prefix collision keeps the bare segment for the
    // shorter key; the longer key is left bare too (no plugin/ prefix
    // applies because the path is not `plugins/...`).
    strictEqual(packageScope('sub/foo', map), 'foo');
  });
});

// -----------------------------------------------------------------------------
// isAgenticPluginsRepo — A5 self-detection for ADR-0028 §P3 strict mode.

describe('isAgenticPluginsRepo — package.json name self-detection (A5)', () => {
  it('returns true when package.json name is "agentic-plugins"', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'a5-detect-'));
    try {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'agentic-plugins', version: '0.1.0' }),
      );
      strictEqual(await isAgenticPluginsRepo(dir), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns false when package.json name is a fork or unrelated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'a5-detect-'));
    try {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'consumer-repo', version: '1.0.0' }),
      );
      strictEqual(await isAgenticPluginsRepo(dir), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns false when package.json is absent (lenient default)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'a5-detect-'));
    try {
      strictEqual(await isAgenticPluginsRepo(dir), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns false when package.json is malformed JSON (lenient default)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'a5-detect-'));
    try {
      await writeFile(join(dir, 'package.json'), '{ not valid json');
      strictEqual(await isAgenticPluginsRepo(dir), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns false when package.json lacks a name field', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'a5-detect-'));
    try {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ version: '0.1.0' }));
      strictEqual(await isAgenticPluginsRepo(dir), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns false when repoRoot is missing', async () => {
    strictEqual(await isAgenticPluginsRepo('/nonexistent/repo'), false);
  });
});

describe('inferSubject — disambiguation pass-through', () => {
  it('forwards packageMap to packageScope and produces plugin/companions on collision', () => {
    const map = ['companions', 'plugins/companions'];
    const s = inferSubject({
      packageKey: 'plugins/companions',
      packageMap: map,
      frontmatter: { verb: 'compose', profile: 'code', original_request: 'wire X' },
    });
    strictEqual(s, 'feat(plugin/companions): wire X');
  });

  it('keeps the short scope when no collision', () => {
    const map = ['companions', 'plugins/engineer'];
    const s = inferSubject({
      packageKey: 'plugins/engineer',
      packageMap: map,
      frontmatter: { verb: 'compose', profile: 'code', original_request: 'wire Y' },
    });
    strictEqual(s, 'feat(engineer): wire Y');
  });
});

// -----------------------------------------------------------------------------
// e2e smoke — driver pipeline against a sandbox git repo (Phase 5 critique
// gap closure). One happy path: empty-manifest + workflow + accept-current-tree.
// We do NOT spin up a full schema-1.2 workflow file here (that exercises
// state.mjs's frontmatter validators which have their own coverage); instead
// we hand-craft the minimum frontmatter the driver needs and verify the
// end-to-end planMode and executeMode pipelines move HEAD and write
// terminal_marker.

const PHASE7_BIN = resolve(REPO_ROOT, 'plugins/engineer/scripts/phase7-commit.mjs');
const STATE_BIN = resolve(REPO_ROOT, 'plugins/engineer/scripts/state.mjs');
const REL_PLEASE_CFG = resolve(REPO_ROOT, 'release-please-config.json');

function shell(cwd, cmd, args) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}

async function makeSandboxRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'phase7-e2e-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'phase7-e2e'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'phase7-e2e@example.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  // Copy the real release-please-config.json so detectCrossPackageRoutes
  // recognizes the same package layout as the production repo.
  await writeFile(join(dir, 'release-please-config.json'), await readFile(REL_PLEASE_CFG, 'utf8'));
  // .gitignore so .agentic-plugins/state/ stays out of git_changes.
  await writeFile(join(dir, '.gitignore'), '.agentic-plugins/state/\n');
  await writeFile(join(dir, 'README.md'), '# sandbox\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'chore: sandbox baseline', '--no-verify'], { cwd: dir });
  return dir;
}

/**
 * Bootstrap a workflow file via state.mjs create + optional
 * record-composed-file calls. Returns the workflow path. Using the
 * production state.mjs CLI guarantees schema 1.2 frontmatter that
 * yaml-mini parses cleanly.
 */
function bootstrapWorkflow(dir, { manifest = [] } = {}) {
  const head = shell(dir, 'git', ['rev-parse', 'HEAD']);
  const statusDigest = execFileSync('shasum', ['-a', '256'], {
    input: execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: dir }),
    encoding: 'utf8',
  }).trim().split(/\s+/)[0];
  const wfPath = shell(dir, 'node', [
    STATE_BIN, 'create',
    '--repo-root', dir,
    '--verb', 'compose',
    '--profile', 'code',
    '--persona', 'engineer',
    '--host', 'claude',
    '--workflow-type', 'start',
    '--git-baseline-branch', 'main',
    '--git-baseline-head', head,
    '--status-digest', statusDigest,
    '--current-phase', 'phase-4-implement',
    '--next-action', 'phase 7 sandbox',
    '--original-request', 'e2e sandbox subject',
  ]);
  for (const entry of manifest) {
    shell(dir, 'node', [
      STATE_BIN, 'record-composed-file',
      '--workflow-path', wfPath,
      '--path', entry.path,
      '--op', entry.op,
    ]);
  }
  return wfPath;
}

function runDriver(cwd, args) {
  try {
    const stdout = execFileSync('node', [PHASE7_BIN, ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout: stdout.trimEnd(), stderr: '' };
  } catch (err) {
    return {
      code: err.status ?? 1,
      stdout: err.stdout ? String(err.stdout).trimEnd() : '',
      stderr: err.stderr ? String(err.stderr).trimEnd() : '',
    };
  }
}

describe('phase7-commit driver — sandbox e2e (Phase 5 critique gap closure)', () => {
  it('plan mode JSON emits ask_user=true for empty-manifest', async () => {
    const dir = await makeSandboxRepo();
    try {
      const wf = bootstrapWorkflow(dir);
      // Add a tracked-file modification + an untracked file AFTER
      // bootstrap so they show up in git_changes (status_digest was
      // captured pre-mutation).
      await writeFile(join(dir, 'README.md'), '# sandbox\nmod\n');
      await writeFile(join(dir, 'new.md'), 'untracked\n');
      const result = runDriver(dir, [
        '--mode', 'plan',
        '--workflow-path', wf,
        '--repo-root', dir,
        '--host', 'claude',
      ]);
      strictEqual(result.code, 0, `expected exit 0; stderr=${result.stderr}`);
      const plan = JSON.parse(result.stdout);
      strictEqual(plan.mode, 'plan');
      strictEqual(plan.branch, 'empty-manifest');
      strictEqual(plan.ask_user, true);
      ok(plan.git_changes.includes('README.md'));
      ok(plan.git_changes.includes('new.md'));
      // README + new.md → both are root (exempt) → docs-only.
      strictEqual(plan.classification, 'docs-only');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('execute mode lands a commit and writes terminal_marker=true', async () => {
    const dir = await makeSandboxRepo();
    try {
      // bootstrapWorkflow with the manifest entry so the staging branch
      // is manifest-intersects-git (no ask_user gate). The write
      // happens AFTER bootstrap so the file shows up in git_changes.
      const wf = bootstrapWorkflow(dir, {
        manifest: [{ path: 'README.md', op: 'edit' }],
      });
      await writeFile(join(dir, 'README.md'), '# sandbox\ne2e change\n');
      const before = shell(dir, 'git', ['rev-parse', 'HEAD']);
      const result = runDriver(dir, [
        '--mode', 'execute',
        '--workflow-path', wf,
        '--repo-root', dir,
        '--host', 'claude',
        '--subject', 'docs: e2e sandbox README update',
        '--confirm-non-interactive',
        '--lenient-cc',
      ]);
      strictEqual(result.code, 0, `expected exit 0; stderr=${result.stderr}`);
      const after = shell(dir, 'git', ['rev-parse', 'HEAD']);
      ok(after !== before, 'HEAD must move after execute mode');
      // Verify commit subject + clean working tree.
      const subject = shell(dir, 'git', ['log', '-1', '--format=%s']);
      strictEqual(subject, 'docs: e2e sandbox README update');
      const porcelain = shell(dir, 'git', ['status', '--porcelain=v1']);
      strictEqual(porcelain, '', 'working tree must be clean after commit');
      // Verify workflow frontmatter has terminal_marker: true and
      // current_phase: commit-complete after the driver wrote set-terminal.
      const wfText = await readFile(wf, 'utf8');
      ok(/terminal_marker:\s*true/.test(wfText), 'terminal_marker must be true');
      ok(/current_phase:\s*"?commit-complete/.test(wfText), 'current_phase must be commit-complete');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects --subject when shouldSplit (multi-package staging set)', async () => {
    const dir = await makeSandboxRepo();
    try {
      // bootstrapWorkflow records the manifest entries via
      // record-composed-file; assertSafePath gates pathspec injection
      // at the write boundary, which is the same hardening Layer 3
      // re-runs before each git add.
      const wf = bootstrapWorkflow(dir, {
        manifest: [
          { path: 'plugins/engineer/a.mjs', op: 'create' },
          { path: 'plugins/runtime/b.mjs', op: 'create' },
        ],
      });
      await mkdir(join(dir, 'plugins', 'engineer'), { recursive: true });
      await mkdir(join(dir, 'plugins', 'runtime'), { recursive: true });
      await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
      await writeFile(join(dir, 'plugins', 'runtime', 'b.mjs'), 'export const b = 2;\n');
      const result = runDriver(dir, [
        '--mode', 'execute',
        '--workflow-path', wf,
        '--repo-root', dir,
        '--host', 'claude',
        '--subject', 'feat: should be rejected',
        '--confirm-non-interactive',
        '--lenient-cc',
      ]);
      ok(result.code !== 0, 'driver must reject --subject when requiresSplit=true');
      ok(
        /not allowed when the staging set requires a split/.test(result.stderr),
        `stderr should mention split policy: ${result.stderr}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('M3 — execute with no parent_workflow leaves parent_writeback_at unset', async () => {
    // PR3 Codex peer review MINOR M3-e2e — sandbox proof that the
    // marker logic is gated on parent_workflow linkage. A direct
    // /engineer:start workflow (no orchestrator parent) writes no
    // marker; the writeback branch is skipped entirely.
    const dir = await makeSandboxRepo();
    try {
      const wf = bootstrapWorkflow(dir, {
        manifest: [{ path: 'README.md', op: 'edit' }],
      });
      await writeFile(join(dir, 'README.md'), '# sandbox\nM3-e2e\n');
      const result = runDriver(dir, [
        '--mode', 'execute',
        '--workflow-path', wf,
        '--repo-root', dir,
        '--host', 'claude',
        '--subject', 'docs: M3-e2e marker absent path',
        '--confirm-non-interactive',
        '--lenient-cc',
      ]);
      strictEqual(result.code, 0, `expected exit 0; stderr=${result.stderr}`);
      const wfText = await readFile(wf, 'utf8');
      ok(!/^parent_writeback_at:/m.test(wfText),
         'marker must NOT be written when workflow has no parent_workflow linkage');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// parseSimpleToml + readPhase7Config — P13 inline parser

describe('parseSimpleToml — P13 inline parser', () => {
  it('parses [phase7] strictCC = true', () => {
    const parsed = parseSimpleToml('[phase7]\nstrictCC = true\n');
    strictEqual(parsed.phase7.strictCC, true);
  });

  it('parses strings, ints, booleans', () => {
    const parsed = parseSimpleToml('[section]\na = "hello"\nb = 42\nc = false\n');
    strictEqual(parsed.section.a, 'hello');
    strictEqual(parsed.section.b, 42);
    strictEqual(parsed.section.c, false);
  });

  it('ignores comments and blank lines', () => {
    const parsed = parseSimpleToml('# header\n\n[phase7]\n# inline\nstrictCC = true\n');
    strictEqual(parsed.phase7.strictCC, true);
  });

  it('returns {} for non-string input', () => {
    deepStrictEqual(parseSimpleToml(null), {});
    deepStrictEqual(parseSimpleToml(undefined), {});
    deepStrictEqual(parseSimpleToml(''), {});
  });
});

describe('readPhase7Config — fixture round-trip', () => {
  it('returns strictCC=false when config.toml is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phase7-cfg-'));
    try {
      const cfg = await readPhase7Config(dir);
      strictEqual(cfg.strictCC, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns strictCC=true when [phase7] strictCC=true', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phase7-cfg-'));
    try {
      const ap = join(dir, '.agentic-plugins');
      await import('node:fs/promises').then((m) => m.mkdir(ap));
      await writeFile(join(ap, 'config.toml'), '[phase7]\nstrictCC = true\n');
      const cfg = await readPhase7Config(dir);
      strictEqual(cfg.strictCC, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns strictCC=false for malformed config.toml (lenient default)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phase7-cfg-'));
    try {
      const ap = join(dir, '.agentic-plugins');
      await import('node:fs/promises').then((m) => m.mkdir(ap));
      await writeFile(join(ap, 'config.toml'), 'this is not valid TOML\n');
      const cfg = await readPhase7Config(dir);
      strictEqual(cfg.strictCC, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// decideStagingBranch — the three Layer 3 branches (⊇ / ⊊ / ∅)
// plus accept-current-tree forwarding and no-changes early exit.

describe('decideStagingBranch — staging set branch decision (ADR-0028 §Layer-3)', () => {
  it('returns no-changes when git_changes is empty', () => {
    const r = decideStagingBranch({ gitChanges: [], manifestPaths: ['a.mjs'] });
    strictEqual(r.branch, 'no-changes');
    strictEqual(r.askUser, false);
  });

  it('returns empty-manifest when manifest is empty but git has changes', () => {
    const r = decideStagingBranch({ gitChanges: ['x.mjs'], manifestPaths: [] });
    strictEqual(r.branch, 'empty-manifest');
    strictEqual(r.askUser, true);
    deepStrictEqual(r.stagingSet, ['x.mjs']);
  });

  it('returns manifest-intersects-git when manifest ⊇ git_changes (validated, no prompt)', () => {
    const r = decideStagingBranch({
      gitChanges: ['a.mjs', 'b.mjs'],
      manifestPaths: ['a.mjs', 'b.mjs', 'c.mjs'],
    });
    strictEqual(r.branch, 'manifest-intersects-git');
    strictEqual(r.askUser, false);
    deepStrictEqual(r.stagingSet, ['a.mjs', 'b.mjs']);
  });

  it('returns manifest-subset-of-git with extras when manifest ⊊ git_changes', () => {
    const r = decideStagingBranch({
      gitChanges: ['a.mjs', 'b.mjs', 'extra.mjs'],
      manifestPaths: ['a.mjs', 'b.mjs'],
    });
    strictEqual(r.branch, 'manifest-subset-of-git');
    strictEqual(r.askUser, true);
    deepStrictEqual(r.stagingSet, ['a.mjs', 'b.mjs']);
    deepStrictEqual(r.extras, ['extra.mjs']);
  });

  it('accept-current-tree overrides everything; stages all git_changes', () => {
    const r = decideStagingBranch({
      gitChanges: ['a.mjs', 'extra.mjs'],
      manifestPaths: ['a.mjs'],
      acceptCurrentTree: true,
    });
    strictEqual(r.branch, 'accept-current-tree');
    strictEqual(r.askUser, false);
    deepStrictEqual(r.stagingSet, ['a.mjs', 'extra.mjs']);
  });

  // ADR-0028 PR4 A4 — manifest-subset-of-git extras flow.
  //
  // Background: plan-mode reports the manifest∩git intersection as the
  // staging set and lists the extras (git_changes − manifest) for the
  // user. Previously the user could only accept ALL extras (via
  // `--accept-current-tree`) or NONE (via `--confirm-non-interactive`
  // alone). A4 adds a middle path: per-path opt-in extras via the
  // repeatable `--include-extra <path>` flag. The decideStagingBranch
  // contract gains an `includeExtras?: string[]` param that, when
  // present, unions only the listed paths back into stagingSet
  // (intersection ∪ includeExtras). An includeExtras entry that is
  // NOT a member of the extras set is a programmer error and throws
  // — the caller should validate paths from the user dialog against
  // the plan-mode extras list before passing them.
  describe('manifest-subset-of-git + includeExtras (PR4 A4)', () => {
    it('unions includeExtras back into stagingSet when subset of extras', () => {
      const r = decideStagingBranch({
        gitChanges: ['a.mjs', 'b.mjs', 'extra1.mjs', 'extra2.mjs'],
        manifestPaths: ['a.mjs', 'b.mjs'],
        includeExtras: ['extra1.mjs'],
      });
      strictEqual(r.branch, 'manifest-subset-of-git');
      // stagingSet contains both intersection AND the opted-in extras.
      deepStrictEqual([...r.stagingSet].sort(), ['a.mjs', 'b.mjs', 'extra1.mjs']);
      // extras still surfaces what was NOT chosen.
      deepStrictEqual(r.extras, ['extra1.mjs', 'extra2.mjs']);
    });

    it('empty includeExtras behaves like before (intersection only)', () => {
      const r = decideStagingBranch({
        gitChanges: ['a.mjs', 'b.mjs', 'extra.mjs'],
        manifestPaths: ['a.mjs', 'b.mjs'],
        includeExtras: [],
      });
      strictEqual(r.branch, 'manifest-subset-of-git');
      deepStrictEqual(r.stagingSet, ['a.mjs', 'b.mjs']);
    });

    it('throws when includeExtras contains a path NOT in extras', () => {
      throws(
        () => decideStagingBranch({
          gitChanges: ['a.mjs', 'b.mjs', 'extra.mjs'],
          manifestPaths: ['a.mjs', 'b.mjs'],
          includeExtras: ['not-an-extra.mjs'],
        }),
        /include-extra.*not.*in.*extras|includeExtras.*subset/i,
      );
    });

    it('ignores includeExtras when branch is NOT manifest-subset-of-git', () => {
      // accept-current-tree already stages everything; includeExtras
      // is a no-op (would be confusing if it threw).
      const r = decideStagingBranch({
        gitChanges: ['a.mjs', 'extra.mjs'],
        manifestPaths: ['a.mjs'],
        acceptCurrentTree: true,
        includeExtras: ['extra.mjs'],
      });
      strictEqual(r.branch, 'accept-current-tree');
      deepStrictEqual(r.stagingSet, ['a.mjs', 'extra.mjs']);
    });
  });
});

// -----------------------------------------------------------------------------
// commitShapeFor — P12 exhaustive enum switch

describe('commitShapeFor — P12 classifyMixedCase exhaustive switch (ADR-0028)', () => {
  it('single-package: 1 commit, requiresSplit=false', () => {
    const shape = commitShapeFor({
      classification: 'single-package',
      perPackageCommits: [{ package: 'plugins/engineer', files: ['a.mjs'] }],
    });
    strictEqual(shape.commits.length, 1);
    strictEqual(shape.requiresSplit, false);
  });

  it('single-package-with-docs: 1 commit (folded), requiresSplit=false', () => {
    const shape = commitShapeFor({
      classification: 'single-package-with-docs',
      perPackageCommits: [
        { package: 'plugins/engineer', files: ['a.mjs', 'docs/x.md'] },
      ],
    });
    strictEqual(shape.commits.length, 1);
    strictEqual(shape.requiresSplit, false);
  });

  it('multi-package: N commits, requiresSplit=true', () => {
    const shape = commitShapeFor({
      classification: 'multi-package',
      perPackageCommits: [
        { package: 'plugins/engineer', files: ['a.mjs'] },
        { package: 'plugins/runtime', files: ['b.mjs'] },
      ],
    });
    strictEqual(shape.commits.length, 2);
    strictEqual(shape.requiresSplit, true);
  });

  it('multi-package-with-docs: N+1 commits with docs commit appended last', () => {
    const shape = commitShapeFor({
      classification: 'multi-package-with-docs',
      perPackageCommits: [
        { package: 'plugins/engineer', files: ['a.mjs'] },
        { package: 'plugins/runtime', files: ['b.mjs'] },
      ],
      docsCommit: { files: ['docs/x.md'] },
    });
    strictEqual(shape.commits.length, 3);
    strictEqual(shape.commits[2].package, null);
    deepStrictEqual(shape.commits[2].files, ['docs/x.md']);
    strictEqual(shape.requiresSplit, true);
  });

  it('docs-only: 1 commit (docs), requiresSplit=false', () => {
    const shape = commitShapeFor({
      classification: 'docs-only',
      perPackageCommits: [],
      docsCommit: { files: ['docs/x.md'] },
    });
    strictEqual(shape.commits.length, 1);
    strictEqual(shape.commits[0].package, null);
    strictEqual(shape.requiresSplit, false);
  });

  it('empty: 0 commits, requiresSplit=false', () => {
    const shape = commitShapeFor({
      classification: 'empty',
      perPackageCommits: [],
    });
    strictEqual(shape.commits.length, 0);
    strictEqual(shape.requiresSplit, false);
  });

  it('throws on unknown classification (P12 exhaustive guard)', () => {
    throws(
      () => commitShapeFor({ classification: 'not-a-real-case', perPackageCommits: [] }),
      /unknown classification/,
    );
  });
});

// -----------------------------------------------------------------------------
// pickSubjectForCommit — single-commit + split-commit subject resolution
// (ADR-0028 PR4 N2 — multiline reject defense).

describe('pickSubjectForCommit — newline-bearing subjects (ADR-0028 PR4 N2)', () => {
  it('rejects single-commit --subject containing \\n', () => {
    throws(
      () => pickSubjectForCommit({
        commit: { package: 'plugins/engineer', files: ['a.mjs'] },
        flags: { subject: 'feat(engineer): a\nfix(x): b', 'subject-pkg': [] },
        requiresSplit: false,
      }),
      /multiline subject|newline|line break/i,
    );
  });

  it('rejects single-commit --subject containing \\r', () => {
    throws(
      () => pickSubjectForCommit({
        commit: { package: 'plugins/engineer', files: ['a.mjs'] },
        flags: { subject: 'feat: a\rstray', 'subject-pkg': [] },
        requiresSplit: false,
      }),
      /multiline subject|newline|line break/i,
    );
  });

  it('rejects split --subject-pkg whose value contains \\n', () => {
    throws(
      () => pickSubjectForCommit({
        commit: { package: 'plugins/engineer', files: ['a.mjs'] },
        flags: { 'subject-pkg': ['plugins/engineer=feat(engineer): a\nfix(x): b'] },
        requiresSplit: true,
      }),
      /multiline subject|newline|line break/i,
    );
  });

  it('accepts a normal single-line subject (regression guard)', () => {
    const got = pickSubjectForCommit({
      commit: { package: 'plugins/engineer', files: ['a.mjs'] },
      flags: { subject: 'feat(engineer): a single line', 'subject-pkg': [] },
      requiresSplit: false,
    });
    strictEqual(got, 'feat(engineer): a single line');
  });
});

// -----------------------------------------------------------------------------
// checkSubjectAgainstCC — multiline subject must be rejected by the
// CC regex AND the explicit `/[\r\n]/` guard (defense in depth).

describe('checkSubjectAgainstCC — multiline reject (ADR-0028 PR4 N2)', () => {
  const stderr = { write: () => {} };

  it('strict mode: throws on multiline subject', () => {
    throws(
      () => checkSubjectAgainstCC({
        subject: 'feat(x): a\nfix(y): b',
        strictCC: true,
        stderr,
      }),
      // Either the explicit newline reject OR the CC mismatch path is
      // an acceptable error — both close the body-injection vector.
      /multiline|newline|line break|Conventional Commit/i,
    );
  });

  it('lenient mode: still rejects multiline subject (security gate, not style)', () => {
    throws(
      () => checkSubjectAgainstCC({
        subject: 'feat(x): a\r\nfix(y): b',
        strictCC: false,
        stderr,
      }),
      /multiline|newline|line break/i,
    );
  });

  it('accepts a single-line CC subject in both modes', () => {
    strictEqual(
      checkSubjectAgainstCC({
        subject: 'feat(engineer): add Phase 7 driver',
        strictCC: true,
        stderr,
      }),
      true,
    );
  });
});
