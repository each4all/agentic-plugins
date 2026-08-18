// tests/runtime/test-runtime-floor.mjs
//
// ADR-0054 §Decision 5 — the minimum assurance-capable runtime, and the strict
// comparison a floor needs.
//
// ⚠ THIS FILE EXISTS BECAUSE A MUTATION SURVIVED. Replacing the comparator's
// `isSemVer` guard with a bare typeof check turned NO test red across the whole
// assurance surface, even though that exact laxity is the defect the module was
// extracted to fix: against a `0.91.0` floor the strings `0.91.0junk` and
// `0.91.0.1` compared EQUAL and `01.91.0` compared ABOVE. A floor exists to
// refuse versions; a parse that accepts malformed text as satisfying one is the
// one defect it cannot have, and it was untested.

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  comparePrereleaseAware,
  describeFloorFailure,
  evaluateHostFloor,
  evaluateRuntimeFloor,
} from '../../plugins/runtime/scripts/lib/runtime-floor.mjs';
import { observePackages } from '../../plugins/runtime/scripts/lib/assurance-contract.mjs';

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

describe('a host satisfies the floor only on the RAW observation', () => {
  const observation = (patch = {}) => ({ present: true, version: FLOOR, enabled: true, ambiguous: false, observations: 1, source: 'list', ...patch });

  it('CONTROL: an authoritative, present, enabled, unambiguous, at-floor install passes', () => {
    deepStrictEqual(evaluateHostFloor({ observation: observation(), authoritative: true, floor: FLOOR }).satisfied, true);
  });

  const refusals = [
    ['a non-authoritative listing', { observation: observation(), authoritative: false }, 'list-not-authoritative'],
    ['an absent package', { observation: null, authoritative: true }, 'not-installed'],
    ['an explicitly disabled package', { observation: observation({ enabled: false }), authoritative: true }, 'disabled'],
    // TRISTATE, and the third value blocks: "the host did not say" is not
    // "enabled", and reading it as such is how a disabled install passes.
    ['unknown enablement', { observation: observation({ enabled: null }), authoritative: true }, 'enablement-unknown'],
    ['conflicting duplicate rows', { observation: observation({ ambiguous: true }), authoritative: true }, 'ambiguous-observation'],
    ['an unparseable version', { observation: observation({ version: '0.91.0junk' }), authoritative: true }, 'version-unparseable'],
    ['a below-floor version', { observation: observation({ version: '0.90.3' }), authoritative: true }, 'below-floor'],
  ];
  for (const [label, input, reason] of refusals) {
    it(`${label} is refused with its own reason`, () => {
      const verdict = evaluateHostFloor({ ...input, floor: FLOOR });
      strictEqual(verdict.satisfied, false);
      strictEqual(verdict.reason, reason);
    });
  }
});

describe('the floor is evaluated for BOTH hosts, independently', () => {
  const list = (version, { status = 'enabled' } = {}) => observePackages({
    claudePluginList: { runtime: { version, status } },
    claudeListStatus: 'available',
    codexPluginList: { status: 'available', entries: { runtime: { version, status } } },
  });

  it('CONTROL: both hosts at the floor satisfies', () => {
    strictEqual(evaluateRuntimeFloor({ floor: FLOOR, packageObservation: list(FLOOR) }).satisfied, true);
  });

  it('one host below the floor blocks, and only that host is named', () => {
    // ADR-0054 §Decision 5 requires BOTH hosts' installed runtime, because the
    // two can carry different versions. A verdict that stopped at the first host
    // would pass a machine whose second host cannot read the record.
    const observation = observePackages({
      claudePluginList: { runtime: { version: FLOOR, status: 'enabled' } },
      claudeListStatus: 'available',
      codexPluginList: { status: 'available', entries: { runtime: { version: '0.90.3', status: 'enabled' } } },
    });
    const verdict = evaluateRuntimeFloor({ floor: FLOOR, packageObservation: observation });
    strictEqual(verdict.satisfied, false);
    deepStrictEqual(verdict.unsatisfied, ['codex']);
    strictEqual(verdict.hosts.claude.satisfied, true);
    strictEqual(verdict.hosts.codex.reason, 'below-floor');
    ok(/codex: the installed runtime is below the floor \(observed 0\.90\.3\)/.test(describeFloorFailure(verdict)));
  });

  it('the host list is FIXED, not read from the plugin set', () => {
    // A corrupted or narrowed `plugins.runtime.hosts` array would otherwise
    // reduce how many hosts must satisfy the floor — a package defect widening
    // coverage. Proved by omitting codex entirely: it must still be judged.
    const claudeOnly = observePackages({
      claudePluginList: { runtime: { version: FLOOR, status: 'enabled' } },
      claudeListStatus: 'available',
      codexPluginList: null,
    });
    const verdict = evaluateRuntimeFloor({ floor: FLOOR, packageObservation: claudeOnly });
    strictEqual(verdict.satisfied, false);
    deepStrictEqual(verdict.unsatisfied, ['codex']);
  });

  it('a MISSING floor is not satisfied, and neither is an unparseable one', () => {
    // REVERSED by ST5's audit. `null` used to be "trivially satisfied" — the
    // pre-§Decision 5 shipped state read forward into a world where the floor IS
    // the policy. Measured: a declared `minimum_version: null` (which
    // validatePluginSet accepts) returned satisfied with ZERO hosts evaluated,
    // ladder step 7 passed, and `covered` reached all three readiness surfaces,
    // two of which never look at runtime_floor at all. Refusing HERE is what
    // makes one value close all three.
    for (const absent of [null, undefined]) {
      const verdict = evaluateRuntimeFloor({ floor: absent, packageObservation: list('9.9.9') });
      strictEqual(verdict.satisfied, false, `floor ${String(absent)} must not satisfy`);
      // Both hosts must be NAMED. A verdict that refuses while evaluating no
      // host is the shape the cutover check had to learn to reject.
      deepStrictEqual(verdict.unsatisfied, ['claude', 'codex']);
      strictEqual(verdict.hosts.claude.reason, 'no-floor-declared');
      strictEqual(verdict.hosts.codex.reason, 'no-floor-declared');
      // Its own operator line, because "install runtime null or newer" names no
      // action anyone can take.
      const line = describeFloorFailure(verdict);
      ok(line.includes('minimum_version'), line);
      ok(!line.includes('null or newer'), line);
    }
    const bad = evaluateRuntimeFloor({ floor: '0.91', packageObservation: list('9.9.9') });
    strictEqual(bad.satisfied, false);
    strictEqual(bad.hosts.claude.reason, 'floor-unparseable');
  });

  it('describeFloorFailure is null for a satisfied verdict and names every failing host otherwise', () => {
    strictEqual(describeFloorFailure(evaluateRuntimeFloor({ floor: FLOOR, packageObservation: list(FLOOR) })), null);
    const both = evaluateRuntimeFloor({ floor: FLOOR, packageObservation: list('0.90.3') });
    const line = describeFloorFailure(both);
    ok(line.includes('claude:'), line);
    ok(line.includes('codex:'), line);
    ok(line.includes('0.91.0 or newer'), line);
  });
});
