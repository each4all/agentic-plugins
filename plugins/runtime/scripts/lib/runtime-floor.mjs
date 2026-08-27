// plugins/runtime/scripts/lib/runtime-floor.mjs
//
// The prerelease-aware SemVer comparator, and nothing else.
//
// ⚠ THE FILE NAME OUTLIVED ITS SUBJECT, deliberately. ADR-0054 §Decision 5 put a
// "minimum assurance-capable runtime version" here together with the three
// functions that evaluated it; ADR-0056 §Decision 4 removed the floor — with no
// assurance record to read, a floor guarding the ability to read one asserts an
// incompatibility that no longer exists — and `evaluateHostFloor`,
// `evaluateRuntimeFloor` and `describeFloorFailure` went with it. The comparator
// stays because `bootstrap.mjs` imports it for the GENERAL per-plugin
// `minimum_version` map (`plugin-set.json` declares one for `companions` and
// `engineer` today), which was never assurance machinery. Renaming the file is a
// separate rename with its own import churn, and ADR-0056 §Decision 2 scopes this
// change to the removal manifest with no adjacent cleanup.
//
// ⚠ WHY THE COMPARATOR IS HARDENED rather than convenient. Its parse used to be
// a PREFIX regex with no end anchor, and cross-host review measured what that
// admits against a `0.91.0` floor:
//
//     0.91.0junk  -> 0   (read as EQUAL to the floor)
//     0.91.0.1    -> 0   (a four-component string, read as equal)
//     01.91.0     -> 1   (leading zero, read as ABOVE the floor)
//
// A floor exists to refuse versions, so a parse that accepts malformed text as
// satisfying it is the one defect that cannot be tolerated here. The shape check
// is `lib/semver.mjs`'s anchored, specification-shaped `isSemVer`.
//
// ⚠ WHAT IS KEPT that `semverCompare` omits: prerelease IDENTIFIERS are ranked
// (`1.0.0-alpha < 1.0.0-beta`). A floor must order prereleases against each
// other, because `0.91.0-rc.1` and `0.91.0-rc.2` are different answers to "is
// this install new enough".

import { isSemVer } from './semver.mjs';

/**
 * SemVer precedence with prerelease identifiers RANKED. Returns `-1 | 0 | 1`,
 * or `null` when either side is not a well-formed version.
 *
 * `null` is the important return: it is not "equal" and not "below", and every
 * caller must treat it as unresolved rather than folding it into a comparison
 * result. That folding is what the old prefix parse did implicitly.
 */
export function comparePrereleaseAware(a, b) {
  // STRICT first. A value that is not a complete SemVer string has no
  // precedence against anything, and saying so is the whole hardening.
  if (!isSemVer(a) || !isSemVer(b)) return null;
  const parse = (v) => {
    // Build metadata never orders (SemVer §10) and strips FIRST, because it may
    // itself contain hyphens — splitting on `-` before dropping it would misread
    // `1.0.0+build-5` as a prerelease.
    const [bare] = String(v).split('+', 2);
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(bare);
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  // Equal cores: a prerelease sorts BELOW its release (SemVer §11).
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  const ia = pa.pre.split('.');
  const ib = pb.pre.split('.');
  for (let i = 0; i < Math.max(ia.length, ib.length); i += 1) {
    const x = ia[i];
    const y = ib[i];
    // A shorter identifier set has LOWER precedence when all preceding
    // identifiers are equal (SemVer §11).
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (nx && !ny) return -1;
    if (!nx && ny) return 1;
    if (nx && ny) return Number(x) < Number(y) ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
