// tests/runtime/test-runtime-floor.mjs
//
// The prerelease-aware comparator, and the strict parse it needs.
//
// ⚠ THIS FILE EXISTS BECAUSE A MUTATION SURVIVED. Replacing the comparator's
// `isSemVer` guard with a bare typeof check turned NO test red across the whole
// surface, even though that exact laxity is the defect the module was extracted
// to fix: against a `0.91.0` floor the strings `0.91.0junk` and `0.91.0.1`
// compared EQUAL and `01.91.0` compared ABOVE. A parse that accepts malformed
// text as satisfying a floor is the one defect a floor cannot have, and it was
// untested.
//
// ⚠ THE FLOOR ITSELF IS GONE (ADR-0056 §Decision 4) — `evaluateHostFloor`,
// `evaluateRuntimeFloor` and `describeFloorFailure` went with the assurance
// layer, and their tests with them. The comparator did NOT: `bootstrap.mjs`
// imports it for the general per-plugin `minimum_version` map, which
// `plugin-set.json` still declares for `companions` and `engineer`. `0.91.0`
// survives below only as a comparison OPERAND — a fixture version string, not a
// policy value — because rewriting it would lose the tie to the three measured
// laxities the numbers came from.

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { comparePrereleaseAware } from '../../plugins/runtime/scripts/lib/runtime-floor.mjs';

const FLOOR = '0.91.0';

describe('the floor comparator refuses what it cannot parse', () => {
  it('CONTROL: well-formed versions order correctly against the floor', () => {
    // Without this, every refusal below would pass against a comparator
    // hard-wired to return null.
    strictEqual(comparePrereleaseAware('0.91.0', FLOOR), 0);
    strictEqual(comparePrereleaseAware('0.92.0', FLOOR), 1);
    strictEqual(comparePrereleaseAware('0.90.3', FLOOR), -1);
    strictEqual(comparePrereleaseAware('1.0.0', FLOOR), 1);
  });

  it('the three MEASURED laxities are refused, not read as satisfying', () => {
    // Each of these compared as satisfying the floor under the unanchored prefix
    // parse this module replaced. `null` is unresolved — not equal, not above.
    strictEqual(comparePrereleaseAware('0.91.0junk', FLOOR), null, 'trailing junk must not read as equal');
    strictEqual(comparePrereleaseAware('0.91.0.1', FLOOR), null, 'a fourth component must not read as equal');
    strictEqual(comparePrereleaseAware('01.91.0', FLOOR), null, 'a leading zero is not SemVer, and read as ABOVE the floor');
  });

  it('other malformed shapes are refused too', () => {
    for (const value of ['banana', '', '1.2', '1.2.3-', 'v1.2.3', null, undefined, 42, '1.2.3 ']) {
      strictEqual(comparePrereleaseAware(value, FLOOR), null, `${JSON.stringify(value)} must not compare`);
    }
    // An unparseable FLOOR is equally refused — the refusal is symmetric.
    strictEqual(comparePrereleaseAware('1.0.0', 'not-a-version'), null);
  });

  it('build metadata never orders; a prerelease sorts below its release', () => {
    strictEqual(comparePrereleaseAware('0.91.0+build.5', FLOOR), 0);
    strictEqual(comparePrereleaseAware('0.91.0-rc.1', FLOOR), -1);
  });

  it('prerelease IDENTIFIERS are ranked — SemVer §11, which semverCompare omits', () => {
    // A floor must order `-rc.1` against `-rc.2`; the shared `semverCompare`
    // deliberately does not, which is why this module keeps its own ordering.
    const below = (a, b) => strictEqual(comparePrereleaseAware(a, b), -1, `${a} < ${b}`);
    below('1.0.0-alpha', '1.0.0-alpha.1');
    below('1.0.0-alpha.1', '1.0.0-alpha.beta');
    below('1.0.0-alpha.beta', '1.0.0-beta');
    below('1.0.0-beta', '1.0.0-beta.2');
    below('1.0.0-beta.2', '1.0.0-beta.11');   // numeric identifiers compare numerically
    below('1.0.0-rc.1', '1.0.0');
  });
});
