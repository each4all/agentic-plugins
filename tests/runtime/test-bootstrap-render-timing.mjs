// tests/runtime/test-bootstrap-render-timing.mjs
//
// The bootstrap renderer's grapheme backoff (plugins/runtime/scripts/
// bootstrap.mjs renderText) is linear in the retreat distance, measured on
// the real clock. A large-tier test (scripts/data/test-tiers.json): its 40 ms
// bound holds on an idle machine with a wide margin (about 2 ms), not under a
// parallel pool that keeps every CPU busy, so it runs in npm test's
// low-concurrency pass. The renderer's other cases:
// tests/runtime/test-bootstrap-cli.mjs.

import { ok } from 'node:assert';
import { describe, it } from 'node:test';

import { renderText } from '../../plugins/runtime/scripts/bootstrap.mjs';

describe('renderText: the grapheme backoff on the real clock', () => {
  const evaluatedProof = (over = {}) => ({
    kind: 'deep-peer-smoke',
    step_id: 'proof.deep-peer-smoke',
    declined: false,
    status: 'stale',
    reasons: [],
    required: true,
    artifact_pointer: null,
    artifact_hash: null,
    bound_versions: null,
    ran_at: null,
    ...over,
  });
  const completionOf = (proofs) => ({
    state: 'configured-not-verified',
    unsatisfied: [],
    missing_steps: [],
    proofs,
    hook_attestation: { status: 'not-applicable', reasons: [], attested_plugins: [], bound_versions: null, artifact_pointer: null, artifact_hash: null, attested_at: null },
  });

  it('the grapheme backoff is linear, not quadratic, in the retreat distance', () => {
    // The first implementation re-spread the kept prefix (`[...cut]`) on every
    // retreat step, which is quadratic in the run of marks. Measured at 74ms for
    // a schema-max reason set of pure combining marks and 886ms once the input
    // is not schema-bounded — and `renderText` is reachable from a stored
    // run.json, so the schema bound is not a guarantee at this boundary.
    const marks = '\u0301'.repeat(512);
    const started = process.hrtime.bigint();
    const text = renderText({
      verb: 'status',
      completion: completionOf([evaluatedProof({ reasons: Array.from({ length: 64 }, () => marks) })]),
      steps: [],
    });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    ok(text.includes('evidence:'), 'it still renders');
    // Generous against CI jitter: the quadratic version took ~74ms here, the
    // linear one ~2ms. Anything under 40ms cannot be the quadratic shape.
    ok(elapsedMs < 40, `expected linear-time backoff, took ${elapsedMs.toFixed(1)}ms`);
  });
});
