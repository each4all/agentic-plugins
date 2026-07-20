// Unit tests for lib/semver.mjs — the shared numeric SemVer comparison with
// the SemVer-standard prerelease tie-break (S9 peer follow-up: the §13/§18
// floor comparisons must agree with the attention sensors' strict versionGte).

import { describe, it } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert';

import { semverCompare } from '../../plugins/runtime/scripts/lib/semver.mjs';

describe('semverCompare (lib/semver.mjs)', () => {
  it('numeric core comparison: major, minor, patch precedence', () => {
    ok(semverCompare('1.0.0', '0.99.99') > 0);
    ok(semverCompare('0.83.0', '0.84.0') < 0);
    ok(semverCompare('0.83.1', '0.83.0') > 0);
    strictEqual(semverCompare('0.83.0', '0.83.0'), 0);
  });

  it('a clean release orders ABOVE its own prerelease (equal core)', () => {
    ok(semverCompare('0.83.0', '0.83.0-beta.1') > 0);
    ok(semverCompare('0.83.0-beta.1', '0.83.0') < 0, 'the §18 floor case: prerelease install < clean floor');
  });

  it('a prerelease of a HIGHER core orders above a lower clean release', () => {
    ok(semverCompare('0.84.0-beta.1', '0.83.0') > 0);
    ok(semverCompare('0.83.0', '0.84.0-beta.1') < 0);
  });

  it('equal-core prereleases compare 0 (identifiers are not ranked)', () => {
    strictEqual(semverCompare('0.83.0-beta.1', '0.83.0-beta.2'), 0);
    strictEqual(semverCompare('0.83.0-alpha', '0.83.0-beta'), 0);
  });

  it('build metadata never orders (SemVer §10 semantics preserved)', () => {
    strictEqual(semverCompare('0.90.0+build.5', '0.90.0'), 0);
    strictEqual(semverCompare('0.90.0+build-5', '0.90.0'), 0, 'hyphenated build metadata is not a prerelease');
    ok(semverCompare('0.90.0-beta.1+build-5', '0.90.0') < 0, 'a prerelease with build metadata still orders below its release');
  });

  it('newest-first sort is deterministic when a cache holds a release beside its prerelease', () => {
    const versions = ['0.83.0-beta.1', '0.82.0', '0.83.0'];
    versions.sort((a, b) => semverCompare(b, a));
    deepStrictEqual(versions, ['0.83.0', '0.83.0-beta.1', '0.82.0']);
  });

  it('wholly non-numeric fragments degrade to 0 (deliberate leniency, shipped sibling-copy behavior)', () => {
    // Leniency is deliberate and additive-only (parity with the attention
    // discover-runtime.mjs sibling copy — the C no-op rationale): a WHOLLY
    // non-numeric fragment sinks to 0, while a numeric-prefixed fragment
    // parses to its prefix ('999junk' → 999) and can rank. Real-world
    // inputs are release-please clean X.Y.Z either way.
    ok(semverCompare('abc', '0.0.1') < 0);
    strictEqual(semverCompare('abc', '0.0.0'), 0);
    ok(semverCompare('999junk.0.0', '1.0.0') > 0, 'numeric-prefixed junk parses to its prefix (documented leniency, not fail-closed)');
  });
});
