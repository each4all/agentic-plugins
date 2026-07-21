// ADR-0047 §7 runtime:retention CLI — the operator surface over the read-only
// planner (retention-planner.mjs) and the M1 deleting executor
// (retention-apply.mjs). Three subcommands:
//   plan     — read-only: recompute the retention plan and print the actionable/
//              pinned split + the plan hash the operator reviews before apply.
//   apply    — dry-run by DEFAULT (ADR-0035 §3 invariant 1); deletes only with an
//              explicit --execute and the reviewed --expected-plan-hash.
//   resolve  — close an open write-ahead receipt (re-inventory started targets).
//
// The CLI never deletes on its own; all deletion is inside applyRetention behind
// its containment + no-follow + receipt + lock + plan-hash safety layers.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RETENTION_FAMILIES, planRetention, projectRetentionAttention } from './lib/retention-planner.mjs';
import { applyRetention, resolveOpenReceipt, computeExpectedHashHex, RETENTION_APPLY_VERSIONS } from './lib/retention-apply.mjs';
import { resolveRepoRoot } from './notify.mjs';

function parseArgs(argv) {
  const opts = { command: null, family: null, format: 'text', execute: false, expectedPlanHash: null, repoRoot: null };
  const rest = argv.slice();
  opts.command = rest.shift() ?? null;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--execute') opts.execute = true;
    else if (arg === '--format') opts.format = rest[++i];
    else if (arg.startsWith('--format=')) opts.format = arg.slice('--format='.length);
    else if (arg === '--family') opts.family = rest[++i];
    else if (arg.startsWith('--family=')) opts.family = arg.slice('--family='.length);
    else if (arg === '--repo-root') opts.repoRoot = rest[++i];
    else if (arg.startsWith('--repo-root=')) opts.repoRoot = arg.slice('--repo-root='.length);
    else if (arg === '--expected-plan-hash') opts.expectedPlanHash = rest[++i];
    else if (arg.startsWith('--expected-plan-hash=')) opts.expectedPlanHash = arg.slice('--expected-plan-hash='.length);
    else return { ok: false, reason: `unknown argument: ${arg}` };
  }
  if (!['plan', 'apply', 'resolve'].includes(opts.command)) {
    return { ok: false, reason: `unknown subcommand: ${opts.command ?? '(none)'} (expected plan|apply|resolve)` };
  }
  if ((opts.command === 'apply' || opts.command === 'resolve') && !opts.family) {
    return { ok: false, reason: `${opts.command} requires --family=<${RETENTION_FAMILIES.join('|')}>` };
  }
  if (opts.family && !RETENTION_FAMILIES.includes(opts.family)) {
    return { ok: false, reason: `unknown family: ${opts.family} (v1: ${RETENTION_FAMILIES.join(', ')})` };
  }
  if (!['text', 'json'].includes(opts.format)) {
    return { ok: false, reason: `unknown format: ${opts.format}` };
  }
  return { ok: true, opts };
}

function renderPlanText(plan, projection) {
  const lines = [];
  lines.push(`runtime:retention plan — read-only (deletes nothing)`);
  lines.push(`- versions: planner=${RETENTION_APPLY_VERSIONS.planner}; scanner=${RETENTION_APPLY_VERSIONS.scanner}`);
  lines.push(`- scan_complete: ${plan.scan_complete}; plan_hash: ${plan.plan_hash}`);
  if (!plan.scan_complete) {
    for (const reason of plan.scan_incomplete_reasons) {
      lines.push(`  scan-incomplete: ${reason.source}${reason.family ? `/${reason.family}` : ''} — ${reason.reason}`);
    }
    lines.push('- NOTE: an incomplete scan withholds all deletion (an unscannable source is treated as citing everything).');
  }
  for (const family of RETENTION_FAMILIES) {
    const f = projection.families[family];
    if (!f) continue;
    lines.push(`- ${family}: runs=${f.run_count}; pinned=${f.pinned_count}; over-cap=${f.over_cap}; actionable=${f.actionable}; pinned-overage=${f.pinned_overage}; withheld-too-young=${f.withheld_too_young}`);
    const deletable = plan.families[family]?.actionable_excess ?? [];
    for (const runId of deletable) lines.push(`    actionable: ${runId}`);
  }
  lines.push('- To delete: runtime:retention apply --family=<f> --expected-plan-hash=<hash> --execute');
  return lines.join('\n');
}

function renderApplyText(result) {
  const lines = [];
  if (result.status === 'dry-run') {
    lines.push(`runtime:retention apply (DRY-RUN) — family=${result.family}; plan_hash=${result.plan_hash}`);
    lines.push(`- would delete ${result.would_delete.length} of ${result.candidate_count} candidate(s) (ceilings: deletions=${result.ceilings.maxDeletions}, bytes=${result.ceilings.maxBytes}, elapsed-ms=${result.ceilings.maxElapsedMs}):`);
    for (const runId of result.would_delete) lines.push(`    ${runId}`);
    lines.push('- Re-run with --execute AND --expected-plan-hash to delete.');
  } else if (result.status === 'applied') {
    lines.push(`runtime:retention apply (EXECUTED) — family=${result.family}; plan_hash=${result.plan_hash}`);
    lines.push(`- deleted: ${result.deleted.length}; conceded: ${result.conceded.length}; failed: ${result.failed.length}; receipt-open: ${result.receipt_open}`);
    for (const runId of result.deleted) lines.push(`    deleted: ${runId}`);
    for (const c of result.conceded) lines.push(`    conceded: ${c.run_id} (${c.reason})`);
    for (const fld of result.failed) lines.push(`    failed: ${fld.run_id} (${fld.reason})`);
  } else if (result.status === 'refused') {
    lines.push(`runtime:retention apply REFUSED — family=${result.family}; reason=${result.reason}`);
    if (result.reason === 'plan-hash-mismatch') {
      lines.push(`- expected (reviewed): ${result.expected_plan_hash}`);
      lines.push(`- recomputed (now):    ${result.recomputed_plan_hash}`);
      lines.push('- The plan drifted (new citations/runs/pins/caps). Re-review the plan and re-run with the new hash.');
    } else if (result.reason === 'scan-incomplete') {
      lines.push('- The pin scan could not complete; deletion is withheld. Inspect scan_incomplete_reasons.');
    }
  } else if (result.status === 'blocked') {
    lines.push(`runtime:retention apply BLOCKED — family=${result.family}; reason=${result.reason}`);
    if (result.reason === 'open-receipt') lines.push('- A prior apply left an open receipt. Run: runtime:retention resolve --family=<f>');
  }
  return lines.join('\n');
}

export async function runRetentionCli(argv, { cwd = process.cwd() } = {}) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const opts = parsed.opts;
  const repoRoot = resolveRepoRoot({ cwd, explicit: opts.repoRoot });
  if (!repoRoot) return { ok: false, reason: 'no repository root (.git) found — pass --repo-root' };

  if (opts.command === 'plan') {
    const plan = await planRetention({ repoRoot, now: new Date() });
    const projection = projectRetentionAttention(plan);
    const output = opts.format === 'json' ? JSON.stringify({ plan, projection }, null, 2) : renderPlanText(plan, projection);
    return { ok: true, output };
  }

  if (opts.command === 'apply') {
    const expected = opts.expectedPlanHash !== null ? computeExpectedHashHex(opts.expectedPlanHash) : null;
    if (opts.expectedPlanHash !== null && expected === null) {
      return { ok: false, reason: 'invalid --expected-plan-hash (expected sha256:<64hex> or <64hex>)' };
    }
    // Execute REQUIRES an explicit reviewed plan hash — a bare --execute without
    // it could delete against an unreviewed plan.
    if (opts.execute && expected === null) {
      return { ok: false, reason: '--execute requires --expected-plan-hash=<reviewed hash> (ADR-0047 §7 plan-hash binding)' };
    }
    const result = await applyRetention({
      repoRoot, family: opts.family, expectedPlanHash: expected, execute: opts.execute, now: new Date(),
    });
    const output = opts.format === 'json' ? JSON.stringify(result, null, 2) : renderApplyText(result);
    const ok = result.status === 'dry-run' || result.status === 'applied';
    return { ok, output, result };
  }

  // resolve
  const result = await resolveOpenReceipt({ repoRoot, family: opts.family, now: new Date() });
  const output = opts.format === 'json' ? JSON.stringify(result, null, 2) : `runtime:retention resolve — family=${result.family}; status=${result.status}`;
  return { ok: true, output, result };
}

async function main(argv) {
  const res = await runRetentionCli(argv);
  if (!res.ok && res.reason) {
    process.stderr.write(`runtime:retention: ${res.reason}\n`);
    process.stderr.write('usage: retention.mjs plan|apply|resolve [--family <f>] [--expected-plan-hash <h>] [--execute] [--format text|json] [--repo-root <path>]\n');
    process.exitCode = 1;
    return;
  }
  if (res.output) process.stdout.write(`${res.output}\n`);
  // A refused/blocked apply is a non-zero exit so scripts can gate on it.
  if (res.result && (res.result.status === 'refused' || res.result.status === 'blocked')) process.exitCode = 2;
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  (async () => {
    try {
      await main(process.argv.slice(2));
    } catch (err) {
      process.stderr.write(`runtime:retention failed: ${err?.stack ?? err?.message ?? err}\n`);
      process.exitCode = 1;
    }
  })();
}
