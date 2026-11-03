// tests/orchestrator/test-autopilot-verify-mutate-timeout.mjs
//
// C170 — the repository's `mutate` check (.agentic-plugins/verify-checks.json)
// carries the mutation harness's per-run timeout to the harness, sized
// against the whole check (ADR-0068 Decision 5, items 3 and 9).
//
// Without a `--timeout` in the declared argv the harness falls back to its
// 900 s default (scripts/mutation-harness.mjs), and a spec whose unmutated
// control runs longer ends TIMEOUT, with no verdict, on every driver run.
//
// Covers:
//   - the declaration resolved through the driver's own parser
//     (verify-decl.mjs) and the persona's (persona-pipeline/files/scripts/lib/
//     verify.mjs) gives one argv, and the harness reads from it the declared
//     per-run timeout, above the default, whatever MUTATION_HARNESS_TIMEOUT
//     the environment holds;
//   - the sizing: the control and the largest number of cases AGENTS.md
//     allows, each at the per-run timeout, plus the margin kept for copies,
//     cleanup and the heavy-work lock, fit the check's timeout_s, which fits
//     the driver's batch bound; one case more would not;
//   - AGENTS.md states the same per-run timeout, timeout_s, margin and case
//     limit.
//
// It proves the transport, not the length: no control here runs past 900 s.
//
// Run via `node --test tests/orchestrator/test-autopilot-verify-mutate-timeout.mjs`.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const D = await import(join(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/verify-decl.mjs'));
const P = await import(join(REPO_ROOT, 'persona-pipeline/files/scripts/lib/verify.mjs'));
const H = await import(join(REPO_ROOT, 'scripts/mutation-harness.mjs'));
const { BOUNDS } = await import(join(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/verify-run.mjs'));

const DECLARATION_TEXT = readFileSync(join(REPO_ROOT, D.VERIFY_DECLARATION_PATH), 'utf8');
const AGENTS_TEXT = readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf8');
const NPM_PREFIX = ['npm', 'run', 'mutate', '--'];

// The seconds AGENTS.md keeps, inside timeout_s, for the disposable copies,
// their cleanup and the wait for the heavy-work lock.
const MARGIN_S = 1800;

const SPEC = 'scripts/mutation-specs/verify-exec.mjs';
const CHECK = { kind: 'mutate', args: { spec: SPEC, ids: ['C1', 'C2'] } };

// The harness options the declared argv gives, read as `npm run mutate` hands
// them on: the words after npm's `--`, to the script package.json names.
function harnessOptions(argv) {
  deepStrictEqual(argv.slice(0, NPM_PREFIX.length), NPM_PREFIX, 'the mutate check runs the npm script, its words after --');
  return H.parseArgs(argv.slice(NPM_PREFIX.length));
}

function perRunTimeout(decl) {
  const argv = D.resolveCheck(decl, CHECK, { tree: REPO_ROOT });
  const opts = harnessOptions(argv);
  ok(opts.timeout !== undefined, `the mutate check's argv ${JSON.stringify(argv)} passes the harness no --timeout, so every run of it falls back to ${H.DEFAULT_TIMEOUT_SECONDS} s`);
  return H.parseTimeoutSeconds(opts.timeout, '--timeout');
}

// The paragraph of AGENTS.md about the driver's mutate check, its words on
// one line.
function agentsParagraph() {
  const start = AGENTS_TEXT.indexOf('**A `mutate` check handed to the autopilot driver**');
  ok(start >= 0, 'AGENTS.md has the paragraph on the driver\'s mutate check');
  const end = AGENTS_TEXT.indexOf('\n- ', start);
  return AGENTS_TEXT.slice(start, end < 0 ? undefined : end).replace(/\s+/g, ' ');
}

describe('the repository\'s mutate check carries the harness timeout (C170)', () => {
  const decl = D.parseDeclaration(DECLARATION_TEXT);

  it('both parsers resolve one argv, and the harness reads the declared timeout from it', () => {
    const driver = D.resolveCheck(decl, CHECK, { tree: REPO_ROOT });
    const persona = P.resolveCheck(P.parseDeclaration(DECLARATION_TEXT), CHECK, { tree: REPO_ROOT });
    deepStrictEqual(persona, driver);
    const opts = harnessOptions(driver);
    strictEqual(opts.spec, SPEC);
    deepStrictEqual(opts.only, ['C1', 'C2']);
    const seconds = perRunTimeout(decl);
    ok(seconds > H.DEFAULT_TIMEOUT_SECONDS, `the per-run timeout ${seconds} s raises the harness default ${H.DEFAULT_TIMEOUT_SECONDS} s`);
    // The flag outranks the environment: the timeout reaches the harness from
    // the argv, not from a variable the driver's environment may or may not hold.
    strictEqual(H.resolveTimeoutSeconds(opts.timeout, { [H.TIMEOUT_ENV]: '60' }), seconds);
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    strictEqual(pkg.scripts.mutate, 'node scripts/mutation-harness.mjs');
  });

  it('the control and the cases AGENTS.md allows, with its margin, fit the check and the batch', () => {
    const seconds = perRunTimeout(decl);
    const total = decl.kinds.mutate.timeout_s;
    const limit = Number(/at most (\d+) case ids/.exec(agentsParagraph())?.[1]);
    ok(Number.isInteger(limit) && limit >= 1, 'AGENTS.md names how many case ids one mutate check may name');
    ok((limit + 1) * seconds + MARGIN_S <= total,
      `the control and ${limit} cases at ${seconds} s each, with ${MARGIN_S} s kept, need ${(limit + 1) * seconds + MARGIN_S} s; the check has ${total} s`);
    ok((limit + 2) * seconds + MARGIN_S > total, `${limit + 1} cases would fit too: AGENTS.md understates the limit`);
    ok(total * BOUNDS.secondMs <= BOUNDS.batchMs, 'one mutate check fits the driver\'s batch bound');
  });

  it('AGENTS.md states the declared timeouts and the margin', () => {
    const text = agentsParagraph();
    const seconds = perRunTimeout(decl);
    ok(text.includes(`\`--timeout ${seconds}\``), `AGENTS.md names --timeout ${seconds}: ${text}`);
    ok(text.includes(`\`timeout_s\` of ${decl.kinds.mutate.timeout_s} seconds`), `AGENTS.md names timeout_s ${decl.kinds.mutate.timeout_s}`);
    ok(text.includes(`keeps ${MARGIN_S} seconds`), `AGENTS.md names the ${MARGIN_S} s margin`);
  });
});
