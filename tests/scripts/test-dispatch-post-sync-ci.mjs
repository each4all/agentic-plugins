// Tests for scripts/dispatch-post-sync-ci.mjs and its release-please.yml wiring
// (docket C58).
//
// A GITHUB_TOKEN push starts no workflow, so the release job's catalog and
// stage-doc sync commits never got a CI run of their own, and every release
// commit since 2026-09-09 carried a red run that read the catalogs before the
// sync. The release job now dispatches the push-to-main test workflows on main
// after its sync pushes. These tests pin the three things that make that
// trustworthy: what a dispatched run is recorded as validating, when the step
// runs relative to the job's other failure domains, and that the dispatched set
// is exactly the set a normal push of the sync paths would have started.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  POST_SYNC_WORKFLOWS,
  dispatchPostSyncCi,
  renderReport,
} from '../../scripts/dispatch-post-sync-ci.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/dispatch-post-sync-ci.mjs');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github/workflows');
const RELEASE_WORKFLOW = 'release-please.yml';

const REPO = 'owner/name';
// The in-memory tests dispatch these, not POST_SYNC_WORKFLOWS, so a failure
// they inject keeps its target when the real workflow set changes.
const WORKFLOWS = ['alpha.yml', 'beta.yml', 'gamma.yml', 'delta.yml'];
const SYNC = 'a'.repeat(40);
const LATER = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);

/**
 * A fake GitHub API. `runs` maps a workflow file to the head_sha its dispatched
 * run gets; `compare` maps a head sha to the compare status against SYNC.
 * Every call is recorded so a test can assert what was sent.
 */
function fakeApi({ runs = {}, compare = {}, dispatchError = {}, noRunId = [], runError = [], runFlaky = {} } = {}) {
  const calls = [];
  let nextId = 100;
  const idToWorkflow = new Map();
  const flaky = { ...runFlaky };
  const api = (route, opts = {}) => {
    calls.push({ route, ...opts });
    let m = route.match(/^repos\/owner\/name\/actions\/workflows\/([^/]+)\/dispatches$/);
    if (m) {
      const wf = m[1];
      if (dispatchError[wf]) throw new Error(dispatchError[wf]);
      if (noRunId.includes(wf)) return {};
      const id = nextId += 1;
      idToWorkflow.set(id, wf);
      return { workflow_run_id: id, run_url: `https://api.example/runs/${id}`, html_url: `https://example/runs/${id}` };
    }
    m = route.match(/^repos\/owner\/name\/actions\/runs\/(\d+)$/);
    if (m) {
      const wf = idToWorkflow.get(Number(m[1]));
      if (runError.includes(wf)) throw new Error('HTTP 502');
      if (flaky[wf] > 0) {
        flaky[wf] -= 1;
        throw new Error('HTTP 404: Not Found');
      }
      return { id: Number(m[1]), head_sha: runs[wf] ?? SYNC, head_branch: 'main', event: 'workflow_dispatch', html_url: `https://example/runs/${m[1]}` };
    }
    m = route.match(/^repos\/owner\/name\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/);
    if (m) {
      const status = compare[m[2]];
      if (!status) throw new Error(`HTTP 404: no compare for ${m[2]}`);
      return { status, ahead_by: status === 'ahead' ? 2 : 0, behind_by: status === 'behind' ? 1 : 0 };
    }
    throw new Error(`unexpected route ${route}`);
  };
  return { api, calls };
}

const sleeps = [];
const run = (api, extra = {}) => {
  sleeps.length = 0;
  return dispatchPostSyncCi({
    api, repo: REPO, ref: 'main', expectSha: SYNC, workflows: WORKFLOWS,
    sleep: (ms) => sleeps.push(ms), ...extra,
  });
};

// ---------------------------------------------------------------------------
// What each dispatched run is recorded as validating
// ---------------------------------------------------------------------------

test('dispatches every post-sync workflow on the ref, asking GitHub for the run id', () => {
  const { api, calls } = fakeApi();
  const summary = run(api);
  const dispatches = calls.filter((c) => c.route.endsWith('/dispatches'));
  assert.deepEqual(dispatches.map((c) => c.route.split('/')[5]), WORKFLOWS);
  for (const c of dispatches) {
    assert.equal(c.method, 'POST');
    assert.deepEqual(c.fields, { ref: 'main', return_run_details: true },
      'without return_run_details the endpoint answers 204 and the run cannot be identified');
  }
  assert.equal(summary.ok, true);
});

test('a run whose head_sha is the pushed sync commit validates exactly that commit', () => {
  const { api, calls } = fakeApi();
  const summary = run(api);
  assert.equal(summary.expectSha, SYNC);
  for (const r of summary.results) {
    assert.equal(r.outcome, 'validated');
    assert.equal(r.headSha, SYNC);
    assert.ok(r.runId > 100);
    assert.equal(r.ok, true);
  }
  assert.equal(calls.filter((c) => c.route.includes('/compare/')).length, 0, 'an exact match needs no ancestry check');
});

test('main advanced before the run was created: a descendant head is recorded as such and accepted', () => {
  const { api, calls } = fakeApi({ runs: { 'alpha.yml': LATER }, compare: { [LATER]: 'ahead' } });
  const summary = run(api);
  const full = summary.results.find((r) => r.workflow === 'alpha.yml');
  assert.equal(full.outcome, 'advanced');
  assert.equal(full.headSha, LATER);
  assert.equal(full.ok, true, 'a descendant still contains the sync commit');
  assert.equal(summary.ok, true);
  const cmp = calls.find((c) => c.route.includes('/compare/'));
  assert.equal(cmp.route, `repos/${REPO}/compare/${SYNC}...${LATER}`, 'base is the intended sha, head is what the run got');
  const report = renderReport(summary);
  const line = report.lines.find((l) => l.text.startsWith('alpha.yml'));
  assert.equal(line.level, 'warning');
  assert.match(line.text, /main advanced/);
  assert.ok(line.text.includes(LATER), 'the full head_sha the run validated is recorded, not an abbreviation');
  assert.match(line.text, /aaaaaaa/);
  assert.ok(report.markdown.includes(`\`${LATER}\``), 'and so is the step summary');
});

for (const status of ['behind', 'diverged']) {
  test(`a run whose head is ${status} relative to the intended sha fails the step`, () => {
    const { api } = fakeApi({ runs: { 'beta.yml': OTHER }, compare: { [OTHER]: status } });
    const summary = run(api);
    const r = summary.results.find((x) => x.workflow === 'beta.yml');
    assert.equal(r.outcome, 'not-descendant');
    assert.equal(r.ok, false);
    assert.equal(summary.ok, false);
    assert.match(renderReport(summary).lines.find((l) => l.text.startsWith('beta.yml')).text, new RegExp(status));
  });
}

test('an ancestry check that cannot be made fails closed', () => {
  const { api } = fakeApi({ runs: { 'gamma.yml': OTHER } });
  const summary = run(api);
  const r = summary.results.find((x) => x.workflow === 'gamma.yml');
  assert.equal(r.outcome, 'compare-failed');
  assert.equal(summary.ok, false);
});

test('one failed dispatch does not stop the others, and fails the step', () => {
  const { api, calls } = fakeApi({ dispatchError: { 'delta.yml': 'HTTP 403: Resource not accessible by integration' } });
  const summary = run(api);
  assert.equal(calls.filter((c) => c.route.endsWith('/dispatches')).length, WORKFLOWS.length);
  const r = summary.results.find((x) => x.workflow === 'delta.yml');
  assert.equal(r.outcome, 'dispatch-failed');
  assert.match(r.detail, /403/);
  assert.equal(summary.results.filter((x) => x.ok).length, WORKFLOWS.length - 1);
  assert.equal(summary.ok, false);
});

test('a dispatch answered without a run id fails: the run exists but what it validates is unrecorded', () => {
  const { api } = fakeApi({ noRunId: ['beta.yml'] });
  const summary = run(api);
  const r = summary.results.find((x) => x.workflow === 'beta.yml');
  assert.equal(r.outcome, 'no-run-id');
  assert.equal(r.ok, false);
  const text = renderReport(summary).lines.find((l) => l.text.startsWith('beta.yml')).text;
  assert.match(text, /dispatched/);
  assert.match(text, /no run id/);
});

test('a run that is not readable at once is read again, and the dispatch is not repeated', () => {
  const { api, calls } = fakeApi({ runFlaky: { 'alpha.yml': 1 } });
  const summary = run(api);
  const r = summary.results.find((x) => x.workflow === 'alpha.yml');
  assert.equal(r.outcome, 'validated');
  assert.deepEqual(sleeps, [2000], 'one wait, before the second read');
  assert.equal(calls.filter((c) => c.route.endsWith('/alpha.yml/dispatches')).length, 1,
    'a POST that may have created a run is never sent twice');
  assert.equal(summary.ok, true);
});

test('a run that cannot be read back after the bounded retries fails the step', () => {
  const { api, calls } = fakeApi({ runError: ['alpha.yml'] });
  const summary = run(api);
  const r = summary.results.find((x) => x.workflow === 'alpha.yml');
  assert.equal(r.outcome, 'run-read-failed');
  assert.match(r.detail, /HTTP 502 \(3 attempts\)/);
  assert.equal(calls.filter((c) => c.route === `repos/${REPO}/actions/runs/${r.runId}`).length, 3);
  assert.deepEqual(sleeps, [2000, 5000]);
  assert.equal(summary.ok, false);
});

test('the report says the runs validate post-sync main, not the release commit', () => {
  const { api } = fakeApi();
  const report = renderReport(run(api));
  const head = report.lines.map((l) => l.text).join('\n');
  assert.match(head, new RegExp(`Intended post-sync sha: ${SYNC}`));
  assert.match(head, /post-sync main, not the release commit/);
  assert.match(report.markdown, /\| Workflow \| Run \| head_sha \| Outcome \|/);
  for (const wf of WORKFLOWS) assert.match(report.markdown, new RegExp(wf.replace('.', '\\.')));
});

// ---------------------------------------------------------------------------
// The CLI, end to end, against a fake `gh` on PATH
// ---------------------------------------------------------------------------

/** A workflow file name as a literal inside a RegExp. */
const escaped = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function fakeGh(t, { headSha = SYNC, dispatchStderr = null, hangDispatch = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'post-sync-gh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls.jsonl');
  const gh = path.join(dir, 'gh');
  writeFileSync(gh, `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + '\\n');
const route = argv.find((a) => a.startsWith('repos/'));
if (route.endsWith('/dispatches')) {
  if (${JSON.stringify(hangDispatch)}) {
    setTimeout(() => {}, 60000); // a call that never answers
  } else if (${JSON.stringify(dispatchStderr)}) {
    process.stderr.write(${JSON.stringify(dispatchStderr)} + '\\n');
    process.exit(1);
  } else {
    const n = fs.readFileSync(${JSON.stringify(log)}, 'utf8').trim().split('\\n').length;
    process.stdout.write(JSON.stringify({ workflow_run_id: 7000 + n, run_url: 'u', html_url: 'https://example/runs/' + (7000 + n) }));
  }
} else if (route.includes('/actions/runs/')) {
  process.stdout.write(JSON.stringify({ head_sha: ${JSON.stringify(headSha)}, head_branch: 'main', event: 'workflow_dispatch', html_url: 'h' }));
} else {
  process.stderr.write('unexpected ' + route);
  process.exit(1);
}
`);
  chmodSync(gh, 0o755);
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { dir, calls };
}

test('CLI — dispatches through gh api with typed fields, records each run, and writes the step summary', (t) => {
  const gh = fakeGh(t);
  const summaryFile = path.join(gh.dir, 'summary.md');
  const env = { ...process.env, PATH: `${gh.dir}${path.delimiter}${process.env.PATH}`, GITHUB_STEP_SUMMARY: summaryFile, GITHUB_ACTIONS: '' };
  const out = spawnSync(process.execPath, [SCRIPT, '--repo', REPO, '--ref', 'main', '--expect-sha', SYNC], { env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const dispatches = gh.calls().filter((argv) => argv.some((a) => a.endsWith('/dispatches')));
  assert.equal(dispatches.length, POST_SYNC_WORKFLOWS.length);
  for (const argv of dispatches) {
    assert.deepEqual(argv.slice(0, 3), ['api', '--method', 'POST']);
    assert.ok(argv.includes('-f') && argv.includes('ref=main'), argv.join(' '));
    // -F, not -f: a string "true" is not the boolean the endpoint reads.
    assert.equal(argv[argv.indexOf('return_run_details=true') - 1], '-F', argv.join(' '));
  }
  for (const wf of POST_SYNC_WORKFLOWS) assert.match(out.stdout, new RegExp(`${wf.replace('.', '\\.')}: run \\d+ validates ${SYNC} `));
  assert.match(readFileSync(summaryFile, 'utf8'), /Intended post-sync sha/);
});

test('CLI — a failing check exits 1 and, on Actions, annotates it as an error', (t) => {
  const gh = fakeGh(t, { headSha: OTHER });
  const env = { ...process.env, PATH: `${gh.dir}${path.delimiter}${process.env.PATH}`, GITHUB_STEP_SUMMARY: '', GITHUB_ACTIONS: 'true' };
  const out = spawnSync(process.execPath, [SCRIPT, '--repo', REPO, '--expect-sha', SYNC], { env, encoding: 'utf8' });
  assert.equal(out.status, 1);
  assert.match(out.stdout, new RegExp(`^::error::${escaped(POST_SYNC_WORKFLOWS[0])}`, 'm'), 'the fake gh has no compare route, so the ancestry check fails closed');
});

test('CLI — a refused dispatch reports GitHub\'s reason from gh\'s stderr, not just the command line', (t) => {
  const gh = fakeGh(t, { dispatchStderr: 'gh: Resource not accessible by integration (HTTP 403)' });
  const env = { ...process.env, PATH: `${gh.dir}${path.delimiter}${process.env.PATH}`, GITHUB_STEP_SUMMARY: '', GITHUB_ACTIONS: '' };
  const out = spawnSync(process.execPath, [SCRIPT, '--repo', REPO, '--expect-sha', SYNC], { env, encoding: 'utf8' });
  assert.equal(out.status, 1);
  for (const wf of POST_SYNC_WORKFLOWS) {
    const line = out.stdout.split('\n').find((l) => l.startsWith(`${wf}:`));
    assert.match(line, /dispatch failed: gh api POST .*: gh: Resource not accessible by integration \(HTTP 403\)/);
  }
});

test('CLI — annotation text escapes % so GitHub does not read it as an encoded character', (t) => {
  const gh = fakeGh(t, { dispatchStderr: 'HTTP 422: 100% of inputs refused' });
  const env = { ...process.env, PATH: `${gh.dir}${path.delimiter}${process.env.PATH}`, GITHUB_STEP_SUMMARY: '', GITHUB_ACTIONS: 'true' };
  const out = spawnSync(process.execPath, [SCRIPT, '--repo', REPO, '--expect-sha', SYNC], { env, encoding: 'utf8' });
  assert.equal(out.status, 1);
  assert.match(out.stdout, new RegExp(`^::error::${escaped(POST_SYNC_WORKFLOWS[0])}: dispatch failed: .*100%25 of inputs refused$`, 'm'));
});

test('CLI — a gh call that never answers is cut off at --gh-timeout-ms, and the other workflows still run', (t) => {
  const gh = fakeGh(t, { hangDispatch: true });
  const env = { ...process.env, PATH: `${gh.dir}${path.delimiter}${process.env.PATH}`, GITHUB_STEP_SUMMARY: '', GITHUB_ACTIONS: '' };
  const started = Date.now();
  const out = spawnSync(process.execPath, [SCRIPT, '--repo', REPO, '--expect-sha', SYNC, '--gh-timeout-ms', '300'], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(out.status, 1, out.stderr);
  assert.ok(Date.now() - started < 20000, 'bounded by the per-call timeout, not the fake gh\'s 60s');
  // Judged from the script's own report, not the fake's call log: the fake is
  // a Node process too, and under load it can be killed at 300ms before it
  // has started far enough to log the call.
  for (const wf of POST_SYNC_WORKFLOWS) {
    const line = out.stdout.split('\n').find((l) => l.startsWith(`${wf}:`));
    assert.match(line ?? '', /dispatch failed: gh api POST .*: timed out after 300ms/, `${wf} was attempted and cut off`);
  }
});

for (const [label, args] of [
  ['a zero gh timeout', ['--repo', REPO, '--expect-sha', 'a'.repeat(40), '--gh-timeout-ms', '0']],
  ['a short sha', ['--repo', REPO, '--expect-sha', 'aaaaaaa']],
  ['no sha', ['--repo', REPO]],
  ['no repo', ['--expect-sha', SYNC]],
  ['a malformed repo', ['--repo', 'owner', '--expect-sha', SYNC]],
  ['an unknown flag', ['--repo', REPO, '--expect-sha', SYNC, '--dry-run']],
]) {
  test(`CLI — usage error on ${label}, before any dispatch`, (t) => {
    const gh = fakeGh(t);
    const env = { ...process.env, PATH: `${gh.dir}${path.delimiter}${process.env.PATH}` };
    const out = spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8' });
    assert.equal(out.status, 2, out.stderr);
    assert.throws(() => gh.calls(), /ENOENT/, 'gh was never called');
  });
}

// ---------------------------------------------------------------------------
// The release job wiring — .github/workflows/release-please.yml
// ---------------------------------------------------------------------------

const releaseYml = () => readFileSync(path.join(WORKFLOWS_DIR, RELEASE_WORKFLOW), 'utf8');

/** The job's steps, in order, as { name, text }. */
function steps(yml) {
  const parts = yml.split(/^(?=      - name: )/m).slice(1);
  return parts.map((text) => ({ name: text.match(/^      - name: (.+)$/m)[1].trim(), text }));
}

const stepById = (all, id) => {
  const found = all.filter((s) => new RegExp(`^        id: ${id}$`, 'm').test(s.text));
  assert.equal(found.length, 1, `exactly one step has id ${id}`);
  return found[0];
};

test('release-please.yml grants the job actions: write, which the dispatch endpoint needs', () => {
  const perms = releaseYml().match(/^permissions:\n((?:  .+\n)+)/m);
  assert.ok(perms, 'a workflow-level permissions block');
  assert.match(perms[1], /^  actions: write$/m);
  assert.match(perms[1], /^  contents: write$/m, 'the sync pushes still need contents: write');
});

test('each sync push step records that it pushed, only after the push succeeded', () => {
  const all = steps(releaseYml());
  for (const id of ['catalog-push', 'docs-push']) {
    const s = stepById(all, id);
    const lines = s.text.split('\n');
    const push = lines.findIndex((l) => /^\s+git push$/.test(l));
    const out = lines.findIndex((l) => /echo "pushed=true" >> "\$GITHUB_OUTPUT"/.test(l));
    assert.ok(push > 0, `${id} pushes`);
    assert.ok(out > push, `${id} records the push after it (bash -e stops before the record when the push fails)`);
    assert.equal(lines.filter((l) => l.includes('pushed=true')).length, 1);
  }
});

test('the dispatch step runs after both pushes, and the obligation assertion stays last', () => {
  const all = steps(releaseYml());
  const names = all.map((s) => s.name);
  const at = (pred) => all.findIndex(pred);
  const catalog = at((s) => /^        id: catalog-push$/m.test(s.text));
  const docs = at((s) => /^        id: docs-push$/m.test(s.text));
  const dispatch = at((s) => s.text.includes('scripts/dispatch-post-sync-ci.mjs'));
  const obligation = at((s) => s.text.includes('scripts/check-release-obligation.mjs'));
  assert.ok(catalog >= 0 && docs > catalog && dispatch > docs, `dispatch follows both pushes: ${names.join(' | ')}`);
  assert.equal(obligation, all.length - 1, 'the obligation assertion stays last');
  assert.equal(dispatch, obligation - 1);
});

/**
 * Evaluate a GitHub Actions `if:` expression over a closed grammar: the status
 * functions, steps.<id>.outputs.<name>, steps.<id>.outcome, github.event_name,
 * single-quoted literals, == != && || ! and parentheses. Anything else throws,
 * so a construct this does not model cannot be evaluated as something it is
 * not. An expression with no status function gets GitHub's implicit success().
 * (GitHub's == ignores case for strings; every literal here is lower case.)
 */
function evalCondition(expr, ctx) {
  const token = /\s+|cancelled\(\)|success\(\)|failure\(\)|always\(\)|steps\.([\w-]+)\.outputs\.([\w-]+)|steps\.([\w-]+)\.outcome|github\.event_name|'([^']*)'|==|!=|&&|\|\||!|\(|\)/y;
  let js = '';
  let pos = 0;
  while (pos < expr.length) {
    token.lastIndex = pos;
    const m = token.exec(expr);
    if (!m) throw new Error(`unmodelled expression at "${expr.slice(pos)}"`);
    pos = token.lastIndex;
    const t = m[0];
    if (/^\s+$/.test(t)) js += ' ';
    else if (t === 'cancelled()') js += 'ctx.cancelled';
    else if (t === 'success()') js += '(!ctx.failed && !ctx.cancelled)';
    else if (t === 'failure()') js += 'ctx.failed';
    else if (t === 'always()') js += 'true';
    else if (m[1]) js += `(ctx.steps[${JSON.stringify(m[1])}]?.outputs?.[${JSON.stringify(m[2])}] ?? null)`;
    else if (m[3]) js += `(ctx.steps[${JSON.stringify(m[3])}]?.outcome ?? null)`;
    else if (t === 'github.event_name') js += 'ctx.event';
    else if (m[4] !== undefined) js += JSON.stringify(m[4]);
    else if (t === '==') js += '===';
    else if (t === '!=') js += '!==';
    else js += t;
  }
  if (!/\b(cancelled|success|failure|always)\(\)/.test(expr)) js = `(!ctx.failed && !ctx.cancelled) && (${js})`;
  return Boolean(new Function('ctx', `return (${js});`)(ctx));
}

const condOf = (step) => {
  const c = step.text.match(/^        if: \$\{\{ (.+) \}\}$/m)?.[1];
  assert.ok(c, `${step.name} has a single-line if`);
  return c;
};

// Every path through the job up to the dispatch step. `failed` is whether any
// earlier step failed, which is what success() and failure() read.
const ok = (pushed) => ({ outcome: 'success', outputs: pushed ? { pushed: 'true' } : {} });
const failed = { outcome: 'failure', outputs: {} };
const skipped = { outcome: 'skipped', outputs: {} };
const released = { outputs: { releases_created: 'true' } };
const noRelease = { outputs: { releases_created: 'false' } };
const PATHS = [
  ['release; both sync pushes land', 'push', false, { release: released, 'catalog-push': ok(true), 'docs-push': ok(true) }, true],
  ['release; catalog lands, stage-doc evidence check fails', 'push', true, { release: released, 'catalog-push': ok(true), 'docs-push': skipped }, true],
  ['release; catalog lands, stage-doc push rejected', 'push', true, { release: released, 'catalog-push': ok(true), 'docs-push': failed }, true],
  ['release; only the stage-doc push lands', 'push', false, { release: released, 'catalog-push': ok(false), 'docs-push': ok(true) }, true],
  ['release; nothing to sync', 'push', false, { release: released, 'catalog-push': ok(false), 'docs-push': ok(false) }, false],
  ['release; catalog sync refused', 'push', true, { release: released, 'catalog-push': skipped, 'docs-push': skipped }, false],
  ['release; catalog push rejected', 'push', true, { release: released, 'catalog-push': failed, 'docs-push': skipped }, false],
  ['push that released nothing, or a re-run of a release run', 'push', false, { release: noRelease, 'catalog-push': skipped, 'docs-push': skipped }, false],
  ['manual dispatch; nothing new to push', 'workflow_dispatch', false, { release: noRelease, 'catalog-push': ok(false), 'docs-push': ok(false) }, true],
  ['manual dispatch; stage-doc evidence check fails', 'workflow_dispatch', true, { release: noRelease, 'catalog-push': ok(false), 'docs-push': skipped }, true],
  ['manual dispatch; catalog sync refused', 'workflow_dispatch', true, { release: noRelease, 'catalog-push': skipped, 'docs-push': skipped }, false],
  ['manual dispatch; catalog push rejected', 'workflow_dispatch', true, { release: noRelease, 'catalog-push': failed, 'docs-push': skipped }, false],
  ['manual dispatch; release-please itself failed', 'workflow_dispatch', true, { release: { outcome: 'failure', outputs: {} }, 'catalog-push': skipped, 'docs-push': skipped }, false],
];

test('the dispatch condition, evaluated on every path through the job', () => {
  const all = steps(releaseYml());
  const dispatchCond = condOf(all.find((x) => x.text.includes('scripts/dispatch-post-sync-ci.mjs')));
  const obligationCond = condOf(all.find((x) => x.text.includes('scripts/check-release-obligation.mjs')));
  for (const [label, event, anyFailed, stepsCtx, expected] of PATHS) {
    const ctx = { event, failed: anyFailed, cancelled: false, steps: stepsCtx };
    assert.equal(evalCondition(dispatchCond, ctx), expected, `dispatch — ${label}`);
    // The obligation step still runs on every release and dispatch, whatever failed before it.
    const releaseOrDispatch = event === 'workflow_dispatch' || stepsCtx.release.outputs.releases_created === 'true';
    assert.equal(evalCondition(obligationCond, ctx), releaseOrDispatch, `obligation — ${label}`);
  }
  // A cancelled job dispatches nothing.
  assert.equal(evalCondition(dispatchCond, { event: 'push', failed: false, cancelled: true, steps: PATHS[0][3] }), false);
});

test('the condition evaluator models GitHub\'s implicit success() and refuses what it does not model', () => {
  const ctx = { event: 'push', failed: true, cancelled: false, steps: { a: ok(true) } };
  assert.equal(evalCondition("steps.a.outputs.pushed == 'true'", ctx), false, 'no status function: an earlier failure skips the step');
  assert.equal(evalCondition("!cancelled() && steps.a.outputs.pushed == 'true'", ctx), true);
  assert.equal(evalCondition("!cancelled() && steps.a.outputs.pushed == 'true' && success()", ctx), false);
  assert.throws(() => evalCondition("contains(github.ref, 'main')", ctx), /unmodelled/);
});

test('the dispatch step expects the sha this job last pushed, and authenticates gh with the job token', () => {
  const s = steps(releaseYml()).find((x) => x.text.includes('scripts/dispatch-post-sync-ci.mjs'));
  assert.match(s.text, /^          GH_TOKEN: \$\{\{ github\.token \}\}$/m);
  // A successful push moves the remote-tracking ref and a rejected one does
  // not, so this is the newest sha that actually reached main — or main as
  // checked out when the job pushed nothing. Local HEAD is wrong: after a
  // rejected stage-doc push it names a commit main never received.
  assert.match(s.text, /EXPECT="\$\(git rev-parse --verify refs\/remotes\/origin\/main\)"/);
  assert.match(s.text, /node scripts\/dispatch-post-sync-ci\.mjs --repo "\$GITHUB_REPOSITORY" --ref main --expect-sha "\$EXPECT"/);
});

// ---------------------------------------------------------------------------
// Completeness — the dispatched set is what a push of the sync paths starts
// ---------------------------------------------------------------------------

/** A YAML scalar in the forms these workflows use; anything else throws. */
function scalar(value, file) {
  const m = value.trim().match(/^'([^']*)'$|^"([^"]*)"$|^([^\s'"#,[\]{}]+)$/);
  if (!m) throw new Error(`${file}: unmodelled YAML scalar ${value.trim()}`);
  return m[1] ?? m[2] ?? m[3];
}

/**
 * The on.push trigger of a workflow: null, or { branches, paths }. It reads
 * only the shapes this repository uses and throws on anything else, including
 * a `push:` key it could not place under `on:`, so a workflow it does not
 * model fails the test instead of silently leaving the derived set.
 */
function pushTrigger(yml, file) {
  const on = yml.match(/^on:\n((?:(?:  .*|\s*)\n)+)/m);
  if (!on) throw new Error(`${file}: no block-form on: trigger — extend pushTrigger rather than skip it`);
  const push = on[1].match(/^  push:\n((?:(?:    .*|\s*)\n)*)/m);
  if (!push) {
    if (/^\s*push:/m.test(yml)) throw new Error(`${file}: a push: key outside the on: block this parser read`);
    return null;
  }
  let branches = null;
  let paths = null;
  let inPaths = false;
  for (const line of push[1].split('\n')) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    let m;
    if ((m = line.match(/^    branches: \[(.*)\]\s*$/))) {
      branches = m[1].split(',').map((b) => scalar(b, file));
      inPaths = false;
    } else if (/^    paths:\s*$/.test(line)) {
      paths = [];
      inPaths = true;
    } else if (inPaths && (m = line.match(/^      - (.+)$/))) {
      paths.push(scalar(m[1], file));
    } else {
      throw new Error(`${file}: unmodelled push trigger line "${line.trim()}"`);
    }
  }
  if (!branches) throw new Error(`${file}: push without an inline branches list`);
  return { branches, paths };
}

function globToRegExp(glob) {
  if (/[?[\]!+]/.test(glob)) throw new Error(`unsupported path filter ${glob}`);
  const src = glob.split('**').map((part) => part.split('*').map((s) => s.replace(/[.^$()|{}\\/]/g, '\\$&')).join('[^/]*')).join('.*');
  return new RegExp(`^${src}$`);
}

/** The files the release job's sync commits can touch, read from the job itself. */
function syncPaths(yml) {
  const catalogs = yml.match(/^\s+CATALOGS="([^"]+)"$/m);
  const docs = yml.match(/^\s+DOC_PATHS="([^"]+)"$/m);
  assert.ok(catalogs && docs, 'the two sync path lists');
  return [...catalogs[1].split(' '), ...docs[1].split(' ')];
}

/** The workflows in `dir` that a push of `synced` to main would start. */
function derivePostSyncSet(dir, synced) {
  const expected = [];
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    if (file === RELEASE_WORKFLOW) continue; // the job doing the dispatching
    const trigger = pushTrigger(readFileSync(path.join(dir, file), 'utf8'), file);
    // A branch filter is a glob: `'**'` starts the workflow on main too.
    if (!trigger || !trigger.branches.some((b) => globToRegExp(b).test('main'))) continue;
    if (trigger.paths && !synced.some((p) => trigger.paths.some((g) => globToRegExp(g).test(p)))) continue;
    expected.push(file);
  }
  return expected;
}

test('POST_SYNC_WORKFLOWS is exactly the workflows a push of the sync paths to main would start', () => {
  const expected = derivePostSyncSet(WORKFLOWS_DIR, syncPaths(releaseYml()));
  assert.deepEqual([...POST_SYNC_WORKFLOWS].sort(), expected);
  // Not vacuous, though the real directory no longer shows the path filter at
  // work. It used to, through host-version-drift.yml — a push-to-main workflow
  // whose paths the sync never touches — and ADR-0060 deleted that workflow; no
  // other real one has that shape. The exclusion is proven by `d.yml` in the
  // synthetic case below, which is a push-to-main workflow the derivation must
  // leave out.
  assert.ok(expected.length > 0, 'the derivation read real triggers');
  assert.ok(!expected.includes(RELEASE_WORKFLOW), 'the dispatching job never dispatches itself');
});

test('the derivation reads .yaml files and every quoting form, and refuses shapes it does not model', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'post-sync-workflows-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const wf = (onBlock) => `name: x\n\non:\n${onBlock}  workflow_dispatch:\n\njobs: {}\n`;
  writeFileSync(path.join(dir, 'a.yaml'), wf('  push:\n    branches: [main]\n'));
  writeFileSync(path.join(dir, 'b.yml'), wf('  push:\n    branches: ["main"]\n    paths:\n      # the catalog\n      - ".claude-plugin/marketplace.json"\n'));
  writeFileSync(path.join(dir, 'c.yml'), wf("  push:\n    branches: ['main', release]\n    paths:\n      - docs/ARCHITECTURE.md\n"));
  writeFileSync(path.join(dir, 'd.yml'), wf('  push:\n    branches: [main]\n    paths:\n      - "src/**"\n'));
  writeFileSync(path.join(dir, 'e.yml'), wf('  pull_request:\n'));
  writeFileSync(path.join(dir, 'f.yml'), wf("  push:\n    branches: ['**']\n"));
  writeFileSync(path.join(dir, 'g.yml'), wf("  push:\n    branches: ['release/*']\n"));
  assert.deepEqual(derivePostSyncSet(dir, ['.claude-plugin/marketplace.json', 'docs/ARCHITECTURE.md']), ['a.yaml', 'b.yml', 'c.yml', 'f.yml']);

  const refused = [
    ['a column-0 comment inside on:', 'on:\n  pull_request:\n# note\n  push:\n    branches: [main]\n'],
    ['a list-form branches filter', 'on:\n  push:\n    branches:\n      - main\n'],
    ['an inline comment after a path', "on:\n  push:\n    branches: [main]\n    paths:\n      - 'docs/**' # docs\n"],
    ['a paths-ignore filter', "on:\n  push:\n    branches: [main]\n    paths-ignore:\n      - 'docs/**'\n"],
    ['a flow-form on:', 'on: [push, pull_request]\n'],
  ];
  for (const [label, yml] of refused) assert.throws(() => pushTrigger(yml, label), /unmodelled|outside the on: block|no block-form|inline branches/, label);
});

test('every dispatched workflow accepts workflow_dispatch, or the endpoint answers 422', () => {
  for (const file of POST_SYNC_WORKFLOWS) {
    const on = readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8').match(/^on:\n((?:(?:  .*|\s*)\n)+)/m)[1];
    assert.match(on, /^  workflow_dispatch:/m, file);
  }
});

test('the path-filter matcher reads the filters it is given', () => {
  assert.ok(globToRegExp('plugins/**').test('plugins/runtime/data/x.json'));
  assert.ok(globToRegExp('.claude-plugin/marketplace.json').test('.claude-plugin/marketplace.json'));
  assert.ok(!globToRegExp('.claude-plugin/marketplace.json').test('.claude-plugin/marketplaceXjson'));
  assert.ok(!globToRegExp('docs/*.md').test('docs/adr/x.md'));
  assert.throws(() => globToRegExp('!docs/**'), /unsupported/);
});
