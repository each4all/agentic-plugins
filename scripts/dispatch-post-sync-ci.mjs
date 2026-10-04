#!/usr/bin/env node
// Dispatches the push-to-main test workflows on main after the release job's
// catalog sync push, and records which commit each dispatched run validates.
//
// Why: the release job's catalog sync commit is pushed with GITHUB_TOKEN, and
// a push authenticated with GITHUB_TOKEN creates no workflow run. So post-sync
// main never had a CI run of its own, and the only run near a
// release was the release commit's, which reads the catalogs BEFORE the sync
// and fails on the lag (11 of 11 release commits from 2026-09-09 to 2026-09-27,
// docket C58). GitHub documents workflow_dispatch and repository_dispatch as
// the exceptions: a dispatch made with GITHUB_TOKEN does create a run. The
// endpoint needs `actions: write`.
//
// What a dispatched run validates: main as it stood when GitHub created the
// run. That is post-sync main, not the release commit. The release commit's
// own run stays red on the catalog lag, and it is not re-run: its tree really
// does trail the manifest.
//
// Main can move. workflow_dispatch takes a branch, not a commit, so a run gets
// whatever main's head is when GitHub creates it. Each run's head_sha is read
// back and compared with --expect-sha, the newest commit the job pushed (or
// main as the job checked it out, when it pushed nothing):
//   - equal: the run validates exactly the post-sync commit;
//   - a descendant: main advanced before the run was created. The run still
//     validates a tree that contains the sync, so it is accepted and reported
//     as a warning; the intended commit itself has no run of its own;
//   - anything else (behind, diverged, or the ancestry cannot be checked):
//     the step fails, because the run does not validate the sync at all.
// A run that was dispatched but whose id or head_sha cannot be read also
// fails the step: the run may be fine, but what it validates is unrecorded.
// Reading a run back is retried a few times, since the dispatch response does
// not promise the run is readable at once; the dispatch itself is never
// retried, because a POST that timed out may still have created a run.
//
// Every workflow is dispatched even when an earlier one fails, and the exit
// code reports all of them. Each gh call is bounded (--gh-timeout-ms), so a
// stalled call cannot hold the step until the release job's time limit. Runs
// are not awaited; each reports on its own.
//
// validate.yml compares no baseline on a dispatch (it has no before-sha).
// The monotonic-pin check against the pre-sync catalog is done by
// scripts/sync-marketplace-versions.mjs before the push.
//
// Usage:
//   node scripts/dispatch-post-sync-ci.mjs --repo <owner/name> --expect-sha <40-hex>
//                                          [--ref main] [--gh-timeout-ms 30000]
// Needs `gh` on PATH, authenticated (GH_TOKEN in CI).
//
// Exit codes:
//   0 — every workflow dispatched, and every run validates --expect-sha or a
//       descendant of it
//   1 — any dispatch, read-back or ancestry check failed
//   2 — usage error (nothing dispatched)

import { execFileSync } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// The workflows a push of the sync paths to main would start.
// tests/scripts/test-dispatch-post-sync-ci.mjs derives that set from the
// workflow files and fails when this list drifts from it.
export const POST_SYNC_WORKFLOWS = [
  'full-tests.yml',
  'validate.yml',
];

const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// Delays before the 2nd and 3rd read of a dispatched run.
const RUN_READ_DELAYS_MS = [2000, 5000];
const short = (sha) => (typeof sha === 'string' ? sha.slice(0, 7) : String(sha));
const message = (err) => (err?.message ?? String(err)).trim().split('\n')[0];
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Dispatch each workflow on `ref` and classify its run against `expectSha`.
 * `api(route, { method, fields })` returns the parsed JSON response ({} when
 * empty) and throws on an HTTP error.
 */
export function dispatchPostSyncCi({
  api, repo, ref, expectSha, workflows = POST_SYNC_WORKFLOWS,
  sleep = sleepSync, runReadDelaysMs = RUN_READ_DELAYS_MS,
}) {
  const results = workflows.map((workflow) => {
    const result = { workflow, ok: false, runId: null, htmlUrl: null, headSha: null, detail: '' };
    let dispatched;
    try {
      dispatched = api(`repos/${repo}/actions/workflows/${workflow}/dispatches`, {
        method: 'POST',
        fields: { ref, return_run_details: true },
      });
    } catch (err) {
      return { ...result, outcome: 'dispatch-failed', detail: message(err) };
    }
    const runId = dispatched?.workflow_run_id;
    if (!Number.isInteger(runId)) {
      return { ...result, outcome: 'no-run-id', detail: 'GitHub answered without a workflow_run_id' };
    }
    result.runId = runId;
    result.htmlUrl = dispatched.html_url ?? null;
    let runInfo;
    let lastError = '';
    for (let attempt = 0; attempt <= runReadDelaysMs.length; attempt += 1) {
      if (attempt > 0) sleep(runReadDelaysMs[attempt - 1]);
      try {
        const got = api(`repos/${repo}/actions/runs/${runId}`, {});
        if (SHA.test(got?.head_sha ?? '')) {
          runInfo = got;
          break;
        }
        lastError = 'the run has no head_sha';
      } catch (err) {
        lastError = message(err);
      }
    }
    if (!runInfo) {
      return { ...result, outcome: 'run-read-failed', detail: `${lastError} (${runReadDelaysMs.length + 1} attempts)` };
    }
    result.headSha = runInfo.head_sha;
    result.htmlUrl = runInfo.html_url ?? result.htmlUrl;
    if (result.headSha === expectSha) return { ...result, ok: true, outcome: 'validated' };
    let cmp;
    try {
      cmp = api(`repos/${repo}/compare/${expectSha}...${result.headSha}`, {});
    } catch (err) {
      return { ...result, outcome: 'compare-failed', detail: message(err) };
    }
    if (cmp?.status === 'ahead') {
      return { ...result, ok: true, outcome: 'advanced', detail: `${cmp.ahead_by ?? '?'} commit(s) ahead` };
    }
    return { ...result, outcome: 'not-descendant', detail: String(cmp?.status ?? 'unknown') };
  });
  return { repo, ref, expectSha, results, ok: results.every((r) => r.ok) };
}

/** Human lines (with an annotation level) and a step-summary table. */
export function renderReport({ ref, expectSha, results }) {
  const lines = [
    { level: 'info', text: `Intended post-sync sha: ${expectSha}` },
    { level: 'info', text: `These runs validate post-sync main, not the release commit, whose own run read the catalogs before the sync.` },
  ];
  const rows = [];
  for (const r of results) {
    const where = r.htmlUrl ? ` ${r.htmlUrl}` : '';
    let level = 'error';
    let text;
    switch (r.outcome) {
      case 'validated':
        level = 'info';
        text = `run ${r.runId} validates ${r.headSha} (the intended post-sync sha)`;
        break;
      case 'advanced':
        level = 'warning';
        text = `run ${r.runId} validates ${r.headSha}, ${r.detail} of the intended ${short(expectSha)} — main advanced before GitHub created the run, so the intended sha has no run of its own`;
        break;
      case 'not-descendant':
        text = `run ${r.runId} got ${r.headSha}, which is ${r.detail} relative to the intended ${short(expectSha)} — it does not validate the sync`;
        break;
      case 'compare-failed':
        text = `run ${r.runId} got ${r.headSha}, and its ancestry to ${short(expectSha)} could not be checked: ${r.detail}`;
        break;
      case 'run-read-failed':
        text = `run ${r.runId} was dispatched, but it could not be read back: ${r.detail}`;
        break;
      case 'no-run-id':
        text = `dispatched on ${ref}, but GitHub returned no run id, so what the run validates is unrecorded`;
        break;
      default:
        text = `dispatch failed: ${r.detail}`;
    }
    lines.push({ level, text: `${r.workflow}: ${text}${where}` });
    rows.push(`| ${r.workflow} | ${r.runId ? (r.htmlUrl ? `[${r.runId}](${r.htmlUrl})` : r.runId) : '—'} | ${r.headSha ? `\`${r.headSha}\`` : '—'} | ${r.outcome} |`);
  }
  const markdown = [
    '### Post-sync CI dispatch',
    '',
    `Intended post-sync sha: \`${expectSha}\`. These runs validate post-sync main, not the release commit.`,
    '',
    '| Workflow | Run | head_sha | Outcome |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
  return { lines, markdown };
}

/** `gh api` as the api() the dispatcher takes, each call bounded by `timeoutMs`. */
export function makeGhApi({ timeoutMs }) {
  return (route, { method = 'GET', fields = {} } = {}) => {
    const args = ['api', '--method', method, route];
    for (const [k, v] of Object.entries(fields)) {
      // -F sends a typed value (true is a boolean), -f always a string.
      args.push(typeof v === 'string' ? '-f' : '-F', `${k}=${v}`);
    }
    let out;
    try {
      out = execFileSync('gh', args, {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs,
      });
    } catch (err) {
      // execFileSync's own message is "Command failed: <argv>"; GitHub's
      // reason (the HTTP status and message) is only on gh's stderr.
      const why = err.code === 'ETIMEDOUT'
        ? `timed out after ${timeoutMs}ms`
        : (String(err.stderr ?? '').trim().split('\n').filter(Boolean).join(' / ') || message(err));
      throw new Error(`gh api ${method} ${route}: ${why}`);
    }
    return out.trim() === '' ? {} : JSON.parse(out);
  };
}

// A workflow command's data must escape %, CR and LF, or the annotation is cut short.
const escapeData = (text) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

function usage(msg) {
  console.error(`dispatch-post-sync-ci: ${msg}`);
  console.error('Usage: node scripts/dispatch-post-sync-ci.mjs --repo <owner/name> --expect-sha <40-hex> [--ref main] [--gh-timeout-ms 30000]');
  process.exit(2);
}

const invokedAsCLI = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedAsCLI) {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        repo: { type: 'string' },
        ref: { type: 'string', default: 'main' },
        'expect-sha': { type: 'string' },
        'gh-timeout-ms': { type: 'string', default: '30000' },
      },
      strict: true,
    }));
  } catch (err) {
    usage(message(err));
  }
  if (!REPO.test(values.repo ?? '')) usage('--repo must be <owner>/<name>');
  if (!SHA.test(values['expect-sha'] ?? '')) usage('--expect-sha must be a full 40-character sha');
  if (!values.ref) usage('--ref must name a branch');
  const timeoutMs = Number(values['gh-timeout-ms']);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) usage('--gh-timeout-ms must be a positive integer');

  const summary = dispatchPostSyncCi({
    api: makeGhApi({ timeoutMs }), repo: values.repo, ref: values.ref, expectSha: values['expect-sha'],
  });
  const report = renderReport(summary);
  const onActions = process.env.GITHUB_ACTIONS === 'true';
  for (const { level, text } of report.lines) {
    console.log(onActions && level !== 'info' ? `::${level}::${escapeData(text)}` : text);
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report.markdown);
  process.exit(summary.ok ? 0 : 1);
}
