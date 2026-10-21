// ADR-0068 Decision 5, item 4 — verify-select's acceptance is a backtest: on
// a recorded set of this repository's past pull requests, every test that
// failed on a pull request's first CI run is selected by that pull request's
// change. The set is tests/orchestrator/fixtures/verify-select-backtest.json;
// its note says how it was collected and why each change is replayed from
// main's history.
//
// A failing test counts as selected only when a rule selects it: a selection
// of the whole suite proves nothing by itself. The tests no rule can select
// are listed on their entry (fallback_only, with why), and for those the
// change must select the suite. Each entry also holds the size of its rule
// selection when recorded, as a ceiling. Where the failing run's own commit
// is in the clone, its tree is replayed too.
//
// It reads git objects, so it skips with no repository (a mutation copy has
// no .git, and no mutation spec lists this file). In a repository, a merge
// commit the fixture names that is missing is a failure: a shallow clone
// proves nothing. A miss widens verify-select's rules, or records a mapping
// on its entry for the declaration.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as vs from '../../plugins/orchestrator/adapters/claude/autopilot/verify-select.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = JSON.parse(readFileSync(path.join(REPO_ROOT, 'tests/orchestrator/fixtures/verify-select-backtest.json'), 'utf8'));

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const git = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
const hasCommit = (sha) => {
  try { git('cat-file', '-e', `${sha}^{commit}`); return true; } catch { return false; }
};

let repository = null;
try {
  repository = git('rev-parse', '--show-toplevel').trim();
} catch {
  repository = null;
}
const inRepository = repository !== null && path.resolve(repository) === REPO_ROOT;

// The kinds that carry tests (the declaration's test and suite kinds); each
// entry adds the mappings it records.
const DECL = {
  kinds: {
    'test-suite': { slots: [], adds_on: [] },
    test: { slots: [{ name: 'files', type: 'path', repeat: 'many', join: 'words', under: ['tests/', 'companions/tests/', 'kit/'], suffix: '.mjs' }], adds_on: [] },
  },
  mappings: [],
};

// The selection of a change from `base` to `head`, and the tests a rule (not
// the fallback) selected.
function replay(entry, base, head) {
  const changes = vs.collectChanges({ cwd: REPO_ROOT, base, head });
  const tree = vs.gitReader({ cwd: REPO_ROOT, commit: head });
  const r = vs.selectChecks({
    tree, base: vs.gitReader({ cwd: REPO_ROOT, commit: base }), changes,
    declaration: { ...DECL, mappings: entry.mappings ?? [] }, maxListed: Number.MAX_SAFE_INTEGER,
  });
  const byRule = new Set(r.reasons.entries.filter((e) => e.test !== '*').map((e) => e.test));
  return { r, byRule, all: vs.discoverTests(tree).length };
}

function assertCovers(entry, { r, byRule }, label) {
  const fallbackOnly = entry.fallback_only ?? {};
  for (const t of entry.failing_tests) {
    if (Object.hasOwn(fallbackOnly, t)) {
      assert.ok(!byRule.has(t), `#${entry.pr} (${label}): a rule now selects ${t}; drop it from fallback_only`);
      assert.equal(r.tests.suite, true, `#${entry.pr} (${label}): ${t} is selected by no rule, and the change does not select the suite`);
    } else {
      assert.ok(byRule.has(t), `#${entry.pr} (${label}): no rule selects ${t}${r.tests.suite ? ' (only the suite does)' : ''}`);
    }
  }
}

describe('verify-select — the backtest', () => {
  it('records at least eight pull requests, the C150 one (#974) among them', () => {
    assert.equal(FIXTURE.schema, 'verify-select-backtest-1.0');
    assert.ok(FIXTURE.entries.length >= 8, `${FIXTURE.entries.length} entries`);
    const c150 = FIXTURE.entries.find((e) => e.pr === 974);
    assert.ok(c150, '#974 is recorded');
    assert.ok(c150.failing_tests.includes('tests/plugin-shape/test-engineer-autopilot-runbooks.mjs'));
    assert.equal(c150.mappings, undefined, 'the C150 test is selected by the rules alone');
    assert.equal(c150.fallback_only, undefined, 'and not by the fallback');
    for (const e of FIXTURE.entries) {
      assert.match(e.base, /^[0-9a-f]{40}$/);
      assert.match(e.head, /^[0-9a-f]{40}$/);
      assert.ok(e.failing_tests.length > 0, `#${e.pr} names a failing test`);
      assert.ok(Number.isInteger(e.selected) && e.selected > 0, `#${e.pr} records its selection's size`);
      for (const [t, why] of Object.entries(e.fallback_only ?? {})) {
        assert.ok(e.failing_tests.includes(t) && typeof why === 'string' && why !== '', `#${e.pr}: fallback_only ${t} is a failing test, with why`);
      }
    }
    const fallbackOnly = FIXTURE.entries.reduce((n, e) => n + Object.keys(e.fallback_only ?? {}).length, 0);
    const failing = FIXTURE.entries.reduce((n, e) => n + e.failing_tests.length, 0);
    assert.ok(fallbackOnly * 5 <= failing, `${fallbackOnly} of ${failing} failing tests are selected only by the fallback`);
  });

  for (const entry of FIXTURE.entries) {
    it(`#${entry.pr}: a rule selects every test that failed on its first run, or the fallback it records does`, { skip: inRepository ? false : 'no git repository here (a mutation copy): the backtest reads git objects' }, (t) => {
      for (const commit of [entry.base, entry.head]) {
        assert.ok(hasCommit(commit), `commit ${commit} of #${entry.pr} is in this repository`);
      }
      const merge = replay(entry, entry.base, entry.head);
      assertCovers(entry, merge, 'merge');
      assert.ok(merge.byRule.size <= entry.selected, `#${entry.pr}: the rules select ${merge.byRule.size} tests, more than the ${entry.selected} recorded`);
      t.diagnostic(`merge: the rules select ${merge.byRule.size} of ${merge.all} tests${merge.r.tests.suite ? '; the change selects the suite' : ''}`);
      // The first run's own tree, against its fork point, where the clone has it.
      if (entry.run_sha && hasCommit(entry.run_sha)) {
        const fork = git('merge-base', entry.run_sha, entry.head).trim();
        const run = replay(entry, fork, entry.run_sha);
        assertCovers(entry, run, 'first run');
        t.diagnostic(`first run: the rules select ${run.byRule.size} of ${run.all} tests${run.r.tests.suite ? '; the change selects the suite' : ''}`);
      } else {
        t.diagnostic('first run: its commit is not in this clone; the merge alone is replayed');
      }
    });
  }
});
