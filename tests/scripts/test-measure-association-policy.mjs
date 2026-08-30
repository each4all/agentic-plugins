// Tests for the association-policy measurements
// (scripts/measure-association-policy.mjs).
//
// These pin the readings the decision record rests on. They are not a gate on
// the corpus — the corpus is frozen, so a change here means the READER changed,
// which is exactly when the decision's evidence needs re-reading. Each
// assertion therefore names what it would mean if it failed.
//
// One reading is pinned twice, deliberately: the proximity sweep is asserted
// both as its numbers and as the PROPERTY the decision draws from it, because
// the property is what the decision uses and a future edit could preserve one
// while destroying the other.

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  DECISION_COMMIT,
  anchorPopulation,
  clauseAmbiguity,
  connectorInventory,
  measure,
  proximitySweep,
} from '../../scripts/measure-association-policy.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');

function commitAvailable() {
  try {
    execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--verify', `${DECISION_COMMIT}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}
const skip = !commitAvailable() && 'the pinned decision commit is not reachable here';

let cached = null;
const result = () => (cached ??= measure(REPO_ROOT, DECISION_COMMIT));

test('the anchor population repeats values, which is why a value oracle cannot certify a pairing', { skip }, () => {
  const a = result().anchors;
  assert.equal(a.runIdOccurrences, 292);
  assert.equal(a.runIdDistinct, 88);
  assert.equal(a.runtimeTagOccurrences, 95);
  assert.equal(a.runtimeTagDistinct, 35);
  // The decision does not rest on the exact counts but on this inequality: if
  // every value occurred once, agreeing on a value WOULD identify an
  // occurrence, and the whole argument for a span-level oracle would collapse.
  assert.ok(a.runIdOccurrences > a.runIdDistinct * 2, 'run ids must repeat substantially');
  assert.ok(a.runtimeTagOccurrences > a.runtimeTagDistinct * 2, 'tags must repeat substantially');
});

test('the family scope really is wider than the rules that were reasoned about', { skip }, () => {
  const a = result().anchors;
  // Eight kinds are recognised while every candidate rule handled `doctor`
  // alone. If this ever collapses to one kind, the scope inconsistency the
  // decision names has been resolved elsewhere and the record should say so.
  assert.ok(Object.keys(a.kinds).length >= 8, `expected 8+ run kinds, got ${Object.keys(a.kinds).join(', ')}`);
  assert.equal(a.kinds.doctor, 174);
  assert.ok(a.doctorOccurrences < a.runIdOccurrences, 'doctor must be a strict subset of the anchor population');
});

test('half the date claims are joined by punctuation, so a purely lexical set has a ceiling', { skip }, () => {
  const c = result().connectors;
  assert.equal(c.pairs, 124);
  assert.equal(c.punctuationOnly, 63);
  // The load-bearing property: a connector with no letter cannot be named by a
  // lexical construction. If this share ever drops near zero, the argument for
  // demoting construction grammars to lane policy weakens and the record needs
  // re-reading.
  assert.ok(c.punctuationShare > 0.4, `punctuation share ${c.punctuationShare} must be substantial`);
});

test('the connector inventory has a long tail rather than a handful of regular forms', { skip }, () => {
  const c = result().connectors;
  assert.equal(c.distinctForms, 20);
  const headTotal = c.head.slice(0, 4).reduce((sum, [, n]) => sum + n, 0);
  // A short head plus a long tail is a different design problem from a small
  // regular set: it is what makes "enumerate the constructions" a treadmill.
  assert.ok(headTotal / c.pairs > 0.7, 'the head should dominate');
  assert.ok(c.distinctForms > 10, 'and the tail should be long');
});

test('the value oracle cannot separate the candidate rules', { skip }, () => {
  const c = result().candidates;
  assert.equal(c['incumbent-7-doctor-only'].bound, 94);
  assert.equal(c['incumbent-7-all-kinds-plus-id-on-date'].bound, 107);
  // THIS is the finding. Two rules with materially different coverage both
  // score a perfect zero, so the oracle ranks them identically. If either ever
  // reports a disagreement, the oracle has become discriminating and the
  // decision's central premise needs re-checking.
  for (const [id, s] of Object.entries(c)) {
    assert.equal(s.disagreeing, 0, `${id} should be indistinguishable under the value oracle`);
  }
});

test('the proximity sweep interleaves: bound keeps rising after the first false pairing', { skip }, () => {
  const rows = result().sweep;
  assert.deepEqual(
    rows.map((r) => [r.width, r.bound, r.disagreeing]),
    [[10, 111, 0], [20, 117, 0], [40, 125, 1], [80, 134, 3], [160, 141, 6], [320, 154, 9]],
  );
  // The PROPERTY, asserted separately from the numbers. An earlier measurement
  // reported zero false pairings up to width 40 and concluded a separating
  // threshold existed; that was an artifact of a gap pattern which forbade a
  // period and so skipped every pair spanning a version number. What actually
  // holds is that genuine bindings continue to appear at widths where false
  // ones already have — so no width admits every claim and excludes every
  // mention, and no proximity rule can be made correct by tuning it.
  const first = rows.find((r) => r.disagreeing > 0);
  assert.ok(first, 'some width must produce a false pairing, or the sweep proves nothing');
  const after = rows.filter((r) => r.width > first.width);
  assert.ok(
    after.every((r) => r.bound > first.bound),
    'genuine bindings must keep appearing above the first false width — that is the interleaving',
  );
});

test('ranking is routine, not an edge case', { skip }, () => {
  const a = result().ambiguity;
  assert.equal(a.clausesWithAnchor, 209);
  assert.equal(a.oneToOne, 88);
  assert.equal(a.ambiguous, 31);
  // If ambiguity were rare, a positional rule with a stated tie-break would be
  // defensible. At this share it is a routine requirement, and ranking is the
  // dimension that produced a false result in this repository before.
  assert.ok(a.ambiguous / a.clausesWithAnchor > 0.1, 'ambiguity must be common enough to matter');
});

test('the measurement is a function of the named commit, not of the checkout', { skip }, () => {
  // The harness must read the COMMIT it is given. If it read the checkout
  // instead, the decision record would silently stop matching its own evidence
  // the first time a stage document changed.
  //
  // Asserting only that the pin reproduces itself does NOT test this: HEAD's
  // stage documents are currently byte-identical to the pin's, so swapping the
  // commit for HEAD changes nothing and the assertion passes either way
  // (measured — that mutation did not bite). Discriminating requires a commit
  // whose stage documents actually differ.
  const a = measure(REPO_ROOT, DECISION_COMMIT);
  assert.deepEqual(a, measure(REPO_ROOT, DECISION_COMMIT), 'repeated measurement must agree');
  assert.equal(a.commit, DECISION_COMMIT);

  const older = 'bd450b2';
  const differs = (() => {
    try {
      execFileSync('git', ['-C', REPO_ROOT, 'diff', '--quiet', older, DECISION_COMMIT, '--', ...a.files], { stdio: 'ignore' });
      return false;
    } catch { return true; }
  })();
  assert.ok(differs, `${older} must differ from the pin in the stage documents, or this proves nothing`);
  const b = measure(REPO_ROOT, older);
  assert.notDeepEqual(
    b.anchors, a.anchors,
    'a commit with different stage documents must produce different readings',
  );
});

test('the segmentation is part of the measurand', { skip }, () => {
  // Stated as a test because the first version of this measurement got it
  // wrong and the error was invisible: both methods look like "proximity".
  // Splitting on sentence punctuation and then measuring an edge gap is not
  // the same as forbidding that punctuation inside the gap.
  const corpus = [{ path: 'x', text: 'ran at 2026-01-02 on version 0.97.0 by doctor-20260102T000000Z-aaaaaa' }];
  const swept = proximitySweep(corpus, [40]);
  assert.equal(swept[0].bound, 1, 'a pair spanning a version number must be reachable at width 40');
  // Control: the same corpus with the version number removed is still reachable,
  // so the assertion above is about the period and not about the distance.
  const shorter = proximitySweep([{ path: 'x', text: 'ran at 2026-01-02 by doctor-20260102T000000Z-aaaaaa' }], [40]);
  assert.equal(shorter[0].bound, 1);
});

test('the exported readings agree with the aggregate', { skip }, () => {
  // Guards against the aggregate drifting from the parts it is assembled from —
  // a shape a reader would not notice, because both look plausible alone.
  const r = result();
  const corpus = r.files.map((path) => ({
    path,
    text: execFileSync('git', ['-C', REPO_ROOT, 'show', `${DECISION_COMMIT}:${path}`], { encoding: 'utf8', maxBuffer: 1 << 28 }).replace(/\s+/g, ' '),
  }));
  assert.deepEqual(anchorPopulation(corpus), r.anchors);
  assert.deepEqual(connectorInventory(corpus), r.connectors);
  assert.deepEqual(clauseAmbiguity(corpus), r.ambiguity);
});
