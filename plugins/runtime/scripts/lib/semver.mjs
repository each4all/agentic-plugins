// Numeric SemVer comparison with the SemVer-standard prerelease tie-break,
// runtime-internal.
//
// Moved verbatim out of doctor.mjs so `lib/peer-execution-context.mjs` can use it
// without importing doctor.mjs (which would form a cycle). doctor.mjs and
// settings.mjs both re-import it here rather than keeping private copies.
// Runtime-internal import only — the ADR-0010 §5 import ban is cross-plugin.
//
// Cores compare numerically; on an equal core a clean release orders ABOVE its
// own prereleases (`0.83.0-beta.1 < 0.83.0`), so the §13/§18 floor comparisons
// in session-readiness.mjs agree with the attention sensors' strict
// `versionGte` gate (an equal-core prerelease install sits BELOW a clean
// declared floor — the recorded S9 follow-up the attention README named), and
// newest-version sorts stay deterministic when a cache holds both a release
// and its prerelease. Same semantics as attention's `discover-runtime.mjs`
// sibling copy. Prerelease identifiers are NOT ranked against each other
// (equal-core prereleases compare 0) and build metadata (`+build`) never
// orders — both unchanged from the numeric-only behavior.

// The SemVer SHAPE, as the specification writes it: no leading zeroes in any
// numeric identifier, prerelease and build identifiers as §9/§10 define them.
//
// One copy, in the module that already owns SemVer semantics runtime-internally.
// There were two loose ones — `plugin-set.mjs`'s private `SEMVER_RE` and a
// second added alongside the manifest reader — and both accepted `01.2.3` and
// `1.2.3-01`, which the specification does not. That matters where the value is
// reported as a version: a manifest saying `01.2.3` was classified `ok` and
// stamped onto artifacts (cross-host review).
const SEMVER_SHAPE_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Is this string a complete, well-formed SemVer version? */
export function isSemVer(value) {
  return typeof value === 'string' && SEMVER_SHAPE_RE.test(value);
}

export function semverCompare(a, b) {
  // Build metadata (`+…`) strips FIRST: it may itself contain hyphens
  // (`1.0.0+build-5` is a clean release, SemVer §10), so splitting on `-`
  // before dropping it would misread the metadata as a prerelease.
  const [bareA] = String(a).split('+', 2);
  const [bareB] = String(b).split('+', 2);
  const [coreA, preA] = bareA.split('-', 2);
  const [coreB, preB] = bareB.split('-', 2);
  const pa = coreA.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = coreB.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  if (!preA && preB) return 1;
  if (preA && !preB) return -1;
  return 0;
}
