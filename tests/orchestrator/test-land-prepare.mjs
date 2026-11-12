// tests/orchestrator/test-land-prepare.mjs
//
// ADR-0062, amendment of 2026-11-11 — the landing preparation helper
// (plugins/orchestrator/scripts/land-prepare.mjs) against a real git
// repository with a bare "origin", a fake `gh` on PATH that keeps its pull
// requests in a JSON file, and a fake engineer CLI that records a committed
// comparison in the child workflow's frontmatter as the real one does.
// The pure decisions are held by test-land-prepare-plan.mjs.

import { describe, it } from 'node:test';
import { strictEqual, ok, match, deepStrictEqual } from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { tmpDir } from '../_tmp.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const STATE_MJS = path.resolve(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs');
const CLI = path.resolve(REPO_ROOT, 'plugins/orchestrator/scripts/land-prepare.mjs');
const { createWorkflow, setPlan, updateSubtask } = await import(STATE_MJS);
const { readComparison } = await import(CLI);

const CHILD = 'compose-20200101T000000Z-abcdef';
const BRANCH = 'w8';

// The caller's environment without a variable of an autopilot run or of the
// agentic plugins (this file may run under one), with a fixed git identity.
function baseEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('AGENTIC_') && !k.startsWith('GIT_')) env[k] = v;
  }
  return {
    ...env,
    GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t.local',
    GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t.local',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
const { execFileSync } = require('child_process');
const file = process.env.FAKE_GH_STATE;
const st = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
st.log.push(args);
const save = () => fs.writeFileSync(file, JSON.stringify(st));
const opt = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const originHead = (b) => { try { return execFileSync('git', ['--git-dir', process.env.FAKE_GH_ORIGIN, 'rev-parse', 'refs/heads/' + b], { encoding: 'utf8' }).trim(); } catch { return null; } };
const out = (v) => { save(); process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v)); process.exit(0); };
if (args[0] === 'auth') { save(); process.exit(st.auth === false ? 1 : 0); }
if (args[0] === 'repo' && args[1] === 'view') out({ nameWithOwner: args[2] === 'o/r' ? 'o/r' : 'someone/else' });
if (args[0] === 'pr' && args[1] === 'list') {
  // Only the fields --json names, as gh answers: a field the helper forgets to
  // ask for is missing here too.
  const fields = (opt('--json') || '').split(',');
  const pick = (p) => Object.fromEntries(fields.filter((k) => k in p).map((k) => [k, p[k]]));
  out(st.prs.filter((p) => p.headRefName === opt('--head')).map((p) => pick({ ...p, headRefOid: p.state === 'OPEN' ? originHead(p.headRefName) : p.headRefOid })));
}
if (args[0] === 'pr' && args[1] === 'create') {
  const n = 100 + st.prs.length;
  st.prs.push({ number: n, url: 'https://github.com/o/r/pull/' + n, state: 'OPEN', baseRefName: opt('--base'), headRefName: opt('--head'), createdAt: new Date().toISOString(), isCrossRepository: false, title: opt('--title'), body: fs.readFileSync(opt('--body-file'), 'utf8') });
  out('https://github.com/o/r/pull/' + n + '\\n');
}
if (args[0] === 'pr' && args[1] === 'edit') {
  const p = st.prs.find((x) => String(x.number) === args[2]);
  if (opt('--title')) p.title = opt('--title');
  if (opt('--body-file')) p.body = fs.readFileSync(opt('--body-file'), 'utf8');
  out('');
}
if (args[0] === 'run' && args[1] === 'list') {
  const sha = opt('--commit');
  const pushed = Object.values(st.prs).some((p) => p.state === 'OPEN' && originHead(p.headRefName) === sha);
  if (st.ci === 'success' && pushed) out([{ databaseId: 1, headSha: sha, status: 'completed', conclusion: 'success', createdAt: '2026-01-01T00:00:00Z', attempt: 1, url: 'u', workflowName: opt('--workflow') }]);
  if (st.ci === 'failure' && pushed) out([{ databaseId: 1, headSha: sha, status: 'completed', conclusion: 'failure', createdAt: '2026-01-01T00:00:00Z', attempt: 1, url: 'https://ci/1', workflowName: opt('--workflow') }]);
  // gh's --commit filter is trusted no further than the head sha it reports.
  if (st.ci === 'old') out([{ databaseId: 1, headSha: '0'.repeat(40), status: 'completed', conclusion: 'success', createdAt: '2026-01-01T00:00:00Z', attempt: 1, url: 'u', workflowName: opt('--workflow') }]);
  out([]);
}
process.stderr.write('fake gh: unhandled ' + JSON.stringify(args) + '\\n');
process.exit(2);
`;

// A fake engineer CLI: records the committed comparison of HEAD at
// --repo-root into the child workflow's review_bindings, as the real
// review-binding-record does, and logs each call.
const FAKE_ENGINEER = `#!/usr/bin/env node
// 'review-binding-record'
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2);
const opt = (n) => args[args.indexOf(n) + 1];
const head = execFileSync('git', ['-C', opt('--repo-root'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
fs.appendFileSync(process.env.FAKE_ENGINEER_LOG, JSON.stringify({ args, head }) + '\\n');
if (process.env.FAKE_ENGINEER_FAIL) {
  process.stdout.write(JSON.stringify({ ok: false, recorded: false, state: 'not-comparable', reason: 'no-landing-ref' }) + '\\n');
  process.exit(1);
}
const file = opt('--workflow-path');
let text = fs.readFileSync(file, 'utf8');
const m = /^review_bindings: (.*)$/m.exec(text);
const doc = m ? JSON.parse(JSON.parse(m[1])) : { v: 1, attempts: {}, answers: {}, seen: {}, comparisons: {} };
doc.comparisons[head] = { state: 'same', manifest_sha256: 'f'.repeat(64), at: 'now' };
const line = 'review_bindings: ' + JSON.stringify(JSON.stringify(doc));
text = m ? text.replace(m[0], line) : text.replace(/\\n---\\n/, '\\n' + line + '\\n---\\n');
fs.writeFileSync(file, text);
// FAKE_ENGINEER_ANSWER: the record is written, but the answer does not vouch
// for it — each shape fails one clause of the gate alone.
const answer = process.env.FAKE_ENGINEER_ANSWER ?? '';
const named = answer === 'other-commit' ? '0'.repeat(40) : head;
const recorded = answer !== 'not-recorded';
process.stdout.write(JSON.stringify({ ok: recorded, recorded, commit: named, state: 'same', reason: null, failures: [] }) + '\\n');
if (answer === 'exit-1') process.exit(1);
`;

async function fixture(t, { behind = true, conflict = false, trailer = true, realEngineer = false, upstreamCopy = false, withBody = true } = {}) {
  const dir = tmpDir(t, 'land-prepare-');
  const env = baseEnv();
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  const origin = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env });
  execFileSync('git', ['clone', '-q', origin, work], { env });
  fs.writeFileSync(path.join(work, '.gitignore'), '.agentic-plugins/\n');
  fs.writeFileSync(path.join(work, 'release-please-config.json'), JSON.stringify({ packages: { 'plugins/orchestrator': {}, 'plugins/engineer': {} } }));
  fs.mkdirSync(path.join(work, 'plugins/orchestrator'), { recursive: true });
  fs.writeFileSync(path.join(work, 'plugins/orchestrator/shared.txt'), 'base\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'base');
  git(work, 'push', '-q', 'origin', 'main');

  git(work, 'switch', '-q', '-c', BRANCH);
  fs.writeFileSync(path.join(work, 'plugins/orchestrator/a.txt'), 'subtask\n');
  if (conflict) fs.writeFileSync(path.join(work, 'plugins/orchestrator/shared.txt'), 'branch\n');
  git(work, 'add', '-A');
  const message = `feat(plugin/orchestrator): add a\n${withBody ? '\nThe intended body.\n' : ''}${trailer ? `\nWorkflow-ID: ${CHILD}\n` : ''}`;
  fs.writeFileSync(path.join(dir, 'msg.txt'), message);
  git(work, 'commit', '-q', '--cleanup=verbatim', '-F', path.join(dir, 'msg.txt'));
  git(work, 'switch', '-q', 'main');
  if (behind) {
    if (conflict) fs.writeFileSync(path.join(work, 'plugins/orchestrator/shared.txt'), 'main\n');
    // The branch's change, landed on main by another commit: a rebase drops it.
    else if (upstreamCopy) fs.writeFileSync(path.join(work, 'plugins/orchestrator/a.txt'), 'subtask\n');
    else fs.writeFileSync(path.join(work, 'other.txt'), 'main moved\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'main moved');
    git(work, 'push', '-q', 'origin', 'main');
  }

  // origin names a GitHub repository, which gh is bound to; git reaches the
  // bare repository through an insteadOf rewrite.
  git(work, 'remote', 'set-url', 'origin', 'https://github.com/o/r.git');
  git(work, 'config', `url.${origin}.insteadOf`, 'https://github.com/o/r.git');

  const { filePath: macroPath } = await createWorkflow({
    repoRoot: work, verb: 'plan', host: 'claude',
    gitBaseline: { branch: 'main', head: '0'.repeat(40), status_digest: '' },
    originalRequest: 'land-prepare fixture',
  });
  await setPlan({ workflowPath: macroPath, host: 'claude', subtasks: [{ id: 'A', verb: 'compose', branch: BRANCH, blocked_by: [], status: 'in_progress' }] });
  await updateSubtask({ workflowPath: macroPath, subtaskId: 'A', host: 'claude', engineerWorkflowId: CHILD });
  const macroId = path.basename(macroPath, '.md');
  const archive = path.join(work, '.agentic-plugins/state/engineer/archive');
  fs.mkdirSync(archive, { recursive: true });
  const childFile = path.join(archive, `${CHILD}.md`);
  // Every field the engineer's parser requires, so the real CLI reads it.
  fs.writeFileSync(childFile, `---\nschema: "1.4"\nworkflow_id: "${CHILD}"\npersona: "engineer"\nverb: "compose"\nprofile: "code"\n` +
    `original_request: "fixture"\nstarted_at: "2020-01-01T00:00:00Z"\nupdated_at: "2020-01-01T00:00:00Z"\nrepo_root: ${JSON.stringify(work)}\n` +
    `parent_workflow: "${macroId}"\noriginating_subtask: "A"\ngit_baseline:\n  branch: "${BRANCH}"\n  head: "${'0'.repeat(40)}"\n  status_digest: ""\n` +
    `current_phase: "commit-complete"\nnext_action: "done"\ntasks: []\nhost_history:\n  - host: "claude"\n    at: "2020-01-01T00:00:00Z"\n    event: "created"\n---\n\nbody\n`);

  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  const eng = path.join(dir, 'engineer');
  fs.mkdirSync(path.join(eng, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(eng, 'scripts', 'state.mjs'), FAKE_ENGINEER);
  const ghState = path.join(dir, 'gh.json');
  fs.writeFileSync(ghState, JSON.stringify({ prs: [], log: [], ci: 'success' }));
  const engLog = path.join(dir, 'engineer.log');
  fs.writeFileSync(engLog, '');

  const runEnv = {
    ...env,
    PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${env.PATH}`,
    FAKE_GH_STATE: ghState, FAKE_GH_ORIGIN: origin, FAKE_ENGINEER_LOG: engLog,
    AGENTIC_ENGINEER_ROOT: realEngineer ? path.join(REPO_ROOT, 'plugins/engineer') : eng,
  };
  const run = (args = [], extra = {}) => {
    const r = spawnSync(process.execPath, [CLI, '--workflow-path', macroPath, '--subtask', 'A', '--repo', work, '--ci-timeout', '0', '--poll', '0', '--format', 'json', ...args], { encoding: 'utf8', env: { ...runEnv, ...extra } });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* none */ }
    return { status: r.status, stderr: r.stderr, json };
  };
  const gh = () => JSON.parse(fs.readFileSync(ghState, 'utf8'));
  const setGh = (patch) => fs.writeFileSync(ghState, JSON.stringify({ ...gh(), ...patch }));
  const engineerCalls = () => fs.readFileSync(engLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const refs = () => git(work, 'for-each-ref', '--format=%(refname) %(objectname)').split('\n').filter((l) => !l.startsWith('refs/remotes/')).sort();
  const worktrees = () => git(work, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length;
  const advanceMain = (name) => {
    fs.writeFileSync(path.join(work, name), `${name}\n`);
    git(work, 'add', name);
    git(work, 'commit', '-q', '-m', `main ${name}`);
    git(work, 'push', '-q', 'origin', 'main');
  };
  return { dir, work, origin, git, run, gh, setGh, engineerCalls, refs, worktrees, childFile, macroId, advanceMain };
}

const body = (git, cwd, ref) => git(cwd, 'cat-file', 'commit', ref).split('\n\n').slice(1).join('\n\n');

describe('land-prepare --execute', () => {
  it('rebases a branch behind main, records the comparison, pushes, opens the pull request and reports ready', async (t) => {
    const f = await fixture(t);
    const before = f.git(f.work, 'rev-parse', BRANCH);
    const message = body(f.git, f.work, BRANCH);
    const r = f.run(['--execute']);
    strictEqual(r.status, 0, r.stderr);
    const head = f.git(f.work, 'rev-parse', BRANCH);
    ok(head !== before, 'the branch was rebased');
    strictEqual(f.git(f.work, 'rev-parse', `${BRANCH}~1`), f.git(f.work, 'rev-parse', 'refs/remotes/origin/main'));
    // The message, Workflow-ID trailer included, is kept byte for byte.
    strictEqual(body(f.git, f.work, BRANCH), message);
    strictEqual(f.git(f.origin, 'rev-parse', `refs/heads/${BRANCH}`), head);
    strictEqual(r.json.stage, 'ready');
    strictEqual(r.json.head, head);
    deepStrictEqual(r.json.packages, ['plugins/orchestrator']);
    strictEqual(r.json.comparison.state, 'same');
    // The comparison was recorded for the rebased head, not the old one.
    deepStrictEqual(f.engineerCalls().map((c) => c.head), [head]);
    const created = f.gh().log.filter((a) => a[0] === 'pr' && a[1] === 'create');
    strictEqual(created.length, 1);
    ok(created[0].includes('--base') && created[0][created[0].indexOf('--base') + 1] === 'main');
    strictEqual(f.gh().prs[0].title, 'feat(plugin/orchestrator): add a');
    strictEqual(f.gh().prs[0].body, 'The intended body.\n');
    match(r.json.merge_commands[0], new RegExp(`^gh pr merge 100 --repo o/r --rebase --match-head-commit ${head}$`));
    // Every pull request and run call is bound to origin's repository.
    ok(f.gh().log.filter((a) => a[0] === 'pr' || a[0] === 'run').every((a) => a.at(-2) === '--repo' && a.at(-1) === 'o/r'));
    match(r.json.merge_commands[1], /--squash --match-head-commit/);
    strictEqual(fs.readFileSync(path.join(f.work, '.agentic-plugins/runs/landing', f.macroId, 'A', 'squash-title.txt'), 'utf8'), 'feat(plugin/orchestrator): add a (#100)\n');
    // No scratch worktree is left.
    strictEqual(f.worktrees(), 1);
  });

  it('rewrites nothing on a branch already current, pushed and with its pull request open', async (t) => {
    const f = await fixture(t, { behind: false });
    strictEqual(f.run(['--execute']).status, 0);
    const head = f.git(f.work, 'rev-parse', BRANCH);
    const calls = f.engineerCalls().length;
    const r = f.run(['--execute']);
    strictEqual(r.status, 0, r.stderr);
    strictEqual(f.git(f.work, 'rev-parse', BRANCH), head);
    deepStrictEqual(r.json.actions, []);
    strictEqual(f.gh().log.filter((a) => a[1] === 'create').length, 1, 'the pull request was reused');
    strictEqual(f.engineerCalls().length, calls, 'the comparison already recorded is not recorded again');
  });

  it('resumes after an interruption between the push and the pull request without pushing again', async (t) => {
    const f = await fixture(t, { behind: false });
    f.git(f.work, 'push', '-q', 'origin', `${BRANCH}:refs/heads/${BRANCH}`);
    const head = f.git(f.work, 'rev-parse', BRANCH);
    const r = f.run(['--execute']);
    strictEqual(r.status, 0, r.stderr);
    ok(!r.json.actions.some((a) => a.startsWith('pushed')), r.json.actions.join('; '));
    ok(r.json.actions.some((a) => a.startsWith('opened a pull request')));
    strictEqual(f.git(f.origin, 'rev-parse', `refs/heads/${BRANCH}`), head);
  });

  it('refuses when someone else moved the remote branch, and pushes nothing', async (t) => {
    const f = await fixture(t, { behind: false });
    // Another commit on origin's branch that the local branch does not have.
    const other = path.join(f.dir, 'other');
    f.git(f.dir, 'clone', '-q', f.origin, other);
    f.git(other, 'switch', '-q', '-c', BRANCH);
    f.git(other, 'commit', '-q', '--allow-empty', '-m', 'someone else');
    f.git(other, 'push', '-q', 'origin', BRANCH);
    const theirs = f.git(other, 'rev-parse', 'HEAD');
    const r = f.run(['--execute']);
    strictEqual(r.status, 1);
    strictEqual(r.json.refused, 'remote-moved');
    strictEqual(f.git(f.origin, 'rev-parse', `refs/heads/${BRANCH}`), theirs);
    strictEqual(f.gh().prs.length, 0);
  });

  it('waits for CI on the current head and never counts a run on an older sha', async (t) => {
    const f = await fixture(t, { behind: false });
    f.setGh({ ci: 'old' });
    const r = f.run(['--execute']);
    strictEqual(r.status, 3, r.stderr);
    strictEqual(r.json.stage, 'wait-ci');
    deepStrictEqual(r.json.ci.workflows.map((w) => w.state), ['missing', 'missing']);
    deepStrictEqual(r.json.merge_commands, []);
  });

  it('reports a failed CI run with its address', async (t) => {
    const f = await fixture(t, { behind: false });
    f.setGh({ ci: 'failure' });
    const r = f.run(['--execute']);
    strictEqual(r.status, 4, r.stderr);
    strictEqual(r.json.stage, 'ci-failed');
    strictEqual(r.json.ci.workflows[0].url, 'https://ci/1');
  });

  it('refuses a rebase that conflicts, leaving the branch ref untouched and no scratch worktree', async (t) => {
    const f = await fixture(t, { conflict: true });
    const before = f.refs();
    const r = f.run(['--execute']);
    strictEqual(r.status, 1);
    strictEqual(r.json.refused, 'rebase-conflict');
    match(r.json.detail, /plugins\/orchestrator\/shared\.txt/);
    deepStrictEqual(f.refs(), before);
    strictEqual(f.worktrees(), 1);
    strictEqual(f.gh().prs.length, 0);
  });

  it('refuses a commit with no Workflow-ID trailer before any write', async (t) => {
    const f = await fixture(t, { trailer: false });
    const before = f.refs();
    const r = f.run(['--execute']);
    strictEqual(r.status, 1);
    strictEqual(r.json.refused, 'commit-without-workflow');
    deepStrictEqual(f.refs(), before);
  });

  it('refuses to move the branch while a worktree has it checked out', async (t) => {
    const f = await fixture(t);
    const holder = path.join(f.dir, 'holder');
    f.git(f.work, 'worktree', 'add', '-q', holder, BRANCH);
    const before = f.refs();
    const r = f.run(['--execute']);
    strictEqual(r.status, 1);
    strictEqual(r.json.refused, 'branch-checked-out');
    deepStrictEqual(f.refs(), before);
  });

  it('refuses under an autopilot run', async (t) => {
    const f = await fixture(t);
    const r = f.run(['--execute'], { AGENTIC_AUTOPILOT: 'autopilot-x' });
    strictEqual(r.status, 1);
    strictEqual(r.json.refused, 'autopilot');
    strictEqual(f.gh().log.length, 0);
  });

  it('needs a title for several commits when it must open the pull request', async (t) => {
    const f = await fixture(t, { behind: false });
    f.git(f.work, 'switch', '-q', BRANCH);
    fs.writeFileSync(path.join(f.dir, 'm2.txt'), `fix(plugin/engineer): b\n\nSecond.\n\nWorkflow-ID: ${CHILD}\n`);
    fs.mkdirSync(path.join(f.work, 'plugins/engineer'), { recursive: true });
    fs.writeFileSync(path.join(f.work, 'plugins/engineer/b.txt'), 'b\n');
    f.git(f.work, 'add', 'plugins/engineer/b.txt');
    f.git(f.work, 'commit', '-q', '--cleanup=verbatim', '-F', path.join(f.dir, 'm2.txt'));
    f.git(f.work, 'switch', '-q', 'main');
    strictEqual(f.run(['--execute']).json.refused, 'title-required');
    fs.writeFileSync(path.join(f.dir, 'title.txt'), 'W8: two packages\n');
    const r = f.run(['--execute', '--title-file', path.join(f.dir, 'title.txt')]);
    strictEqual(r.status, 0, r.stderr);
    deepStrictEqual(r.json.packages, ['plugins/engineer', 'plugins/orchestrator']);
    strictEqual(r.json.merge_commands.length, 1, 'several commits land by rebase only');
    match(f.gh().prs[0].body, /^- feat\(plugin\/orchestrator\): add a\n\n {2}The intended body\.\n\n- fix\(plugin\/engineer\): b/);
  });
});

describe('land-prepare refusals and isolation (plan-verify of 2026-11-12)', () => {
  it('keeps to the scratch worktree when GIT_DIR and GIT_WORK_TREE point at the checkout', async (t) => {
    const f = await fixture(t);
    const main = f.git(f.work, 'rev-parse', 'main');
    const r = f.run(['--execute'], { GIT_DIR: path.join(f.work, '.git'), GIT_WORK_TREE: f.work });
    strictEqual(r.status, 0, r.stderr);
    strictEqual(f.git(f.work, 'rev-parse', 'main'), main);
    strictEqual(f.git(f.work, 'rev-parse', `${BRANCH}~1`), f.git(f.work, 'rev-parse', 'refs/remotes/origin/main'));
  });

  it('fetches only the refs it names, whatever fetch mapping origin configures', async (t) => {
    const f = await fixture(t);
    f.git(f.work, 'config', '--add', 'remote.origin.fetch', '+refs/heads/main:refs/heads/unexpected-local');
    const before = f.refs();
    strictEqual(f.run([]).status, 0);
    deepStrictEqual(f.refs(), before);
  });

  it("binds gh to origin's repository, not GH_REPO", async (t) => {
    const f = await fixture(t, { behind: false });
    const r = f.run(['--execute'], { GH_REPO: 'someone/else' });
    strictEqual(r.status, 0, r.stderr);
    strictEqual(r.json.repository, 'o/r');
    ok(f.gh().log.filter((a) => a[0] === 'pr').every((a) => a.includes('o/r')));
  });

  it('refuses a pull request of another base before rebasing or pushing', async (t) => {
    const f = await fixture(t);
    f.git(f.work, 'push', '-q', 'origin', `${BRANCH}:refs/heads/${BRANCH}`);
    const remote = f.git(f.origin, 'rev-parse', `refs/heads/${BRANCH}`);
    f.setGh({ prs: [{ number: 9, url: 'u', state: 'OPEN', baseRefName: 'dev', headRefName: BRANCH, createdAt: '2026-01-01T00:00:00Z', isCrossRepository: false }] });
    const before = f.refs();
    const r = f.run(['--execute']);
    strictEqual(r.status, 1);
    strictEqual(r.json.refused, 'base-mismatch');
    deepStrictEqual(f.refs(), before);
    strictEqual(f.git(f.origin, 'rev-parse', `refs/heads/${BRANCH}`), remote);
  });

  it('pushes nothing when the committed comparison cannot be recorded', async (t) => {
    const f = await fixture(t, { behind: false });
    const r = f.run(['--execute'], { FAKE_ENGINEER_FAIL: '1' });
    strictEqual(r.status, 1);
    strictEqual(r.json.refused, 'record-failed');
    strictEqual(spawnSync('git', ['--git-dir', f.origin, 'rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`]).status, 1);
    strictEqual(f.gh().prs.length, 0);
  });

  // The read-back alone would pass these: the comparison is in the file, but
  // the engineer's answer does not vouch for it. Each answer fails one clause
  // of the gate alone: a nonzero exit, recorded false, another commit.
  for (const answer of ['exit-1', 'not-recorded', 'other-commit']) {
    it(`pushes nothing when the engineer's answer does not vouch for the record it wrote (${answer})`, async (t) => {
      const f = await fixture(t, { behind: false });
      const head = f.git(f.work, 'rev-parse', BRANCH);
      const r = f.run(['--execute'], { FAKE_ENGINEER_ANSWER: answer });
      strictEqual(f.engineerCalls().length, 1, 'the engineer was asked to record');
      strictEqual(readComparison(f.childFile, head).state, 'recorded', 'the record is in the file, so only the answer refuses');
      strictEqual(r.status, 1);
      strictEqual(r.json.refused, 'record-failed');
      strictEqual(spawnSync('git', ['--git-dir', f.origin, 'rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`]).status, 1);
      strictEqual(f.gh().prs.length, 0);
    });
  }

  it('accepts its own unpushed lineage after a second rebase', async (t) => {
    const f = await fixture(t, { behind: false });
    f.git(f.work, 'push', '-q', 'origin', `${BRANCH}:refs/heads/${BRANCH}`);
    f.advanceMain('m1.txt');
    const hook = path.join(f.work, '.git', 'hooks', 'pre-push');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const first = f.run(['--execute']);
    strictEqual(first.json.refused, 'push-refused');
    fs.rmSync(hook);
    f.advanceMain('m2.txt');
    const r = f.run(['--execute']);
    strictEqual(r.status, 0, r.stderr);
    strictEqual(f.git(f.origin, 'rev-parse', `refs/heads/${BRANCH}`), f.git(f.work, 'rev-parse', BRANCH));
    strictEqual(f.git(f.work, 'rev-parse', `${BRANCH}~1`), f.git(f.work, 'rev-parse', 'refs/remotes/origin/main'));
  });

  // Critique F1: the common rerun path. The first run rebases, pushes and is
  // ready; main moves while the owner waits; the rerun rebases the pushed head
  // again and must push over its own earlier push.
  it('rebases and pushes again after main moves past a rebase it already pushed', async (t) => {
    const f = await fixture(t);
    strictEqual(f.run(['--execute']).status, 0);
    const pushed = f.git(f.origin, 'rev-parse', `refs/heads/${BRANCH}`);
    f.advanceMain('m1.txt');
    const r = f.run(['--execute']);
    strictEqual(r.status, 0, r.stderr);
    const head = f.git(f.work, 'rev-parse', BRANCH);
    ok(head !== pushed, 'the branch was rebased again');
    strictEqual(f.git(f.origin, 'rev-parse', `refs/heads/${BRANCH}`), head);
    strictEqual(f.git(f.work, 'rev-parse', `${BRANCH}~1`), f.git(f.work, 'rev-parse', 'refs/remotes/origin/main'));
    strictEqual(r.json.stage, 'ready');
  });

  // Critique F2: a rebase recorded whose ref move never happened (an
  // interruption between the two, or a run that lost the compare-and-swap)
  // leaves the earlier lineage readable.
  it('keeps its lineage when a recorded rebase never moved the ref', async (t) => {
    const f = await fixture(t, { behind: false });
    f.git(f.work, 'push', '-q', 'origin', `${BRANCH}:refs/heads/${BRANCH}`);
    f.advanceMain('m1.txt');
    const hook = path.join(f.work, '.git', 'hooks', 'pre-push');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    strictEqual(f.run(['--execute']).json.refused, 'push-refused');
    fs.rmSync(hook);
    const local = f.git(f.work, 'rev-parse', BRANCH);
    // The pair a second rebase appends before its ref move, left alone: the
    // lineage's last line names a head the ref never reached.
    const lineage = path.join(f.work, '.agentic-plugins/runs/landing', f.macroId, 'A', 'lineage.jsonl');
    ok(fs.existsSync(lineage), 'the first rebase appended its pair');
    const unused = f.git(f.work, 'rev-parse', 'refs/remotes/origin/main');
    fs.appendFileSync(lineage, `\n${JSON.stringify({ branch: BRANCH, before: local, after: unused })}\n{"branch":"w8","bef`);
    const r = f.run(['--execute']);
    strictEqual(r.status, 0, r.stderr);
    strictEqual(f.git(f.origin, 'rev-parse', `refs/heads/${BRANCH}`), local);
  });

  // Critique F3: the push must reach the repository gh is bound to.
  it('refuses a push URL that is not the fetch URL, before any write', async (t) => {
    const f = await fixture(t);
    const elsewhere = path.join(f.dir, 'elsewhere.git');
    f.git(f.dir, 'init', '-q', '--bare', elsewhere);
    f.git(f.work, 'config', 'remote.origin.pushurl', elsewhere);
    const before = f.refs();
    const r = f.run(['--execute']);
    strictEqual(r.status, 1);
    strictEqual(r.json.refused, 'push-destination');
    match(r.json.detail, /pushes to .*elsewhere\.git but fetches from/);
    deepStrictEqual(f.refs(), before);
    strictEqual(f.git(elsewhere, 'for-each-ref'), '');
    strictEqual(spawnSync('git', ['--git-dir', f.origin, 'rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`]).status, 1);
    strictEqual(f.gh().prs.length, 0);
    // A dry run reports it.
    const dry = f.run([]);
    strictEqual(dry.status, 0, dry.stderr);
    ok(dry.json.notes.some((n) => /pushes to .* but fetches from .*--execute would refuse/.test(n)), dry.json.notes.join('; '));
  });

  it('refuses a fetch rewrite to another GitHub repository', async (t) => {
    const f = await fixture(t);
    f.git(f.work, 'config', '--unset-all', `url.${f.origin}.insteadOf`);
    f.git(f.work, 'config', 'url.https://github.com/someone/else.git.insteadOf', 'https://github.com/o/r.git');
    const r = f.run(['--execute']);
    strictEqual(r.status, 1);
    strictEqual(r.json.refused, 'push-destination');
    match(r.json.detail, /names o\/r, but git reaches someone\/else/);
  });

  for (const key of ['receivepack', 'vcs']) {
    it(`refuses a transport override (remote.origin.${key}) before any write`, async (t) => {
      const f = await fixture(t);
      f.git(f.work, 'config', `remote.origin.${key}`, key === 'vcs' ? 'other' : 'git-receive-pack');
      const before = f.refs();
      const r = f.run(['--execute']);
      strictEqual(r.status, 1);
      strictEqual(r.json.refused, 'push-destination');
      match(r.json.detail, new RegExp(`remote\\.origin\\.${key}`));
      deepStrictEqual(f.refs(), before);
    });
  }

  it('drops configuration injected through the environment, so the push goes to origin', async (t) => {
    const f = await fixture(t);
    const elsewhere = path.join(f.dir, 'elsewhere.git');
    f.git(f.dir, 'init', '-q', '--bare', elsewhere);
    const r = f.run(['--execute'], {
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.origin.pushurl', GIT_CONFIG_VALUE_0: elsewhere,
      GIT_CONFIG_PARAMETERS: `'remote.origin.pushurl'='${elsewhere}'`,
    });
    strictEqual(r.status, 0, r.stderr);
    strictEqual(f.git(f.origin, 'rev-parse', `refs/heads/${BRANCH}`), f.git(f.work, 'rev-parse', BRANCH));
    strictEqual(f.git(elsewhere, 'for-each-ref'), '');
  });

  it('reads the configuration the push uses, whatever GIT_CONFIG names', async (t) => {
    const f = await fixture(t);
    f.git(f.work, 'config', 'remote.origin.receivepack', 'git-receive-pack');
    // A file holding only the expected URL: git config alone would read it.
    const decoy = path.join(f.dir, 'decoy.config');
    fs.writeFileSync(decoy, '[remote "origin"]\n\turl = https://github.com/o/r.git\n');
    const before = f.refs();
    const r = f.run(['--execute'], { GIT_CONFIG: decoy });
    strictEqual(r.status, 1, r.stderr);
    strictEqual(r.json.refused, 'push-destination');
    deepStrictEqual(f.refs(), before);
  });

  it('drops configuration injected through the environment (control)', async (t) => {
    const f = await fixture(t);
    const elsewhere = path.join(f.dir, 'elsewhere.git');
    f.git(f.dir, 'init', '-q', '--bare', elsewhere);
    const r = f.run(['--execute'], {
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.origin.pushurl', GIT_CONFIG_VALUE_0: elsewhere,
    });
    strictEqual(r.status, 0, r.stderr);
    strictEqual(f.git(f.origin, 'rev-parse', `refs/heads/${BRANCH}`), f.git(f.work, 'rev-parse', BRANCH));
    strictEqual(f.git(elsewhere, 'for-each-ref'), '');
  });

  it('refuses a rebase that drops a commit already upstream, leaving the branch', async (t) => {
    const f = await fixture(t, { upstreamCopy: true });
    const before = f.refs();
    const r = f.run(['--execute']);
    strictEqual(r.status, 1);
    strictEqual(r.json.refused, 'rebase-changed-series');
    deepStrictEqual(f.refs(), before);
    strictEqual(f.worktrees(), 1);
  });

  it('opens the pull request with a plain body when the commit has none', async (t) => {
    const f = await fixture(t, { behind: false, withBody: false });
    const r = f.run(['--execute']);
    strictEqual(r.status, 0, r.stderr);
    strictEqual(f.gh().prs[0].body, `Subtask A of ${f.macroId}.\n`);
  });
});

describe('land-prepare squash text (critique round 2, G1)', () => {
  const squashFiles = (f) => {
    const dir = path.join(f.work, '.agentic-plugins/runs/landing', f.macroId, 'A');
    return { title: fs.readFileSync(path.join(dir, 'squash-title.txt'), 'utf8'), body: fs.readFileSync(path.join(dir, 'squash-body.txt'), 'utf8') };
  };

  it("keeps the pull request's text on a rerun without the first run's title and body files", async (t) => {
    const f = await fixture(t, { behind: false });
    fs.writeFileSync(path.join(f.dir, 'title.txt'), 'W8: the landing helper\n');
    fs.writeFileSync(path.join(f.dir, 'body.txt'), 'The reviewed body.\n');
    const first = f.run(['--execute', '--title-file', path.join(f.dir, 'title.txt'), '--body-file', path.join(f.dir, 'body.txt')]);
    strictEqual(first.status, 0, first.stderr);
    deepStrictEqual(squashFiles(f), { title: 'W8: the landing helper (#100)\n', body: 'The reviewed body.\n' });
    // The rerun names neither file: the squash text still comes from the PR,
    // never from the commit's own subject and body.
    const again = f.run(['--execute']);
    strictEqual(again.status, 0, again.stderr);
    deepStrictEqual(squashFiles(f), { title: 'W8: the landing helper (#100)\n', body: 'The reviewed body.\n' });
    match(again.json.merge_commands[1], /--squash --match-head-commit/);
  });

  it('takes the text this run edited onto an open pull request, a title alone or a body alone', async (t) => {
    const f = await fixture(t, { behind: false });
    strictEqual(f.run(['--execute']).status, 0);
    fs.writeFileSync(path.join(f.dir, 'title.txt'), 'W8: retitled\n');
    const titled = f.run(['--execute', '--title-file', path.join(f.dir, 'title.txt')]);
    strictEqual(titled.status, 0, titled.stderr);
    deepStrictEqual(squashFiles(f), { title: 'W8: retitled (#100)\n', body: 'The intended body.\n' });
    fs.writeFileSync(path.join(f.dir, 'body.txt'), 'A body set on the open pull request.\n');
    const bodied = f.run(['--execute', '--body-file', path.join(f.dir, 'body.txt')]);
    strictEqual(bodied.status, 0, bodied.stderr);
    deepStrictEqual(squashFiles(f), { title: 'W8: retitled (#100)\n', body: 'A body set on the open pull request.\n' });
  });

  it('takes an edit the owner made on GitHub', async (t) => {
    const f = await fixture(t, { behind: false });
    strictEqual(f.run(['--execute']).status, 0);
    const prs = f.gh().prs;
    prs[0] = { ...prs[0], title: 'Edited on GitHub', body: 'Edited body.\r\n' };
    f.setGh({ prs });
    const r = f.run(['--execute']);
    strictEqual(r.status, 0, r.stderr);
    deepStrictEqual(squashFiles(f), { title: 'Edited on GitHub (#100)\n', body: 'Edited body.\n' });
  });

  it('prints no squash command when the pull request text would be refused, and says why', async (t) => {
    const f = await fixture(t, { behind: false });
    strictEqual(f.run(['--execute']).status, 0);
    const dir = path.join(f.work, '.agentic-plugins/runs/landing', f.macroId, 'A');
    fs.rmSync(path.join(dir, 'squash-title.txt'));
    fs.rmSync(path.join(dir, 'squash-body.txt'));
    const prs = f.gh().prs;
    prs[0] = { ...prs[0], body: 'Intro\n\nBREAKING CHANGE: routed' };
    f.setGh({ prs });
    const r = f.run(['--execute']);
    strictEqual(r.status, 0, r.stderr);
    strictEqual(r.json.merge_commands.length, 1, 'the rebase merge only');
    ok(r.json.notes.some((n) => /no squash command: pull request #100's body: line 3 is a breaking-change footer/.test(n)), JSON.stringify(r.json.notes));
    ok(!fs.existsSync(path.join(dir, 'squash-title.txt')));
  });
});

describe('land-prepare with the engineer CLI', () => {
  it('records the committed comparison through the real review-binding-record, keyed by the rebased head', async (t) => {
    const f = await fixture(t, { realEngineer: true });
    const before = f.git(f.work, 'rev-parse', BRANCH);
    const r = f.run(['--execute']);
    strictEqual(r.status, 0, r.stderr);
    const head = f.git(f.work, 'rev-parse', BRANCH);
    ok(head !== before);
    // The child has no review: the engineer records no-reviews for the head,
    // and the helper reads that record back from the child's frontmatter.
    strictEqual(r.json.comparison.state, 'no-reviews');
    const m = /^review_bindings: (.*)$/m.exec(fs.readFileSync(f.childFile, 'utf8'));
    ok(m, 'the engineer wrote review_bindings');
    deepStrictEqual(Object.keys(JSON.parse(JSON.parse(m[1])).comparisons), [head]);
  });
});

describe('land-prepare dry run', () => {
  it('reports the next stage and changes no ref but the remote-tracking ones, no worktree and no pull request', async (t) => {
    const f = await fixture(t);
    const before = f.refs();
    const r = f.run([]);
    strictEqual(r.status, 0, r.stderr);
    strictEqual(r.json.mode, 'dry-run');
    strictEqual(r.json.stage, 'rebase');
    strictEqual(r.json.fresh, false);
    deepStrictEqual(f.refs(), before);
    strictEqual(f.worktrees(), 1);
    deepStrictEqual(f.engineerCalls(), []);
    ok(!f.gh().log.some((a) => ['create', 'edit'].includes(a[1])));
  });
});
