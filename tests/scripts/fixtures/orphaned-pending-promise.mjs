// Expected-failure fixture for tests/scripts/test-test-timeout-policy.mjs.
// NOT named test-*.mjs on purpose: node's no-arg discovery must never pick it
// up — it exists only to be run by the policy meta-test with a small
// --test-timeout and to prove that an orphaned pending promise (zero live
// handles, never settles — the 2026-07-11 hang shape) becomes a bounded test
// FAILURE instead of a silent forever-hang.
import { test } from 'node:test';

test('orphaned pending promise (fixture)', async () => {
  await new Promise(() => {});
});
