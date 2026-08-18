// plugins/runtime/scripts/lib/runtime-floor.mjs
//
// ADR-0054 §Decision 5 — the minimum assurance-capable runtime version, and the
// ONE evaluator that decides whether an installed runtime satisfies it.
//
// WHY A LEAF MODULE. Three callers need this answer — `bootstrap.mjs`'s Stage
// readiness, the assurance ladder, and the cutover gate — and two of them are
// libraries. Keeping the comparison inside `bootstrap.mjs`, where it lived,
// would have made a library import a command module: the command/library
// boundary inverted, and a second cycle risk beside the ones
// `host-assurance-facts.mjs` already documents. So the comparator MOVED here and
// `bootstrap.mjs` imports it back.
//
// ⚠ WHY THE MOVE HARDENED IT RATHER THAN RELOCATING IT. The comparator's parse
// was a PREFIX regex with no end anchor, and cross-host review measured what
// that admits against a `0.91.0` floor:
//
//     0.91.0junk  -> 0   (read as EQUAL to the floor)
//     0.91.0.1    -> 0   (a four-component string, read as equal)
//     01.91.0     -> 1   (leading zero, read as ABOVE the floor)
//
// A floor exists to refuse versions, so a parse that accepts malformed text as
// satisfying it is the one defect that cannot be tolerated in this file. The
// shape check is now `lib/semver.mjs`'s anchored, specification-shaped
// `isSemVer` — the module ADR-0054 §Decision 7 assigns to "a different question
// about manifests", which is exactly the question a plugin-version floor asks.
// §Decision 7's "untouched and unused here" scopes the HOST-version comparator,
// not this.
//
// ⚠ WHAT IS KEPT from the original: prerelease IDENTIFIERS are ranked
// (`1.0.0-alpha < 1.0.0-beta`), which `semverCompare` deliberately omits. A
// floor must order prereleases against each other, because `0.91.0-rc.1` and
// `0.91.0-rc.2` are different answers to "is this install new enough".

import { isSemVer } from './semver.mjs';

/** The two hosts a floor verdict must cover, fixed rather than read from data. */
const FLOOR_HOSTS = Object.freeze(['claude', 'codex']);

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

/**
 * Decide whether ONE host's installed runtime satisfies the floor.
 *
 * The predicate is deliberately the RAW observation's, not a coarse install
 * status, and each clause below is a way a positive answer would have been
 * wrong rather than a way to be strict for its own sake:
 *
 *   authoritative  a cache-sourced answer is evidence about disk, not about
 *                  what the host loads
 *   present        absence is never satisfaction
 *   enabled        an installed-but-disabled package runs no code, and
 *                  ADR-0053 §Decision 8 names "is disabled" as grant-invalidating
 *   unambiguous    two conflicting rows for one package mean the observation
 *                  cannot say which version is loaded
 *   well-formed    see the header — an unparseable version must not compare
 *   at-or-above    the comparison itself, last
 *
 * @param {object?} observation the `observePackages` entry for `runtime`.
 * @param {boolean} authoritative the host's list authority flag.
 * @param {string} floor the required minimum version.
 */
export function evaluateHostFloor({ observation, authoritative, floor }) {
  const fail = (reason, detail = null) => ({ satisfied: false, reason, version: observation?.version ?? null, detail });
  if (authoritative !== true) return fail('list-not-authoritative');
  if (!observation || observation.present !== true) return fail('not-installed');
  // TRISTATE, and the third value blocks. `enabled === null` is "the host did
  // not say", which is not the same as enabled and must not be read as it.
  if (observation.enabled !== true) {
    return fail(observation.enabled === false ? 'disabled' : 'enablement-unknown');
  }
  if (observation.ambiguous === true) return fail('ambiguous-observation');
  const cmp = comparePrereleaseAware(observation.version, floor);
  if (cmp === null) return fail('version-unparseable');
  if (cmp < 0) return fail('below-floor');
  return { satisfied: true, reason: null, version: observation.version, detail: null };
}

/**
 * The floor verdict for BOTH hosts.
 *
 * ⚠ BOTH HOSTS, FIXED. ADR-0054 §Decision 5 requires the floor to be evaluated
 * for "both hosts' installed runtime", not the executing process's — the two can
 * carry different versions, and the process running this code is not evidence
 * about either install. The host list is a frozen constant rather than a read of
 * `pluginSet.plugins.runtime.hosts`, because a corrupted or narrowed `hosts`
 * array would otherwise silently reduce how many hosts must satisfy the floor,
 * which is a way for a package defect to widen coverage.
 *
 * ⚠ A `null` FLOOR IS NOT SATISFIED, and this reversed in ST5's audit. It used
 * to return `{satisfied: true, hosts: {}}` — "no floor is declared, so every host
 * trivially satisfies it" — which was the pre-§Decision 5 shipped state read
 * forward into a world where the floor IS the policy. Four independent reviews
 * converged on the same measurement: a declared `plugins.runtime.minimum_version:
 * null` (which `validatePluginSet` accepts) made this return a satisfied verdict
 * with ZERO hosts evaluated, ladder step 7 passed it, and `covered` then reached
 * all three readiness surfaces — `doctor`'s experience-parity criterion and
 * `compat`'s `readinessStatus` both key on `assurance.status` alone and never
 * look at `runtime_floor`, so hardening only the cutover check left two of three
 * open. Refusing here is what makes ONE value close all three, and is why the fix
 * is not at the consumers: a fourth consumer would repeat it.
 *
 * `no-floor-declared` is deliberately its own reason rather than reusing
 * `floor-unparseable`: the operator action differs — one is a corrupt package to
 * reinstall, the other is a package that shipped without the policy value at all.
 */
export function evaluateRuntimeFloor({ floor, packageObservation }) {
  if (floor === null || floor === undefined) {
    return {
      floor: null,
      satisfied: false,
      hosts: Object.fromEntries(FLOOR_HOSTS.map((h) => [h, { satisfied: false, reason: 'no-floor-declared', version: null, detail: null }])),
      unsatisfied: [...FLOOR_HOSTS],
    };
  }
  // A floor the PACKAGE declares but this runtime cannot parse is a corrupt
  // package, not a satisfied floor. `validatePluginSet` already rejects this
  // shape; the guard stays because a caller may hand a floor from elsewhere and
  // "unparseable therefore fine" is the wrong direction for a refusal.
  if (!isSemVer(floor)) {
    return {
      floor,
      satisfied: false,
      hosts: Object.fromEntries(FLOOR_HOSTS.map((h) => [h, { satisfied: false, reason: 'floor-unparseable', version: null, detail: null }])),
      unsatisfied: [...FLOOR_HOSTS],
    };
  }
  const hosts = {};
  for (const host of FLOOR_HOSTS) {
    hosts[host] = evaluateHostFloor({
      observation: packageObservation?.[host]?.packages?.runtime ?? null,
      authoritative: packageObservation?.[host]?.authoritative,
      floor,
    });
  }
  const unsatisfied = FLOOR_HOSTS.filter((host) => !hosts[host].satisfied);
  return { floor, satisfied: unsatisfied.length === 0, hosts, unsatisfied };
}

/** One operator line naming every host that failed and why. */
export function describeFloorFailure(verdict) {
  if (verdict.satisfied) return null;
  // A missing floor is a PACKAGE defect, not an install to upgrade. Falling
  // through to the shared sentence would tell the operator to "install runtime
  // null or newer", which names no action they can take.
  if (verdict.floor === null || verdict.floor === undefined) {
    return 'Reinstall or repair the runtime plugin — its packaged plugin set declares no `plugins.runtime.minimum_version`, '
      + 'so the minimum assurance-capable runtime cannot be checked on either host. A floor that evaluates no host satisfies '
      + 'nothing, and readiness is not claimable without one (ADR-0054 §Decision 5).';
  }
  const REASONS = {
    'no-floor-declared': 'the packaged plugin set declares no minimum runtime version, so there is no floor to evaluate — a floor that evaluates no host satisfies nothing (ADR-0054 §Decision 5)',
    'list-not-authoritative': 'the installed-plugin list was not authoritative (a cache-sourced answer is evidence about disk, not about what the host loads)',
    'not-installed': 'runtime is not installed',
    disabled: 'runtime is installed but disabled',
    'enablement-unknown': 'the host did not report whether runtime is enabled',
    'ambiguous-observation': 'the installed-plugin list reported conflicting rows for runtime',
    'version-unparseable': 'the reported runtime version is not a well-formed version',
    'below-floor': 'the installed runtime is below the floor',
    'floor-unparseable': 'the packaged floor value is not a well-formed version',
  };
  const parts = verdict.unsatisfied.map((host) => {
    const row = verdict.hosts[host];
    const reason = REASONS[row.reason] ?? row.reason;
    return `${host}: ${reason}${row.version ? ` (observed ${row.version})` : ''}`;
  });
  return `Install or enable runtime ${verdict.floor} or newer on both hosts — ${parts.join('; ')}. `
    + 'Below the floor a host cannot read the compatibility assurance record at all, so readiness is not claimable (ADR-0054 §Decision 5).';
}
