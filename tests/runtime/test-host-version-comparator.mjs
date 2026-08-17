// The packaged host-version comparator — ADR-0053 §Decision 10, ADR-0054 §Decision 7.
//
// Two things are under test, and they fail in different ways:
//
//   - the COMPARISON itself, where the failure is a wrong order or a false
//     `exact` — and where the two defects this module was written to remove
//     were both false-EQUAL, never false-different;
//   - the SINGLE-SOURCING, where the failure is invisible to any assertion
//     about one implementation because it is two implementations agreeing
//     today and drifting tomorrow. That half is pinned by identity, not by
//     comparing outputs.
//
// The direction table below is ADR-0054's, reproduced as executable rows
// rather than prose, including the two rows the ADR recorded as defects.

import { describe, it } from 'node:test';
import { ok, strictEqual, deepStrictEqual, notStrictEqual } from 'node:assert/strict';

import {
  HOST_PAIR_RELATION_STATES,
  VERSION_RELATION_STATES,
  classifyHostPairRelation,
  classifyVersionRelation,
  compareReleaseCore,
  normalizeVersion,
  releaseCoreParts,
  releaseVersion,
} from '../../plugins/runtime/scripts/lib/host-parity-baseline.mjs';

describe('packaged comparator — the ADR-0054 direction table, executed', () => {
  // Columns: observed, reviewed, expected state, expected exact.
  // The first eight rows are the ADR's table verbatim. The last two are the
  // rows it recorded as DEFECTS of the pre-existing readers, and they are the
  // reason this module exists rather than a re-export of the CI helper.
  const TABLE = [
    ['2.1.233', '2.1.233', 'exact', true],
    ['2.1.234', '2.1.233', 'ahead', false],
    ['2.1.232', '2.1.233', 'behind', false],
    ['0.147.0-rc.1', '0.147.0', 'same-precedence-nonexact', false],
    ['2.1', '2.1.0', 'same-precedence-nonexact', false],
    ['0.147.0+build.5', '0.147.0+build.9', 'same-precedence-nonexact', false],
    ['01.2.3', '1.2.3', 'same-precedence-nonexact', false],
    ['banana', '2.1.233', 'unparseable', false],
    // ADR-0054's "false-exact" row: `SEMVER_RE` takes the first three
    // components, so `normalizeVersion` reports `1.2.3` and the old readers
    // called this EXACTLY equal to a genuine `1.2.3`.
    ['1.2.3.4', '1.2.3', 'unparseable', false],
    // And the row `Number.parseInt` collapsed: two distinct twenty-digit
    // majors landed on one float and compared equal.
    ['99999999999999999999.0.0', '99999999999999999998.0.0', 'ahead', false],
  ];

  for (const [observed, reviewed, state, exact] of TABLE) {
    it(`${observed} vs ${reviewed} → ${state}`, () => {
      const result = classifyVersionRelation({ observed, reviewed });
      strictEqual(result.state, state);
      strictEqual(result.exact, exact);
      ok(VERSION_RELATION_STATES.includes(result.state), 'the state is in the declared vocabulary');
    });
  }

  it('is SYMMETRIC in direction — every ahead row is a behind row reversed', () => {
    // Guards the easy transposition: a comparator that returned the sign of
    // (reviewed - observed) would pass every `exact` and
    // `same-precedence-nonexact` row above and invert only these two.
    for (const [observed, reviewed, state] of TABLE) {
      if (state !== 'ahead' && state !== 'behind') continue;
      const forward = classifyVersionRelation({ observed, reviewed }).state;
      const reverse = classifyVersionRelation({ observed: reviewed, reviewed: observed }).state;
      strictEqual(reverse, forward === 'ahead' ? 'behind' : 'ahead', `${observed} vs ${reviewed}`);
    }
  });

  it('`ahead` means the OBSERVED machine is ahead, not the reviewed baseline', () => {
    // ADR-0054 §Decision 7 fixes the direction of the word. Stated as its own
    // case because the symmetry test above passes under either convention.
    strictEqual(classifyVersionRelation({ observed: '2.1.234', reviewed: '2.1.233' }).state, 'ahead');
    strictEqual(compareReleaseCore('2.1.234', '2.1.233'), 1);
  });
});

describe('packaged comparator — ordering is exact at every magnitude', () => {
  it('returns a SIGN, never a difference', () => {
    // `lib/semver.mjs`'s `semverCompare` returns a difference, which is where a
    // twenty-digit major loses precision. Every result here is one of three
    // values regardless of how far apart the inputs are.
    for (const [a, b] of [['1.0.0', '1.0.0'], ['2.0.0', '1.0.0'], ['1.0.0', '2.0.0'], ['999999999999.0.0', '1.0.0']]) {
      ok([-1, 0, 1].includes(compareReleaseCore(a, b)), `${a} vs ${b}`);
    }
  });

  it('orders components of DIFFERENT digit lengths by magnitude, not lexically', () => {
    // The trap in a digit-string comparison: `"9" < "10"` lexically but 9 < 10
    // numerically, and only one of those is right.
    strictEqual(compareReleaseCore('1.10.0', '1.9.0'), 1, '10 > 9');
    strictEqual(compareReleaseCore('1.9.0', '1.10.0'), -1);
    strictEqual(compareReleaseCore('100.0.0', '99.0.0'), 1);
    strictEqual(compareReleaseCore('2.1.100', '2.1.99'), 1);
  });

  it('treats leading zeros as the same number', () => {
    strictEqual(compareReleaseCore('01.02.03', '1.2.3'), 0);
    deepStrictEqual(releaseCoreParts('01.02.03'), ['1', '2', '3']);
    deepStrictEqual(releaseCoreParts('0.0.0'), ['0', '0', '0'], 'a zero component survives the strip');
  });

  it('pads a two-component version rather than refusing it', () => {
    // The grammar is deliberately permissive about the core because it reads
    // observed CLI text, not a manifest.
    deepStrictEqual(releaseCoreParts('2.1'), ['2', '1', '0']);
    strictEqual(compareReleaseCore('2.1', '2.1.0'), 0);
  });

  it('is null when either side is not a version', () => {
    strictEqual(compareReleaseCore('banana', '1.0.0'), null);
    strictEqual(compareReleaseCore('1.0.0', ''), null);
    strictEqual(compareReleaseCore(null, undefined), null);
    strictEqual(releaseCoreParts('banana'), null);
  });
});

describe('packaged comparator — the truncation refusal', () => {
  it('refuses a four-or-more-component version instead of silently dropping the tail', () => {
    // The defect, stated as the sequence that produces it: `SEMVER_RE` matches
    // `1.2.3` inside `1.2.3.4`, so the identity form reports `1.2.3` and any
    // comparison built on it calls the two EXACTLY equal.
    strictEqual(normalizeVersion('1.2.3.4'), '1.2.3', 'the identity form is UNCHANGED — §Decision 1');
    strictEqual(releaseVersion('1.2.3.4'), '1.2.3', 'and so is the comparison form');
    // The refusal lives in the comparator, which is what every comparison now
    // goes through.
    strictEqual(releaseCoreParts('1.2.3.4'), null);
    strictEqual(compareReleaseCore('1.2.3.4', '1.2.3'), null);
    strictEqual(classifyVersionRelation({ observed: '1.2.3.4', reviewed: '1.2.3' }).state, 'unparseable');
    strictEqual(releaseCoreParts('1.2.3.4.5'), null, 'and any longer run');
  });

  it('CONTROL: does NOT flag the labelled forms real baselines and registries carry', () => {
    // The over-correction this refusal invites. Every string below is one this
    // repository's own baseline, drift checker, or release feeds actually
    // produce, and each must still compare.
    for (const input of [
      '2.1.197 (Claude Code)',
      'codex-cli 0.142.4',
      'rust-v0.137.0',
      'v2.1.226',
      '0.147.0-rc.1',
      '0.147.0+build.5',
      '0.147.0-rc.1+build.5',
      '2.1.233',
      '2.1',
    ]) {
      notStrictEqual(releaseCoreParts(input), null, `${input} must remain comparable`);
    }
  });

  it('CONTROL: a dot that is not followed by a DIGIT is not a truncation', () => {
    // The detector keys on `.<digit>`, so ordinary prose after a version is not
    // mistaken for a dropped component.
    notStrictEqual(releaseCoreParts('2.1.233. See the note below.'), null);
    notStrictEqual(releaseCoreParts('2.1.233.beta'), null);
  });
});

describe('packaged comparator — the host PAIR vocabulary', () => {
  const pair = (co, cr, xo, xr) => classifyHostPairRelation({
    observed: { claude: co, codex: xo },
    reviewed: { claude: cr, codex: xr },
  });

  it('mixed-direction when one host is ahead and the other behind', () => {
    // The state that exists because no single direction word is true of the
    // pair, and an operator action assuming one would be wrong for the other.
    const result = pair('2.1.234', '2.1.233', '0.146.0', '0.147.0');
    strictEqual(result.state, 'mixed-direction');
    strictEqual(result.hosts.claude.state, 'ahead');
    strictEqual(result.hosts.codex.state, 'behind');
    ok(HOST_PAIR_RELATION_STATES.includes(result.state));
  });

  it('agrees with its own halves when they agree with each other', () => {
    strictEqual(pair('2.1.233', '2.1.233', '0.147.0', '0.147.0').state, 'exact');
    strictEqual(pair('2.1.234', '2.1.233', '0.148.0', '0.147.0').state, 'ahead');
    strictEqual(pair('2.1.232', '2.1.233', '0.146.0', '0.147.0').state, 'behind');
  });

  it('one exact host does not dilute the other host\'s direction', () => {
    strictEqual(pair('2.1.234', '2.1.233', '0.147.0', '0.147.0').state, 'ahead');
    strictEqual(pair('2.1.233', '2.1.233', '0.146.0', '0.147.0').state, 'behind');
  });

  it('same-precedence-nonexact outranks exact but not a real direction', () => {
    strictEqual(pair('2.1.233', '2.1.233', '0.147.0-rc.1', '0.147.0').state, 'same-precedence-nonexact');
    strictEqual(pair('2.1.234', '2.1.233', '0.147.0-rc.1', '0.147.0').state, 'ahead');
  });

  it('UNKNOWN outranks everything — a half-known pair is not a verdict', () => {
    // Fail-closed: a pair computed from one readable host is a guess about the
    // other, and this plane exists to refuse guesses.
    strictEqual(pair('banana', '2.1.233', '0.148.0', '0.147.0').state, 'unparseable');
    strictEqual(pair('2.1.233', '2.1.233', 'potato', '0.147.0').state, 'unparseable');
    strictEqual(pair('1.2.3.4', '1.2.3', '0.147.0', '0.147.0').state, 'unparseable', 'including the truncation class');
    strictEqual(pair(undefined, '2.1.233', '0.147.0', '0.147.0').state, 'unparseable', 'and a missing host');
  });

  it('every pair state it can emit is in the declared vocabulary', () => {
    const emitted = new Set();
    for (const [co, cr] of [['2.1.233', '2.1.233'], ['2.1.234', '2.1.233'], ['2.1.232', '2.1.233'], ['2.1', '2.1.0'], ['banana', '2.1.233']]) {
      for (const [xo, xr] of [['0.147.0', '0.147.0'], ['0.148.0', '0.147.0'], ['0.146.0', '0.147.0'], ['0.147.0-rc.1', '0.147.0'], ['potato', '0.147.0']]) {
        emitted.add(pair(co, cr, xo, xr).state);
      }
    }
    for (const state of emitted) ok(HOST_PAIR_RELATION_STATES.includes(state), `${state} is declared`);
    // Non-vacuity: the sweep must actually reach the interesting states rather
    // than emitting one value twenty-five times.
    for (const expected of ['exact', 'ahead', 'behind', 'same-precedence-nonexact', 'unparseable', 'mixed-direction']) {
      ok(emitted.has(expected), `the sweep reaches ${expected}`);
    }
  });
});

describe('packaged comparator — §Decision 9: direction is evidence, never safety', () => {
  it('returns no verdict, score, or boolean a caller could read as coverage', () => {
    // The invariant stated mechanically. Measured against the failure it
    // prevents: 17 of 18 recorded Claude Code steps are patch-position, and the
    // one lap that produced real adoption work was patch-position too — so any
    // field here that graded a step would grade that one as safe.
    const result = classifyVersionRelation({ observed: '2.1.233', reviewed: '2.1.233' });
    deepStrictEqual(Object.keys(result).sort(), ['core_order', 'exact', 'state']);
    const pairResult = classifyHostPairRelation({
      observed: { claude: '2.1.233', codex: '0.147.0' },
      reviewed: { claude: '2.1.233', codex: '0.147.0' },
    });
    deepStrictEqual(Object.keys(pairResult).sort(), ['hosts', 'state']);
    for (const key of ['safe', 'covered', 'assured', 'ok', 'pass', 'verdict', 'severity']) {
      ok(!(key in result), `single-host result must not carry '${key}'`);
      ok(!(key in pairResult), `pair result must not carry '${key}'`);
    }
  });

  it('the most favourable possible state is still only `exact`', () => {
    // There is no state above `exact`, and `exact` is a statement about two
    // strings — not about whether the host is safe to run.
    strictEqual(VERSION_RELATION_STATES[0], 'exact');
    strictEqual(classifyVersionRelation({ observed: '2.1.233', reviewed: '2.1.233' }).exact, true);
    ok(!VERSION_RELATION_STATES.includes('assured'));
    ok(!HOST_PAIR_RELATION_STATES.includes('assured'));
  });
});

describe('packaged comparator — the CI script is single-sourced onto it', () => {
  it('CI USES the packaged comparator rather than re-implementing it', async () => {
    // Identity, not agreement. The predecessor of this case compared OUTPUTS
    // and passed while CI routed through a private loose parser behind an
    // unused import — two implementations that agree today are still two
    // implementations. The `normalizeVersion === releaseVersion` assertion in
    // test-host-parity-baseline.mjs closed that for the normalizer and left the
    // comparison built on it behind; this closes the mirror.
    const ci = await import('../../scripts/check-host-version-drift.mjs');
    const lib = await import('../../plugins/runtime/scripts/lib/host-parity-baseline.mjs');
    strictEqual(ci.compareSemver, lib.compareReleaseCore, 'CI must USE the packaged comparator');
    strictEqual(ci.normalizeVersion, lib.releaseVersion, 'and still the packaged normalizer');
  });

  it('the CI verdicts the old private comparator produced are UNCHANGED', async () => {
    // The convergence shown rather than the evidence deleted. Every pair below
    // is one the drift checker's own tests already pinned, and each must still
    // answer identically now that the private `semverParts` is gone.
    const ci = await import('../../scripts/check-host-version-drift.mjs');
    strictEqual(ci.compareSemver('1.0.0', '1.0.0'), 0);
    strictEqual(ci.compareSemver('1.0.0', '1.0.1'), -1);
    strictEqual(ci.compareSemver('2.0.0', '1.9.9'), 1);
    strictEqual(ci.compareSemver('v2.1.0', '2.1.0'), 0);
    strictEqual(ci.compareSemver('rust-v0.137.0', '0.136.0'), 1);
    strictEqual(ci.compareSemver('garbage', '1.0.0'), null);

    strictEqual(ci.driftSeverity('2.1.161', '2.1.161'), 'current');
    strictEqual(ci.driftSeverity('2.1.161', '2.1.163'), 'patch');
    strictEqual(ci.driftSeverity('0.136.0', '0.137.0'), 'minor');
    strictEqual(ci.driftSeverity('2.1.161', '3.0.0'), 'major');
    strictEqual(ci.driftSeverity('bad', '1.0.0'), 'unknown');
  });

  it('`driftSeverity` was the MIRROR, and it moved too', async () => {
    // `compareSemver` is the function this subtask was told to unify, but
    // `driftSeverity` read the same private parts helper. Fixing only the named
    // one would have left the identical `Number.parseInt` and truncation
    // defects alive one function away.
    const ci = await import('../../scripts/check-host-version-drift.mjs');
    // Truncation: the old helper sliced to three components and reported these
    // as the same release.
    strictEqual(ci.driftSeverity('1.2.3.4', '1.2.3'), 'unknown', 'a version it cannot represent is not "current"');
    // Large components: the old helper parsed both to one float.
    strictEqual(ci.driftSeverity('99999999999999999999.0.0', '99999999999999999998.0.0'), 'major');
    strictEqual(ci.compareSemver('99999999999999999999.0.0', '99999999999999999998.0.0'), 1);
  });
});
